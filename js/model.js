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
   * Adjust poll results for neutral/swing voters by blending
   * standard results with neutral results to reduce house effects.
   * @param {Object} poll - Poll object with results and neutralResults
   * @param {number} alpha - Blending factor (0 = use raw, 1 = use neutral only)
   * @returns {Object} adjusted results { candidateId: adjustedSupport }
   */
  adjustForNeutralVoters(poll, alpha = 0.5) {
    const adjusted = {};
    const candidates = Object.keys(poll.results);

    for (const cid of candidates) {
      const raw = poll.results[cid] || 0;
      const neutral = (poll.neutralResults && poll.neutralResults[cid]) || raw;
      adjusted[cid] = raw * (1 - alpha) + neutral * alpha;
    }

    return adjusted;
  },

  /**
   * Convert adjusted support percentages to projected vote share
   * by proportionally allocating undecided voters.
   * @param {Object} adjustedResults - { candidateId: support% }
   * @returns {Object} projected vote shares { candidateId: voteShare% }
   */
  convertToVoteShare(adjustedResults) {
    const totalSupport = Object.values(adjustedResults).reduce((a, b) => a + b, 0);

    if (totalSupport <= 0) return adjustedResults;

    const voteShares = {};
    for (const [cid, support] of Object.entries(adjustedResults)) {
      // Proportional allocation: each candidate gets share of remaining votes
      // proportional to their current support
      voteShares[cid] = (support / totalSupport) * 100;
    }

    return voteShares;
  },

  /**
   * Calculate weighted average across all polls.
   * Each poll's weight = recency * sampleQuality * credibility
   * @param {Array} polls - Array of poll objects
   * @param {Array} pollsters - Array of pollster objects
   * @param {string} electionDate - ISO date string
   * @returns {Object} { voteShares, weightedPolls, totalWeight }
   */
  calcWeightedAverage(polls, pollsters, electionDate) {
    if (!polls || polls.length === 0) {
      return { voteShares: {}, weightedPolls: [], totalWeight: 0 };
    }

    // Get all candidate IDs from the first poll
    const candidateIds = Object.keys(polls[0].results);
    const weightedSums = {};
    candidateIds.forEach(cid => { weightedSums[cid] = 0; });

    // Use the latest poll's date in the dataset as the reference date for recency decay.
    // This ensures the latest poll has 100% recency weight (1.0), and older polls decay relative to it.
    // The relative weights (and thus the final prediction results) remain mathematically identical,
    // but it avoids all polls having 0% recency weight when the election is far in the future.
    const pollDates = polls.map(p => new Date(p.date).getTime());
    const latestPollTime = Math.max(...pollDates);
    const referenceDate = new Date(latestPollTime).toISOString().split('T')[0];

    let totalWeight = 0;
    const weightedPolls = [];

    for (const poll of polls) {
      // Calculate individual weights
      const recencyW = this.calcRecencyWeight(poll.date, referenceDate);
      const sampleW = this.calcSampleWeight(poll.sampleSize, poll.method);
      const credibilityW = this.getCredibilityWeight(poll.pollster, pollsters);

      // Combined weight
      const combinedWeight = recencyW * sampleW * credibilityW;

      // Adjust for neutral voters
      const adjusted = this.adjustForNeutralVoters(poll);

      // Convert to projected vote shares
      const voteShares = this.convertToVoteShare(adjusted);

      // Accumulate weighted sums
      for (const cid of candidateIds) {
        weightedSums[cid] += (voteShares[cid] || 0) * combinedWeight;
      }
      totalWeight += combinedWeight;

      // Store poll with calculated weights
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

    // Calculate final weighted averages
    const voteShares = {};
    if (totalWeight > 0) {
      for (const cid of candidateIds) {
        voteShares[cid] = Math.round((weightedSums[cid] / totalWeight) * 10) / 10;
      }
    }

    // Sort weighted polls by combined weight (descending)
    weightedPolls.sort((a, b) => b.weights.combined - a.weights.combined);

    return { voteShares, weightedPolls, totalWeight };
  },

  /**
   * Calculate win probability using normal distribution approximation.
   * Based on the lead and combined standard error.
   * @param {Object} voteShares - { candidateId: voteShare% }
   * @param {number} combinedSE - Combined standard error (default estimates from data)
   * @returns {Object} { candidateId: probability }
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

    // Standard error of the difference: SE_diff = sqrt(SE1^2 + SE2^2) ≈ SE * sqrt(2)
    const seDiff = combinedSE * Math.SQRT2;

    // Z-score = lead / SE_diff
    const z = lead / seDiff;

    // CDF approximation using the error function
    const leaderProb = this._normalCDF(z);

    const probabilities = {};
    // Distribute probabilities
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
    // Approximation of standard normal CDF
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
   * Simulates running the model as if each poll came in sequentially.
   * @param {Array} polls - All polls sorted by date
   * @param {Array} pollsters - Pollster data
   * @param {string} electionDate - ISO date string
   * @param {Array} candidates - Candidate array
   * @returns {Array} prediction snapshots
   */
  generatePredictionLog(polls, pollsters, electionDate, candidates) {
    // Sort polls by date ascending
    const sorted = [...polls].sort((a, b) => new Date(a.date) - new Date(b.date));
    const log = [];
    const candidateIds = candidates.map(c => c.id);

    for (let i = 0; i < sorted.length; i++) {
      const pollsUpToNow = sorted.slice(0, i + 1);
      const { voteShares } = this.calcWeightedAverage(pollsUpToNow, pollsters, electionDate);
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
   * @param {Array} weightedPolls - Polls with weights
   * @param {string} candidateId - Candidate to estimate SE for
   * @returns {number} estimated SE
   */
  estimateSE(weightedPolls, candidateId) {
    if (weightedPolls.length < 2) return 5.0;

    const shares = weightedPolls.map(p => p.projectedVoteShare[candidateId] || 0);
    const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
    const variance = shares.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (shares.length - 1);

    return Math.max(Math.sqrt(variance), 1.5); // Floor at 1.5
  },

  /**
   * Main entry point: run full analysis.
   * @param {Object} pollData - Poll data JSON (with electionId, candidates, polls, etc.)
   * @param {Object} pollsterData - Pollster data JSON
   * @returns {Object} Full analysis results
   */
  analyze(pollData, pollsterData) {
    const { candidates, polls, electionDate } = pollData;
    const pollsters = pollsterData.pollsters || [];

    // Step 1: Calculate weighted average
    const { voteShares, weightedPolls, totalWeight } = this.calcWeightedAverage(
      polls, pollsters, electionDate
    );

    // Step 2: Estimate standard error from poll variance
    const leaderId = Object.entries(voteShares).sort(([, a], [, b]) => b - a)[0]?.[0];
    const se = leaderId ? this.estimateSE(weightedPolls, leaderId) : 3.0;

    // Step 3: Calculate win probabilities
    const winProbabilities = this.calcWinProbability(voteShares, se);

    // Step 4: Generate prediction log
    const predictionLog = this.generatePredictionLog(polls, pollsters, electionDate, candidates);

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
