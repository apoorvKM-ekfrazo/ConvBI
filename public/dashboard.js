'use strict';

const API = '';
let loadedTables    = {};
let allCharts       = [];    // echarts instances for resize
let pendingCharts   = [];    // {id, option} waiting for their section to become visible
let sidebarOpen     = true;

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

// Try to initialize a chart — returns true if succeeded (element visible)
function tryInitChart(id, option) {
  const el = document.getElementById(id);
  if (!el || typeof echarts === 'undefined') return false;
  if (el.offsetWidth === 0) return false;  // still hidden
  if (el._chartInited) return true;
  const chart = echarts.init(el, 'dark');
  chart.setOption({ ...option, backgroundColor: 'transparent' });
  allCharts.push(chart);
  el._chartInited = true;
  return true;
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
  pendingCharts = [];

  try {
    const res  = await fetch(`${API}/api/tables`);
    const data = await res.json();
    loadedTables = data.tables || {};
  } catch (_) { loadedTables = {}; }

  const names = Object.keys(loadedTables);
  renderSidebarSources(names);
  populateTableSelector(names);

  if (!names.length) return;

  // Parallel: pull sample rows + detect relationships
  const [samples, relData] = await Promise.all([
    fetchAllSamples(names),
    fetch(`${API}/api/detect-relationships`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' }).then(r => r.ok ? r.json() : { joins: [], noRelation: [] }).catch(() => ({ joins: [], noRelation: [] }))
  ]);

  renderKPIStrip(samples);
  renderRelationshipMap(names, relData);
  renderSmartCharts(names, 'overviewCharts', 2);
  renderSmartCharts(names, 'chartsSection',  6);
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
function renderKPIStrip(samples) {
  const el = document.getElementById('kpiStrip');
  if (!el) return;

  const kpis = [];
  let totalRows = 0;

  for (const [name, d] of Object.entries(samples)) {
    totalRows += d.rowCount || d.rows?.length || 0;
    const numCols = (d.columns||[]).filter(c =>
      ['INTEGER','BIGINT','DOUBLE','FLOAT','REAL'].some(t => (c.type||'').toUpperCase().startsWith(t))
    );
    numCols.slice(0, 2).forEach(col => {
      const vals = (d.rows||[]).map(r => +r[col.name]).filter(v => !isNaN(v));
      if (!vals.length) return;
      const isRate = /pct|rate|eff|util/i.test(col.name);
      const sum = vals.reduce((a,b)=>a+b, 0);
      const avg = sum / vals.length;
      // trend: compare first half vs second half
      const half = Math.floor(vals.length/2);
      const avg1 = half > 0 ? vals.slice(0,half).reduce((a,b)=>a+b,0)/half : avg;
      const avg2 = vals.length-half > 0 ? vals.slice(half).reduce((a,b)=>a+b,0)/(vals.length-half) : avg;
      const pct  = avg1 ? ((avg2-avg1)/Math.abs(avg1)*100) : 0;
      const dir  = pct > 1 ? 'up' : pct < -1 ? 'down' : 'flat';
      kpis.push({
        label: col.name.replace(/_/g,' '),
        value: isRate ? avg.toFixed(1)+'%' : Math.round(sum).toLocaleString(),
        trend: dir, pct: Math.abs(pct).toFixed(1), table: name
      });
    });
    if (kpis.length >= 5) break;
  }

  // Total records KPI
  kpis.unshift({ label: 'Total Records', value: totalRows.toLocaleString(), trend: 'flat', pct: '0', table: 'all' });

  const arrowMap = { up: '▲', down: '▼', flat: '→' };
  const clsMap   = { up: 'kpi-trend-up', down: 'kpi-trend-down', flat: 'kpi-trend-flat' };

  el.innerHTML = kpis.slice(0, 5).map(k => `
    <div class="kpi-card" onclick="filterByKPI('${escapeHtml(k.label)}')">
      <div class="kpi-label">${escapeHtml(k.label)}</div>
      <div class="kpi-value">${escapeHtml(k.value)}</div>
      <div class="kpi-trend ${clsMap[k.trend]}">${arrowMap[k.trend]} ${k.pct}% vs prior half</div>
      <div class="kpi-sub">${escapeHtml(k.table)}</div>
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
  } catch (e) {
    storyH.textContent = 'Could not generate story: ' + e.message;
  }
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

  const sourceColor = s => ({ databricks: '#3FB950', s3: '#D29922', file: '#58A6FF' })[s] || '#58A6FF';

  // Draw edges first
  let edges = '';
  (relData.joins||[]).forEach(j => {
    const pa = positions[j.tableA], pb = positions[j.tableB];
    if (!pa||!pb) return;
    const color = j.confidence > 0.8 ? '#3FB950' : j.confidence > 0.5 ? '#D29922' : '#6E7681';
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
            fill="rgba(22,27,34,.95)" stroke="${color}" stroke-width="1.5"/>
      <text x="${x}" y="${y-8}" fill="${escapeHtml(color)}" font-size="12" font-weight="600" text-anchor="middle">${escapeHtml(name.slice(0,18))}</text>
      <text x="${x}" y="${y+8}" fill="#8B949E" font-size="10" text-anchor="middle">${(t.rowCount||0).toLocaleString()} rows · ${(t.columns||[]).length} cols</text>
      <text x="${x}" y="${y+22}" fill="#6E7681" font-size="9" text-anchor="middle">${escapeHtml(t.source||'file')}</text>`;
  });

  const svgH = Math.max(H, rows * (nodeH + padding*1.5) + padding*2);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${svgH}" class="rel-map-svg">${edges}${nodes}</svg>`;

  if (badge) {
    const jc = (relData.joins||[]).length;
    badge.textContent = jc ? `${jc} join${jc>1?'s':''} detected` : 'No joins detected';
  }
}

// ── Smart chart gallery (uses /api/charts/:tableName pipeline) ────────────────
async function renderSmartCharts(tableNames, containerId, maxCharts) {
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
        allDefs.push({ ...c, tableName });
      }
    } catch (_) {}
  }));

  // Sort by score descending
  allDefs.sort((a, b) => b.score - a.score);

  container.innerHTML = '';
  let count = 0;

  for (const def of allDefs.slice(0, maxCharts)) {
    const cid  = `sc_${def.tableName.replace(/[^a-z0-9]/gi,'_')}_${count}`;
    const title = def.option?.title?.text || `${(def.yCol||'').replace(/_/g,' ')} by ${(def.xCol||'').replace(/_/g,' ')}`;
    const sub   = `${def.type} · score ${def.score} · ${def.tableName}`;

    const card = document.createElement('div');
    card.className = 'db-chart-card';
    card.innerHTML = `
      <div class="db-chart-card-title">${escapeHtml(title)}</div>
      <div class="db-chart-card-sub">${escapeHtml(sub)}</div>
      <div class="db-chart-inner" id="${cid}"></div>`;
    container.appendChild(card);

    const opt = def.option;
    setTimeout(() => {
      if (!tryInitChart(cid, opt)) pendingCharts.push({ id: cid, option: opt });
    }, 80 + count * 30);

    count++;
  }

  if (!count) {
    container.innerHTML = '<div class="rel-map-empty">No chart-able data found in loaded tables.</div>';
  }
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
      const card = document.createElement('div');
      card.className = 'db-chart-card';
      card.innerHTML = `
        <div class="db-chart-card-title">${escapeHtml(chartDef.title)}</div>
        <div class="db-chart-card-sub">${escapeHtml(chartDef.sub)}</div>
        <div class="db-chart-inner" id="${chartId}"></div>`;
      container.appendChild(card);

      const opt = chartDef.option, cid = chartId;
      setTimeout(() => {
        if (!tryInitChart(cid, opt)) pendingCharts.push({ id: cid, option: opt });
      }, 80 + count * 30);

      count++;
    }
  }

  if (!count) container.innerHTML = '<div class="rel-map-empty">No chart-able data found in loaded tables.</div>';
}

// ── ECharts option builders (dark theme) ──────────────────────────────────────
const DARK_COLORS = ['#58A6FF','#3FB950','#D29922','#F85149','#BC8CFF','#79C0FF'];

const DARK_GRID  = { top:30, right:20, bottom:40, left:60 };
const DARK_AXIS  = { axisLine:{lineStyle:{color:'#30363D'}}, splitLine:{lineStyle:{color:'#21262D'}}, axisLabel:{color:'#8B949E',fontSize:11} };
const DARK_TIP   = { trigger:'axis', backgroundColor:'#161B22', borderColor:'#30363D', textStyle:{color:'#E6EDF3',fontSize:12} };
const DARK_LEGEND= { textStyle:{color:'#8B949E'} };

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
        colorStops:[{offset:0,color:'#58A6FF'},{offset:1,color:'#1f6feb'}]
      }},
      label:{ show: xData.length<=10, position:'top', color:'#8B949E', fontSize:10 }
    }]
  };
}

function buildDonutOption(labels, values) {
  return {
    tooltip: { trigger:'item', backgroundColor:'#161B22', borderColor:'#30363D', textStyle:{color:'#E6EDF3'} },
    legend: { orient:'vertical', right:10, top:'center', ...DARK_LEGEND },
    series: [{
      type:'pie', radius:['40%','70%'], center:['40%','50%'],
      data: labels.map((l,i) => ({ name:l, value:values[i], itemStyle:{color:DARK_COLORS[i%DARK_COLORS.length]} })),
      label:{ color:'#8B949E', fontSize:11 },
      labelLine:{lineStyle:{color:'#30363D'}}
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
      itemStyle:{ color:'#58A6FF', opacity:0.6 },
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

    // Compute per-column min/max for numeric heat
    const colStats = {};
    cols.forEach(c => {
      const vals = rows.map(r => +r[c.name]).filter(v => !isNaN(v));
      if (vals.length) colStats[c.name] = { min: Math.min(...vals), max: Math.max(...vals) };
    });

    const numTypes = ['INTEGER','BIGINT','DOUBLE','FLOAT','REAL'];
    const isNum    = c => numTypes.some(t => (c.type||'').toUpperCase().startsWith(t));

    el.innerHTML = `
      <table class="db-data-table">
        <thead><tr>${cols.map(c => `<th title="${escapeHtml(c.type||'')}">
          ${isNum(c)?'🔢':'🔤'} ${escapeHtml(c.name)}
          ${colStats[c.name] ? `<br><small style="font-weight:400;color:var(--text-muted)">${colStats[c.name].min.toFixed(1)}–${colStats[c.name].max.toFixed(1)}</small>` : ''}
        </th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr>${cols.map(c => {
          const v = r[c.name];
          const s = colStats[c.name];
          let style = '';
          if (s && !isNaN(+v)) {
            const pct = s.max === s.min ? 0.5 : (+v - s.min) / (s.max - s.min);
            style = `background:rgba(88,166,255,${(pct*0.3).toFixed(2)})`;
          }
          return `<td style="${style}" title="${escapeHtml(String(v??''))}">${escapeHtml(String(v??''))}</td>`;
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
