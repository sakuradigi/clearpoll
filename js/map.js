/* ============================================
   ClearPoll 透析民調 — Interactive Taiwan Map & Party Statistics
   ============================================ */

const ClearPollMap = {
  svgLoaded: false,
  svgContent: null,

  /**
   * Initialize and render the Taiwan Map with real ClearPoll model data.
   * @param {string} containerId - DOM container ID
   * @param {Array} electionsMeta - Array of election metadata
   * @param {Object} countyResults - Map of cityKey -> { election, result, leader, runner, margin, rating }
   * @param {Function} onCountyClick - Callback when a county is clicked
   */
  async renderMap(containerId, electionsMeta, countyResults, onCountyClick) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!this.svgContent) {
      try {
        const resp = await fetch('data/taiwan_counties.svg');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        this.svgContent = await resp.text();
      } catch (err) {
        console.error('[ClearPollMap] Failed to load SVG map:', err);
        container.innerHTML = `<div class="card text-center" style="padding: 40px;">地圖載入失敗</div>`;
        return;
      }
    }

    container.innerHTML = this.svgContent;

    // Get or create tooltip
    let tooltip = document.getElementById('clearPollMapTooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'clearPollMapTooltip';
      tooltip.className = 'taiwan-map-tooltip';
      document.body.appendChild(tooltip);
    }

    // Party color schemes
    const partyColorMap = {
      'KMT': '#2563EB',
      'DPP': '#10B981',
      'TPP': '#06B6D4',
      'IND': '#8B5CF6',
      'OTHER': '#6B7280'
    };

    // Style each county path
    const paths = container.querySelectorAll('.taiwan-county-path');
    paths.forEach(path => {
      const cityKey = path.dataset.city;
      const data = countyResults[cityKey];

      if (!data || !data.leader) {
        path.style.fill = 'var(--color-bg-tertiary)';
        path.style.opacity = '0.5';
        return;
      }

      const leaderParty = data.leader.party || 'OTHER';
      const baseColor = partyColorMap[leaderParty] || data.leader.color || '#64748B';
      const isTossUp = data.margin <= 3.5;

      path.style.fill = baseColor;
      path.setAttribute('data-leader', data.leader.name);
      path.setAttribute('data-party', leaderParty);
      if (isTossUp) {
        path.classList.add('is-tossup');
      }

      // Hover events
      path.addEventListener('mouseenter', (e) => {
        path.classList.add('is-hovered');
        this.showTooltip(tooltip, data, e);
      });

      path.addEventListener('mousemove', (e) => {
        this.positionTooltip(tooltip, e);
      });

      path.addEventListener('mouseleave', () => {
        path.classList.remove('is-hovered');
        this.hideTooltip(tooltip);
      });

      // Click event
      path.addEventListener('click', (e) => {
        e.preventDefault();
        if (onCountyClick) {
          onCountyClick(cityKey, data.election.id);
        }
      });
    });
  },

  /**
   * Show interactive tooltip.
   */
  showTooltip(tooltip, data, event) {
    const { election, result, leader, runner, margin, rating } = data;
    const isTossUp = margin <= 3.5;
    const ratingBadge = `<span class="win-opportunity-badge ${rating.level}" style="font-size: 0.72rem; padding: 2px 6px;">${rating.text}</span>`;
    const tossUpBadge = isTossUp ? `<span class="badge" style="background:#EF4444; color:#fff; font-size:0.7rem; margin-left:4px; padding:2px 6px; border-radius:4px;">激戰五五波</span>` : '';

    const candidates = election.candidates.map(c => {
      const share = result.predictedVoteShares[c.id] || 0;
      const prob = result.winProbabilities ? (result.winProbabilities[c.id] || 0) : 0;
      return { ...c, share, prob };
    }).sort((a, b) => b.share - a.share);

    const rows = candidates.map(c => `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px; font-size: 0.85rem;">
        <span style="color: ${c.color}; font-weight: 700;">${c.name} (${c.party})</span>
        <span style="font-weight: 800; color: ${c.color};">${c.share.toFixed(1)}% <span style="font-size:0.72rem; opacity:0.8;">(${c.prob.toFixed(0)}%勝率)</span></span>
      </div>
      <div style="width: 100%; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden; margin-top: 2px;">
        <div style="width: ${c.share.toFixed(1)}%; height: 100%; background-color: ${c.color};"></div>
      </div>
    `).join('');

    tooltip.innerHTML = `
      <div style="padding: 10px 12px; min-width: 200px;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.12); padding-bottom: 6px; margin-bottom: 6px;">
          <strong style="font-size: 1rem; color: #fff;">${election.cityName}</strong>
          <div>${ratingBadge}${tossUpBadge}</div>
        </div>
        ${rows}
        <div style="margin-top: 8px; font-size: 0.75rem; color: rgba(255,255,255,0.7); display: flex; justify-content: space-between;">
          <span>領先差距：${margin.toFixed(1)}%</span>
          <span style="color: #60A5FA;">點擊查看卡片 ➔</span>
        </div>
      </div>
    `;

    tooltip.style.display = 'block';
    this.positionTooltip(tooltip, event);
  },

  positionTooltip(tooltip, event) {
    const x = event.clientX + 16;
    const y = event.clientY + 16;
    const ttWidth = tooltip.offsetWidth || 220;
    const ttHeight = tooltip.offsetHeight || 150;

    let left = x;
    let top = y;

    if (x + ttWidth > window.innerWidth - 10) {
      left = event.clientX - ttWidth - 16;
    }
    if (y + ttHeight > window.innerHeight - 10) {
      top = event.clientY - ttHeight - 16;
    }

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  },

  hideTooltip(tooltip) {
    if (tooltip) {
      tooltip.style.display = 'none';
    }
  },

  /**
   * Render party summary statistics (similar to TPOC reference layout).
   * @param {string} containerId - Target container ID
   * @param {Object} countyResults - Computed results for 22 counties
   */
  renderPartyStatistics(containerId, countyResults) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let kmtCount = 0;
    let dppCount = 0;
    let indCount = 0;
    let tossUpCount = 0;

    const kmtCities = [];
    const dppCities = [];
    const indCities = [];
    const tossUpCities = [];

    Object.values(countyResults).forEach(item => {
      const party = item.leader.party;
      const cityName = item.election.cityName.replace('市', '').replace('縣', '');
      const isTossUp = item.margin <= 3.5;

      if (isTossUp) {
        tossUpCount++;
        tossUpCities.push(`${cityName}(+${item.margin.toFixed(1)}%)`);
      }

      if (party === 'KMT') {
        kmtCount++;
        kmtCities.push(cityName);
      } else if (party === 'DPP') {
        dppCount++;
        dppCities.push(cityName);
      } else {
        indCount++;
        indCities.push(cityName);
      }
    });

    const total = kmtCount + dppCount + indCount || 22;
    const kmtPercent = ((kmtCount / total) * 100).toFixed(1);
    const dppPercent = ((dppCount / total) * 100).toFixed(1);
    const indPercent = ((indCount / total) * 100).toFixed(1);

    container.innerHTML = `
      <div class="national-stats-card">
        <div class="stats-header">
          <h3 class="stats-title">
            <span style="font-size: 1.25rem;">🏛️</span> 全台 22 縣市席次模型預測版圖
          </h3>
          <span class="stats-subtitle">依據 ClearPoll 雙重加權與蒙地卡羅動態模擬</span>
        </div>

        <!-- Seats Share Bar -->
        <div class="seats-progress-bar">
          <div class="seats-segment kmt" style="width: ${kmtPercent}%;" title="國民黨: ${kmtCount}席 (${kmtPercent}%)">
            <span>國民黨 ${kmtCount}</span>
          </div>
          <div class="seats-segment dpp" style="width: ${dppPercent}%;" title="民進黨: ${dppCount}席 (${dppPercent}%)">
            <span>民進黨 ${dppCount}</span>
          </div>
          <div class="seats-segment ind" style="width: ${indPercent}%;" title="無黨／其他: ${indCount}席 (${indPercent}%)">
            <span>無黨/其他 ${indCount}</span>
          </div>
        </div>

        <!-- Party Cards Grid -->
        <div class="party-stats-grid">
          <!-- KMT Card -->
          <div class="party-stat-box kmt-box">
            <div class="party-stat-header">
              <div class="party-emblem kmt-emblem">藍</div>
              <div class="party-meta">
                <span class="party-name">中國國民黨</span>
                <span class="party-lead-tag">藍營領先</span>
              </div>
              <div class="party-seat-number">${kmtCount} <span class="unit">席</span></div>
            </div>
            <div class="party-counties-list">
              ${kmtCities.map(c => `<span class="county-chip kmt-chip">${c}</span>`).join('')}
            </div>
          </div>

          <!-- DPP Card -->
          <div class="party-stat-box dpp-box">
            <div class="party-stat-header">
              <div class="party-emblem dpp-emblem">綠</div>
              <div class="party-meta">
                <span class="party-name">民主進步黨</span>
                <span class="party-lead-tag">綠營領先</span>
              </div>
              <div class="party-seat-number">${dppCount} <span class="unit">席</span></div>
            </div>
            <div class="party-counties-list">
              ${dppCities.map(c => `<span class="county-chip dpp-chip">${c}</span>`).join('')}
            </div>
          </div>

          <!-- IND/TPP Card -->
          <div class="party-stat-box ind-box">
            <div class="party-stat-header">
              <div class="party-emblem ind-emblem">無</div>
              <div class="party-meta">
                <span class="party-name">無黨籍／民眾黨支持</span>
                <span class="party-lead-tag">非藍綠</span>
              </div>
              <div class="party-seat-number">${indCount} <span class="unit">席</span></div>
            </div>
            <div class="party-counties-list">
              ${indCities.map(c => `<span class="county-chip ind-chip">${c}</span>`).join('')}
            </div>
          </div>

          <!-- Toss-Up Card -->
          <div class="party-stat-box tossup-box">
            <div class="party-stat-header">
              <div class="party-emblem tossup-emblem">⚔️</div>
              <div class="party-meta">
                <span class="party-name">激烈拉鋸五五波</span>
                <span class="party-lead-tag" style="color:#EF4444; border-color:#EF4444;">差距 ≤ 3.5%</span>
              </div>
              <div class="party-seat-number" style="color: #EF4444;">${tossUpCount} <span class="unit">區</span></div>
            </div>
            <div class="party-counties-list">
              ${tossUpCities.map(c => `<span class="county-chip tossup-chip">${c}</span>`).join('')}
            </div>
          </div>
        </div>

        <div class="stats-footer-note">
          <span>💡 說明：點擊地圖任意縣市或下方卡片，可直接跳轉至各縣市深度民調與模型加權細項。</span>
        </div>
      </div>
    `;
  }
};

if (typeof window !== 'undefined') {
  window.ClearPollMap = ClearPollMap;
}
