/* ============================================
   ClearPoll 透析民調 — Main Application
   ============================================ */

(function () {
  'use strict';

  // ---- State ----
  let currentElectionId = '2022-kaohsiung-mayor';
  let analysisResult = null;
  let pollData = null;
  let pollsterData = null;
  let tableSortColumn = 'date';
  let tableSortAsc = false;

  // ---- DOM References ----
  const $ = (id) => document.getElementById(id);

  const DOM = {
    loadingState: $('loadingState'),
    appContent: $('appContent'),
    electionSelect: $('electionSelect'),
    heroElectionName: $('heroElectionName'),
    heroUpdateTime: $('heroUpdateTime'),
    heroSummaryText: $('heroSummaryText'),
    predictionGrid: $('predictionGrid'),
    pollDataBody: $('pollDataBody'),
    pollCountLabel: $('pollCountLabel'),
    predictionLogBody: $('predictionLogBody'),
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
   * Load all data for the current election.
   */
  async function loadElectionData(electionId) {
    const [electionsData, pollsterData] = await Promise.all([
      loadJSON('data/meta/elections.json'),
      loadJSON('data/meta/pollsters.json')
    ]);

    if (!electionsData || !pollsterData) return null;

    const election = electionsData.elections.find(e => e.id === electionId);
    if (!election) {
      console.error(`[ClearPoll] Election not found in metadata: ${electionId}`);
      return null;
    }

    const pollsData = await loadJSON(election.pollsFile);
    if (!pollsData) return null;

    const pollDataMerged = {
      electionId: election.id,
      electionName: election.name,
      electionDate: election.date,
      candidates: election.candidates,
      polls: pollsData.polls || []
    };

    return { polls: pollDataMerged, pollsters: pollsterData };
  }

  // ---- Rendering ----

  /**
   * Show/hide loading state.
   */
  function setLoading(isLoading) {
    DOM.loadingState.classList.toggle('hidden', !isLoading);
    DOM.appContent.classList.toggle('hidden', isLoading);
  }

  /**
   * Render the hero prediction cards.
   */
  function renderPredictionCards(result) {
    const { candidates, predictedVoteShares, winProbabilities } = result;

    DOM.heroElectionName.textContent = result.electionName;
    DOM.heroUpdateTime.textContent = `最後更新：${new Date(result.analysisTimestamp).toLocaleString('zh-TW')}`;
    DOM.heroSummaryText.textContent =
      `根據 ${result.pollCount} 筆民調加權分析，標準誤差 ±${result.standardError}%。`;

    let html = '';
    for (const candidate of candidates) {
      const vote = predictedVoteShares[candidate.id] || 0;
      const prob = winProbabilities[candidate.id] || 0;
      const probPercent = (prob * 100).toFixed(1);
      const partyClass = candidate.party.toLowerCase();

      // Determine probability badge level
      let probLevel = 'low';
      if (prob >= 0.8) probLevel = 'high';
      else if (prob >= 0.3) probLevel = 'medium';

      const probIcon = prob >= 0.8 ? '✅' : prob >= 0.3 ? '⚠️' : '❌';

      html += `
        <div class="prediction-card ${partyClass}">
          <div class="party-accent"></div>
          <span class="candidate-party ${partyClass}">${candidate.party}</span>
          <h3 class="candidate-name">${candidate.name}</h3>
          <div class="predicted-vote">
            <p class="label">預測得票率</p>
            <p class="number-large count-up" style="color: ${candidate.color};">${vote.toFixed(1)}<span class="unit">%</span></p>
          </div>
          <div class="vote-bar-container">
            <div class="vote-bar-track large">
              <div class="vote-bar-fill ${partyClass} animate-bar" style="width: ${vote}%;"></div>
            </div>
          </div>
          <div class="mt-md">
            <p class="label">勝選機率</p>
            <span class="win-prob-badge ${probLevel}">
              <span class="prob-icon">${probIcon}</span>
              ${probPercent}%
            </span>
          </div>
        </div>
      `;
    }

    DOM.predictionGrid.innerHTML = html;

    // Trigger stagger animation
    requestAnimationFrame(() => {
      DOM.predictionGrid.classList.add('visible');
    });
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
        return `<td class="number-cell text-right" style="color: ${c.color}; font-weight: 500;">${displayVal}</td>`;
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

    let shareHeaders = candidates.map(c => `<th class="text-right">${c.name} 得票率</th>`).join('');
    let probHeaders = candidates.map(c => `<th class="text-right">${c.name} 勝率</th>`).join('');

    thead.innerHTML = `
      <tr>
        <th>日期</th>
        <th class="text-right">累計民調數</th>
        ${shareHeaders}
        ${probHeaders}
      </tr>
    `;

    let html = '';
    for (const entry of predictionLog) {
      let shareCells = candidates.map(c => {
        const val = entry.voteShares[c.id];
        return `<td class="number-cell text-right" style="color: ${c.color}; font-weight: 500;">${val != null ? val.toFixed(1) + '%' : '-'}</td>`;
      }).join('');

      let probCells = candidates.map(c => {
        const val = entry.winProbabilities[c.id];
        return `<td class="number-cell text-right" style="font-weight: 500;">${val != null ? (val * 100).toFixed(1) + '%' : '-'}</td>`;
      }).join('');

      html += `
        <tr>
          <td>${entry.date}</td>
          <td class="number-cell text-right">${entry.pollCount}</td>
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

    // Poll trend scatter chart
    ClearPollCharts.renderPollTrendChart('pollTrendChart', weightedPolls, candidates);

    // Win probability trend chart
    ClearPollCharts.renderWinProbChart('winProbChart', predictionLog, candidates);

    // Vote share bar chart
    ClearPollCharts.renderVoteShareBar('voteShareChart', predictedVoteShares, candidates);
  }

  // ---- Scroll Animations ----

  function initScrollAnimations() {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            // Stop observing once visible
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
    let lastScroll = 0;

    window.addEventListener('scroll', () => {
      const currentScroll = window.scrollY;
      header.classList.toggle('scrolled', currentScroll > 10);
      lastScroll = currentScroll;
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

  // ---- Election Switcher ----

  function initElectionSwitcher() {
    DOM.electionSelect.addEventListener('change', async (e) => {
      currentElectionId = e.target.value;
      await loadAndRender(currentElectionId);
    });
  }

  // ---- Main Init ----

  async function loadAndRender(electionId) {
    setLoading(true);

    const data = await loadElectionData(electionId);
    pollData = data.polls;
    pollsterData = data.pollsters;

    if (!pollData || !pollsterData) {
      // If no data files exist yet, use embedded demo data
      console.warn('[ClearPoll] Data files not found, using embedded demo data.');
      pollData = getDemoData();
      pollsterData = getDemoPollsterData();
    }

    // Run analysis
    analysisResult = ClearPollModel.analyze(pollData, pollsterData);
    console.log('[ClearPoll] Analysis complete:', analysisResult);

    // Render everything
    renderPredictionCards(analysisResult);
    renderPollTable(analysisResult);
    renderPredictionLog(analysisResult);

    setLoading(false);

    // Wait a tick for DOM to settle, then render charts
    requestAnimationFrame(() => {
      renderCharts(analysisResult);
      initScrollAnimations();
    });
  }

  // ---- Demo Data (Fallback) ----

  function getDemoData() {
    return {
      electionId: '2022-kaohsiung-mayor',
      electionName: '2022 高雄市長選舉',
      electionDate: '2022-11-26',
      candidates: [
        { id: 'chen', name: '陳其邁', party: 'DPP', color: '#1B9431' },
        { id: 'ke', name: '柯志恩', party: 'KMT', color: '#000095' },
      ],
      polls: [
        {
          id: 'poll-001', date: '2022-08-01', pollster: 'udn', pollsterName: '聯合報',
          sampleSize: 1073, method: 'phone',
          results: { chen: 53.0, ke: 18.0 }, neutralResults: { chen: 48.0, ke: 12.0 },
          undecided: 29.0, source: 'https://udn.com'
        },
        {
          id: 'poll-002', date: '2022-08-15', pollster: 'tvbs', pollsterName: 'TVBS',
          sampleSize: 1005, method: 'phone',
          results: { chen: 50.0, ke: 20.0 }, neutralResults: { chen: 45.0, ke: 15.0 },
          undecided: 30.0, source: 'https://tvbs.com.tw'
        },
        {
          id: 'poll-003', date: '2022-09-01', pollster: 'ettoday', pollsterName: 'ETtoday',
          sampleSize: 1102, method: 'phone',
          results: { chen: 55.2, ke: 21.3 }, neutralResults: { chen: 50.0, ke: 16.0 },
          undecided: 23.5, source: 'https://ettoday.net'
        },
        {
          id: 'poll-004', date: '2022-09-15', pollster: 'formosa', pollsterName: '美麗島電子報',
          sampleSize: 1074, method: 'phone',
          results: { chen: 56.8, ke: 19.5 }, neutralResults: { chen: 52.0, ke: 14.0 },
          undecided: 23.7, source: 'https://formosa.tw'
        },
        {
          id: 'poll-005', date: '2022-10-01', pollster: 'udn', pollsterName: '聯合報',
          sampleSize: 1087, method: 'phone',
          results: { chen: 52.5, ke: 22.0 }, neutralResults: { chen: 47.5, ke: 17.0 },
          undecided: 25.5, source: 'https://udn.com'
        },
        {
          id: 'poll-006', date: '2022-10-12', pollster: 'chinatimes', pollsterName: '中國時報',
          sampleSize: 1007, method: 'phone',
          results: { chen: 49.0, ke: 24.0 }, neutralResults: { chen: 44.0, ke: 19.0 },
          undecided: 27.0, source: 'https://chinatimes.com'
        },
        {
          id: 'poll-007', date: '2022-10-20', pollster: 'tvbs', pollsterName: 'TVBS',
          sampleSize: 1012, method: 'phone',
          results: { chen: 51.5, ke: 23.5 }, neutralResults: { chen: 46.5, ke: 18.5 },
          undecided: 25.0, source: 'https://tvbs.com.tw'
        },
        {
          id: 'poll-008', date: '2022-11-01', pollster: 'formosa', pollsterName: '美麗島電子報',
          sampleSize: 1068, method: 'phone',
          results: { chen: 57.3, ke: 22.8 }, neutralResults: { chen: 53.0, ke: 17.0 },
          undecided: 19.9, source: 'https://formosa.tw'
        },
        {
          id: 'poll-009', date: '2022-11-08', pollster: 'ettoday', pollsterName: 'ETtoday',
          sampleSize: 1116, method: 'phone',
          results: { chen: 54.0, ke: 25.0 }, neutralResults: { chen: 49.0, ke: 20.0 },
          undecided: 21.0, source: 'https://ettoday.net'
        },
        {
          id: 'poll-010', date: '2022-11-12', pollster: 'udn', pollsterName: '聯合報',
          sampleSize: 1092, method: 'phone',
          results: { chen: 51.0, ke: 26.0 }, neutralResults: { chen: 46.0, ke: 21.0 },
          undecided: 23.0, source: 'https://udn.com'
        },
        {
          id: 'poll-011', date: '2022-11-15', pollster: 'tvbs', pollsterName: 'TVBS',
          sampleSize: 1024, method: 'phone',
          results: { chen: 52.0, ke: 27.0 }, neutralResults: { chen: 47.5, ke: 22.0 },
          undecided: 21.0, source: 'https://tvbs.com.tw'
        },
        {
          id: 'poll-012', date: '2022-11-18', pollster: 'formosa', pollsterName: '美麗島電子報',
          sampleSize: 1081, method: 'phone',
          results: { chen: 58.0, ke: 24.5 }, neutralResults: { chen: 54.0, ke: 19.0 },
          undecided: 17.5, source: 'https://formosa.tw'
        },
      ],
    };
  }

  function getDemoPollsterData() {
    return {
      pollsters: [
        { id: 'udn', name: '聯合報', credibilityScore: 0.82, leanDirection: 'slightly-blue', leanMagnitude: 0.12 },
        { id: 'tvbs', name: 'TVBS', credibilityScore: 0.85, leanDirection: 'slightly-blue', leanMagnitude: 0.08 },
        { id: 'ettoday', name: 'ETtoday', credibilityScore: 0.78, leanDirection: 'neutral', leanMagnitude: 0.03 },
        { id: 'formosa', name: '美麗島電子報', credibilityScore: 0.88, leanDirection: 'slightly-green', leanMagnitude: 0.10 },
        { id: 'chinatimes', name: '中國時報', credibilityScore: 0.75, leanDirection: 'blue', leanMagnitude: 0.18 },
        { id: 'ltn', name: '自由時報', credibilityScore: 0.80, leanDirection: 'green', leanMagnitude: 0.15 },
      ],
    };
  }

  // ---- Boot ----

  async function init() {
    initHeaderScroll();
    initTableSorting();
    initElectionSwitcher();

    // Dynamically load elections to populate dropdown
    const electionsData = await loadJSON('data/meta/elections.json');
    if (electionsData && electionsData.elections) {
      DOM.electionSelect.innerHTML = electionsData.elections.map(e => 
        `<option value="${e.id}">${e.name}</option>`
      ).join('');
      currentElectionId = electionsData.elections[0].id;
    }

    await loadAndRender(currentElectionId);
  }

  document.addEventListener('DOMContentLoaded', () => {
    init();
  });

})();
