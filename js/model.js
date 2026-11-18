/* ============================================
   ClearPoll 透析民調 — Analysis Model & Data Integrity Contract

   【數據嚴謹度與誠實性最高原則 (Data Integrity Directives)】
   1. 「數字正確、精準為最高原則」 (Accuracy and precision are supreme).
   2. 「嚴禁使用錯誤民調數字、嚴禁未經查證之編撰、嚴禁模型或 AI 產生幻覺，避免數據謬誤」 (Strictly No Hallucination or Fabrication).
   3. 所有輸入之民調與歷史選舉數據，必須強制與中央選舉委員會 (CEC) 官方紀錄或原始機構報告進行雙重核對。
   ============================================ */

const ClearPollModel = {

  /**
   * Calculate adaptive half-life based on days remaining until the election.
   * Prevents a single pollster from dominating 50%+ weight in the mid/early phase.
   * @param {string} electionDate - ISO date string of election
   * @param {string} referenceDate - ISO date string of latest poll
   * @returns {number} half-life in days (10 to 28)
   */
  calcAdaptiveHalfLife(electionDate, referenceDate) {
    if (!electionDate) return 28;
    const election = new Date(electionDate).getTime();
    const ref = new Date(referenceDate || new Date()).getTime();
    const daysUntilElection = Math.max(0, (election - ref) / (1000 * 60 * 60 * 24));

    if (daysUntilElection > 60) return 28; // Mid/early phase: 28 days (4 weeks)
    if (daysUntilElection > 30) return 21; // Mid phase: 21 days (3 weeks)
    if (daysUntilElection > 14) return 14; // Final stretch: 14 days (2 weeks)
    return 10; // Final 2 weeks: 10 days
  },

  /**
   * Calculate recency weight using exponential decay with adaptive half-life.
   * Polls closer to election day get higher weight.
   * @param {string} pollDate - ISO date string of the poll
   * @param {string} referenceDate - ISO date string of reference latest poll
   * @param {number} halfLifeDays - Half-life in days
   * @returns {number} weight between 0 and 1
   */
  calcRecencyWeight(pollDate, referenceDate, halfLifeDays = 28) {
    const poll = new Date(pollDate).getTime();
    const ref = new Date(referenceDate).getTime();
    const daysDiff = Math.max(0, (ref - poll) / (1000 * 60 * 60 * 24));

    // Exponential decay: w = 2^(-daysDiff / halfLife)
    return Math.pow(2, -daysDiff / halfLifeDays);
  },

  /**
   * Calculate sample quality weight based on sample size and method.
   * Larger samples and more rigorous methods get higher weight.
   * @param {number} sampleSize
   * @param {string} method - 'phone', 'online', 'face-to-face', 'ivr'
   * @returns {number} weight between 0 and 1
   */
  calcSampleWeight(sampleSize, method) {
    // Sample size component: sqrt(n) / sqrt(1000), capped at 1.25 for large-sample (N >= 1562) polls
    const sizeWeight = Math.min(Math.sqrt(sampleSize) / Math.sqrt(1000), 1.25);

    // Method quality multiplier
    const methodMultipliers = {
      'face-to-face': 1.0,
      'mixed': 0.96,
      'phone+cell': 0.95,
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
  calibratePollsterBias(poll, pollsters, candidates, scale = 1.0) {
    const pollsterObj = pollsters.find(p => p.id === poll.pollster);
    if (!pollsterObj || !pollsterObj.leanDirection || pollsterObj.leanDirection === 'neutral') {
      return { ...poll.results };
    }

    const leanDir = pollsterObj.leanDirection;
    const mag = pollsterObj.leanMagnitude || 0.1;
    // Maximum bias shift in percentage points (e.g., 0.1 mag -> ~1.2 percentage points max)
    const shiftPP = mag * 12.0 * scale;

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
   * Adjust poll results for neutral/swing voters and house effects.
   * To prevent mathematical double-counting of neutralResults (which are already part of
   * the decided sample in poll.results and receive 70% weight in undecided allocation),
   * baseline alpha defaults to 0.0 when Prior-Anchored Undecided Allocation is active,
   * and dynamically scales up to 0.45 ONLY when poll.partyAffiliation exhibits explicit
   * sample partisan skew relative to local CDPSM fundamentals.
   * @param {Object} poll - Poll object with results and neutralResults
   * @param {Array} pollsters - Array of pollsters
   * @param {Array} candidates - Candidate objects
   * @param {number} alpha - Baseline blending factor (0.0 with prior undecided, 0.25 without)
   * @param {boolean} applyBiasCorrection - Whether to apply house effect calibration
   * @param {Object} fundamentals - Optional CDPSM city fundamentals for sample skew detection
   * @returns {Object} adjusted results { candidateId: adjustedSupport }
   */
  adjustForNeutralVoters(poll, pollsters = [], candidates = [], alpha = 0.0, applyBiasCorrection = true, fundamentals = null) {
    const adjusted = {};
    const baseResults = applyBiasCorrection && pollsters.length > 0
      ? this.calibratePollsterBias(poll, pollsters, candidates, 1.0)
      : { ...poll.results };

    const neutralCalibrated = (poll.neutralResults && applyBiasCorrection && pollsters.length > 0)
      ? this.calibratePollsterBias({ ...poll, results: poll.neutralResults }, pollsters, candidates, 0.5)
      : poll.neutralResults;

    // Dynamic sample-skew calibration (Raking) when poll discloses sample partyAffiliation:
    // Deducts any house-effect shift already applied by calibratePollsterBias to prevent double-counting,
    // and allows a ±5.0% natural political climate band before applying mild (15%, max ±1.2%) dampening.
    if (poll.partyAffiliation && fundamentals) {
      let alreadyShiftedGap = 0;
      const pollsterObj = pollsters.find(p => p.id === poll.pollster);
      if (applyBiasCorrection && pollsterObj && pollsterObj.leanDirection && pollsterObj.leanDirection !== 'neutral') {
        const mag = pollsterObj.leanMagnitude || 0.1;
        const shiftPP = mag * 12.0;
        if (pollsterObj.leanDirection.includes('green')) alreadyShiftedGap = 2 * shiftPP;
        else if (pollsterObj.leanDirection.includes('blue')) alreadyShiftedGap = -2 * shiftPP;
      }

      const rawSampleGap = (poll.partyAffiliation.dpp || 0) - (poll.partyAffiliation.kmt || 0);
      const effectiveSampleGap = rawSampleGap - alreadyShiftedGap;
      const fundGap = (fundamentals.green || 40) - (fundamentals.blue || 40);
      const skew = effectiveSampleGap - fundGap; // positive = sample over-sampled DPP; negative = sample over-sampled KMT
      if (Math.abs(skew) > 5.0) {
        const excess = Math.sign(skew) * (Math.abs(skew) - 5.0);
        // Dampen 15% of excess partisan sample skew beyond climate band (capped at ±1.2% per candidate)
        const shift = Math.max(-1.2, Math.min(1.2, excess * 0.15));
        for (const cid of Object.keys(baseResults)) {
          const cand = candidates.find(c => c.id === cid);
          const party = (cand?.party || '').toUpperCase();
          if (party === 'DPP') {
            baseResults[cid] = Math.max(0, baseResults[cid] - shift);
          } else if (party === 'KMT') {
            baseResults[cid] = Math.max(0, baseResults[cid] + shift);
          }
        }
      }
    }

    const candidateKeys = Object.keys(poll.results);

    for (const cid of candidateKeys) {
      const raw = baseResults[cid] != null ? baseResults[cid] : (poll.results[cid] || 0);
      const neutral = (neutralCalibrated && neutralCalibrated[cid] != null)
        ? neutralCalibrated[cid]
        : raw;
      adjusted[cid] = raw * (1 - alpha) + neutral * alpha;
    }

    return adjusted;
  },

  /**
   * 2022 CEC Actual Vote Structure Recall-Vote Raking (上屆實際得票結構回溯加權).
   * Corrects partisan non-response / winner-recall bias using 2022 CEC actual vote shares
   * and empirical cross-tab transition matrices when available.
   * @param {Object} poll - Poll object
   * @param {Object} adjustedResults - { candidateId: support% }
   * @param {Array} candidates - Candidate array
   * @param {Object} options - Scenario options containing pastResults, cityId, fundamentals
   * @returns {Object} recall-raked support results
   */
  applyRecallVoteRaking(poll, adjustedResults, candidates = [], options = null) {
    if (!options?.applyRecallRaking) return adjustedResults;

    const candidateIds = Object.keys(adjustedResults);
    if (candidateIds.length < 2) return adjustedResults;

    // Case 1: Poll has explicit 2022 recall transition cross-tab (e.g. Taipei TVBS tp2026-009)
    if (poll.recallCrossTab) {
      const raked = {};
      candidateIds.forEach(cid => { raked[cid] = 0; });
      for (const group of Object.values(poll.recallCrossTab)) {
        const w = (group.share2022 || 0) / 100;
        for (const cid of candidateIds) {
          if (group[cid] != null) {
            raked[cid] += w * group[cid];
          }
        }
      }
      const rakedSum = Object.values(raked).reduce((a, b) => a + b, 0);
      if (rakedSum > 0) {
        return raked;
      }
    }

    // Case 2: Reconstruct 2022 CEC structural raking from official 2022 election results + neutral transfer
    const cityId = options.cityId;
    const past2022 = options.pastResults?.results?.find(r => r.electionId === `2022-${cityId}-mayor`);
    if (!past2022 || !past2022.candidates) return adjustedResults;

    let pastKmt = 0;
    let pastDpp = 0;
    let pastOther = 0;
    for (const c of past2022.candidates) {
      const p = (c.party || '').toUpperCase();
      if (p === 'KMT') pastKmt += c.voteShare;
      else if (p === 'DPP') pastDpp += c.voteShare;
      else pastOther += c.voteShare;
    }

    // Estimate neutral / third-party transfer split from poll's neutralResults
    const neutralSrc = poll.neutralResults || adjustedResults;
    const neutralTotal = candidateIds.reduce((s, cid) => s + (neutralSrc[cid] || 0), 0) || 1;
    const neutralRatios = {};
    for (const cid of candidateIds) {
      neutralRatios[cid] = (neutralSrc[cid] || 0) / neutralTotal;
    }

    // Construct 2022 CEC recall-implied baseline for each candidate
    const hasKmt = candidates.some(c => (c.party || '').toUpperCase() === 'KMT');
    const hasDpp = candidates.some(c => (c.party || '').toUpperCase() === 'DPP');
    const cecTarget = {};
    const totalAdj = Object.values(adjustedResults).reduce((a, b) => a + b, 0) || 80;
    for (const c of candidates) {
      if (!candidateIds.includes(c.id)) continue;
      const party = (c.party || '').toUpperCase();
      // Check if this exact candidate ran in 2022 (handles dual-KMT races like Lienchiang 王忠銘 vs 曹爾元)
      const sameCand2022 = past2022.candidates.find(pc => pc.name === c.name);
      let base2022 = 0;
      if (sameCand2022 && (!hasDpp || !hasKmt)) {
        base2022 = sameCand2022.voteShare * 0.85 + 15.0 * neutralRatios[c.id];
      } else if (party === 'KMT') {
        // 85% base retention + neutral share of 2022 third-party/non-voter pool
        base2022 = pastKmt * 0.85 + (pastOther + 15.0) * neutralRatios[c.id];
      } else if (party === 'DPP') {
        // 90% base retention + neutral share of 2022 third-party/non-voter pool
        base2022 = pastDpp * 0.90 + (pastOther + 15.0) * neutralRatios[c.id];
      } else if (!hasKmt && candidateIds.length === 2) {
        // Pan-Blue / Independent challenger in a 2-way race without KMT (e.g. Chiayi County 吳品叡)
        base2022 = (pastKmt + pastOther) * 0.80 + 15.0 * neutralRatios[c.id];
      } else if (!hasDpp && candidateIds.length === 2) {
        // Independent challenger in a 2-way race without DPP (e.g. Kinmen 李文良)
        base2022 = (pastDpp + pastOther) * 0.80 + 15.0 * neutralRatios[c.id];
      } else {
        base2022 = pastOther * 0.70 + 15.0 * neutralRatios[c.id];
      }
      cecTarget[c.id] = base2022;
    }

    const cecSum = Object.values(cecTarget).reduce((a, b) => a + b, 0) || 1;
    const rakedResults = {};
    // Blend 65% empirical poll with 35% 2022 CEC raked structure
    const rakeAlpha = 0.35;
    for (const cid of candidateIds) {
      const scaledCec = (cecTarget[cid] / cecSum) * totalAdj;
      rakedResults[cid] = adjustedResults[cid] * (1 - rakeAlpha) + scaledCec * rakeAlpha;
    }

    return rakedResults;
  },

  /**
   * Convert adjusted support percentages to projected vote share
   * with Prior-Anchored Undecided Allocation and optional undecided voter lean parameter.
   * @param {Object} adjustedResults - { candidateId: support% }
   * @param {Array} candidates - Candidate metadata array
   * @param {number} undecidedLean - User scenario slider (-1.0 to 1.0)
   * @param {Object} conversionOptions - { poll, fundamentals, usePriorUndecided }
   * @returns {Object} projected vote shares summing to 100%
   */
  convertToVoteShare(adjustedResults, candidates = [], undecidedLean = 0, conversionOptions = null) {
    const totalSupport = Object.values(adjustedResults).reduce((a, b) => a + b, 0);

    if (totalSupport <= 0) return adjustedResults;

    const candidateIds = Object.keys(adjustedResults);
    const usePriorUndecided = conversionOptions?.usePriorUndecided !== false;
    const poll = conversionOptions?.poll;
    const fundamentals = conversionOptions?.fundamentals;

    // Effective undecided percentage in this poll
    const rawUndecided = (poll && typeof poll.undecided === 'number')
      ? poll.undecided
      : Math.max(0, 100 - totalSupport);
    const effectiveUndecided = Math.min(48, Math.max(0, rawUndecided));
    const decidedPool = 100 - effectiveUndecided;

    // Neutral momentum share ratios for undecided allocation (using bias-calibrated neutralResults when available)
    const calibratedNeutral = conversionOptions?.calibratedNeutral;
    const neutralSrc = calibratedNeutral || ((poll && poll.neutralResults) ? poll.neutralResults : adjustedResults);
    const neutralSum = candidateIds.reduce((s, cid) => s + (neutralSrc[cid] || 0), 0) || totalSupport;

    // Structural prior share ratios (50% competitive equal split + 50% local CDPSM fundamental)
    const priorRatios = {};
    const equalShare = 1 / (candidateIds.length || 1);
    let fundSum = 0;
    const rawFund = {};
    for (const cid of candidateIds) {
      const cand = candidates.find(c => c.id === cid);
      const party = (cand?.party || '').toUpperCase();
      let fVal = equalShare * 100;
      if (fundamentals) {
        if (party === 'DPP') {
          fVal = (candidateIds.length === 2 && fundamentals.headToHead) ? fundamentals.headToHead.green : (fundamentals.green || 40);
        } else if (party === 'KMT') {
          fVal = (candidateIds.length === 2 && fundamentals.headToHead) ? fundamentals.headToHead.blue : (fundamentals.blue || 40);
        } else if (party === 'TPP') {
          fVal = fundamentals.white || 15;
        } else {
          fVal = (fundamentals.white || 20) * 0.6;
        }
      }
      rawFund[cid] = fVal;
      fundSum += fVal;
    }
    for (const cid of candidateIds) {
      const normFund = fundSum > 0 ? (rawFund[cid] / fundSum) : equalShare;
      priorRatios[cid] = 0.5 * equalShare + 0.5 * normFund;
    }

    const voteShares = {};

    for (const [cid, support] of Object.entries(adjustedResults)) {
      let baseShare;
      if (usePriorUndecided && effectiveUndecided > 5) {
        // Prior-Anchored Undecided Allocation:
        // Decided pool allocated by adjusted support; Undecided pool allocated 70% by neutral momentum + 30% by structural prior
        const decidedComponent = (support / totalSupport) * decidedPool;
        const neutralRatio = (neutralSrc[cid] != null ? neutralSrc[cid] : support) / neutralSum;
        const undecidedComponent = effectiveUndecided * (0.70 * neutralRatio + 0.30 * priorRatios[cid]);
        baseShare = decidedComponent + undecidedComponent;
      } else {
        // Traditional 100% Proportional Allocation
        baseShare = (support / totalSupport) * 100;
      }

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
   * Calculate weighted average across all polls with Single-Poll Weight Capping
   * and Same-Pollster Repeat-Wave Decay.
   * Prevents a single recent poll or single frequent pollster from monopolizing the forecast.
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

    const candidateIds = (candidates && candidates.length > 0)
      ? candidates.map(c => c.id)
      : Object.keys(polls[0].results);
    const pollDates = polls.map(p => new Date(p.date).getTime());
    const latestPollTime = Math.max(...pollDates);
    const referenceDate = new Date(latestPollTime).toISOString().split('T')[0];

    const applyBias = scenarioOptions?.applyBiasCorrection !== false;
    const undecidedLean = scenarioOptions?.undecidedLean || 0;
    const usePriorUndecided = scenarioOptions?.usePriorUndecided !== false;
    const halfLifeDays = this.calcAdaptiveHalfLife(electionDate, referenceDate);

    // Compute same-pollster repeat-wave rank (newest wave = 0, 2nd newest = 1, etc.)
    const sortedIndices = polls
      .map((_, idx) => idx)
      .sort((a, b) => new Date(polls[b].date) - new Date(polls[a].date));
    const pollsterCounts = {};
    const repeatRanks = new Array(polls.length).fill(0);
    for (const idx of sortedIndices) {
      const pid = polls[idx].pollster || 'unknown';
      const rank = pollsterCounts[pid] || 0;
      repeatRanks[idx] = rank;
      pollsterCounts[pid] = rank + 1;
    }

    // Step 1: Calculate raw weights & projected shares
    const intermediatePolls = [];
    let rawTotalWeight = 0;

    for (let idx = 0; idx < polls.length; idx++) {
      const poll = polls[idx];
      const recencyW = this.calcRecencyWeight(poll.date, referenceDate, halfLifeDays);
      const sampleW = this.calcSampleWeight(poll.sampleSize, poll.method);
      const credibilityW = this.getCredibilityWeight(poll.pollster, pollsters);
      const repeatDecayW = Math.pow(0.80, repeatRanks[idx]);
      const rawCombined = recencyW * sampleW * credibilityW * repeatDecayW;

      // Adjust for neutral voters, pollster bias & optional 2022 CEC Recall-Vote Raking
      // When usePriorUndecided is true, undecided pool is already allocated 70% by neutralResults,
      // so baseline alpha = 0.0 prevents double-counting neutralResults in the decided pool.
      const baseNeutralAlpha = usePriorUndecided ? 0.0 : 0.25;
      const neutralAdjusted = this.adjustForNeutralVoters(poll, pollsters, candidates, baseNeutralAlpha, applyBias, scenarioOptions?.fundamentals);
      const calibratedNeutral = (poll.neutralResults && applyBias && pollsters.length > 0)
        ? this.calibratePollsterBias({ ...poll, results: poll.neutralResults }, pollsters, candidates, 0.5)
        : poll.neutralResults;
      const adjusted = this.applyRecallVoteRaking(poll, neutralAdjusted, candidates, scenarioOptions);
      const voteShares = this.convertToVoteShare(adjusted, candidates, undecidedLean, {
        poll,
        calibratedNeutral,
        fundamentals: scenarioOptions?.fundamentals,
        usePriorUndecided
      });

      intermediatePolls.push({
        poll,
        recencyW,
        sampleW,
        credibilityW,
        repeatDecayW,
        rawCombined,
        adjusted,
        voteShares,
      });
      rawTotalWeight += rawCombined;
    }

    // Step 2: Apply single-poll weight capping (Max 35% when >= 3 polls)
    // Ensures robust multi-pollster consensus and prevents single-pollster hijack
    let cappedWeights = intermediatePolls.map(p => p.rawCombined);
    const maxWeightRatio = intermediatePolls.length >= 3 ? 0.35 : 1.0;

    if (rawTotalWeight > 0 && maxWeightRatio < 1.0) {
      for (let iter = 0; iter < 10; iter++) {
        const currentSum = cappedWeights.reduce((a, b) => a + b, 0);
        let excess = 0;
        let uncappedCount = 0;

        for (let i = 0; i < cappedWeights.length; i++) {
          const maxAllowed = currentSum * maxWeightRatio;
          if (cappedWeights[i] > maxAllowed) {
            excess += cappedWeights[i] - maxAllowed;
            cappedWeights[i] = maxAllowed;
          } else {
            uncappedCount++;
          }
        }

        if (excess <= 0.0001 || uncappedCount === 0) break;
        // Distribute excess among uncapped polls
        const addPerPoll = excess / uncappedCount;
        for (let i = 0; i < cappedWeights.length; i++) {
          if (cappedWeights[i] < currentSum * maxWeightRatio) {
            cappedWeights[i] += addPerPoll;
          }
        }
      }
    }

    // Step 3: Compute weighted sums with capped weights
    let totalWeight = cappedWeights.reduce((a, b) => a + b, 0);
    const weightedSums = {};
    candidateIds.forEach(cid => { weightedSums[cid] = 0; });
    const weightedPolls = [];

    for (let i = 0; i < intermediatePolls.length; i++) {
      const item = intermediatePolls[i];
      const finalWeight = cappedWeights[i];

      for (const cid of candidateIds) {
        weightedSums[cid] += (item.voteShares[cid] || 0) * finalWeight;
      }

      const normalizedWeight = totalWeight > 0 ? (finalWeight / totalWeight) : 0;

      weightedPolls.push({
        ...item.poll,
        recallRaked: Boolean(scenarioOptions?.applyRecallRaking),
        weights: {
          recency: item.recencyW,
          sample: item.sampleW,
          credibility: item.credibilityW,
          repeatDecay: item.repeatDecayW,
          combined: normalizedWeight,
          rawCombined: item.rawCombined,
        },
        adjustedResults: item.adjusted,
        projectedVoteShare: item.voteShares,
      });
    }

    const voteShares = {};
    if (totalWeight > 0) {
      for (const cid of candidateIds) {
        voteShares[cid] = Math.round((weightedSums[cid] / totalWeight) * 10) / 10;
      }
    }

    // Step 4: Bayesian Fundamentals Blending
    // When polls are sparse (N < 4), anchor with official CEC election fundamentals
    let blendedShares = { ...voteShares };
    let fundamentalsWeight = 0;
    const fundamentals = scenarioOptions?.fundamentals;

    if (fundamentals && scenarioOptions?.useFundamentals !== false) {
      const N = polls.length;
      if (typeof scenarioOptions?.fundamentalsWeight === 'number') {
        fundamentalsWeight = Math.max(0, Math.min(1, scenarioOptions.fundamentalsWeight));
      } else if (N < 4) {
        // Dynamic Bayesian shrinkage for sparse races: 1 poll -> 22.5%, 2 -> 15%, 3 -> 7.5%, 4+ -> 0%
        fundamentalsWeight = Math.round(0.30 * (1 - N / 4) * 100) / 100;
      }

      const activeCandidates = candidates.filter(c => candidateIds.includes(c.id));
      if (fundamentalsWeight > 0 && activeCandidates.length > 0) {
        // Map candidates to party fundamentals
        const rawFundShares = {};
        let fundTotal = 0;

        for (const c of activeCandidates) {
          const party = (c.party || '').toUpperCase();
          let share = 0;
          if (party === 'DPP') {
            share = (activeCandidates.length === 2 && fundamentals.headToHead) ? fundamentals.headToHead.green : fundamentals.green;
          } else if (party === 'KMT') {
            share = (activeCandidates.length === 2 && fundamentals.headToHead) ? fundamentals.headToHead.blue : fundamentals.blue;
          } else if (party === 'TPP') {
            share = fundamentals.white || 15.0;
          } else {
            // Third party / Independent / Other
            share = fundamentals.white ? (fundamentals.white * 0.5) : 10.0;
          }
          rawFundShares[c.id] = share;
          fundTotal += share;
        }

        // Normalize rawFundShares to 100%
        const normalizedFundShares = {};
        for (const c of activeCandidates) {
          normalizedFundShares[c.id] = fundTotal > 0 ? (rawFundShares[c.id] / fundTotal) * 100 : (100 / activeCandidates.length);
        }

        // Blend: (1 - w) * pollShare + w * fundShare
        blendedShares = {};
        let blendedSum = 0;
        for (const c of activeCandidates) {
          const pShare = voteShares[c.id] || 0;
          const fShare = normalizedFundShares[c.id] || 0;
          blendedShares[c.id] = Math.round(((1 - fundamentalsWeight) * pShare + fundamentalsWeight * fShare) * 10) / 10;
          blendedSum += blendedShares[c.id];
        }

        // Re-normalize to 100%
        if (blendedSum > 0) {
          for (const c of activeCandidates) {
            blendedShares[c.id] = Math.round((blendedShares[c.id] / blendedSum) * 1000) / 10;
          }
        }
      }
    }

    weightedPolls.sort((a, b) => b.weights.combined - a.weights.combined);
    return {
      voteShares: blendedShares,
      rawPollShares: voteShares,
      weightedPolls,
      totalWeight,
      fundamentalsWeight
    };
  },

  /**
   * Deterministic Mulberry32 PRNG for reproducible Monte Carlo simulations across views.
   * @private
   */
  _createSeededRandom(seedStr) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < seedStr.length; i++) {
      h ^= seedStr.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    let a = h >>> 0;
    return function() {
      let t = (a += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },

  /**
   * Run Monte Carlo simulation with Weighted Inter-Pollster Divergence & Correlated Systemic Shock.
   * @param {Array} polls
   * @param {Array} pollsters
   * @param {string} electionDate
   * @param {Array} candidates
   * @param {number} iterations - Number of stochastic simulations (default 3000)
   * @param {Object} scenarioOptions
   * @returns {Object} { winProbabilities, ci95 }
   */
  runMonteCarloSimulation(polls, pollsters, electionDate, candidates, iterations = 3000, scenarioOptions = null) {
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

    // Estimate weighted cross-pollster divergence standard deviation
    const { voteShares: baseShares, weightedPolls } = this.calcWeightedAverage(polls, pollsters, electionDate, candidates, scenarioOptions);
    const leaderId = Object.entries(baseShares).sort(([, a], [, b]) => b - a)[0]?.[0] || candidateIds[0];
    const divergenceSE = this.estimateSE(weightedPolls, leaderId);
    // Correlated election-day systemic error floor (turnout differential + late undecided break)
    const systemicSigma = Math.hypot(divergenceSE * 0.55, 2.0);

    const seedKey = `${electionDate}-${polls.length}-${polls[polls.length - 1]?.id || ''}-${scenarioOptions?.undecidedLean || 0}-${scenarioOptions?.applyBiasCorrection !== false}-${scenarioOptions?.applyRecallRaking === true}-${scenarioOptions?.usePriorUndecided !== false}-${scenarioOptions?.fundamentalsWeight ?? 'auto'}`;
    const rand = this._createSeededRandom(seedKey);
    const boxMuller = () => {
      const u1 = rand() || 0.0001;
      const u2 = rand();
      return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    };

    for (let i = 0; i < iterations; i++) {
      // Perturb individual polls by their sampling standard error
      const perturbedPolls = polls.map(poll => {
        const moe = poll.marginOfError || 3.0;
        const se = moe / 1.96;

        const perturbedResults = {};
        const perturbedNeutral = poll.neutralResults ? {} : null;
        for (const cid of candidateIds) {
          const original = poll.results[cid] || 0;
          const noise = boxMuller() * se;
          perturbedResults[cid] = Math.max(0, original + noise);
          if (perturbedNeutral && poll.neutralResults[cid] != null) {
            perturbedNeutral[cid] = Math.max(0, poll.neutralResults[cid] + noise * 0.7 + boxMuller() * se * 0.9);
          }
        }

        return perturbedNeutral
          ? { ...poll, results: perturbedResults, neutralResults: perturbedNeutral }
          : { ...poll, results: perturbedResults };
      });

      const { voteShares } = this.calcWeightedAverage(perturbedPolls, pollsters, electionDate, candidates, scenarioOptions);

      // Apply correlated systemic election shock across all candidates
      const adjustedShares = {};
      if (candidateIds.length === 2) {
        const macroShift = boxMuller() * systemicSigma;
        adjustedShares[candidateIds[0]] = Math.max(0, (voteShares[candidateIds[0]] || 0) + macroShift);
        adjustedShares[candidateIds[1]] = Math.max(0, (voteShares[candidateIds[1]] || 0) - macroShift);
      } else {
        const rawShocks = {};
        let shockSum = 0;
        for (const cid of candidateIds) {
          rawShocks[cid] = boxMuller() * systemicSigma;
          shockSum += rawShocks[cid];
        }
        const meanShock = shockSum / (candidateIds.length || 1);
        for (const cid of candidateIds) {
          adjustedShares[cid] = Math.max(0, (voteShares[cid] || 0) + (rawShocks[cid] - meanShock));
        }
      }

      // Normalize simulated shares to 100%
      const simTotal = Object.values(adjustedShares).reduce((a, b) => a + b, 0) || 1;
      let winnerId = null;
      let maxShare = -1;
      for (const cid of candidateIds) {
        const share = (adjustedShares[cid] / simTotal) * 100;
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
      const meanVal = arr.reduce((sum, v) => sum + v, 0) / arr.length;
      const lower = arr[Math.floor(iterations * 0.025)] || arr[0];
      const upper = arr[Math.floor(iterations * 0.975)] || arr[arr.length - 1];
      const stdDev = Math.sqrt(arr.reduce((sum, v) => sum + Math.pow(v - meanVal, 2), 0) / arr.length);

      ci95[cid] = {
        mean: Math.round(meanVal * 10) / 10,
        lower: Math.round(lower * 10) / 10,
        upper: Math.round(upper * 10) / 10,
        stdDev: Math.round(stdDev * 100) / 100,
      };
    }

    return { winProbabilities, ci95 };
  },

  /**
   * Determine win opportunity rating with dual-threshold (Margin & Probability).
   * Prevents declaring "High Chance" when race margin is within statistical noise.
   * @param {number} margin - Absolute percentage lead between #1 and #2 (e.g. 2.0)
   * @param {number} winProb - Win probability between 0 and 1 (e.g. 0.85)
   * @returns {Object} { text, level }
   */
  getOpportunityRating(margin, winProb) {
    // If within sampling margin of error (<= 3.5%) or probability is close to even (<= 65%), it's a toss-up
    if (margin <= 3.5 || winProb <= 0.65) {
      return { text: '五五波', level: 'medium' };
    }
    // Solid / Safe lead: margin > 12% and win prob >= 95%
    if (margin > 12.0 && winProb >= 0.95) {
      return { text: '機會極高', level: 'high' };
    }
    // Likely lead: margin > 7.0% and win prob >= 80%
    if (margin > 7.0 && winProb >= 0.80) {
      return { text: '機會高', level: 'high' };
    }
    // Lean lead: margin > 3.5% and win prob >= 65%
    if (margin > 3.5 && winProb >= 0.65) {
      return { text: '機會略高', level: 'medium' };
    }
    return { text: '五五波', level: 'medium' };
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
      const { voteShares, weightedPolls } = this.calcWeightedAverage(pollsUpToNow, pollsters, electionDate, candidates, scenarioOptions);
      const leaderId = Object.entries(voteShares).sort(([, a], [, b]) => b - a)[0]?.[0];
      const divSE = leaderId ? this.estimateSE(weightedPolls, leaderId) : 3.0;
      const effectiveSE = Math.hypot(divSE * 0.65, 2.0);
      const winProb = this.calcWinProbability(voteShares, effectiveSE);

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
   * Estimate combined weighted standard error from the poll data.
   * Uses combined poll weights so secular multi-month trends do not artificially inflate cross-pollster variance.
   */
  estimateSE(weightedPolls, candidateId) {
    if (!weightedPolls || weightedPolls.length < 2) return 4.5;

    const totalW = weightedPolls.reduce((sum, p) => sum + (p.weights?.combined || 1), 0) || 1;
    const wMean = weightedPolls.reduce(
      (sum, p) => sum + (p.projectedVoteShare[candidateId] || 0) * (p.weights?.combined || 1),
      0
    ) / totalW;

    const n = weightedPolls.length;
    const wVariance = weightedPolls.reduce((sum, p) => {
      const w = (p.weights?.combined || 1) / totalW;
      const diff = (p.projectedVoteShare[candidateId] || 0) - wMean;
      return sum + w * diff * diff;
    }, 0) * (n / (n - 1));

    return Math.min(Math.max(Math.sqrt(wVariance), 2.2), 5.5);
  },

  /**
   * Get major campaign & televised debate milestones for Chart.js Event Annotation Layer.
   * @param {string} cityId
   * @returns {Array} [{ date, label, category, color, description }]
   */
  getElectionEvents(cityId) {
    const c = (cityId || '').toLowerCase();
    const cityEvents = {
      taipei: [
        { date: '2026-05-20', label: '民進黨徵召沈伯洋', category: 'nomination', color: '#10B981', description: '民進黨正式徵召沈伯洋參選台北市長，開啟雙雄對決' },
        { date: '2026-09-22', label: '信民協會民調差1.2%', category: 'poll_shift', color: '#F59E0B', description: '9/22信民協會（戴立安）雙底冊調查蔣41.7% vs 沈40.5%首度進入誤差範圍' },
        { date: '2026-10-08', label: 'TVBS白營票53%轉沈', category: 'crossover', color: '#8B5CF6', description: '10/8 TVBS調查20-29歲青年與2022黃珊珊選票逾半轉向沈伯洋' },
        { date: '2026-10-20', label: '信民民調沈50.3%逆轉', category: 'crossover', color: '#10B981', description: '10/20信民協會（戴立安）調查沈伯洋50.3%首度逆轉超車蔣萬安33.3%（差17%）' },
        { date: '2026-10-22', label: '震傳媒沈42.8%蔣39.0%', category: 'crossover', color: '#10B981', description: '10/22震傳媒（山水執行）民調沈42.8%領先蔣39.0%，但中立選民蔣29.1%仍領先沈21.0%(未表態49.9%)' },
        { date: '2026-10-27', label: 'ETtoday蔣48.6%沈41.1%', category: 'poll_shift', color: '#2563EB', description: '10/27 ETtoday民調雲公布蔣萬安48.6%領先沈伯洋41.1%（差7.5%），看好度蔣51.3% vs 沈40.9%' },
        { date: '2026-10-28', label: '聯合報沈45%超車蔣41%', category: 'crossover', color: '#10B981', description: '10/28聯合報民調沈伯洋45%超前蔣萬安41%，且中立選民沈40%逆轉領先蔣33%（26%觀望）' },
        { date: '2026-10-31', label: '辯論後TVBS蔣46%沈42%', category: 'debate', color: '#EF4444', description: '10/31電視辯論後TVBS即時民調蔣萬安46% vs 沈伯洋42%（差縮至4%、中立差1%），辯論表現沈47%勝蔣40%' },
        { date: '2026-11-02', label: 'ETtoday蔣52% vs 韜略沈52.6%', category: 'poll_shift', color: '#F59E0B', description: '11/2辯論後兩份民調極端對撞：ETtoday網路調查蔣萬安52.0% vs 沈伯洋40.7%，台灣韜略AI雙底冊民調沈伯洋52.6% vs 蔣萬安35.3%' },
        { date: '2026-11-04', label: 'ETtoday追蹤蔣50.7%沈41.9%', category: 'poll_shift', color: '#2563EB', description: '11/4 ETtoday辯論後追蹤調查蔣萬安50.7%領先沈伯洋41.9%（中立蔣43.8% vs 沈38.5%，市政解決力43.5% vs 43.1%）' },
        { date: '2026-11-15', label: '國策沈46.3% & 鋒燦沈44.7%', category: 'crossover', color: '#10B981', description: '11/15新台灣國策智庫沈伯洋46.3%領先蔣萬安42.2%（中立沈52.1% vs 蔣27.1%）；11/16鋒燦傳媒沈44.7% vs 蔣43.0%（中立蔣40.7% vs 沈28.6%）' },
        { date: '2026-11-16', label: '封關TVBS蔣46%沈44%差2%', category: 'poll_shift', color: '#EF4444', description: '11/16四大封關民調齊發：TVBS蔣46% vs 沈44%(中立沈40% vs 蔣37%)、鋒燦沈44.7% vs 蔣43.0%、信民沈48.6% vs 蔣33.8%、ETtoday蔣48.1% vs 沈42.0%' },
        { date: '2026-11-17', label: '中時蔣44.1% vs TIA沈47.7%', category: 'poll_shift', color: '#F59E0B', description: '11/17封關最後波：中時艾普羅蔣萬安44.1%領先沈伯洋37.1%（中立24.7% vs 23.2%）；台灣勵志協會（TIA）雙底冊沈伯洋47.7%領先蔣萬安42.7%' }
      ],
      newtaipei: [
        { date: '2026-05-29', label: '國民黨徵召李四川', category: 'nomination', color: '#2563EB', description: '國民黨正式徵召李四川出戰新北市長，與蘇巧慧正面對決' },
        { date: '2026-09-23', label: '震傳媒蘇首超車+1.1%', category: 'crossover', color: '#10B981', description: '9/23震傳媒民調蘇巧慧首度微幅超車李四川1.1%，拉開黃金交叉序幕' },
        { date: '2026-10-13', label: '信民民調蘇+13.1%逆轉', category: 'crossover', color: '#10B981', description: '10/13信民協會雙底冊調查蘇巧慧43.1%大勝李四川30.0%' },
        { date: '2026-10-15', label: '皮爾森調查藍綠平盤', category: 'poll_shift', color: '#F59E0B', description: '10/15鉅聞天下皮爾森調查李45.74% vs 蘇45.18%差距僅0.56%' },
        { date: '2026-10-27', label: '號次抽籤蘇1號李3號', category: 'campaign', color: '#6366F1', description: '10/27完成號次抽籤（1號蘇巧慧、2號蘇輝湟、3號李四川），選戰進入倒數30天肉搏' },
        { date: '2026-11-05', label: '鏡新聞蘇47.7%領先李32.8%', category: 'crossover', color: '#10B981', description: '11/5鏡新聞市話民調蘇巧慧47.7%領先李四川32.8%（一定投票蘇55.5% vs 李34.5%，中立蘇20.8% vs 李19.2%）' },
        { date: '2026-11-09', label: '聯合報蘇42%微超李39%', category: 'crossover', color: '#10B981', description: '11/9聯合報雙底冊民調蘇巧慧42%微幅領先李四川39%（差3%，中立選民蘇31% vs 李29%，看好度李37% vs 蘇36%戰平）' },
        { date: '2026-11-13', label: '鋒燦蘇44.0%領先李35.6%', category: 'crossover', color: '#10B981', description: '11/13鋒燦傳媒（台大張佑宗教授）市話＋網路混合民調蘇巧慧44.0%領先李四川35.6%（一定投票蘇47.7% vs 李36.7%，中立選民李24.4% vs 蘇21.7%）' },
        { date: '2026-11-16', label: '中時艾普羅李37.0%蘇33.4%', category: 'poll_shift', color: '#2563EB', description: '11/13台灣研究學會（關鍵調查）李43.1%領先蘇38.4%；11/16中時委託艾普羅李四川37.0% vs 蘇巧慧33.4%（具投票意願李38.9% vs 蘇36.1%）' },
        { date: '2026-11-17', label: '封關TVBS蘇43.0%黃金交叉李42.4%', category: 'crossover', color: '#EF4444', description: '11/17 TVBS封關雙底冊民調蘇巧慧43.0%首度超車李四川42.4%（差0.6%），惟中立選民李38.5%仍領先蘇27.8%（33.2%未決定）' }
      ],
      kaohsiung: [
        { date: '2026-06-02', label: '藍綠對決民調起跑', category: 'nomination', color: '#10B981', description: '民進黨由賴瑞隆出戰對決國民黨柯志恩，陳其邁全力輔選整合' },
        { date: '2026-09-11', label: 'ETtoday藍綠戰平0.3%', category: 'poll_shift', color: '#F59E0B', description: '9/11 ETtoday網路民調柯志恩43.8% vs 賴瑞隆43.5%差距僅0.3%' },
        { date: '2026-10-17', label: '陳其邁站台賴競總成立', category: 'campaign', color: '#10B981', description: '10月17日市長陳其邁親赴賴瑞隆競選總部成立大會交棒催票' },
        { date: '2026-10-30', label: '辯論登場&ETtoday差0.1%', category: 'debate', color: '#EF4444', description: '10/30首場電視辯論登場；同日ETtoday網路民調賴43.2% vs 柯43.1%平盤，中立選民柯38.8%領先賴20.6%' },
        { date: '2026-11-02', label: '聯合報賴40%＆鋒燦賴47.8%', category: 'poll_shift', color: '#10B981', description: '11/2聯合報民調賴瑞隆40%領先柯志恩33%（中立柯25% vs 賴22%）；同日鋒燦傳媒賴47.8%領先柯27.4%' },
        { date: '2026-11-16', label: '年代封關賴43.9%柯24.7%', category: 'poll_shift', color: '#10B981', description: '11/16年代封關民調賴瑞隆43.9%領先柯志恩24.7%（中立賴21.8% vs 柯19.5%，陳其邁滿意度80.9%）' },
        { date: '2026-11-17', label: 'ETtoday封關柯46.1%賴44.6%', category: 'poll_shift', color: '#2563EB', description: '11/17 ETtoday民調雲封關調查柯志恩46.1%微幅領先賴瑞隆44.6%（中立柯52.6% vs 賴21.3%，與電話調查結構差異顯著）' }
      ],
      taichung: [
        { date: '2026-05-15', label: '江啟臣對決何欣純定局', category: 'nomination', color: '#2563EB', description: '藍綠完成台中市長提名布局，江啟臣對決何欣純' },
        { date: '2026-09-15', label: 'TVBS江領先12.6%', category: 'poll_shift', color: '#2563EB', description: '9/15 TVBS調查江啟臣45.1%領先何欣純32.5%' },
        { date: '2026-10-12', label: '循證民調差距縮至1.9%', category: 'crossover', color: '#10B981', description: '10/12循證民調江34.3% vs 何32.4%進入誤差範圍，北屯北區綠營突圍' },
        { date: '2026-10-17', label: '世新大學江穩住+11.1%', category: 'poll_shift', color: '#2563EB', description: '10/17世新大學民調江啟臣39.8% vs 何欣純28.7%（中立江31.5% vs 何22.0%）' },
        { date: '2026-11-02', label: '佛光大學江38.3%領先何28.1%', category: 'poll_shift', color: '#2563EB', description: '11/2佛光大學民調江啟臣38.3%領先何欣純28.1%（差10.2%，未決定25.3%）' },
        { date: '2026-11-03', label: '信民民調何41.1%逆轉江30.4%', category: 'crossover', color: '#10B981', description: '11/3信民協會（戴立安）雙底冊民調何欣純41.1%首度超車江啟臣30.4%（中立何23.9% vs 江18.7%），戴立安推估實際得票五五波' },
        { date: '2026-11-09', label: '世新大學江39.2%領先何30%', category: 'poll_shift', color: '#2563EB', description: '11/9世新大學市話民調江啟臣39.2%領先何欣純30.0%（差9.2%，未決定23.2%），五大指標江全面領先' }
      ],
      tainan: [
        { date: '2026-04-25', label: '陳亭妃出線黃偉哲掌舵', category: 'nomination', color: '#10B981', description: '陳亭妃代表民進黨出戰，市長黃偉哲親任競總主委' },
        { date: '2026-09-08', label: '菱傳媒陳亭妃穩居領先', category: 'poll_shift', color: '#10B981', description: '9/8菱傳媒調查陳亭妃維持穩定領先優勢' },
        { date: '2026-10-21', label: '國策智庫陳59.4%大勝', category: 'poll_shift', color: '#10B981', description: '10/21新台灣國策智庫民調陳亭妃59.4%大幅領先謝龍介22.6%（差距36.8%）' }
      ],
      taoyuan: [
        { date: '2026-05-18', label: '民進黨徵召黃世杰', category: 'nomination', color: '#10B981', description: '民進黨徵召前法務部政次黃世杰挑戰現任市長張善政' },
        { date: '2026-09-22', label: '張善政施政滿意度58.2%', category: 'poll_shift', color: '#2563EB', description: '9/22新台灣國策智庫調查張善政47.0%大幅領先黃世杰25.9%' },
        { date: '2026-10-27', label: '號次抽籤黃1號張2號', category: 'campaign', color: '#6366F1', description: '10/27完成號次抽籤（1號黃世杰、2號張善政），藍營執政優勢穩固' },
        { date: '2026-11-04', label: 'ETtoday張47.4%領先黃36.0%', category: 'poll_shift', color: '#2563EB', description: '11/4 ETtoday民調雲張善政47.4%領先黃世杰36.0%（差11.4%），看好度56.8% vs 30.9%' },
        { date: '2026-11-05', label: '年代民調張35%勝黃28%', category: 'poll_shift', color: '#F59E0B', description: '11/5年代民調張善政35.0%領先黃世杰28.0%（差7%），一定投票選民張36.8% vs 黃32.5%差距縮至4.3%' },
        { date: '2026-11-10', label: '信民民調張36.9%黃32.8%拉近', category: 'crossover', color: '#10B981', description: '11/10信民協會（戴立安）雙底冊民調張善政36.9% vs 黃世杰32.8%差4.1%（一定投票黃42.7%反超張41.4%，看好度張56.4% vs 黃14.8%）' }
      ],
      hsinchucity: [
        { date: '2026-06-25', label: '高虹安莊競程何志勇三腳督', category: 'nomination', color: '#28C8C8', description: '高虹安（藍白合）爭取連任，民進黨徵召莊競程、無黨籍何志勇參選形成三腳督' },
        { date: '2026-09-16', label: 'ETtoday高48.6%領跑', category: 'poll_shift', color: '#28C8C8', description: '9/16 ETtoday民調高虹安48.6%大幅領先莊競程21.2%、何志勇1.8%' },
        { date: '2026-09-22', label: '匯流民調高49.5%居冠', category: 'poll_shift', color: '#28C8C8', description: '9/22匯流民調高虹安49.5% vs 莊競程25.7% vs 何志勇6.1%' },
        { date: '2026-11-03', label: '循證民調高38.1%莊36.1%拉鋸', category: 'crossover', color: '#10B981', description: '11/3 Newtalk循證民調高虹安38.1% vs 莊競程36.1%差距縮至2%，一定投票族群莊39.4%反超高36.1%' },
        { date: '2026-11-05', label: 'TVBS民調高46%勝莊31%', category: 'poll_shift', color: '#28C8C8', description: '11/5文大陳毓麒教授委託TVBS調查高虹安46%領先莊競程31%（中立高42% vs 莊13%，碩士以上高60%）' },
        { date: '2026-11-16', label: '民主法律學會高22.7%莊21.8%', category: 'poll_shift', color: '#F59E0B', description: '11/16台灣民主法律學會（窩窩科技AI電訪）高虹安22.7% vs 莊競程21.8% vs 何志勇14.3%（未表態35.6%）' }
      ],
      keelung: [
        { date: '2026-07-22', label: '議長童子瑋挑戰謝國樑', category: 'nomination', color: '#10B981', description: '民進黨徵召基隆市議長童子瑋對決現任市長謝國樑' },
        { date: '2026-09-24', label: '山水民調一定投票童反超', category: 'crossover', color: '#F59E0B', description: '9/24山水民調謝38.0% vs 童34.2%，一定投票族群童子瑋反超1.5%' },
        { date: '2026-10-15', label: '趨勢民調差距拉鋸4.6%', category: 'poll_shift', color: '#2563EB', description: '10/15趨勢民調謝國樑42.9%領先童子瑋38.3%，選情緊咬' },
        { date: '2026-10-20', label: '公信力民調謝+5.6%拉鋸', category: 'poll_shift', color: '#2563EB', description: '10/20全國公信力民調謝國樑41.3%領先童子瑋35.7%，施政滿意度52.7%' },
        { date: '2026-10-23', label: '鏡新聞童37.0%黃金交叉', category: 'crossover', color: '#10B981', description: '10/23鏡新聞民調童子瑋37.0%微幅超車謝國樑36.3%（差0.7%），一定投票童44.8% vs 謝40.1%' },
        { date: '2026-10-24', label: '雨晴指標謝40.5%反擊', category: 'poll_shift', color: '#2563EB', description: '10/24謝國樑競辦公布雨晴指標民調謝40.5%領先童33.2%（差7.3%），藍綠民調激戰' },
        { date: '2026-11-04', label: '艾普羅謝36.1%童35.6%平手', category: 'poll_shift', color: '#F59E0B', description: '11/4基隆港務工會委託艾普羅民調謝國樑36.1% vs 童子瑋35.6%僅差0.5%，一定投票童41.0%反超謝40.4%' },
        { date: '2026-11-13', label: '思傳媒/戴立安童38.4%超車', category: 'crossover', color: '#10B981', description: '11/13思傳媒委託戴立安雙底冊民調童子瑋38.4%反超謝國樑35.1%（一定投票童48.5% vs 謝39.5%領先9%）' }
      ],
      hsinchucounty: [
        { date: '2026-05-18', label: '徐欣瑩對決竹北鄭朝方', category: 'nomination', color: '#2563EB', description: '國民黨徐欣瑩對決竹北市長鄭朝方' },
        { date: '2026-09-09', label: 'TVBS徐欣瑩領先3.2%', category: 'poll_shift', color: '#2563EB', description: '9/9 TVBS調查徐欣瑩39.8%微幅領先鄭朝方36.6%' },
        { date: '2026-09-21', label: '年代民調鄭朝方+6.4%逆轉', category: 'crossover', color: '#10B981', description: '9/21年代民調鄭朝方35.1%首度逆轉超車徐欣瑩28.7%，實現黃金交叉' },
        { date: '2026-10-27', label: '皮爾森民調鄭50.3%破五成', category: 'crossover', color: '#10B981', description: '10/27鄭朝方陣營公布皮爾森數據調查鄭朝方50.30%領先徐欣瑩34.87%（中立選民鄭54.95% vs 徐25.49%）' },
        { date: '2026-10-29', label: '關鍵調查徐44.1%反超', category: 'poll_shift', color: '#2563EB', description: '10/29台灣公共政策學會公布關鍵調查市話民調徐欣瑩44.1%領先鄭朝方37.7%（差6.4%）' },
        { date: '2026-11-12', label: '年代鄭36.9% vs 關鍵徐44.4%', category: 'poll_shift', color: '#F59E0B', description: '11/12同日兩份市話民調對決：年代民調鄭朝方36.9%領先徐欣瑩28.6%（中立鄭30.8% vs 徐16.6%）；關鍵調查徐欣瑩44.4%領先鄭朝方37.5%' },
        { date: '2026-11-15', label: '精確網路大樣本徐43.3%鄭36%', category: 'poll_shift', color: '#2563EB', description: '11/15精確調查網路大樣本（N=3722）徐欣瑩43.3%領先鄭朝方36.0%（朱定瑀4.6%，竹北徐42.9% vs 鄭36.9%）' }
      ],
      taitung: [
        { date: '2026-05-18', label: '議長吳秀華對決陳瑩', category: 'nomination', color: '#2563EB', description: '國民黨台東縣議會議長吳秀華接棒饒慶鈴，對決民進黨立委陳瑩' },
        { date: '2026-09-06', label: '鏡新聞吳秀華51.5%過半', category: 'poll_shift', color: '#2563EB', description: '9/6鏡新聞雙底冊民調吳秀華51.5%大幅領先陳瑩33.8%' },
        { date: '2026-11-07', label: 'ETtoday吳43.6%領先陳29.3%', category: 'poll_shift', color: '#2563EB', description: '11/7 ETtoday民調雲吳秀華43.6%領先陳瑩29.3%（差14.3%），看好度42.7% vs 25.7%' },
        { date: '2026-11-11', label: '大地民調吳35.7%陳31.1%拉近', category: 'crossover', color: '#10B981', description: '11/11陳瑩競總委託大地民調吳秀華35.7% vs 陳瑩31.1%（差4.6%），一定會投票族群吳39.9% vs 陳37.3%差僅2.6%' }
      ],
      changhua: [
        { date: '2026-07-25', label: '邱建富參選形成三腳督', category: 'nomination', color: '#F59E0B', description: '前彰化市長邱建富投入選戰，與陳素月、魏平政形成三腳督' },
        { date: '2026-09-18', label: '鏡新聞陳素月領先14.7%', category: 'poll_shift', color: '#10B981', description: '9/18鏡新聞調查陳素月37.2% vs 魏平政22.5% vs 邱建富13.0%' },
        { date: '2026-10-19', label: '聯合報陳素月32%倍數領先', category: 'poll_shift', color: '#10B981', description: '10/19聯合報民調陳素月32%穩居第一、魏平政16%、邱建富10%' }
      ],
      hualien: [
        { date: '2026-08-25', label: '游淑貞泛藍三腳督領跑', category: 'nomination', color: '#2563EB', description: '國民黨提名游淑貞接棒，迎戰無黨籍張峻與魏嘉賢' },
        { date: '2026-11-13', label: '窩窩AI游25.3%魏25.1%張25.0%', category: 'poll_shift', color: '#F59E0B', description: '11/13臺北國際商會委託窩窩科技AI雙底冊民調呈現游25.3%、魏25.1%、張25.0%三強毫釐平手' },
        { date: '2026-11-15', label: '風傳媒封關游30.5%張峻19.1%', category: 'poll_shift', color: '#2563EB', description: '11/15風傳媒封關民調游淑貞30.5%領先張峻19.1%、魏嘉賢13.6%（一定投票游38.5% vs 張25.3% vs 魏14.6%）' }
      ],
      yilan: [
        { date: '2026-09-17', label: '菱傳媒林國漳39.8%領先吳35.2%', category: 'poll_shift', color: '#10B981', description: '9/17菱傳媒（皮爾森數據）大樣本調查林國漳39.8%領先藍白整合吳宗憲35.2%' },
        { date: '2026-11-17', label: '封關台灣研究學會林38.7%吳37.7%', category: 'poll_shift', color: '#F59E0B', description: '11/17台灣研究學會（趨勢民調執行）封關前市話調查林國漳38.7%微幅領先吳宗憲37.7%，差距縮至1.0%進入五五波' }
      ],
      penghu: [
        { date: '2026-06-20', label: '陳光復傷退吳淑瑾代夫出征', category: 'nomination', color: '#10B981', description: '民進黨徵召吳淑瑾對決國民黨陳振中與無黨籍葉竹林' },
        { date: '2026-11-16', label: '北市大封關陳28.89%吳21.64%', category: 'poll_shift', color: '#2563EB', description: '11/16國民黨委託北市大民調陳振中28.89%領先吳淑瑾21.64%、葉竹林16.53%' }
      ]
    };

    return cityEvents[c] || [
      { date: '2026-06-01', label: '各陣營完成提名布局', category: 'nomination', color: '#6366F1', description: '藍綠白各陣營完成地方首長提名與基層整合' },
      { date: '2026-09-01', label: '競選總部成立動員潮', category: 'campaign', color: '#F59E0B', description: '選戰進入百日衝刺，各陣營陸續成立競選總部' }
    ];
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

    // Auto-inject fundamentals and cityId if historicalDemographics provided
    let options = scenarioOptions ? { ...scenarioOptions } : {};
    const cityId = pollData.city || (pollData.electionId ? pollData.electionId.split('-')[1] : null);
    options.cityId = cityId;

    if (options.historicalDemographics && cityId && !options.fundamentals) {
      options.fundamentals = this.getBayesianFundamentals(cityId, options.historicalDemographics);
    }

    // Step 1: Calculate weighted average (with Bayesian Fundamentals Blending)
    const { voteShares, rawPollShares, weightedPolls, totalWeight, fundamentalsWeight } = this.calcWeightedAverage(
      polls, pollsters, electionDate, candidates, options
    );

    // Compute default baseline shares (without Recall Raking) when Recall Raking or custom scenario is active
    let baselineComparison = null;
    if (options.applyRecallRaking || options.usePriorUndecided === false || (options.undecidedLean && options.undecidedLean !== 0) || options.applyBiasCorrection === false) {
      const defaultOpts = {
        ...options,
        undecidedLean: 0,
        applyBiasCorrection: true,
        applyRecallRaking: false,
        usePriorUndecided: true
      };
      const baseRes = this.calcWeightedAverage(polls, pollsters, electionDate, candidates, defaultOpts);
      baselineComparison = {
        defaultShares: baseRes.voteShares,
        deltas: {}
      };
      for (const c of candidates) {
        baselineComparison.deltas[c.id] = Math.round(((voteShares[c.id] || 0) - (baseRes.voteShares[c.id] || 0)) * 10) / 10;
      }
    }

    // Step 2: Estimate standard error from poll variance
    const leaderId = Object.entries(voteShares).sort(([, a], [, b]) => b - a)[0]?.[0];
    const se = leaderId ? this.estimateSE(weightedPolls, leaderId) : 3.0;

    // Step 3: Run Monte Carlo simulation for 95% Confidence Intervals & probabilities
    const { winProbabilities: mcWinProbs, ci95 } = this.runMonteCarloSimulation(
      polls, pollsters, electionDate, candidates, 3000, options
    );

    // Dynamic win probability fallback blend
    const winProbabilities = mcWinProbs && Object.keys(mcWinProbs).length > 0
      ? mcWinProbs
      : this.calcWinProbability(voteShares, se);

    // Step 4: Generate prediction log and sync final entry with exact Monte Carlo winProbabilities
    const predictionLog = this.generatePredictionLog(polls, pollsters, electionDate, candidates, options);
    if (predictionLog.length > 0 && winProbabilities) {
      predictionLog[predictionLog.length - 1].winProbabilities = { ...winProbabilities };
    }

    // Step 5: Calculate "others" share
    const totalCandidateShare = Object.values(voteShares).reduce((a, b) => a + b, 0);
    const predictedVoteShares = { ...voteShares };
    if (totalCandidateShare < 100) {
      predictedVoteShares.others = Math.round((100 - totalCandidateShare) * 10) / 10;
    }

    // Step 6: Calculate Partisan Shift Index if pastResults provided
    let partisanShift = null;
    if (options.pastResults && cityId) {
      partisanShift = this.calculatePartisanShift(predictedVoteShares, cityId, options.pastResults, candidates);
    }

    // Step 7: Generate AI Model Assessment & Campaign Events
    const aiAssessment = this.getAIElectionAssessment(pollData.electionId, pollData.city || pollData.cityName, {
      predictedVoteShares,
      winProbabilities,
      candidates,
      se,
      weightedPolls
    });
    const events = this.getElectionEvents(cityId);

    return {
      electionId: pollData.electionId,
      electionName: pollData.electionName,
      electionDate: pollData.electionDate,
      candidates,
      predictedVoteShares,
      rawPollShares,
      winProbabilities,
      ci95,
      standardError: Math.round(se * 100) / 100,
      weightedPolls,
      predictionLog,
      totalWeight: Math.round(totalWeight * 1000) / 1000,
      pollCount: polls.length,
      fundamentals: options.fundamentals || null,
      fundamentalsWeight: fundamentalsWeight || 0,
      partisanShift,
      aiAssessment,
      events,
      baselineComparison,
      scenarioActive: Boolean(baselineComparison),
      analysisTimestamp: new Date().toISOString(),
    };
  },

  /**
   * AI Model Election Assessment Engine.
   * Generates dynamic, data-driven political science commentary and intelligence briefs.
   * @param {string} electionId
   * @param {string} city
   * @param {Object} context - { predictedVoteShares, winProbabilities, candidates, se, weightedPolls }
   * @returns {Object} { shortBrief, detailedBrief, factors, confidence }
   */
  getAIElectionAssessment(electionId, city, context = {}) {
    const c = (city || '').toLowerCase();
    const id = (electionId || '').toLowerCase();

    let cityKey = c;
    if (!cityKey || cityKey === 'undefined') {
      const allKeys = [
        'newtaipei', 'taipei', 'taoyuan', 'taichung', 'tainan', 'kaohsiung',
        'keelung', 'hsinchucity', 'hsinchucounty', 'miaoli', 'changhua',
        'nantou', 'yunlin', 'chiayicity', 'chiayicounty', 'pingtung',
        'yilan', 'hualien', 'taitung', 'penghu', 'kinmen', 'lienchiang'
      ];
      for (const k of allKeys) {
        if (id.includes(k)) {
          cityKey = k;
          break;
        }
      }
    }

    const assessments = {
      newtaipei: {
        shortBrief: '全台最大票倉封關陷入毫釐五五波肉搏！模型預估蘇巧慧 50.9% vs 李四川 49.1%（差距 1.8%，勝率 63.9% vs 36.1%；若開啟 2022 實際得票回溯加權則為李四川 52.4% vs 蘇巧慧 47.6%）。11月17日最後壓軸《TVBS》封關雙底冊民調獲最高權重 23.6%（蘇 43.0% 首度黃金交叉李 42.4%，惟中立選民李 38.5% 仍領先蘇 27.8%），與 11/13《鋒燦》（19.1%）及 11/16《中時艾普羅》（16.8%）正面對沖！',
        detailedBrief: '新北市選情在封關前夕進入最膠著的五五波對決！11 月 17 日《TVBS 民調中心》壓軸公布封關雙底冊調查（11/15-16 執行，市話 779＋手機 548 共 N=1,327，誤差 ±2.7%，權重 23.6%），有投票意願選民中蘇巧慧以 43.0% 首度微幅超車李四川 42.4%（黃金交叉，僅差 0.6%，蘇輝湟 0.9%、未決定 13.6%），惟中立選民仍呈李四川 38.5% 領先蘇巧慧 27.8%（33.2% 未決定），且侯友宜 2022 選票僅 66.7% 移轉李四川、24.4% 轉投蘇巧慧。同時 11/13《鋒燦傳媒》（張佑宗教授，N=2,033，權重 19.1%）蘇 44.0% 勝李 35.6%；藍營則有 11/16《中時艾普羅》（權重 16.8%，李 37.0% vs 蘇 33.4%）與 11/13《台灣研究學會》（權重 15.3%，李 43.1% vs 蘇 38.4%）支撐。ClearPoll 綜合加權後推算蘇巧慧 50.9% vs 李四川 49.1%（開啟 2022 回溯加權則為李四川 52.4% vs 蘇巧慧 47.6%），勝負完全取決於投票率與三分之一未決定中立選民的臨門一腳！',
        factors: [
          '11/17 TVBS 封關壓軸（N=1,327，權重 23.6%）：蘇 43.0% 首度黃金交叉李 42.4%（單筆推估蘇 50.8% vs 李 49.2%），中立選民李 38.5% 領先蘇 27.8%',
          '11/13 鋒燦 1:1 混合大樣本（權重 19.1%）vs 11/16 中時艾普羅（16.8%）、11/13 台灣研究學會（15.3%）多方拉鋸',
          '侯票鬆動與白營歸隊對決：2022 投侯者 24.4% 轉蘇，惟民眾黨認同者 81.7% 挺李；標準模型蘇 50.9% : 李 49.1%（回溯 2022 則李 52.4% 領先）'
        ],
        confidence: '五五波拉鋸 (差距1.8%)'
      },
      kaohsiung: {
        shortBrief: '封關兩波電話與網路民調正面交鋒，綠營賴瑞隆維持穩定優勢！模型預估賴瑞隆 54.5% vs 柯志恩 45.5%（差距 9.0%，勝率 91.0% vs 9.0%；開啟 2022 回溯加權則為賴 55.0% vs 柯 45.0%）。11月16日《年代》市話賴 43.9% 大勝柯 24.7%（權重 21.8%），11月17日《ETtoday民調雲》網路封關則測得柯 46.1% 微超賴 44.6%（權重 20.6%，中立柯 52.6% vs 賴 21.3%），方法論平衡後綠營仍守穩領先！',
        detailedBrief: '高雄市在封關最後兩日迎來「傳統市話 vs 網路會員問卷」方法論終極對比！11 月 16 日《年代民調中心》（CATI 市話 N=1,070，權重 21.8%）顯示賴瑞隆以 43.9% 大幅領先柯志恩 24.7%（中立賴 21.8% vs 柯 19.5%，陳其邁施政滿意度高達 80.9%）；隔日 11 月 17 日《ETtoday民調雲》公布封閉式網路會員調查（N=1,296，誤差 ±2.72%，權重 20.6%），在具投票意願受訪者中柯志恩以 46.1% 微幅領先賴瑞隆 44.6%（差距僅 1.5%，在誤差範圍內），且網路中立選民呈現柯 52.6% vs 賴 21.3%。這清楚反映非隨機網路會員庫在高雄都會藍白族群的選擇性偏態——ETtoday 過去四波高雄調查均呈現藍綠平盤或柯微幅領先，與聯合報（賴 40:33）、鋒燦（賴 47.8:27.4）及年代（賴 43.9:24.7）等雙底冊／市話結構截然不同。ClearPoll 綜合加權 14 筆調查並透過方法論係數平衡後，推算賴瑞隆仍以 54.5% vs 柯志恩 45.5%（開啟 2022 回溯加權為 55.0% vs 45.0%）穩健領先，藍營若欲翻盤須仰賴極高青年與中間選民臨場投票率！',
        factors: [
          '11/16 年代（21.8%）vs 11/17 ETtoday（20.6%）：年代市話賴 43.9% 勝柯 24.7%（陳其邁滿意度 80.9%），ETtoday 網路會員柯 46.1% 微超賴 44.6%',
          '網路會員選擇性偏態解析：ETtoday 高雄中間選民柯 52.6% 對賴 21.3%，異於聯合報(25:22)與年代(19.5:21.8)電訪結構',
          '多機構綜合勝率 91.0%：納入 11/2 鋒燦(21.5%)、聯合報(17.6%)與年代共同平衡後，賴瑞隆維持 9 個百分點領先優勢'
        ],
        confidence: '穩固領先 (綠勝率91.0%)'
      },
      taichung: {
        shortBrief: '藍營江啟臣在 11/9 世新大學最新民調穩住陣腳，模型預估江啟臣 53.5% vs 何欣純 46.5%（差距 7.0%，勝率 85.4% vs 14.6%；開啟 2022 回溯加權為江 54.7% vs 何 45.3%）。11月9日《世新大學》市話民調江啟臣以 39.2% 領先何欣純 30.0%（差 9.2%），與 11月3日《信民協會》（何 41.1% vs 江 30.4%）形成市話與雙底冊的正面交鋒！',
        detailedBrief: '台中市選情在 11 月初上演藍綠民調拉鋸戰！繼 11 月 3 日《信民協會》（戴立安規劃）雙底冊電訪顯示何欣純 41.1% 首度逆轉江啟臣 30.4%（中立何 23.9% vs 江 18.7%，惟看好度江 39.7% 仍領先何 25.4%，戴立安推估實際得票五五波）後，11 月 9 日台中市議會國民黨團公布委託《世新大學民調中心》執行之最新市話調查（11/5-7 執行，N=1,068，誤差 ±3.0%），江啟臣以 39.2% 領先何欣純 30.0%（差距 9.2%，未決定 23.2%），在支持度、經驗能力、政見評價與看好度五大指標均居上風，與 11 月 2 日《佛光大學》（江 38.3% vs 何 28.1%）走勢一致。ClearPoll 模型同時納入 11/9 世新大學（權重 32.4%，與 10/17 世新同機構去重）、11/3 信民協會（權重 26.1%，含樣本政黨結構 Raking 收斂）與 11/2 佛光大學（權重 21.5%）後，預估江啟臣得票率為 53.5% vs 何欣純 46.5%（開啟 2022 回溯加權為江 54.7% vs 何 45.3%），江啟臣維持穩定領先優勢！',
        factors: [
          '11/9 世新大學最新民調：江啟臣39.2%領先何欣純30.0%（差9.2%），與11/2佛光大學(38.3% vs 28.1%)穩住藍營市話基本盤',
          '雙底冊 vs 市話方法論對決：11/3信民協會雙底冊何欣純41.1% vs 江30.4%（模型自動校正綠34.4%對藍19.6%樣本偏誤）',
          '支持度與看好度指標：信民民調何支持度占優但江看好度(39.7% vs 25.4%)領先，世新大學五大面向指標均由江啟臣居首'
        ],
        confidence: '優勢領先 (藍領先7.0%)'
      },
      taipei: {
        shortBrief: '封關前夕六大終局民調匯流，首都鎖死 50:50 終極肉搏！模型預估沈伯洋 50.3% vs 蔣萬安 49.7%（差距僅 0.6%，勝率 54.2% vs 45.8%；開啟 2022 回溯加權則為蔣萬安 50.6% vs 沈伯洋 49.4%）。11月17日最後兩波封關對撞：《中時艾普羅》蔣 44.1% 勝沈 37.1%（中立 24.7% vs 23.2%），《台灣勵志協會（TIA）》雙底冊沈 47.7% 勝蔣 42.7%，與 11/16《TVBS》（蔣 46% vs 沈 44%）及《鋒燦》（沈 44.7% vs 蔣 43.0%）完全指向毫釐決戰！',
        detailedBrief: '台北市選情在 11 月 17 日封關最後倒數迎來最後兩份壓線民調，使封關週累計共七份權威調查同台定錨！11 月 17 日《中國時報》委託「艾普羅」執行市話封關（11/13-15 執行，N=1,071，權重 7.7%），蔣萬安以 44.1% 領先沈伯洋 37.1%（一定會投 49% vs 42%，中立選民蔣 24.7% vs 沈 23.2%，民眾黨 74.9% 挺蔣）；同日《台灣勵志協會（TIA）》公布委託「故鄉市場調查」執行之雙底冊電訪（N=1,325，權重 8.3%），沈伯洋則以 47.7% 領先蔣萬安 42.7%（差距 5.0%，蔣萬安施政滿意度 52.7%）。結合前一日 11 月 16 日《鋒燦傳媒》（權重 10.6%，沈 44.7% vs 蔣 43.0%）、《TVBS》（權重 9.9%，蔣 46% vs 沈 44%，中立沈 40% vs 蔣 37%）、《信民協會》（權重 8.5%，沈 48.6% vs 蔣 33.8%）與《ETtoday》（蔣 48.1% vs 沈 42.0%），ClearPoll 綜合加權 23 筆追蹤民調後，標準模型推算 **沈伯洋 50.3% vs 蔣萬安 49.7%**（差距僅 0.6%，開啟 2022 回溯加權則為 **蔣萬安 50.6% vs 沈伯洋 49.4%**），寫下台北市長選舉史上最接近的預測天平！',
        factors: [
          '11/17 中時艾普羅 vs 台灣勵志協會（TIA）：中時市話蔣 44.1% 勝沈 37.1%（中立差 1.5%），TIA 雙底冊沈 47.7% 勝蔣 42.7%',
          '11/16 鋒燦（10.6%）＆ TVBS（9.9%）雙核心：鋒燦沈 44.7% vs 蔣 43.0%，TVBS 蔣 46% vs 沈 44%（中立沈 40% 反超蔣 37%）',
          '藍白整合 vs 黃珊珊票源裂解：中時/信民/鋒燦顯示白營支持者 74.9%~81.2% 挺蔣，但 TVBS 顯示 2022 投黃珊珊選民仍有 53% 轉投沈伯洋',
          '終極 0.6% 五五波拉鋸：標準模型沈 50.3% 微幅領先，回溯加權蔣 50.6% 微幅領先，投票日青壯年與長者出門率決定首都歸屬'
        ],
        confidence: '五五波拉鋸 (差距僅0.6%)'
      },
      taoyuan: {
        shortBrief: '現任市長張善政維持穩定領先，惟 11/10 信民協會雙底冊顯示黃世杰急起直追！模型預估張善政 57.7% vs 黃世杰 42.3%（差距 15.4%，勝率 99.7%；開啟 2022 回溯加權為張 57.2% vs 黃 42.8%）。11月10日《信民協會》（戴立安規劃）雙底冊民調張善政 36.9% vs 黃世杰 32.8%（差 4.1%，中立選民張 24.6% vs 黃 14.8%，一定投票選民黃 42.7% 反超張 41.4%，看好度張 56.4% vs 黃 14.8%）！',
        detailedBrief: '桃園市選情在 11 月上旬出現顯著收斂，但現任市長張善政仍掌握穩固結構優勢。11 月 10 日《信民協會》公布由戴立安問卷設計分析、畢肯市場研究執行之雙底冊電訪（市話 751 + 手機 323，共 1,074 份，誤差 ±3.0%），國民黨張善政以 36.9% 領先民進黨黃世杰的 32.8%（差距縮小至 4.1%，未明確回答與不投合計 30.3%）；在自述「一定會去投票」選民中，黃世杰更以 42.7% 微幅反超張善政 41.4%（黃支持者一定投票意願 81.3% 高於張的 69.9%）。然而在中立選民（占 32.3%）中，張善政仍以 24.6% 領先黃世杰 14.8%（未表態 60.6%），且當選看好度張善政高達 56.4% 遠勝黃世杰 14.8%（另有 45%~55% 受訪者表示不認識或無法評價黃世杰）。由於該波調查樣本政黨認同呈現綠大於藍（民進黨 32.4% vs 國民黨 21.7%），戴立安綜合投票率與歷史參數推估實際得票率為張善政 53.8%~57.5% vs 黃世杰 42.5%~46.2%；ClearPoll 模型自動啟動「樣本政黨結構偏差收斂（Raking，調整後張 38.6% vs 黃 31.1%）」並結合 11/5 年代（張 35% vs 黃 28%）、11/4 ETtoday（張 47.4% vs 黃 36.0%）及桃園偏藍結構先驗後，推算張善政以 57.7% vs 黃世杰 42.3%（開啟 2022 回溯加權為 57.2% vs 42.8%）穩居上風！',
        factors: [
          '11/10 信民協會雙底冊拉近：張善政36.9% vs 黃世杰32.8%（差4.1%），一定會投票族群黃42.7%微幅反超張41.4%',
          '中立選民與看好度張善政占優：信民調查中立選民張24.6%勝黃14.8%，當選看好度張56.4%遠高於黃14.8%（近半選民仍不認識黃）',
          '樣本政黨結構自動收斂：信民樣本綠32.4%對藍21.7%，模型啟動Raking校正並與年代(35%對28%)、ETtoday(47.4%對36%)加權整合'
        ],
        confidence: '穩固領先 (綠高投票意願追近)'
      },
      tainan: {
        shortBrief: '綠營陳亭妃位居絕對領先，預估得票率約 63.5% vs 36.5%（差距 27.0%）。10月21日新台灣國策智庫最新民調陳亭妃 59.4% 大幅領先謝龍介 22.6%（看好度 70.5% vs 15.9%），綠營堡壘難以撼動。',
        detailedBrief: '台南市為傳統綠營核心堡壘。10月21日新台灣國策智庫公布最新市話調查（N=1,071），民進黨陳亭妃以 59.4% 支持度大幅領先國民黨謝龍介 22.6%（差距達 36.8 個百分點，未表態 17.0%，當選看好度陳亭妃高達 70.5% vs 謝龍介 15.9%）。雖然謝龍介陣營強烈質疑該智庫數據並積極透過議題凝聚在野力量，但綜合菱傳媒、TVBS 與美麗島等歷次調查，陳亭妃均維持穩定領先，模型預估陳亭妃得票率為 63.5% vs 謝龍介 36.5%，勝選機會極高。',
        factors: [
          '核心勝負手：溪北原縣區農漁民與深綠動員',
          '基本盤結構：台南深綠版圖穩固 (歷史綠盤約 60%)',
          '機構效應：新台灣國策智庫(+36.8%綠) 與菱傳媒(+17.1%綠) 一致顯示陳亭妃大幅領跑'
        ],
        confidence: '絕對優勢 (機會極高)'
      },
      keelung: {
        shortBrief: '基隆陷入極限五五波貼身肉搏！模型預估謝國樑 51.1% vs 童子瑋 48.9%（差距僅 2.2%，勝率 67.3% vs 32.7%；開啟 2022 回溯加權為謝 52.4% vs 童 47.6%）。11月13日《思傳媒》（戴立安規劃／畢肯執行）雙底冊民調童子瑋以 38.4% 反超謝國樑 35.1%（一定會投票選民童 48.5% vs 謝 39.5% 擴大領先 9.0%），與 11/4《艾普羅》（36.1% vs 35.6%）形成連續翻轉壓力！',
        detailedBrief: '基隆市選情在辯論與封關前夕進入白熱化換黨邊緣！繼 11 月 4 日《艾普羅》市話調查呈現極限平手（謝國樑 36.1% vs 童子瑋 35.6%，一定投票童 41.0% 反超謝 40.4%）後，11 月 13 日《思傳媒》公布由戴立安問卷設計分析、畢肯市場研究執行之雙底冊民調（11/9-11 執行，市話 749 + 手機 324，N=1,073，誤差 ±3.0%），民進黨童子瑋以 38.4% 正式反超謝國樑的 35.1%（差距 3.3%，魏造文 2.0%，未決定合計 24.5%），並在占 71.2% 之「一定會投票」選民中以 48.5% 領先謝國樑 39.5%（差距達 9.0%），同時有 42.4% 市民認為應換民進黨做做看（高於國民黨續任 31.8%）。ClearPoll 模型納入 11/13 思傳媒（最高單筆權重 25.3%，單筆推估童 51.8% vs 謝 48.2%）與 11/4 艾普羅（18.0%，單筆推估童 51.2% vs 謝 48.8%），配合前期鏡新聞、雨晴與趨勢民調後，整體加權預測謝國樑 51.1% vs 童子瑋 48.9%（差距僅 2.2%，開啟 2022 回溯加權為 52.4% vs 47.6%），基隆已成為藍綠勝負最難預料的激戰區之一！',
        factors: [
          '11/13 思傳媒（戴立安）雙底冊反超：童子瑋 38.4% 勝謝國樑 35.1%（一定會投票族群擴大至 48.5% vs 39.5%），42.4% 認應政黨輪替',
          '連續兩波一定投票結構警訊：11/4 艾普羅與 11/13 思傳媒雙底冊均顯示綠營核心選民投票意願顯著高於藍營基本盤',
          '極限五五波拉鋸（差距 2.2%）：33.3% 高比例中立選民與高達 24.5% 未決定選民的最後倒數表態將決定基隆藍綠版圖'
        ],
        confidence: '五五波拉鋸 (差距僅2.2%)'
      },
      hsinchucity: {
        shortBrief: '高虹安維持兩位數領先，惟 11/16 AI 封關民調呈現低表態拉鋸！模型預估高虹安 50.5% vs 莊競程 38.6% vs 何志勇 10.9%（勝率 99.2%；開啟 2022 回溯加權為高 45.4% vs 莊 38.8% vs 何 15.7%）。11月16日《台灣民主法律學會》（窩窩科技 AI 電訪）高 22.7% vs 莊 21.8% vs 何 14.3%（未表態高達 35.6%），與 11/5《TVBS》（高 46% vs 莊 31%）形成對照！',
        detailedBrief: '新竹市在封關日迎來第三份封關前調查《台灣民主法律學會》（11/14-15 由明新科大林冠年主持、窩窩科技執行 AI 語音電訪，N=1,103，誤差 ±3.0%），結果顯示高虹安 22.7%、莊競程 21.8%、何志勇 14.3%（未表態與拒答高達 35.6%）。相較之下，11 月 5 日文大陳毓麒教授委託《TVBS民調中心》（CATI 市話 N=1,098，權重 30.2%）高虹安在具投票意願選民中以 46.0% 大勝莊競程 31.0% 與何志勇 2.0%（中立高 42% vs 莊 13%，碩士以上高 60%），而 11 月 3 日《循證民調》（權重 23.2%）則為高 38.1% vs 莊 36.1%。ClearPoll 模型依 IVR AI 語音抽樣方法論（0.75x）與機構權重給予 11/16 AI 民調 23.9% 權重並與 TVBS、循證民調平衡整合後，推算高虹安 50.5% vs 莊競程 38.6% vs 何志勇 10.9%（開啟 2022 回溯加權為高 45.4% vs 莊 38.8% vs 何 15.7%），高虹安仍保持穩健勝出態勢。',
        factors: [
          '11/16 台灣民主法律學會 AI 封關（權重 23.9%）：高虹安 22.7% vs 莊競程 21.8% vs 何志勇 14.3%（未表態達 35.6%）',
          '11/5 TVBS vs 11/3 循證對照：TVBS（權重 30.2%）高虹安 46% 領先莊 31%（中立高 42% vs 莊 13%），循證（權重 23.2%）則縮至 38.1% vs 36.1%',
          '藍白整合與棄保程度：TVBS 顯示國民黨 81%、民眾黨 95% 集中挺高（何志勇僅 2%），而 AI 問卷顯示何志勇仍獲 14.3%，最終棄保幅度決定高虹安過半高度'
        ],
        confidence: '穩固領先 (高過半優勢)'
      },
      hsinchucounty: {
        shortBrief: '全國唯一 0.2% 極限五五波血戰！模型預估鄭朝方 50.1% vs 徐欣瑩 49.9%（差距僅 0.2%，勝率 51.3% vs 48.7%；開啟 2022 回溯加權則為徐欣瑩 53.3% vs 鄭朝方 46.7%）。11月15日《精確調查》網路大樣本（N=3,722，權重 24.5%）徐欣瑩以 43.3% 領先鄭朝方 36.0%，與 11/12《年代》鄭 36.9% vs 徐 28.6% 形成完全平盤對決！',
        detailedBrief: '新竹縣在封關前迎來 3,722 份大樣本網路民調衝擊！繼 11 月 12 日同日兩份市話調查（《年代民調》鄭朝方 36.9% vs 徐欣瑩 28.6%，中立鄭 30.8% vs 徐 16.6%；《關鍵調查》徐欣瑩 44.4% vs 鄭朝方 37.5%）對峙後，11 月 15 日李承志主持、委託《精確調查》執行之新竹縣大樣本網路問卷（11/5-13 執行，N=3,722，誤差 ±1.61%，權重 24.5%）顯示徐欣瑩以 43.3% 領先鄭朝方 36.0%（朱定瑀 4.6%，未決定 16.2%，竹北市徐 42.9% vs 鄭 36.9%）。ClearPoll 模型依同機構重複波次衰減與網路加權（0.80x）平衡納入 11/15 精確網路（24.5%）、11/12 年代（22.8%）與 11/12 關鍵調查（17.3%）後，標準模型由 51.2% 收斂至 **鄭朝方 50.1% vs 徐欣瑩 49.9%**（差距僅 0.2%），而若開啟「2022 實際得票回溯加權」則為 **徐欣瑩 53.3% vs 鄭朝方 46.7%**，竹北科技家庭與傳統客家鄉鎮投票率將一翻兩瞪眼！',
        factors: [
          '11/15 精確調查網路大樣本（N=3,722，權重 24.5%）：徐欣瑩 43.3% 領先鄭朝方 36.0%（朱定瑀 4.6%），與年代(鄭+8.3%)相互抵消',
          '竹北決戰板塊：年代測得竹北鄭 42.4% 勝徐 22.5%，精確網路則測得竹北徐 42.9% 勝鄭 36.9%，突顯受訪族群通路極化',
          '全國最膠著 50.1% : 49.9%：標準模型差距僅 0.2%，回溯加權藍營徐欣瑩領先至 53.3%，成為投票日最受矚目一級戰區'
        ],
        confidence: '五五波拉鋸 (差距僅0.2%)'
      },
      miaoli: {
        shortBrief: '現任縣長鍾東錦回歸藍營掌握壓倒性優勢，預估得票率約 69.6% vs 30.4%。藍營基層與派系高度整合，陳品安難以突破山海線結構。',
        detailedBrief: '苗栗縣選情呈現現任者全面掌控格局。鍾東錦自重返國民黨並獲提名後，施政滿意度長年位居全台前列，歷次民調均大幅領先民進黨對手陳品安 30 個百分點以上。苗栗山線客家與海線閩南派系全面歸隊，模型評估鍾東錦連任毫無懸念。',
        factors: [
          '核心勝負手：山海線地方農漁會與宗親派系整合度',
          '基本盤結構：苗栗傳統版圖深藍無黨聯盟極度穩固',
          '機構效應：各機構調查一致呈現鍾東錦過半領先'
        ],
        confidence: '絕對優勢 (機會極高)'
      },
      changhua: {
        shortBrief: '中台灣指標戰場，綠營陳素月穩居領先，預估得票率約 50.8% vs 魏平政 30.0% vs 邱建富 19.2%（傳統等比分配為 52.4% : 28.8% : 18.7%）。10月19日聯合報最新民調陳素月 32% 穩居第一、魏平政 16% 居次、邱建富 10%，在野分裂使陳素月勝券在握。',
        detailedBrief: '彰化縣向來為台灣大選『搖擺州』，但本屆呈現綠營一枝獨秀格局。10月19日聯合報系民調中心公布最新電話調查（N=1,003），民進黨立委陳素月以 32% 支持度穩居第一（看好度 36%），大幅領先國民黨魏平政的 16%（看好度 12%）、前彰化市長邱建富的 10%（看好度 9%）及無黨籍陳重嘉 0.3%，未決定高達 42%。針對高達四成二的未表態群體，模型導入「先驗錨定未表態分配（70% 中立選民動能 + 30% 地方結構先驗）」防範等比放大偏誤後，陳素月預估得票率為 50.8% vs 魏平政 30.0% vs 邱建富 19.2%（傳統 100% 等比分配為 52.4% : 28.8% : 18.7%），領先逾 20 個百分點，勝選機會極高。',
        factors: [
          '核心勝負手：42%高比例未決定選民流向與藍營農水會系統能否止跌',
          '基本盤結構：邱建富退黨參選僅拿10%，未能動搖陳素月泛綠基本盤',
          '機構效應：聯合報(+16%綠領先) 與鏡新聞(+14.7%綠領先) 高度一致'
        ],
        confidence: '絕對優勢 (機會極高)'
      },
      nantou: {
        shortBrief: '現任縣長許淑華坐擁超高民意支持，預估得票率約 65.5% vs 34.5%。南投基本盤藍大於綠，温世政知名度受限難撼動許淑華親民光環。',
        detailedBrief: '南投縣由現任縣長許淑華展現穩健連任姿態。許淑華以高親和力與觀光、農業政策獲得縣民極高信任度，TVBS民調支持度高達 54.2%，領先民進黨參選人温世政達 25.7 個百分點。南投傳統政治版圖結構性藍大於綠，模型評估許淑華勝選機會極高。',
        factors: [
          '核心勝負手：烏溪線與濁水溪線觀光休閒產業選民',
          '基本盤結構：南投傳統政治版圖穩健偏藍',
          '機構效應：歷次調查許淑華均保持20%以上絕對優勢'
        ],
        confidence: '絕對優勢 (機會極高)'
      },
      yunlin: {
        shortBrief: '藍營張嘉郡維持穩定優勢，預估得票率約 53.0% vs 47.0%（勝率 89.5% vs 10.5%）。張麗善執政八年滿意度堅挺，張家農會水利系統扎實，劉建國苦戰山海線整合。',
        detailedBrief: '雲林縣長選戰由張麗善交棒姪女、立委張嘉郡。張家在雲林深耕數十年，農會、漁會與基層水利組織實力雄厚；民進黨再度推派山線立委劉建國挑戰，但綠營海線整合仍有待強化。TVBS民調張嘉郡以 46.5% 領先劉建國 39.2%，模型評估張嘉郡具備穩定接棒優勢。',
        factors: [
          '核心勝負手：海線台西麥寮六輕周邊與農漁民投票傾向',
          '基本盤結構：地方派系勢力大於政黨色彩，張家基層實力穩固',
          '機構效應：TVBS(+7.3%藍) vs 山水民調(+4.3%藍)'
        ],
        confidence: '機會略高 (藍營穩健)'
      },
      chiayicity: {
        shortBrief: '綠營王美惠支持度領跑，預估得票率約 54.1% vs 張啓楷 45.9%（差距 8.2%，勝率 96.2%）。ETtoday 最新民調王美惠 45.2% 領先張啓楷 39.5%，王美惠憑親民形象鞏固民主聖地優勢。',
        detailedBrief: '嘉義市被譽為『民主聖地』，政治板塊素有看人不看黨的傳統。五星級市長黃敏惠任期屆滿，民進黨立委王美惠憑藉全台最高得票率立委之親民形象強勢出戰。9月18日 ETtoday 最新民調王美惠以 45.2% 領先民眾黨立委張啓楷 39.5%，模型評估王美惠掌握穩定領先格局。',
        factors: [
          '核心勝負手：黃敏惠系統支持者與公教選民最終流向',
          '基本盤結構：選人不選黨，重視民意代表基層服務溫度',
          '機構效應：歷次民調王美惠均穩定居首'
        ],
        confidence: '優勢領先 (機會高)'
      },
      chiayicounty: {
        shortBrief: '綠營蔡易餘掌握壓倒性優勢，預估得票率約 67.9% vs 32.1%。現任縣長翁章梁高滿意度全面力挺，吳品叡跨區挑戰難撼農工大縣堡壘。',
        detailedBrief: '嘉義縣為民進黨長年執政的核心大本營。五星縣長翁章梁高滿意度交棒，由海線重量級立委蔡易餘出馬角逐，獲得山海線綠營民代與農田水利系統一致支持。無黨籍朴子市長吳品叡雖獲泛藍暗助跨區挑戰，但基層組織難以全面抗衡，模型評估蔡易餘勝選機會極高。',
        factors: [
          '核心勝負手：台積電進駐嘉科之產業紅利認同度',
          '基本盤結構：全台綠營基本盤最穩固縣市之一 (約 65:35)',
          '機構效應：匯流與鏡新聞均顯示蔡易餘破五成穩定領先'
        ],
        confidence: '絕對優勢 (機會極高)'
      },
      pingtung: {
        shortBrief: '現任縣長周春米穩健領先，預估得票率約 56.4% vs 43.6%（勝率 99.7%）。延續潘孟安執政基石且施政獲肯定，蘇清泉再戰仍面臨深綠板塊考驗。',
        detailedBrief: '屏東縣長選情由現任縣長周春米掌握主動。周春米上任後全力推動高鐵延伸屏東與屏科園區建設，施政滿意度逐步突破六成五。國民黨立委蘇清泉二度挑戰，在原住民鄉與客家鄉鎮具備動員能量，但在屏北與屏南龐大綠營基本盤下，TVBS民調周春米保持 48.2% vs 37.5% 的安全領先。',
        factors: [
          '核心勝負手：屏東客家六堆與原鄉票源之在野開票率',
          '基本盤結構：屏東綠營執政長達28年，基本盤偏綠',
          '機構效應：TVBS(+10.7%綠) vs 山水(+13.3%綠)'
        ],
        confidence: '穩固領先 (機會極高)'
      },
      yilan: {
        shortBrief: '封關民調急速收斂至誤差邊緣！模型預估綠營林國漳 52.2% vs 藍白吳宗憲 47.8%（差距 4.4%，勝率 83.5% vs 16.5%；開啟 2022 回溯加權更拉近至 50.7% vs 49.3%）。11月17日《台灣研究學會／趨勢民調》封關調查獲 35.0% 上限權重，林國漳 38.7% 僅領先吳宗憲 37.7% 1 個百分點！',
        detailedBrief: '宜蘭縣長選戰在封關最後時刻急劇緊繃！11 月 17 日《台灣研究學會》公布由趨勢民調執行的封關前市話調查（11/11-13 執行，N=1,068，誤差 ±3.0%，權重 35.0%），民進黨林國漳獲 38.7% 支持度、獲藍白整合推薦的國民黨吳宗憲達 37.7%，雙方差距縮至僅 1.0 個百分點（報導約 8% 尚未表態）。交叉結構顯示受訪者泛綠認同 38.0% 略高於藍白 33.5%，但藍白整合凝聚力極高——國民黨支持者 91.9%、民眾黨支持者 82.9% 表態挺吳，民進黨支持者 87.2% 挺林。ClearPoll 綜合最新封關趨勢民調（單筆推估林 50.7% vs 吳 49.3%）與前期 9 月菱傳媒、8 月山水調查後，標準模型推估林國漳 52.2% 微幅領先吳宗憲 47.8%（若開啟 2022 回溯加權則進一步收斂至 50.7% vs 49.3% 五五波），勝負端視藍白草根動員與中間選民投票率！',
        factors: [
          '11/17 台灣研究學會／趨勢封關民調（權重 35.0%）：林國漳 38.7% vs 吳宗憲 37.7% 僅差 1.0%，進入誤差範圍肉搏戰',
          '藍白合歸隊率亮眼：國民黨 91.9% 與民眾黨 82.9% 支持者挺吳宗憲（僅 5.8% 轉投林），展現整合效果',
          '基本盤微幅偏綠：受訪者泛綠認同 38.0% vs 藍白 33.5%，標準模型林 52.2% 領先（2022 回溯加權縮至 50.7% : 49.3%）'
        ],
        confidence: '微幅領先 (五五波邊緣)'
      },
      hualien: {
        shortBrief: '國民黨游淑貞在泛藍三腳督中維持優勢，模型預估游淑貞 42.3% vs 張峻 29.9% vs 魏嘉賢 27.9%（開啟 2022 回溯加權為游 55.5%）。11月15日《風傳媒》游 30.5% 領先（張峻 19.1% 居次），惟 11月13日《窩窩科技AI電訪》測出游 25.3%、魏 25.1%、張 25.0% 三強平盤拉鋸！',
        detailedBrief: '花蓮縣長選情呈現傳統市話與雙底冊 AI 電訪顯著分歧！11 月 15 日《風傳媒》封關純市話民調（11/12-14 執行，N=1,068，權重 35.0%）顯示國民黨游淑貞以 30.5% 穩居第一，無黨籍張峻 19.1% 首度超車魏嘉賢 13.6%（一定會投票族群游更擴大至 38.5% vs 張 25.3% vs 魏 14.6%）。然而稍早 11 月 13 日臺北國際商會委託《窩窩科技》執行的市話＋手機雙底冊 AI 電訪（11/11-12 執行，N=1,077，權重 35.0%）則測得游淑貞 25.3%、魏嘉賢 25.1%、張峻 25.0% 三強毫釐平手（一對一模擬魏 40.1% 勝游 26.3%，游 36.1% 勝張 35.2%），反映手機族與泛綠/反傅選票存在棄保潛能。ClearPoll 綜合加權兩份封關前雙強調查並結合花蓮深藍基本盤先驗後，標準模型推算游淑貞 42.3% vs 張峻 29.9% vs 魏嘉賢 27.9%（2022 回溯加權為游 55.5%），只要張、魏持續分票，游淑貞接棒勝率仍高達 98.6%！',
        factors: [
          '11/15 風傳媒純市話（權重 35.0%）vs 11/13 窩窩AI雙底冊（35.0%）：風傳媒游 30.5% 遙遙領先（張 19.1%、魏 13.6%），窩窩雙底冊則測出 25.3% : 25.1% : 25.0% 平手',
          '在野雙雄分流效應：民進黨花蓮縣黨部呼籲支持張峻，在野兩強若無明確棄保整合，將持續稀釋非游選票',
          '基本盤結構：花蓮長期泛藍底盤深厚，標準模型游 42.3% 領先（2022 回溯加權 55.5%），穩佔上風'
        ],
        confidence: '相對領先 (機會極高)'
      },
      taitung: {
        shortBrief: '藍營吳秀華維持穩定領先，惟 11/11 大地民調顯示陳瑩急起直追！模型預估吳秀華 58.8% vs 陳瑩 41.2%（差距 17.6%，勝率 >99.9%；開啟 2022 回溯加權為吳 59.4% vs 陳 40.6%）。11月11日陳瑩競總委託《大地民調》調查吳秀華 35.7% vs 陳瑩 31.1%（差 4.6%，一定會投票族群吳 39.9% vs 陳 37.3% 僅差 2.6%），與 11月7日《ETtoday》（吳 43.6% vs 陳 29.3%）共同納入平衡！',
        detailedBrief: '台東縣長選情在封關前夕出現藍綠民調交鋒。繼 11 月 7 日《ETtoday民調雲》封閉式網路問卷調查（N=1,071，誤差 ±2.99%）顯示國民黨縣議會議長吳秀華以 43.6% 領先民進黨立委陳瑩 29.3%（差 14.3%，看好度 42.7% vs 25.7%）後，11 月 11 日陳瑩競選總部公布委託《大地民意研究》執行之最新市話調查（11/6-8 執行，N=1,067，誤差 ±3.00%），吳秀華以 35.7% 領先陳瑩 31.1%（差距拉近至 4.6%，未表態 33.2%），而在占 64.0% 表態「一定會投票」選民中，吳秀華 39.9% 與陳瑩 37.3% 差距更縮小至 2.6 個百分點。ClearPoll 模型同時納入 11/11 大地民調（含陣營委託公信力折減與機構效應校正，權重 35.0%）、11/7 ETtoday（權重 35.0%）、鏡新聞與 TVBS 歷次調查並結合台東偏藍結構先驗後，推算吳秀華得票率為 58.8% vs 陳瑩 41.2%（開啟 2022 回溯加權為 59.4% vs 40.6%），吳秀華仍穩居領先優勢。',
        factors: [
          '11/11 大地民調 vs 11/7 ETtoday：大地市話吳秀華35.7%勝陳瑩31.1%（一定投票差2.6%），ETtoday吳43.6%勝陳29.3%（差14.3%）',
          '基本盤結構：台東結構藍大於綠，饒慶鈴縣府施政紅利與議會農會系統全面整合',
          '投票意願動能：綠營支持者一定投票意願轉強拉近差距，惟全縣基本盤吳秀華仍保持雙位數優勢'
        ],
        confidence: '絕對優勢 (機會極高)'
      },
      penghu: {
        shortBrief: '國民黨陳振中穩定領先，吳淑瑾於封關民調超車葉竹林站上第二！模型預估陳振中 42.5% vs 吳淑瑾 30.7% vs 葉竹林 26.8%（勝率 99.9%；開啟 2022 回溯加權為陳 41.6% vs 吳 33.6% vs 葉 24.8%）。11月16日《北市大》封關調查陳振中 28.89% 領先吳淑瑾 21.64% 與葉竹林 16.53%！',
        detailedBrief: '澎湖縣選情在封關前呈現「藍營穩定居首、綠營止跌超車第三名」態勢。11 月 16 日國民黨澎湖縣黨部公布委託《臺北市立大學》執行之 MISS-CATI 市話封關民調（11/2-9 執行，N=1,071，誤差 ±2.99%，權重 35.0%），國民黨陳振中獲 28.89% 保持第一，民進黨吳淑瑾回升至 21.64% 超越無黨籍葉竹林 16.53%（許智富 2.92%、陳盡川 2.18%、周倪安 1.60%，未表態合計 26.24%）。雖然該份民調公布後遭吳、葉陣營質疑未載明完整細節，但結合前期匯流與關鍵調查後，ClearPoll 推算陳振中得票率為 42.5% vs 吳淑瑾 30.7% vs 葉竹林 26.8%（回溯加權 41.6% vs 33.6% vs 24.8%），陳振中翻轉勝券在握。',
        factors: [
          '11/16 北市大封關民調（權重 35.0%）：陳振中 28.89% 領先吳淑瑾 21.64% 與葉竹林 16.53%，在馬公/白沙/西嶼/七美佔優勢',
          '老二位置換人：吳淑瑾回穩站上 21.64%（湖西、望安領先）反超葉竹林，惟仍有 26.24% 未決定與 53.44% 看人不看黨選民',
          '外島三腳督結構：在綠營基本盤與無黨平民路線相互分流下，藍營陳振中維持雙位數安全領先'
        ],
        confidence: '相對領先 (機會極高)'
      },
      kinmen: {
        shortBrief: '藍營陳玉珍掌握壓倒性絕對優勢，模型預估得票率 65.2% vs 李文良 34.8%（開啟 2022 回溯加權為 63.9% vs 36.1%，勝率 >99.9%）。11月14日《世新大學民調中心》最新調查陳玉珍支持度 45.1% 遠勝李文良 14.8% 與張國威 6.7%，當選看好度更高達 67.0%！',
        detailedBrief: '金門縣長選戰由國民黨立委陳玉珍展現壓倒性優勢。11 月 14 日台北金門同鄉會榮譽理事長許奮鬥公布委託《世新大學民調中心》執行之最新市話調查（11/2-5 執行，N=1,070，誤差 ±3.0%），陳玉珍以 45.1% 大幅領先無黨籍李文良 14.8% 與張國威 6.7%（其餘候選人皆低於 2%），在「一定會投票」積極選民中更達 49.0% vs 17.2%，當選看好度更攀升至 67.0%（李文良 4.5%、張國威 4.6%）。綜合前期 TVBS 與艾普羅調查，模型推算陳玉珍得票率約 65.2% vs 李文良 34.8%（回溯加權 63.9% vs 36.1%），連同深藍結構勝算毫無懸念。',
        factors: [
          '11/14 世新大學最新民調：陳玉珍 45.1%（一定會投 49.0%）大幅領先李文良 14.8%，看好度達 67.0%',
          '小三通全面復航與兩岸觀光民生政策紅利持續發酵，外島基層黏著度極高',
          '深藍結構與多方分散效應：李文良與張國威等挑戰者分流在野選票，難以撼動陳玉珍基本盤'
        ],
        confidence: '絕對優勢 (機會極高)'
      },
      lienchiang: {
        shortBrief: '現任縣長王忠銘掌握絕對領先，預估得票率約 65.5% vs 曹爾元 34.5%。馬祖四鄉五島藍營政通人和，李問未登記，雙雄對決王忠銘勝算極高。',
        detailedBrief: '連江縣（馬祖）選情由現任縣長王忠銘展現穩定優勢。王忠銘推動馬祖新航運與機場升級工程獲地方好評，關鍵調查民調達 58.5%。前地政局長曹爾元在南竿有部分宗親票源挑戰，但民進黨李問未登記參選，選局回歸藍營內部對決，模型評估王忠銘連任勝選機會極高。',
        factors: [
          '核心勝負手：南竿、北竿跨海大橋與海空交通運量',
          '基本盤結構：馬祖宗親文化深厚，政治版圖深藍',
          '機構效應：各機構調查王忠銘均領先 20% 以上'
        ],
        confidence: '絕對優勢 (機會極高)'
      }
    };

    const baseAssessment = assessments[cityKey] ? { ...assessments[cityKey] } : {
      shortBrief: '選情持續動態觀測中，模型即時加權推算各方陣營得票率與勝選機率。',
      detailedBrief: '本選區正在即時收錄最新科學民調數據，模型套用多層次加權、抗偏誤校正與蒙地卡羅隨機擾動模擬，即時輸出最精準之選情洞察。',
      factors: ['時效動態加權', '抽樣品質校正', '多機構綜合評析'],
      confidence: '中立監測中'
    };

    // Dynamic Live Interpolation for Scenario Simulator & Real-Time Updates
    if (context && context.predictedVoteShares && context.candidates && context.candidates.length >= 2) {
      const sortedCands = [...context.candidates]
        .map(cand => ({
          ...cand,
          share: context.predictedVoteShares[cand.id] || 0,
          prob: context.winProbabilities ? (context.winProbabilities[cand.id] || 0) : 0
        }))
        .sort((a, b) => b.share - a.share);

      const leader = sortedCands[0];
      const runner = sortedCands[1];
      const margin = Math.round((leader.share - runner.share) * 10) / 10;
      const rating = this.getOpportunityRating(margin, leader.prob);

      baseAssessment.liveSummary = `${leader.name} ${leader.share.toFixed(1)}% vs ${runner.name} ${runner.share.toFixed(1)}%（差距 ${margin.toFixed(1)}%，勝率 ${(leader.prob * 100).toFixed(1)}%）`;
      baseAssessment.dynamicRating = rating.text;
    }

    return baseAssessment;
  },

  /**
   * Calculate dynamic partisan demographics (CDPSM Model) from historical election dataset.
   * @param {Object} historicalData - Data from historical-demographics.json
   * @returns {Object} Computed demographics breakdown for national and all cities
   */
  calculateDemographics(historicalData) {
    if (!historicalData || !historicalData.elections) return null;

    const cities = [
      'taipei', 'newtaipei', 'taoyuan', 'taichung', 'tainan', 'kaohsiung',
      'keelung', 'hsinchucity', 'hsinchucounty', 'miaoli', 'changhua', 'nantou',
      'yunlin', 'chiayicity', 'chiayicounty', 'pingtung', 'yilan', 'hualien',
      'taitung', 'penghu', 'kinmen', 'lienchiang'
    ];
    const entities = ['national', ...cities];
    const resultsByEntity = {};

    for (const ent of entities) {
      let greenWeighted = 0;
      let blueWeighted = 0;
      let whiteWeighted = 0;
      let totalW = 0;
      let partyList2024White = 18.0;

      for (const elec of historicalData.elections) {
        // 2026 Local Executive Structural Calibration:
        // Boost local mayoral elections (0.48) and dampen 2024 3-way presidential peak anomaly (0.25)
        let wType = elec.weightType || 0.3;
        if (elec.type === 'mayoral') {
          wType = 0.48;
        } else if (elec.id === '2024-presidential') {
          wType = 0.25;
        } else if (elec.type === 'partyList') {
          wType = 0.32;
        }
        const w = wType * (elec.weightTime || 0.5);
        const res = elec.results ? elec.results[ent] : null;
        if (res) {
          let g = res.green || 0;
          let b = res.blue || 0;
          let wh = res.white || 0;
          const oth = res.other || 0;

          if (elec.id === '2024-partylist' && res.white != null) {
            partyList2024White = res.white;
          }

          // Post-2024 TPP Deflation & Single-Member Executive Re-anchoring:
          // 35% of the Jan 2024 white peak reverts to local blue/green structure in mayoral races,
          // while minor parties (other) contribute to the non-major swing/third-party pool.
          if (elec.year === 2024) {
            const revert = wh * 0.35;
            const gbSum = g + b;
            const gRatio = gbSum > 0 ? g / gbSum : 0.5;
            g += revert * gRatio;
            b += revert * (1 - gRatio);
            wh = wh * 0.65 + oth * 0.35;
          } else {
            wh = wh + oth * 0.25;
          }

          greenWeighted += g * w;
          blueWeighted += b * w;
          whiteWeighted += wh * w;
          totalW += w;
        }
      }

      if (totalW > 0) {
        const g = greenWeighted / totalW;
        const b = blueWeighted / totalW;
        const w = whiteWeighted / totalW;
        const sum = g + b + w;

        const greenPct = Math.round((g / sum) * 10000) / 100;
        const bluePct = Math.round((b / sum) * 10000) / 100;
        const whitePct = Math.round((w / sum) * 10000) / 100;

        // Decompose non-blue/non-green pool into estimated 2026 TPP core vs. independent/swing voters
        const rawTppCore = partyList2024White * (ent === 'hsinchucity' ? 0.42 : 0.30);
        const tppCore = Math.round(Math.min(whitePct * 0.72, rawTppCore) * 10) / 10;
        const swingIndependent = Math.round(Math.max(0, whitePct - tppCore) * 10) / 10;

        resultsByEntity[ent] = {
          green: greenPct,
          blue: bluePct,
          white: whitePct,
          tppCore,
          swingIndependent,
        };
      }
    }

    const national = resultsByEntity.national || { green: 44.70, blue: 42.45, white: 12.85, tppCore: 6.6, swingIndependent: 6.3 };

    const computedCities = cities.map(cityId => {
      const entData = resultsByEntity[cityId] || national;
      const greenIdx = Math.round(entData.green - national.green);
      const blueIdx = Math.round(entData.blue - national.blue);
      const whiteIdx = Math.round(entData.white - national.white);

      // Head to Head proportional reallocation
      const h2hGreen = (entData.green + entData.blue > 0)
        ? Math.round((entData.green / (entData.green + entData.blue)) * 10000) / 100
        : 50.0;
      const h2hBlue = Math.round((100 - h2hGreen) * 100) / 100;

      return {
        id: cityId,
        index: { green: greenIdx, blue: blueIdx, white: whiteIdx },
        structure: {
          green: entData.green,
          blue: entData.blue,
          white: entData.white,
          tppCore: entData.tppCore,
          swingIndependent: entData.swingIndependent
        },
        headToHead: { green: h2hGreen, blue: h2hBlue }
      };
    });

    const natH2hGreen = (national.green + national.blue > 0)
      ? Math.round((national.green / (national.green + national.blue)) * 10000) / 100
      : 50.0;
    const natH2hBlue = Math.round((100 - natH2hGreen) * 100) / 100;

    return {
      national: {
        structure: national,
        headToHead: { green: natH2hGreen, blue: natH2hBlue }
      },
      cities: computedCities
    };
  },

  /**
   * Get Bayesian election fundamentals for a specific city/county.
   * @param {string} cityId
   * @param {Object} historicalData
   * @returns {Object|null}
   */
  getBayesianFundamentals(cityId, historicalData) {
    if (!historicalData || !cityId) return null;
    const demoResult = this.calculateDemographics(historicalData);
    if (!demoResult) return null;
    const cityData = demoResult.cities.find(c => c.id === cityId);
    if (!cityData) return null;

    return {
      cityId,
      green: cityData.structure.green,
      blue: cityData.structure.blue,
      white: cityData.structure.white,
      headToHead: cityData.headToHead,
      index: cityData.index,
      national: demoResult.national
    };
  },

  /**
   * Calculate Partisan Shift & Swing Index (民意板塊位移指數).
   * Compares 2022 actual CEC election results with 2026 ClearPoll predicted shares.
   * @param {Object} predictedVoteShares
   * @param {string} cityId
   * @param {Object} pastResults
   * @param {Array} candidates
   * @returns {Object|null}
   */
  calculatePartisanShift(predictedVoteShares, cityId, pastResults, candidates = []) {
    if (!predictedVoteShares || !cityId || !pastResults || !pastResults.results) return null;

    const past2022 = pastResults.results.find(r => r.electionId === `2022-${cityId}-mayor`);
    if (!past2022) return null;

    let pastGreen = 0;
    let pastBlue = 0;
    let pastOther = 0;
    let pastWinner = null;

    for (const c of past2022.candidates) {
      const party = (c.party || '').toUpperCase();
      if (party === 'DPP') pastGreen += c.voteShare;
      else if (party === 'KMT') pastBlue += c.voteShare;
      else pastOther += c.voteShare;

      if (c.elected) pastWinner = c;
    }

    let predGreen = 0;
    let predBlue = 0;
    let predOther = 0;

    for (const c of candidates) {
      const share = predictedVoteShares[c.id] || 0;
      const party = (c.party || '').toUpperCase();
      if (party === 'DPP') predGreen += share;
      else if (party === 'KMT') predBlue += share;
      else predOther += share;
    }
    if (predictedVoteShares.others) {
      predOther += predictedVoteShares.others;
    }

    const greenDelta = Math.round((predGreen - pastGreen) * 10) / 10;
    const blueDelta = Math.round((predBlue - pastBlue) * 10) / 10;
    const otherDelta = Math.round((predOther - pastOther) * 10) / 10;

    // Net swing: (predBlue - predGreen) - (pastBlue - pastGreen)
    const netBlueSwing = Math.round(((predBlue - predGreen) - (pastBlue - pastGreen)) * 10) / 10;

    let direction = 'stable';
    let summary = '';
    if (Math.abs(netBlueSwing) < 2.0) {
      direction = 'stable';
      summary = `板塊結構大致持平（藍綠消長幅度小於 2%），選情呈現高度拉鋸狀態。`;
    } else if (netBlueSwing > 0) {
      direction = 'blue';
      summary = `民意板塊較 2022 年向泛藍傾斜 +${netBlueSwing}%（藍營消長 ${blueDelta >= 0 ? '+' : ''}${blueDelta}%，綠營消長 ${greenDelta >= 0 ? '+' : ''}${greenDelta}%）。`;
    } else {
      direction = 'green';
      summary = `民意板塊較 2022 年向泛綠回升 +${Math.abs(netBlueSwing)}%（綠營消長 ${greenDelta >= 0 ? '+' : ''}${greenDelta}%，藍營消長 ${blueDelta >= 0 ? '+' : ''}${blueDelta}%）。`;
    }

    return {
      cityId,
      past2022: {
        date: past2022.date,
        turnoutRate: past2022.turnoutRate,
        totalVotes: past2022.totalVotes,
        greenShare: Math.round(pastGreen * 10) / 10,
        blueShare: Math.round(pastBlue * 10) / 10,
        otherShare: Math.round(pastOther * 10) / 10,
        winner: pastWinner ? `${pastWinner.name} (${pastWinner.party})` : '未知'
      },
      predicted2026: {
        greenShare: Math.round(predGreen * 10) / 10,
        blueShare: Math.round(predBlue * 10) / 10,
        otherShare: Math.round(predOther * 10) / 10
      },
      shift: {
        greenDelta,
        blueDelta,
        otherDelta,
        netBlueSwing,
        direction,
        summary
      }
    };
  },
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ClearPollModel;
}
