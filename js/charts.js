/* ============================================
   ClearPoll 透析民調 — Chart Rendering
   ============================================ */

const ClearPollCharts = {

  /** Store chart instances for cleanup */
  _instances: {},
  _dragCleanups: {},

  /**
   * Destroy existing chart instance if it exists (prevents canvas reuse errors).
   * @param {string} canvasId
   */
  _destroyIfExists(canvasId) {
    if (this._dragCleanups[canvasId]) {
      this._dragCleanups[canvasId]();
      delete this._dragCleanups[canvasId];
    }
    if (this._instances[canvasId]) {
      this._instances[canvasId].destroy();
      delete this._instances[canvasId];
    }
  },

  /**
   * Parse YYYY-MM-DD string as local midnight timestamp (avoids UTC drift).
   * @param {string} dateStr
   * @returns {number}
   */
  _parseLocalDateTs(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return NaN;
    const parts = dateStr.split('-').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) {
      return new Date(dateStr).getTime();
    }
    return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
  },

  /**
   * Format timestamp as YYYY-MM-DD in local calendar date.
   * @param {number} ts
   * @returns {string}
   */
  _formatLocalDate(ts) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  /**
   * Build adaptive Chart.js x-axis bounds and tick unit for optional zoom range.
   */
  _computeXAxisConfig(allDates, rangeOptions) {
    const valid = (allDates || []).filter(Boolean).sort();
    const fullMinStr = valid[0] || null;
    const fullMaxStr = valid[valid.length - 1] || null;
    const fullMinTs = fullMinStr ? this._parseLocalDateTs(fullMinStr) : NaN;
    const fullMaxTs = fullMaxStr ? this._parseLocalDateTs(fullMaxStr) : NaN;

    const hasCustom = Boolean(rangeOptions && rangeOptions.start && rangeOptions.end);
    let minTs = hasCustom ? this._parseLocalDateTs(rangeOptions.start) : fullMinTs;
    let maxTs = hasCustom ? this._parseLocalDateTs(rangeOptions.end) : fullMaxTs;
    if (Number.isNaN(minTs)) minTs = fullMinTs;
    if (Number.isNaN(maxTs)) maxTs = fullMaxTs;
    if (!Number.isNaN(minTs) && !Number.isNaN(maxTs) && minTs > maxTs) {
      [minTs, maxTs] = [maxTs, minTs];
    }

    const DAY_MS = 86400000;
    const spanDays = (!Number.isNaN(minTs) && !Number.isNaN(maxTs))
      ? Math.max(1, (maxTs - minTs) / DAY_MS)
      : 60;
    const padMs = hasCustom ? Math.max(DAY_MS * 0.5, spanDays * DAY_MS * 0.025) : DAY_MS * 0.5;
    const unit = spanDays <= 21 ? 'day' : spanDays <= 140 ? 'week' : 'month';

    return {
      fullMinStr,
      fullMaxStr,
      xScale: {
        min: hasCustom && !Number.isNaN(minTs) ? minTs - padMs : undefined,
        max: hasCustom && !Number.isNaN(maxTs) ? maxTs + padMs : undefined,
        suggestedMax: !hasCustom && !Number.isNaN(fullMaxTs) ? fullMaxTs + DAY_MS : undefined,
        unit,
        displayFormats: { day: 'MM/dd', week: 'MM/dd', month: 'yyyy/MM' },
      },
    };
  },

  /**
   * Inline plugin drawing live horizontal drag-zoom selection band.
   */
  _createDragSelectPlugin(dragState) {
    return {
      id: 'clearPollDragSelect',
      afterDraw: (chart) => {
        if (!dragState.active || Math.abs(dragState.currentX - dragState.startX) < 12) return;
        const { ctx, chartArea, scales } = chart;
        const xScale = scales.x;
        if (!chartArea || !xScale) return;

        const left = Math.max(chartArea.left, Math.min(dragState.startX, dragState.currentX));
        const right = Math.min(chartArea.right, Math.max(dragState.startX, dragState.currentX));
        if (right - left < 8) return;

        ctx.save();
        ctx.fillStyle = 'rgba(37, 99, 235, 0.14)';
        ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);

        ctx.strokeStyle = '#2563EB';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(left, chartArea.top);
        ctx.lineTo(left, chartArea.bottom);
        ctx.moveTo(right, chartArea.top);
        ctx.lineTo(right, chartArea.bottom);
        ctx.stroke();

        // Preview selected date span label at top-center of box
        const startTs = xScale.getValueForPixel(left);
        const endTs = xScale.getValueForPixel(right);
        if (Number.isFinite(startTs) && Number.isFinite(endTs)) {
          const label = `${this._formatLocalDate(startTs).slice(5).replace('-', '/')} ～ ${this._formatLocalDate(endTs).slice(5).replace('-', '/')}`;
          ctx.setLineDash([]);
          ctx.font = "600 11px 'Inter', 'Noto Sans TC', sans-serif";
          const tw = ctx.measureText(label).width;
          const bw = tw + 12;
          const bh = 20;
          const bx = Math.min(Math.max((left + right) / 2 - bw / 2, chartArea.left + 2), chartArea.right - bw - 2);
          const by = chartArea.top + 6;
          ctx.fillStyle = '#1D4ED8';
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') ctx.roundRect(bx, by, bw, bh, 4);
          else ctx.rect(bx, by, bw, bh);
          ctx.fill();
          ctx.fillStyle = '#FFFFFF';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, bx + bw / 2, by + bh / 2 + 0.5);
        }
        ctx.restore();
      }
    };
  },

  /**
   * Attach desktop mouse drag-to-zoom + double-click reset onto a chart canvas.
   */
  _attachDragZoom(canvasId, canvasEl, dragState, rangeOptions) {
    if (!canvasEl || !rangeOptions || typeof rangeOptions.onRangeSelect !== 'function') return;
    canvasEl.classList.add('is-zoom-draggable');

    let rafPending = false;
    const requestRedraw = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        const inst = this._instances[canvasId];
        if (inst) inst.draw();
      });
    };

    const getCanvasX = (evt) => {
      const rect = canvasEl.getBoundingClientRect();
      return evt.clientX - rect.left;
    };

    const onPointerDown = (evt) => {
      if (evt.pointerType !== 'mouse' || evt.button !== 0) return;
      const chart = this._instances[canvasId];
      if (!chart || !chart.chartArea) return;
      const x = getCanvasX(evt);
      const rect = canvasEl.getBoundingClientRect();
      const y = evt.clientY - rect.top;
      const { left, right, top, bottom } = chart.chartArea;
      if (x < left || x > right || y < top || y > bottom) return;

      dragState.active = true;
      dragState.startX = x;
      dragState.currentX = x;
      if (typeof canvasEl.setPointerCapture === 'function') {
        try { canvasEl.setPointerCapture(evt.pointerId); } catch (_) { /* noop */ }
      }
    };

    const onPointerMove = (evt) => {
      if (!dragState.active) return;
      const chart = this._instances[canvasId];
      if (!chart || !chart.chartArea) return;
      const { left, right } = chart.chartArea;
      dragState.currentX = Math.min(Math.max(getCanvasX(evt), left), right);
      requestRedraw();
    };

    const finishDrag = () => {
      if (!dragState.active) return;
      const chart = this._instances[canvasId];
      const delta = Math.abs(dragState.currentX - dragState.startX);
      const leftPx = Math.min(dragState.startX, dragState.currentX);
      const rightPx = Math.max(dragState.startX, dragState.currentX);
      dragState.active = false;

      if (chart && delta >= 14 && chart.scales?.x) {
        let startTs = chart.scales.x.getValueForPixel(leftPx);
        let endTs = chart.scales.x.getValueForPixel(rightPx);
        if (Number.isFinite(startTs) && Number.isFinite(endTs)) {
          const DAY_MS = 86400000;
          if (endTs - startTs < DAY_MS * 2) {
            const mid = (startTs + endTs) / 2;
            startTs = mid - DAY_MS;
            endTs = mid + DAY_MS;
          }
          const start = this._formatLocalDate(startTs);
          const end = this._formatLocalDate(endTs);
          rangeOptions.onRangeSelect({ start, end });
          return;
        }
      }
      if (chart) chart.draw();
    };

    const onDblClick = () => {
      if (typeof rangeOptions.onRangeReset === 'function') {
        rangeOptions.onRangeReset();
      }
    };

    canvasEl.addEventListener('pointerdown', onPointerDown);
    canvasEl.addEventListener('pointermove', onPointerMove);
    canvasEl.addEventListener('pointerup', finishDrag);
    canvasEl.addEventListener('pointercancel', finishDrag);
    canvasEl.addEventListener('dblclick', onDblClick);

    this._dragCleanups[canvasId] = () => {
      canvasEl.classList.remove('is-zoom-draggable');
      canvasEl.removeEventListener('pointerdown', onPointerDown);
      canvasEl.removeEventListener('pointermove', onPointerMove);
      canvasEl.removeEventListener('pointerup', finishDrag);
      canvasEl.removeEventListener('pointercancel', finishDrag);
      canvasEl.removeEventListener('dblclick', onDblClick);
    };
  },

  /**
   * Responsive helper: true on phone-sized viewports.
   */
  _isMobile() {
    return typeof window !== 'undefined' && window.innerWidth < 640;
  },

  /**
   * Common light-theme defaults for all charts.
   */
  _getDefaults() {
    const mobile = this._isMobile();
    return {
      fontFamily: "'Inter', 'Noto Sans TC', sans-serif",
      gridColor: 'rgba(0, 0, 0, 0.06)',
      tickColor: '#6B7280',
      bgColor: '#FFFFFF',
      mobile,
      legendFont: mobile ? 11 : 12,
      legendPadding: mobile ? 10 : 16,
      tickFont: mobile ? 10 : 11,
      showAxisTitle: !mobile,
      maxXTicks: mobile ? 5 : 12,
    };
  },

  /**
   * Build a color -> rgba string with custom alpha.
   */
  _alpha(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  },

  /**
   * Create a lightweight inline Chart.js plugin that renders vertical campaign/debate event markers.
   * Uses horizontal collision avoidance (up to 4 rows) so zoomed-in event pills do not overlap.
   * @param {Array} events - [{ date, label, category, color, description }]
   * @returns {Object} Chart.js plugin object
   */
  _createEventAnnotationPlugin(events = []) {
    const parseLocalTs = this._parseLocalDateTs.bind(this);
    return {
      id: 'clearPollEventAnnotations',
      afterDatasetsDraw(chart) {
        if (!events || events.length === 0) return;
        const { ctx, chartArea, scales } = chart;
        const xScale = scales.x;
        if (!xScale || !chartArea) return;
        const isCompact = chart.width < 560;
        const minScale = xScale.min ?? -Infinity;
        const maxScale = xScale.max ?? Infinity;
        const TOL = 43200000; // 12h tolerance around boundaries

        const visibleEvents = events
          .map((ev, origIdx) => ({ ev, origIdx, ts: parseLocalTs(ev.date) }))
          .filter(item => !Number.isNaN(item.ts) && item.ts >= minScale - TOL && item.ts <= maxScale + TOL)
          .sort((a, b) => a.ts - b.ts);

        if (visibleEvents.length === 0) return;

        ctx.save();
        const rowRightEdges = [-Infinity, -Infinity, -Infinity, -Infinity];
        const compactRowEdges = [-Infinity, -Infinity, -Infinity];

        visibleEvents.forEach(({ ev, origIdx, ts }) => {
          const x = xScale.getPixelForValue(ts);
          if (x == null || x < chartArea.left - 4 || x > chartArea.right + 4) return;

          const clampedX = Math.min(Math.max(x, chartArea.left + 2), chartArea.right - 2);
          const color = ev.color || '#6366F1';

          // Vertical dashed event line
          ctx.beginPath();
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = color;
          ctx.moveTo(clampedX, chartArea.top + 4);
          ctx.lineTo(clampedX, chartArea.bottom);
          ctx.stroke();
          ctx.setLineDash([]);

          const drawNumberCircle = (cy) => {
            const r = 8;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(clampedX, cy, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#FFFFFF';
            ctx.font = "700 10px 'Inter', 'Noto Sans TC', sans-serif";
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(origIdx + 1), clampedX, cy + 0.5);
          };

          if (isCompact) {
            let row = compactRowEdges.findIndex(edge => clampedX - 10 >= edge);
            if (row === -1) row = origIdx % 3;
            compactRowEdges[row] = Math.max(compactRowEdges[row], clampedX + 10);
            drawNumberCircle(chartArea.top + 10 + row * 18);
            return;
          }

          const text = ev.label || ev.date;
          ctx.font = "600 10px 'Inter', 'Noto Sans TC', sans-serif";
          const textWidth = ctx.measureText(text).width;
          const padX = 6;
          const pillW = textWidth + padX * 2;
          const pillH = 17;

          let pillX = clampedX - pillW / 2;
          if (pillX < chartArea.left + 2) pillX = chartArea.left + 2;
          if (pillX + pillW > chartArea.right - 2) pillX = chartArea.right - pillW - 2;

          // Pick the first row where this pill clears the previous pill horizontally
          const freeRow = rowRightEdges.findIndex(edge => pillX >= edge + 4);
          if (freeRow === -1) {
            // Fallback to compact numbered circle if all 4 rows are saturated at the same day
            drawNumberCircle(chartArea.top + 12 + 4 * 20);
            return;
          }

          rowRightEdges[freeRow] = pillX + pillW;
          const pillY = chartArea.top + 6 + freeRow * 20;

          ctx.fillStyle = color;
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(pillX, pillY, pillW, pillH, 4);
          } else {
            ctx.rect(pillX, pillY, pillW, pillH);
          }
          ctx.fill();

          ctx.fillStyle = '#FFFFFF';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, pillX + pillW / 2, pillY + pillH / 2 + 0.5);
        });
        ctx.restore();
      }
    };
  },

  /**
   * Render poll trend scatter chart — shows individual poll results over time
   * with a moving average trend line overlay and campaign event annotations.
   * @param {string} canvasId - Canvas element ID
   * @param {Array} polls - Weighted polls array (from model)
   * @param {Array} candidates - Candidate objects with id, name, color
   * @param {Array} events - Campaign & debate milestone objects
   * @param {Object|null} rangeOptions - { start, end, onRangeSelect, onRangeReset }
   */
  renderPollTrendChart(canvasId, polls, candidates, events = [], rangeOptions = null) {
    this._destroyIfExists(canvasId);
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const defaults = this._getDefaults();

    // Sort polls by date
    const sortedPolls = [...polls].sort((a, b) => new Date(a.date) - new Date(b.date));

    // Compute x-axis bounds & optional zoom window
    const allDates = [
      ...sortedPolls.map(p => p.date),
      ...(events || []).map(ev => ev.date)
    ];
    const axisCfg = this._computeXAxisConfig(allDates, rangeOptions);
    const dragState = { active: false, startX: 0, currentX: 0 };

    // Create datasets — one scatter set + one trend line per candidate
    const datasets = [];

    for (const candidate of candidates) {
      // Scatter points (individual polls)
      const scatterData = sortedPolls.map(p => ({
        x: p.date,
        y: p.projectedVoteShare?.[candidate.id] ?? p.results[candidate.id] ?? null,
        pollster: p.pollsterName,
        sampleSize: p.sampleSize,
        weight: p.weights?.combined ?? 0,
      })).filter(d => d.y !== null);

      datasets.push({
        label: candidate.name,
        data: scatterData,
        type: 'scatter',
        backgroundColor: this._alpha(candidate.color, 0.5),
        borderColor: candidate.color,
        borderWidth: 1.5,
        pointRadius: (c) => {
          const w = c.raw?.weight ?? 0.15;
          return 3.5 + Math.min(w, 0.45) * 14;
        },
        pointHoverRadius: 8,
        pointHoverBackgroundColor: candidate.color,
        order: 2,
      });

      // Trend line (moving average computed on full series so window start stays accurate)
      const trendData = this._calcMovingAverage(scatterData, 3);
      datasets.push({
        label: `${candidate.name} 趨勢`,
        data: trendData,
        type: 'line',
        borderColor: candidate.color,
        backgroundColor: 'transparent',
        borderWidth: 2.5,
        borderDash: [],
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0.4,
        order: 1,
      });
    }

    const chart = new Chart(ctx, {
      type: 'scatter',
      data: { datasets },
      plugins: [this._createEventAnnotationPlugin(events), this._createDragSelectPlugin(dragState)],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'nearest',
          intersect: true,
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: {
              font: { family: defaults.fontFamily, size: defaults.legendFont },
              color: defaults.tickColor,
              usePointStyle: true,
              pointStyle: 'circle',
              padding: defaults.legendPadding,
              filter: (item) => !item.text.includes('趨勢'),
            },
          },
          tooltip: {
            backgroundColor: 'rgba(255, 255, 255, 0.95)',
            titleColor: '#1A1A2E',
            bodyColor: '#6B7280',
            borderColor: '#E5E7EB',
            borderWidth: 1,
            cornerRadius: 8,
            padding: 12,
            titleFont: { family: defaults.fontFamily, weight: '600', size: 13 },
            bodyFont: { family: defaults.fontFamily, size: 12 },
            callbacks: {
              title: (items) => {
                const raw = items[0]?.raw;
                if (!raw) return '';
                return `${raw.x}`;
              },
              label: (item) => {
                const raw = item.raw;
                const lines = [`${item.dataset.label}: ${raw.y?.toFixed(1)}%`];
                if (raw.pollster) lines.push(`民調機構: ${raw.pollster}`);
                if (raw.sampleSize) lines.push(`樣本數: ${raw.sampleSize}`);
                if (raw.weight) lines.push(`權重: ${(raw.weight * 100).toFixed(0)}%`);
                return lines;
              },
            },
          },
        },
        scales: {
          x: {
            type: 'time',
            min: axisCfg.xScale.min,
            max: axisCfg.xScale.max,
            suggestedMax: axisCfg.xScale.suggestedMax,
            time: {
              unit: axisCfg.xScale.unit,
              displayFormats: axisCfg.xScale.displayFormats,
              tooltipFormat: 'yyyy-MM-dd',
            },
            grid: { color: defaults.gridColor, drawBorder: false },
            ticks: {
              font: { family: defaults.fontFamily, size: defaults.tickFont },
              color: defaults.tickColor,
              maxRotation: 0,
              maxTicksLimit: defaults.maxXTicks,
              autoSkip: true,
            },
            title: {
              display: defaults.showAxisTitle,
              text: '日期',
              font: { family: defaults.fontFamily, size: 12, weight: '600' },
              color: defaults.tickColor,
            },
          },
          y: {
            beginAtZero: true,
            max: 100,
            grid: { color: defaults.gridColor, drawBorder: false },
            ticks: {
              font: { family: defaults.fontFamily, size: defaults.tickFont },
              color: defaults.tickColor,
              callback: (val) => val + '%',
              stepSize: 10,
            },
            title: {
              display: defaults.showAxisTitle,
              text: '支持度 (%)',
              font: { family: defaults.fontFamily, size: 12, weight: '600' },
              color: defaults.tickColor,
            },
          },
        },
      },
    });

    this._instances[canvasId] = chart;
    this._attachDragZoom(canvasId, ctx, dragState, rangeOptions);
  },

  /**
   * Calculate simple moving average for trend line.
   * @param {Array} data - [{x, y}, ...]
   * @param {number} window - Window size
   * @returns {Array} smoothed data points
   */
  _calcMovingAverage(data, window) {
    if (data.length <= window) return data.map(d => ({ x: d.x, y: d.y }));

    const result = [];
    for (let i = 0; i < data.length; i++) {
      const start = Math.max(0, i - Math.floor(window / 2));
      const end = Math.min(data.length, i + Math.ceil(window / 2));
      const slice = data.slice(start, end);
      const avg = slice.reduce((sum, d) => sum + d.y, 0) / slice.length;
      result.push({ x: data[i].x, y: Math.round(avg * 10) / 10 });
    }
    return result;
  },

  /**
   * Render win probability trend chart — line chart showing how
   * win probability changed over time as polls came in.
   * @param {string} canvasId - Canvas element ID
   * @param {Array} predictionLog - Array of prediction snapshots
   * @param {Array} candidates - Candidate objects
   * @param {Array} events - Campaign & debate milestone objects
   * @param {Object|null} rangeOptions - { start, end, onRangeSelect, onRangeReset }
   */
  renderWinProbChart(canvasId, predictionLog, candidates, events = [], rangeOptions = null) {
    this._destroyIfExists(canvasId);
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const defaults = this._getDefaults();
    const sortedLog = [...predictionLog].sort((a, b) => new Date(a.date) - new Date(b.date));
    const allDates = [
      ...sortedLog.map(p => p.date),
      ...(events || []).map(ev => ev.date)
    ];
    const axisCfg = this._computeXAxisConfig(allDates, rangeOptions);
    const dragState = { active: false, startX: 0, currentX: 0 };

    const datasets = candidates.map(candidate => ({
      label: candidate.name,
      data: sortedLog.map(p => {
        const prob = p.winProbabilities[candidate.id];
        return prob !== undefined ? { x: p.date, y: Math.round(prob * 1000) / 10 } : null;
      }).filter(Boolean),
      borderColor: candidate.color,
      backgroundColor: this._alpha(candidate.color, 0.08),
      borderWidth: 2.5,
      fill: true,
      tension: 0.35,
      pointRadius: 3,
      pointBackgroundColor: '#FFFFFF',
      pointBorderColor: candidate.color,
      pointBorderWidth: 2,
      pointHoverRadius: 6,
      pointHoverBackgroundColor: candidate.color,
    }));

    const chart = new Chart(ctx, {
      type: 'line',
      data: { datasets },
      plugins: [this._createEventAnnotationPlugin(events), this._createDragSelectPlugin(dragState)],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: {
              font: { family: defaults.fontFamily, size: defaults.legendFont },
              color: defaults.tickColor,
              usePointStyle: true,
              padding: defaults.legendPadding,
            },
          },
          tooltip: {
            backgroundColor: 'rgba(255, 255, 255, 0.95)',
            titleColor: '#1A1A2E',
            bodyColor: '#6B7280',
            borderColor: '#E5E7EB',
            borderWidth: 1,
            cornerRadius: 8,
            padding: 12,
            titleFont: { family: defaults.fontFamily, weight: '600', size: 13 },
            bodyFont: { family: defaults.fontFamily, size: 12 },
            callbacks: {
              label: (item) => `${item.dataset.label}: ${item.parsed.y?.toFixed(1)}%`,
            },
          },
        },
        scales: {
          x: {
            type: 'time',
            min: axisCfg.xScale.min,
            max: axisCfg.xScale.max,
            suggestedMax: axisCfg.xScale.suggestedMax,
            time: {
              unit: axisCfg.xScale.unit,
              displayFormats: axisCfg.xScale.displayFormats,
              tooltipFormat: 'yyyy-MM-dd',
            },
            grid: { color: defaults.gridColor, drawBorder: false },
            ticks: {
              font: { family: defaults.fontFamily, size: defaults.tickFont },
              color: defaults.tickColor,
              maxRotation: 0,
              maxTicksLimit: defaults.maxXTicks,
              autoSkip: true,
            },
            title: {
              display: defaults.showAxisTitle,
              text: '日期',
              font: { family: defaults.fontFamily, size: 12, weight: '600' },
              color: defaults.tickColor,
            },
          },
          y: {
            min: 0,
            max: 100,
            grid: { color: defaults.gridColor, drawBorder: false },
            ticks: {
              font: { family: defaults.fontFamily, size: defaults.tickFont },
              color: defaults.tickColor,
              callback: (val) => val + '%',
              stepSize: 20,
            },
            title: {
              display: defaults.showAxisTitle,
              text: '勝選機率 (%)',
              font: { family: defaults.fontFamily, size: 12, weight: '600' },
              color: defaults.tickColor,
            },
          },
        },
      },
    });

    this._instances[canvasId] = chart;
    this._attachDragZoom(canvasId, ctx, dragState, rangeOptions);
  },

  /**
   * Render horizontal bar chart of predicted vote shares.
   * @param {string} canvasId - Canvas element ID
   * @param {Object} voteShares - { candidateId: voteShare% }
   * @param {Array} candidates - Candidate objects
   */
  renderVoteShareBar(canvasId, voteShares, candidates) {
    this._destroyIfExists(canvasId);
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const defaults = this._getDefaults();

    // Build labels and data, including "others" if present
    const labels = [];
    const data = [];
    const bgColors = [];
    const borderColors = [];

    for (const candidate of candidates) {
      labels.push(candidate.name);
      data.push(voteShares[candidate.id] || 0);
      bgColors.push(this._alpha(candidate.color, 0.85));
      borderColors.push(candidate.color);
    }

    // Add "Others" if present
    if (voteShares.others) {
      labels.push('其他');
      data.push(voteShares.others);
      bgColors.push('rgba(156, 163, 175, 0.7)');
      borderColors.push('#9CA3AF');
    }

    this._instances[canvasId] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: bgColors,
          borderColor: borderColors,
          borderWidth: 1.5,
          hoverOffset: 8
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%', // Sleek modern donut cutout
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: {
              font: { family: defaults.fontFamily, size: defaults.legendFont },
              color: defaults.tickColor,
              usePointStyle: true,
              padding: defaults.legendPadding
            }
          },
          tooltip: {
            backgroundColor: 'rgba(255, 255, 255, 0.95)',
            titleColor: '#1A1A2E',
            bodyColor: '#6B7280',
            borderColor: '#E5E7EB',
            borderWidth: 1,
            cornerRadius: 8,
            padding: 12,
            titleFont: { family: defaults.fontFamily, weight: '600' },
            bodyFont: { family: defaults.fontFamily },
            callbacks: {
              label: (item) => ` 預測得票率: ${item.parsed.toFixed(1)}%`,
            },
          },
        },
      },
    });

    this._instances[canvasId] = chart;
    this._attachDragZoom(canvasId, ctx, dragState, rangeOptions);
  },

  /**
   * Destroy all chart instances.
   */
  destroyAll() {
    for (const key of Object.keys(this._dragCleanups)) {
      this._dragCleanups[key]();
    }
    this._dragCleanups = {};
    for (const key of Object.keys(this._instances)) {
      this._instances[key].destroy();
    }
    this._instances = {};
  },
};
