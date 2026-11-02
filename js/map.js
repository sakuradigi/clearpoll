/* ============================================
   ClearPoll 透析民調 — Interactive Taiwan Map & Party Statistics
   ============================================ */

const ClearPollMap = {
  svgLoaded: false,
  svgContent: null,
  svgPromise: null,

  /**
   * Preload SVG map immediately to eliminate network waterfall delays.
   */
  preloadSvg() {
    if (!this.svgPromise) {
      this.svgPromise = fetch('data/taiwan_counties.svg?v=20261022')
        .then(resp => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return resp.text();
        })
        .then(text => {
          this.svgContent = text;
          this.svgLoaded = true;
          return text;
        })
        .catch(err => {
          console.error('[ClearPollMap] Failed to load SVG map:', err);
          return null;
        });
    }
    return this.svgPromise;
  },

  /**
   * Immediately render base outline map so users see the map instantly on load.
   * @param {string} containerId - Container DOM ID
   */
  async renderPlaceholderMap(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!this.svgContent) {
      await this.preloadSvg();
    }
    if (this.svgContent && container && !container.querySelector('.taiwan-map-svg')) {
      container.innerHTML = this.svgContent;
      container.querySelectorAll('.taiwan-county-path').forEach(path => {
        path.style.fill = 'var(--color-bg-tertiary)';
        path.style.opacity = '0.55';
      });
    }
  },

  /**
   * Initialize and render the Taiwan Map with real ClearPoll model data.
   * @param {string} containerId - DOM container ID
   * @param {Array} electionsMeta - Array of election metadata
   * @param {Object} countyResults - Map of cityKey -> { election, result, leader, runner, margin, rating }
   * @param {Function} onCountyClick - Callback when a county is clicked
   */
  async renderMap(containerId, electionsMeta, countyResults = {}, onCountyClick) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!this.svgContent) {
      await this.preloadSvg();
    }
    if (!this.svgContent) {
      container.innerHTML = `<div class="card text-center" style="padding: 40px;">地圖載入失敗</div>`;
      return;
    }

    if (!container.querySelector('.taiwan-map-svg')) {
      container.innerHTML = this.svgContent;
    }

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

      // Remove native SVG <title> to prevent the browser's default tooltip from overlapping the custom tooltip
      const nativeTitle = path.querySelector('title');
      if (nativeTitle) {
        path.setAttribute('aria-label', nativeTitle.textContent);
        nativeTitle.remove();
      }

      // Hover events (skipped on touch-only devices to avoid a stuck tooltip after tapping)
      const canHover = () => window.matchMedia && window.matchMedia('(hover: hover)').matches;
      path.addEventListener('mouseenter', (e) => {
        if (!canHover()) return;
        path.classList.add('is-hovered');
        this.showTooltip(tooltip, data, e);
      });

      path.addEventListener('mousemove', (e) => {
        if (!canHover()) return;
        this.positionTooltip(tooltip, e);
      });

      path.addEventListener('mouseleave', () => {
        path.classList.remove('is-hovered');
        this.hideTooltip(tooltip);
      });

      // Click / tap event
      path.addEventListener('click', (e) => {
        e.preventDefault();
        path.classList.remove('is-hovered');
        this.hideTooltip(tooltip);
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

    // High-contrast badge palette tailored for dark tooltip background
    const darkBadgeStyles = {
      high: 'background: rgba(16, 185, 129, 0.22); color: #6EE7B7; border: 1px solid rgba(52, 211, 153, 0.45);',
      medium: 'background: rgba(245, 158, 11, 0.22); color: #FCD34D; border: 1px solid rgba(251, 191, 36, 0.45);',
      low: 'background: rgba(239, 68, 68, 0.22); color: #FCA5A5; border: 1px solid rgba(248, 113, 113, 0.45);',
      none: 'background: rgba(148, 163, 184, 0.2); color: #CBD5E1; border: 1px solid rgba(148, 163, 184, 0.35);'
    };
    const badgeStyle = darkBadgeStyles[rating.level] || darkBadgeStyles.medium;
    const ratingBadge = `<span style="display:inline-block; font-size: 0.72rem; font-weight: 700; padding: 2px 8px; border-radius: 999px; ${badgeStyle}">${rating.text}</span>`;
    const tossUpBadge = isTossUp && rating.text !== '五五波'
      ? `<span style="display:inline-block; background: rgba(239, 68, 68, 0.25); color: #FCA5A5; border: 1px solid rgba(248, 113, 113, 0.5); font-size: 0.7rem; font-weight: 700; margin-left: 5px; padding: 2px 7px; border-radius: 999px;">激戰區</span>`
      : '';

    // High-contrast candidate colors for dark slate (#0F172A) background
    const darkTextColors = {
      'KMT': '#60A5FA',
      'DPP': '#34D399',
      'TPP': '#22D3EE',
      'IND': '#C084FC',
      'OTHER': '#CBD5E1'
    };
    const darkBarColors = {
      'KMT': '#3B82F6',
      'DPP': '#10B981',
      'TPP': '#06B6D4',
      'IND': '#A855F7',
      'OTHER': '#94A3B8'
    };

    const candidates = election.candidates.map(c => {
      const share = result.predictedVoteShares[c.id] || 0;
      const rawProb = result.winProbabilities ? (result.winProbabilities[c.id] || 0) : 0;
      // Convert 0~1 probability to 0~100 percentage if needed
      const probPct = rawProb <= 1.0 && rawProb > 0 ? rawProb * 100 : rawProb;
      return { ...c, share, probPct };
    }).sort((a, b) => b.share - a.share);

    const rows = candidates.map(c => {
      const partyKey = (c.party || 'OTHER').toUpperCase();
      const textColor = darkTextColors[partyKey] || '#E2E8F0';
      const barColor = darkBarColors[partyKey] || c.color || '#60A5FA';
      return `
      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-top: 8px; font-size: 0.86rem; gap: 10px;">
        <span style="color: ${textColor}; font-weight: 700; display: inline-flex; align-items: center; gap: 6px;">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: ${barColor}; display: inline-block; flex-shrink: 0;"></span>
          ${c.name} <span style="font-size: 0.75rem; color: #CBD5E1; font-weight: 600;">(${c.party})</span>
        </span>
        <span style="font-weight: 800; color: #F8FAFC; font-variant-numeric: tabular-nums;">
          ${c.share.toFixed(1)}% <span style="font-size: 0.74rem; color: ${textColor}; font-weight: 600; margin-left: 2px;">(${c.probPct.toFixed(1)}%勝率)</span>
        </span>
      </div>
      <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.12); border-radius: 999px; overflow: hidden; margin-top: 4px;">
        <div style="width: ${c.share.toFixed(1)}%; height: 100%; background-color: ${barColor}; border-radius: 999px;"></div>
      </div>
    `;
    }).join('');

    tooltip.innerHTML = `
      <div style="padding: 12px 14px; min-width: 235px;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.14); padding-bottom: 8px; margin-bottom: 4px; gap: 8px;">
          <strong style="font-size: 1.02rem; color: #FFFFFF; letter-spacing: 0.02em;">${election.cityName}</strong>
          <div style="display: flex; align-items: center;">${ratingBadge}${tossUpBadge}</div>
        </div>
        ${rows}
        <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.1); font-size: 0.76rem; color: #CBD5E1; display: flex; justify-content: space-between; align-items: center;">
          <span>領先差距：<strong style="color: #FFFFFF;">${margin.toFixed(1)}%</strong></span>
          <span style="color: #93C5FD; font-weight: 600;">點擊查看卡片 ➔</span>
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
  // Automatically preload SVG map immediately
  ClearPollMap.preloadSvg();
}
