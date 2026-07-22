/* ============================================
   ClearPoll 透析民調 — Analysis Model
   ============================================ */

const ClearPollModel = {

  /**
   * Calculate recency weight using exponential decay.
   * Polls closer to election day get higher weight.
   * @param {string} pollDate - ISO date string of the poll
   * @param {string} electionDate - ISO date string of the election
   * @param {number} halfLifeDays - Half-life in days (default 14)
   * @returns {number} weight between 0 and 1
   */
  calcRecencyWeight(pollDate, electionDate, halfLifeDays = 14) {
    const poll = new Date(pollDate);
    const election = new Date(electionDate);
    const daysBeforeElection = (election - poll) / (1000 * 60 * 60 * 24);

    if (daysBeforeElection < 0) return 0.5; // Post-election poll, low weight
    if (daysBeforeElection === 0) return 1;

    // Exponential decay: w = 2^(-t / halfLife)
    return Math.pow(2, -daysBeforeElection / halfLifeDays);
  },

  /**
   * Calculate sample quality weight based on sample size and method.
   * Larger samples and more rigorous methods get higher weight.
   * @param {number} sampleSize
   * @param {string} method - 'phone', 'online', 'face-to-face', 'ivr'
   * @returns {number} weight between 0 and 1
   */
  calcSampleWeight(sampleSize, method) {
    // Sample size component: sqrt(n) / sqrt(1000), capped at 1
    const sizeWeight = Math.min(Math.sqrt(sampleSize) / Math.sqrt(1000), 1.0);

    // Method quality multiplier
    const methodMultipliers = {
      'face-to-face': 1.0,
      'phone': 0.92,
      'online': 0.80,
      'ivr': 0.75,
    };
    const methodWeight = methodMultipliers[method] || 0.85;

    return sizeWeight * methodWeight;
  },

  /**
   * Get credibility weight from pollster data.
   * @param {string} pollsterId
   * @param {Array} pollsters - Array of pollster objects
   * @returns {number} credibility score between 0 and 1
   */
  getCredibilityWeight(pollsterId, pollsters) {
    const pollster = pollsters.find(p => p.id === pollsterId);
    if (!pollster) return 0.7; // Default for unknown pollster
    return pollster.credibilityScore || 0.7;
  },

  /**
   * Calibrate pollster house effects (bias calibration).
   * @param {Object} poll
   * @param {Array} pollsters
   * @param {Array} candidates
   * @returns {Object} calibrated raw results
   */
  calibratePollsterBias(poll, pollsters, candidates) {
    const pollsterObj = pollsters.find(p => p.id === poll.pollster);
    if (!pollsterObj || !pollsterObj.leanDirection || pollsterObj.leanDirection === 'neutral') {
      return { ...poll.results };
    }

    const leanDir = pollsterObj.leanDirection;
    const mag = pollsterObj.leanMagnitude || 0.1;
    // Maximum bias shift in percentage points (e.g., 0.1 mag -> ~1.2 percentage points max)
    const shiftPP = mag * 12.0;

    const calibrated = { ...poll.results };
    if (!candidates || candidates.length === 0) return calibrated;

    for (const c of candidates) {
      if (calibrated[c.id] == null) continue;

      const party = c.party ? c.party.toUpperCase() : '';
      if (leanDir.includes('blue')) {
        // Pollster leans blue (overstates KMT, understates DPP)
        if (party === 'KMT') {
          calibrated[c.id] = Math.max(0, calibrated[c.id] - shiftPP);
        } else if (party === 'DPP') {
          calibrated[c.id] = calibrated[c.id] + shiftPP;
        }
      } else if (leanDir.includes('green')) {
        // Pollster leans green (overstates DPP, understates KMT)
        if (party === 'DPP') {
          calibrated[c.id] = Math.max(0, calibrated[c.id] - shiftPP);
        } else if (party === 'KMT') {
          calibrated[c.id] = calibrated[c.id] + shiftPP;
        }
      }
    }

    return calibrated;
  },

  /**
   * Adjust poll results for neutral/swing voters by blending
   * standard results with neutral results to reduce house effects.
   * @param {Object} poll - Poll object with results and neutralResults
   * @param {Array} pollsters - Array of pollsters
   * @param {Array} candidates - Candidate objects
   * @param {number} alpha - Blending factor (0 = use raw, 1 = use neutral only)
   * @param {boolean} applyBiasCorrection - Whether to apply house effect calibration
   * @returns {Object} adjusted results { candidateId: adjustedSupport }
   */
  adjustForNeutralVoters(poll, pollsters = [], candidates = [], alpha = 0.5, applyBiasCorrection = true) {
    const adjusted = {};
    const baseResults = applyBiasCorrection && pollsters.length > 0
      ? this.calibratePollsterBias(poll, pollsters, candidates)
      : poll.results;

    const candidateKeys = Object.keys(poll.results);

    for (const cid of candidateKeys) {
      const raw = baseResults[cid] != null ? baseResults[cid] : (poll.results[cid] || 0);
      const neutral = (poll.neutralResults && poll.neutralResults[cid] != null)
        ? poll.neutralResults[cid]
        : raw;
      adjusted[cid] = raw * (1 - alpha) + neutral * alpha;
    }

    return adjusted;
  },

  /**
   * Convert adjusted support percentages to projected vote share
   * with optional undecided voter lean parameter.
   * @param {Object} adjustedResults - { candidateId: support% }
   * @param {Array} candidates - Candidate metadata array
   * @param {number} undecidedLean - Undecided voter shift factor (-0.5 to +0.5, default 0)
   * @returns {Object} projected vote shares { candidateId: voteShare% }
   */
  convertToVoteShare(adjustedResults, candidates = [], undecidedLean = 0) {
    const totalSupport = Object.values(adjustedResults).reduce((a, b) => a + b, 0);

    if (totalSupport <= 0) return adjustedResults;

    const voteShares = {};

    for (const [cid, support] of Object.entries(adjustedResults)) {
      let baseShare = (support / totalSupport) * 100;

      // Apply scenario undecided voter lean adjustment if specified
      if (undecidedLean !== 0 && candidates.length > 0) {
        const cand = candidates.find(c => c.id === cid);
        if (cand) {
          const party = cand.party ? cand.party.toUpperCase() : '';
          if (party === 'DPP') {
            baseShare += undecidedLean * 6.0; // Shift up to ±3%
          } else if (party === 'KMT') {
            baseShare -= undecidedLean * 6.0;
          }
        }
      }

      voteShares[cid] = Math.max(0, baseShare);
    }

    // Re-normalize to 100%
    const newTotal = Object.values(voteShares).reduce((a, b) => a + b, 0);
    if (newTotal > 0) {
      for (const cid of Object.keys(voteShares)) {
        voteShares[cid] = (voteShares[cid] / newTotal) * 100;
      }
    }

    return voteShares;
  },

  /**
   * Calculate weighted average across all polls.
   * Each poll's weight = recency * sampleQuality * credibility
   * @param {Array} polls - Array of poll objects
   * @param {Array} pollsters - Array of pollster objects
   * @param {string} electionDate - ISO date string
   * @param {Array} candidates - Array of candidate objects
   * @param {Object} scenarioOptions - Optional scenario parameters
   * @returns {Object} { voteShares, weightedPolls, totalWeight }
   */
  calcWeightedAverage(polls, pollsters, electionDate, candidates = [], scenarioOptions = null) {
    if (!polls || polls.length === 0) {
      return { voteShares: {}, weightedPolls: [], totalWeight: 0 };
    }

    const candidateIds = Object.keys(polls[0].results);
    const weightedSums = {};
    candidateIds.forEach(cid => { weightedSums[cid] = 0; });

    const pollDates = polls.map(p => new Date(p.date).getTime());
    const latestPollTime = Math.max(...pollDates);
    const referenceDate = new Date(latestPollTime).toISOString().split('T')[0];

    const applyBias = scenarioOptions?.applyBiasCorrection !== false;
    const undecidedLean = scenarioOptions?.undecidedLean || 0;

    let totalWeight = 0;
    const weightedPolls = [];

    for (const poll of polls) {
      const recencyW = this.calcRecencyWeight(poll.date, referenceDate);
      const sampleW = this.calcSampleWeight(poll.sampleSize, poll.method);
      const credibilityW = this.getCredibilityWeight(poll.pollster, pollsters);

      const combinedWeight = recencyW * sampleW * credibilityW;

      // Adjust for neutral voters & pollster bias
      const adjusted = this.adjustForNeutralVoters(poll, pollsters, candidates, 0.5, applyBias);

      // Convert to projected vote shares
      const voteShares = this.convertToVoteShare(adjusted, candidates, undecidedLean);

      for (const cid of candidateIds) {
        weightedSums[cid] += (voteShares[cid] || 0) * combinedWeight;
      }
      totalWeight += combinedWeight;

      weightedPolls.push({
        ...poll,
        weights: {
          recency: recencyW,
          sample: sampleW,
          credibility: credibilityW,
          combined: combinedWeight,
        },
        adjustedResults: adjusted,
        projectedVoteShare: voteShares,
      });
    }

    const voteShares = {};
    if (totalWeight > 0) {
      for (const cid of candidateIds) {
        voteShares[cid] = Math.round((weightedSums[cid] / totalWeight) * 10) / 10;
      }
    }

    weightedPolls.sort((a, b) => b.weights.combined - a.weights.combined);

    return { voteShares, weightedPolls, totalWeight };
  },

  /**
   * Run Monte Carlo simulation for win probability and 95% Confidence Intervals.
   * @param {Array} polls
   * @param {Array} pollsters
   * @param {string} electionDate
   * @param {Array} candidates
   * @param {number} iterations - Number of stochastic simulations (default 5000)
   * @param {Object} scenarioOptions
   * @returns {Object} { winProbabilities, ci95 }
   */
  runMonteCarloSimulation(polls, pollsters, electionDate, candidates, iterations = 5000, scenarioOptions = null) {
    if (!polls || polls.length === 0 || !candidates || candidates.length === 0) {
      return { winProbabilities: {}, ci95: {} };
    }

    const candidateIds = candidates.map(c => c.id);
    const winCounts = {};
    const samples = {};
    candidateIds.forEach(cid => {
      winCounts[cid] = 0;
      samples[cid] = [];
    });

    for (let i = 0; i < iterations; i++) {
      // Perturb poll results according to margin of error
      const perturbedPolls = polls.map(poll => {
        const moe = poll.marginOfError || 3.0;
        const se = moe / 1.96;

        const perturbedResults = {};
        for (const cid of candidateIds) {
          const original = poll.results[cid] || 0;
          // Box-Muller normal sample
          const u1 = Math.random();
          const u2 = Math.random();
          const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
          perturbedResults[cid] = Math.max(0, original + z * se);
        }

        return { ...poll, results: perturbedResults };
      });

      const { voteShares } = this.calcWeightedAverage(perturbedPolls, pollsters, electionDate, candidates, scenarioOptions);

      // Determine winner of this iteration
      let winnerId = null;
      let maxShare = -1;
      for (const cid of candidateIds) {
        const share = voteShares[cid] || 0;
        samples[cid].push(share);
        if (share > maxShare) {
          maxShare = share;
          winnerId = cid;
        }
      }

      if (winnerId) {
        winCounts[winnerId]++;
      }
    }

    const winProbabilities = {};
    const ci95 = {};

    for (const cid of candidateIds) {
      winProbabilities[cid] = Math.round((winCounts[cid] / iterations) * 1000) / 1000;

      const arr = samples[cid].sort((a, b) => a - b);
      const mean = arr.reduce((sum, v) => sum + v, 0) / arr.length;
      const lower = arr[Math.floor(iterations * 0.025)] || arr[0];
      const upper = arr[Math.floor(iterations * 0.975)] || arr[arr.length - 1];
      const stdDev = Math.sqrt(arr.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / arr.length);

      ci95[cid] = {
        mean: Math.round(mean * 10) / 10,
        lower: Math.round(lower * 10) / 10,
        upper: Math.round(upper * 10) / 10,
        stdDev: Math.round(stdDev * 100) / 100,
      };
    }

    return { winProbabilities, ci95 };
  },

  /**
   * Calculate win probability using standard normal distribution.
   */
  calcWinProbability(voteShares, combinedSE = 3.0) {
    const entries = Object.entries(voteShares).sort(([, a], [, b]) => b - a);

    if (entries.length < 2) {
      const prob = {};
      if (entries.length === 1) prob[entries[0][0]] = 1.0;
      return prob;
    }

    const leader = entries[0];
    const runnerUp = entries[1];
    const lead = leader[1] - runnerUp[1];
    const seDiff = combinedSE * Math.SQRT2;
    const z = lead / seDiff;
    const leaderProb = this._normalCDF(z);

    const probabilities = {};
    for (const [cid] of entries) {
      if (cid === leader[0]) {
        probabilities[cid] = Math.round(leaderProb * 1000) / 1000;
      } else if (cid === runnerUp[0]) {
        probabilities[cid] = Math.round((1 - leaderProb) * 1000) / 1000;
      } else {
        probabilities[cid] = 0;
      }
    }

    return probabilities;
  },

  /**
   * Normal CDF approximation using error function.
   * @private
   */
  _normalCDF(x) {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * absX);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

    return 0.5 * (1.0 + sign * y);
  },

  /**
   * Generate prediction log — snapshots of how prediction evolved over time.
   */
  generatePredictionLog(polls, pollsters, electionDate, candidates, scenarioOptions = null) {
    const sorted = [...polls].sort((a, b) => new Date(a.date) - new Date(b.date));
    const log = [];

    for (let i = 0; i < sorted.length; i++) {
      const pollsUpToNow = sorted.slice(0, i + 1);
      const { voteShares } = this.calcWeightedAverage(pollsUpToNow, pollsters, electionDate, candidates, scenarioOptions);
      const winProb = this.calcWinProbability(voteShares);

      log.push({
        date: sorted[i].date,
        pollCount: i + 1,
        voteShares: { ...voteShares },
        winProbabilities: { ...winProb },
      });
    }

    return log;
  },

  /**
   * Estimate combined standard error from the poll data.
   */
  estimateSE(weightedPolls, candidateId) {
    if (weightedPolls.length < 2) return 4.5;

    const shares = weightedPolls.map(p => p.projectedVoteShare[candidateId] || 0);
    const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
    const variance = shares.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (shares.length - 1);

    return Math.max(Math.sqrt(variance), 2.0);
  },

  /**
   * Main entry point: run full analysis.
   * @param {Object} pollData - Poll data JSON
   * @param {Object} pollsterData - Pollster data JSON
   * @param {Object} scenarioOptions - Optional user scenario parameters
   * @returns {Object} Full analysis results
   */
  analyze(pollData, pollsterData, scenarioOptions = null) {
    const { candidates, polls, electionDate } = pollData;
    const pollsters = pollsterData.pollsters || [];

    // Step 1: Calculate weighted average
    const { voteShares, weightedPolls, totalWeight } = this.calcWeightedAverage(
      polls, pollsters, electionDate, candidates, scenarioOptions
    );

    // Step 2: Estimate standard error from poll variance
    const leaderId = Object.entries(voteShares).sort(([, a], [, b]) => b - a)[0]?.[0];
    const se = leaderId ? this.estimateSE(weightedPolls, leaderId) : 3.0;

    // Step 3: Run Monte Carlo simulation for 95% Confidence Intervals & probabilities
    const { winProbabilities: mcWinProbs, ci95 } = this.runMonteCarloSimulation(
      polls, pollsters, electionDate, candidates, 3000, scenarioOptions
    );

    // Dynamic win probability fallback blend
    const winProbabilities = mcWinProbs && Object.keys(mcWinProbs).length > 0
      ? mcWinProbs
      : this.calcWinProbability(voteShares, se);

    // Step 4: Generate prediction log
    const predictionLog = this.generatePredictionLog(polls, pollsters, electionDate, candidates, scenarioOptions);

    // Step 5: Calculate "others" share
    const totalCandidateShare = Object.values(voteShares).reduce((a, b) => a + b, 0);
    const predictedVoteShares = { ...voteShares };
    if (totalCandidateShare < 100) {
      predictedVoteShares.others = Math.round((100 - totalCandidateShare) * 10) / 10;
    }

    return {
      electionId: pollData.electionId,
      electionName: pollData.electionName,
      electionDate: pollData.electionDate,
      candidates,
      predictedVoteShares,
      winProbabilities,
      ci95,
      standardError: Math.round(se * 100) / 100,
      weightedPolls,
      predictionLog,
      totalWeight: Math.round(totalWeight * 1000) / 1000,
      pollCount: polls.length,
      analysisTimestamp: new Date().toISOString(),
    };
  },
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ClearPollModel;
}
