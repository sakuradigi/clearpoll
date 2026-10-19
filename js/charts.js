/* ============================================
   ClearPoll 透析民調 — Chart Rendering
   ============================================ */

const ClearPollCharts = {

  /** Store chart instances for cleanup */
  _instances: {},

  /**
   * Destroy existing chart instance if it exists (prevents canvas reuse errors).
   * @param {string} canvasId
   */
  _destroyIfExists(canvasId) {
    if (this._instances[canvasId]) {
      this._instances[canvasId].destroy();
      delete this._instances[canvasId];
    }
  },

  /**
   * Common light-theme defaults for all charts.
   */
  _getDefaults() {
    return {
      fontFamily: "'Inter', 'Noto Sans TC', sans-serif",
      gridColor: 'rgba(0, 0, 0, 0.06)',
      tickColor: '#6B7280',
      bgColor: '#FFFFFF',
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
   * @param {Array} events - [{ date, label, category, color, description }]
   * @returns {Object} Chart.js plugin object
   */
  _createEventAnnotationPlugin(events = []) {
    return {
      id: 'clearPollEventAnnotations',
      afterDatasetsDraw(chart) {
        if (!events || events.length === 0) return;
        const { ctx, chartArea, scales } = chart;
        const xScale = scales.x;
        if (!xScale || !chartArea) return;

        ctx.save();
        events.forEach((ev, idx) => {
          const ts = new Date(ev.date).getTime();
          if (isNaN(ts)) return;
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

          // Staggered pill label at top of chart
          ctx.setLineDash([]);
          const text = ev.label || ev.date;
          ctx.font = "600 10.5px 'Inter', 'Noto Sans TC', sans-serif";
          const textWidth = ctx.measureText(text).width;
          const padX = 6;
          const pillW = textWidth + padX * 2;
          const pillH = 18;
          const rowOffset = (idx % 2) * 21;
          const pillY = chartArea.top + 6 + rowOffset;
          let pillX = clampedX - pillW / 2;
          if (pillX < chartArea.left + 2) pillX = chartArea.left + 2;
          if (pillX + pillW > chartArea.right - 2) pillX = chartArea.right - pillW - 2;

          // Pill background
          ctx.fillStyle = color;
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(pillX, pillY, pillW, pillH, 4);
          } else {
            ctx.rect(pillX, pillY, pillW, pillH);
          }
          ctx.fill();

          // Pill text
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
   */
  renderPollTrendChart(canvasId, polls, candidates, events = []) {
    this._destroyIfExists(canvasId);
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const defaults = this._getDefaults();

    // Sort polls by date
    const sortedPolls = [...polls].sort((a, b) => new Date(a.date) - new Date(b.date));

    // Compute x-axis bounds so upcoming events (e.g., 10/30 televised debate) are visible
    const allDates = [
      ...sortedPolls.map(p => p.date),
      ...(events || []).map(ev => ev.date)
    ].filter(Boolean).sort();
    const maxDateStr = allDates[allDates.length - 1];

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
        pointRadius: (ctx) => {
          // Size based on weight
          const w = ctx.raw?.weight ?? 0.5;
          return 3 + w * 6;
        },
        pointHoverRadius: 8,
        pointHoverBackgroundColor: candidate.color,
        order: 2,
      });

      // Trend line (moving average)
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

    this._instances[canvasId] = new Chart(ctx, {
      type: 'scatter',
      data: { datasets },
      plugins: [this._createEventAnnotationPlugin(events)],
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
              font: { family: defaults.fontFamily, size: 12 },
              color: defaults.tickColor,
              usePointStyle: true,
              pointStyle: 'circle',
              padding: 16,
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
            suggestedMax: maxDateStr,
            time: {
              unit: 'week',
              displayFormats: { week: 'MM/dd', month: 'yyyy/MM' },
              tooltipFormat: 'yyyy-MM-dd',
            },
            grid: { color: defaults.gridColor, drawBorder: false },
            ticks: {
              font: { family: defaults.fontFamily, size: 11 },
              color: defaults.tickColor,
              maxRotation: 0,
            },
            title: {
              display: true,
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
              font: { family: defaults.fontFamily, size: 11 },
              color: defaults.tickColor,
              callback: (val) => val + '%',
              stepSize: 10,
            },
            title: {
              display: true,
              text: '支持度 (%)',
              font: { family: defaults.fontFamily, size: 12, weight: '600' },
              color: defaults.tickColor,
            },
          },
        },
      },
    });
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
   */
  renderWinProbChart(canvasId, predictionLog, candidates, events = []) {
    this._destroyIfExists(canvasId);
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const defaults = this._getDefaults();
    const labels = predictionLog.map(p => p.date);
    const allDates = [
      ...labels,
      ...(events || []).map(ev => ev.date)
    ].filter(Boolean).sort();
    const maxDateStr = allDates[allDates.length - 1];

    const datasets = candidates.map(candidate => ({
      label: candidate.name,
      data: predictionLog.map(p => {
        const prob = p.winProbabilities[candidate.id];
        return prob !== undefined ? Math.round(prob * 1000) / 10 : null;
      }),
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

    this._instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      plugins: [this._createEventAnnotationPlugin(events)],
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
              font: { family: defaults.fontFamily, size: 12 },
              color: defaults.tickColor,
              usePointStyle: true,
              padding: 16,
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
            suggestedMax: maxDateStr,
            time: {
              unit: 'week',
              displayFormats: { week: 'MM/dd', month: 'yyyy/MM' },
            },
            grid: { color: defaults.gridColor, drawBorder: false },
            ticks: {
              font: { family: defaults.fontFamily, size: 11 },
              color: defaults.tickColor,
              maxRotation: 0,
            },
            title: {
              display: true,
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
              font: { family: defaults.fontFamily, size: 11 },
              color: defaults.tickColor,
              callback: (val) => val + '%',
              stepSize: 20,
            },
            title: {
              display: true,
              text: '勝選機率 (%)',
              font: { family: defaults.fontFamily, size: 12, weight: '600' },
              color: defaults.tickColor,
            },
          },
        },
      },
    });
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
              font: { family: defaults.fontFamily, size: 12 },
              color: defaults.tickColor,
              usePointStyle: true,
              padding: 16
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
  },

  /**
   * Destroy all chart instances.
   */
  destroyAll() {
    for (const key of Object.keys(this._instances)) {
      this._instances[key].destroy();
    }
    this._instances = {};
  },
};
