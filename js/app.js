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
  let selectedCity = 'kaohsiung';
  let selectedYear = '2026';
  let currentElectionId = '2026-kaohsiung-mayor';
  let activeTab = 'dashboard'; // 'dashboard' | 'detail' | 'methodology'
  
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
    yearSelector: $('yearSelector'),
    dashboardSection: $('dashboardSection'),
    dashboardGrid: $('dashboardGrid'),
    methodologyViewSection: $('methodologyViewSection'),
  };

  // ---- Data Loading ----

  /**
   * Load JSON from data/ directory.
   */
  async function loadJSON(path) {
    try {
      const resp = await fetch(path);
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

    // Row: 勝選機會
    let winOpportunityRow = candidates.map(c => {
      const prob = winProbabilities[c.id] || 0;
      let level = 'none';
      let text = '機會渺茫';
      if (prob >= 0.92) { level = 'high'; text = '機會極高'; }
      else if (prob >= 0.79) { level = 'high'; text = '機會高'; }
      else if (prob >= 0.68) { level = 'medium'; text = '機會略高'; }
      else if (prob >= 0.32) { level = 'medium'; text = '五五波'; }
      else if (prob > 0.05) { level = 'low'; text = '機會低'; }
      return `<td><span class="win-opportunity-badge ${level}">${text}</span></td>`;
    }).join('');

    // Row: 勝率
    let winProbabilityRow = candidates.map(c => {
      const prob = winProbabilities[c.id] || 0;
      return `<td style="font-weight: 700;">${(prob * 100).toFixed(1)}%</td>`;
    }).join('');

    // Row: 得票率預測
    let voteShareProjectionRow = candidates.map(c => {
      const share = predictedVoteShares[c.id] || 0;
      return `<td class="val-large" style="color: ${c.color}; font-weight: 800;">${share.toFixed(1)}%</td>`;
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

    DOM.predictionTableContainer.innerHTML = tableHtml;
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
        <tr>
          <td>${poll.date}</td>
          <td class="pollster-cell">${poll.pollsterName || poll.pollster}</td>
          <td><span class="method-badge">${methodLabels[poll.method] || poll.method}</span></td>
          <td class="number-cell text-right">${poll.sampleSize.toLocaleString()}</td>
          ${candidateCells}
          <td class="number-cell text-right">${poll.undecided != null ? poll.undecided.toFixed(1) + '%' : '-'}</td>
          <td class="weight-cell text-right">${(w * 100).toFixed(1)}% ${weightBar}</td>
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

  async function renderDashboard() {
    DOM.dashboardGrid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 60px 0;">
        <div class="loading-shimmer" style="width: 180px; height: 24px; margin: 0 auto;"></div>
        <p class="mt-md" style="color: var(--color-text-secondary);">正在彙整與加權計算六都選情大盤...</p>
      </div>
    `;

    // Ensure metadata is loaded
    if (!electionsMetadata || !pollsterData) {
      const [electionsData, pollsterD] = await Promise.all([
        loadJSON('data/meta/elections.json'),
        loadJSON('data/meta/pollsters.json')
      ]);
      if (!electionsData || !pollsterD) {
        DOM.dashboardGrid.innerHTML = `<div class="card text-center" style="grid-column:1/-1;">資料載入失敗</div>`;
        return;
      }
      electionsMetadata = electionsData.elections;
      pollsterData = pollsterD;
    }

    const yearElections = electionsMetadata.filter(e => e.year === selectedYear);

    const cardPromises = yearElections.map(async (election) => {
      // Check if under construction
      if (election.status === 'construction' || !election.pollsFile) {
        return `
          <div class="dashboard-card" style="opacity: 0.85; cursor: default;">
            <div class="dash-card-header">
              <span class="dash-city-name">${election.cityName}</span>
              <span class="dash-status-label construction">施工中</span>
            </div>
            <div class="dash-construction-body">
              <div style="font-size: 2rem; margin-bottom: var(--space-xs);">🚧</div>
              <div style="font-weight: 600;">資料正收集中</div>
              <div style="font-size: 0.72rem; color: var(--color-text-tertiary);">施工中選區</div>
            </div>
            <div class="dash-card-footer">
              <span>-</span>
              <span style="font-weight: 600; color: var(--color-text-tertiary);">敬請期待</span>
            </div>
          </div>
        `;
      }

      try {
        // Load election data using our Google Sheet / local JSON loader
        const data = await loadElectionData(election.id);
        if (!data || !data.polls || data.polls.polls.length === 0) {
          throw new Error(`No polls for ${election.id}`);
        }

        const result = ClearPollModel.analyze(data.polls, data.pollsters);

        // Map candidates to sorted support bars
        let barsHtml = election.candidates.map(c => {
          const share = result.predictedVoteShares[c.id] || 0;
          return `
            <div class="dash-cand-row">
              <div class="dash-cand-info">
                <span style="color: ${c.color}; font-weight: 700;">${c.name} (${c.party})</span>
                <span style="color: ${c.color}; font-weight: 800;">${share.toFixed(1)}%</span>
              </div>
              <div class="dash-progress-track">
                <div class="dash-progress-fill" style="width: ${share.toFixed(1)}%; background-color: ${c.color};"></div>
              </div>
            </div>
          `;
        }).join('');

        // Find leader
        let leader = election.candidates[0];
        let maxProb = 0;
        for (const c of election.candidates) {
          const prob = result.winProbabilities[c.id] || 0;
          if (prob > maxProb) {
            maxProb = prob;
            leader = c;
          }
        }

        let oppText = '五五波';
        let badgeClass = 'medium';
        if (maxProb >= 0.92) { oppText = '機會極高'; badgeClass = 'high'; }
        else if (maxProb >= 0.79) { oppText = '機會高'; badgeClass = 'high'; }
        else if (maxProb >= 0.68) { oppText = '機會略高'; badgeClass = 'medium'; }
        else if (maxProb < 0.32) { oppText = '機會低'; badgeClass = 'low'; }

        const statusClass = election.status === 'completed' ? 'completed' : 'upcoming';
        const statusText = election.status === 'completed' ? '已落幕' : '預測中';

        return `
          <div class="dashboard-card" data-election-id="${election.id}" data-city="${election.city}">
            <div>
              <div class="dash-card-header">
                <span class="dash-city-name">${election.cityName}</span>
                <span class="dash-status-label ${statusClass}">${statusText}</span>
              </div>
              <div class="dash-card-body">
                ${barsHtml}
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
        console.error(`Failed to render dashboard card for ${election.id}:`, err);
        return `
          <div class="dashboard-card" style="opacity: 0.85; cursor: default;">
            <div class="dash-card-header">
              <span class="dash-city-name">${election.cityName}</span>
              <span class="dash-status-label construction">錯誤</span>
            </div>
            <div class="dash-construction-body">
              <div style="font-size: 2rem; margin-bottom: var(--space-xs);">⚠️</div>
              <div style="font-weight: 600;">數據載入失敗</div>
              <div style="font-size: 0.72rem; color: var(--color-text-tertiary);">連線或結構錯誤</div>
            </div>
            <div class="dash-card-footer">
              <span>-</span>
              <span style="font-weight: 600; color: var(--color-text-tertiary);">重試</span>
            </div>
          </div>
        `;
      }
    });

    const cardsHtml = await Promise.all(cardPromises);
    DOM.dashboardGrid.innerHTML = cardsHtml.join('');

    // Bind card clicks
    DOM.dashboardGrid.querySelectorAll('.dashboard-card[data-election-id]').forEach(card => {
      card.addEventListener('click', () => {
        const eid = card.dataset.electionId;
        const city = card.dataset.city;

        selectedCity = city;
        currentElectionId = eid;

        // Set active city button in detail navigator
        document.querySelectorAll('#citySelector .city-btn').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.city === city);
        });

        switchTab('detail');
      });
    });
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
      selectedCity = btn.dataset.city;

      updateElectionId();
      await loadAndRender(currentElectionId);
    });

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

    // Run analysis
    analysisResult = ClearPollModel.analyze(pollData, pollsterData);
    console.log('[ClearPoll] Analysis complete:', analysisResult);

    // Render everything
    DOM.heroElectionName.textContent = analysisResult.electionName;
    DOM.heroUpdateTime.textContent = `最後更新：${new Date(analysisResult.analysisTimestamp).toLocaleString('zh-TW')}`;
    DOM.heroSummaryText.textContent =
      `根據 ${analysisResult.pollCount} 筆民調加權分析，標準誤差 ±${analysisResult.standardError}%。`;

    renderPredictionSummaryTable(analysisResult, pastResults);
    renderPollTable(analysisResult);
    renderPredictionLog(analysisResult);

    setViewState('content');

    // Wait a tick for DOM to settle, then render charts
    requestAnimationFrame(() => {
      renderCharts(analysisResult);
      initScrollAnimations();
    });
  }

  // ---- Boot ----

  document.addEventListener('DOMContentLoaded', () => {
    initHeaderScroll();
    initTableSorting();
    init2DNavigation();
    initFontAdjuster();
    initSPANavigation();
    
    // Set initial tab state
    switchTab('dashboard');
  });

})();
