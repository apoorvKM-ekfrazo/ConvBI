let parsedRows = [];       // raw CSV parsed rows (before loadToAnalytics)
let pendingCsvFiles = [];  // staged File objects for multi-CSV upload
let shiftData = [];        // active dataset rows (backward-compat alias)
let charts = {};
let pendingClarification = null; // { originalQuestion, decoded } — set when LLM asks for clarification

// ── Multi-dataset state ───────────────────────────────────────────────────────
// Each entry: { id, name, source, color, data, schema, rowCount }
let loadedDatasets = [];
const DS_COLORS = ['#4F46E5','#0EA5E9','#059669','#D97706','#DC2626','#7C3AED','#EC4899','#0D9488'];

// Databricks browser state
let dbBrowserState = { catalog: null, schema: null, table: null };

// Populated by loadToAnalytics(); used by all schema-aware functions
let dataSchema = {
  dateCol: null,        // name of the date column
  numericCols: [],      // names of numeric columns
  categoricalCols: [],  // names of low-cardinality string columns
  textCols: [],         // names of free-text string columns
  derivedCols: [],      // computed metric names (e.g. 'efficiency')
  allCols: [],          // all column names (original CSV headers)
  primaryGroupCol: null // first categorical column — main grouping axis
};

const TEMPLATE_COLS = ['date','shift','target_units','actual_units','wastage_units','downtime_minutes','headcount','machine_utilisation_pct','remarks'];

function downloadTemplate() {
  const sample = [
    TEMPLATE_COLS.join(','),
    '2024-04-15,A,1000,940,32,20,25,88,Good run',
    '2024-04-15,B,1000,870,55,45,24,79,Machine 3 issue',
    '2024-04-15,C,1000,910,28,15,23,91,Smooth night',
    '2024-04-16,A,1000,960,20,10,25,93,',
    '2024-04-16,B,1000,900,40,30,24,85,',
    '2024-04-16,C,1000,880,60,50,23,80,Quality check delayed',
  ].join('\n');
  const blob = new Blob([sample], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'shift_data_template.csv';
  a.click();
}

function onDragOver(e) { e.preventDefault(); document.getElementById('dropZone').classList.add('drag-over'); }
function onDragLeave(e) { document.getElementById('dropZone').classList.remove('drag-over'); }
function onDrop(e) { e.preventDefault(); document.getElementById('dropZone').classList.remove('drag-over'); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }

function handleFile(file) {
  if (!file || !file.name.endsWith('.csv')) { showError('Please upload a .csv file.'); return; }
  const reader = new FileReader();
  reader.onload = e => parseCSV(e.target.result, file.name.replace(/\.csv$/i, ''));
  reader.readAsText(file);
}

function handleFiles(files) {
  if (!files || !files.length) return;
  for (const f of Array.from(files)) {
    if (!f.name.endsWith('.csv')) continue;
    const reader = new FileReader();
    const name = f.name.replace(/\.csv$/i, '');
    reader.onload = e => parseCSV(e.target.result, name);
    reader.readAsText(f);
  }
}

function parseCSVLine(line) {
  const result = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { field += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(field.trim());
      field = '';
    } else {
      field += ch;
    }
  }
  result.push(field.trim());
  return result;
}

function parseCSV(text, datasetName) {
  hideError();
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) { showError('CSV must have a header row and at least one data row.'); return; }

  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,''));
  if (!headers.length) { showError('Could not parse headers from the CSV file.'); return; }

  const rows = lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] !== undefined ? vals[i] : '').trim(); });
    return row;
  }).filter(r => Object.values(r).some(v => v !== ''));

  if (!rows.length) { showError('No valid data rows found. Check that the CSV is not empty.'); return; }

  const name = datasetName || ('Dataset ' + (loadedDatasets.length + pendingCsvFiles.length + 1));
  // Store as pending CSV file with pre-parsed rows
  pendingCsvFiles.push({ name, rows, headers });

  // Show preview for the most-recently parsed file
  renderPreview(headers, rows);
  document.getElementById('previewSection').style.display = 'block';
  document.getElementById('rowCount').textContent =
    rows.length + ' rows • "' + name + '"' + (pendingCsvFiles.length > 1 ? ' (+' + (pendingCsvFiles.length - 1) + ' more staged)' : '');
  document.getElementById('loadBtn') && (document.getElementById('loadBtn').textContent =
    'Load ' + pendingCsvFiles.length + ' file' + (pendingCsvFiles.length > 1 ? 's' : '') + ' into analytics');
}

function renderPreview(headers, rows) {
  // Show at most 12 columns; if more, truncate to keep the table readable
  const show = headers.slice(0, 12);
  const table = document.getElementById('previewTable');
  const preview = rows.slice(0, 8);
  table.innerHTML = `
    <thead><tr>${show.map(h => `<th>${h.replace(/_/g,' ')}</th>`).join('')}${headers.length > 12 ? '<th>…</th>' : ''}</tr></thead>
    <tbody>${preview.map(r => `<tr>${show.map(h => `<td>${r[h]||''}</td>`).join('')}${headers.length > 12 ? '<td>…</td>' : ''}</tr>`).join('')}</tbody>
  `;
}

// ─── Column-type auto-detection ──────────────────────────────────────────────

function _detectDateCol(headers, rows) {
  const sample = rows.slice(0, 30);
  for (const h of headers) {
    const vals = sample.map(r => (r[h] || '').trim()).filter(Boolean);
    if (!vals.length) continue;
    const hits = vals.filter(v => normalizeDateString(v) !== null).length;
    if (hits >= vals.length * 0.8) return h;
  }
  return null;
}

function _detectNumericCols(headers, rows, excludeCol) {
  const sample = rows.slice(0, 30);
  return headers.filter(h => {
    if (h === excludeCol) return false;
    const vals = sample.map(r => (r[h] || '').trim()).filter(Boolean);
    if (!vals.length) return false;
    const numHits = vals.filter(v => !isNaN(parseFloat(v)) && isFinite(v)).length;
    return numHits >= vals.length * 0.8;
  });
}

function _detectCategoricalCols(headers, rows, excludeCols) {
  return headers.filter(h => {
    if (excludeCols.includes(h)) return false;
    const vals = rows.map(r => (r[h] || '').trim()).filter(Boolean);
    if (!vals.length) return false;
    const unique = new Set(vals.map(v => v.toLowerCase())).size;
    return unique >= 1 && unique <= 50;
  });
}

// ─── Multi-dataset management ──────────────────────────────────────────────────

function addDataset(name, source, rows) {
  const headers = Object.keys(rows[0] || {});
  const dateCol  = _detectDateCol(headers, rows);
  const numCols  = _detectNumericCols(headers, rows, dateCol);
  const catCols  = _detectCategoricalCols(headers, rows, [dateCol, ...numCols].filter(Boolean));
  const textCols = headers.filter(h => h !== dateCol && !numCols.includes(h) && !catCols.includes(h));
  const derived  = [];

  const processed = rows.map(r => {
    const row = {};
    headers.forEach(h => {
      if (h === dateCol) row[h] = normalizeDateString(r[h]) || (r[h] || '').trim();
      else if (numCols.includes(h)) { const v = parseFloat(r[h]); row[h] = isNaN(v) ? 0 : v; }
      else row[h] = (r[h] || '').trim();
    });
    const actualVal = row['actual_units'] ?? row['actual'];
    const targetVal = row['target_units'] ?? row['target'];
    const wastageVal = row['wastage_units'] ?? row['wastage'];
    const headcntVal = row['headcount'];
    if (actualVal !== undefined && targetVal !== undefined && !('efficiency' in row)) {
      row['efficiency'] = targetVal > 0 ? Math.round((actualVal / targetVal) * 100) : null;
      if (!derived.includes('efficiency')) derived.push('efficiency');
    }
    if (actualVal !== undefined && wastageVal !== undefined && !('wastage_rate' in row)) {
      row['wastage_rate'] = (actualVal + wastageVal) > 0
        ? parseFloat(((wastageVal / (actualVal + wastageVal)) * 100).toFixed(1)) : 0;
      if (!derived.includes('wastage_rate')) derived.push('wastage_rate');
    }
    if (actualVal !== undefined && headcntVal !== undefined && headcntVal > 0 && !('productivity' in row)) {
      row['productivity'] = parseFloat((actualVal / headcntVal).toFixed(1));
      if (!derived.includes('productivity')) derived.push('productivity');
    }
    return row;
  }).filter(r => !dateCol || (r[dateCol] && r[dateCol].trim() !== ''));

  catCols.forEach(col => {
    const sample = processed.slice(0, 10).map(r => r[col]).filter(Boolean);
    if (sample.every(v => v.length === 1)) processed.forEach(r => { if (r[col]) r[col] = r[col].toUpperCase(); });
  });

  const schema = {
    dateCol, numericCols: numCols, categoricalCols: catCols,
    textCols, derivedCols: derived,
    allCols: headers, primaryGroupCol: catCols[0] || null
  };

  const existing = loadedDatasets.find(d => d.name === name);
  if (existing) {
    existing.data   = processed;
    existing.schema = schema;
    existing.rowCount = processed.length;
    existing.source = source;
  } else {
    const id = 'ds_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    loadedDatasets.push({
      id, name, source,
      color: DS_COLORS[loadedDatasets.length % DS_COLORS.length],
      data: processed, schema, rowCount: processed.length
    });
  }
}

function setActiveDataset(id) {
  const ds = id ? loadedDatasets.find(d => d.id === id) : loadedDatasets[0];
  if (!ds) return;
  shiftData  = ds.data;
  dataSchema = ds.schema;
  // Mark active in the list
  loadedDatasets.forEach(d => d.active = (d.id === ds.id));
  renderDatasetList();
  renderDashboard();
}

function getActiveDataset() {
  return loadedDatasets.find(d => d.active) || loadedDatasets[0];
}

function removeDataset(id) {
  loadedDatasets = loadedDatasets.filter(d => d.id !== id);
  if (!loadedDatasets.length) {
    shiftData  = [];
    dataSchema = { dateCol: null, numericCols: [], categoricalCols: [], textCols: [], derivedCols: [], allCols: [], primaryGroupCol: null };
    document.getElementById('dashContent').innerHTML = '<div class="no-data">No data yet — upload a CSV or load a Databricks table.</div>';
    document.getElementById('messages').innerHTML = '';
  } else {
    setActiveDataset(null);
  }
  renderDatasetList();
}

function renderDatasetList() {
  const sec = document.getElementById('loadedDatasetsSection');
  const list = document.getElementById('datasetsList');
  if (!sec || !list) return;
  if (!loadedDatasets.length) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  list.innerHTML = loadedDatasets.map(ds => `
    <div class="ds-item ${ds.active ? 'ds-active' : ''}" onclick="setActiveDataset('${ds.id}')">
      <span class="ds-dot" style="background:${ds.color}"></span>
      <span class="ds-name">${escapeHtml(ds.name)}</span>
      <span class="ds-badge ds-badge-${ds.source}">${ds.source === 'databricks' ? '🔷' : '📄'} ${ds.source}</span>
      <span class="ds-rows">${ds.rowCount.toLocaleString()} rows</span>
      ${ds.active ? '<span class="ds-active-tag">active</span>' : ''}
      <button class="ds-remove" onclick="event.stopPropagation();removeDataset('${ds.id}')" title="Remove">✕</button>
    </div>`).join('');
}

function buildMultiTableContext() {
  if (loadedDatasets.length <= 1) return null;
  const tables = {};
  loadedDatasets.forEach(ds => { tables[ds.name] = ds.data; });
  return tables;
}

function buildMultiTableSemanticRules() {
  if (loadedDatasets.length <= 1) return null;
  let rules = `MULTI-TABLE CONTEXT — ${loadedDatasets.length} tables are loaded.\n`;
  rules += `The primary/active table is in \`data\` (table: "${getActiveDataset()?.name}").\n`;
  rules += `All tables are available via the \`tables\` object:\n`;
  loadedDatasets.forEach(ds => {
    const s = ds.schema;
    rules += `  tables["${ds.name}"] — ${ds.rowCount} rows`;
    if (s.dateCol) rules += `, date: ${s.dateCol}`;
    if (s.primaryGroupCol) rules += `, group: ${s.primaryGroupCol}`;
    const metrics = [...s.numericCols, ...s.derivedCols].slice(0, 4);
    if (metrics.length) rules += `, metrics: ${metrics.join(', ')}`;
    rules += '\n';
  });
  rules += '\nCROSS-TABLE JOIN pattern:\n';
  rules += '  const joined = tables["tableA"].map(a => ({ ...a, ...tables["tableB"].find(b => b.key === a.key) })).filter(r => r.key !== undefined);\n';
  rules += 'Use the table name from the user\'s question to pick the right table from `tables`.';
  return rules;
}

// ─── Data loader ──────────────────────────────────────────────────────────────

function loadToAnalytics() {
  if (!pendingCsvFiles.length) return;
  // Process all staged CSV files into named datasets
  pendingCsvFiles.forEach(({ name, rows }) => addDataset(name, 'csv', rows));
  const added = pendingCsvFiles.length;
  pendingCsvFiles = [];
  // Activate the first (or first new) dataset
  const firstNew = loadedDatasets.find(d => !d.active);
  setActiveDataset(firstNew ? firstNew.id : null);
  renderDatasetList();
  const total = loadedDatasets.reduce((a, d) => a + d.rowCount, 0);
  showSuccess(added + ' file' + (added > 1 ? 's' : '') + ' loaded — ' + total.toLocaleString() + ' total records. Switch to Dashboard or Ask Questions.');
  switchTab('dashboard');
}

function renderDashboard() {
  if (!shiftData.length && !loadedDatasets.length) return;
  const dc = document.getElementById('dashContent');
  if (!dc) return;
  // Multi-dataset tab bar
  let tabsHtml = '';
  if (loadedDatasets.length > 1) {
    tabsHtml = `<div class="ds-tab-bar">${loadedDatasets.map(ds =>
      `<button class="ds-tab ${ds.active ? 'ds-tab-active' : ''}" style="--ds-color:${ds.color}"
        onclick="setActiveDataset('${ds.id}')">${escapeHtml(ds.name)}<span class="ds-tab-rows">${ds.rowCount.toLocaleString()}</span></button>`
    ).join('')}</div>`;
  }
  dc.innerHTML = tabsHtml;
  if (!shiftData.length) return;
  const schema = dataSchema;

  const CHART_COLORS = ['#4F46E5','#0EA5E9','#059669','#D97706','#DC2626','#8B5CF6','#EC4899'];
  const CHART_DEFAULTS = { responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } } };

  const { dateCol, numericCols, categoricalCols, derivedCols } = schema;
  const groupCol   = schema.primaryGroupCol;
  // Exclude columns where every row has the same value — they add no insight to the dashboard
  const allMetrics = [...numericCols, ...derivedCols].filter(col => !isConstantCol(col));
  const rowCount   = shiftData.length;

  // Date range
  const dates = dateCol
    ? [...new Set(shiftData.map(d => d[dateCol]).filter(Boolean))].sort()
    : [];
  const dateRange = dates.length > 1 ? `${dates[0]} — ${dates[dates.length - 1]}` : (dates[0] || '');

  // Groups for the primary categorical column
  const groups = groupCol
    ? [...new Set(shiftData.map(r => r[groupCol]).filter(Boolean))].sort()
    : [];

  // Per-group aggregations for all metrics
  const byGroup = {};
  if (groupCol) {
    shiftData.forEach(r => {
      const k = r[groupCol] || 'Unknown';
      if (!byGroup[k]) byGroup[k] = [];
      byGroup[k].push(r);
    });
  }

  const groupAvg = (g, col) => {
    const vals = (byGroup[g] || []).map(r => r[col]).filter(v => typeof v === 'number' && v !== null && !isNaN(v));
    return vals.length ? parseFloat((vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1)) : null;
  };

  // ── Trend indicator helper: compare first vs second half of date range ──────
  const computeTrend = (col) => {
    if (!dateCol || dates.length < 4) return null;
    const mid = dates[Math.floor(dates.length / 2)];
    const firstHalf  = shiftData.filter(r => r[dateCol] <  mid).map(r => r[col]).filter(v => typeof v === 'number' && !isNaN(v));
    const secondHalf = shiftData.filter(r => r[dateCol] >= mid).map(r => r[col]).filter(v => typeof v === 'number' && !isNaN(v));
    if (!firstHalf.length || !secondHalf.length) return null;
    const avg1 = firstHalf.reduce((a,b)=>a+b,0)  / firstHalf.length;
    const avg2 = secondHalf.reduce((a,b)=>a+b,0) / secondHalf.length;
    const pct  = avg1 === 0 ? 0 : parseFloat(((avg2 - avg1) / Math.abs(avg1) * 100).toFixed(1));
    return { direction: pct > 1 ? 'up' : pct < -1 ? 'down' : 'flat', pct: Math.abs(pct) };
  };

  // ── Summary metric cards (first 3 non-constant numeric cols + record count) ──
  const metricColorClasses = ['metric-blue','metric-sky','metric-amber','metric-green','metric-rose','metric-violet'];
  const metricIcons        = ['📊','📈','🔢','📉','⚡','🎯'];
  const showMetrics = allMetrics.slice(0, 3);
  const metricCards = showMetrics.map((col, i) => {
    const vals = shiftData.map(r => r[col]).filter(v => typeof v === 'number' && !isNaN(v));
    const total = vals.reduce((a,b)=>a+b,0);
    const avg   = vals.length ? parseFloat((total/vals.length).toFixed(1)) : 0;
    const label = col.replace(/_/g,' ');
    const isRate = /rate|pct|percent|efficiency|utilisation|utilization/.test(col);
    const trend  = computeTrend(col);
    const trendHtml = trend
      ? trend.direction === 'up'
        ? `<div class="metric-trend trend-up">▲ ${trend.pct}% vs prior period</div>`
        : trend.direction === 'down'
          ? `<div class="metric-trend trend-down">▼ ${trend.pct}% vs prior period</div>`
          : `<div class="metric-trend trend-flat">→ Stable</div>`
      : '';
    return `<div class="metric ${metricColorClasses[i]}">
      <div class="metric-icon">${metricIcons[i]}</div>
      <div class="metric-label">${isRate ? 'Avg' : 'Total'} ${label}</div>
      <div class="metric-val">${isRate ? avg : (total >= 1000 ? Math.round(total).toLocaleString() : parseFloat(total.toFixed(1)))}</div>
      ${trendHtml}
      <div class="metric-sub">across ${vals.length} records</div>
    </div>`;
  });
  metricCards.push(`<div class="metric ${metricColorClasses[showMetrics.length % 6]}">
    <div class="metric-icon">📋</div>
    <div class="metric-label">Total Records</div>
    <div class="metric-val">${rowCount.toLocaleString()}</div>
    <div class="metric-sub">${groupCol ? groups.length + ' ' + groupCol.replace(/_/g,' ') + ' groups' : (dateRange || 'rows loaded')}</div>
  </div>`);

  // ── Anomaly detection helper: find groups whose value > mean + 2*stddev ─────
  const detectAnomalies = (vals) => {
    const nums = vals.filter(v => v !== null && typeof v === 'number');
    if (nums.length < 3) return { mean: null, stdDev: null, threshold: null };
    const mean = nums.reduce((a,b)=>a+b,0) / nums.length;
    const stdDev = Math.sqrt(nums.reduce((a,b)=>a+(b-mean)**2,0) / nums.length);
    return { mean: parseFloat(mean.toFixed(2)), stdDev: parseFloat(stdDev.toFixed(2)), threshold: mean + 2 * stdDev };
  };

  // ── Chart HTML slots ──
  let chartsHtml = '';
  const primaryMetric = allMetrics[0];

  if (groupCol && primaryMetric) {
    const groupVals   = groups.map(g => groupAvg(g, primaryMetric));
    const anomaly     = detectAnomalies(groupVals);
    const validPairs  = groups.map((g,i) => ({ g, v: groupVals[i] })).filter(x => x.v !== null);
    const topGroup    = validPairs.length ? validPairs.reduce((a,b) => a.v > b.v ? a : b) : null;
    const botGroup    = validPairs.length ? validPairs.reduce((a,b) => a.v < b.v ? a : b) : null;
    const insightText = topGroup && botGroup && topGroup.g !== botGroup.g
      ? `${topGroup.g} leads at ${parseFloat(topGroup.v.toFixed(1))} (highest). ${botGroup.g} is lowest at ${parseFloat(botGroup.v.toFixed(1))}.`
      : '';
    const title = `${primaryMetric.replace(/_/g,' ')} by ${groupCol.replace(/_/g,' ')}`;
    chartsHtml += `<div class="card dash-card">
      <div class="dash-card-title">${title}</div>
      <div class="chart-wrap" style="height:200px"><canvas id="dashGroupChart"></canvas></div>
      ${insightText ? `<div class="chart-insight"><span class="chart-insight-icon">💡</span>${escapeHtml(insightText)}</div>` : ''}
      <details class="dash-transparency">
        <summary class="dash-transparency-toggle">AI Analysis</summary>
        <div class="dash-transparency-body">
          <ol class="dash-analysis-steps">
            <li>Grouped ${rowCount} records by <strong>${groupCol.replace(/_/g,' ')}</strong></li>
            <li>Computed average <strong>${primaryMetric.replace(/_/g,' ')}</strong> per group</li>
            <li>Bars exceeding mean + 2σ (threshold: ${anomaly.threshold !== null ? parseFloat(anomaly.threshold.toFixed(1)) : 'n/a'}) highlighted in orange</li>
          </ol>
          <details class="code-details"><summary class="code-toggle">⟨/⟩ View generated code</summary><pre class="code-pre">// Group average: ${primaryMetric}
const grouped = {};
data.forEach(r => { grouped[r.${groupCol}] = grouped[r.${groupCol}] || []; grouped[r.${groupCol}].push(r); });
const answer = Object.entries(grouped).map(([g, rows]) => ({
  group: g,
  avg: rows.reduce((s,r) => s + r.${primaryMetric}, 0) / rows.length
}));</pre></details>
        </div>
      </details>
    </div>`;
  }

  // Two side-by-side charts for metrics 2 & 3 (if groupCol available)
  const sideMetrics = allMetrics.slice(1, 3).filter(Boolean);
  if (groupCol && sideMetrics.length) {
    chartsHtml += `<div class="dash-2col">`;
    sideMetrics.forEach((col, i) => {
      const sideVals   = groups.map(g => groupAvg(g, col));
      const sideAnom   = detectAnomalies(sideVals);
      const sidePairs  = groups.map((g,j) => ({ g, v: sideVals[j] })).filter(x => x.v !== null);
      const sideTop    = sidePairs.length ? sidePairs.reduce((a,b) => a.v > b.v ? a : b) : null;
      const sideBot    = sidePairs.length ? sidePairs.reduce((a,b) => a.v < b.v ? a : b) : null;
      const sideInsight = sideTop && sideBot && sideTop.g !== sideBot.g
        ? `${sideTop.g} highest (${parseFloat(sideTop.v.toFixed(1))}), ${sideBot.g} lowest (${parseFloat(sideBot.v.toFixed(1))}).`
        : '';
      chartsHtml += `<div class="card dash-card">
        <div class="dash-card-title">${col.replace(/_/g,' ')} by ${groupCol.replace(/_/g,' ')}</div>
        <div class="chart-wrap" style="height:180px"><canvas id="dashSide${i}Chart"></canvas></div>
        ${sideInsight ? `<div class="chart-insight"><span class="chart-insight-icon">💡</span>${escapeHtml(sideInsight)}</div>` : ''}
        <details class="dash-transparency">
          <summary class="dash-transparency-toggle">AI Analysis</summary>
          <div class="dash-transparency-body">
            <ol class="dash-analysis-steps">
              <li>Grouped by <strong>${groupCol.replace(/_/g,' ')}</strong>, averaged <strong>${col.replace(/_/g,' ')}</strong></li>
              <li>Anomaly threshold (mean + 2σ): ${sideAnom.threshold !== null ? parseFloat(sideAnom.threshold.toFixed(1)) : 'n/a'}</li>
            </ol>
          </div>
        </details>
      </div>`;
    });
    chartsHtml += `</div>`;
  }

  // Trend chart (date + numeric col)
  if (dateCol && primaryMetric) {
    const trendTitle = `${primaryMetric.replace(/_/g,' ')} Trend${groupCol ? ' by ' + groupCol.replace(/_/g,' ') : ''}`;
    const trendInsight = (() => {
      if (!dates.length) return '';
      const buckets = {};
      shiftData.forEach(r => { const d = r[dateCol]; if (d) { buckets[d] = buckets[d] || []; buckets[d].push(r[primaryMetric] || 0); } });
      const sorted = Object.keys(buckets).sort();
      if (sorted.length < 2) return '';
      const firstVal = buckets[sorted[0]].reduce((a,b)=>a+b,0);
      const lastVal  = buckets[sorted[sorted.length-1]].reduce((a,b)=>a+b,0);
      const dir = lastVal > firstVal ? 'upward' : lastVal < firstVal ? 'downward' : 'flat';
      return `Trend is ${dir} from ${sorted[0]} to ${sorted[sorted.length-1]}.`;
    })();
    chartsHtml += `<div class="card dash-card">
      <div class="dash-card-title">${trendTitle}</div>
      <div class="chart-wrap" style="height:240px"><canvas id="dashTrendChart"></canvas></div>
      ${trendInsight ? `<div class="chart-insight"><span class="chart-insight-icon">💡</span>${escapeHtml(trendInsight)}</div>` : ''}
      <details class="dash-transparency">
        <summary class="dash-transparency-toggle">AI Analysis</summary>
        <div class="dash-transparency-body">
          <ol class="dash-analysis-steps">
            <li>Aggregated <strong>${primaryMetric.replace(/_/g,' ')}</strong> by date${groupCol ? ` and ${groupCol.replace(/_/g,' ')}` : ''}</li>
            <li>Plotted as a time-series line chart (${dates.length} date points)</li>
            <li>Each line represents one ${groupCol ? groupCol.replace(/_/g,' ') : 'series'}</li>
          </ol>
        </div>
      </details>
    </div>`;
  }

  // ── Schema banner tags ──
  const schemaTags = [];
  if (dateCol) schemaTags.push(`<span class="schema-tag schema-tag-date">📅 ${dateCol.replace(/_/g,' ')}</span>`);
  categoricalCols.forEach(c => schemaTags.push(`<span class="schema-tag schema-tag-cat">🏷 ${c.replace(/_/g,' ')}</span>`));
  allMetrics.slice(0, 4).forEach(c => schemaTags.push(`<span class="schema-tag schema-tag-num">🔢 ${c.replace(/_/g,' ')}</span>`));
  if (derivedCols.length) schemaTags.push(`<span class="schema-tag schema-tag-derived">⚙ ${derivedCols.length} derived</span>`);

  // ── Inject HTML ──
  const infoItems = [
    dateRange ? `📅 ${dateRange}` : null,
    `📋 ${rowCount.toLocaleString()} records`,
    groupCol && groups.length ? `🏷 ${groupCol.replace(/_/g,' ')}: ${groups.join(', ')}` : null
  ].filter(Boolean);

  dc.innerHTML += `
    <div class="exec-summary-module" id="execSummaryModule">
      <div class="exec-summary-header">
        <span class="exec-summary-icon">✦</span> Executive Summary
        <span class="exec-summary-badge">AI Generated</span>
      </div>
      <div class="exec-summary-text" id="execSummaryText">Generating dataset summary…</div>
    </div>
    <div class="schema-banner"><span class="schema-banner-label">Auto-detected schema</span>${schemaTags.join('')}</div>
    <div class="dash-info-bar">${infoItems.map(i=>`<span class="dash-info-item">${i}</span>`).join('')}</div>
    <div class="metric-grid">${metricCards.join('')}</div>
    ${chartsHtml}
  `;

  // Fetch executive summary asynchronously after DOM is ready
  (async () => {
    try {
      const schemaProfile = buildSchemaProfile(shiftData);
      const activeDs = getActiveDataset();
      // Build compact stats for the summary prompt
      const stats = {};
      allMetrics.slice(0, 5).forEach(col => {
        const vals = shiftData.map(r => r[col]).filter(v => typeof v === 'number' && !isNaN(v));
        if (!vals.length) return;
        const total = vals.reduce((a,b)=>a+b,0);
        stats[col] = {
          total: parseFloat(total.toFixed(1)),
          avg: parseFloat((total/vals.length).toFixed(2)),
          min: Math.min(...vals),
          max: Math.max(...vals),
          count: vals.length
        };
      });
      if (dateRange) stats._dateRange = dateRange;
      if (groupCol && groups.length) stats._groups = groups;
      const res = await fetch(`${PROXY_HOST}/api/summarize-dataset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaProfile, stats, datasetName: activeDs?.name || 'Dataset' })
      });
      if (res.ok) {
        const data = await res.json();
        const el = document.getElementById('execSummaryText');
        if (el && data.summary) el.textContent = data.summary;
      } else {
        const el = document.getElementById('execSummaryText');
        if (el) el.textContent = `${rowCount.toLocaleString()} records loaded across ${dateRange || 'all dates'}.${groupCol ? ` ${groups.length} ${groupCol.replace(/_/g,' ')} groups detected.` : ''}`;
      }
    } catch (_) {
      const el = document.getElementById('execSummaryText');
      if (el) el.textContent = `${rowCount.toLocaleString()} records loaded. Use Ask Questions to explore the data.`;
    }
  })();

  // ── Render Chart.js instances ──
  setTimeout(() => {
    Object.values(charts).forEach(c => { try { c.destroy(); } catch(e){} });
    charts = {};

    // Group comparison bar chart
    if (groupCol && primaryMetric && document.getElementById('dashGroupChart')) {
      charts.group = new Chart(document.getElementById('dashGroupChart'), {
        type: 'bar',
        data: {
          labels: groups,
          datasets: [{ data: groups.map(g => groupAvg(g, primaryMetric)),
            backgroundColor: CHART_COLORS, borderRadius: 6, borderSkipped: false }]
        },
        options: { ...CHART_DEFAULTS, scales: {
          y: { beginAtZero: true, grid: { color: '#F1F5F9' } },
          x: { grid: { display: false } } } }
      });
    }

    // Side metric charts
    sideMetrics.forEach((col, i) => {
      const el = document.getElementById(`dashSide${i}Chart`);
      if (!el || !groupCol) return;
      charts[`side${i}`] = new Chart(el, {
        type: 'bar',
        data: {
          labels: groups,
          datasets: [{ data: groups.map(g => groupAvg(g, col)),
            backgroundColor: CHART_COLORS[i + 1] || CHART_COLORS[0], borderRadius: 6, borderSkipped: false }]
        },
        options: { ...CHART_DEFAULTS, scales: {
          y: { beginAtZero: true, grid: { color: '#F1F5F9' } },
          x: { grid: { display: false } } } }
      });
    });

    // Trend line chart
    const trendEl = document.getElementById('dashTrendChart');
    if (trendEl && dateCol && primaryMetric) {
      // Limit x-axis labels if many dates
      const dispDates = dates.length > 60
        ? dates.filter((_, i) => i % Math.ceil(dates.length / 40) === 0)
        : dates;

      let datasets;
      if (groupCol && groups.length > 1) {
        // Multi-series: one line per group
        const byGrpDate = {};
        shiftData.forEach(r => {
          const g = r[groupCol] || 'Unknown';
          const d = r[dateCol];
          if (!byGrpDate[g]) byGrpDate[g] = {};
          if (!byGrpDate[g][d]) byGrpDate[g][d] = [];
          byGrpDate[g][d].push(r[primaryMetric] || 0);
        });
        datasets = groups.slice(0, 6).map((g, i) => ({
          label: g,
          data: dispDates.map(d => {
            const vals = byGrpDate[g]?.[d];
            return vals ? vals.reduce((a,b)=>a+b,0) : null;
          }),
          borderColor: CHART_COLORS[i % CHART_COLORS.length],
          backgroundColor: 'transparent',
          tension: 0.35, spanGaps: true, pointRadius: 2, borderWidth: 2
        }));
      } else {
        // Single series: aggregate all rows per date
        const byDate = {};
        shiftData.forEach(r => {
          const d = r[dateCol];
          if (!byDate[d]) byDate[d] = [];
          byDate[d].push(r[primaryMetric] || 0);
        });
        datasets = [{
          label: primaryMetric.replace(/_/g,' '),
          data: dispDates.map(d => { const v = byDate[d]; return v ? v.reduce((a,b)=>a+b,0) : null; }),
          borderColor: CHART_COLORS[0], backgroundColor: 'transparent',
          tension: 0.35, spanGaps: true, pointRadius: 2, borderWidth: 2
        }];
      }

      charts.trend = new Chart(trendEl, {
        type: 'line',
        data: { labels: dispDates, datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: datasets.length > 1, position: 'top' } },
          scales: {
            y: { beginAtZero: false, grid: { color: '#F1F5F9' } },
            x: { grid: { display: false }, ticks: { maxTicksLimit: 12 } }
          }
        }
      });
    }
  }, 100);
}

const PROXY_HOST = 'http://127.0.0.1:3001';

// ─── Layer 1: Semantic layer & schema profiler ────────────────────────────────

/** Auto-profile the shiftData array into a JSON schema for LLM prompts. */
function buildSchemaProfile(data) {
  if (!data || !data.length) return {};
  const fields = Object.keys(data[0]);
  const profile = {};
  for (const field of fields) {
    const values = data.map(r => r[field]).filter(v => v !== null && v !== undefined);
    const numericValues = values.filter(v => typeof v === 'number');
    const isNumeric = values.length > 0 && numericValues.length > values.length * 0.8;
    profile[field] = {
      type: isNumeric ? 'number' : 'string',
      sample_values: values.slice(0, 3),
      unique_count: new Set(values.map(String)).size
    };
    if (isNumeric && numericValues.length > 0) {
      profile[field].min = Math.min(...numericValues);
      profile[field].max = Math.max(...numericValues);
    }
    // For date strings, record lexicographic min/max so LLM knows the data's year range
    if (!isNumeric && field === 'date' && values.length > 0) {
      const sorted = values.map(String).sort();
      profile[field].date_min = sorted[0];
      profile[field].date_max = sorted[sorted.length - 1];
      profile[field].years = [...new Set(values.map(v => String(v).slice(0, 4)))].sort();
    }
  }
  return profile;
}

/** Business rules injected into every code-generation prompt — generated from live schema. */
function buildSemanticRules() {
  const schema = dataSchema;
  if (!schema || !schema.allCols || !schema.allCols.length) return 'No schema available.';

  const { dateCol, numericCols, categoricalCols, textCols, derivedCols, primaryGroupCol } = schema;
  let rules = 'Fields in each data row:\n';

  // Date column
  if (dateCol) rules += `- ${dateCol}: string — date in 'YYYY-MM-DD' format\n`;

  // Categorical columns
  categoricalCols.forEach(col => {
    const unique = [...new Set(shiftData.slice(0, 200).map(r => r[col]).filter(v => v && v.trim()))];
    rules += `- ${col}: string — category; known values: ${unique.slice(0,12).join(', ')}\n`;
  });

  // Numeric (raw) columns
  numericCols.forEach(col => {
    const vals = shiftData.map(r => r[col]).filter(v => typeof v === 'number' && !isNaN(v));
    if (!vals.length) { rules += `- ${col}: number\n`; return; }
    const mn = Math.min(...vals), mx = Math.max(...vals);
    rules += `- ${col}: number — range ${parseFloat(mn.toFixed(2))} to ${parseFloat(mx.toFixed(2))}\n`;
  });

  // Derived / computed columns
  if (derivedCols.includes('efficiency')) {
    rules += `- efficiency: number or null — pre-calculated as (actual_units/target_units)*100; null when target_units=0\n`;
  }
  if (derivedCols.includes('wastage_rate')) {
    rules += `- wastage_rate: number — pre-calculated as (wastage_units/(actual_units+wastage_units))*100\n`;
  }
  if (derivedCols.includes('productivity')) {
    rules += `- productivity: number — pre-calculated as actual_units/headcount\n`;
  }

  // Text columns
  textCols.forEach(col => { rules += `- ${col}: string — free text\n`; });

  rules += '\nBusiness rules:\n';

  // Group-by rules
  if (primaryGroupCol) {
    const uniqGroups = [...new Set(shiftData.map(r => r[primaryGroupCol]).filter(v => v))];
    rules += `- Primary grouping column: "${primaryGroupCol}" — use for group-by operations\n`;
    rules += `- Unique values in "${primaryGroupCol}": ${uniqGroups.join(', ')}\n`;
    rules += `- For groupBy ${primaryGroupCol}: data.reduce((acc,r)=>{ if(!acc[r.${primaryGroupCol}]) acc[r.${primaryGroupCol}]=[]; acc[r.${primaryGroupCol}].push(r); return acc; }, {})\n`;
  }

  rules += '- For averages: divide sum by filtered array length; return null if array is empty\n';
  if (derivedCols.includes('efficiency')) {
    rules += '- Always filter nulls for efficiency: data.filter(r => r.efficiency !== null)\n';
    rules += `- "Best ${primaryGroupCol || 'group'}" means the group with the highest average efficiency\n`;
  }
  if (derivedCols.includes('wastage_rate') && primaryGroupCol) {
    rules += `- When asked for a GROUP-LEVEL wastage rate (e.g. 'wastage rate by ${primaryGroupCol}'), compute from grouped sums:\n`;
    rules += `    const groupWastageRate = (rows) => { const tw=rows.reduce((a,b)=>a+b.wastage_units,0), ta=rows.reduce((a,b)=>a+b.actual_units,0); return (ta+tw)===0?null:parseFloat((tw/(ta+tw)*100).toFixed(2)); };\n`;
  }
  rules += "- 'Consistent', 'stable', 'reliable' = low standard deviation of the metric\n";
  rules += "- 'Variable', 'inconsistent', 'volatile' = high standard deviation\n";
  rules += `- Standard deviation:
    const mean = nums.reduce((a,b)=>a+b,0)/nums.length;
    const variance = nums.reduce((a,b)=>a+(b-mean)**2,0)/nums.length;
    const stdDev = parseFloat(Math.sqrt(variance).toFixed(2));
- Coefficient of variation (CV) = stdDev/mean*100 — use for comparing variability across groups\n`;

  // Date filtering rules
  if (dateCol) {
    const dc = dateCol;
    rules += `
Date filtering rules (ISO strings compare correctly with >= and <=):
- ALWAYS detect year(s) from data first: const years = [...new Set(data.map(r => r.${dc}.slice(0,4)))].sort(); const yr = years[years.length-1];
- If the question mentions a year (e.g. "in 2025"), use that year directly instead of yr
- Month numbers: jan=01 feb=02 mar=03 apr=04 may=05 jun=06 jul=07 aug=08 sep=09 oct=10 nov=11 dec=12
- "First week of [month]"  = days 01-07  → r.${dc} >= yr+'-MM-01' && r.${dc} <= yr+'-MM-07'
- "Second week of [month]" = days 08-14  → r.${dc} >= yr+'-MM-08' && r.${dc} <= yr+'-MM-14'
- "Third week of [month]"  = days 15-21  → r.${dc} >= yr+'-MM-15' && r.${dc} <= yr+'-MM-21'
- "Fourth/last week"       = days 22-end → r.${dc} >= yr+'-MM-22' && r.${dc} <= yr+'-MM-31'
- "In [month]"             = full month  → r.${dc} >= yr+'-MM-01' && r.${dc} <= yr+'-MM-31'
- "In [month] [year]"      = use given year directly
- "Q1" = Jan-Mar, "Q2" = Apr-Jun, "Q3" = Jul-Sep, "Q4" = Oct-Dec
- Always pad month/day to 2 digits with .padStart(2,'0')
- For "in [year]" queries: filter r.${dc}.startsWith(year_string)`;
  }

  return rules;
}

// ─── Layer 3: Sandboxed JS code execution ─────────────────────────────────────

/**
 * Execute LLM-generated JavaScript against the real data array.
 * The generated code must assign its result to variable `answer`.
 */
function executeGeneratedCode(code, data, tables) {
  try {
    // new Function creates an isolated scope — data and tables are the only inputs
    // eslint-disable-next-line no-new-func
    const fn = new Function('data', 'tables', code + '\nreturn typeof answer !== "undefined" ? answer : null;');
    const result = fn(data, tables || {});
    return { success: true, result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Returns true when the question contains temporal keywords (week, month name,
 * "last month", "q3", etc.) that were NOT successfully resolved into a date
 * filter by the regex-based fast paths.  When true, the fast paths should be
 * skipped so the question reaches the gold-standard code-generation path.
 */
function questionHasUnresolvedDateContext(question, instruction) {
  const text = question.toLowerCase();
  const hasTemporalTerms = /\b(first|second|third|fourth|last|this|past|previous|next)\s+(week|month|quarter|year)\b|\bthis\s+week\b|\blast\s+week\b|\byesterday\b|\btoday\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b|\bq[1-4]\b|\bquarter\b|\bweek\s+(of|in|ending|starting)\b|\b20\d{2}\b/i.test(text);
  if (!hasTemporalTerms) return false;
  const filters = instruction?.filters || {};
  return !(filters.date || filters.dateRange || filters.dateBefore || filters.dateAfter);
}

/**
 * Returns true for questions that require the full gold-standard LLM path
 * regardless of whether the fast path could produce *some* answer.
 * Catches: ordinal rankings ("second largest"), groupBy-temporal ("which month had"),
 * trend comparisons ("how has X changed"), and shift vs shift comparisons.
 */
function questionNeedsGoldStandard(question) {
  const text = question.toLowerCase();
  // Ordinal rankings beyond rank 1: "second/third/4th largest/highest/most/lowest/smallest/best/worst"
  if (/\b(second|third|fourth|2nd|3rd|4th|fifth|5th)\s+(largest|highest|most|lowest|smallest|best|worst)\b/i.test(text)) return true;
  // GroupBy-temporal: "which month/week had/has/was the most/highest/lowest"
  if (/\b(which|what)\s+(month|week)\b/i.test(text)) return true;
  // Trend/change analysis
  if (/\bhow\s+(has|have|did|is)\b.{0,30}\b(changed|improved|declined|grown|trended|fallen|increased|decreased)\b/i.test(text)) return true;
  // Cross-group comparisons ("compare X vs Y", "A versus B")
  if (/\bcompare\b|\bvs\b|\bversus\b|\bagainst\b/i.test(text)) return true;
  return false;
}

/** Sanity-check the computed answer before narrating it. */
function validateAnswer(question, answer) {
  const checks = [];
  checks.push({ check: 'non_null', pass: answer !== null && answer !== undefined });
  const expectsNumber = /\b(how much|total|sum|average|avg|mean|maximum|minimum|highest|lowest|how many|count)\b/i.test(question);
  if (expectsNumber) {
    const isNumeric = typeof answer === 'number' ||
      (typeof answer === 'string' && !isNaN(parseFloat(answer)));
    checks.push({ check: 'numeric_type', pass: isNumeric });
  }
  if (typeof answer === 'number') {
    checks.push({ check: 'finite', pass: isFinite(answer) && !isNaN(answer) });
  }
  const passCount = checks.filter(c => c.pass).length;
  const confidence = checks.length > 0 ? passCount / checks.length : 1;
  return { confidence, checks, flagged: confidence < 0.7 };
}

/**
 * Condense large execution results before sending to the narration LLM.
 * Raw arrays of 20+ rows cause the LLM to hallucinate summaries.
 * Returns a compact representation the LLM can narrate accurately.
 */
function condenseResultForNarration(result) {
  if (!Array.isArray(result) || result.length <= 10) return result;
  const sample = result.slice(0, 10);
  return {
    type: 'list_result',
    total_count: result.length,
    sample_rows: sample,
    note: `${result.length} total rows matched. First 10 shown above.`
  };
}

// ─── Chart visualization ──────────────────────────────────────────────────────

const CHART_PALETTE = ['#4F46E5','#0EA5E9','#059669','#D97706','#DC2626','#8B5CF6','#EC4899'];

const pendingCharts = new Map();

function isChartRequest(question) {
  return /\b(bar\s*(?:graph|chart)?|line\s*(?:graph|chart)?|pie\s*(?:chart)?|chart|graph|visuali[sz]e|plot|show\s+(?:me\s+)?(?:a\s+)?(?:bar|line|pie))\b/i.test(question);
}

function isConstantCol(col) {
  if (!shiftData.length) return true;
  const first = shiftData[0][col];
  return shiftData.every(r => r[col] === first);
}

function isPredictionRequest(question) {
  return /\b(predict|forecast|project|extrapolate|next\s+(month|week|quarter|year)|future\s+(value|trend|performance|price)|will\s+be|trend\s+(prediction|forecast)|price\s+prediction|what\s+will)\b/i.test(question);
}

function buildInlineChartHtml(result) {
  const id = 'ic_' + Date.now() + Math.floor(Math.random() * 1000);
  let config = null;

  if (result && result.chartType && result.labels && result.datasets) {
    config = {
      type: result.chartType,
      data: {
        labels: result.labels,
        datasets: result.datasets.map((d, i) => ({
          ...d,
          backgroundColor: d.backgroundColor || (result.chartType === 'line' ? 'transparent' : CHART_PALETTE[i % CHART_PALETTE.length]),
          borderColor: d.borderColor || CHART_PALETTE[i % CHART_PALETTE.length],
          borderWidth: result.chartType === 'line' ? 2 : 0,
          borderRadius: result.chartType === 'bar' ? 5 : 0,
          tension: 0.35,
          pointRadius: result.chartType === 'line' ? 3 : 0,
          fill: false
        }))
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: (result.datasets || []).length > 1, position: 'top' },
          title: { display: !!result.title, text: result.title || '', font: { size: 13, weight: '600' } }
        },
        scales: result.chartType !== 'pie' ? {
          x: { grid: { display: false }, title: { display: !!result.xLabel, text: result.xLabel || '' }, ticks: { maxTicksLimit: 14 } },
          y: { beginAtZero: true, grid: { color: '#F1F5F9' }, title: { display: !!result.yLabel, text: result.yLabel || '' } }
        } : undefined
      }
    };
  } else if (result && result.series && Array.isArray(result.series)) {
    config = {
      type: 'line',
      data: {
        labels: result.series.map(s => s.period),
        datasets: [{ label: 'Value', data: result.series.map(s => s.value), borderColor: CHART_PALETTE[0], backgroundColor: 'transparent', borderWidth: 2, tension: 0.35, pointRadius: 3, fill: false }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: false, grid: { color: '#F1F5F9' } } } }
    };
  } else if (result && (result.ranked_groups || result.ranked_shifts) && Array.isArray(result.ranked_groups || result.ranked_shifts)) {
    const ranked = result.ranked_groups || result.ranked_shifts;
    const labels = ranked.map(s => s.group || s.shift || String(s.rank));
    config = {
      type: 'bar',
      data: {
        labels,
        datasets: [{ data: ranked.map(s => s.value), backgroundColor: CHART_PALETTE, borderRadius: 5, borderSkipped: false }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: false, grid: { color: '#F1F5F9' } } } }
    };
  } else if (result && result.forecast_model === 'linear_regression' && Array.isArray(result.historical) && Array.isArray(result.forecasts)) {
    const histLabels = result.historical.map(h => h.period);
    const foreLabels = result.forecasts.map(f => f.period);
    const allLabels  = [...histLabels, ...foreLabels];
    // Historical data spans first N points; forecast spans last M points with bridge at N-1
    const histData = [...result.historical.map(h => h.value), ...result.forecasts.map(() => null)];
    const foreData = result.historical.map(() => null);
    if (result.historical.length > 0) {
      foreData[result.historical.length - 1] = result.historical[result.historical.length - 1].value;
    }
    result.forecasts.forEach(f => foreData.push(f.predicted));
    const r2Label = result.r_squared !== undefined ? ` (R²=${result.r_squared})` : '';
    const metricLabel = (result.metric || 'value').replace(/_/g,' ');
    config = {
      type: 'line',
      data: {
        labels: allLabels,
        datasets: [
          {
            label: 'Historical',
            data: histData,
            borderColor: CHART_PALETTE[0],
            backgroundColor: 'rgba(79,70,229,.08)',
            borderWidth: 2.5,
            tension: 0.35,
            pointRadius: 3,
            fill: true
          },
          {
            label: 'Forecast',
            data: foreData,
            borderColor: CHART_PALETTE[5] || '#8B5CF6',
            backgroundColor: 'transparent',
            borderWidth: 2.5,
            borderDash: [7, 4],
            tension: 0.35,
            pointRadius: 4,
            pointStyle: 'triangle',
            fill: false
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'top' },
          title: { display: true, text: `${metricLabel} — Forecast${r2Label}`, font: { size: 13, weight: '600' }, color: '#0F172A' }
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 12 } },
          y: { beginAtZero: false, grid: { color: '#F1F5F9' } }
        }
      }
    };
  }

  if (!config) return null;
  pendingCharts.set(id, config);
  return `<div class="answer-chart-wrap"><canvas id="${id}"></canvas></div>`;
}

function renderPendingCharts() {
  for (const [id, config] of pendingCharts.entries()) {
    const canvas = document.getElementById(id);
    if (canvas) {
      try {
        // eslint-disable-next-line no-undef
        new Chart(canvas, config);
      } catch(_) {}
      pendingCharts.delete(id);
    }
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Intent decoding ──────────────────────────────────────────────────────────

async function decodeIntent(question, schemaProfile, semanticRules) {
  try {
    const res = await fetch(`${PROXY_HOST}/api/decode-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, schemaProfile, semanticRules })
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('decodeIntent failed', e);
    return null;
  }
}

// ─── Answer rendering ─────────────────────────────────────────────────────────

/** Parse the ##SUMMARY## / ##INSIGHT## / ##APPROACH## sections from /api/interpret response. */
function parseInterpretSections(text) {
  if (!text) return { summary: text, insight: null, approach: null };
  const summaryMatch = text.match(/##SUMMARY##\s*([\s\S]*?)(?=##INSIGHT##|##APPROACH##|$)/i);
  const insightMatch = text.match(/##INSIGHT##\s*([\s\S]*?)(?=##SUMMARY##|##APPROACH##|$)/i);
  const approachMatch = text.match(/##APPROACH##\s*([\s\S]*?)(?=##SUMMARY##|##INSIGHT##|$)/i);
  return {
    summary: summaryMatch ? summaryMatch[1].trim() : text.trim(),
    insight: insightMatch ? insightMatch[1].trim() : null,
    approach: approachMatch ? approachMatch[1].trim() : null
  };
}

/**
 * Build the 3-part answer card HTML:
 *   SUMMARY (always visible) → INSIGHT (muted, always visible) → APPROACH (collapsible) → code (nested)
 * isForecast: true → shows the AI Forecast badge above the summary
 */
function renderAnswerCard(summary, insight, approach, generatedCode, decodedIntent, chartHtml, isForecast) {
  const predBadge = isForecast
    ? `<div class="prediction-badge">🔮 AI Forecast</div>`
    : '';
  const summaryHtml = `<div class="answer-summary">${escapeHtml(summary)}</div>`;

  const chartSection = chartHtml ? chartHtml : '';

  const insightHtml = insight
    ? `<div class="answer-insight">${escapeHtml(insight)}</div>`
    : '';

  const approachParts = [];
  if (approach) {
    approachParts.push(`<div class="answer-approach-text">${escapeHtml(approach)}</div>`);
  }
  if (decodedIntent?.filter_conditions?.length) {
    approachParts.push(`<div class="answer-filters">🔍 Filters applied: ${escapeHtml(decodedIntent.filter_conditions.join(' · '))}</div>`);
  }
  if (generatedCode) {
    approachParts.push(`<details class="code-details"><summary class="code-toggle">⟨/⟩ View generated code</summary><pre class="code-pre">${escapeHtml(generatedCode)}</pre></details>`);
  }

  const approachHtml = approachParts.length
    ? `<details class="approach-details"><summary class="approach-toggle">▼ How this was solved</summary><div class="approach-body">${approachParts.join('')}</div></details>`
    : '';

  return predBadge + summaryHtml + chartSection + insightHtml + approachHtml;
}

/** Render the amber clarification bubble HTML (replaces the thinking indicator). */
function renderClarificationBubble(clarificationPrompt) {
  return `<div class="clarify-header">🔍 Quick clarification</div><div class="clarify-body">${escapeHtml(clarificationPrompt)}</div>`;
}

/**
 * Insert a "🎯 Decoded as:" tag as a standalone element BEFORE the target message bubble,
 * so it appears visually between the user's question and the AI answer.
 */
function insertDecodedTagBefore(targetId, restatement) {
  const targetEl = document.getElementById(targetId);
  if (!targetEl || !restatement) return;
  const div = document.createElement('div');
  div.className = 'decoded-tag';
  div.innerHTML = `🎯 <span>${escapeHtml(restatement)}</span>`;
  targetEl.parentNode.insertBefore(div, targetEl);
}

// ─── Template chip interaction ────────────────────────────────────────────────

function useChip(btn) {
  const input = document.getElementById('qaInput');
  input.value = btn.textContent.trim();
  btn.classList.add('chip-active');
  setTimeout(() => btn.classList.remove('chip-active'), 600);
  askQuestion();
}

function getApiUrl() {
  const origin = window.location.origin;
  if (origin === `${PROXY_HOST}` || origin === 'http://localhost:3001') {
    return '/api/ask';
  }
  return `${PROXY_HOST}/api/ask`;
}

async function parseQuestion(question) {
  try {
    const res = await fetch(`${PROXY_HOST}/api/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question })
    });
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    return data?.instruction ? data : null;
  } catch (e) {
    console.error('Parse request failed', e);
    return null;
  }
}

function safeParseJSON(text) {
  if (!text) return null;
  const raw = text.trim();
  try {
    return JSON.parse(raw);
  } catch (_) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch (_e) {
        return null;
      }
    }
    return null;
  }
}

function normalizeFieldName(field) {
  if (!field) return null;
  const f = field.toString().toLowerCase().replace(/\s+/g,'_');

  // Exact match against actual columns first
  const allCols = [...(dataSchema.numericCols||[]), ...(dataSchema.categoricalCols||[]),
                   ...(dataSchema.derivedCols||[]), dataSchema.dateCol].filter(Boolean);
  const exact = allCols.find(c => c.toLowerCase() === f);
  if (exact) return exact;

  // Fuzzy match — pick first column whose name contains the token (or vice-versa)
  const fuzzy = allCols.find(c => c.toLowerCase().includes(f) || f.includes(c.toLowerCase()));
  if (fuzzy) return fuzzy;

  // Legacy shift-data fallbacks (kept for backward compat)
  if (f.includes('wast'))                          return allCols.find(c=>c.includes('wastage')||c.includes('waste')) || null;
  if (f.includes('actual') || f.includes('output') || f.includes('production')) return allCols.find(c=>c.includes('actual')||c.includes('output')||c.includes('revenue')||c.includes('sales')) || null;
  if (f.includes('target'))                        return allCols.find(c=>c.includes('target')||c.includes('goal')) || null;
  if (f.includes('downtime'))                      return allCols.find(c=>c.includes('downtime')) || null;
  if (f.includes('headcount') || f.includes('head_count')) return allCols.find(c=>c.includes('headcount')||c.includes('head_count')) || null;
  if (f.includes('util'))                          return allCols.find(c=>c.includes('util')) || null;
  if (f.includes('efficien'))                      return allCols.find(c=>c.includes('efficien')) || 'efficiency';
  if (f.includes('product') && !f.includes('production')) return allCols.find(c=>c.includes('product') && !c.includes('production')) || null;
  if (f === 'date' && dataSchema.dateCol)          return dataSchema.dateCol;
  if (f === 'shift' || f === 'group')              return dataSchema.primaryGroupCol || null;
  return null;
}

function compareValue(val, operator, threshold) {
  if (typeof val !== 'number' || typeof threshold !== 'number') return false;
  switch (operator) {
    case '>': return val > threshold;
    case '>=': return val >= threshold;
    case '<': return val < threshold;
    case '<=': return val <= threshold;
    case '=':
    case '==': return val === threshold;
    default: return val === threshold;
  }
}

function describeField(field) {
  if (!field) return 'unknown field';
  return field.replace(/_/g, ' ');
}

function normalizeDateRange(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    const mapped = value.map(normalizeDateString).filter(Boolean);
    return mapped.length >= 2 ? mapped : null;
  }
  if (typeof value === 'string') {
    const rangeMatch = value.match(/([^\d]*)(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})(?:\s*(?:to|through|-)\s*)(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})/i);
    if (rangeMatch) {
      const start = normalizeDateString(rangeMatch[2]);
      const end = normalizeDateString(rangeMatch[3]);
      if (start && end) return [start, end];
    }
    const parts = value.split(/[;,]/).map(v => v.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const mapped = parts.map(normalizeDateString).filter(Boolean);
      return mapped.length >= 2 ? mapped : null;
    }
  }
  return null;
}

function parseRelativeDateFilter(question) {
  const text = question.toLowerCase();
  const beforeMatch = text.match(/\b(before|prior to|until)\s+([^,?.]+)/i);
  if (beforeMatch) {
    const date = normalizeDateString(beforeMatch[2].trim());
    if (date) return { dateBefore: date };
  }
  const afterMatch = text.match(/\b(after|since)\s+([^,?.]+)/i);
  if (afterMatch) {
    const date = normalizeDateString(afterMatch[2].trim());
    if (date) return { dateAfter: date };
  }
  return null;
}

function describeFilters(filters) {
  const parts = [];
  if (filters.shift) {
    const shiftList = Array.isArray(filters.shift) ? filters.shift.join(', ') : filters.shift;
    parts.push(`shift ${shiftList}`);
  }
  const dateRange = normalizeDateRange(filters.dateRange || filters.date);
  if (dateRange) {
    parts.push(`from ${dateRange[0]} to ${dateRange[1]}`);
  } else if (filters.date) {
    const dateValue = normalizeDateString(filters.date);
    if (dateValue) parts.push(`on ${filters.date}`);
  }
  if (filters.dateBefore) {
    parts.push(`before ${filters.dateBefore}`);
  }
  if (filters.dateAfter) {
    parts.push(`after ${filters.dateAfter}`);
  }
  return parts.length ? ` ${parts.join(' and ')}` : '';
}

function parseComparisonCondition(question) {
  const text = question.toLowerCase();
  const patterns = [
    /(?:where|with|and)?\s*([a-zA-Z_]+)\s*(?:is|was|=|==|>=|<=|>|<)\s*([0-9]+(?:\.[0-9]+)?)/i,
    /([a-zA-Z_]+)\s+was\s+([0-9]+(?:\.[0-9]+)?)/i,
    /([a-zA-Z_]+)\s+equals\s+([0-9]+(?:\.[0-9]+)?)/i,
    // "have/had/with downtime 0" — field directly followed by value, no explicit operator
    /\b(?:have|had|with|where|when)\s+([a-zA-Z_]+)\s+(?:of\s+)?(zero|\d+(?:\.\d+)?)\b/i
  ];

  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (match) {
      const field = normalizeFieldName(match[1]);
      const rawVal = (match[2] || '').toLowerCase();
      const value = rawVal === 'zero' ? 0 : parseFloat(rawVal);
      if (!field || Number.isNaN(value)) continue;
      let operator = '=';
      if (/>=/.test(match[0])) operator = '>=';
      else if (/<=/.test(match[0])) operator = '<=';
      else if (/</.test(match[0]) && !/<=/.test(match[0])) operator = '<';
      else if (/>/.test(match[0]) && !/>=/.test(match[0])) operator = '>';
      return { field, operator, value };
    }
  }
  return null;
}

function isListQuery(question) {
  const text = question.toLowerCase();
  return /\b(list|show|find|display|which)\b/.test(text) && /\b(where|with|having|zero|0)\b/.test(text);
}

function isWhenQuery(question) {
  return /\bwhen\b/i.test(question) ||
    /\bspecify\b.*\b(date|shift|day)\b/i.test(question) ||
    /\b(which|what)\b.{0,25}\b(date|day|shift)\b/i.test(question) ||
    /\bon\s+which\b/i.test(question) ||
    /\b(for|on)\s+what\b/i.test(question);
}

function parseLocalInstruction(question) {
  if (!question) return null;
  const operation = inferOperation(question);
  const field = inferFieldFromQuestion(question);
  const filters = {};
  const catFilter = inferCategoryFilters(question);
  if (catFilter) {
    const pgc = dataSchema.primaryGroupCol || 'shift';
    if (Array.isArray(catFilter)) filters[pgc] = catFilter.length === 1 ? catFilter[0] : catFilter;
    else Object.assign(filters, catFilter);
  }
  const dateFilter = parseRelativeDateFilter(question) || inferDateFilter(question);
  if (dateFilter) Object.assign(filters, dateFilter);
  const condition = parseComparisonCondition(question);
  const groupBy = inferGroupBy(question);
  const listQuery = isListQuery(question);
  const whenQuery = isWhenQuery(question);

  if (/best day|best date|highest production day|most productive day/i.test(question)) {
    return { operation: 'max', field: 'actual', filters, groupBy: 'date', rowResult: true };
  }

  if (!operation && condition && listQuery) {
    return { operation: 'list', field: condition.field, filters, condition, returnRows: true };
  }

  if (!operation && condition && whenQuery) {
    return { operation: 'max', field: condition.field, filters, condition, rowResult: true };
  }

  if (!operation) return null;
  if (operation === 'count') return { operation, field, filters, groupBy, condition };
  if (!field && condition) {
    return { operation: 'list', field: condition.field, filters, condition, returnRows: true };
  }

  return { operation, field, filters, groupBy, condition, returnRows: listQuery, rowResult: whenQuery };
}

function filterRows(rows, filters = {}, condition = null) {
  let result = rows;
  // Filter by any categorical column value mentioned in filters
  const allCatCols = dataSchema.categoricalCols || [];
  const groupCol   = dataSchema.primaryGroupCol || 'shift';
  // Support both the legacy 'shift' key and the dynamic group column key
  const catKeys = [...new Set([groupCol, 'shift', ...allCatCols])];
  for (const key of catKeys) {
    if (!filters[key]) continue;
    const wanted = Array.isArray(filters[key])
      ? filters[key].map(s => s.toString().toUpperCase())
      : [filters[key].toString().toUpperCase()];
    result = result.filter(r => {
      const val = (r[key] || '').toString().toUpperCase();
      return wanted.includes(val);
    });
    break; // Apply at most one categorical filter from the stack
  }
  const dateRange = normalizeDateRange(filters.dateRange || filters.date);
  if (dateRange) {
    const start = new Date(dateRange[0]).getTime();
    const end = new Date(dateRange[1]).getTime();
    if (!Number.isNaN(start) && !Number.isNaN(end)) {
      result = result.filter(r => {
        const rowDate = normalizeDateString(r.date);
        const rowTime = rowDate ? new Date(rowDate).getTime() : NaN;
        return !Number.isNaN(rowTime) && rowTime >= start && rowTime <= end;
      });
    }
  } else if (filters.date) {
    const dateValue = normalizeDateString(filters.date);
    if (dateValue) result = result.filter(r => normalizeDateString(r.date) === dateValue);
  }
  if (filters.dateBefore) {
    const cutoff = new Date(filters.dateBefore).getTime();
    if (!Number.isNaN(cutoff)) {
      result = result.filter(r => {
        const rowDate = normalizeDateString(r.date);
        const rowTime = rowDate ? new Date(rowDate).getTime() : NaN;
        return !Number.isNaN(rowTime) && rowTime < cutoff;
      });
    }
  }
  if (filters.dateAfter) {
    const cutoff = new Date(filters.dateAfter).getTime();
    if (!Number.isNaN(cutoff)) {
      result = result.filter(r => {
        const rowDate = normalizeDateString(r.date);
        const rowTime = rowDate ? new Date(rowDate).getTime() : NaN;
        return !Number.isNaN(rowTime) && rowTime > cutoff;
      });
    }
  }
  if (condition && condition.field) {
    result = result.filter(r => compareValue(r[condition.field], condition.operator || '=', condition.value));
  }
  return result;
}

function inferShiftFilters(question) {
  // Legacy: detect shift A/B/C/D pattern
  const matches = [...question.matchAll(/shift\s*([A-D])/gi)].map(m => m[1].toUpperCase());
  if (matches.length) return [...new Set(matches)];
  return null;
}

/** Generic: find mentions of any categorical column value in the question. */
function inferCategoryFilters(question) {
  const schema = dataSchema;
  if (!schema || !schema.primaryGroupCol) return inferShiftFilters(question);

  const result = {};
  for (const col of schema.categoricalCols) {
    const unique = [...new Set(shiftData.map(r => r[col]).filter(v => v && v.trim()))];
    const mentioned = unique.filter(val =>
      new RegExp('\\b' + val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(question)
    );
    if (mentioned.length) result[col] = mentioned;
  }
  // Return shift array if only the primary group was matched (backward compat shape)
  const pgc = schema.primaryGroupCol;
  if (Object.keys(result).length === 1 && result[pgc]) return result[pgc];
  return Object.keys(result).length ? result : null;
}

function inferOperation(question) {
  const text = question.toLowerCase();
  if (/\b(average|avg|mean)\b/.test(text)) return 'average';
  if (/\b(total|sum)\b/.test(text) && !/\b(average|avg|mean)\b/.test(text)) return 'sum';
  if (/\b(count|how many)\b/.test(text)) return 'count';
  if (/\b(minimum|min|lowest|smallest)\b/.test(text)) return 'min';
  if (/\b(maximum|max|highest|best|top)\b/.test(text)) return 'max';
  return null;
}

function inferFieldFromQuestion(question) {
  const token = question.toLowerCase();
  const allCols = [
    ...(dataSchema.numericCols  || []),
    ...(dataSchema.derivedCols  || []),
    ...(dataSchema.categoricalCols || [])
  ];

  // 1. Exact column name match (underscores treated as spaces)
  for (const col of allCols) {
    const colLower = col.toLowerCase();
    if (token.includes(colLower) || token.includes(colLower.replace(/_/g,' '))) return col;
  }

  // 2. Fuzzy keyword → pick best matching column
  const kw = [
    { pattern: /wastage|waste/,                      pick: c => c.includes('wastage') || c.includes('waste') },
    { pattern: /actual|output/,                      pick: c => c.includes('actual') || c.includes('output') || c.includes('revenue') || c.includes('sales') },
    { pattern: /target|goal/,                        pick: c => c.includes('target') || c.includes('goal') },
    { pattern: /downtime|down.?time/,                pick: c => c.includes('downtime') },
    { pattern: /headcount|head.?count|worker|staff/, pick: c => c.includes('headcount') || c.includes('head') },
    { pattern: /utilisa|utiliza|util/,               pick: c => c.includes('util') },
    { pattern: /efficien/,                           pick: c => c.includes('efficien') },
    { pattern: /productiv/,                          pick: c => c.includes('productiv') && !c.includes('production') },
    { pattern: /\bproduction\b|\bunits\b/,           pick: c => c.includes('actual') || c.includes('unit') || c.includes('production') || c.includes('qty') || c.includes('quantity') }
  ];
  for (const { pattern, pick } of kw) {
    if (pattern.test(token)) {
      const match = allCols.find(pick);
      if (match) return match;
    }
  }

  // 3. Fallback: date col / group col
  if (/\bdate\b/.test(token) && dataSchema.dateCol) return dataSchema.dateCol;
  if (/\bgroup\b|\bshift\b|\bcategory\b/.test(token) && dataSchema.primaryGroupCol) return dataSchema.primaryGroupCol;

  return null;
}

function inferGroupBy(question) {
  const text = question.toLowerCase();
  const pgc = dataSchema.primaryGroupCol || 'shift';
  const dateCol = dataSchema.dateCol || 'date';

  if (new RegExp(`by ${pgc}|per ${pgc}|for each ${pgc}`).test(text)) return pgc;
  if (/by shift|per shift|for each shift|by group|per group/.test(text)) return pgc;
  if (/by date|per day|per date|for each day/.test(text)) return dateCol;
  if (/best day|best date|most productive day/.test(text)) return dateCol;
  return null;
}

function inferDateFilter(question) {
  const dates = extractDateRange(question);
  if (dates.length >= 2) return { dateRange: [dates[0], dates[1]] };
  if (dates.length === 1) return { date: dates[0] };
  return null;
}

function groupBy(rows, key) {
  return rows.reduce((groups, row) => {
    const groupKey = row[key] || 'Unknown';
    groups[groupKey] = groups[groupKey] || [];
    groups[groupKey].push(row);
    return groups;
  }, {});
}

function formatGroupResult(operation, field, groups) {
  const lines = Object.entries(groups).map(([groupKey, groupRows]) => {
    const values = field ? groupRows.map(r => r[field]).filter(v => typeof v === 'number') : [];
    if (operation === 'count') {
      return `${groupKey}: ${groupRows.length}`;
    }
    if (!values.length) return `${groupKey}: no numeric data`;
    let value;
    switch (operation) {
      case 'average': value = parseFloat((values.reduce((a,b)=>a+b,0)/values.length).toFixed(1)); break;
      case 'sum': value = values.reduce((a,b)=>a+b,0); break;
      case 'max': value = Math.max(...values); break;
      case 'min': value = Math.min(...values); break;
      default: value = null;
    }
    return `${groupKey}: ${value}`;
  });
  return lines.join('; ');
}

function formatRowMatches(rows, field) {
  if (!rows.length) return '';
  const dateCol  = dataSchema.dateCol  || 'date';
  const groupCol = dataSchema.primaryGroupCol || 'shift';
  return rows.map(r => {
    const parts = [];
    if (r[dateCol] !== undefined)  parts.push(`${dateCol}:${r[dateCol]}`);
    if (r[groupCol] !== undefined) parts.push(`${groupCol}:${r[groupCol]}`);
    if (field && r[field] !== undefined) parts.push(`${describeField(field)}:${r[field]}`);
    return parts.join(' ');
  }).join('; ');
}

function executeParsedInstruction(instruction, rows, question) {
  if (!instruction || !instruction.operation || instruction.operation === 'unknown') return null;
  const operation = instruction.operation.toString().toLowerCase();
  const field = normalizeFieldName(instruction.field);
  const filters = instruction.filters || {};
  const group = instruction.groupBy ? instruction.groupBy.toString().toLowerCase() : null;
  let filtered = filterRows(rows, filters, instruction.condition);

  // Fallback: if the parsed filters exist but no filtering occurred, use question text extraction.
  if (filtered.length === rows.length && (filters.date || filters.dateRange || filters.shift) && question) {
    const fallback = getRelevantRows(question, rows);
    if (fallback.length < filtered.length) {
      filtered = fallback;
    }
  }

  if (!filtered.length) return 'No rows match the requested filters.';

  if (instruction.returnRows || operation === 'list') {
    const rowText = formatRowMatches(filtered, field);
    return rowText ? `Matching rows: ${rowText}.` : 'No matching rows found.';
  }

  const fieldLabel = describeField(field);
  const filterText = describeFilters(filters);

  if (instruction.rowResult && (operation === 'max' || operation === 'min') && field) {
    const bestRow = filtered.reduce((best, row) => {
      if (!best) return row;
      return operation === 'max' ? (row[field] > best[field] ? row : best) : (row[field] < best[field] ? row : best);
    }, null);
    if (bestRow) {
      const value = bestRow[field];
      const verb = operation === 'max' ? 'Maximum' : 'Minimum';
      const dateCol  = dataSchema.dateCol  || 'date';
      const groupCol = dataSchema.primaryGroupCol || 'shift';
      return `${verb} ${fieldLabel}${filterText} is ${value} on ${bestRow[dateCol] || '?'}${bestRow[groupCol] ? ' (' + groupCol + ' ' + bestRow[groupCol] + ')' : ''}.`;
    }
  }

  const dateColKey  = dataSchema.dateCol  || 'date';
  const groupColKey = dataSchema.primaryGroupCol || 'shift';
  if (group && [groupColKey, 'shift', dateColKey, 'date'].includes(group)) {
    const grouped = groupBy(filtered, group);
    const groupText = formatGroupResult(operation, field, grouped);
    if (operation === 'count') {
      return `Count by ${group}${filterText}: ${groupText}.`;
    }
    if (!field) return `Cannot compute ${operation} by ${group} because no numeric field was recognized.`;
    return `${operation.charAt(0).toUpperCase() + operation.slice(1)} of ${fieldLabel} by ${group}${filterText}: ${groupText}.`;
  }

  if (operation === 'count') {
    return `Row count${filterText} is ${filtered.length}.`;
  }
  if (!field) return null;

  const values = filtered.map(r => r[field]).filter(v => typeof v === 'number');
  if (!values.length) return `No numeric values found for field ${instruction.field}.`;

  let result;
  let detail = '';
  switch (operation) {
    case 'average':
      result = parseFloat((values.reduce((a,b)=>a+b,0)/values.length).toFixed(1));
      detail = `calculated as total ${fieldLabel} ${values.reduce((a,b)=>a+b,0)} divided by ${values.length} rows`;
      break;
    case 'sum':
      result = values.reduce((a,b)=>a+b,0);
      detail = `calculated over ${values.length} rows`;
      break;
    case 'max': {
      result = Math.max(...values);
      const maxRow = filtered.find(r => r[field] === result);
      const maxCtx = maxRow ? `, occurring at: ${Object.entries(maxRow).filter(([k]) => k !== field).map(([k,v])=>`${k}:${v}`).join(', ')}` : '';
      detail = `highest ${fieldLabel} across ${values.length} rows${maxCtx}`;
      break;
    }
    case 'min': {
      result = Math.min(...values);
      const minRow = filtered.find(r => r[field] === result);
      const minCtx = minRow ? `, occurring at: ${Object.entries(minRow).filter(([k]) => k !== field).map(([k,v])=>`${k}:${v}`).join(', ')}` : '';
      detail = `lowest ${fieldLabel} across ${values.length} rows${minCtx}`;
      break;
    }
    default:
      return null;
  }

  const verb = operation === 'sum' ? 'Total' : operation === 'average' ? 'Average' : operation === 'max' ? 'Maximum' : 'Minimum';
  return `${verb} ${fieldLabel}${filterText} is ${result}, ${detail}.`;
}

async function checkProxyAlive() {
  try {
    const res = await fetch(`${PROXY_HOST}/api/ping`, { method: 'GET' });
    if (!res.ok) throw new Error(`Proxy responded ${res.status}`);
    hideError();
  } catch (err) {
    showError('Proxy not reachable on port 3001. Start the Node server with `npm start` and open the page through http://127.0.0.1:3001/');
  }
}

function formatRows(rows) {
  const cols = dataSchema.allCols && dataSchema.allCols.length
    ? [...dataSchema.allCols, ...dataSchema.derivedCols].filter(Boolean)
    : Object.keys(rows[0] || {});
  return rows.map(r => cols.map(c => `${c}:${r[c] !== undefined ? r[c] : '-'}`).join(' ')).join('\n');
}

function normalizeDateString(text) {
  if (!text) return null;
  const value = text.trim();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slash = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (slash) {
    const [_, part1, part2, year] = slash;
    const first = parseInt(part1, 10);
    const second = parseInt(part2, 10);
    let day, month;
    if (first > 12) {
      day = part1;
      month = part2;
    } else if (second > 12) {
      month = part1;
      day = part2;
    } else {
      month = part1;
      day = part2;
    }
    return `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`;
  }

  const monthNames = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
  };

  let match = value.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})$/);
  if (match) {
    const [, day, monthName, year] = match;
    const month = monthNames[monthName.slice(0,3).toLowerCase()];
    if (month) return `${year}-${month}-${day.padStart(2,'0')}`;
  }

  match = value.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (match) {
    const [, monthName, day, year] = match;
    const month = monthNames[monthName.slice(0,3).toLowerCase()];
    if (month) return `${year}-${month}-${day.padStart(2,'0')}`;
  }

  return null;
}

function extractDateStrings(question) {
  const dates = [];
  const text = question.toLowerCase();

  const isoMatches = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)];
  isoMatches.forEach(match => dates.push(match[0]));

  const slashMatches = [...text.matchAll(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b/g)];
  slashMatches.forEach(match => {
    const normalized = normalizeDateString(match[0]);
    if (normalized) dates.push(normalized);
  });

  const wordMatches = [...text.matchAll(/(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})/g)];
  wordMatches.forEach(match => {
    const normalized = normalizeDateString(`${match[1]} ${match[2]} ${match[3]}`);
    if (normalized) dates.push(normalized);
  });

  const monthWordMatches = [...text.matchAll(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/g)];
  monthWordMatches.forEach(match => {
    const normalized = normalizeDateString(`${match[2]} ${match[1]} ${match[3]}`);
    if (normalized) dates.push(normalized);
  });

  return [...new Set(dates)];
}

function extractDateRange(question) {
  const rangeMatch = question.match(/(?:from|between)\s+([^?.,]+?)\s+(?:to|through|and)\s+([^?.,]+)/i);
  if (rangeMatch) {
    const start = normalizeDateString(rangeMatch[1].trim());
    const end = normalizeDateString(rangeMatch[2].trim());
    if (start && end) return [start, end];
  }

  return extractDateStrings(question);
}

function getRelevantRows(question, rows) {
  let relevant = rows;
  // Filter by any mentioned category values
  const catFilter = inferCategoryFilters(question);
  if (catFilter) {
    const pgc = dataSchema.primaryGroupCol || 'shift';
    const wanted = Array.isArray(catFilter)
      ? catFilter.map(v => v.toUpperCase())
      : Object.values(catFilter).flat().map(v => v.toUpperCase());
    if (wanted.length) {
      relevant = relevant.filter(r => {
        const val = (r[pgc] || '').toString().toUpperCase();
        return wanted.includes(val);
      });
    }
  }

  const dateRange = extractDateRange(question);
  if (dateRange.length === 1) {
    relevant = relevant.filter(r => normalizeDateString(r.date) === dateRange[0]);
  } else if (dateRange.length >= 2) {
    const start = new Date(dateRange[0]).getTime();
    const end = new Date(dateRange[1]).getTime();
    if (!Number.isNaN(start) && !Number.isNaN(end)) {
      relevant = relevant.filter(r => {
        const rowIso = normalizeDateString(r.date);
        if (!rowIso) return false;
        const rowTime = new Date(rowIso).getTime();
        return rowTime >= start && rowTime <= end;
      });
    }
  }

  return relevant.length ? relevant : rows;
}

function computeNumericAnswer(question, rows) {
  if (!rows.length) return null;
  const text = question.toLowerCase();
  const field = inferFieldFromQuestion(question);
  if (!field) return null;

  const vals = rows.map(r => r[field]).filter(v => typeof v === 'number' && !isNaN(v) && v !== null);
  if (!vals.length) return null;

  const rowCount = rows.length;
  const total = vals.reduce((a,b) => a+b, 0);
  const label = describeField(field);

  if (/\b(average|avg|mean)\b/.test(text)) {
    const avg = parseFloat((total / vals.length).toFixed(2));
    return `Average ${label} is ${avg}, calculated over ${vals.length} records.`;
  }
  if (/\b(total|sum)\b/.test(text)) {
    return `Total ${label} is ${parseFloat(total.toFixed(2)).toLocaleString()} across ${rowCount} records.`;
  }
  if (/\b(maximum|max|highest)\b/.test(text)) {
    return `Maximum ${label} is ${Math.max(...vals)} across ${rowCount} records.`;
  }
  if (/\b(minimum|min|lowest)\b/.test(text)) {
    return `Minimum ${label} is ${Math.min(...vals)} across ${rowCount} records.`;
  }
  return null;
}

function buildCompactSummary(rows) {
  const schema = dataSchema;
  const count = rows.length;
  let summary = `Row count: ${count}.`;

  // Date range
  if (schema.dateCol) {
    const dates = [...new Set(rows.map(r => r[schema.dateCol]).filter(Boolean))].sort();
    if (dates.length) summary += ` Date range: ${dates[0]} to ${dates[dates.length-1]}.`;
  }

  // Groups
  if (schema.primaryGroupCol) {
    const groups = [...new Set(rows.map(r => r[schema.primaryGroupCol]).filter(Boolean))].sort();
    summary += ` ${schema.primaryGroupCol}: ${groups.join(', ')}.`;
  }

  // Numeric totals / averages
  const metricCols = [...schema.numericCols, ...schema.derivedCols].slice(0, 5);
  metricCols.forEach(col => {
    const vals = rows.map(r => r[col]).filter(v => typeof v === 'number' && !isNaN(v) && v !== null);
    if (!vals.length) return;
    const total = vals.reduce((a,b)=>a+b,0);
    const avg   = parseFloat((total/vals.length).toFixed(1));
    summary += ` ${col}: total=${parseFloat(total.toFixed(1)).toLocaleString()}, avg=${avg}.`;
  });

  // Sample rows
  const sampleRows = rows.slice(0, Math.min(5, rows.length));
  summary += `\nSample rows:\n${formatRows(sampleRows)}`;
  return summary;
}

/**
 * Strict gate: returns true ONLY for simple single-field aggregations with
 * no temporal, ranking, comparison, or "which/when" context.
 * Everything else is routed to the gold-standard LLM path.
 */
function canAnswerLocally(question) {
  const text = question.toLowerCase();

  // Reject ANY month name
  if (/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/.test(text)) return false;
  // Reject week, quarter, year references
  if (/\bweek\b|\bquarter\b|\bq[1-4]\b|\b20\d{2}\b/.test(text)) return false;
  // Reject relative time words
  if (/\b(today|yesterday|last|this|past|previous|next|recent|lately)\s+\w/.test(text)) return false;
  // Reject ranking/ordinal beyond rank 1
  if (/\b(second|third|fourth|2nd|3rd|4th|fifth|5th|top\s+\d|bottom\s+\d)\b/.test(text)) return false;
  // Reject "which/when/where/how has" questions — need LLM to determine context
  if (/\b(which|when|where|how\s+has|how\s+have|how\s+did|how\s+is)\b/.test(text)) return false;
  // Reject comparison/trend
  if (/\b(compare|versus|vs\.?|against|trend|over\s+time|changed|improved|declined|grown|increased|decreased)\b/.test(text)) return false;
  // Reject multi-condition queries (having more than one "where/and/or/with" connector)
  if (/\b(and|or)\b.{5,}\b(and|or)\b/.test(text)) return false;
  // Reject "days where", "shifts where" — these need list comprehension
  if (/\b(days?|shifts?|records?)\s+(where|with|that|when)\b/.test(text) && /\b(and|or)\b/.test(text)) return false;

  // Must have a clear aggregation operation
  if (!/\b(total|sum|average|avg|mean|count|how many|minimum|maximum|min|max|highest|lowest)\b/.test(text)) return false;
  // Must mention a recognized data field OR be a count question
  const isCount = /\b(how many|count)\b/.test(text);
  if (isCount) return true;

  // Check if any actual column name (or its display form) is mentioned
  const allCols = [...(dataSchema.numericCols||[]), ...(dataSchema.derivedCols||[])];
  const hasField = allCols.some(col => {
    const c = col.toLowerCase();
    return text.includes(c) || text.includes(c.replace(/_/g,' '));
  }) || /\b(actual|production|output|wastage|waste|downtime|efficiency|productivity|utilisation|utilization|headcount|target|units|revenue|sales|quantity|qty)\b/.test(text);
  if (!hasField) return false;

  return true;
}

async function askQuestion() {
  const input = document.getElementById('qaInput');
  const rawInput = input.value.trim();
  if (!rawInput) return;
  if (!shiftData.length) {
    addMessage('ai', 'No data loaded yet. Please upload a CSV in the Input tab first.');
    return;
  }

  addMessage('user', rawInput);
  input.value = '';
  const thinkId = addMessage('ai', '<span class="thinking">Analysing data...</span>');
  document.getElementById('askBtn').disabled = true;

  // Handle clarification response: attach it to the original question
  let q = rawInput;
  let isClarificationResponse = false;
  const isForecast = isPredictionRequest(rawInput);
  if (pendingClarification) {
    q = pendingClarification.originalQuestion;
    isClarificationResponse = true;
    pendingClarification = null;
  }

  // ── Local path: zero API calls, strictly gated ────────────────────────────
  // Only fires for the simplest queries (total/avg/count of one field, no
  // temporal/ranking/comparison context). Everything else → gold-standard.
  if (!isClarificationResponse && canAnswerLocally(q)) {
    const localInstruction = parseLocalInstruction(q);
    if (localInstruction && localInstruction.operation !== 'unknown') {
      const localAnswer = executeParsedInstruction(localInstruction, shiftData, q);
      if (localAnswer) {
        updateMessage(thinkId, localAnswer);
        document.getElementById('askBtn').disabled = false;
        return;
      }
    }
  }

  // Detect if question mentions a different table — switch active dataset
  if (loadedDatasets.length > 1) {
    const qLow = q.toLowerCase();
    const mentioned = loadedDatasets.find(ds => qLow.includes(ds.name.toLowerCase()));
    if (mentioned && !mentioned.active) setActiveDataset(mentioned.id);
  }

  // ── Gold-standard path: decode → generate code → execute → narrate ────────
  const schemaProfile = buildSchemaProfile(shiftData);
  const multiTableRules = buildMultiTableSemanticRules();
  const semanticRules = multiTableRules
    ? buildSemanticRules() + '\n\n' + multiTableRules
    : buildSemanticRules();

  const effectiveQuestion = isClarificationResponse
    ? `${q}\n\nUser clarification: ${rawInput}`
    : q;

  // Step 1: Decode analytical intent
  let decoded = null;
  try {
    const intentRes = await decodeIntent(effectiveQuestion, schemaProfile, semanticRules);
    decoded = intentRes?.decoded || null;
  } catch (_) {}

  // Step 2: If LLM flagged ambiguity, ask user for clarification
  if (decoded?.needs_clarification && !isClarificationResponse) {
    pendingClarification = { originalQuestion: q, decoded };
    const msgEl = document.getElementById(thinkId);
    if (msgEl) {
      msgEl.className = 'msg msg-clarify';
      msgEl.innerHTML = renderClarificationBubble(
        decoded.clarification_prompt || 'Could you clarify what you mean?'
      );
    }
    document.getElementById('askBtn').disabled = false;
    return;
  }

  if (decoded?.decoded_restatement) {
    insertDecodedTagBefore(thinkId, decoded.decoded_restatement);
  }

  // Step 3: Generate JS code → execute in sandbox → self-correct up to 3×
  let generatedCode = null;
  let executionResult = null;
  let lastError = null;

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const codeRes = await fetch(`${PROXY_HOST}/api/generate-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: effectiveQuestion,
          schemaJson: JSON.stringify(schemaProfile),
          semanticRules,
          decodedIntent: decoded || undefined,
          previousCode: attempt > 0 ? generatedCode : undefined,
          errorMessage: attempt > 0 ? lastError : undefined
        })
      });

      if (!codeRes.ok) break;
      const codeData = await codeRes.json();
      if (!codeData.code) break;

      generatedCode = codeData.code;
      const execResult = executeGeneratedCode(generatedCode, shiftData, buildMultiTableContext());

      if (execResult.success) {
        executionResult = execResult.result;
        lastError = null;
        break;
      } else {
        lastError = execResult.error;
        console.warn(`Code execution attempt ${attempt + 1} failed:`, lastError);
      }
    }
  } catch (e) {
    console.error('Code generation path failed:', e);
  }

  // Null result: code ran successfully but found no matching records
  if (lastError === null && executionResult === null && generatedCode !== null) {
    const filterDesc = decoded?.filter_conditions?.length
      ? ' Filters applied: ' + decoded.filter_conditions.join(', ') + '.'
      : '';
    const noDataHtml = renderAnswerCard(
      'No records found matching those conditions.',
      'The dataset contains no entries for this filter combination.' + filterDesc +
      ' Try a broader date range or check that the relevant data was uploaded.',
      'The generated code executed successfully and returned null, indicating the filter produced zero matching rows.',
      generatedCode,
      decoded,
      null,
      false
    );
    updateMessage(thinkId, noDataHtml);
    document.getElementById('askBtn').disabled = false;
    return;
  }

  // Step 4: Narrate the verified result
  if (executionResult !== null && executionResult !== undefined && lastError === null) {
    const validation = validateAnswer(q, executionResult);
    let rawInterpret = null;
    try {
      const interpretRes = await fetch(`${PROXY_HOST}/api/interpret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: q,
          decodedIntent: decoded || undefined,
          executedCode: generatedCode || undefined,
          result: condenseResultForNarration(executionResult)
        })
      });
      if (interpretRes.ok) {
        const interpretData = await interpretRes.json();
        rawInterpret = interpretData.answer || null;
      }
    } catch (_) {}

    // Build inline chart if result has chart data or user asked for a chart
    let chartHtml = null;
    if (executionResult && typeof executionResult === 'object') {
      chartHtml = buildInlineChartHtml(executionResult);
    }

    let finalHtml;
    if (rawInterpret) {
      const sections = parseInterpretSections(rawInterpret);
      finalHtml = renderAnswerCard(sections.summary, sections.insight, sections.approach, generatedCode, decoded, chartHtml, isForecast);
    } else {
      const fallback = typeof executionResult === 'object'
        ? JSON.stringify(executionResult, null, 2)
        : String(executionResult);
      finalHtml = renderAnswerCard(fallback, null, null, generatedCode, decoded, chartHtml, isForecast);
    }

    updateMessage(thinkId, finalHtml);
    setTimeout(renderPendingCharts, 80);
    document.getElementById('askBtn').disabled = false;
    return;
  }

  // Step 5: Fallback — send compact data summary to /api/ask for qualitative questions
  const relevantRows = getRelevantRows(q, shiftData);
  const summary = buildCompactSummary(relevantRows.length < shiftData.length ? relevantRows : shiftData);
  const apiUrl = getApiUrl();

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, summary })
    });
    let data = null;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) data = await res.json();
    if (!res.ok) {
      const bodyText = data ? JSON.stringify(data) : await res.text();
      const errVal = data?.error;
      const errMsg = errVal
        ? (typeof errVal === 'string' ? errVal : (errVal.message || JSON.stringify(errVal)))
        : (bodyText || `Proxy returned ${res.status}`);
      throw new Error(errMsg);
    }
    updateMessage(thinkId, data?.answer || 'Unable to get a response.');
  } catch (e) {
    console.error(e);
    updateMessage(thinkId, 'Error: ' + (e.message || e) + ' (make sure the local proxy is running on port 3001)');
  }
  document.getElementById('askBtn').disabled = false;
}

function addMessage(role, html) {
  const id = 'msg_' + Date.now() + Math.random();
  const div = document.createElement('div');
  div.id = id; div.className = 'msg msg-' + role;
  if (role === 'ai') div.innerHTML = `<div class="ai-label">AI analysis</div>${html}`;
  else div.textContent = html;
  document.getElementById('messages').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return id;
}

function updateMessage(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = `<div class="ai-label">AI analysis</div>${html}`;
}

// ─── Databricks browser ───────────────────────────────────────────────────────

async function initDatabricksBrowser() {
  const statusEl = document.getElementById('dbStatusDot');
  const statusText = document.getElementById('dbStatusText');
  if (statusEl) statusEl.className = 'db-dot db-dot-checking';
  if (statusText) statusText.textContent = 'Connecting…';
  try {
    const res = await fetch(`${PROXY_HOST}/api/databricks/status`);
    const data = await res.json();
    if (data.connected) {
      if (statusEl) statusEl.className = 'db-dot db-dot-ok';
      if (statusText) statusText.textContent = 'Connected — ' + data.hostname;
      loadDbCatalogs();
    } else {
      if (statusEl) statusEl.className = 'db-dot db-dot-err';
      if (statusText) statusText.textContent = 'Not connected: ' + (data.error || 'unknown');
    }
  } catch (e) {
    if (statusEl) statusEl.className = 'db-dot db-dot-err';
    if (statusText) statusText.textContent = 'Server not reachable';
  }
}

async function loadDbCatalogs() {
  const el = document.getElementById('dbCatalogList');
  if (!el) return;
  el.innerHTML = '<div class="db-loading">Loading…</div>';
  try {
    const res = await fetch(`${PROXY_HOST}/api/databricks/catalogs`);
    const data = await res.json();
    if (data.error) { el.innerHTML = `<div class="db-err">${escapeHtml(data.error)}</div>`; return; }
    el.innerHTML = data.catalogs.map(c =>
      `<div class="db-item" onclick="selectDbCatalog('${escapeHtml(c)}')">${escapeHtml(c)}</div>`
    ).join('') || '<div class="db-empty">No catalogs found</div>';
  } catch (e) {
    el.innerHTML = `<div class="db-err">${e.message}</div>`;
  }
}

async function selectDbCatalog(catalog) {
  dbBrowserState = { catalog, schema: null, table: null };
  document.querySelectorAll('#dbCatalogList .db-item').forEach(el => {
    el.classList.toggle('db-item-active', el.textContent.trim() === catalog);
  });
  document.getElementById('dbSchemaList').innerHTML = '<div class="db-loading">Loading…</div>';
  document.getElementById('dbTableList').innerHTML = '';
  document.getElementById('dbPreviewArea').innerHTML = '';
  renderDbLoadBtn();
  try {
    const res = await fetch(`${PROXY_HOST}/api/databricks/schemas`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ catalog })
    });
    const data = await res.json();
    const el = document.getElementById('dbSchemaList');
    if (data.error) { el.innerHTML = `<div class="db-err">${escapeHtml(data.error)}</div>`; return; }
    el.innerHTML = data.schemas.map(s =>
      `<div class="db-item" onclick="selectDbSchema('${escapeHtml(s)}')">${escapeHtml(s)}</div>`
    ).join('') || '<div class="db-empty">No schemas</div>';
  } catch (e) {
    document.getElementById('dbSchemaList').innerHTML = `<div class="db-err">${e.message}</div>`;
  }
}

async function selectDbSchema(schema) {
  dbBrowserState.schema = schema;
  dbBrowserState.table  = null;
  document.querySelectorAll('#dbSchemaList .db-item').forEach(el => {
    el.classList.toggle('db-item-active', el.textContent.trim() === schema);
  });
  document.getElementById('dbTableList').innerHTML = '<div class="db-loading">Loading…</div>';
  document.getElementById('dbPreviewArea').innerHTML = '';
  renderDbLoadBtn();
  try {
    const res = await fetch(`${PROXY_HOST}/api/databricks/tables`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ catalog: dbBrowserState.catalog, schema })
    });
    const data = await res.json();
    const el = document.getElementById('dbTableList');
    if (data.error) { el.innerHTML = `<div class="db-err">${escapeHtml(data.error)}</div>`; return; }
    el.innerHTML = data.tables.map(t =>
      `<div class="db-item" onclick="selectDbTable('${escapeHtml(t.name)}')">${escapeHtml(t.name)}</div>`
    ).join('') || '<div class="db-empty">No tables</div>';
  } catch (e) {
    document.getElementById('dbTableList').innerHTML = `<div class="db-err">${e.message}</div>`;
  }
}

async function selectDbTable(table) {
  dbBrowserState.table = table;
  document.querySelectorAll('#dbTableList .db-item').forEach(el => {
    el.classList.toggle('db-item-active', el.textContent.trim() === table);
  });
  renderDbLoadBtn();
  const previewEl = document.getElementById('dbPreviewArea');
  previewEl.innerHTML = '<div class="db-loading">Loading preview…</div>';
  try {
    const res = await fetch(`${PROXY_HOST}/api/databricks/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ catalog: dbBrowserState.catalog, schema: dbBrowserState.schema, table })
    });
    const data = await res.json();
    if (data.error) { previewEl.innerHTML = `<div class="db-err">${escapeHtml(data.error)}</div>`; return; }
    const cols = data.columns.map(c => c.name);
    const rows = data.rows.slice(0, 5);
    previewEl.innerHTML = `
      <div class="db-preview-label">Preview — ${escapeHtml(table)} (first 5 rows)</div>
      <div class="preview-table-wrap" style="margin-top:8px">
        <table>
          <thead><tr>${cols.slice(0,10).map(c=>`<th>${escapeHtml(c.replace(/_/g,' '))}</th>`).join('')}${cols.length>10?'<th>…</th>':''}</tr></thead>
          <tbody>${rows.map(r=>`<tr>${cols.slice(0,10).map(c=>`<td>${escapeHtml(String(r[c]??''))}</td>`).join('')}${cols.length>10?'<td>…</td>':''}</tr>`).join('')}</tbody>
        </table>
      </div>`;
  } catch (e) {
    previewEl.innerHTML = `<div class="db-err">${e.message}</div>`;
  }
}

function renderDbLoadBtn() {
  const btn = document.getElementById('dbLoadTableBtn');
  if (!btn) return;
  const { catalog, schema, table } = dbBrowserState;
  btn.disabled = !(catalog && schema && table);
  btn.textContent = table ? `Load "${table}" into analysis` : 'Select a table to load';
}

async function loadDatabricksTable() {
  const { catalog, schema, table } = dbBrowserState;
  if (!catalog || !schema || !table) return;
  const btn = document.getElementById('dbLoadTableBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  try {
    const res = await fetch(`${PROXY_HOST}/api/databricks/load-table`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ catalog, schema, table })
    });
    const data = await res.json();
    if (data.error) { showError('Databricks error: ' + data.error); return; }
    if (!data.rows || !data.rows.length) { showError('Table loaded but contains no rows.'); return; }
    addDataset(table, 'databricks', data.rows);
    setActiveDataset(null);
    renderDatasetList();
    showSuccess(`"${table}" loaded — ${data.rows.length.toLocaleString()} rows. Switch to Dashboard or Ask Questions.`);
    switchTab('dashboard');
  } catch (e) {
    showError('Failed to load table: ' + e.message);
  } finally {
    renderDbLoadBtn();
  }
}

function switchSourceTab(tab) {
  document.querySelectorAll('.src-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('csvPanel').style.display   = tab === 'csv' ? '' : 'none';
  document.getElementById('databricksPanel').style.display = tab === 'databricks' ? '' : 'none';
  if (tab === 'databricks') initDatabricksBrowser();
}

window.addEventListener('load', checkProxyAlive);

function showError(msg) { const el = document.getElementById('errorBox'); el.textContent = msg; el.style.display = 'block'; }
function hideError() { document.getElementById('errorBox').style.display = 'none'; }
function showSuccess(msg) { const el = document.getElementById('successBox'); el.textContent = msg; el.style.display = 'block'; }
function hideSuccess() { document.getElementById('successBox').style.display = 'none'; }

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', ['input','dashboard','qa'][i] === name));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(name).classList.add('active');
}