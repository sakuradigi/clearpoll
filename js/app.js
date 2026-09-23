/* ============================================
   ClearPoll 透析民調 — Main Application
   ============================================ */

(function () {
  'use strict';

  // ==== Google Sheets Integration Config ====
  // To sync with Google Sheets (方案 A), replace this with your public Spreadsheet ID:
  // (Format: '1aBcDeFgHiJkLmNoPqRsTuVwXyZ')
  const GOOGLE_SPREADSHEET_ID = '';

  // ---- State ----
  let selectedCity = 'taipei';
  let selectedYear = '2026';
  let currentElectionId = '2026-taipei-mayor';
  let activeTab = 'dashboard'; // 'dashboard' | 'detail' | 'methodology'
  let historicalRangeMode = 'all'; // 'all' (2016-2024) | 'recent' (2+2+2: 2020-2024)
  let historicalViewLayout = 'grid'; // 'grid' (2+2+2) | 'table' (full-width stacked tables)
  
  let electionsMetadata = null;
  let analysisResult = null;
  let pollData = null;
  let pollsterData = null;
  let pastResultsData = null;
  
  let tableSortColumn = 'date';
  let tableSortAsc = false;
  let currentFontScale = 1.0;
  try {
    currentFontScale = parseFloat(localStorage.getItem('clearPollFontScale')) || 1.0;
  } catch (e) {
    console.warn('[ClearPoll] localStorage is blocked or not available:', e);
  }

  // ---- DOM References ----
  const $ = (id) => document.getElementById(id);

  const DOM = {
    loadingState: $('loadingState'),
    appContent: $('appContent'),
    constructionState: $('constructionState'),
    heroElectionName: $('heroElectionName'),
    heroUpdateTime: $('heroUpdateTime'),
    heroSummaryText: $('heroSummaryText'),
    predictionTableContainer: $('predictionTableContainer'),
    pollDataBody: $('pollDataBody'),
    pollCountLabel: $('pollCountLabel'),
    predictionLogBody: $('predictionLogBody'),
    citySelector: $('citySelector'),
    otherCitiesSelect: $('otherCitiesSelect'),
    yearSelector: $('yearSelector'),
    dashboardSection: $('dashboardSection'),
    dashboardGrid: $('dashboardGrid'),
    nationalOverviewSection: $('nationalOverviewSection'),
    taiwanMapContainer: $('taiwanMapContainer'),
    partyStatsContainer: $('partyStatsContainer'),
    historicalTableContainer: $('historicalTableContainer'),
    sixMetrosSection: $('sixMetrosSection'),
    sixMetrosGrid: $('sixMetrosGrid'),
    otherCountiesSection: $('otherCountiesSection'),
    otherCountiesGrid: $('otherCountiesGrid'),
    regionFilterBar: $('regionFilterBar'),
    methodologyViewSection: $('methodologyViewSection'),
    historicalGrid: $('historicalGrid'),
  };

  // ---- Data Loading ----

  /**
   * Load JSON from data/ directory with automatic cache-busting.
   */
  async function loadJSON(path) {
    try {
      const sep = path.includes('?') ? '&' : '?';
      const cacheBustPath = `${path}${sep}_t=${Date.now()}`;
      const resp = await fetch(cacheBustPath, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${path}`);
      return await resp.json();
    } catch (err) {
      console.error(`[ClearPoll] Failed to load ${path}:`, err);
      return null;
    }
  }

  /**
   * Fetch CSV content from a public Google Sheet.
   */
  async function fetchCSVFromGoogleSheets(spreadsheetId, sheetName) {
    try {
      const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${sheetName}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} on sheet: ${sheetName}`);
      return await resp.text();
    } catch (err) {
      console.warn(`[ClearPoll] Failed to fetch Google Sheet CSV for ${sheetName}:`, err);
      return null;
    }
  }

  /**
   * Standard RFC 4180 compliant CSV Parser.
   */
  function parseCSV(text) {
    const lines = [];
    let row = [""];
    let insideQuote = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const next = text[i + 1];
      if (char === '"') {
        if (insideQuote && next === '"') {
          row[row.length - 1] += '"';
          i++;
        } else {
          insideQuote = !insideQuote;
        }
      } else if (char === ',' && !insideQuote) {
        row.push('');
      } else if ((char === '\n' || char === '\r') && !insideQuote) {
        if (char === '\r' && next === '\n') i++;
        lines.push(row);
        row = [''];
      } else {
        row[row.length - 1] += char;
      }
    }
    if (row.length > 1 || row[0] !== '') {
      lines.push(row);
    }
    return lines;
  }

  /**
   * Map parsed CSV rows to poll data objects.
   */
  function mapCSVToPolls(csvRows) {
    if (csvRows.length < 2) return [];
    const headers = csvRows[0].map(h => h.trim().toLowerCase());
    
    const parseResultPairs = (str) => {
      if (!str) return null;
      const res = {};
      str.split(',').forEach(pair => {
        const parts = pair.split(':');
        if (parts.length === 2) {
          res[parts[0].trim()] = parseFloat(parts[1].trim());
        }
      });
      return Object.keys(res).length > 0 ? res : null;
    };

    const polls = [];
    for (let i = 1; i < csvRows.length; i++) {
      const row = csvRows[i];
      if (row.length < headers.length) continue;
      
      const poll = {};
      headers.forEach((header, idx) => {
        const val = row[idx]?.trim();
        if (!val) return;

        if (header === 'id') poll.id = val;
        else if (header === 'date') poll.date = val;
        else if (header === 'pollster') poll.pollster = val;
        else if (header === 'pollstername') poll.pollsterName = val;
        else if (header === 'samplesize') poll.sampleSize = parseInt(val, 10) || 0;
        else if (header === 'method') poll.method = val;
        else if (header === 'marginoferror') poll.marginOfError = parseFloat(val) || 0;
        else if (header === 'results') poll.results = parseResultPairs(val);
        else if (header === 'neutralresults') poll.neutralResults = parseResultPairs(val);
        else if (header === 'undecided') poll.undecided = parseFloat(val) || 0;
        else if (header === 'source') poll.source = val;
      });

      if (poll.id && poll.date && poll.results) {
        polls.push(poll);
      }
    }
    return polls;
  }

  /**
   * Load all data for the current election.
   */
  async function loadElectionData(electionId) {
    // Lazy load metadata and pollsters if not loaded
    if (!electionsMetadata || !pollsterData || !pastResultsData) {
      const [electionsData, pollsterD, pastResults] = await Promise.all([
        loadJSON('data/meta/elections.json'),
        loadJSON('data/meta/pollsters.json'),
        loadJSON('data/history/past-results.json')
      ]);

      if (!electionsData || !pollsterD) return null;
      
      electionsMetadata = electionsData.elections;
      pollsterData = pollsterD;
      pastResultsData = pastResults;
    }

    const election = electionsMetadata.find(e => e.id === electionId);
    if (!election) {
      console.error(`[ClearPoll] Election not found in metadata: ${electionId}`);
      return null;
    }

    if (election.status === 'construction' || !election.pollsFile) {
      return { election, polls: null, pollsters: pollsterData, pastResults: pastResultsData };
    }

    // Try fetching from Google Sheet first if enabled
    let polls = null;
    if (GOOGLE_SPREADSHEET_ID) {
      console.log(`[ClearPoll] Attempting Google Sheets fetch for ${electionId}`);
      const csvText = await fetchCSVFromGoogleSheets(GOOGLE_SPREADSHEET_ID, electionId);
      if (csvText) {
        const csvRows = parseCSV(csvText);
        polls = mapCSVToPolls(csvRows);
        console.log(`[ClearPoll] Google Sheets fetch success! Parsed ${polls.length} polls.`);
      }
    }

    // Fallback to local JSON
    if (!polls || polls.length === 0) {
      const pollsData = await loadJSON(election.pollsFile);
      if (pollsData) {
        polls = pollsData.polls || [];
      }
    }

    if (!polls) return null;

    const pollDataMerged = {
      electionId: election.id,
      electionName: election.name,
      electionDate: election.date,
      candidates: election.candidates,
      polls: polls
    };

    return { election, polls: pollDataMerged, pollsters: pollsterData, pastResults: pastResultsData };
  }

  // ---- Rendering ----

  /**
   * Show/hide loading state and handle construction pages.
   */
  function setViewState(state) {
    // state: 'loading' | 'construction' | 'content'
    DOM.loadingState.classList.toggle('hidden', state !== 'loading');
    DOM.constructionState.classList.toggle('hidden', state !== 'construction');
    DOM.appContent.classList.toggle('hidden', state !== 'content');
  }

  /**
   * Calculate weighted neutral support for a candidate.
   */
  function calcWeightedNeutralSupport(weightedPolls, candidateId) {
    let weightedSum = 0;
    let totalWeight = 0;

    for (const poll of weightedPolls) {
      if (poll.neutralResults && poll.neutralResults[candidateId] != null) {
        const support = poll.neutralResults[candidateId];
        const weight = poll.weights.combined;
        weightedSum += support * weight;
        totalWeight += weight;
      }
    }

    if (totalWeight > 0) {
      return Math.round((weightedSum / totalWeight) * 10) / 10;
    }
    return null; // N/A
  }

  /**
   * Render the prediction summary table.
   */
  function renderPredictionSummaryTable(result, pastResults) {
    const { candidates, predictedVoteShares, winProbabilities, weightedPolls } = result;

    // Find actual results if completed
    const actualResult = pastResults?.results?.find(r => r.electionId === result.electionId);

    // Build headers
    let candidateHeaders = candidates.map(c => 
      `<th class="candidate-header-cell" style="background-color: ${c.color};">${c.name} (${c.party})</th>`
    ).join('');

    // Row: 中間選民支持度
    let neutralSupportRow = candidates.map(c => {
      const val = calcWeightedNeutralSupport(weightedPolls, c.id);
      return `<td>${val != null ? val.toFixed(1) + '%' : 'N/A'}</td>`;
    }).join('');

    // Calculate margin between top 2 candidates
    const sortedShares = [...candidates]
      .map(c => ({ id: c.id, share: predictedVoteShares[c.id] || 0 }))
      .sort((a, b) => b.share - a.share);
    const topMargin = sortedShares.length >= 2 ? Math.abs(sortedShares[0].share - sortedShares[1].share) : 99;
    const topCandidateId = sortedShares[0]?.id;

    // Row: 勝選機會
    let winOpportunityRow = candidates.map(c => {
      const prob = winProbabilities[c.id] || 0;
      let rating;
      if (c.id === topCandidateId) {
        rating = ClearPollModel.getOpportunityRating(topMargin, prob);
      } else {
        if (topMargin <= 3.5 || prob >= 0.35) {
          rating = { text: '五五波', level: 'medium' };
        } else if (prob > 0.05) {
          rating = { text: '機會低', level: 'low' };
        } else {
          rating = { text: '機會渺茫', level: 'none' };
        }
      }
      return `<td><span class="win-opportunity-badge ${rating.level}">${rating.text}</span></td>`;
    }).join('');

    // Row: 勝率
    let winProbabilityRow = candidates.map(c => {
      const prob = winProbabilities[c.id] || 0;
      return `<td style="font-weight: 700;">${(prob * 100).toFixed(1)}%</td>`;
    }).join('');

    // Row: 得票率預測
    let voteShareProjectionRow = candidates.map(c => {
      const share = predictedVoteShares[c.id] || 0;
      const ci = result.ci95 ? result.ci95[c.id] : null;
      const ciHtml = ci
        ? `<div class="ci-bounds-text" style="font-size:0.75rem; color: var(--color-text-secondary); font-weight: 500; margin-top: 3px;">
             95% CI: ${ci.lower}% ~ ${ci.upper}%
           </div>`
        : '';
      return `<td class="val-large" style="color: ${c.color}; font-weight: 800;">
        ${share.toFixed(1)}%
        ${ciHtml}
      </td>`;
    }).join('');

    // Row: 實際選舉結果
    let actualResultsRow = '';
    let predictionGapRow = '';

    if (actualResult) {
      actualResultsRow = `
        <tr>
          <td class="row-label">選舉結果 (實際得票率)</td>
          ${candidates.map(c => {
            const candResult = actualResult.candidates.find(ac => ac.id === c.id);
            return `<td style="font-weight: 600;">${candResult ? candResult.voteShare.toFixed(1) + '%' : '-'}</td>`;
          }).join('')}
        </tr>
      `;

      predictionGapRow = `
        <tr>
          <td class="row-label">預測誤差</td>
          ${candidates.map(c => {
            const candResult = actualResult.candidates.find(ac => ac.id === c.id);
            if (!candResult) return '<td>-</td>';
            const proj = predictedVoteShares[c.id] || 0;
            const act = candResult.voteShare;
            const diff = proj - act;
            const colorClass = diff >= 0 ? 'text-dpp' : 'text-danger';
            const sign = diff >= 0 ? '+' : '';
            return `<td class="${colorClass}" style="font-weight: 600;">${sign}${diff.toFixed(1)}%</td>`;
          }).join('')}
        </tr>
      `;
    }

    const tableHtml = `
      <table class="prediction-summary-table">
        <thead>
          <tr>
            <th style="width: 220px; text-align: left; background-color: var(--color-bg-secondary);">預測項目</th>
            ${candidateHeaders}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="row-label">中間選民平均支持度</td>
            ${neutralSupportRow}
          </tr>
          <tr>
            <td class="row-label">勝選機會</td>
            ${winOpportunityRow}
          </tr>
          <tr>
            <td class="row-label">勝率預測</td>
            ${winProbabilityRow}
          </tr>
          <tr>
            <td class="row-label" style="border-bottom: 2px solid var(--color-border);">得票率加權預測</td>
            ${voteShareProjectionRow}
          </tr>
          ${actualResultsRow}
          ${predictionGapRow}
        </tbody>
      </table>
    `;

    // AI Model Detailed Election Assessment
    const aiAssessment = result.aiAssessment || ClearPollModel.getAIElectionAssessment(result.electionId, result.city, result);
    const aiCardHtml = aiAssessment ? `
      <div class="ai-detail-assessment-card">
        <div class="ai-detail-header">
          <div class="ai-detail-badge">
            <span>🤖 ClearPoll AI MODEL 選情深入評估</span>
            <span class="ai-confidence-pill" style="font-size:0.7rem; font-weight:700; padding:2px 8px; border-radius:12px; background:rgba(99,102,241,0.12); color:#4338CA;">
              ${aiAssessment.confidence || '動態加權監測'}
            </span>
          </div>
          <span class="ai-detail-time">資料分析基準：${new Date().toISOString().split('T')[0]}</span>
        </div>
        <p class="ai-detail-text">${aiAssessment.detailedBrief}</p>
        <div class="ai-detail-factors">
          ${(aiAssessment.factors || []).map(f => `<span class="ai-factor-pill">📌 ${f}</span>`).join('')}
        </div>
      </div>
    ` : '';

    DOM.predictionTableContainer.innerHTML = aiCardHtml + tableHtml;
  }

  /**
   * Render the poll data table.
   */
  function renderPollTable(result) {
    const { candidates, weightedPolls } = result;

    const thead = $('pollDataTable').querySelector('thead');
    if (!thead) return;

    // Build candidate headers dynamically
    let candidateHeaders = candidates.map(c => {
      const key = `candidate_${c.id}`;
      const isSorted = tableSortColumn === key;
      const icon = isSorted ? (tableSortAsc ? ' ▲' : ' ▼') : '';
      const sortedClass = isSorted ? 'class="sorted"' : '';
      return `<th data-sort="${key}" ${sortedClass} class="text-right">${c.name} (${c.party})${icon}</th>`;
    }).join('');

    const otherHeaders = [
      { key: 'date', label: '日期' },
      { key: 'pollster', label: '民調機構' },
      { key: 'method', label: '方法' },
      { key: 'sampleSize', label: '樣本數', align: 'text-right' },
    ];

    let startHeaders = otherHeaders.map(h => {
      const isSorted = tableSortColumn === h.key;
      const icon = isSorted ? (tableSortAsc ? ' ▲' : ' ▼') : '';
      const classes = [h.align, isSorted ? 'sorted' : ''].filter(Boolean).join(' ');
      const classAttr = classes ? `class="${classes}"` : '';
      return `<th data-sort="${h.key}" ${classAttr}>${h.label}${icon}</th>`;
    }).join('');

    const endHeaders = [
      { key: 'undecided', label: '未決定', align: 'text-right' },
      { key: 'weight', label: '權重', align: 'text-right' }
    ].map(h => {
      const isSorted = tableSortColumn === h.key;
      const icon = isSorted ? (tableSortAsc ? ' ▲' : ' ▼') : '';
      const classes = [h.align, isSorted ? 'sorted' : ''].filter(Boolean).join(' ');
      const classAttr = classes ? `class="${classes}"` : '';
      return `<th data-sort="${h.key}" ${classAttr}>${h.label}${icon}</th>`;
    }).join('');

    thead.innerHTML = `
      <tr>
        ${startHeaders}
        ${candidateHeaders}
        ${endHeaders}
        <th>來源</th>
      </tr>
    `;

    // Sort polls
    const sorted = sortPolls(weightedPolls, tableSortColumn, tableSortAsc, candidates);

    DOM.pollCountLabel.textContent = `共 ${sorted.length} 筆民調`;

    const methodLabels = {
      'phone+cell': '市話+手機',
      'phone': '電訪',
      'online': '網路',
      'face-to-face': '面訪',
      'ivr': '語音',
    };

    let html = '';
    for (const poll of sorted) {
      const w = poll.weights?.combined ?? 0;
      const weightBar = `<div class="vote-bar-track" style="width:60px;height:4px;display:inline-block;vertical-align:middle;margin-left:4px;">
        <div class="vote-bar-fill" style="width:${(w * 100).toFixed(0)}%;background:var(--gradient-accent);height:100%;border-radius:9999px;"></div>
      </div>`;

      // Candidate support cells
      let candidateCells = candidates.map(c => {
        const val = poll.results[c.id];
        const displayVal = typeof val === 'number' ? val.toFixed(1) + '%' : '-';
        
        let neutralHtml = '';
        if (poll.neutralResults && poll.neutralResults[c.id] != null) {
          const nVal = poll.neutralResults[c.id];
          neutralHtml = `<div class="neutral-sub">中立: ${nVal.toFixed(1)}%</div>`;
        }
        
        return `<td class="number-cell text-right" style="color: ${c.color}; font-weight: 500; vertical-align: middle;">
          <div>${displayVal}</div>
          ${neutralHtml}
        </td>`;
      }).join('');

      html += `
        <tr data-poll-id="${poll.id}" style="cursor: pointer;" title="點擊檢視民調交叉分析與校正細項">
          <td>${poll.date}</td>
          <td class="pollster-cell">${poll.pollsterName || poll.pollster}</td>
          <td><span class="method-badge">${methodLabels[poll.method] || poll.method}</span></td>
          <td class="number-cell text-right">${poll.sampleSize.toLocaleString()}</td>
          ${candidateCells}
          <td class="number-cell text-right">${poll.undecided != null ? poll.undecided.toFixed(1) + '%' : '-'}</td>
          <td class="weight-cell text-right" style="vertical-align: middle; line-height: 1.3;">
            <div style="font-weight: 700;">${(w * 100).toFixed(1)}% ${weightBar}</div>
            <div style="font-size: 0.72rem; color: var(--color-text-tertiary); margin-top: 2px;">
              時效:${Math.round((poll.weights?.recency || 0) * 100)}% | 
              樣本:${Math.round((poll.weights?.sample || 0) * 100)}% | 
              信譽:${Math.round((poll.weights?.credibility || 0) * 100)}%
            </div>
          </td>
          <td>${poll.source ? `<a href="${poll.source}" class="source-link" target="_blank" rel="noopener">🔗 來源</a>` : '-'}</td>
        </tr>
      `;
    }

    DOM.pollDataBody.innerHTML = html;
  }

  /**
   * Sort polls by column.
   */
  function sortPolls(polls, column, ascending, candidates) {
    const sorted = [...polls];
    sorted.sort((a, b) => {
      let va, vb;
      if (column.startsWith('candidate_')) {
        const cid = column.replace('candidate_', '');
        va = a.results[cid] || 0;
        vb = b.results[cid] || 0;
      } else {
        switch (column) {
          case 'date': va = a.date; vb = b.date; break;
          case 'pollster': va = a.pollsterName || a.pollster; vb = b.pollsterName || b.pollster; break;
          case 'method': va = a.method; vb = b.method; break;
          case 'sampleSize': va = a.sampleSize; vb = b.sampleSize; break;
          case 'undecided': va = a.undecided || 0; vb = b.undecided || 0; break;
          case 'weight': va = a.weights?.combined || 0; vb = b.weights?.combined || 0; break;
          default: va = a.date; vb = b.date;
        }
      }
      if (typeof va === 'string') {
        return ascending ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      return ascending ? va - vb : vb - va;
    });
    return sorted;
  }

  /**
   * Render prediction log table.
   */
  function renderPredictionLog(result) {
    const { predictionLog, candidates } = result;

    const thead = $('predictionLogTable').querySelector('thead');
    if (!thead) return;

    let shareHeaders = candidates.map(c => `<th class="text-center">${c.name} 得票率</th>`).join('');
    let probHeaders = candidates.map(c => `<th class="text-center">${c.name} 勝率</th>`).join('');

    thead.innerHTML = `
      <tr>
        <th class="text-center">日期</th>
        <th class="text-center">累計民調數</th>
        ${shareHeaders}
        ${probHeaders}
      </tr>
    `;

    let html = '';
    for (const entry of predictionLog) {
      let shareCells = candidates.map(c => {
        const val = entry.voteShares[c.id];
        return `<td class="number-cell text-center" style="color: ${c.color}; font-weight: 600;">${val != null ? val.toFixed(1) + '%' : '-'}</td>`;
      }).join('');

      let probCells = candidates.map(c => {
        const val = entry.winProbabilities[c.id];
        return `<td class="number-cell text-center" style="font-weight: 600;">${val != null ? (val * 100).toFixed(1) + '%' : '-'}</td>`;
      }).join('');

      html += `
        <tr>
          <td class="text-center">${entry.date}</td>
          <td class="number-cell text-center" style="font-weight: 600;">${entry.pollCount}</td>
          ${shareCells}
          ${probCells}
        </tr>
      `;
    }

    DOM.predictionLogBody.innerHTML = html;
  }

  /**
   * Render all charts.
   */
  function renderCharts(result) {
    const { candidates, weightedPolls, predictionLog, predictedVoteShares } = result;

    try {
      // Poll trend scatter chart
      ClearPollCharts.renderPollTrendChart('pollTrendChart', weightedPolls, candidates);
    } catch (e) {
      console.error('[ClearPoll] Failed to render pollTrendChart (possibly missing date adapter):', e);
    }

    try {
      // Win probability trend chart
      ClearPollCharts.renderWinProbChart('winProbChart', predictionLog, candidates);
    } catch (e) {
      console.error('[ClearPoll] Failed to render winProbChart:', e);
    }

    try {
      // Vote share pie/donut chart
      ClearPollCharts.renderVoteShareBar('voteShareChart', predictedVoteShares, candidates);
    } catch (e) {
      console.error('[ClearPoll] Failed to render voteShareChart:', e);
    }
  }

  // ---- Dashboard Render ----

  function updateCitySelectorUI(city) {
    let matched = false;
    document.querySelectorAll('#citySelector .city-btn').forEach(btn => {
      const isMatch = btn.dataset.city === city;
      btn.classList.toggle('active', isMatch);
      if (isMatch) matched = true;
    });

    if (DOM.otherCitiesSelect) {
      if (!matched) {
        DOM.otherCitiesSelect.value = city;
        DOM.otherCitiesSelect.classList.add('active');
      } else {
        DOM.otherCitiesSelect.value = '';
        DOM.otherCitiesSelect.classList.remove('active');
      }
    }
  }

  async function renderDashboard() {
    if (DOM.sixMetrosGrid) {
      DOM.sixMetrosGrid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px 0;">
          <div class="loading-shimmer" style="width: 180px; height: 24px; margin: 0 auto;"></div>
          <p class="mt-md" style="color: var(--color-text-secondary);">正在彙整與加權計算直轄市選情大盤...</p>
        </div>
      `;
    }
    if (DOM.otherCountiesGrid) {
      DOM.otherCountiesGrid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px 0;">
          <div class="loading-shimmer" style="width: 180px; height: 24px; margin: 0 auto;"></div>
          <p class="mt-md" style="color: var(--color-text-secondary);">正在彙整與加權計算臺灣省及離島選情大盤...</p>
        </div>
      `;
    }

    if (!electionsMetadata || !pollsterData) {
      const [electionsData, pollsterD] = await Promise.all([
        loadJSON('data/meta/elections.json'),
        loadJSON('data/meta/pollsters.json')
      ]);
      if (!electionsData || !pollsterD) {
        if (DOM.sixMetrosGrid) DOM.sixMetrosGrid.innerHTML = `<div class="card text-center" style="grid-column:1/-1;">資料載入失敗</div>`;
        return;
      }
      electionsMetadata = electionsData.elections;
      pollsterData = pollsterD;
    }

    const metroCityOrder = ['taipei', 'newtaipei', 'taoyuan', 'taichung', 'tainan', 'kaohsiung'];
    const otherCityOrder = [
      'keelung', 'hsinchucity', 'hsinchucounty',
      'miaoli', 'changhua', 'nantou', 'yunlin',
      'chiayicity', 'chiayicounty', 'pingtung',
      'yilan', 'hualien', 'taitung', 'penghu', 'kinmen', 'lienchiang'
    ];

    if (selectedYear === '2022' || selectedYear === '2018') {
      if (DOM.nationalOverviewSection) DOM.nationalOverviewSection.style.display = 'none';
      if (DOM.sixMetrosSection) DOM.sixMetrosSection.style.display = 'none';
      if (DOM.otherCountiesSection) DOM.otherCountiesSection.style.display = 'none';
      if (DOM.historicalTableContainer) {
        DOM.historicalTableContainer.style.display = 'block';

        const rowsHtml = metroCityOrder.map(city => {
          const electionId = `${selectedYear}-${city}-mayor`;
          const electionMeta = electionsMetadata.find(e => e.id === electionId || (e.city === city && e.year === selectedYear));
          const cityName = electionMeta ? electionMeta.cityName : city;
          const result = pastResultsData ? pastResultsData.results.find(r => r.electionId === electionId) : null;

          if (!result) {
            return `
              <tr data-city="${city}" data-election-id="${electionId}" style="cursor: pointer;">
                <td style="padding: var(--space-sm) var(--space-md); font-weight: 600;">${cityName}</td>
                <td colspan="7" class="text-center" style="color: var(--color-text-tertiary);">暫無此選區的歷史得票統計數據</td>
              </tr>
            `;
          }

          const sortedCandidates = [...result.candidates].sort((a, b) => b.votes - a.votes);
          const winner = sortedCandidates[0];
          const runnerUp = sortedCandidates[1] || { name: '-', party: '-', voteShare: 0 };
          const lead = winner.voteShare - runnerUp.voteShare;

          const partyColors = { 'DPP': '#1B9431', 'KMT': '#000095', 'TPP': '#28C8C8', 'IND': '#888888', 'OTHER': '#666666' };
          const winnerColor = partyColors[winner.party] || 'var(--color-text-primary)';
          const runnerColor = partyColors[runnerUp.party] || 'var(--color-text-secondary)';

          return `
            <tr data-city="${city}" data-election-id="${electionId}" style="cursor: pointer;" class="hover-row">
              <td style="padding: var(--space-md) var(--space-md); font-weight: 700; color: var(--color-accent-blue); vertical-align: middle;">
                ${cityName}長
              </td>
              <td style="padding: var(--space-md) var(--space-md); vertical-align: middle;">
                <span style="font-weight: 700; color: ${winnerColor};">${winner.name}</span>
                <span class="label" style="font-size: 0.72rem; margin-left: 4px; background: var(--color-bg-tertiary);">${winner.party}</span>
              </td>
              <td style="text-align: right; padding: var(--space-md) var(--space-md); font-weight: 600; vertical-align: middle;">
                ${winner.votes.toLocaleString()} 票
              </td>
              <td style="text-align: right; padding: var(--space-md) var(--space-md); font-weight: 800; color: ${winnerColor}; vertical-align: middle;">
                ${winner.voteShare.toFixed(2)}%
              </td>
              <td style="padding: var(--space-md) var(--space-md); vertical-align: middle;">
                <span style="font-weight: 600; color: ${runnerColor};">${runnerUp.name}</span>
                <span class="label" style="font-size: 0.72rem; margin-left: 4px; background: var(--color-bg-tertiary);">${runnerUp.party}</span>
              </td>
              <td style="text-align: right; padding: var(--space-md) var(--space-md); font-weight: 600; vertical-align: middle;">
                ${runnerUp.voteShare.toFixed(2)}%
              </td>
              <td style="text-align: right; padding: var(--space-md) var(--space-md); font-weight: 700; color: var(--color-danger); vertical-align: middle;">
                +${lead.toFixed(2)}%
              </td>
              <td style="text-align: right; padding: var(--space-md) var(--space-md); color: var(--color-text-secondary); vertical-align: middle;">
                ${result.turnoutRate.toFixed(2)}%
              </td>
            </tr>
          `;
        }).join('');

        DOM.historicalTableContainer.innerHTML = `
          <div class="card" style="padding: var(--space-xl); margin-top: var(--space-md); overflow-x: auto;">
            <h2 style="font-size: 1.4rem; margin-bottom: var(--space-md); font-weight: 800; text-align: center;" class="text-gradient">
              ${selectedYear} 年直轄市長選舉實際開票統計總表
            </h2>
            <p style="text-align: center; color: var(--color-text-secondary); font-size: 0.9rem; margin-bottom: var(--space-lg);">
              以下為中選會公布之法定實際開票結果。點擊任何直轄市行可切換至該市的深度分析與詳細對照表。
            </p>
            <div class="table-container">
              <table class="data-table" style="width: 100%; border-collapse: collapse; min-width: 800px;">
                <thead>
                  <tr>
                    <th style="text-align: left; padding: var(--space-sm) var(--space-md);">直轄市</th>
                    <th style="text-align: left; padding: var(--space-sm) var(--space-md);">當選人 (政黨)</th>
                    <th style="text-align: right; padding: var(--space-sm) var(--space-md);">當選得票數</th>
                    <th style="text-align: right; padding: var(--space-sm) var(--space-md);">當選得票率</th>
                    <th style="text-align: left; padding: var(--space-sm) var(--space-md);">次高票對手 (政黨)</th>
                    <th style="text-align: right; padding: var(--space-sm) var(--space-md);">次高票得票率</th>
                    <th style="text-align: right; padding: var(--space-sm) var(--space-md);">領先幅度</th>
                    <th style="text-align: right; padding: var(--space-sm) var(--space-md);">投票率</th>
                  </tr>
                </thead>
                <tbody>
                  ${rowsHtml}
                </tbody>
              </table>
            </div>
          </div>
        `;

        DOM.historicalTableContainer.querySelectorAll('tr[data-election-id]').forEach(row => {
          row.addEventListener('click', () => {
            const eid = row.dataset.electionId;
            const city = row.dataset.city;
            selectedCity = city;
            currentElectionId = eid;
            updateCitySelectorUI(city);
            switchTab('detail');
          });
        });
      }
      initScrollAnimations();
      return;
    }

    // 2026 Prediction View
    if (DOM.nationalOverviewSection) DOM.nationalOverviewSection.style.display = 'block';
    if (DOM.sixMetrosSection) DOM.sixMetrosSection.style.display = 'block';
    if (DOM.otherCountiesSection) DOM.otherCountiesSection.style.display = 'block';
    if (DOM.historicalTableContainer) DOM.historicalTableContainer.style.display = 'none';

    const year2026Elections = electionsMetadata.filter(e => e.year === '2026');
    const countyResults = {};

    const buildCardHtml = async (election) => {
      try {
        const data = await loadElectionData(election.id);
        if (!data || !data.polls || data.polls.polls.length === 0) {
          throw new Error(`No polls for ${election.id}`);
        }

        if (!historicalDemographicsData) {
          historicalDemographicsData = await loadJSON('data/history/historical-demographics.json');
        }
        const result = ClearPollModel.analyze(data.polls, data.pollsters, {
          historicalDemographics: historicalDemographicsData,
          pastResults: data.pastResults
        });

        const sortedCands = [...election.candidates]
          .map(c => ({
            ...c,
            share: result.predictedVoteShares[c.id] || 0,
            prob: result.winProbabilities ? (result.winProbabilities[c.id] || 0) : 0
          }))
          .sort((a, b) => b.share - a.share);

        const leader = sortedCands[0] || election.candidates[0];
        const runner = sortedCands[1] || null;
        const margin = runner ? Math.abs(leader.share - runner.share) : 99;
        const rating = ClearPollModel.getOpportunityRating(margin, leader.prob);

        countyResults[election.city] = {
          election,
          result,
          leader,
          runner,
          margin,
          rating
        };

        const barsHtml = election.candidates.map(c => {
          const share = result.predictedVoteShares[c.id] || 0;
          const ci = result.ci95 ? result.ci95[c.id] : null;
          const ciTag = ci ? `<span class="ci-badge" style="font-size:0.7rem; font-weight:400; padding:1px 5px;">CI: ${ci.lower}%~${ci.upper}%</span>` : '';
          return `
            <div class="dash-cand-row">
              <div class="dash-cand-info">
                <span style="color: ${c.color}; font-weight: 700;">${c.name} (${c.party}) ${ciTag}</span>
                <span style="color: ${c.color}; font-weight: 800;">${share.toFixed(1)}%</span>
              </div>
              <div class="dash-progress-track">
                <div class="dash-progress-fill" style="width: ${share.toFixed(1)}%; background-color: ${c.color};"></div>
              </div>
            </div>
          `;
        }).join('');

        const oppText = rating.text;
        const badgeClass = rating.level;
        const statusClass = election.status === 'completed' ? 'completed' : 'upcoming';
        const statusText = election.status === 'completed' ? '已落幕' : '預測中';

        const aiAssessment = result.aiAssessment || ClearPollModel.getAIElectionAssessment(election.id, election.city, result);
        const aiBriefHtml = aiAssessment ? `
          <div class="dash-ai-assessment">
            <span class="dash-ai-tag">🤖 AI MODEL 評估簡評</span>
            <p class="dash-ai-text">${aiAssessment.shortBrief}</p>
          </div>
        ` : '';

        return `
          <div class="dashboard-card" data-election-id="${election.id}" data-city="${election.city}" data-region="${election.region || 'north'}">
            <div>
              <div class="dash-card-header">
                <span class="dash-city-name">${election.cityName}</span>
                <span class="dash-status-label ${statusClass}">${statusText}</span>
              </div>
              <div class="dash-card-body">
                ${barsHtml}
                ${aiBriefHtml}
              </div>
            </div>
            <div class="dash-card-footer">
              <div>
                <span class="dash-win-badge" style="color: ${leader.color};">${leader.name}</span>
                <span class="win-opportunity-badge ${badgeClass}" style="margin-left: 6px; padding: 2px 8px; font-size: 0.72rem;">${oppText}</span>
              </div>
              <span class="dash-detail-link">深度分析 →</span>
            </div>
          </div>
        `;
      } catch (err) {
        console.error(`Failed to render card for ${election.id}:`, err);
        return `
          <div class="dashboard-card" style="opacity: 0.85; cursor: default;" data-city="${election.city}" data-region="${election.region || 'north'}">
            <div class="dash-card-header">
              <span class="dash-city-name">${election.cityName}</span>
              <span class="dash-status-label construction">資料收集中</span>
            </div>
            <div class="dash-construction-body">
              <div style="font-size: 2rem; margin-bottom: var(--space-xs);">🚧</div>
              <div style="font-weight: 600;">即將收錄</div>
              <div style="font-size: 0.72rem; color: var(--color-text-tertiary);">敬請期待最新民調</div>
            </div>
          </div>
        `;
      }
    };

    const metroElections = metroCityOrder
      .map(city => year2026Elections.find(e => e.city === city))
      .filter(Boolean);

    const otherElections = otherCityOrder
      .map(city => year2026Elections.find(e => e.city === city))
      .filter(Boolean);

    const [metroCards, otherCards] = await Promise.all([
      Promise.all(metroElections.map(buildCardHtml)),
      Promise.all(otherElections.map(buildCardHtml))
    ]);

    if (DOM.sixMetrosGrid) DOM.sixMetrosGrid.innerHTML = metroCards.join('');
    if (DOM.otherCountiesGrid) DOM.otherCountiesGrid.innerHTML = otherCards.join('');

    const handleCountyFocus = (cityKey, electionId) => {
      const targetCard = document.querySelector(`.dashboard-card[data-city="${cityKey}"]`);
      if (!targetCard) return;

      if (targetCard.closest('#otherCountiesGrid')) {
        const region = targetCard.dataset.region;
        const activeFilterBtn = document.querySelector('#regionFilterBar .region-btn.active');
        if (activeFilterBtn && activeFilterBtn.dataset.region !== 'all' && activeFilterBtn.dataset.region !== region) {
          document.querySelectorAll('#regionFilterBar .region-btn').forEach(b => b.classList.toggle('active', b.dataset.region === 'all'));
          document.querySelectorAll('#otherCountiesGrid .dashboard-card').forEach(c => c.style.display = '');
        }
      }

      targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetCard.classList.add('map-highlight-pulse');
      setTimeout(() => targetCard.classList.remove('map-highlight-pulse'), 1800);
    };

    if (window.ClearPollMap) {
      await ClearPollMap.renderMap('taiwanMapContainer', electionsMetadata, countyResults, handleCountyFocus);
      ClearPollMap.renderPartyStatistics('partyStatsContainer', countyResults);
    }

    document.querySelectorAll('.county-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = chip.textContent.split('(')[0].trim();
        const match = Object.values(countyResults).find(cr => cr.election.cityName.includes(name));
        if (match) {
          handleCountyFocus(match.election.city, match.election.id);
        }
      });
    });

    if (DOM.regionFilterBar) {
      DOM.regionFilterBar.querySelectorAll('.region-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          DOM.regionFilterBar.querySelectorAll('.region-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const reg = btn.dataset.region;
          document.querySelectorAll('#otherCountiesGrid .dashboard-card').forEach(card => {
            if (reg === 'all' || card.dataset.region === reg) {
              card.style.display = '';
            } else {
              card.style.display = 'none';
            }
          });
        });
      });
    }

    document.querySelectorAll('.dashboard-card[data-election-id]').forEach(card => {
      card.addEventListener('click', () => {
        const eid = card.dataset.electionId;
        const city = card.dataset.city;
        selectedCity = city;
        currentElectionId = eid;
        updateCitySelectorUI(city);
        switchTab('detail');
      });
    });

    initScrollAnimations();
  }
  // ---- Scroll Animations ----

  function initScrollAnimations() {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        }
      },
      {
        rootMargin: '0px 0px -60px 0px',
        threshold: 0.1,
      }
    );

    document.querySelectorAll('.fade-in, .slide-up').forEach((el) => {
      observer.observe(el);
    });
  }

  // ---- Header Scroll Effect ----

  function initHeaderScroll() {
    const header = $('siteHeader');
    window.addEventListener('scroll', () => {
      header.classList.toggle('scrolled', window.scrollY > 10);
    }, { passive: true });
  }

  // ---- Table Sorting ----

  function initTableSorting() {
    const table = $('pollDataTable');
    if (!table) return;

    table.addEventListener('click', (e) => {
      const th = e.target.closest('thead th[data-sort]');
      if (!th) return;

      const col = th.dataset.sort;

      // Toggle direction
      if (tableSortColumn === col) {
        tableSortAsc = !tableSortAsc;
      } else {
        tableSortColumn = col;
        tableSortAsc = false;
      }

      // Re-render
      if (analysisResult) {
        renderPollTable(analysisResult);
      }
    });
  }

  // ---- 2D Switcher Navigation ----

  function init2DNavigation() {
    // City buttons
    DOM.citySelector.addEventListener('click', async (e) => {
      const btn = e.target.closest('.city-btn');
      if (!btn) return;

      document.querySelectorAll('#citySelector .city-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (DOM.otherCitiesSelect) {
        DOM.otherCitiesSelect.value = '';
        DOM.otherCitiesSelect.classList.remove('active');
      }
      selectedCity = btn.dataset.city;

      updateElectionId();
      await loadAndRender(currentElectionId);
    });

    // Other 16 cities dropdown
    if (DOM.otherCitiesSelect) {
      DOM.otherCitiesSelect.addEventListener('change', async (e) => {
        const city = e.target.value;
        if (!city) return;
        document.querySelectorAll('#citySelector .city-btn').forEach(b => b.classList.remove('active'));
        DOM.otherCitiesSelect.classList.add('active');
        selectedCity = city;

        updateElectionId();
        await loadAndRender(currentElectionId);
      });
    }

    // Year buttons
    DOM.yearSelector.addEventListener('click', async (e) => {
      const btn = e.target.closest('.year-btn');
      if (!btn) return;

      document.querySelectorAll('#yearSelector .year-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedYear = btn.dataset.year;

      updateElectionId();

      if (activeTab === 'dashboard') {
        renderDashboard();
      } else {
        await loadAndRender(currentElectionId);
      }
    });

    // Handle "Under Construction" demo links
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('.btn-demo-link');
      if (!btn) return;

      const targetCity = btn.dataset.targetCity;
      const targetYear = btn.dataset.targetYear;

      // Set active city button
      document.querySelectorAll('#citySelector .city-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.city === targetCity);
      });
      // Set active year button
      document.querySelectorAll('#yearSelector .year-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.year === targetYear);
      });

      selectedCity = targetCity;
      selectedYear = targetYear;
      
      updateElectionId();
      await loadAndRender(currentElectionId);
    });
  }

  function updateElectionId() {
    currentElectionId = `${selectedYear}-${selectedCity}-mayor`;
  }

  // ---- SPA Navigation ----

  async function renderMethodology() {
    const tbody = document.getElementById('pollsterWeightsTableBody');
    if (!tbody) return;

    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="text-center" style="padding: var(--space-md); color: var(--color-text-secondary);">
          載入民調機構信譽評分中...
        </td>
      </tr>
    `;

    // Ensure metadata is loaded
    if (!pollsterData) {
      const pollsterD = await loadJSON('data/meta/pollsters.json');
      if (!pollsterD) {
        tbody.innerHTML = `
          <tr>
            <td colspan="4" class="text-center" style="padding: var(--space-md); color: var(--color-danger);">
              資料載入失敗
            </td>
          </tr>
        `;
        return;
      }
      pollsterData = pollsterD;
    }

    const pollsters = pollsterData.pollsters || [];
    
    // Sort pollsters by credibilityScore descending
    const sortedPollsters = [...pollsters].sort((a, b) => b.credibilityScore - a.credibilityScore);

    tbody.innerHTML = sortedPollsters.map(p => {
      let leanText = '中立';
      let leanStyle = 'color: var(--color-text-secondary);';
      if (p.leanDirection === 'blue') {
        leanText = '偏藍';
        leanStyle = 'color: #3b82f6; font-weight: 600;';
      } else if (p.leanDirection === 'slightly-blue') {
        leanText = '略藍';
        leanStyle = 'color: #60a5fa; font-weight: 500;';
      } else if (p.leanDirection === 'green') {
        leanText = '偏綠';
        leanStyle = 'color: #10b981; font-weight: 600;';
      } else if (p.leanDirection === 'slightly-green') {
        leanText = '略綠';
        leanStyle = 'color: #34d399; font-weight: 500;';
      }

      const scorePercent = (p.credibilityScore * 100).toFixed(0) + '%';
      
      return `
        <tr>
          <td style="padding: var(--space-sm) var(--space-md); vertical-align: middle;">
            <div style="font-weight: 700;">${p.name}</div>
            <div style="font-size: 0.75rem; color: var(--color-text-tertiary);">${p.fullName}</div>
          </td>
          <td style="text-align: center; padding: var(--space-sm) var(--space-md); vertical-align: middle;">
            <div style="font-weight: 800; font-size: 1.1rem; color: var(--color-accent-blue);">${p.credibilityScore.toFixed(2)}</div>
            <div class="vote-bar-track" style="width: 80px; height: 6px; margin: 4px auto 0 auto; border-radius: 3px;">
              <div class="vote-bar-fill" style="width: ${p.credibilityScore * 100}%; height: 100%; background: var(--color-accent-blue); border-radius: 3px;"></div>
            </div>
          </td>
          <td style="padding: var(--space-sm) var(--space-md); font-size: 0.85rem; color: var(--color-text-secondary); vertical-align: middle;">
            ${p.methodology || '電話調查'}
          </td>
          <td style="padding: var(--space-sm) var(--space-md); font-size: 0.85rem; color: var(--color-text-secondary); line-height: 1.5; vertical-align: middle;">
            <div>${p.notes || ''}</div>
            <div style="font-size: 0.72rem; margin-top: 4px; ${leanStyle}">傾向偏向：${leanText} (偏差值: ${p.leanMagnitude || 0.0})</div>
          </td>
        </tr>
      `;
    }).join('');

    initScrollAnimations();
  }

  function switchTab(tab) {
    activeTab = tab;
    
    // Update header nav active styles
    $('navLinkDashboard').classList.toggle('active', tab === 'dashboard');
    $('navLinkDetail').classList.toggle('active', tab === 'detail');
    $('navLinkMethodology').classList.toggle('active', tab === 'methodology');

    // Update section visibility
    DOM.dashboardSection.classList.toggle('hidden', tab !== 'dashboard');
    DOM.methodologyViewSection.classList.toggle('hidden', tab !== 'methodology');

    if (tab === 'detail') {
      document.querySelector('.nav-switcher-container').classList.remove('hidden');
      DOM.citySelector.classList.remove('hidden');
      loadAndRender(currentElectionId);
    } else if (tab === 'dashboard') {
      document.querySelector('.nav-switcher-container').classList.remove('hidden');
      DOM.citySelector.classList.add('hidden');
      
      DOM.loadingState.classList.add('hidden');
      DOM.constructionState.classList.add('hidden');
      DOM.appContent.classList.add('hidden');

      renderDashboard();
    } else if (tab === 'methodology') {
      document.querySelector('.nav-switcher-container').classList.add('hidden');
      
      DOM.loadingState.classList.add('hidden');
      DOM.constructionState.classList.add('hidden');
      DOM.appContent.classList.add('hidden');

      renderMethodology();
    }
  }

  function initSPANavigation() {
    $('navLinkDashboard').addEventListener('click', () => switchTab('dashboard'));
    $('navLinkDetail').addEventListener('click', () => switchTab('detail'));
    $('navLinkMethodology').addEventListener('click', () => switchTab('methodology'));
  }

  // ---- Font Size Adjuster ----

  function initFontAdjuster() {
    const setFontScale = (scale) => {
      currentFontScale = scale;
      try {
        localStorage.setItem('clearPollFontScale', scale);
      } catch (e) {
        console.warn('[ClearPoll] localStorage set failed:', e);
      }
      document.documentElement.style.setProperty('--font-scale', scale);

      document.querySelectorAll('#fontAdjuster .font-btn').forEach(btn => btn.classList.remove('active'));
      if (scale < 1.0) {
        $('fontSizeDown').classList.add('active');
      } else if (scale > 1.0) {
        $('fontSizeUp').classList.add('active');
      } else {
        $('fontSizeReset').classList.add('active');
      }
    };

    // Set initial scale
    setFontScale(currentFontScale);

    $('fontSizeDown').addEventListener('click', () => {
      if (currentFontScale > 0.85) setFontScale(parseFloat((currentFontScale - 0.15).toFixed(2)));
    });
    $('fontSizeReset').addEventListener('click', () => {
      setFontScale(1.0);
    });
    $('fontSizeUp').addEventListener('click', () => {
      if (currentFontScale < 1.30) setFontScale(parseFloat((currentFontScale + 0.15).toFixed(2)));
    });
  }

  function renderHistoricalComparison(city, pastResults) {
    const container = DOM.historicalGrid;
    if (!container || !pastResults || !pastResults.results) return;

    // Filter past results for this city
    const cityResults = pastResults.results.filter(r => {
      const parts = r.electionId.split('-');
      return parts[1] === city;
    });

    if (cityResults.length === 0) {
      container.innerHTML = `<div class="card text-center" style="padding:40px;">暫無此選區的歷史得票統計數據</div>`;
      return;
    }

    const cityMeta = electionsMetadata?.find(e => e.city === city);
    const cityName = cityMeta ? cityMeta.cityName : city;

    function getPartyVisual(c, electionType) {
      let color = '#666666';
      let className = 'other';
      let partyLabel = c.party;

      if (c.party === 'DPP') {
        color = '#1B9431';
        className = 'dpp';
        partyLabel = '民進黨';
      } else if (c.party === 'KMT') {
        color = '#000095';
        className = 'kmt';
        partyLabel = '國民黨';
      } else if (c.party === 'TPP') {
        color = '#28C8C8';
        className = 'tpp';
        partyLabel = '民眾黨';
      } else if (c.id === 'pfp' || (c.name && c.name.includes('親民')) || (c.name && c.name.includes('宋楚瑜'))) {
        color = '#ea580c';
        className = 'pfp';
        partyLabel = '親民黨';
      } else if (c.id === 'npp' || (c.name && c.name.includes('時代力量'))) {
        color = '#f59e0b';
        className = 'npp';
        partyLabel = '時代力量';
      } else if (c.party === 'IND') {
        color = '#64748b';
        className = 'ind';
        partyLabel = '無黨籍';
      }

      return { color, className, partyLabel };
    }

    function renderCard(r, cardTitle, electionType) {
      const rowsHtml = r.candidates.map(c => {
        const visual = getPartyVisual(c, electionType);
        const color = visual.color;
        const colorClass = visual.className;

        let candidateTitle = c.name;
        if (electionType === 'mayor') {
          const pLabel = visual.partyLabel || (c.party === 'IND' ? '無黨籍' : c.party);
          candidateTitle = `${c.name} (${pLabel})`;
        } else if (electionType === 'president') {
          const pLabel = (c.party === 'OTHER' && c.name.includes('宋楚瑜')) ? '親民黨' : (visual.partyLabel || c.party);
          candidateTitle = `${c.name} (${pLabel})`;
        } else {
          // partylist: c.name is already the full party name (e.g. 民主進步黨, 中國國民黨)
          candidateTitle = c.name;
        }

        let badgeHtml = '';
        if (c.elected) {
          if (electionType === 'partylist') {
            badgeHtml = '<span class="label" style="font-size:0.72rem; margin-left:6px; background:#dcfce7; color:#15803d; border:1px solid #bbf7d0; padding:1px 5px; border-radius:4px; font-weight:600; white-space:nowrap; vertical-align:middle;" title="跨過5%門檻分配席次">🏆 獲分配席次</span>';
          } else {
            badgeHtml = '<span style="font-size:0.85rem; margin-left:4px; white-space:nowrap; vertical-align:middle;" title="當選">🏆</span>';
          }
        }

        return `
          <tr>
            <td class="candidate-col" style="color:${color};">
              <div style="display:inline-flex; align-items:center; white-space:nowrap; gap:2px;">
                <span>${candidateTitle}</span>${badgeHtml}
              </div>
            </td>
            <td class="bar-col">
              <div style="height:8px; background:var(--color-bg-secondary); border-radius:4px; overflow:hidden; width:100%; min-width:60px;">
                <div class="vote-bar-fill ${colorClass} animate-bar" style="width:${c.voteShare}%; background-color:${color}; height:100%; border-radius:4px;"></div>
              </div>
            </td>
            <td class="stat-col">
              <span style="color:${color}; font-weight:700; font-size:0.92rem;">${c.voteShare.toFixed(1)}%</span>
              <span style="font-size:0.75rem; color:var(--color-text-tertiary); margin-left:4px;">(${c.votes.toLocaleString()} 票)</span>
            </td>
          </tr>
        `;
      }).join('');

      return `
        <div class="card historical-card" style="display:flex; flex-direction:column; justify-content:space-between; margin-bottom:0;">
          <div>
            <div class="card-header" style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--color-border); padding-bottom:var(--space-xs); margin-bottom:var(--space-sm); gap:8px;">
              <h3 class="historical-card-title" title="${cardTitle}">${cardTitle}</h3>
              <span class="historical-card-date">${r.date}</span>
            </div>
            <div class="card-body" style="padding:0; overflow-x:auto;">
              <table class="historical-table">
                <tbody>
                  ${rowsHtml}
                </tbody>
              </table>
            </div>
          </div>
          <div style="border-top:1px dashed var(--color-border); margin-top:var(--space-md); padding-top:var(--space-xs); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
            <span style="font-size:0.78rem; color:var(--color-text-tertiary); white-space:nowrap;">
              投票率：<strong style="color:var(--color-text-secondary);">${r.turnoutRate ? r.turnoutRate.toFixed(2) + '%' : 'N/A'}</strong>
            </span>
            <span style="font-size:0.78rem; color:var(--color-text-tertiary); white-space:nowrap;">
              有效票：<strong style="color:var(--color-text-secondary);">${r.totalVotes ? r.totalVotes.toLocaleString() + ' 票' : 'N/A'}</strong>
            </span>
          </div>
        </div>
      `;
    }

    let shiftCardHtml = '';
    if (analysisResult && analysisResult.partisanShift && analysisResult.partisanShift.past2022) {
      const ps = analysisResult.partisanShift;
      const shift = ps.shift;
      const past = ps.past2022;
      const pred = ps.predicted2026;

      const swingBadgeColor = shift.direction === 'blue' ? '#3b82f6' : (shift.direction === 'green' ? '#10b981' : '#6b7280');
      const swingBadgeText = shift.direction === 'blue'
        ? `泛藍位移 +${shift.netBlueSwing}%`
        : (shift.direction === 'green' ? `泛綠位移 +${Math.abs(shift.netBlueSwing)}%` : '板塊穩定五五波');

      shiftCardHtml = `
        <div class="card" style="border-top: 4px solid ${swingBadgeColor}; margin-bottom: var(--space-md); box-shadow: var(--shadow-md);">
          <div class="card-header" style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--color-border); padding-bottom: var(--space-xs); margin-bottom: var(--space-sm);">
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:1.3rem;">📊</span>
              <div>
                <h3 style="font-weight:800; font-size:1.15rem; margin:0;">民意板塊位移指數 (Partisan Shift Index)</h3>
                <span style="font-size:0.75rem; color: var(--color-text-tertiary);">對照中選會 2022 實際開票 vs 2026 ClearPoll 最新預測</span>
              </div>
            </div>
            <span class="label" style="font-size:0.8rem; font-weight:700; background: ${swingBadgeColor}15; color: ${swingBadgeColor}; border: 1px solid ${swingBadgeColor}40; padding:4px 10px; border-radius:6px; white-space:nowrap; flex-shrink:0;">
              ${swingBadgeText}
            </span>
          </div>
          <div class="card-body" style="padding:0;">
            <p style="font-size: 0.9rem; line-height: 1.6; color: var(--color-text-secondary); margin-bottom: var(--space-md);">
              ${shift.summary}
            </p>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px;">
              <div style="background: var(--color-bg-secondary); padding: 12px; border-radius: 8px; border: 1px solid var(--color-border);">
                <div style="font-size: 0.75rem; color: var(--color-text-tertiary); font-weight:600;">泛藍板塊消長</div>
                <div style="font-size: 1.3rem; font-weight: 800; color: #3b82f6; margin: 4px 0;">
                  ${shift.blueDelta >= 0 ? '+' : ''}${shift.blueDelta}%
                </div>
                <div style="font-size: 0.75rem; color: var(--color-text-secondary);">2022: ${past.blueShare}% → 2026: ${pred.blueShare}%</div>
              </div>
              <div style="background: var(--color-bg-secondary); padding: 12px; border-radius: 8px; border: 1px solid var(--color-border);">
                <div style="font-size: 0.75rem; color: var(--color-text-tertiary); font-weight:600;">泛綠板塊消長</div>
                <div style="font-size: 1.3rem; font-weight: 800; color: #10b981; margin: 4px 0;">
                  ${shift.greenDelta >= 0 ? '+' : ''}${shift.greenDelta}%
                </div>
                <div style="font-size: 0.75rem; color: var(--color-text-secondary);">2022: ${past.greenShare}% → 2026: ${pred.greenShare}%</div>
              </div>
              <div style="background: var(--color-bg-secondary); padding: 12px; border-radius: 8px; border: 1px solid var(--color-border);">
                <div style="font-size: 0.75rem; color: var(--color-text-tertiary); font-weight:600;">第三勢力／其他</div>
                <div style="font-size: 1.3rem; font-weight: 800; color: #f59e0b; margin: 4px 0;">
                  ${shift.otherDelta >= 0 ? '+' : ''}${shift.otherDelta}%
                </div>
                <div style="font-size: 0.75rem; color: var(--color-text-secondary);">2022: ${past.otherShare}% → 2026: ${pred.otherShare}%</div>
              </div>
              <div style="background: var(--color-bg-secondary); padding: 12px; border-radius: 8px; border: 1px solid var(--color-border);">
                <div style="font-size: 0.75rem; color: var(--color-text-tertiary); font-weight:600;">藍綠淨位移 (Net Swing)</div>
                <div style="font-size: 1.3rem; font-weight: 800; color: ${swingBadgeColor}; margin: 4px 0;">
                  ${shift.netBlueSwing >= 0 ? `藍 +${shift.netBlueSwing}%` : `綠 +${Math.abs(shift.netBlueSwing)}%`}
                </div>
                <div style="font-size: 0.75rem; color: var(--color-text-secondary);">2022勝者：${past.winner}</div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    // Dual Switcher Bar: Layout mode (2+2+2 grid vs full-width table) & Range mode (all vs recent)
    const filterBarHtml = `
      <div class="historical-filter-bar" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:var(--space-md); background:var(--color-bg-secondary); padding:10px 16px; border-radius:12px; border:1px solid var(--color-border);">
        <div style="font-size:0.85rem; color:var(--color-text-secondary); font-weight:600; display:flex; align-items:center; gap:6px;">
          <span>🗳️ 歷屆中選會選舉真實得票紀錄</span>
          <span style="font-size:0.75rem; color:var(--color-text-tertiary); font-weight:normal;">（依年份週期成對排列・已收錄 2016~2024 總統、政黨票及市長選舉）</span>
        </div>
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <!-- Layout Switcher -->
          <div class="hist-toggle-group">
            <button type="button" class="hist-btn hist-layout-btn ${historicalViewLayout === 'grid' ? 'active' : ''}" data-layout="grid">
              ⊞ 雙欄並排 (2+2+2)
            </button>
            <button type="button" class="hist-btn hist-layout-btn ${historicalViewLayout === 'table' ? 'active' : ''}" data-layout="table">
              ☰ 滿版表格模式
            </button>
          </div>

          <!-- Range Switcher -->
          <div class="hist-toggle-group">
            <button type="button" class="hist-btn hist-range-btn ${historicalRangeMode === 'all' ? 'active' : ''}" data-range="all">
              📜 完整歷屆 (2016~2024)
            </button>
            <button type="button" class="hist-btn hist-range-btn ${historicalRangeMode === 'recent' ? 'active' : ''}" data-range="recent">
              🔥 精選近三屆 (2+2+2)
            </button>
          </div>
        </div>
      </div>
    `;

    function findElection(year, type) {
      return cityResults.find(r => {
        const parts = r.electionId.split('-');
        const y = parts[0];
        const t = r.type || (parts.length > 2 ? parts[2] : 'mayor');
        return y === year && (t === type || r.electionId.includes(`-${type}`));
      });
    }

    const allCycles = [
      {
        id: '2024',
        title: '🗳️ 2024 年中華民國大選',
        desc: `中央大選 ${cityName} 得票對照（2024-01-13 同日投票・藍綠白最新三腳督盤勢）`,
        isRecent: true,
        items: [
          { r: findElection('2024', 'president'), title: `2024 總統大選 (${cityName})`, type: 'president' },
          { r: findElection('2024', 'partylist'), title: `2024 立委不分區政黨票 (${cityName})`, type: 'partylist' }
        ].filter(x => x.r)
      },
      {
        id: 'mayor-cycle',
        title: '🏛️ 歷屆縣市長地方選舉',
        desc: `地方首長選舉真實開票（2022、2018 地方執政版圖與首長選情結構）`,
        isRecent: true,
        items: [
          { r: findElection('2022', 'mayor'), title: `2022 ${cityName}長選舉`, type: 'mayor' },
          { r: findElection('2018', 'mayor'), title: `2018 ${cityName}長選舉`, type: 'mayor' }
        ].filter(x => x.r)
      },
      {
        id: '2020',
        title: '🗳️ 2020 年中華民國大選',
        desc: `中央大選 ${cityName} 得票對照（2020-01-11 同日投票・藍綠對決抗中保台結構）`,
        isRecent: true,
        items: [
          { r: findElection('2020', 'president'), title: `2020 總統大選 (${cityName})`, type: 'president' },
          { r: findElection('2020', 'partylist'), title: `2020 立委不分區政黨票 (${cityName})`, type: 'partylist' }
        ].filter(x => x.r)
      },
      {
        id: '2016',
        title: '🗳️ 2016 年中華民國大選',
        desc: `中央大選 ${cityName} 得票對照（2016-01-16 同日投票・首度政黨輪替結構）`,
        isRecent: false,
        items: [
          { r: findElection('2016', 'president'), title: `2016 總統大選 (${cityName})`, type: 'president' },
          { r: findElection('2016', 'partylist'), title: `2016 立委不分區政黨票 (${cityName})`, type: 'partylist' }
        ].filter(x => x.r)
      }
    ];

    const visibleCycles = historicalRangeMode === 'recent'
      ? allCycles.filter(c => c.isRecent && c.items.length > 0)
      : allCycles.filter(c => c.items.length > 0);

    const containerClass = historicalViewLayout === 'table' ? 'historical-table-stack' : 'historical-pair-grid';

    let groupsHtml = `
      <div class="historical-groups-container" style="display:flex; flex-direction:column; gap:var(--space-xl);">
        ${visibleCycles.map(cycle => {
          const cardsHtml = cycle.items.map(item => renderCard(item.r, item.title, item.type)).join('');
          return `
            <div class="historical-group">
              <div class="historical-group-header">
                <h4 class="historical-group-title">${cycle.title}</h4>
                <span class="historical-group-desc">${cycle.desc}</span>
              </div>
              <div class="${containerClass}">
                ${cardsHtml}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    container.innerHTML = filterBarHtml + shiftCardHtml + groupsHtml;

    // Attach range button click listeners
    container.querySelectorAll('.hist-range-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const mode = e.currentTarget.dataset.range;
        if (mode && mode !== historicalRangeMode) {
          historicalRangeMode = mode;
          renderHistoricalComparison(city, pastResults);
        }
      });
    });

    // Attach layout button click listeners
    container.querySelectorAll('.hist-layout-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const layout = e.currentTarget.dataset.layout;
        if (layout && layout !== historicalViewLayout) {
          historicalViewLayout = layout;
          renderHistoricalComparison(city, pastResults);
        }
      });
    });
  }

  // ---- Main Loader & Renderer ----

  function renderHistoricalOnlyResults(election, pastResults) {
    const actual = pastResults?.results?.find(r => r.electionId === election.id);
    
    DOM.heroSummaryText.textContent = `本選區為已落幕之歷史選舉（實際投票率 ${actual ? actual.turnoutRate + '%' : 'N/A'}）。本站在此選舉期間尚未啟動，故無歷史民調預測，以下為最終實際選舉開票結果對照：`;
    
    if (!actual) {
      DOM.predictionTableContainer.innerHTML = `<div class="card text-center" style="padding:40px;">暫無此選區的歷史得票統計數據</div>`;
      return;
    }

    // Build headers
    let candidateHeaders = actual.candidates.map(c => {
      const colors = { 'DPP': '#1B9431', 'KMT': '#000095', 'TPP': '#28C8C8', 'IND': '#888888', 'OTHER': '#666666' };
      const color = colors[c.party] || '#555555';
      return `<th class="candidate-header-cell text-center" style="background-color: ${color}; color: #ffffff; font-weight: 700; padding: var(--space-sm);">${c.name} (${c.party})</th>`;
    }).join('');

    // Row: 實際得票數
    let votesRow = actual.candidates.map(c => {
      return `<td class="text-center val-medium" style="font-weight: 600; padding: var(--space-md);">${c.votes.toLocaleString()} 票</td>`;
    }).join('');

    // Row: 實際得票率
    let shareRow = actual.candidates.map(c => {
      const colors = { 'DPP': '#1B9431', 'KMT': '#000095', 'TPP': '#28C8C8', 'IND': '#888888', 'OTHER': '#666666' };
      const color = colors[c.party] || '#555555';
      return `<td class="text-center val-large" style="color: ${color}; font-weight: 800; padding: var(--space-md);">${c.voteShare.toFixed(2)}%</td>`;
    }).join('');

    // Row: 是否當選
    let electedRow = actual.candidates.map(c => {
      return `<td class="text-center" style="padding: var(--space-md);">${c.elected ? '<span class="win-opportunity-badge high" style="background-color: #D1FAE5; color: #065F46; font-weight: 700; padding: 4px 12px; border-radius: var(--radius-full);">🏆 當選</span>' : '<span style="color: var(--color-text-tertiary);">未當選</span>'}</td>`;
    }).join('');

    const tableHtml = `
      <table class="prediction-summary-table" style="width: 100%; border-collapse: collapse; margin-top: var(--space-md);">
        <thead>
          <tr>
            <th style="width: 220px; text-align: left; background-color: var(--color-bg-secondary); padding: var(--space-sm);">項目</th>
            ${candidateHeaders}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="row-label" style="padding: var(--space-md); font-weight: 600; background-color: var(--color-bg-secondary-light);">實際得票數</td>
            ${votesRow}
          </tr>
          <tr>
            <td class="row-label" style="padding: var(--space-md); font-weight: 600; border-bottom: 2px solid var(--color-border); background-color: var(--color-bg-secondary-light);">實際得票率</td>
            ${shareRow}
          </tr>
          <tr>
            <td class="row-label" style="padding: var(--space-md); font-weight: 600; background-color: var(--color-bg-secondary-light);">選舉當選狀態</td>
            ${electedRow}
          </tr>
        </tbody>
      </table>
    `;

    DOM.predictionTableContainer.innerHTML = tableHtml;
  }

  async function loadAndRender(electionId) {
    setViewState('loading');

    const data = await loadElectionData(electionId);
    
    if (!data) {
      console.warn('[ClearPoll] No data loaded, using fallbacks.');
      setViewState('construction');
      return;
    }

    const { election, polls, pollsters, pastResults } = data;

    // Check if it's a completed election with no polls data (Pure Historical Results page)
    const isHistoricalOnly = election.status === 'completed' && (!polls || polls.polls.length === 0);

    $('pollTrendSection').classList.toggle('hidden', isHistoricalOnly);
    $('winProbSection').classList.toggle('hidden', isHistoricalOnly);
    $('voteShareSection').classList.toggle('hidden', isHistoricalOnly);
    $('pollTableSection').classList.toggle('hidden', isHistoricalOnly);
    $('predictionLogSection').classList.toggle('hidden', isHistoricalOnly);
    $('historicalSection').classList.toggle('hidden', isHistoricalOnly);

    if (isHistoricalOnly) {
      const actual = pastResults?.results?.find(r => r.electionId === election.id);
      DOM.heroElectionName.textContent = election.name;
      DOM.heroUpdateTime.textContent = `開票日期：${actual ? actual.date : election.date}`;
      renderHistoricalOnlyResults(election, pastResults);
      setViewState('content');
      return;
    }

    // Check if it's marked as construction
    if (election.status === 'construction' || !polls || polls.polls.length === 0) {
      DOM.heroElectionName.textContent = election.name;
      setViewState('construction');
      return;
    }

    pollData = polls;
    pollsterData = pollsters;

    if (!historicalDemographicsData) {
      historicalDemographicsData = await loadJSON('data/history/historical-demographics.json');
    }

    // Run analysis with scenario options, fundamentals, and historical past results
    const scenarioOpts = {
      ...getScenarioOptions(),
      historicalDemographics: historicalDemographicsData,
      pastResults: pastResults
    };
    analysisResult = ClearPollModel.analyze(pollData, pollsterData, scenarioOpts);
    console.log('[ClearPoll] Analysis complete:', analysisResult);

    // Render everything
    DOM.heroElectionName.textContent = analysisResult.electionName;
    DOM.heroUpdateTime.textContent = `最後更新：${new Date(analysisResult.analysisTimestamp).toLocaleString('zh-TW')}`;
    const fundText = analysisResult.fundamentalsWeight > 0
      ? `【雙支柱模型】因民調樣本精簡（${analysisResult.pollCount} 筆），已導入中選會歷屆選舉基本盤加權錨定 ${(analysisResult.fundamentalsWeight * 100).toFixed(0)}%，防範單一機構偏誤。`
      : '';
    DOM.heroSummaryText.textContent =
      `根據 ${analysisResult.pollCount} 筆民調加權分析，標準誤差 ±${analysisResult.standardError}%。${fundText}`;

    renderPredictionSummaryTable(analysisResult, pastResults);
    renderPollTable(analysisResult);
    renderPredictionLog(analysisResult);
    renderHistoricalComparison(selectedCity, pastResults);
    renderDemographics(selectedCity);

    setViewState('content');

    // Wait a tick for DOM to settle, then render charts
    requestAnimationFrame(() => {
      renderCharts(analysisResult);
      initScrollAnimations();
    });
  }

  function getScenarioOptions() {
    const undecidedLeanEl = $('simUndecidedLean');
    const applyBiasEl = $('simApplyBias');
    return {
      undecidedLean: undecidedLeanEl ? parseFloat(undecidedLeanEl.value) : 0,
      applyBiasCorrection: applyBiasEl ? applyBiasEl.checked : true,
    };
  }

  function openPollDetailModal(poll, result) {
    const modal = $('pollDetailModal');
    const modalBody = $('modalPollBody');
    const modalTitle = $('modalPollsterTitle');
    if (!modal || !modalBody) return;

    const pollsterObj = pollsterData?.pollsters?.find(p => p.id === poll.pollster);
    const candidates = result?.candidates || [];

    modalTitle.textContent = `${poll.pollsterName || poll.pollster} (${poll.date})`;

    let candidateRows = candidates.map(c => {
      const raw = poll.results[c.id] != null ? poll.results[c.id].toFixed(1) + '%' : '-';
      const neutral = poll.neutralResults && poll.neutralResults[c.id] != null ? poll.neutralResults[c.id].toFixed(1) + '%' : raw;
      const adjusted = poll.adjustedResults && poll.adjustedResults[c.id] != null ? poll.adjustedResults[c.id].toFixed(1) + '%' : raw;
      const proj = poll.projectedVoteShare && poll.projectedVoteShare[c.id] != null ? poll.projectedVoteShare[c.id].toFixed(1) + '%' : '-';

      return `
        <tr>
          <td style="font-weight: 700; color: ${c.color};">${c.name} (${c.party})</td>
          <td class="text-right">${raw}</td>
          <td class="text-right">${neutral}</td>
          <td class="text-right">${adjusted}</td>
          <td class="text-right" style="font-weight: 800; color: ${c.color};">${proj}</td>
        </tr>
      `;
    }).join('');

    let leanText = '中立';
    if (pollsterObj) {
      if (pollsterObj.leanDirection?.includes('blue')) leanText = '偏藍 (機構效應校正中)';
      else if (pollsterObj.leanDirection?.includes('green')) leanText = '偏綠 (機構效應校正中)';
    }

    modalBody.innerHTML = `
      <div style="margin-bottom: var(--space-md); font-size: 0.88rem; color: var(--color-text-secondary); line-height: 1.7; background: var(--color-bg-secondary); padding: 12px; border-radius: var(--radius-md);">
        <div><b>調查日期：</b> ${poll.date}</div>
        <div><b>樣本規模：</b> ${poll.sampleSize.toLocaleString()} 份 (${poll.method === 'phone' ? '電話CATI' : '網路調查'})</div>
        <div><b>抽樣誤差：</b> ±${poll.marginOfError}%</div>
        <div><b>機構信譽得分：</b> ${pollsterObj ? pollsterObj.credibilityScore : 0.75} (${leanText})</div>
        ${poll.commissioner ? `<div><b>委託單位：</b> ${poll.commissioner}</div>` : ''}
      </div>

      <h4 style="font-weight: 700; margin-bottom: var(--space-xs); font-size: 0.95rem;">📊 交叉分析與偏差校正比對表</h4>
      <div style="overflow-x: auto; margin-bottom: var(--space-md);">
        <table class="data-table" style="width: 100%;">
          <thead>
            <tr>
              <th style="text-align: left;">候選人</th>
              <th class="text-right">原始民調支持度</th>
              <th class="text-right">中立選民支持度</th>
              <th class="text-right">偏差校正後支持度</th>
              <th class="text-right">推估得票率</th>
            </tr>
          </thead>
          <tbody>
            ${candidateRows}
          </tbody>
        </table>
      </div>

      <div style="background: var(--color-bg-tertiary); padding: 10px 14px; border-radius: var(--radius-md); font-size: 0.8rem; color: var(--color-text-secondary);">
        <b>加權拆解：</b> 時效 ${Math.round((poll.weights?.recency || 0)*100)}% | 樣本 ${Math.round((poll.weights?.sample || 0)*100)}% | 信譽 ${Math.round((poll.weights?.credibility || 0)*100)}% | <b>綜合權重：${((poll.weights?.combined || 0)*100).toFixed(1)}%</b>
      </div>
    `;

    modal.classList.remove('hidden');
  }

  function initPollModal() {
    const modal = $('pollDetailModal');
    const closeBtn = $('closeModalBtn');

    if (closeBtn && modal) {
      closeBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
      });

      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.classList.add('hidden');
        }
      });
    }

    if (DOM.pollDataBody) {
      DOM.pollDataBody.addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-poll-id]');
        if (!tr || e.target.closest('a.source-link')) return;

        const pid = tr.dataset.pollId;
        if (analysisResult && analysisResult.weightedPolls) {
          const poll = analysisResult.weightedPolls.find(p => p.id === pid);
          if (poll) {
            openPollDetailModal(poll, analysisResult);
          }
        }
      });
    }
  }

  function initScenarioSimulator() {
    const slider = $('simUndecidedLean');
    const valBadge = $('simUndecidedLeanVal');
    const biasCheck = $('simApplyBias');
    const biasBadge = $('simBiasVal');
    const resetBtn = $('resetSimBtn');

    if (!slider || !biasCheck) return;

    function updateLabels() {
      const val = parseFloat(slider.value);
      if (val === 0) {
        valBadge.textContent = '50/50 中立等比';
        valBadge.style.background = 'var(--color-accent-blue)';
      } else if (val < 0) {
        valBadge.textContent = `偏藍/野 (${(val * -6).toFixed(1)}%)`;
        valBadge.style.background = '#3b82f6';
      } else {
        valBadge.textContent = `偏綠/執 (${(val * 6).toFixed(1)}%)`;
        valBadge.style.background = '#10b981';
      }

      if (biasCheck.checked) {
        biasBadge.textContent = '已啟動';
        biasBadge.style.background = 'var(--color-accent-green)';
      } else {
        biasBadge.textContent = '未啟動';
        biasBadge.style.background = 'var(--color-text-tertiary)';
      }
    }

    slider.addEventListener('input', async () => {
      updateLabels();
      if (currentElectionId) {
        await loadAndRender(currentElectionId);
      }
    });

    biasCheck.addEventListener('change', async () => {
      updateLabels();
      if (currentElectionId) {
        await loadAndRender(currentElectionId);
      }
    });

    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        slider.value = 0;
        biasCheck.checked = true;
        updateLabels();
        if (currentElectionId) {
          await loadAndRender(currentElectionId);
        }
      });
    }

    updateLabels();
  }

  let historicalDemographicsData = null;

  async function renderDemographics(cityId) {
    const container = $('demographicsCardContainer');
    if (!container) return;

    if (!historicalDemographicsData) {
      historicalDemographicsData = await loadJSON('data/history/historical-demographics.json');
    }

    if (!historicalDemographicsData) {
      container.innerHTML = '<p class="text-secondary">選民結構資料載入中...</p>';
      return;
    }

    const demoResult = ClearPollModel.calculateDemographics(historicalDemographicsData);
    if (!demoResult) return;

    const cityData = demoResult.cities.find(c => c.id === cityId) || demoResult.cities[0];
    const cityNames = {
      taipei: '台北市',
      newtaipei: '新北市',
      taoyuan: '桃園市',
      taichung: '台中市',
      tainan: '台南市',
      kaohsiung: '高雄市',
      keelung: '基隆市',
      hsinchucity: '新竹市',
      hsinchucounty: '新竹縣',
      miaoli: '苗栗縣',
      changhua: '彰化縣',
      nantou: '南投縣',
      yunlin: '雲林縣',
      chiayicity: '嘉義市',
      chiayicounty: '嘉義縣',
      pingtung: '屏東縣',
      yilan: '宜蘭縣',
      hualien: '花蓮縣',
      taitung: '台東縣',
      penghu: '澎湖縣',
      kinmen: '金門縣',
      lienchiang: '連江縣'
    };

    const cName = cityNames[cityId] || (electionsMetadata?.find(e => e.city === cityId)?.cityName) || '該選區';

    const fmtSign = (val) => val > 0 ? `+${val}` : `${val}`;
    const greenIdxText = `綠 ${fmtSign(cityData.index.green)}`;
    const blueIdxText = `藍 ${fmtSign(cityData.index.blue)}`;
    const whiteIdxText = `白 ${fmtSign(cityData.index.white)}`;

    const gPct = cityData.structure.green.toFixed(1);
    const bPct = cityData.structure.blue.toFixed(1);
    const wPct = cityData.structure.white.toFixed(1);

    const h2hGPct = cityData.headToHead.green.toFixed(1);
    const h2hBPct = cityData.headToHead.blue.toFixed(1);

    container.innerHTML = `
      <div class="demo-header-bar">
        <div class="demo-title">【${cName}】當前選民結構與政治基本盤推估 (CDPSM 模型)</div>
        <div class="demo-index-tags">
          <span class="demo-tag green">2026投票指數：${greenIdxText}</span>
          <span class="demo-tag blue">${blueIdxText}</span>
          <span class="demo-tag white">${whiteIdxText}</span>
        </div>
      </div>

      <div style="font-size: 0.85rem; color: var(--color-text-secondary); margin-bottom: 8px; font-weight: 600;">
        三腳督基本盤分佈 (泛綠 ${gPct}% | 泛藍 ${bPct}% | 民眾黨/第三勢力 ${wPct}%)
      </div>

      <div class="demo-stack-bar">
        <div class="demo-stack-seg" style="width: ${gPct}%; background-color: #10b981;" title="泛綠 ${gPct}%">
          ${gPct > 10 ? `泛綠 ${gPct}%` : ''}
        </div>
        <div class="demo-stack-seg" style="width: ${bPct}%; background-color: #3b82f6;" title="泛藍 ${bPct}%">
          ${bPct > 10 ? `泛藍 ${bPct}%` : ''}
        </div>
        <div class="demo-stack-seg" style="width: ${wPct}%; background-color: #f59e0b;" title="民眾黨 ${wPct}%">
          ${wPct > 10 ? `民眾黨 ${wPct}%` : ''}
        </div>
      </div>

      <div style="margin-top: var(--space-lg);">
        <h4 style="font-size: 0.95rem; font-weight: 700; margin-bottom: 8px;">⚔️ 藍綠對決（一對一）極限盤勢推估</h4>
        <div style="overflow-x: auto;">
          <table class="demo-table">
            <thead>
              <tr>
                <th>地區別</th>
                <th>2026 藍綠投票指數</th>
                <th>泛綠支持率估算</th>
                <th>藍綠對決極限</th>
                <th>泛藍支持率估算</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="font-weight: 700;">${cName}</td>
                <td style="font-weight: 700; color: ${cityData.index.green >= 0 ? '#10b981' : '#3b82f6'};">
                  ${cityData.index.green >= 0 ? `綠 +${cityData.index.green}` : `藍 +${Math.abs(cityData.index.green)}`}
                </td>
                <td style="font-weight: 800; color: #10b981;">${h2hGPct}%</td>
                <td style="font-weight: 600; color: var(--color-text-secondary);">${cName}</td>
                <td style="font-weight: 800; color: #3b82f6;">${h2hBPct}%</td>
              </tr>
              <tr style="background: var(--color-bg-secondary-light);">
                <td>全國基準</td>
                <td>基準 0</td>
                <td style="font-weight: 700;">${demoResult.national.headToHead.green}%</td>
                <td>全國</td>
                <td style="font-weight: 700;">${demoResult.national.headToHead.blue}%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ---- Boot ----

  document.addEventListener('DOMContentLoaded', () => {
    initHeaderScroll();
    initTableSorting();
    init2DNavigation();
    initFontAdjuster();
    initSPANavigation();
    initPollModal();
    initScenarioSimulator();

    // Set initial tab state
    switchTab('dashboard');
  });

})();
