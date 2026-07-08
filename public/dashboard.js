'use strict';

const API = '';
let loadedTables    = {};
let allCharts       = [];    // echarts instances for resize
let chartRegistry   = {};    // chartId -> echarts instance
let chartMetaById   = {};    // chartId -> conversion state and source option
let pendingCharts   = [];    // {id, option} waiting for their section to become visible
let sidebarOpen     = true;
let sourceModalState = { chartId: '', activeTab: 'sql' };

const CHART_TYPE_SEQUENCE = ['auto', 'bar', 'hbar', 'line', 'area', 'donut', 'rose', 'scatter'];
const CHART_PREFS_KEY = 'convbi_chart_type_prefs_v1';

function _canonicalChartType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'pie') return 'donut';
  return t;
}

function _chartTypeLabel(type) {
  return ({
    auto: 'Default',
    bar: 'Bar',
    hbar: 'Horizontal Bar',
    line: 'Line',
    area: 'Area',
    donut: 'Donut',
    rose: 'Rose Donut',
    scatter: 'Scatter'
  })[type] || 'Default';
}

function _builderNameForType(type) {
  return ({
    auto: 'auto-selected',
    bar: 'buildBarOption',
    hbar: 'buildHorizontalBarOption',
    line: 'buildLineOption',
    area: 'buildAreaOption',
    donut: 'buildDonutOption',
    rose: 'buildRoseOption',
    scatter: 'buildScatterOption'
  })[type] || 'unknown-builder';
}

function _availableChartTypes(originalType) {
  const defaultType = _canonicalChartType(originalType);
  return CHART_TYPE_SEQUENCE.filter(t => t === 'auto' || t !== defaultType);
}

let workflowState = {
  step1: false,
  step2: false,
  step3: false,
  step4: false,
  step5: false
};

// ── Section navigation ────────────────────────────────────────────────────────
function showSection(name) {
  document.querySelectorAll('.db-section').forEach(s => s.classList.remove('active'));
  document.getElementById('section-' + name)?.classList.add('active');
  document.querySelectorAll('.db-nav-item').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === '#' + name);
  });
  document.getElementById('breadcrumb').textContent =
    { overview: 'Overview', charts: 'Charts', tables: 'Data Tables', insights: 'Saved Insights' }[name] || name;

  // Initialize any charts that were deferred because their section was hidden
  setTimeout(() => {
    const stillPending = [];
    pendingCharts.forEach(({ id, option }) => {
      if (!tryInitChart(id, option)) stillPending.push({ id, option });
    });
    pendingCharts = stillPending;
    // Also resize already-initialized charts (handles layout reflows)
    allCharts.forEach(c => { try { c.resize(); } catch (_) {} });
  }, 60);
}

// Normalize any ECharts option to the light palette before rendering
function _normalizeOption(option) {
  // Deep-clone to avoid mutating the source
  const opt = JSON.parse(JSON.stringify(option));

  const formatTwoDecimals = value => {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'number') return Number.isFinite(value) ? value.toFixed(2) : String(value);
    const n = Number(value);
    if (Number.isFinite(n) && String(value).trim() !== '') return n.toFixed(2);
    return String(value);
  };

  // Strip built-in title/subtext — the card HTML header already shows them
  delete opt.title;

  // Light axis overrides
  const lightLine  = { lineStyle: { color: '#E5E7EB' } };
  const lightSplit = { lineStyle: { color: '#F3F4F6' } };
  const lightLabel = { color: '#6B7280', fontSize: 11 };
  const applyAxis = ax => {
    if (!ax) return ax;
    ax.axisLine  = lightLine;
    ax.splitLine = lightSplit;
    ax.axisLabel = { ...lightLabel, ...(ax.axisLabel || {}), color: '#6B7280' };
    if ((ax.type === 'value' || ax.type === 'log') && !ax.axisLabel.formatter) {
      ax.axisLabel.formatter = v => formatTwoDecimals(v);
    }
    return ax;
  };
  if (opt.xAxis) opt.xAxis = Array.isArray(opt.xAxis) ? opt.xAxis.map(applyAxis) : applyAxis(opt.xAxis);
  if (opt.yAxis) opt.yAxis = Array.isArray(opt.yAxis) ? opt.yAxis.map(applyAxis) : applyAxis(opt.yAxis);

  // Light tooltip
  if (opt.tooltip) {
    opt.tooltip.backgroundColor = '#FFFFFF';
    opt.tooltip.borderColor     = '#E5E7EB';
    opt.tooltip.textStyle       = { color: '#111827', fontSize: 12 };
    if (!opt.tooltip.valueFormatter) {
      opt.tooltip.valueFormatter = value => formatTwoDecimals(value);
    }
  }

  // Light legend
  if (opt.legend) opt.legend.textStyle = { color: '#4B5563' };

  // containLabel so labels never clip
  if (opt.grid) {
    opt.grid.containLabel = true;
    opt.grid.top    = opt.grid.top    ?? 16;
    opt.grid.bottom = opt.grid.bottom ?? 48;
    opt.grid.left   = opt.grid.left   ?? 16;
    opt.grid.right  = opt.grid.right  ?? 16;
  }

  // Palette swap for series
  const OLD_DARK = ['#58A6FF','#3FB950','#D29922','#F85149','#BC8CFF','#79C0FF'];
  (opt.series || []).forEach((s, i) => {
    // Swap old-palette solid colors
    if (s.itemStyle?.color && typeof s.itemStyle.color === 'string' && OLD_DARK.includes(s.itemStyle.color)) {
      s.itemStyle.color = DARK_COLORS[OLD_DARK.indexOf(s.itemStyle.color) % DARK_COLORS.length];
    }
    // Swap old-palette linear gradient (bar charts)
    if (s.itemStyle?.color?.colorStops) {
      s.itemStyle.color = { type:'linear', x:0,y:0,x2:0,y2:1,
        colorStops:[{offset:0,color:'#9d71d9'},{offset:1,color:'#6F42C1'}] };
    }
    // Swap old-palette line colors
    if (s.lineStyle?.color && OLD_DARK.includes(s.lineStyle.color)) {
      s.lineStyle.color = DARK_COLORS[i % DARK_COLORS.length];
    }
    if (s.areaStyle?.color && OLD_DARK.includes(s.areaStyle.color)) {
      s.areaStyle.color = DARK_COLORS[i % DARK_COLORS.length];
    }
    // Fix pie slice colors
    if (s.type === 'pie' && s.data) {
      s.data.forEach((d, di) => {
        if (d.itemStyle?.color && OLD_DARK.includes(d.itemStyle.color)) {
          d.itemStyle.color = DARK_COLORS[di % DARK_COLORS.length];
        }
      });
      if (s.label?.color === '#8B949E') s.label.color = '#6B7280';
      if (s.labelLine?.lineStyle?.color === '#30363D') s.labelLine.lineStyle.color = '#E5E7EB';
    }
    // Fix axis labels
    if (s.label?.color === '#8B949E') s.label.color = '#6B7280';

    // Standardize visible numeric data labels to 2 decimals
    if (s.label?.show && !s.label.formatter) {
      s.label.formatter = params => {
        const val = params?.value;
        if (Array.isArray(val)) {
          const last = val[val.length - 1];
          return formatTwoDecimals(last);
        }
        if (val && typeof val === 'object' && val.value !== undefined) return formatTwoDecimals(val.value);
        return formatTwoDecimals(val);
      };
    }
  });

  return opt;
}

// Try to initialize a chart — returns true if succeeded (element visible)
function tryInitChart(id, option) {
  const el = document.getElementById(id);
  if (!el || typeof echarts === 'undefined') return false;
  if (el.offsetWidth === 0) return false;  // still hidden
  if (el._chartInited) return true;
  const chart = echarts.init(el);
  chart.setOption({ ..._normalizeOption(option), backgroundColor: 'transparent' });
  allCharts.push(chart);
  chartRegistry[id] = chart;
  el._chartInited = true;
  return true;
}

function exportChartImage(chartId, title) {
  const el = document.getElementById(chartId);
  if (!el || typeof echarts === 'undefined') {
    alert('Chart is not available for export yet.');
    return;
  }

  const chart = chartRegistry[chartId] || echarts.getInstanceByDom(el);
  if (!chart) {
    alert('Chart is still loading. Open this section and try again.');
    return;
  }

  try {
    const card = el.closest('.db-chart-card');
    if (!card) {
      alert('Chart card container is missing.');
      return;
    }

    const titleEl = card.querySelector('.db-chart-card-title');
    const subEl = card.querySelector('.db-chart-card-sub');
    const summaryEl = card.querySelector('.db-chart-summary');

    const titleText = String(titleEl?.textContent || title || 'Chart').trim();
    const subText = String(subEl?.textContent || '').trim();
    const summaryText = String(summaryEl?.textContent || '').trim();

    const chartUrl = chart.getDataURL({
      type: 'png',
      pixelRatio: 2,
      backgroundColor: '#FFFFFF'
    });

    const cardRect = card.getBoundingClientRect();
    const chartRect = el.getBoundingClientRect();
    const chartOffsetTop = Math.max(0, chartRect.top - cardRect.top);
    const chartOffsetLeft = Math.max(0, chartRect.left - cardRect.left);
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(cardRect.width * scale));
    canvas.height = Math.max(1, Math.round(cardRect.height * scale));

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      alert('Could not create export canvas.');
      return;
    }

    ctx.scale(scale, scale);

    const styles = getComputedStyle(card);
    const bgColor = styles.backgroundColor || '#FFFFFF';
    const borderColor = styles.borderColor || '#E5E7EB';

    // Draw card background/border first so non-chart content is part of the exported image.
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, cardRect.width, cardRect.height);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, cardRect.width - 1, cardRect.height - 1);

    const image = new Image();
    image.onload = () => {
      try {
        ctx.drawImage(image, chartOffsetLeft, chartOffsetTop, chartRect.width, chartRect.height);

        const wrapText = (text, x, y, maxWidth, lineHeight, maxLines, color, font, weight = 'normal') => {
          if (!text) return y;
          ctx.fillStyle = color;
          ctx.font = `${weight} ${font}`;
          const words = text.split(/\s+/).filter(Boolean);
          let line = '';
          let lines = 0;
          for (let i = 0; i < words.length; i++) {
            const candidate = line ? `${line} ${words[i]}` : words[i];
            if (ctx.measureText(candidate).width > maxWidth && line) {
              ctx.fillText(line, x, y);
              y += lineHeight;
              lines += 1;
              line = words[i];
              if (lines >= maxLines) {
                const clipped = line.length > 3 ? `${line.slice(0, Math.max(0, line.length - 3))}...` : `${line}...`;
                ctx.fillText(clipped, x, y - lineHeight + Math.min(lineHeight, 2));
                return y;
              }
            } else {
              line = candidate;
            }
          }
          if (line && lines < maxLines) {
            ctx.fillText(line, x, y);
            y += lineHeight;
          }
          return y;
        };

        const leftPad = 20;
        const topPad = 34;
        const textWidth = Math.max(160, cardRect.width - leftPad * 2 - 10);

        // Overlay card heading/subheading text so exported PNG includes full context.
        let y = topPad;
        y = wrapText(titleText, leftPad, y, textWidth, 18, 2, '#111827', '600 13px Inter, sans-serif');
        wrapText(subText, leftPad, y + 2, textWidth, 14, 2, '#6B7280', '11px Inter, sans-serif');

        if (summaryText) {
          const dividerY = Math.max(chartOffsetTop + chartRect.height + 10, cardRect.height - 52);
          ctx.strokeStyle = '#E5E7EB';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(leftPad, dividerY);
          ctx.lineTo(cardRect.width - leftPad, dividerY);
          ctx.stroke();
          wrapText(summaryText, leftPad, dividerY + 16, textWidth, 14, 4, '#4B5563', '12px Inter, sans-serif');
        }

        const dataUrl = canvas.toDataURL('image/png');
        const safe = String(title || titleText || 'chart')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 64) || 'chart';
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `${safe}.png`;
        a.click();
      } catch (_) {
        alert('Could not export this chart card image.');
      }
    };

    image.onerror = () => {
      alert('Could not render chart image for export.');
    };

    image.src = chartUrl;
  } catch (_) {
    alert('Could not export this chart image.');
  }
}

function shortFallbackSummary(meta = {}, option = {}) {
  const type = String(meta.type || option?.series?.[0]?.type || '').toLowerCase();
  const series = Array.isArray(option.series) ? option.series : [];
  const first = series[0] || {};
  const xLabels = Array.isArray(option?.xAxis?.data) ? option.xAxis.data : [];

  const numericVals = (Array.isArray(first.data) ? first.data : [])
    .map(v => {
      if (typeof v === 'number') return v;
      if (Array.isArray(v) && typeof v[1] === 'number') return v[1];
      if (v && typeof v === 'object' && typeof v.value === 'number') return v.value;
      return NaN;
    })
    .filter(v => Number.isFinite(v));

  if ((type === 'line' || type === 'bar') && numericVals.length >= 2) {
    const firstVal = numericVals[0];
    const lastVal = numericVals[numericVals.length - 1];
    const change = firstVal === 0 ? 0 : ((lastVal - firstVal) / Math.abs(firstVal)) * 100;
    const firstLabel = xLabels[0] != null ? String(xLabels[0]) : 'start';
    const lastLabel = xLabels[numericVals.length - 1] != null ? String(xLabels[numericVals.length - 1]) : 'latest';
    if (Math.abs(change) >= 8) {
      return change > 0
        ? `Increased from ${firstVal.toFixed(1)} to ${lastVal.toFixed(1)} (${Math.abs(change).toFixed(1)}%) between ${firstLabel} and ${lastLabel}.`
        : `Dropped from ${firstVal.toFixed(1)} to ${lastVal.toFixed(1)} (${Math.abs(change).toFixed(1)}%) between ${firstLabel} and ${lastLabel}.`;
    }
    const avg = numericVals.reduce((a, b) => a + b, 0) / numericVals.length;
    return `Stayed mostly stable around ${avg.toFixed(1)} from ${firstLabel} to ${lastLabel}.`;
  }

  if (type === 'pie' && Array.isArray(first.data) && first.data.length) {
    const vals = first.data.map(d => +d.value || 0);
    const total = vals.reduce((a, b) => a + b, 0);
    if (total > 0) {
      let maxIdx = 0;
      for (let i = 1; i < vals.length; i++) if (vals[i] > vals[maxIdx]) maxIdx = i;
      const share = (vals[maxIdx] / total) * 100;
      const topName = first.data[maxIdx]?.name || 'Top segment';
      if (share >= 45) return `${topName} leads with ${share.toFixed(1)}% of total, far above other segments.`;
      if (share >= 30) return `${topName} is highest at ${share.toFixed(1)}%, but others still contribute.`;
      return `${topName} is highest at ${share.toFixed(1)}%, showing a relatively balanced split.`;
    }
  }

  if (type === 'scatter' && Array.isArray(first.data) && first.data.length >= 6) {
    const pts = first.data
      .map(p => Array.isArray(p) ? [Number(p[0]), Number(p[1])] : null)
      .filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length >= 6) {
      const n = pts.length;
      const sx = pts.reduce((s, p) => s + p[0], 0);
      const sy = pts.reduce((s, p) => s + p[1], 0);
      const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0);
      const syy = pts.reduce((s, p) => s + p[1] * p[1], 0);
      const sxy = pts.reduce((s, p) => s + p[0] * p[1], 0);
      const num = n * sxy - sx * sy;
      const den = Math.sqrt(Math.max((n * sxx - sx * sx) * (n * syy - sy * sy), 0));
      const r = den ? num / den : 0;
      if (r >= 0.5) return `Strong same-direction movement in points (r=${r.toFixed(2)}), with both values increasing together.`;
      if (r <= -0.5) return `Strong opposite movement in points (r=${r.toFixed(2)}), where increases in one align with decreases in the other.`;
      return `No strong link in points (r=${r.toFixed(2)}), so changes in one value do not reliably predict the other.`;
    }
  }

  const y = String(meta.yCol || '').replace(/_/g, ' ').trim();
  const x = String(meta.xCol || '').replace(/_/g, ' ').trim();
  if (y && x) return `${y} changes across ${x}, with visible differences between groups.`;
  return 'Pattern detected from chart values.';
}

function _toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function _safeReadChartPrefs() {
  try {
    const raw = localStorage.getItem(CHART_PREFS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function _safeWriteChartPrefs(nextPrefs) {
  try {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(nextPrefs || {}));
  } catch (_) {}
}

function _getChartTypePreference(prefKey) {
  if (!prefKey) return 'auto';
  const prefs = _safeReadChartPrefs();
  const saved = String(prefs[prefKey] || 'auto').toLowerCase();
  return CHART_TYPE_SEQUENCE.includes(saved) ? saved : 'auto';
}

function _setChartTypePreference(prefKey, type) {
  if (!prefKey || !CHART_TYPE_SEQUENCE.includes(type)) return;
  const prefs = _safeReadChartPrefs();
  prefs[prefKey] = type;
  _safeWriteChartPrefs(prefs);
}

function _chartPreferenceKey(title = '', meta = {}) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const parts = [
    norm(meta.tableName),
    norm(title || meta.title),
    norm(meta.xCol),
    norm(meta.yCol)
  ].filter(Boolean);
  return parts.join('|') || norm(title || 'chart');
}

function _sourceMeta(sourceMeta, selectedType, option) {
  const source = sourceMeta && typeof sourceMeta === 'object' ? sourceMeta : {};
  return {
    sql: String(source.sql || '').trim(),
    jsBuilder: String(source.jsBuilder || _builderNameForType(selectedType || 'auto')),
    origin: String(source.origin || 'dashboard'),
    note: String(source.note || ''),
    option
  };
}

async function fetchChartSource(chartId) {
  const state = chartMetaById[chartId];
  if (!state || state.sourceLoaded || state.sourceLoading) return;

  const meta = state.summaryMeta || {};
  if (!meta.tableName || !meta.xCol || !meta.yCol || !state.originalType) {
    state.originalSource = _sourceMeta({
      sql: '',
      jsBuilder: _builderNameForType(state.originalType || 'auto'),
      origin: 'chart-source',
      note: 'SQL is not available for this visual.'
    }, 'auto', state.originalOption);
    state.sourceLoaded = true;
    state.sourceError = '';
    if (state.currentType === 'auto') state.currentSource = state.originalSource;
    return;
  }

  state.sourceLoading = true;
  state.sourceError = '';
  if (sourceModalState.chartId === chartId) renderSourceModal();

  try {
    const res = await fetch(`${API}/api/chart-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableName: meta.tableName,
        type: state.originalType,
        xCol: meta.xCol,
        yCol: meta.yCol
      })
    });
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {
      const looksHtml = /^\s*</.test(raw || '');
      if (looksHtml) {
        throw new Error('Source endpoint returned HTML instead of JSON. Restart backend and verify /api/chart-source route.');
      }
      throw new Error('Source endpoint returned invalid JSON.');
    }
    if (!res.ok) throw new Error(data?.error || `Failed to load source (HTTP ${res.status}).`);

    state.originalSource = _sourceMeta(data, 'auto', state.originalOption);
    state.sourceLoaded = true;
    if (state.currentType === 'auto') {
      state.currentSource = state.originalSource;
    } else if (state.currentSource) {
      state.currentSource.sql = state.originalSource.sql;
    }
  } catch (e) {
    state.sourceError = String(e?.message || 'Could not load source.');
  } finally {
    state.sourceLoading = false;
    if (sourceModalState.chartId === chartId) renderSourceModal();
  }
}

function ensureSourceModal() {
  if (document.getElementById('dbSourceModal')) return;
  const modal = document.createElement('div');
  modal.id = 'dbSourceModal';
  modal.className = 'db-source-modal';
  modal.innerHTML = `
    <div class="db-source-backdrop" data-close="1"></div>
    <div class="db-source-dialog" role="dialog" aria-modal="true" aria-labelledby="dbSourceTitle">
      <div class="db-source-head">
        <div>
          <div class="db-source-title" id="dbSourceTitle">Chart Source</div>
          <div class="db-source-meta" id="dbSourceMeta"></div>
        </div>
        <button class="db-source-close" id="dbSourceClose" type="button" aria-label="Close source viewer">×</button>
      </div>
      <div class="db-source-tabs">
        <button class="db-source-tab active" data-tab="sql" type="button">SQL</button>
        <button class="db-source-tab" data-tab="js" type="button">JS</button>
        <button class="db-source-copy" id="dbSourceCopy" type="button">Copy</button>
      </div>
      <pre class="db-source-code" id="dbSourceCode"></pre>
    </div>`;
  document.body.appendChild(modal);

  modal.addEventListener('click', e => {
    if (e.target?.dataset?.close === '1') closeSourceModal();
  });
  document.getElementById('dbSourceClose')?.addEventListener('click', closeSourceModal);
  document.querySelectorAll('.db-source-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      sourceModalState.activeTab = btn.dataset.tab || 'sql';
      renderSourceModal();
    });
  });
  document.getElementById('dbSourceCopy')?.addEventListener('click', copySourceFromModal);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('open')) closeSourceModal();
  });
}

function sourceModalContent(state, tab) {
  if (!state) return 'No source metadata available.';
  if (tab === 'sql' && state.sourceLoading) return 'Loading SQL source...';
  if (tab === 'sql' && state.sourceError) return `-- ${state.sourceError}`;
  const src = state.currentSource || _sourceMeta({}, state.currentType, state.currentOption);

  if (tab === 'sql') {
    if (src.sql) return src.sql;
    return '-- SQL is not available for this chart (client-side generated or transformed visual).';
  }

  const jsPayload = {
    chartType: state.currentType,
    builder: src.jsBuilder || _builderNameForType(state.currentType),
    origin: src.origin || 'dashboard',
    note: src.note || '',
    option: state.currentOption || state.originalOption
  };
  return JSON.stringify(jsPayload, null, 2);
}

function renderSourceModal() {
  const modal = document.getElementById('dbSourceModal');
  if (!modal) return;
  const state = chartMetaById[sourceModalState.chartId];
  const title = String(state?.summaryMeta?.title || 'Chart Source');
  const tab = sourceModalState.activeTab || 'sql';

  const metaEl = document.getElementById('dbSourceMeta');
  if (metaEl) {
    const tableName = String(state?.summaryMeta?.tableName || '').trim();
    const chartType = _chartTypeLabel(state?.currentType || 'auto');
    metaEl.textContent = tableName ? `${tableName} · ${chartType}` : chartType;
  }

  const titleEl = document.getElementById('dbSourceTitle');
  if (titleEl) titleEl.textContent = `${title} - Source`;

  document.querySelectorAll('.db-source-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  const codeEl = document.getElementById('dbSourceCode');
  if (codeEl) codeEl.textContent = sourceModalContent(state, tab);
}

async function openSourceModal(chartId, tab = 'sql') {
  ensureSourceModal();
  sourceModalState.chartId = chartId;
  sourceModalState.activeTab = tab;
  const modal = document.getElementById('dbSourceModal');
  if (!modal) return;
  modal.classList.add('open');
  renderSourceModal();
  await fetchChartSource(chartId);
}

function closeSourceModal() {
  const modal = document.getElementById('dbSourceModal');
  if (!modal) return;
  modal.classList.remove('open');
}

async function copySourceFromModal() {
  const text = sourceModalContent(chartMetaById[sourceModalState.chartId], sourceModalState.activeTab);
  try {
    await navigator.clipboard.writeText(text);
    alert('Source copied.');
  } catch (_) {
    alert('Could not copy source.');
  }
}

function _extractConvertibleSeries(option = {}) {
  const series = Array.isArray(option.series) ? option.series : [];
  const first = series[0] || {};
  const type = String(first.type || '').toLowerCase();

  if (type === 'pie') {
    const data = Array.isArray(first.data) ? first.data : [];
    const labels = [];
    const values = [];
    data.forEach(d => {
      const name = String(d?.name ?? '').trim();
      const value = _toFiniteNumber(d?.value);
      if (name && Number.isFinite(value)) {
        labels.push(name);
        values.push(value);
      }
    });
    if (labels.length >= 2) return { kind: 'category', labels, values };
    return null;
  }

  if (type === 'scatter') {
    const data = Array.isArray(first.data) ? first.data : [];
    const points = data
      .map(p => Array.isArray(p) ? [_toFiniteNumber(p[0]), _toFiniteNumber(p[1])] : null)
      .filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (points.length >= 2) return { kind: 'scatter', points };
    return null;
  }

  const xAxis = Array.isArray(option?.xAxis) ? option.xAxis[0] : option?.xAxis;
  const labels = Array.isArray(xAxis?.data) ? xAxis.data.map(v => String(v)) : [];
  const data = Array.isArray(first.data) ? first.data : [];
  const values = data
    .map(v => {
      if (typeof v === 'number') return v;
      if (Array.isArray(v)) return _toFiniteNumber(v[v.length - 1]);
      if (v && typeof v === 'object' && v.value !== undefined) return _toFiniteNumber(v.value);
      return _toFiniteNumber(v);
    });

  const usable = [];
  const usableLabels = [];
  for (let i = 0; i < Math.min(labels.length, values.length); i++) {
    if (Number.isFinite(values[i])) {
      usableLabels.push(labels[i]);
      usable.push(values[i]);
    }
  }
  if (usable.length >= 2) return { kind: 'category', labels: usableLabels, values: usable };
  return null;
}

function _buildScatterFromPoints(points = [], xName = 'X', yName = 'Y') {
  return {
    grid: DARK_GRID, tooltip: DARK_TIP,
    xAxis: { type:'value', name:String(xName), nameLocation:'middle', nameGap:25, ...DARK_AXIS },
    yAxis: { type:'value', name:String(yName), nameLocation:'middle', nameGap:40, ...DARK_AXIS },
    series: [{
      type:'scatter',
      data: points,
      itemStyle:{ color:'#007BFF', opacity:0.6 },
      symbolSize: 6
    }]
  };
}

function _buildConvertedOption(targetType, sourceOption = {}, summaryMeta = {}) {
  const extracted = _extractConvertibleSeries(sourceOption);
  if (!extracted) {
    return { ok: false, message: 'This chart does not have enough points to convert.' };
  }

  if (targetType === 'bar' || targetType === 'hbar' || targetType === 'line' || targetType === 'area' || targetType === 'donut' || targetType === 'rose') {
    let labels = [];
    let values = [];

    if (extracted.kind === 'category') {
      labels = extracted.labels;
      values = extracted.values;
    } else {
      labels = extracted.points.map(p => String(Number(p[0].toFixed(2))));
      values = extracted.points.map(p => p[1]);
    }

    if (labels.length < 2 || values.length < 2) {
      return { ok: false, message: 'Need at least 2 values for this chart type.' };
    }

    if ((targetType === 'donut' || targetType === 'rose') && labels.length > 12) {
      return { ok: false, message: 'Donut/Rose works best with 12 or fewer categories.' };
    }

    if (targetType === 'bar') {
      return { ok: true, option: buildBarOption(labels, values), type: 'bar' };
    }
    if (targetType === 'hbar') {
      return { ok: true, option: buildHorizontalBarOption(labels, values), type: 'bar' };
    }
    if (targetType === 'line') {
      return {
        ok: true,
        option: buildLineOption(labels, [{
          name: String(summaryMeta?.yCol || summaryMeta?.title || 'Value').replace(/_/g, ' '),
          data: values,
          color: DARK_COLORS[0]
        }]),
        type: 'line'
      };
    }
    if (targetType === 'area') {
      return {
        ok: true,
        option: buildAreaOption(labels, values, String(summaryMeta?.yCol || summaryMeta?.title || 'Value').replace(/_/g, ' ')),
        type: 'line'
      };
    }
    if (targetType === 'rose') {
      return { ok: true, option: buildRoseOption(labels, values), type: 'pie' };
    }
    return { ok: true, option: buildDonutOption(labels, values), type: 'pie' };
  }

  if (targetType === 'scatter') {
    let points = [];
    if (extracted.kind === 'scatter') {
      points = extracted.points;
    } else {
      const xNumeric = extracted.labels.map(v => _toFiniteNumber(v));
      if (xNumeric.some(v => !Number.isFinite(v))) {
        return { ok: false, message: 'Scatter needs numeric X values.' };
      }
      points = xNumeric.map((x, i) => [x, extracted.values[i]]);
    }

    if (points.length < 2) {
      return { ok: false, message: 'Need at least 2 points for scatter.' };
    }

    return {
      ok: true,
      option: _buildScatterFromPoints(
        points,
        String(summaryMeta?.xCol || 'X').replace(/_/g, ' '),
        String(summaryMeta?.yCol || 'Y').replace(/_/g, ' ')
      ),
      type: 'scatter'
    };
  }

  return { ok: false, message: 'Unsupported chart conversion type.' };
}

function showConversionNote(noteId, message, isError = false) {
  const el = document.getElementById(noteId);
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('is-error', !!isError);
  el.classList.toggle('is-success', !isError && !!message);
  if (!message) return;
  setTimeout(() => {
    if (el.textContent === message) {
      el.textContent = '';
      el.classList.remove('is-error', 'is-success');
    }
  }, 2400);
}

function _syncChartTypeControls(state, value) {
  if (!state) return;
  const selectEl = document.getElementById(state.convertId);
  if (selectEl && selectEl.value !== value) selectEl.value = value;
}

function applyChartOption(chartId, option) {
  const chart = chartRegistry[chartId];
  if (chart) {
    chart.setOption({ ..._normalizeOption(option), backgroundColor: 'transparent' }, true);
    try { chart.resize(); } catch (_) {}
    return true;
  }

  const pending = pendingCharts.find(p => p.id === chartId);
  if (pending) {
    pending.option = option;
    return true;
  }
  return false;
}

function handleChartTypeChange(chartId, selectedType) {
  const state = chartMetaById[chartId];
  if (!state) return;
  if (!state.availableTypes.includes(selectedType)) return;
  const isRefresh = state.currentType === selectedType;

  if (selectedType === 'auto') {
    const applied = applyChartOption(chartId, state.originalOption);
    if (!applied) return;
    state.currentOption = state.originalOption;
    state.currentSource = _sourceMeta(state.originalSource, 'auto', state.originalOption);
    state.currentType = 'auto';
    _syncChartTypeControls(state, 'auto');
    _setChartTypePreference(state.prefKey, 'auto');
    fillChartSummary(state.summaryId, { ...state.summaryMeta, type: state.originalType }, state.currentOption);
    showConversionNote(state.noteId, isRefresh ? 'Refreshed default chart.' : 'Showing auto-selected chart.');
    return;
  }

  const result = _buildConvertedOption(selectedType, state.originalOption, state.summaryMeta);
  if (!result.ok || !result.option) {
    _syncChartTypeControls(state, state.currentType);
    showConversionNote(state.noteId, result.message || 'Could not convert this chart.', true);
    return;
  }

  const applied = applyChartOption(chartId, result.option);
  if (!applied) {
    showConversionNote(state.noteId, 'Chart is still loading. Try again.', true);
    return;
  }

  state.currentOption = result.option;
  state.currentSource = _sourceMeta({
    sql: state.originalSource?.sql || '',
    origin: 'converted',
    note: 'SQL remains from the original chart; visual transformed in browser.'
  }, selectedType, result.option);
  state.currentType = selectedType;
  _syncChartTypeControls(state, selectedType);
  _setChartTypePreference(state.prefKey, selectedType);
  fillChartSummary(state.summaryId, { ...state.summaryMeta, type: result.type || selectedType }, state.currentOption);
  showConversionNote(state.noteId, isRefresh ? `Refreshed ${selectedType} chart.` : `Switched to ${selectedType} chart.`);
}

function refreshChartType(chartId) {
  const state = chartMetaById[chartId];
  if (!state) return;
  const current = state.currentType || 'auto';
  handleChartTypeChange(chartId, current);
}

function isWeakSummary(summary = '') {
  const s = String(summary).toLowerCase().trim();
  const genericPhrases = [
    'values are going up over time',
    'values are going down over time',
    'values are mostly stable over time',
    'the parts are fairly balanced',
    'there is no clear relationship here',
    'this chart shows the main data pattern'
  ];
  const hasEvidenceNumber = /\d/.test(s);
  const genericMatch = genericPhrases.some(p => s.includes(p));
  return genericMatch || !hasEvidenceNumber;
}

function buildChartPreview(option) {
  const opt = option || {};
  const s0 = (opt.series || [])[0] || {};
  const x = (opt.xAxis && opt.xAxis.data) || [];
  const yRaw = Array.isArray(s0.data) ? s0.data.slice(0, 12) : [];
  const y = yRaw.map(v => {
    if (v && typeof v === 'object' && Array.isArray(v.value)) return v.value;
    return v;
  });
  return {
    x: x.slice(0, 12),
    y
  };
}

function isTitleLikeSummary(summary, meta = {}) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const sm = norm(summary);
  if (!sm) return true;

  const title = norm(meta.title);
  const subtitle = norm(meta.subtitle);
  if (title && (sm === title || title.includes(sm) || sm.includes(title))) return true;
  if (subtitle && (sm === subtitle || subtitle.includes(sm) || sm.includes(subtitle))) return true;

  const generic = [
    'chart summary',
    'key pattern shown',
    'chart insight',
    'summary',
    'insight'
  ];
  return generic.includes(sm);
}

async function fillChartSummary(summaryId, meta, option) {
  const el = document.getElementById(summaryId);
  if (!el) return;

  const fallback = shortFallbackSummary(meta, option);
  el.textContent = 'Summarizing...';

  try {
    const res = await fetch(`${API}/api/chart-summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chart: {
          title: meta.title || '',
          subtitle: meta.subtitle || '',
          type: meta.type || '',
          tableName: meta.tableName || '',
          xCol: meta.xCol || '',
          yCol: meta.yCol || ''
        },
        preview: buildChartPreview(option)
      })
    });

    if (!res.ok) throw new Error('summary api failed');
    const data = await res.json();
    const summary = String(data.summary || '').trim();
    el.textContent = (!summary || isTitleLikeSummary(summary, meta) || isWeakSummary(summary)) ? fallback : summary;
  } catch (_) {
    el.textContent = fallback;
  }
}

function buildChartCard({ container, chartId, title, sub, option, summaryMeta, delayIndex }) {
  const summaryId = `${chartId}_summary`;
  const exportId = `${chartId}_export`;
  const sourceId = `${chartId}_source`;
  const convertId = `${chartId}_convert`;
  const cycleId = `${chartId}_cycle`;
  const noteId = `${chartId}_convert_note`;
  const originalType = String(summaryMeta?.type || option?.series?.[0]?.type || '').toLowerCase();
  const defaultType = _canonicalChartType(originalType);
  const availableTypes = _availableChartTypes(originalType);
  const selectOptions = availableTypes
    .map(type => {
      const label = type === 'auto' && defaultType && defaultType !== 'auto'
        ? `Default (${_chartTypeLabel(defaultType)})`
        : _chartTypeLabel(type);
      return `<option value="${type}">${label}</option>`;
    })
    .join('');
  const prefKey = _chartPreferenceKey(title, summaryMeta);
  const subtitleHtml = sub ? `<div class="db-chart-card-sub">${escapeHtml(sub)}</div>` : '';
  const card = document.createElement('div');
  card.className = 'db-chart-card';
  card.innerHTML = `
    <div class="db-chart-card-head">
      <div class="db-chart-card-title">${escapeHtml(title)}</div>
      <div class="db-chart-card-actions">
        <button class="db-chart-cycle-btn" id="${cycleId}" type="button" title="Refresh chart" aria-label="Refresh chart">↺</button>
        <select class="db-chart-type-select" id="${convertId}" aria-label="Convert chart type">
          ${selectOptions}
        </select>
        <button class="db-chart-export-btn" id="${sourceId}" type="button">Source</button>
        <button class="db-chart-export-btn" id="${exportId}" type="button">Export Image</button>
      </div>
    </div>
    <div class="db-chart-convert-note" id="${noteId}" aria-live="polite"></div>
    ${subtitleHtml}
    <div class="db-chart-inner" id="${chartId}"></div>
    <div class="db-chart-summary" id="${summaryId}">Summarizing...</div>`;
  container.appendChild(card);

  const exportBtn = document.getElementById(exportId);
  if (exportBtn) {
    exportBtn.addEventListener('click', () => exportChartImage(chartId, title));
  }

  const sourceBtn = document.getElementById(sourceId);
  if (sourceBtn) {
    sourceBtn.addEventListener('click', () => openSourceModal(chartId, 'sql'));
  }

  const originalSource = _sourceMeta({}, 'auto', option);

  chartMetaById[chartId] = {
    originalOption: option,
    currentOption: option,
    originalSource,
    currentSource: originalSource,
    currentType: 'auto',
    originalType,
    summaryMeta,
    summaryId,
    convertId,
    noteId,
    prefKey,
    availableTypes,
    sourceLoading: false,
    sourceLoaded: false,
    sourceError: ''
  };

  const convertEl = document.getElementById(convertId);
  if (convertEl) {
    convertEl.addEventListener('change', e => handleChartTypeChange(chartId, String(e.target.value || 'auto')));
  }

  const cycleEl = document.getElementById(cycleId);
  if (cycleEl) {
    cycleEl.addEventListener('click', () => refreshChartType(chartId));
  }

  const cid = chartId;
  const opt = option;
  setTimeout(() => {
    if (!tryInitChart(cid, opt)) pendingCharts.push({ id: cid, option: opt });
    const preferredType = _getChartTypePreference(prefKey);
    const validPreferredType = availableTypes.includes(preferredType) ? preferredType : 'auto';
    if (validPreferredType !== preferredType) _setChartTypePreference(prefKey, validPreferredType);
    if (validPreferredType !== 'auto') handleChartTypeChange(cid, validPreferredType);
  }, 80 + delayIndex * 30);

  fillChartSummary(summaryId, summaryMeta, option);
}

function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  document.getElementById('sidebar').classList.toggle('collapsed', !sidebarOpen);
  document.body.classList.toggle('sidebar-collapsed', !sidebarOpen);
  const btn = document.getElementById('sidebarToggle');
  if (btn) btn.textContent = sidebarOpen ? '‹' : '›';
  localStorage.setItem('sidebarCollapsed', sidebarOpen ? 'false' : 'true');
}

function toggleHistory() {
  document.getElementById('historyPanel').classList.toggle('open');
}

// ── Main load sequence ────────────────────────────────────────────────────────
async function loadDashboard() {
  // Dispose old chart instances to avoid memory leaks on refresh
  allCharts.forEach(c => { try { c.dispose(); } catch (_) {} });
  allCharts   = [];
  chartRegistry = {};
  chartMetaById = {};
  pendingCharts = [];
  sourceModalState = { chartId: '', activeTab: 'sql' };
  closeSourceModal();

  try {
    const res  = await fetch(`${API}/api/tables`);
    const data = await res.json();
    loadedTables = data.tables || {};
  } catch (_) { loadedTables = {}; }

  const names = Object.keys(loadedTables);
  workflowState.step1 = names.length > 0;
  renderSidebarSources(names);
  populateTableSelector(names);

  if (!names.length) {
    workflowState = { step1: false, step2: false, step3: false, step4: false, step5: false };
    renderWorkflowCoverage();
    return;
  }

  // Parallel: pull sample rows + detect relationships
  const [samples, relData] = await Promise.all([
    fetchAllSamples(names),
    fetch(`${API}/api/detect-relationships`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' }).then(r => r.ok ? r.json() : { joins: [], noRelation: [] }).catch(() => ({ joins: [], noRelation: [] }))
  ]);

  workflowState.step2 = Object.values(loadedTables).some(t => Array.isArray(t.columns) && t.columns.length > 0);
  workflowState.step3 = hasBusinessSignals(samples);

  await renderKPIStrip(samples);
  renderRelationshipMap(names, relData);
  const [overviewCount, chartCount] = await Promise.all([
    renderSmartCharts(names, 'overviewCharts', 2, samples),
    renderSmartCharts(names, 'chartsSection', 6, samples)
  ]);
  workflowState.step4 = (overviewCount + chartCount) > 0;
  renderWorkflowCoverage();
  renderHistory();
  renderInsights();

  // Data story (async — LLM call)
  generateDataStory(samples, names);

  document.getElementById('dbLastUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

async function fetchAllSamples(names) {
  const samples = {};
  await Promise.all(names.slice(0, 6).map(async name => {
    try {
      const r = await fetch(`${API}/api/execute-sql`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ sql: `SELECT * FROM "${name}" LIMIT 500` })
      });
      if (r.ok) {
        const d = await r.json();
        samples[name] = { ...d, meta: loadedTables[name] };
      }
    } catch (_) {}
  }));
  return samples;
}

// ── Sidebar sources ───────────────────────────────────────────────────────────
function renderSidebarSources(names) {
  const el = document.getElementById('sidebarSources');
  if (!el) return;
  const icon = s => s === 'databricks' ? '🔷' : s === 's3' ? '🟠' : '📄';
  el.innerHTML = names.map(n => {
    const t = loadedTables[n];
    return `<div class="db-source-item" onclick="loadTableExplorer('${escapeHtml(n)}');showSection('tables')">
      <span class="db-source-icon">${icon(t.source||'file')}</span>
      <span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(n)}</span>
      <span class="db-source-badge">${(t.rowCount||0).toLocaleString()}</span>
    </div>`;
  }).join('') || '<div style="padding:8px 10px;color:var(--text-muted);font-size:12px">No tables loaded</div>';
}

// ── KPI Strip ─────────────────────────────────────────────────────────────────
function buildKPIRecommendationPayload(samples) {
  const TYPE_CANDIDATES = ['INTEGER', 'BIGINT', 'DOUBLE', 'FLOAT', 'REAL', 'DECIMAL', 'NUMERIC'];
  const tables = [];

  for (const [tableName, d] of Object.entries(samples || {})) {
    const rows = Array.isArray(d?.rows) ? d.rows : [];
    const cols = Array.isArray(d?.columns) ? d.columns : [];
    const numericColumns = [];

    cols
      .filter(c => TYPE_CANDIDATES.some(t => String(c?.type || '').toUpperCase().startsWith(t)))
      .forEach(col => {
        const raw = rows.map(r => r?.[col.name]);
        const vals = raw.map(v => +v).filter(v => !isNaN(v));
        if (!vals.length) return;

        const sum = vals.reduce((a, b) => a + b, 0);
        const avg = sum / vals.length;
        const variance = vals.length > 1 ? vals.reduce((a, v) => a + Math.pow(v - avg, 2), 0) / vals.length : 0;
        const std = Math.sqrt(variance);
        const spread = Math.max(...vals) - Math.min(...vals);
        const nonZeroRatio = vals.length ? vals.filter(v => v !== 0).length / vals.length : 0;
        const nullCount = raw.length - vals.length;
        const nullPct = raw.length ? nullCount / raw.length : 0;

        numericColumns.push({
          column: col.name,
          sampleSize: vals.length,
          nullPct: +nullPct.toFixed(4),
          nonZeroRatio: +nonZeroRatio.toFixed(4),
          spread: +spread.toFixed(4),
          cv: avg ? +(Math.abs(std / avg)).toFixed(4) : 0,
          sum: +sum.toFixed(4),
          avg: +avg.toFixed(4)
        });
      });

    tables.push({
      tableName,
      rowCount: d?.rowCount || rows.length || 0,
      numericColumns
    });
  }

  return { tables };
}

async function fetchAIKPIRecommendations(samples) {
  try {
    const payload = buildKPIRecommendationPayload(samples);
    const res = await fetch(`${API}/api/recommend-kpis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.kpis) ? data.kpis : [];
  } catch (_) {
    return [];
  }
}

async function renderKPIStrip(samples) {
  const el = document.getElementById('kpiStrip');
  if (!el) return;

  const candidateKPIs = [];
  let totalRows = 0;

  const TYPE_CANDIDATES = ['INTEGER', 'BIGINT', 'DOUBLE', 'FLOAT', 'REAL', 'DECIMAL', 'NUMERIC'];
  const compactNumber = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1
  });

  const normalizeLabel = raw => String(raw || '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());

  const isPercentMetric = name => /pct|percentage|%|rate|ratio|conversion|churn|retention/i.test(name);
  const isCurrencyMetric = name => /sales|revenue|profit|margin|cost|expense|spend|amount|value|price|gmv|arr|mrr|income/i.test(name);

  const scoreNameRelevance = (rawName) => {
    const name = String(rawName || '').toLowerCase();
    let score = 0;

    if (/revenue|sales|profit|margin|amount|value|gmv|arr|mrr/.test(name)) score += 28;
    if (/cost|expense|spend|price|income|orders?|units?|volume|quantity/.test(name)) score += 18;
    if (/count|total|sum/.test(name)) score += 10;
    if (/rate|ratio|pct|percentage|conversion|churn|retention/.test(name)) score += 12;

    // Penalize likely IDs/codes that are often not actionable KPIs.
    if (/(^|_)(id|key|code|zip|pin|index|idx)($|_)/.test(name)) score -= 22;

    return score;
  };

  const formatKPIValue = (colName, vals) => {
    const name = String(colName || '');
    const percentMetric = isPercentMetric(name);
    const sum = vals.reduce((a, b) => a + b, 0);
    const avg = sum / vals.length;
    const baseValue = /total|sum|amount|sales|revenue|profit|cost|expense|spend|value|gmv|arr|mrr|orders?|units?|volume|quantity/i.test(name)
      ? sum
      : avg;

    if (percentMetric) {
      // Keep percentage/rate KPIs on average to avoid inflated totals.
      return `${avg.toFixed(1)}%`;
    }
    if (isCurrencyMetric(name)) {
      return `$${compactNumber.format(baseValue)}`;
    }
    return compactNumber.format(baseValue);
  };

  const computeTrend = vals => {
    const half = Math.floor(vals.length / 2);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const avg1 = half > 0 ? vals.slice(0, half).reduce((a, b) => a + b, 0) / half : avg;
    const avg2 = vals.length - half > 0 ? vals.slice(half).reduce((a, b) => a + b, 0) / (vals.length - half) : avg;
    const pct = avg1 ? ((avg2 - avg1) / Math.abs(avg1) * 100) : 0;
    return {
      pct,
      dir: pct > 1 ? 'up' : pct < -1 ? 'down' : 'flat'
    };
  };

  for (const [name, d] of Object.entries(samples)) {
    totalRows += d.rowCount || d.rows?.length || 0;
    const numCols = (d.columns||[]).filter(c =>
      TYPE_CANDIDATES.some(t => (c.type||'').toUpperCase().startsWith(t)) &&
      !/date|time|start|end|month|week|year|quarter/i.test(c.name)  // Exclude all temporal columns
    );

    numCols.forEach(col => {
      const vals = (d.rows||[]).map(r => +r[col.name]).filter(v => !isNaN(v));
      if (!vals.length) return;

      const numericSpread = Math.max(...vals) - Math.min(...vals);
      const nonZeroCount = vals.filter(v => v !== 0).length;
      const nonZeroRatio = vals.length ? nonZeroCount / vals.length : 0;
      const trend = computeTrend(vals);
      const relevanceScore =
        scoreNameRelevance(col.name) +
        Math.min(20, numericSpread > 0 ? Math.log10(Math.abs(numericSpread) + 1) * 6 : 0) +
        Math.min(15, nonZeroRatio * 15) +
        Math.min(12, Math.abs(trend.pct) * 0.6) +
        (vals.length >= 8 ? 10 : vals.length >= 4 ? 6 : 2);

      candidateKPIs.push({
        _key: `${name}::${col.name}`,
        _rawColumn: col.name,
        label: normalizeLabel(col.name),
        value: formatKPIValue(col.name, vals),
        trend: trend.dir,
        pct: Math.abs(trend.pct).toFixed(1),
        table: name,
        _score: relevanceScore
      });
    });
  }

  const rankedFallback = candidateKPIs
    .sort((a, b) => b._score - a._score)
    .map(({ _score, ...k }) => k);

  const aiRecommendations = await fetchAIKPIRecommendations(samples);
  const byKey = new Map(rankedFallback.map(k => [k._key, k]));
  const seen = new Set();
  const topKPIs = [];

  aiRecommendations.forEach(item => {
    const key = `${item?.table || ''}::${item?.column || ''}`;
    const match = byKey.get(key);
    if (!match || seen.has(key) || topKPIs.length >= 5) return;
    seen.add(key);
    topKPIs.push({ ...match, _why: String(item?.why || '').trim() });
  });

  rankedFallback.forEach(k => {
    if (topKPIs.length >= 5) return;
    if (seen.has(k._key)) return;
    seen.add(k._key);
    topKPIs.push(k);
  });

  // Fallback if dataset has too few numeric metrics.
  if (!topKPIs.length || topKPIs.length < 5) {
    topKPIs.unshift({ label: 'Total Records', value: compactNumber.format(totalRows), trend: 'flat', pct: '0', table: 'all', _why: 'Row volume across loaded tables.' });
  }

  const arrowMap = { up: '▲', down: '▼', flat: '→' };
  const clsMap   = { up: 'kpi-trend-up', down: 'kpi-trend-down', flat: 'kpi-trend-flat' };

  el.innerHTML = topKPIs.slice(0, 5).map(k => `
    <div class="kpi-card" onclick="filterByKPI('${escapeHtml(k.label)}')" title="${escapeHtml(`Source: ${k.table || 'all'}${k._why ? `\nAI reason: ${k._why}` : ''}`)}">
      <div class="kpi-label">${escapeHtml(k.label)}</div>
      <div class="kpi-value">${escapeHtml(k.value)}</div>
      <div class="kpi-trend ${clsMap[k.trend]}">${arrowMap[k.trend]} ${k.pct}% vs prev period</div>
    </div>`).join('');
}

function filterByKPI(label) {
  // Navigate to charts section filtered by this KPI
  showSection('charts');
}

// ── Data story ────────────────────────────────────────────────────────────────
async function generateDataStory(samples, names) {
  const storyH = document.getElementById('storyHeadline');
  const storyN = document.getElementById('storyNarrative');
  const storyA = document.getElementById('storyAlerts');
  const storyAt= document.getElementById('storyAttrib');
  if (!storyH) return;

  storyH.textContent = 'Generating data story…';

  const tableSchemas = {};
  const sampleData   = {};
  for (const [n, d] of Object.entries(samples)) {
    tableSchemas[n] = { columns: d.columns||[], rowCount: d.rowCount||0, source: d.meta?.source||'file' };
    sampleData[n]   = (d.rows||[]).slice(0, 5);
  }

  try {
    const res  = await fetch(`${API}/api/generate-story`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ tableSchemas, sampleData })
    });
    if (!res.ok) throw new Error('Story API failed');
    const story = await res.json();

    storyH.textContent = story.headline || 'No headline generated';
    storyN.innerHTML   = (story.narrative||'').split('\n').filter(Boolean).map(p => `<p>${escapeHtml(p)}</p>`).join('');

    const sevClass = { CRITICAL:'story-alert-critical', WARNING:'story-alert-warning', INFO:'story-alert-info' };
    storyA.innerHTML = (story.alerts||[]).map(a => `
      <div class="story-alert ${sevClass[a.severity]||'story-alert-info'}">
        <span class="story-alert-badge">${escapeHtml(a.severity)}</span>
        <div class="story-alert-text"><strong>${escapeHtml(a.finding)}</strong> — ${escapeHtml(a.action)}</div>
      </div>`).join('');

    const totalRows = Object.values(tableSchemas).reduce((s,t) => s + (t.rowCount||0), 0);
    storyAt.textContent = `Analysis of ${names.join(', ')} · ${totalRows.toLocaleString()} records`;
    workflowState.step5 = true;
    renderWorkflowCoverage();
  } catch (e) {
    storyH.textContent = 'Could not generate story: ' + e.message;
    workflowState.step5 = false;
    renderWorkflowCoverage();
  }
}

function hasBusinessSignals(samples) {
  for (const d of Object.values(samples || {})) {
    const cols = d.columns || [];
    if (cols.some(c => /revenue|profit|sales|customer|product|region|date|month|quarter|year|cost|margin|churn/i.test(c.name || ''))) {
      return true;
    }
  }
  return false;
}

function renderWorkflowCoverage() {
  const el = document.getElementById('workflowStages');
  const badge = document.getElementById('workflowCoverageBadge');
  if (!el || !badge) return;

  const steps = [
    { id: 1, title: '1. Connect Business Data', on: workflowState.step1, note: workflowState.step1 ? 'Data source connected.' : 'Awaiting file/database/warehouse/cloud source.' },
    { id: 2, title: '2. Data Discovery & Understanding', on: workflowState.step2, note: workflowState.step2 ? 'Schema, types, and relationships detected.' : 'Waiting for schema and metadata.' },
    { id: 3, title: '3. AI Business Data Exploration', on: workflowState.step3, note: workflowState.step3 ? 'Business KPI signals identified.' : 'No clear KPI signals detected yet.' },
    { id: 4, title: '4. Automatic Dashboard Generation', on: workflowState.step4, note: workflowState.step4 ? 'Smart charts generated automatically.' : 'No chartable analytics generated yet.' },
    { id: 5, title: '5. AI Executive Insights & Storytelling', on: workflowState.step5, note: workflowState.step5 ? 'Executive story generated.' : 'Story generation pending.' },
    { id: 6, title: '6. User Asks Business Question', on: true, note: 'Question intake is available in Ask Questions.' },
    { id: 7, title: '7. Intent Understanding', on: true, note: 'Intent decoder uses KPI, filters, time, and context.' },
    { id: 8, title: '8. Analytics Engine', on: true, note: 'SQL + KPI/trend/comparison computation is active.' },
    { id: 9, title: '9. Context-Aware Data Storytelling', on: true, note: 'Responses include 6 structured business sections.' },
    { id: 10, title: '10. Conversational Follow-up', on: true, note: 'Follow-up prompts and contextual continuity enabled.' },
    { id: 11, title: '11. Decision Support', on: true, note: 'Recommended actions and risk/opportunity guidance included.' }
  ];

  const done = steps.filter(s => s.on).length;
  badge.textContent = `${done}/11 stages active`;
  el.innerHTML = steps.map(s => `
    <div class="workflow-stage ${s.on ? 'on' : 'off'}">
      <span class="workflow-dot"></span>
      <div>
        <div class="workflow-step-title">${escapeHtml(s.title)}</div>
        <div class="workflow-step-note">${escapeHtml(s.note)}</div>
      </div>
    </div>`).join('');
}

// ── Relationship map (SVG) ────────────────────────────────────────────────────
function renderRelationshipMap(names, relData) {
  const el = document.getElementById('relMap');
  const badge = document.getElementById('relMapBadge');
  if (!el) return;

  if (!names.length) { el.innerHTML = '<div class="rel-map-empty">No tables loaded</div>'; return; }

  const W = 700, H = 240, padding = 40;
  const nodeW = 140, nodeH = 60;
  const n = names.length;
  const cols = Math.min(n, 4);
  const rows = Math.ceil(n / cols);

  const positions = {};
  names.forEach((name, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const totalW = cols * nodeW + (cols - 1) * padding;
    const startX = (W - totalW) / 2;
    positions[name] = {
      x: startX + col * (nodeW + padding) + nodeW/2,
      y: padding + row * (nodeH + padding*1.5) + nodeH/2
    };
  });

  const sourceColor = s => ({ databricks: '#00CCCC', s3: '#D97706', file: '#6F42C1' })[s] || '#6F42C1';

  // Draw edges first
  let edges = '';
  (relData.joins||[]).forEach(j => {
    const pa = positions[j.tableA], pb = positions[j.tableB];
    if (!pa||!pb) return;
    const color = j.confidence > 0.8 ? '#00CCCC' : j.confidence > 0.5 ? '#D97706' : '#9CA3AF';
    const dash  = j.confidence > 0.8 ? '' : 'stroke-dasharray="5,4"';
    edges += `<line x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}" stroke="${color}" stroke-width="1.5" opacity="0.6" ${dash}/>`;
    const mx = (pa.x+pb.x)/2, my = (pa.y+pb.y)/2;
    edges += `<text x="${mx}" y="${my-4}" fill="${color}" font-size="9" text-anchor="middle">${escapeHtml(j.columnA)}</text>`;
  });

  // Draw nodes
  let nodes = '';
  names.forEach(name => {
    const { x, y } = positions[name];
    const t = loadedTables[name] || {};
    const color = sourceColor(t.source || 'file');
    nodes += `
      <rect x="${x-nodeW/2}" y="${y-nodeH/2}" width="${nodeW}" height="${nodeH}" rx="6"
            fill="#FFFFFF" stroke="${color}" stroke-width="1.5"/>
      <text x="${x}" y="${y-8}" fill="${escapeHtml(color)}" font-size="12" font-weight="600" text-anchor="middle">${escapeHtml(name.slice(0,18))}</text>
      <text x="${x}" y="${y+8}" fill="#6B7280" font-size="10" text-anchor="middle">${(t.rowCount||0).toLocaleString()} rows · ${(t.columns||[]).length} cols</text>
      <text x="${x}" y="${y+22}" fill="#9CA3AF" font-size="9" text-anchor="middle">${escapeHtml(t.source||'file')}</text>`;
  });

  const svgH = Math.max(H, rows * (nodeH + padding*1.5) + padding*2);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${svgH}" class="rel-map-svg">${edges}${nodes}</svg>`;

  if (badge) {
    const jc = (relData.joins||[]).length;
    badge.textContent = jc ? `${jc} join${jc>1?'s':''} detected` : 'No joins detected';
  }
}

function chartDefKey(def = {}) {
  return [def.tableName || '', def.type || '', def.xCol || '', def.yCol || ''].join('::');
}

function deterministicTopVisuals(candidates = [], limit = 6) {
  const sorted = [...candidates].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const selected = [];
  const byType = new Map();
  const byTable = new Map();

  const maxPerType = Math.max(1, Math.floor(limit / 3));
  const maxPerTable = Math.max(1, Math.floor(limit / 3));
  const isTrend = t => ['line', 'area'].includes(String(t || '').toLowerCase());
  const isCompositionOrDistribution = t => ['donut', 'pie', 'scatter', 'bar', 'hbar'].includes(String(t || '').toLowerCase());

  const pickOne = predicate => {
    const found = sorted.find(c => predicate(c) && !selected.some(s => s.key === c.key));
    if (!found) return;
    selected.push(found);
    byType.set(found.type, (byType.get(found.type) || 0) + 1);
    byTable.set(found.tableName, (byTable.get(found.tableName) || 0) + 1);
  };

  pickOne(c => isTrend(c.type));
  pickOne(c => isCompositionOrDistribution(c.type));

  for (const c of sorted) {
    if (selected.length >= limit) break;
    if (selected.some(s => s.key === c.key)) continue;
    const typeCount = byType.get(c.type) || 0;
    const tableCount = byTable.get(c.tableName) || 0;
    if (typeCount >= maxPerType || tableCount >= maxPerTable) continue;
    selected.push(c);
    byType.set(c.type, typeCount + 1);
    byTable.set(c.tableName, tableCount + 1);
  }

  if (selected.length < limit) {
    for (const c of sorted) {
      if (selected.length >= limit) break;
      if (selected.some(s => s.key === c.key)) continue;
      selected.push(c);
    }
  }

  return selected.slice(0, limit);
}

async function fetchTopVisualRecommendations(defs = [], limit = 6) {
  try {
    const payload = {
      limit,
      candidates: defs.map(d => ({
        key: d.key,
        tableName: d.tableName,
        type: d.type,
        xCol: d.xCol,
        yCol: d.yCol,
        score: d.score
      }))
    };

    const res = await fetch(`${API}/api/recommend-visuals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.visuals) ? data.visuals : [];
  } catch (_) {
    return [];
  }
}

// ── Smart chart gallery (uses /api/charts/:tableName pipeline) ────────────────
async function renderSmartCharts(tableNames, containerId, maxCharts, samplesForFallback = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px">Selecting best charts…</div>';

  const allDefs = [];

  await Promise.all(tableNames.slice(0, 6).map(async tableName => {
    try {
      const res = await fetch(`${API}/api/charts/${encodeURIComponent(tableName)}`);
      if (!res.ok) return;
      const data = await res.json();
      for (const c of (data.charts || [])) {
        allDefs.push({ ...c, tableName, key: chartDefKey({ ...c, tableName }) });
      }
    } catch (_) {}
  }));

  // Sort by score descending and then run AI/global diversity selection.
  allDefs.sort((a, b) => b.score - a.score);
  const aiRecommended = await fetchTopVisualRecommendations(allDefs, maxCharts);
  const byKey = new Map(allDefs.map(d => [d.key, d]));
  const selected = [];
  const seen = new Set();

  aiRecommended.forEach(item => {
    const key = String(item?.key || '').trim();
    const def = byKey.get(key);
    if (!def || seen.has(key) || selected.length >= maxCharts) return;
    selected.push(def);
    seen.add(key);
  });

  if (selected.length < maxCharts) {
    deterministicTopVisuals(allDefs, maxCharts).forEach(def => {
      if (selected.length >= maxCharts) return;
      if (seen.has(def.key)) return;
      selected.push(def);
      seen.add(def.key);
    });
  }

  container.innerHTML = '';
  let count = 0;

  for (const def of selected.slice(0, maxCharts)) {
    const cid  = `sc_${containerId}_${def.tableName.replace(/[^a-z0-9]/gi,'_')}_${count}`;
    const title = def.option?.title?.text || `${(def.yCol||'').replace(/_/g,' ')} by ${(def.xCol||'').replace(/_/g,' ')}`;
    const sub   = '';

    buildChartCard({
      container,
      chartId: cid,
      title,
      sub,
      option: def.option,
      summaryMeta: {
        title,
        subtitle: sub,
        type: def.type,
        tableName: def.tableName,
        xCol: def.xCol,
        yCol: def.yCol
      },
      delayIndex: count
    });

    count++;
  }

  if (!count) {
    // Fallback path: build deterministic charts from sampled rows if smart scoring yields none.
    count = renderAutoCharts(samplesForFallback, containerId, maxCharts);
    if (!container.children.length) {
      container.innerHTML = '<div class="rel-map-empty">No chart-able data found in loaded tables.</div>';
    }
  }

  return count;
}

// ── Auto-chart gallery ────────────────────────────────────────────────────────
function isNumericType(t) {
  return /^(INTEGER|INT|BIGINT|DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC|HUGEINT|UBIGINT|TINYINT|SMALLINT|UINTEGER|USMALLINT|UTINYINT|INT4|INT8|INT2|NUMBER|MONEY)/i.test(String(t).trim());
}
function colIsNumeric(col, rows) {
  if (isNumericType(col.type)) return true;
  // Fallback: check actual row values (inferType returns VARCHAR for first-row nulls)
  return rows.slice(0, 10).some(r => typeof r[col.name] === 'number' && r[col.name] !== null);
}
function colIsDate(col, rows) {
  if (/date|time|period|month|year/i.test(col.name)) return true;
  if (/^(DATE|TIMESTAMP|TIME)/i.test(col.type||'')) return true;
  const sample = rows.find(r => r[col.name] != null)?.[col.name];
  return typeof sample === 'string' && /^\d{4}-\d{2}/.test(sample);
}

function renderAutoCharts(samples, containerId, maxCharts) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  let count = 0;

  for (const [name, d] of Object.entries(samples)) {
    if (count >= maxCharts) break;
    const cols = d.columns || [];
    const rows = d.rows    || [];
    if (!rows.length) continue;

    const numCols  = cols.filter(c => colIsNumeric(c, rows));
    const dateCols = cols.filter(c => colIsDate(c, rows));
    const catCols  = cols.filter(c =>
      !numCols.find(n=>n.name===c.name) &&
      !dateCols.find(n=>n.name===c.name) &&
      rows.some(r => r[c.name] !== null && r[c.name] !== undefined && r[c.name] !== '')
    );

    // Collect chart definitions for this table
    const charts = [];

    // 1. Time-series per numeric column (up to 3)
    if (dateCols.length && numCols.length) {
      const xCol = dateCols[0].name;
      numCols.slice(0, 3).forEach((nc, ni) => {
        const byPeriod = {};
        rows.forEach(r => {
          const k = String(r[xCol]||'').slice(0, 7);
          if (!byPeriod[k]) byPeriod[k] = [];
          byPeriod[k].push(+r[nc.name] || 0);
        });
        const keys = Object.keys(byPeriod).filter(k => k.length >= 4).sort().slice(-24);
        if (keys.length < 2) return;
        const vals = keys.map(k => { const a = byPeriod[k]; return +(a.reduce((s,v)=>s+v,0)/a.length).toFixed(2); });
        charts.push({
          title: `${nc.name.replace(/_/g,' ')} over time`,
          sub:   `Monthly avg · ${rows.length} records · ${name}`,
          option: buildLineOption(keys, [{ name: nc.name.replace(/_/g,' '), data: vals, color: DARK_COLORS[ni] }])
        });
      });
    }

    // 2. Bar/Donut per categorical × numeric (up to 4 combos)
    if (catCols.length && numCols.length) {
      catCols.slice(0, 2).forEach(cc => {
        numCols.slice(0, 2).forEach((nc, ni) => {
          const groups = {};
          rows.forEach(r => { const k = String(r[cc.name]||'?'); if(!groups[k]) groups[k]=[]; groups[k].push(+r[nc.name]||0); });
          const keys = Object.keys(groups).slice(0, 15);
          if (keys.length < 2) return;
          const vals = keys.map(k => +(groups[k].reduce((a,b)=>a+b,0)/groups[k].length).toFixed(2));
          const uniq = Object.keys(groups).length;
          charts.push({
            title: `${nc.name.replace(/_/g,' ')} by ${cc.name.replace(/_/g,' ')}`,
            sub:   `${uniq} categor${uniq===1?'y':'ies'} · ${name}`,
            option: uniq <= 6 ? buildDonutOption(keys, vals) : buildBarOption(keys, vals)
          });
        });
      });
    }

    // 3. Scatter for top 2 numeric cols (when we still need more charts)
    if (numCols.length >= 2) {
      numCols.slice(0, numCols.length - 1).slice(0, 3).forEach((nc, i) => {
        const nc2 = numCols[i + 1];
        charts.push({
          title: `${nc.name.replace(/_/g,' ')} vs ${nc2.name.replace(/_/g,' ')}`,
          sub:   `${rows.length} data points · ${name}`,
          option: buildScatterOption(rows, nc.name, nc2.name)
        });
      });
    }

    // 4. Histogram for numeric columns (distribution)
    numCols.slice(0, 3).forEach((nc, ni) => {
      const vals = rows.map(r => +r[nc.name]).filter(v => Number.isFinite(v));
      if (vals.length < 5) return;
      const min = Math.min(...vals), max = Math.max(...vals);
      if (min === max) return;
      const bc   = Math.min(12, Math.max(5, Math.round(Math.sqrt(vals.length))));
      const step = (max - min) / bc;
      const buckets = Array(bc).fill(0);
      vals.forEach(v => buckets[Math.min(bc-1, Math.floor((v-min)/step))]++);
      const labels = buckets.map((_, i) => (min+i*step).toFixed(1));
      charts.push({
        title: `${nc.name.replace(/_/g,' ')} distribution`,
        sub:   `${vals.length} values · ${name}`,
        option: buildBarOption(labels, buckets)
      });
    });

    // Render up to maxCharts total, pulling from this table's chart list
    for (const chartDef of charts) {
      if (count >= maxCharts) break;
      const chartId = `ac_${name.replace(/[^a-z0-9]/gi,'_')}_${count}`;
      buildChartCard({
        container,
        chartId,
        title: chartDef.title,
        sub: '',
        option: chartDef.option,
        summaryMeta: {
          title: chartDef.title,
          subtitle: '',
          type: (chartDef.option?.series?.[0]?.type || '').toLowerCase(),
          tableName: name,
          xCol: '',
          yCol: ''
        },
        delayIndex: count
      });

      count++;
    }
  }

  if (!count) container.innerHTML = '<div class="rel-map-empty">No chart-able data found in loaded tables.</div>';
  return count;
}

// ── ECharts option builders (light theme — Fuchsian/Aquamarine palette) ───────
const DARK_COLORS = ['#6F42C1','#007BFF','#00CCCC','#0DCAF0','#17A2B8','#6c757d'];

const DARK_GRID  = { top:16, right:16, bottom:48, left:16, containLabel:true };
const DARK_AXIS  = { axisLine:{lineStyle:{color:'#E5E7EB'}}, splitLine:{lineStyle:{color:'#F3F4F6'}}, axisLabel:{color:'#6B7280',fontSize:11} };
const DARK_TIP   = { trigger:'axis', backgroundColor:'#FFFFFF', borderColor:'#E5E7EB', textStyle:{color:'#111827',fontSize:12} };
const DARK_LEGEND= { textStyle:{color:'#4B5563'} };

function buildLineOption(xData, series) {
  return {
    grid: DARK_GRID, tooltip: DARK_TIP, legend: DARK_LEGEND,
    xAxis: { type:'category', data:xData, ...DARK_AXIS, axisLabel:{...DARK_AXIS.axisLabel, rotate:xData.length>8?30:0} },
    yAxis: { type:'value', ...DARK_AXIS },
    series: series.map((s,i) => ({
      name:s.name, type:'line', data:s.data, smooth:true,
      lineStyle:{width:2,color:s.color||DARK_COLORS[i]},
      itemStyle:{color:s.color||DARK_COLORS[i]},
      areaStyle:{color:s.color||DARK_COLORS[i], opacity:0.06},
      symbol:'circle', symbolSize:4
    }))
  };
}

function buildBarOption(xData, yData) {
  return {
    grid: DARK_GRID, tooltip: DARK_TIP,
    xAxis: { type:'category', data:xData, ...DARK_AXIS, axisLabel:{...DARK_AXIS.axisLabel, rotate:xData.length>6?35:0} },
    yAxis: { type:'value', ...DARK_AXIS },
    series: [{
      type:'bar', data:yData,
      itemStyle:{borderRadius:[4,4,0,0], color: {
        type:'linear', x:0,y:0,x2:0,y2:1,
        colorStops:[{offset:0,color:'#9d71d9'},{offset:1,color:'#6F42C1'}]
      }},
      label:{
        show: xData.length<=10,
        position:'top',
        color:'#6B7280',
        fontSize:10,
        formatter: p => (Number.isFinite(+p.value) ? (+p.value).toFixed(2) : p.value)
      }
    }]
  };
}

function buildHorizontalBarOption(labels, values) {
  return {
    grid: { ...DARK_GRID, left: 40, right: 20, bottom: 20, top: 20 },
    tooltip: DARK_TIP,
    xAxis: { type:'value', ...DARK_AXIS },
    yAxis: { type:'category', data: labels, ...DARK_AXIS, axisLabel:{...DARK_AXIS.axisLabel, width: 120, overflow: 'truncate'} },
    series: [{
      type:'bar',
      data: values,
      itemStyle:{borderRadius:[0,4,4,0], color: {
        type:'linear', x:0,y:0,x2:1,y2:0,
        colorStops:[{offset:0,color:'#9d71d9'},{offset:1,color:'#6F42C1'}]
      }},
      label:{
        show: labels.length<=10,
        position:'right',
        color:'#6B7280',
        fontSize:10,
        formatter: p => (Number.isFinite(+p.value) ? (+p.value).toFixed(2) : p.value)
      }
    }]
  };
}

function buildAreaOption(labels, values, seriesName = 'Value') {
  return {
    grid: DARK_GRID, tooltip: DARK_TIP, legend: DARK_LEGEND,
    xAxis: { type:'category', data:labels, ...DARK_AXIS, axisLabel:{...DARK_AXIS.axisLabel, rotate:labels.length>8?30:0} },
    yAxis: { type:'value', ...DARK_AXIS },
    series: [{
      name: seriesName,
      type:'line',
      data: values,
      smooth:true,
      lineStyle:{ width:2, color:DARK_COLORS[0] },
      itemStyle:{ color:DARK_COLORS[0] },
      areaStyle:{
        color: {
          type:'linear', x:0, y:0, x2:0, y2:1,
          colorStops:[
            { offset:0, color:'rgba(111,66,193,0.35)' },
            { offset:1, color:'rgba(111,66,193,0.04)' }
          ]
        }
      },
      symbol:'circle',
      symbolSize:4
    }]
  };
}

function buildDonutOption(labels, values) {
  return {
    tooltip: { trigger:'item', backgroundColor:'#FFFFFF', borderColor:'#E5E7EB', textStyle:{color:'#111827'} },
    legend: { orient:'vertical', right:10, top:'center', ...DARK_LEGEND },
    series: [{
      type:'pie', radius:['40%','70%'], center:['40%','50%'],
      data: labels.map((l,i) => ({ name:l, value:values[i], itemStyle:{color:DARK_COLORS[i%DARK_COLORS.length]} })),
      label:{ color:'#6B7280', fontSize:11 },
      labelLine:{lineStyle:{color:'#E5E7EB'}}
    }]
  };
}

function buildRoseOption(labels, values) {
  return {
    tooltip: { trigger:'item', backgroundColor:'#FFFFFF', borderColor:'#E5E7EB', textStyle:{color:'#111827'} },
    legend: { orient:'vertical', right:10, top:'center', ...DARK_LEGEND },
    series: [{
      type:'pie',
      roseType:'radius',
      radius:['20%','72%'],
      center:['40%','50%'],
      data: labels.map((l,i) => ({ name:l, value:values[i], itemStyle:{color:DARK_COLORS[i%DARK_COLORS.length]} })),
      label:{ color:'#6B7280', fontSize:11 },
      labelLine:{ lineStyle:{ color:'#E5E7EB' } }
    }]
  };
}

function buildScatterOption(rows, xCol, yCol) {
  return {
    grid: DARK_GRID, tooltip: DARK_TIP,
    xAxis: { type:'value', name:xCol.replace(/_/g,' '), nameLocation:'middle', nameGap:25, ...DARK_AXIS },
    yAxis: { type:'value', name:yCol.replace(/_/g,' '), nameLocation:'middle', nameGap:40, ...DARK_AXIS },
    series: [{
      type:'scatter',
      data: rows.map(r => [+r[xCol]||0, +r[yCol]||0]),
      itemStyle:{ color:'#007BFF', opacity:0.6 },
      symbolSize: 6
    }]
  };
}

// ── Table explorer ────────────────────────────────────────────────────────────
function populateTableSelector(names) {
  const sel = document.getElementById('tableSelector');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select a table…</option>' +
    names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
}

// Format cell value: handle dates, numbers, and special types
function formatTableCell(value, colName) {
  if (value === null || value === undefined || value === '') return '';

  // Check if column is a date/time column
  const isDateCol = /date|time|start|end|month|week|year|quarter/i.test(colName);

  if (isDateCol) {
    // Handle Excel serial dates (numbers like 46023)
    if (typeof value === 'number' && value > 100 && value < 100000) {
      const excelDate = new Date((value - 25569) * 86400 * 1000);
      if (!isNaN(excelDate.getTime())) {
        return excelDate.toISOString().split('T')[0];
      }
    }
    // Handle ISO format dates (2026-01-01)
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      return value.split('T')[0];
    }
  }

  // Format large numbers with commas
  if (typeof value === 'number' && !isDateCol && Math.abs(value) >= 1000) {
    return value.toLocaleString();
  }

  return String(value);
}

async function loadTableExplorer(tableName) {
  const el = document.getElementById('tableExplorerContent');
  if (!el || !tableName) return;
  el.innerHTML = '<div style="padding:16px;color:var(--text-muted)">Loading…</div>';

  try {
    const res  = await fetch(`${API}/api/execute-sql`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sql: `SELECT * FROM "${tableName}" LIMIT 200` })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const cols = (data.columns||[]).slice(0, 15);
    const rows = data.rows || [];
    const meta = loadedTables[tableName] || {};

    const numTypes = ['INTEGER','BIGINT','DOUBLE','FLOAT','REAL'];
    const isNum    = c => numTypes.some(t => (c.type||'').toUpperCase().startsWith(t));
    const isDate   = c => /date|time|start|end|month|week|year|quarter/i.test(c.name);

    // Compute per-column min/max for numeric heat (skip dates)
    const colStats = {};
    cols.forEach(c => {
      // Skip date columns — their min/max are Excel serial numbers (meaningless to display)
      if (isDate(c)) return;

      const vals = rows.map(r => +r[c.name]).filter(v => !isNaN(v));
      if (vals.length && isNum(c)) {
        colStats[c.name] = { min: Math.min(...vals), max: Math.max(...vals) };
      }
    });

    el.innerHTML = `
      <table class="db-data-table">
        <thead><tr>${cols.map(c => `<th title="${escapeHtml(c.type||'')}">
          ${isNum(c)?'🔢':isDate(c)?'📅':'🔤'} ${escapeHtml(c.name)}
          ${colStats[c.name] ? `<br><small style="font-weight:400;color:var(--text-muted)">${colStats[c.name].min.toFixed(1)}–${colStats[c.name].max.toFixed(1)}</small>` : ''}
        </th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr>${cols.map(c => {
          const v = r[c.name];
          const s = colStats[c.name];
          let style = '';
          // Only apply heatmap highlight for numeric (non-date) columns
          if (s && !isNaN(+v) && !isDate(c)) {
            const pct = s.max === s.min ? 0.5 : (+v - s.min) / (s.max - s.min);
            style = `background:rgba(111,66,193,${(pct*0.18).toFixed(2)})`;
          }
          const displayVal = formatTableCell(v, c.name);
          return `<td style="${style}" title="${escapeHtml(displayVal)}">${escapeHtml(displayVal)}</td>`;
        }).join('')}</tr>`).join('')}</tbody>
      </table>
      <div class="table-row-count">Showing ${rows.length} of ${(meta.rowCount||0).toLocaleString()} rows · ${cols.length} columns</div>`;

    document.getElementById('tableSelector').value = tableName;
  } catch (e) {
    el.innerHTML = `<div style="padding:16px;color:var(--accent-red)">Error: ${escapeHtml(e.message)}</div>`;
  }
}

// ── Query history ─────────────────────────────────────────────────────────────
function renderHistory() {
  const el = document.getElementById('historyList');
  if (!el) return;
  let history = [];
  try { history = JSON.parse(localStorage.getItem('convbi_history') || '[]'); } catch (_) {}
  el.innerHTML = history.slice(0, 20).map(h => `
    <div class="db-history-item" onclick="restoreQuestion('${escapeHtml(h.q)}')">
      <div class="db-history-q">${escapeHtml(h.q)}</div>
      <div class="db-history-preview">${escapeHtml((h.summary||'').slice(0,80))}</div>
      <div class="db-history-ts">${new Date(h.ts).toLocaleString()}</div>
    </div>`).join('') || '<div style="padding:8px;color:var(--text-muted);font-size:12px">No history yet</div>';
}

function restoreQuestion(q) {
  window.open(`/?q=${encodeURIComponent(q)}`, '_self');
}

// ── Saved insights ────────────────────────────────────────────────────────────
function renderInsights() {
  const el = document.getElementById('insightsList');
  if (!el) return;
  let insights = [];
  try { insights = JSON.parse(localStorage.getItem('convbi_insights') || '[]'); } catch (_) {}
  el.innerHTML = insights.slice(0, 30).map(i => `
    <div class="insight-item">
      <div class="insight-q">${escapeHtml(i.question)}</div>
      <div class="insight-summary">${escapeHtml(i.summary)}</div>
      <div class="insight-ts">${new Date(i.ts).toLocaleString()}</div>
    </div>`).join('') || '<div class="rel-map-empty">No pinned insights yet — click 📌 Pin on any answer in the chat.</div>';
}

function exportInsights() {
  let insights = [];
  try { insights = JSON.parse(localStorage.getItem('convbi_insights') || '[]'); } catch (_) {}
  if (!insights.length) { alert('No insights to export.'); return; }
  const text = insights.map(i => `Q: ${i.question}\nA: ${i.summary}\n---`).join('\n\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const a    = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'convbi_insights.txt' });
  a.click();
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Window resize: update all echarts ────────────────────────────────────────
window.addEventListener('resize', () => allCharts.forEach(c => { try { c.resize(); } catch (_) {} }));

// ── Listen for main app updates ───────────────────────────────────────────────
window.addEventListener('storage', e => {
  if (e.key === 'convbi_tables_updated') loadDashboard();
});

// Restore sidebar state from localStorage
(function() {
  if (localStorage.getItem('sidebarCollapsed') === 'true') {
    sidebarOpen = false;
    document.getElementById('sidebar')?.classList.add('collapsed');
    document.body.classList.add('sidebar-collapsed');
    const btn = document.getElementById('sidebarToggle');
    if (btn) btn.textContent = '›';
  }
})();

// Ctrl+B toggles sidebar (VS Code style)
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadDashboard();
