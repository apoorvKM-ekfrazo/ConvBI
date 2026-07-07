'use strict';

// ── Global state ─────────────────────────────────────────────────────────────
const API = '';           // same origin
let loadedTables   = {}; // tableName → { rowCount, columns, source, ... }
let activeTableSet = new Set(); // tables in scope for current question
let pendingFiles   = []; // staged File objects before upload
let voiceMgr       = null; // set by voice-manager.js
let savedInsights  = JSON.parse(localStorage.getItem('convbi_insights') || '[]');
let conversationTurns = []; // recent Q/A context for intent decoding
const answerPayloadStore = {}; // cardId -> payload for exports

const WORKFLOW_LABELS = {
  6: 'User Asks Business Question',
  7: 'Intent Understanding',
  8: 'Analytics Engine',
  9: 'Context-Aware Data Storytelling',
  10: 'Conversational Follow-up',
  11: 'Decision Support'
};

// Databricks browser state (legacy compat)
let dbBrowserState = { catalog: null, schema: null, table: null };

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t, i) => {
    const tabs = ['input','qa'];  // 'dashboard' tab is now a link — skip index 1
    // Map button index to tab ids
    const btnTabs = ['input','dashboard','qa'];
    t.classList.toggle('active', btnTabs[i] === name);
  });
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(name)?.classList.add('active');
  if (name === 'qa') refreshTableContextBar();
}

function getInitialTabFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const tabParam = (params.get('tab') || '').toLowerCase();
    if (tabParam === 'qa' || tabParam === 'ask' || tabParam === 'ask-questions') return 'qa';
    if (tabParam === 'input') return 'input';

    const hash = (window.location.hash || '').replace('#', '').toLowerCase();
    if (hash === 'qa' || hash === 'ask' || hash === 'ask-questions') return 'qa';
    if (hash === 'input') return 'input';
  } catch (_) {}
  return 'input';
}

function switchSourceTab(name) {
  document.querySelectorAll('.src-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.getElementById('filesPanel').style.display     = name === 'files'      ? '' : 'none';
  document.getElementById('databricksPanel').style.display = name === 'databricks' ? '' : 'none';
  document.getElementById('s3Panel').style.display         = name === 's3'         ? '' : 'none';
  if (name === 'databricks') initDatabricksBrowser();
  if (name === 's3') initS3Panel();
}

// ── Notifications ─────────────────────────────────────────────────────────────
function showError(msg)   { const el = document.getElementById('errorBox');   if(el){ el.textContent = msg; el.style.display = ''; setTimeout(()=> el.style.display='none', 6000); }}
function hideError()      { const el = document.getElementById('errorBox');   if(el) el.style.display = 'none'; }
function showSuccess(msg) { const el = document.getElementById('successBox'); if(el){ el.textContent = msg; el.style.display = ''; setTimeout(()=> el.style.display='none', 5000); }}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setWorkflowRuntime(step, detail) {
  const box = document.getElementById('workflowRuntime');
  if (!box) return;
  const title = WORKFLOW_LABELS[step] || 'Workflow';
  const suffix = detail ? ` ${escapeHtml(detail)}` : '';
  box.innerHTML = `<strong>Step ${step}: ${escapeHtml(title)}</strong>${suffix}`;
}

function buildFollowupSuggestions(question, decoded) {
  const q = String(question || '').toLowerCase();
  const suggestions = [
    'Explain further',
    'Compare another period',
    'Filter by Region',
    'Show only Electronics',
    'Forecast next six months',
    'Drill down into customers',
    'Refresh Dashboard'
  ];

  if (decoded?.time_period && decoded.time_period !== 'all_time') {
    suggestions.unshift('Compare with previous period');
  }
  if (/forecast|next quarter|next month|next six|prediction/.test(q)) {
    suggestions.unshift('Show forecast confidence range');
  }
  return Array.from(new Set(suggestions)).slice(0, 8);
}

function renderFollowupRail(question, decoded) {
  const rail = document.getElementById('followupRail');
  if (!rail) return;
  const prompts = buildFollowupSuggestions(question, decoded);
  rail.style.display = '';
  rail.innerHTML = `
    <div style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--t3);margin-bottom:8px">Step 10: Conversational Follow-up</div>
    <div style="display:flex;gap:7px;flex-wrap:wrap">${prompts.map(p => `<button class="chip" onclick="runFollowupPrompt('${escapeHtml(p)}')">${escapeHtml(p)}</button>`).join('')}</div>`;
}

function runFollowupPrompt(prompt) {
  if (prompt === 'Refresh Dashboard') {
    localStorage.setItem('convbi_tables_updated', Date.now().toString());
    window.open('/dashboard', '_blank');
    return;
  }
  const input = document.getElementById('qaInput');
  if (!input) return;
  input.value = prompt;
  input.focus();
}

// ── Template download ─────────────────────────────────────────────────────────
function downloadTemplate() {
  const cols = ['date','shift','target_units','actual_units','wastage_units','downtime_minutes','headcount','machine_utilisation_pct','remarks'];
  const rows = [
    '2024-04-15,A,1000,940,32,20,25,88,Good run',
    '2024-04-15,B,1000,870,55,45,24,79,Machine 3 issue',
    '2024-04-16,A,1000,960,20,10,25,93,',
    '2024-04-16,B,1000,900,40,30,24,85,',
  ];
  const blob = new Blob([[cols.join(','), ...rows].join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'sample_data.csv' });
  a.click();
}

// ══════════════════════════════════════════════════════════════════════════════
// FILE UPLOAD
// ══════════════════════════════════════════════════════════════════════════════

function onDragOver(e)  { e.preventDefault(); document.getElementById('dropZone').classList.add('drag-over'); }
function onDragLeave()  { document.getElementById('dropZone').classList.remove('drag-over'); }
function onDrop(e)      { e.preventDefault(); document.getElementById('dropZone').classList.remove('drag-over'); if(e.dataTransfer.files.length) handleFileInputChange(e.dataTransfer.files); }

function handleFileInputChange(files) {
  if (!files || !files.length) return;
  pendingFiles = Array.from(files);
  const names = pendingFiles.map(f => f.name).join(', ');
  // Show preview for last file
  const last = pendingFiles[pendingFiles.length - 1];
  if (/\.(csv|tsv)$/i.test(last.name)) {
    const reader = new FileReader();
    reader.onload = e => showCSVPreview(e.target.result, last.name);
    reader.readAsText(last);
  } else {
    // Non-text file — just show file names
    document.getElementById('previewSection').style.display = '';
    document.getElementById('previewTable').innerHTML = `<tbody><tr><td colspan="4" style="padding:1rem;color:var(--t2)">${escapeHtml(names)}</td></tr></tbody>`;
    document.getElementById('rowCount').textContent = pendingFiles.length + ' file(s) staged for upload';
    document.getElementById('loadBtn').textContent  = 'Upload ' + pendingFiles.length + ' file(s)';
  }
}

function showCSVPreview(text, filename) {
  const lines   = text.trim().split(/\r?\n/).filter(l => l.trim()).slice(0, 10);
  const headers = splitCSVLine(lines[0]);
  const rows    = lines.slice(1, 8).map(l => splitCSVLine(l));
  const show    = headers.slice(0, 10);
  const table   = document.getElementById('previewTable');
  table.innerHTML = `
    <thead><tr>${show.map(h=>`<th>${escapeHtml(h)}</th>`).join('')}${headers.length>10?'<th>…</th>':''}</tr></thead>
    <tbody>${rows.map(r=>`<tr>${show.map((_,i)=>`<td>${escapeHtml(r[i]||'')}</td>`).join('')}${headers.length>10?'<td>…</td>':''}</tr>`).join('')}</tbody>`;
  document.getElementById('previewSection').style.display = '';
  document.getElementById('rowCount').textContent = `${filename} • ${lines.length - 1} rows previewed`;
  document.getElementById('loadBtn').textContent = 'Upload ' + pendingFiles.length + ' file(s)';
}

function splitCSVLine(line, delim = ',') {
  const out = []; let field = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i+1]==='"') { field+='"'; i++; } else inQ=!inQ; }
    else if (ch === delim && !inQ) { out.push(field.trim()); field=''; }
    else field += ch;
  }
  out.push(field.trim());
  return out;
}

async function uploadStagedFiles() {
  if (!pendingFiles.length) return;
  const btn = document.getElementById('loadBtn');
  btn.disabled = true; btn.textContent = 'Uploading…';

  const fd = new FormData();
  pendingFiles.forEach(f => fd.append('files', f));

  try {
    const res  = await fetch(`${API}/api/upload-files`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) { showError(data.error || 'Upload failed.'); return; }

    pendingFiles = [];
    document.getElementById('previewSection').style.display = 'none';

    const count = data.tables.length;
    showSuccess(`${count} table${count>1?'s':''} loaded! Opening dashboard…`);
    await refreshTableLibrary();
    switchTab('qa');
    // Open dashboard in new tab after a short delay so the success message is seen
    setTimeout(() => window.open('/dashboard', '_blank'), 800);
  } catch (e) {
    showError('Upload error: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Upload files';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TABLE LIBRARY (server-side DuckDB registry)
// ══════════════════════════════════════════════════════════════════════════════

async function refreshTableLibrary() {
  try {
    const res  = await fetch(`${API}/api/tables`);
    const data = await res.json();
    loadedTables = data.tables || {};
    renderTableLibrary();
    refreshTableContextBar();
    // Broadcast to dashboard page
    localStorage.setItem('convbi_tables_updated', Date.now().toString());
  } catch (_) {}
}

function renderTableLibrary() {
  const sec  = document.getElementById('tableLibrarySection');
  const list = document.getElementById('tableLibraryList');
  if (!sec || !list) return;
  const names = Object.keys(loadedTables);
  if (!names.length) { sec.style.display = 'none'; return; }
  sec.style.display = '';

  const sourceIcon = s => s === 'databricks' ? '🔷' : s === 's3' ? '🟠' : '📄';
  list.innerHTML = names.map(name => {
    const t = loadedTables[name];
    return `<div class="ds-item">
      <span class="ds-dot" style="background:#4F46E5"></span>
      <span class="ds-name">${escapeHtml(name)}</span>
      <span class="ds-badge">${sourceIcon(t.source||'file')} ${escapeHtml(t.source||'file')}</span>
      <span class="ds-rows">${(t.rowCount||0).toLocaleString()} rows</span>
      <span class="ds-rows">${(t.columns||[]).length} cols</span>
      <button class="ds-remove" title="Unload" onclick="removeTable('${escapeHtml(name)}')">✕</button>
    </div>`;
  }).join('');
}

async function removeTable(name) {
  await fetch(`${API}/api/tables/${encodeURIComponent(name)}`, { method: 'DELETE' });
  await refreshTableLibrary();
}

// ── Table context bar (which tables are in scope for the question) ─────────────
function refreshTableContextBar() {
  const bar   = document.getElementById('tableContextBar');
  const chips = document.getElementById('tableContextChips');
  if (!bar || !chips) return;
  const names = Object.keys(loadedTables);
  if (!names.length) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  // Default: all active
  if (!activeTableSet.size) names.forEach(n => activeTableSet.add(n));
  chips.innerHTML = names.map(n =>
    `<button class="ctx-chip ${activeTableSet.has(n)?'ctx-chip-on':''}" onclick="toggleTableCtx('${escapeHtml(n)}')">${escapeHtml(n)}</button>`
  ).join('');
}
function toggleTableCtx(name) {
  activeTableSet.has(name) ? activeTableSet.delete(name) : activeTableSet.add(name);
  refreshTableContextBar();
}
function selectAllTables() {
  Object.keys(loadedTables).forEach(n => activeTableSet.add(n));
  refreshTableContextBar();
}

// ══════════════════════════════════════════════════════════════════════════════
// INLINE DASHBOARD (Dashboard tab)
// ══════════════════════════════════════════════════════════════════════════════

async function renderInlineDashboard() {
  const dc = document.getElementById('dashContent');
  if (!dc) return;
  await refreshTableLibrary();
  const names = Object.keys(loadedTables);
  if (!names.length) {
    dc.innerHTML = '<div class="no-data">No data yet — upload a file in the Data Input tab.</div>';
    return;
  }

  // Pull sample data for each table to build charts
  dc.innerHTML = `<div style="padding:1.5rem;text-align:center;color:var(--t2)">Loading dashboard…</div>`;

  const tableData = {};
  for (const name of names.slice(0, 4)) {
    const res = await fetch(`${API}/api/execute-sql`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sql: `SELECT * FROM "${name}" LIMIT 2000` })
    }).catch(() => null);
    if (res && res.ok) {
      const d = await res.json();
      if (d.rows) tableData[name] = d;
    }
  }

  let html = '<div class="dash-grid">';
  for (const [name, d] of Object.entries(tableData)) {
    const numCols = (d.columns||[]).filter(c => ['INTEGER','BIGINT','DOUBLE','FLOAT','REAL'].some(t => (c.type||'').toUpperCase().startsWith(t)));
    const catCols = (d.columns||[]).filter(c => !numCols.find(n=>n.name===c.name) && !/date|time/i.test(c.name));
    const dateCols= (d.columns||[]).filter(c => /date|time/i.test(c.name));

    // KPI strip
    const kpis = numCols.slice(0, 3).map(col => {
      const vals = d.rows.map(r => +r[col.name]).filter(v => !isNaN(v));
      const sum  = vals.reduce((a,b)=>a+b, 0);
      const avg  = vals.length ? (sum/vals.length) : 0;
      const isRate = /pct|rate|efficiency|utilisation/i.test(col.name);
      return `<div class="mini-kpi"><div class="mini-kpi-label">${col.name.replace(/_/g,' ')}</div><div class="mini-kpi-val">${isRate ? avg.toFixed(1)+'%' : Math.round(sum).toLocaleString()}</div></div>`;
    });

    const chartId = 'chart_' + name.replace(/[^a-z0-9]/gi,'_') + '_' + Date.now();
    html += `
      <div class="card dash-card">
        <div class="dash-card-title">${escapeHtml(name)}
          <span class="dash-card-sub">${d.rowCount||d.rows.length} rows</span>
        </div>
        ${kpis.length ? `<div class="mini-kpi-row">${kpis.join('')}</div>` : ''}
        <div class="chart-wrap" style="height:200px"><div id="${chartId}" style="width:100%;height:100%"></div></div>
      </div>`;

    setTimeout(() => {
      const el = document.getElementById(chartId);
      if (!el || typeof echarts === 'undefined') return;
      const chart = echarts.init(el);
      let option;

      if (dateCols.length && numCols.length) {
        // Time series line
        const dc2 = dateCols[0].name, nc = numCols[0].name;
        const byDate = {};
        d.rows.forEach(r => {
          const k = (r[dc2]||'').slice(0,7);
          if (!byDate[k]) byDate[k] = [];
          byDate[k].push(+r[nc]||0);
        });
        const keys = Object.keys(byDate).sort().slice(-24);
        option = {
          grid:{top:20,right:10,bottom:30,left:50},
          xAxis:{type:'category',data:keys,axisLabel:{fontSize:10}},
          yAxis:{type:'value',axisLabel:{fontSize:10}},
          series:[{type:'line',data:keys.map(k=>+(byDate[k].reduce((a,b)=>a+b,0)/byDate[k].length).toFixed(2)),smooth:true,lineStyle:{width:2},itemStyle:{color:'#4F46E5'},areaStyle:{opacity:0.08}}],
          tooltip:{trigger:'axis'}
        };
      } else if (catCols.length && numCols.length) {
        // Bar chart
        const cc = catCols[0].name, nc = numCols[0].name;
        const groups = {};
        d.rows.forEach(r => { const k=r[cc]||'?'; if(!groups[k]) groups[k]=[]; groups[k].push(+r[nc]||0); });
        const keys = Object.keys(groups).slice(0,12);
        option = {
          grid:{top:20,right:10,bottom:40,left:50},
          xAxis:{type:'category',data:keys,axisLabel:{fontSize:10,rotate:keys.length>6?30:0}},
          yAxis:{type:'value',axisLabel:{fontSize:10}},
          series:[{type:'bar',data:keys.map(k=>+(groups[k].reduce((a,b)=>a+b,0)/groups[k].length).toFixed(2)),itemStyle:{color:'#0EA5E9',borderRadius:[4,4,0,0]}}],
          tooltip:{trigger:'axis'}
        };
      }
      if (option) chart.setOption(option);
    }, 200);
  }
  html += '</div>';
  dc.innerHTML = html;
}

// ══════════════════════════════════════════════════════════════════════════════
// SCHEMA BUILDING FOR LLM PROMPTS
// ══════════════════════════════════════════════════════════════════════════════

async function buildAllTableSchemas() {
  const schemas = {};
  const inScope = activeTableSet.size ? activeTableSet : new Set(Object.keys(loadedTables));
  for (const name of inScope) {
    const t = loadedTables[name];
    if (!t) continue;
    const sampleRes = await fetch(`${API}/api/execute-sql`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sql: `SELECT * FROM "${name}" LIMIT 5` })
    }).catch(() => null);
    const sample = sampleRes && sampleRes.ok ? (await sampleRes.json()).rows : [];
    schemas[name] = {
      rowCount:   t.rowCount || 0,
      columns:    t.columns  || [],
      source:     t.source   || 'file',
      sampleRows: sample
    };
  }
  return schemas;
}

function buildSemanticRulesFromSchemas(schemas) {
  let rules = `TABLES LOADED:\n`;
  for (const [name, s] of Object.entries(schemas)) {
    rules += `\nTable "${name}" (${s.rowCount} rows, source: ${s.source}):\n`;
    (s.columns||[]).forEach(c => { rules += `  - ${c.name}: ${c.type}\n`; });
  }
  rules += `
QUERY RULES:
- Use double-quoted table names: SELECT * FROM "tableName"
- DuckDB date_trunc('month', date_col) for month grouping
- STDDEV_POP(col) for standard deviation
- IQR outlier: percentile_cont(0.25/0.75) WITHIN GROUP (ORDER BY col)
- For cross-table queries, use JOIN when common columns exist
- For independent tables with no join, use UNION ALL with a source_table column`;
  return rules;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN QUESTION PIPELINE
// ══════════════════════════════════════════════════════════════════════════════

let isAsking = false;

async function askQuestion() {
  if (isAsking) return;
  const input = document.getElementById('qaInput');
  const q     = (input.value || '').trim();
  if (!q) return;

  const tables = Object.keys(loadedTables);
  if (!tables.length) { showError('Load some data first.'); return; }

  isAsking = true;
  input.value = '';
  input.disabled = true;
  document.getElementById('askBtn').disabled = true;

  appendUserMessage(q);
  const thinkingId = appendThinking();
  setWorkflowRuntime(6, 'Question captured and queued for analysis.');

  try {
    // 1. Build schemas & relationships
    const allTableSchemas = await buildAllTableSchemas();

    // Build a cheap cache key from schema + row counts
    const schemaHash = btoa(JSON.stringify(Object.entries(allTableSchemas).map(([t,s]) => [t, (s.columns||[]).map(c=>c.name).join(',')])).slice(0, 200)).slice(0, 32);
    const rowChecksum = Object.values(loadedTables).map(t => t.rowCount || 0).join(',');
    const cacheRes = await fetch(`${API}/api/check-cache`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ question: q, schemaHash, rowChecksum })
    }).then(r => r.ok ? r.json() : { hit: false }).catch(() => ({ hit: false }));

    if (cacheRes.hit && cacheRes.cached && hasLewSections(cacheRes.cached.answer || '')) {
      removeThinking(thinkingId);
      const c = cacheRes.cached;
      const sections = parseInterpretSections(c.answer || '');
      renderAnswerCard(q, sections, c.sql || '', c.decoded || null, { rows: c.rows || [], columns: c.columns || [] }, allTableSchemas, true);
      setWorkflowRuntime(9, 'Context-aware storytelling restored from cache.');
      renderFollowupRail(q, c.decoded || {});
      setWorkflowRuntime(11, 'Decision support reused from cached analytical result.');
      if (voiceMgr?.speakText && c.answer) voiceMgr.speakText(sections.directAnswer || sections.summary || '');
      saveToHistory(q, sections.directAnswer || sections.summary || '', c.sql || '');
      conversationTurns.push({ question: q, directAnswer: sections.directAnswer || sections.summary || '' });
      conversationTurns = conversationTurns.slice(-8);
      return;
    }

    let _cacheKey = cacheRes.key;
    let _cachePayload = { decoded: null, sql: null, rows: null, columns: null, answer: null };

    const relRes  = await fetch(`${API}/api/detect-relationships`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({}) });
    const relData = relRes.ok ? await relRes.json() : { joins: [], noRelation: [] };
    const semanticRules = buildSemanticRulesFromSchemas(allTableSchemas);

    // 2. Decode intent
    setWorkflowRuntime(7, 'Extracting business goal, KPI, filters, period, and context.');
    updateThinking(thinkingId, 'Step 7/11 · Intent understanding…');
    const intRes  = await fetch(`${API}/api/decode-intent`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        question: q,
        schemaProfile: allTableSchemas,
        semanticRules,
        relationships: relData,
        conversationContext: conversationTurns
      })
    });
    const intData = intRes.ok ? await intRes.json() : {};
    const decoded = intData.decoded;

    if (decoded?.needs_clarification && decoded.clarification_prompt) {
      removeThinking(thinkingId);
      appendClarification(decoded.clarification_prompt, q, decoded);
      return;
    }

    // 3. Generate SQL
    setWorkflowRuntime(8, 'Generating analytics plan and SQL computation path.');
    updateThinking(thinkingId, 'Step 8/11 · Building analytics query…');
    let sql = null, sqlError = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const genRes  = await fetch(`${API}/api/generate-code`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          question: q, allTableSchemas, relationships: relData,
          semanticRules, decodedIntent: decoded,
          ...(attempt > 0 ? { previousCode: sql, errorMessage: sqlError } : {})
        })
      });
      const genData = genRes.ok ? await genRes.json() : {};
      sql = genData.code;
      if (!sql) { sqlError = genData.error || 'No SQL generated'; continue; }

      // 4. Execute SQL
      updateThinking(thinkingId, 'Step 8/11 · Executing analytics engine…');
      const execRes  = await fetch(`${API}/api/execute-sql`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ sql })
      });
      const execData = execRes.ok ? await execRes.json() : {};

      if (execData.error) { sqlError = execData.error; continue; }

      // 5. Narrate
      setWorkflowRuntime(9, 'Preparing 6-part context-aware business storytelling.');
      updateThinking(thinkingId, 'Step 9/11 · Writing business narrative…');
      const allRows = execData.rows || [];
      // Cap rows sent to LLM to avoid token overuse — 30 rows is enough to narrate
      const resultForLLM = allRows.length === 1 ? allRows[0] : allRows.slice(0, 30);
      const narrateRes  = await fetch(`${API}/api/interpret`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ question: q, decodedIntent: decoded, sql, result: resultForLLM })
      });
      const narrateData = narrateRes.ok ? await narrateRes.json() : {};

      removeThinking(thinkingId);
      // Fallback: if LLM didn't narrate, produce a concise auto-summary instead of raw JSON dump
      let answerText = narrateData.answer;
      if (!answerText) {
        const n = allRows.length;
        const colNames = (execData.columns||[]).map(c=>c.name).join(', ');
        answerText = [
          '##DIRECT_ANSWER##',
          `Query returned ${n} row${n!==1?'s':''}.`,
          '##WHAT_HAPPENED##',
          colNames ? `The query produced data with columns: ${colNames}.` : 'The query completed successfully.',
          '##WHY_HAPPENED##',
          'This result reflects the applied filters and aggregation in the generated SQL.',
          '##SUPPORTING_EVIDENCE##',
          `- Returned rows: ${n}`,
          '- SQL executed successfully',
          '##BUSINESS_IMPACT##',
          'Use this result to validate current performance and identify whether action is needed.',
          '##RECOMMENDED_ACTION##',
          '- Review top and bottom contributors',
          '- Compare with previous period for context'
        ].join('\n');
      }
      const sections = parseInterpretSections(answerText);
      renderAnswerCard(q, sections, sql, decoded, execData, allTableSchemas);
      setWorkflowRuntime(10, 'Follow-up prompts are ready for deeper exploration.');
      renderFollowupRail(q, decoded || {});
      setWorkflowRuntime(11, 'Decision support generated with recommendations and impacts.');

      // Save to history
      saveToHistory(q, sections.directAnswer || sections.summary || '', sql);
      conversationTurns.push({ question: q, directAnswer: sections.directAnswer || sections.summary || '' });
      conversationTurns = conversationTurns.slice(-8);
      localStorage.setItem('convbi_tables_updated', Date.now().toString());

      if (_cacheKey) {
        _cachePayload.decoded = decoded;
        _cachePayload.sql = sql;
        _cachePayload.rows = allRows.slice(0, 100);
        _cachePayload.columns = execData.columns;
        _cachePayload.answer = answerText;
        fetch(`${API}/api/save-cache`, {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ key: _cacheKey, value: _cachePayload })
        }).catch(() => {});
      }
      return;
    }

    // All retries failed
    removeThinking(thinkingId);
    appendErrorMessage(`Could not answer: ${sqlError}`);

  } catch (e) {
    removeThinking(thinkingId);
    setWorkflowRuntime(6, 'Pipeline failed. Review error and retry question.');
    appendErrorMessage('Error: ' + e.message);
  } finally {
    isAsking = false;
    input.disabled = false;
    document.getElementById('askBtn').disabled = false;
    input.focus();
  }
}

// ── Clarification flow ────────────────────────────────────────────────────────
function appendClarification(prompt, origQ, decoded) {
  const msgs = document.getElementById('messages');
  const div  = document.createElement('div');
  div.className = 'msg bot';
  div.innerHTML = `
    <div class="msg-bubble">
      <div class="answer-summary">${escapeHtml(prompt)}</div>
      <div style="margin-top:.75rem;display:flex;gap:.5rem">
        <input id="clarifyInput" class="clarify-input" placeholder="Your clarification…" onkeydown="if(event.key==='Enter') submitClarification('${escapeHtml(origQ)}')"/>
        <button class="qa-ask-btn" onclick="submitClarification('${escapeHtml(origQ)}')">Send</button>
      </div>
    </div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function submitClarification(origQ) {
  const inp = document.getElementById('clarifyInput');
  const val = (inp?.value||'').trim();
  if (!val) return;
  document.getElementById('qaInput').value = origQ + ' — ' + val;
  askQuestion();
}

// ── Message helpers ───────────────────────────────────────────────────────────
function appendUserMessage(q) {
  const msgs = document.getElementById('messages');
  const div  = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="msg-bubble">${escapeHtml(q)}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function appendThinking() {
  const msgs = document.getElementById('messages');
  const id   = 'think_' + Date.now();
  const div  = document.createElement('div');
  div.id = id; div.className = 'msg bot';
  div.innerHTML = `<div class="msg-bubble thinking"><span class="think-dot"></span><span class="think-dot"></span><span class="think-dot"></span><span class="think-label" id="${id}_lbl">Thinking…</span></div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return id;
}
function updateThinking(id, text) {
  const el = document.getElementById(id+'_lbl');
  if (el) el.textContent = text;
}
function removeThinking(id) {
  document.getElementById(id)?.remove();
}
function appendErrorMessage(msg) {
  const msgs = document.getElementById('messages');
  const div  = document.createElement('div');
  div.className = 'msg bot';
  div.innerHTML = `<div class="msg-bubble error-bubble">${escapeHtml(msg)}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

// ── Parse ##SUMMARY## / ##INSIGHT## / ##APPROACH## ───────────────────────────
function parseInterpretSections(text) {
  if (!text) return { summary: text };
  const da = text.match(/##DIRECT_ANSWER##\s*([\s\S]*?)(?=##WHAT_HAPPENED##|##WHY_HAPPENED##|##SUPPORTING_EVIDENCE##|##BUSINESS_IMPACT##|##RECOMMENDED_ACTION##|$)/i);
  const wh = text.match(/##WHAT_HAPPENED##\s*([\s\S]*?)(?=##DIRECT_ANSWER##|##WHY_HAPPENED##|##SUPPORTING_EVIDENCE##|##BUSINESS_IMPACT##|##RECOMMENDED_ACTION##|$)/i);
  const yh = text.match(/##WHY_HAPPENED##\s*([\s\S]*?)(?=##DIRECT_ANSWER##|##WHAT_HAPPENED##|##SUPPORTING_EVIDENCE##|##BUSINESS_IMPACT##|##RECOMMENDED_ACTION##|$)/i);
  const se = text.match(/##SUPPORTING_EVIDENCE##\s*([\s\S]*?)(?=##DIRECT_ANSWER##|##WHAT_HAPPENED##|##WHY_HAPPENED##|##BUSINESS_IMPACT##|##RECOMMENDED_ACTION##|$)/i);
  const bi = text.match(/##BUSINESS_IMPACT##\s*([\s\S]*?)(?=##DIRECT_ANSWER##|##WHAT_HAPPENED##|##WHY_HAPPENED##|##SUPPORTING_EVIDENCE##|##RECOMMENDED_ACTION##|$)/i);
  const ra = text.match(/##RECOMMENDED_ACTION##\s*([\s\S]*?)(?=##DIRECT_ANSWER##|##WHAT_HAPPENED##|##WHY_HAPPENED##|##SUPPORTING_EVIDENCE##|##BUSINESS_IMPACT##|$)/i);

  if (da || wh || yh || se || bi || ra) {
    return {
      directAnswer: da ? da[1].trim() : '',
      whatHappened: wh ? wh[1].trim() : '',
      whyHappened: yh ? yh[1].trim() : '',
      supportingEvidence: se ? se[1].trim() : '',
      businessImpact: bi ? bi[1].trim() : '',
      recommendedAction: ra ? ra[1].trim() : '',
      summary: da ? da[1].trim() : text.trim()
    };
  }

  const sm = text.match(/##SUMMARY##\s*([\s\S]*?)(?=##INSIGHT##|##APPROACH##|$)/i);
  const im = text.match(/##INSIGHT##\s*([\s\S]*?)(?=##SUMMARY##|##APPROACH##|$)/i);
  const am = text.match(/##APPROACH##\s*([\s\S]*?)(?=##SUMMARY##|##INSIGHT##|$)/i);
  return {
    directAnswer: sm ? sm[1].trim() : text.trim(),
    whatHappened: im ? im[1].trim() : '',
    whyHappened: '',
    supportingEvidence: am ? am[1].trim() : '',
    businessImpact: '',
    recommendedAction: '',
    summary: sm ? sm[1].trim() : text.trim()
  };
}

// ── Render answer card ────────────────────────────────────────────────────────
function renderAnswerCard(question, sections, sql, decoded, execData, schemas, fromCache = false) {
  const msgs = document.getElementById('messages');
  const div  = document.createElement('div');
  div.className = 'msg bot answer-card-msg';

  const tablesUsed = decoded?.tables_needed || Object.keys(schemas||{}).slice(0,3);
  const joinInfo   = decoded?.join_hint ? `<div class="answer-join">JOIN: ${escapeHtml(decoded.join_hint)}</div>` : '';

  // Build chart, but keep it hidden by default (dashboard-first UX)
  let chartHtml = '';
  if (execData?.rows?.length > 1) {
    chartHtml = buildEChartsHtml(execData.columns || [], execData.rows, question);
  }

  const cardId = 'ac_' + Date.now();
  answerPayloadStore[cardId] = {
    question,
    sections,
    sql,
    tablesUsed,
    rowsPreview: (execData?.rows || []).slice(0, 20)
  };

  div.innerHTML = `
    <div class="msg-bubble answer-card" id="${cardId}">
      <div class="answer-meta">
        <div class="answer-tables">${tablesUsed.map(t=>`<span class="answer-table-chip">${escapeHtml(t)}</span>`).join('')}</div>
        ${fromCache ? '<span class="cached-badge">&#9889; cached</span>' : ''}
        ${joinInfo}
      </div>
      <div class="answer-summary"><strong>1) Direct Answer:</strong> ${escapeHtml(sections.directAnswer || sections.summary || '')}</div>
      <div class="answer-insight"><strong>2) What Happened:</strong> ${escapeHtml(sections.whatHappened || 'Not available')}</div>
      <div class="answer-insight"><strong>3) Why It Happened:</strong> ${escapeHtml(sections.whyHappened || 'Not available')}</div>
      <div class="answer-insight"><strong>4) Supporting Evidence:</strong><br/>${escapeHtml(sections.supportingEvidence || 'Not available').replace(/\n/g,'<br/>')}</div>
      <div class="answer-insight"><strong>5) Business Impact:</strong> ${escapeHtml(sections.businessImpact || 'Not available')}</div>
      <div class="answer-insight"><strong>6) Recommended Action:</strong><br/>${escapeHtml(sections.recommendedAction || 'Not available').replace(/\n/g,'<br/>')}</div>
      ${chartHtml}
      <details class="answer-approach-detail">
        <summary class="approach-toggle">How this was solved</summary>
        <div class="approach-body">
          <details class="sql-detail">
            <summary class="sql-toggle">⟨/⟩ View SQL</summary>
            <pre class="sql-pre">${escapeHtml(sql||'')}</pre>
            <button class="copy-sql-btn" onclick="copySQL('${cardId}')">Copy SQL</button>
          </details>
        </div>
      </details>
      <div class="answer-actions">
        <button class="action-btn" onclick="speakAnswer('${cardId}')">🔊 Speak</button>
        <button class="action-btn" onclick="pinInsight('${cardId}','${escapeHtml(question)}','${escapeHtml(sections.directAnswer || sections.summary || '')}')">📌 Pin</button>
        <button class="action-btn" onclick="chartAnswer('${cardId}')">📊 Show/Hide Chart</button>
        <button class="action-btn" onclick="exportAnswerReport('${cardId}')">Export Report</button>
        <button class="action-btn" onclick="generateExecutiveSummary('${cardId}')">Executive Summary</button>
      </div>
      <div class="answer-insight" style="margin-top:10px"><strong>Decision Support:</strong> Prioritize recommended actions by business impact, then monitor KPI trend and risk weekly.</div>
    </div>`;

  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;

  // Render any pending ECharts
  setTimeout(() => renderPendingECharts(), 100);
}

// ── Mic toggle ────────────────────────────────────────────────────────────────
function toggleMic() {
  if (voiceMgr) voiceMgr.toggleMic();
}

// ── Speak answer ─────────────────────────────────────────────────────────────
function speakAnswer(cardId) {
  const card = document.getElementById(cardId);
  const blocks = card ? [...card.querySelectorAll('.answer-summary, .answer-insight')] : [];
  const text  = blocks.map(b => b.textContent).filter(Boolean).join('. ');
  if (!voiceMgr || !text) return;
  // If currently speaking this card, stop
  const stopBtn = card?.querySelector('.speak-stop-btn');
  if (stopBtn && stopBtn.style.display !== 'none') {
    voiceMgr.stopSpeaking();
    return;
  }
  voiceMgr.speakText(text);
}

// ── Pin insight ───────────────────────────────────────────────────────────────
function pinInsight(cardId, question, summary) {
  savedInsights.unshift({ id: Date.now(), question, summary, ts: new Date().toISOString() });
  if (savedInsights.length > 50) savedInsights.pop();
  localStorage.setItem('convbi_insights', JSON.stringify(savedInsights));
  showSuccess('Insight pinned!');
}

// ── Copy SQL ──────────────────────────────────────────────────────────────────
function copySQL(cardId) {
  const card = document.getElementById(cardId);
  const pre  = card?.querySelector('.sql-pre');
  if (pre) navigator.clipboard.writeText(pre.textContent).then(() => showSuccess('SQL copied!'));
}

// ── Chart answer button ───────────────────────────────────────────────────────
function chartAnswer(cardId) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const cw = card.querySelector('.ec-chart-wrap');
  if (cw) cw.style.display = cw.style.display === 'none' ? '' : 'none';
}

async function exportAnswerReport(cardId) {
  const payload = answerPayloadStore[cardId];
  if (!payload) return showError('Report data not found for this answer.');
  try {
    const res = await fetch(`${API}/api/export-report`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        question: payload.question,
        sections: payload.sections,
        sql: payload.sql,
        tablesUsed: payload.tablesUsed,
        generatedAt: new Date().toISOString()
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not export report.');
    downloadTextFile(data.fileName || `convbi_report_${Date.now()}.md`, data.content || '');
    showSuccess('Business report exported.');
  } catch (e) {
    showError('Export failed: ' + e.message);
  }
}

async function generateExecutiveSummary(cardId) {
  const payload = answerPayloadStore[cardId];
  if (!payload) return showError('Summary data not found for this answer.');
  try {
    const res = await fetch(`${API}/api/generate-executive-summary`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        question: payload.question,
        sections: payload.sections,
        sql: payload.sql,
        rowsPreview: payload.rowsPreview
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Executive summary unavailable.');
    appendExecutiveSummaryMessage(payload.question, data.summary || 'No summary generated.');
  } catch (e) {
    showError('Executive summary failed: ' + e.message);
  }
}

function appendExecutiveSummaryMessage(question, summary) {
  const msgs = document.getElementById('messages');
  const div  = document.createElement('div');
  div.className = 'msg bot';
  div.innerHTML = `<div class="msg-bubble"><strong>Executive Summary</strong><br/>${escapeHtml(summary).replace(/\n/g,'<br/>')}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  saveToHistory(`Executive Summary: ${question}`, summary, '');
}

function downloadTextFile(fileName, text) {
  const blob = new Blob([text], { type: 'text/markdown' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: fileName
  });
  a.click();
}

// ── Chip / history ────────────────────────────────────────────────────────────
function useChip(btn) {
  document.getElementById('qaInput').value = btn.textContent.trim();
  document.getElementById('qaInput').focus();
}

let queryHistory = [];
function saveToHistory(q, summary, sql) {
  queryHistory.unshift({ q, summary, sql, ts: new Date().toISOString() });
  if (queryHistory.length > 20) queryHistory.pop();
  localStorage.setItem('convbi_history', JSON.stringify(queryHistory));
}

function hasLewSections(text) {
  if (!text) return false;
  const tags = [
    '##DIRECT_ANSWER##',
    '##WHAT_HAPPENED##',
    '##WHY_HAPPENED##',
    '##SUPPORTING_EVIDENCE##',
    '##BUSINESS_IMPACT##',
    '##RECOMMENDED_ACTION##'
  ];
  return tags.every(t => String(text).includes(t));
}

// ══════════════════════════════════════════════════════════════════════════════
// ECHARTS INTEGRATION
// ══════════════════════════════════════════════════════════════════════════════

const pendingECharts = [];

function buildEChartsHtml(columns, rows, question) {
  if (!rows || rows.length < 2) return '';
  const id = 'ec_' + Date.now() + '_' + Math.floor(Math.random()*9999);

  const numCols  = columns.filter(c => rows.some(r => typeof r[c.name] === 'number'));
  const dateCols = columns.filter(c => /date|time|month|period/i.test(c.name) || (rows[0]?.[c.name]||'').match?.(/^\d{4}-\d{2}/));
  const catCols  = columns.filter(c => !numCols.find(n=>n.name===c.name) && !dateCols.find(n=>n.name===c.name));

  let option = null;

  if (dateCols.length && numCols.length) {
    const xCol = dateCols[0].name;
    option = {
      grid: {top:30,right:20,bottom:40,left:60},
      xAxis: {type:'category',data:rows.map(r=>String(r[xCol]).slice(0,7)),axisLabel:{fontSize:11,rotate:rows.length>10?30:0}},
      yAxis: {type:'value',axisLabel:{fontSize:11}},
      legend: numCols.length>1 ? {top:5} : {show:false},
      series: numCols.slice(0,4).map((c,i) => ({
        name: c.name, type:'line',
        data: rows.map(r=>r[c.name]),
        smooth: true, lineStyle:{width:2},
        itemStyle:{color:['#4F46E5','#0EA5E9','#059669','#D97706'][i]}
      })),
      tooltip:{trigger:'axis'}
    };
  } else if (catCols.length && numCols.length) {
    const xCol = catCols[0].name, yCol = numCols[0].name;
    const limited = rows.slice(0, 20);
    option = {
      grid: {top:30,right:20,bottom:50,left:70},
      xAxis: {type:'category',data:limited.map(r=>String(r[xCol])),axisLabel:{fontSize:11,rotate:limited.length>8?30:0}},
      yAxis: {type:'value',axisLabel:{fontSize:11}},
      series: [{type:'bar',data:limited.map(r=>r[yCol]),
        itemStyle:{color:'#4F46E5',borderRadius:[4,4,0,0]},
        label:{show:limited.length<=12,position:'top',fontSize:10}}],
      tooltip:{trigger:'axis'}
    };
  } else if (numCols.length === 2 && rows.length >= 5) {
    option = {
      grid: {top:30,right:20,bottom:40,left:60},
      xAxis: {type:'value',name:numCols[0].name,nameLocation:'middle',nameGap:25,axisLabel:{fontSize:11}},
      yAxis: {type:'value',name:numCols[1].name,nameLocation:'middle',nameGap:40,axisLabel:{fontSize:11}},
      series: [{type:'scatter',data:rows.map(r=>[r[numCols[0].name],r[numCols[1].name]]),
        itemStyle:{color:'#4F46E5',opacity:0.7}}],
      tooltip:{trigger:'item'}
    };
  }

  if (!option) return '';
  pendingECharts.push({ id, option });
  return `<div class="ec-chart-wrap" style="display:none"><div id="${id}" style="width:100%;height:240px"></div></div>`;
}

function renderPendingECharts() {
  if (typeof echarts === 'undefined') return;
  pendingECharts.forEach(({ id, option }) => {
    const el = document.getElementById(id);
    if (el && !el._chart) {
      const c = echarts.init(el);
      c.setOption(option);
      el._chart = c;
    }
  });
  pendingECharts.length = 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// DATABRICKS BROWSER (legacy compat)
// ══════════════════════════════════════════════════════════════════════════════

async function initDatabricksBrowser() {
  const dot  = document.getElementById('dbStatusDot');
  const text = document.getElementById('dbStatusText');
  if (!dot||!text) return;
  text.textContent = 'Connecting…';
  try {
    const r    = await fetch(`${API}/api/databricks/status`);
    const data = await r.json();
    if (data.connected) {
      dot.className  = 'db-dot db-dot-ok';
      text.textContent = 'Connected to ' + data.hostname;
      loadDbCatalogs();
    } else {
      dot.className = 'db-dot db-dot-err';
      text.textContent = 'Error: ' + (data.error||'Not connected');
    }
  } catch (e) {
    dot.className = 'db-dot db-dot-err';
    text.textContent = 'Could not reach Databricks API';
  }
}

async function loadDbCatalogs() {
  const list = document.getElementById('dbCatalogList');
  if (!list) return;
  list.innerHTML = '<div class="db-loading">Loading…</div>';
  const r    = await fetch(`${API}/api/databricks/catalogs`);
  const data = await r.json();
  const cats = data.catalogs || [];
  list.innerHTML = cats.map(c =>
    `<div class="db-item" onclick="selectDbCatalog('${escapeHtml(c)}')">${escapeHtml(c)}</div>`
  ).join('') || '<div class="db-loading">No catalogs found</div>';
}

async function selectDbCatalog(catalog) {
  dbBrowserState.catalog = catalog; dbBrowserState.schema = null; dbBrowserState.table = null;
  document.querySelectorAll('#dbCatalogList .db-item').forEach(el => el.classList.toggle('db-item-active', el.textContent===catalog));
  document.getElementById('dbSchemaList').innerHTML = '<div class="db-loading">Loading…</div>';
  document.getElementById('dbTableList').innerHTML  = '';
  const r    = await fetch(`${API}/api/databricks/schemas`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ catalog }) });
  const data = await r.json();
  document.getElementById('dbSchemaList').innerHTML = (data.schemas||[]).map(s =>
    `<div class="db-item" onclick="selectDbSchema('${escapeHtml(s)}')">${escapeHtml(s)}</div>`
  ).join('') || '<div class="db-loading">No schemas</div>';
}

async function selectDbSchema(schema) {
  dbBrowserState.schema = schema; dbBrowserState.table = null;
  document.querySelectorAll('#dbSchemaList .db-item').forEach(el => el.classList.toggle('db-item-active', el.textContent===schema));
  document.getElementById('dbTableList').innerHTML = '<div class="db-loading">Loading…</div>';
  const r    = await fetch(`${API}/api/databricks/tables`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ catalog: dbBrowserState.catalog, schema }) });
  const data = await r.json();
  document.getElementById('dbTableList').innerHTML = (data.tables||[]).map(t =>
    `<div class="db-item" onclick="selectDbTable('${escapeHtml(t.name)}')">${escapeHtml(t.name)}</div>`
  ).join('') || '<div class="db-loading">No tables</div>';
}

async function selectDbTable(table) {
  dbBrowserState.table = table;
  document.querySelectorAll('#dbTableList .db-item').forEach(el => el.classList.toggle('db-item-active', el.textContent===table));
  const btn = document.getElementById('dbLoadTableBtn');
  if (btn) { btn.disabled = false; btn.textContent = `Load "${table}"`; }
  // Preview
  const r    = await fetch(`${API}/api/databricks/preview`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ catalog:dbBrowserState.catalog, schema:dbBrowserState.schema, table }) });
  const data = await r.json();
  const area = document.getElementById('dbPreviewArea');
  if (!area || !data.rows) return;
  const cols = (data.columns||[]).slice(0,8);
  area.innerHTML = `<table class="preview-t">
    <thead><tr>${cols.map(c=>`<th>${escapeHtml(c.name)}</th>`).join('')}</tr></thead>
    <tbody>${(data.rows||[]).slice(0,8).map(r=>`<tr>${cols.map(c=>`<td>${escapeHtml(String(r[c.name]||''))}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

async function loadDatabricksTable() {
  const { catalog, schema, table } = dbBrowserState;
  if (!table) return;
  const btn = document.getElementById('dbLoadTableBtn');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const r    = await fetch(`${API}/api/databricks/load-table`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ catalog, schema, table }) });
    const data = await r.json();
    if (data.rows) {
      // Register into DuckDB via bulk register endpoint
      const safeName = table.replace(/[^a-zA-Z0-9_]/g,'_');
      await fetch(`${API}/api/tables/register`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ name: safeName, data: data.rows, sourceMeta: { source:'databricks', sourceLabel:`${catalog}.${schema}.${table}` } })
      });
      showSuccess(`Table "${table}" loaded — ${data.rows.length} rows.`);
      await refreshTableLibrary();
      switchTab('qa');
      setTimeout(() => window.open('/dashboard', '_blank'), 800);
    }
  } catch (e) {
    showError('Load error: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = `Load "${table}"`;
  }
}

// ── AWS S3 connector ──────────────────────────────────────────────────────────

// Cached credentials for load calls
let _s3Creds     = null;
let _s3EnvCreds  = null;   // credentials that came from server .env

async function initS3Panel() {
  try {
    const res  = await fetch('/api/s3/defaults');
    if (!res.ok) return;
    const d = await res.json();
    _s3EnvCreds = d;

    if (d.hasEnvCreds) {
      // Pre-fill visible fields
      const regionEl = document.getElementById('s3Region');
      const bucketEl = document.getElementById('s3Bucket');
      if (regionEl) regionEl.value = d.region  || '';
      if (bucketEl) bucketEl.value = d.bucket  || '';

      // Hide credential input fields, show the banner
      const fields = document.getElementById('s3CredFields');
      const note   = document.getElementById('s3CredNote');
      const banner = document.getElementById('s3EnvBanner');
      if (fields)  fields.style.display  = 'none';
      if (note)    note.style.display    = 'none';
      if (banner)  banner.style.display  = 'flex';
    }
  } catch (_) {}
}

function s3ShowManualFields() {
  const fields = document.getElementById('s3CredFields');
  const note   = document.getElementById('s3CredNote');
  const banner = document.getElementById('s3EnvBanner');
  if (fields)  fields.style.display  = '';
  if (note)    note.style.display    = '';
  if (banner)  banner.style.display  = 'none';
  _s3EnvCreds = null;   // force manual path
}

async function browseS3() {
  // Use env-sourced creds if fields are hidden (no override)
  const usingEnv = _s3EnvCreds?.hasEnvCreds &&
    document.getElementById('s3CredFields')?.style.display === 'none';

  const region          = usingEnv ? (_s3EnvCreds.region  || '') : (document.getElementById('s3Region')?.value.trim()  || '');
  const accessKeyId     = usingEnv ? ''                          : (document.getElementById('s3AccessKey')?.value.trim() || '');
  const secretAccessKey = usingEnv ? ''                          : (document.getElementById('s3SecretKey')?.value.trim() || '');
  const bucket          = usingEnv ? (_s3EnvCreds.bucket  || '') : (document.getElementById('s3Bucket')?.value.trim()  || '');
  const prefix          = document.getElementById('s3Prefix')?.value.trim();

  // When NOT using env creds, validate that user filled all fields
  if (!usingEnv && (!region || !accessKeyId || !secretAccessKey || !bucket)) {
    showError('Please fill in Region, Access Key ID, Secret Access Key, and Bucket before browsing.');
    return;
  }
  if (!region || !bucket) {
    showError('Region and Bucket are required.');
    return;
  }

  // Only include creds in body when user typed them; if usingEnv, server reads from process.env
  _s3Creds = usingEnv
    ? { region, accessKeyId: '', secretAccessKey: '', bucket, prefix }
    : { region, accessKeyId, secretAccessKey, bucket, prefix };

  const browseBody = usingEnv
    ? { region, bucket, prefix }
    : { region, accessKeyId, secretAccessKey, bucket, prefix };

  const listEl = document.getElementById('s3FileList');
  if (listEl) listEl.innerHTML = '<div style="color:var(--t2);font-size:13px;padding:8px 0">Connecting to S3…</div>';

  try {
    const resp = await fetch('/api/s3/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(browseBody)
    });
    const data = await resp.json();

    if (!resp.ok) {
      const msg = data.error || resp.statusText;
      showError('S3 browse error: ' + msg);
      if (listEl) listEl.innerHTML = `<div style="color:#ef4444;font-size:13px;padding:8px;background:rgba(239,68,68,.1);border-radius:6px;border:1px solid rgba(239,68,68,.3)"><strong>S3 Error:</strong> ${escapeHtml(msg)}</div>`;
      return;
    }

    const files = data.files || [];
    if (files.length === 0) {
      if (listEl) listEl.innerHTML = '<div style="color:var(--t2);font-size:13px;padding:8px 0">No supported files found in <strong>' + escapeHtml(bucket + (prefix ? '/' + prefix : '')) + '</strong>. Supported: CSV, TSV, JSON, Parquet, Excel.</div>';
      return;
    }

    // Render file list — use data-s3key to avoid quote escaping issues in onclick
    const rows = files.map(f => `
      <div class="s3-file-row" style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
        <span class="s3-ext-badge" style="font-size:10px;font-weight:700;background:var(--accent);color:#fff;padding:2px 6px;border-radius:4px;min-width:38px;text-align:center;text-transform:uppercase">${escapeHtml(f.ext)}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(f.key)}">${escapeHtml(f.name)}</div>
          <div style="font-size:11px;color:var(--t2)">${escapeHtml(f.sizeLabel)} &bull; ${escapeHtml(f.key)}</div>
        </div>
        <button data-s3key="${escapeHtml(f.key)}" onclick="loadS3FileFromBtn(this)" style="font-size:12px;padding:4px 12px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap">Load</button>
      </div>`).join('');

    if (listEl) listEl.innerHTML = `
      <div style="font-size:12px;color:var(--t2);margin-bottom:6px">${files.length} file${files.length !== 1 ? 's' : ''} in <strong>${escapeHtml(bucket + (prefix ? '/' + prefix : ''))}</strong></div>
      ${rows}`;
  } catch (e) {
    showError('S3 connection failed: ' + e.message);
    if (listEl) listEl.innerHTML = '';
  }
}

function loadS3FileFromBtn(btn) {
  loadS3File(btn.dataset.s3key, btn);
}

async function loadS3File(key, btn) {
  if (!_s3Creds) { showError('Browse S3 first to set credentials.'); return; }
  const { region, accessKeyId, secretAccessKey, bucket } = _s3Creds;
  const usingEnv = _s3EnvCreds?.hasEnvCreds && !accessKeyId;

  if (!btn) btn = [...document.querySelectorAll('[data-s3key]')].find(b => b.dataset.s3key === key);
  const origText = btn?.textContent;
  if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }

  const loadBody = usingEnv
    ? { region, bucket, key }
    : { region, accessKeyId, secretAccessKey, bucket, key };

  try {
    const resp = await fetch('/api/s3/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loadBody)
    });
    const data = await resp.json();

    if (!resp.ok) {
      showError('S3 load error: ' + (data.error || resp.statusText));
      if (btn) { btn.textContent = origText; btn.disabled = false; }
      return;
    }

    const tables = data.tables || [];
    const names  = tables.map(t => t.tableName || t.name || t).join(', ');
    showSuccess(`Loaded from S3: ${names || key}`);
    if (btn) { btn.textContent = 'Loaded ✓'; btn.style.background = 'var(--green, #16a34a)'; }

    await refreshTableLibrary();
    setTimeout(() => switchTab('qa'), 800);
  } catch (e) {
    showError('S3 load failed: ' + e.message);
    if (btn) { btn.textContent = origText; btn.disabled = false; }
  }
}

// ── Voice settings modal ─────────────────────────────────────────────────────
function openVoiceSettings()  { document.getElementById('voiceSettingsModal').style.display = ''; }
function closeVoiceSettings() { document.getElementById('voiceSettingsModal').style.display = 'none'; }
function selectVoice(id)      { if (voiceMgr) voiceMgr.setVoice(id); }
function previewVoice(id)     { if (voiceMgr) voiceMgr.previewVoice(id); }
function updateVoiceSpeed(v)  {
  document.getElementById('voiceSpeedVal').textContent = parseFloat(v).toFixed(2) + '×';
  if (voiceMgr) voiceMgr.setSpeed(parseFloat(v));
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  await refreshTableLibrary();
  switchTab(getInitialTabFromUrl());
  setWorkflowRuntime(6, 'Ready for your business question.');
  // Load query history
  try { queryHistory = JSON.parse(localStorage.getItem('convbi_history')||'[]'); } catch (_) {}
  // Set up voice manager if available
  if (typeof VoiceManager !== 'undefined') {
    voiceMgr = new VoiceManager({
      onMicState: (active) => {
        const btn = document.getElementById('micBtn');
        if (btn) btn.classList.toggle('mic-recording', active);
      },
      onTranscript: (text) => {
        // Live transcript shown in input — user presses Ask manually
      },
      onSpeakingState: (speaking) => {
        // Update any active speak buttons
        document.querySelectorAll('.speak-stop-btn').forEach(b => {
          b.style.display = speaking ? '' : 'none';
        });
        document.querySelectorAll('.speak-start-btn').forEach(b => {
          b.style.display = speaking ? 'none' : '';
        });
      },
      onError: (msg) => showError('Voice: ' + msg)
    });
  }
})();
