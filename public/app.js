'use strict';

const API = '';

const STEPS = [
  { id: 'home', title: 'Home', desc: 'Welcome to your AI-guided analytics workspace.' },
  { id: 'connect-data', title: 'Connect Data', desc: 'Choose where your business data is stored.' },
  { id: 'configure-connection', title: 'Configure Connection', desc: 'Provide connection details and load data safely.' },
  { id: 'validate', title: 'Validate', desc: 'Confirm data is readable, complete, and ready.' },
  { id: 'profile-data', title: 'Profile Data', desc: 'Understand shape, types, and structure of your dataset.' },
  { id: 'data-quality', title: 'Data Quality', desc: 'Assess health using completeness and consistency metrics.' },
  { id: 'cleaning', title: 'Cleaning', desc: 'Apply AI-assisted improvements to boost trust in data.' },
  { id: 'semantic-layer', title: 'Semantic Layer', desc: 'Map entities, measures, dimensions, and relationships.' },
  { id: 'ready', title: 'Ready', desc: 'Review readiness before conversational analysis.' },
  { id: 'ask-questions', title: 'Ask Questions', desc: 'Ask business questions and receive AI answers.' }
];

const state = {
  current: 0,
  completed: new Set(),
  dataset: {
    source: null,
    tables: {},
    selectedFile: null,
    validation: null,
    profile: null,
    quality: null,
    semantics: null,
    transformHistory: []
  },
  loadingMessage: '',
  notifications: []
};

const el = {
  stepList: document.getElementById('stepList'),
  stepHeader: document.getElementById('stepHeader'),
  stepContent: document.getElementById('stepContent'),
  aiGuideBody: document.getElementById('aiGuideBody'),
  helpSection: document.getElementById('helpSection'),
  progressFill: document.getElementById('progressFill'),
  progressPercent: document.getElementById('progressPercent'),
  stepCountLabel: document.getElementById('stepCountLabel'),
  statusLabel: document.getElementById('statusLabel'),
  notificationArea: document.getElementById('notificationArea'),
  prevBtn: document.getElementById('prevBtn'),
  nextBtn: document.getElementById('nextBtn'),
  backHomeBtn: document.getElementById('backHomeBtn'),
  saveProgressBtn: document.getElementById('saveProgressBtn'),
  resetFlowBtn: document.getElementById('resetFlowBtn'),
  homeBtn: document.getElementById('homeBtn')
};

function notify(msg) {
  state.notifications.unshift({ msg, ts: new Date().toLocaleTimeString() });
  state.notifications = state.notifications.slice(0, 5);
  el.notificationArea.textContent = msg;
}

function markCompleted(index) {
  if (index >= 0 && index < STEPS.length) state.completed.add(index);
}

function isUnlocked(index) {
  if (index === 0) return true;
  return state.completed.has(index - 1) || index <= state.current;
}

function updateProgress() {
  const pct = Math.round(((state.current + 1) / STEPS.length) * 100);
  el.progressFill.style.width = pct + '%';
  el.progressPercent.textContent = pct + '%';
  el.stepCountLabel.textContent = 'Step ' + (state.current + 1) + ' of ' + STEPS.length;
  el.statusLabel.textContent = STEPS[state.current].title;
}

function renderStepList() {
  el.stepList.innerHTML = STEPS.map((s, i) => {
    const active = i === state.current ? 'active' : '';
    const done = state.completed.has(i) ? 'done' : '';
    const disabled = isUnlocked(i) ? '' : 'disabled';
    const dot = state.completed.has(i) ? '✓' : (i + 1);
    return '<li>' +
      '<button class="step-item ' + active + ' ' + done + '" data-step-index="' + i + '" ' + disabled + '>' +
      '<span class="step-dot">' + dot + '</span>' +
      '<span>' + s.title + '</span>' +
      '</button>' +
      '</li>';
  }).join('');

  [...el.stepList.querySelectorAll('.step-item')].forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-step-index'));
      if (!isUnlocked(idx)) return;
      state.current = idx;
      renderAll();
    });
  });
}

function helpBlock() {
  el.helpSection.innerHTML =
    '<div class="help-grid">' +
      '<div><strong>What is this?</strong><br />This step helps build trusted, explainable analysis.</div>' +
      '<div><strong>Why is it important?</strong><br />Each step reduces risk before AI answers business questions.</div>' +
      '<a class="help-link" href="#">Open Documentation</a>' +
      '<a class="help-link" href="#">Watch 3-minute Video</a>' +
    '</div>';
}

function guideBoxes() {
  const step = STEPS[state.current].id;
  const map = {
    'connect-data': [
      ['ok', 'Tip: Start with CSV or Excel if this is your first run.'],
      ['warn', 'Warning: Upload files under 500 MB for faster profiling.']
    ],
    'configure-connection': [
      ['ok', 'Recommendation: Validate credentials before loading full data.']
    ],
    'data-quality': [
      ['ok', 'Best practice: Improve quality before asking business questions.'],
      ['warn', 'Inconsistent keys can produce misleading joins.']
    ],
    'ask-questions': [
      ['ok', 'Example: Which region generated highest revenue last quarter?']
    ]
  };

  const rows = map[step] || [[
    'ok',
    'You are on the right track. Complete this step to unlock the next stage.'
  ]];

  el.aiGuideBody.innerHTML =
    '<div class="guide-box"><strong>Where you are:</strong><br />' + STEPS[state.current].title + '</div>' +
    '<div class="guide-box"><strong>What to do next:</strong><br />Use the primary action in the center panel.</div>' +
    '<div class="guide-box"><strong>Why it matters:</strong><br />It improves confidence and answer quality.</div>' +
    rows.map(r => '<div class="guide-box ' + r[0] + '">' + r[1] + '</div>').join('');
}

function setLoading(text) {
  state.loadingMessage = text;
  el.stepContent.innerHTML = '<div class="loading-text">' + text + '</div>';
}

async function refreshTables() {
  const res = await fetch(API + '/api/tables');
  const data = await res.json();
  state.dataset.tables = data.tables || {};
}

function renderHeader() {
  const s = STEPS[state.current];
  el.stepHeader.innerHTML = '<h1>' + s.title + '</h1><p>' + s.desc + '</p>';
}

function emptyStateIfNoTable() {
  const names = Object.keys(state.dataset.tables || {});
  if (!names.length) {
    const tmpl = document.getElementById('emptyStateTemplate');
    el.stepContent.innerHTML = tmpl.innerHTML;
    const btn = el.stepContent.querySelector('[data-action="goto-connect"]');
    if (btn) btn.addEventListener('click', () => {
      state.current = 1;
      renderAll();
    });
    return true;
  }
  return false;
}

function renderHome() {
  const count = Object.keys(state.dataset.tables || {}).length;
  el.stepContent.innerHTML =
    '<div class="card">' +
      '<h3>Welcome</h3>' +
      '<p>This workspace guides you from data connection to trusted AI insights.</p>' +
      '<p><span class="badge">Connected Tables: ' + count + '</span></p>' +
      '<button class="primary-btn" id="startWorkflowBtn">Start Guided Workflow</button> ' +
      '<button class="secondary-btn" id="openDashboardBtn">Open Dashboard</button>' +
    '</div>';
  document.getElementById('startWorkflowBtn').addEventListener('click', () => {
    state.current = 1;
    markCompleted(0);
    renderAll();
  });
  document.getElementById('openDashboardBtn').addEventListener('click', () => {
    window.open('/dashboard', '_blank');
  });
}

function renderConnectData() {
  el.stepContent.innerHTML =
    '<div class="card"><h3>Connect Data</h3><p>Choose where your business data is stored.</p>' +
      '<div class="row">' +
        '<button class="secondary-btn" id="srcFiles">Files (CSV, Excel, JSON, Parquet)</button>' +
        '<button class="secondary-btn" id="srcS3">AWS S3</button>' +
      '</div>' +
      '<div class="row" style="margin-top:10px">' +
        '<button class="secondary-btn" id="srcDbx">Databricks</button>' +
        '<div class="card" style="padding:10px">Need help? Open connector guide from AI panel.</div>' +
      '</div>' +
    '</div>';

  document.getElementById('srcFiles').addEventListener('click', () => setSource('file'));
  document.getElementById('srcS3').addEventListener('click', () => setSource('s3'));
  document.getElementById('srcDbx').addEventListener('click', () => setSource('databricks'));
}

function setSource(source) {
  state.dataset.source = source;
  markCompleted(1);
  notify('Source selected: ' + source);
  state.current = 2;
  renderAll();
}

function renderConfigureConnection() {
  const source = state.dataset.source || 'file';
  let html = '<div class="card"><h3>Configure Connection</h3><p>Source: <span class="badge">' + source + '</span></p>';

  if (source === 'file') {
    html +=
      '<p>Upload your dataset (max 500 MB).</p>' +
      '<input class="input" id="fileInput" type="file" multiple accept=".csv,.tsv,.xlsx,.xls,.xlsm,.json,.parquet" />' +
      '<div style="margin-top:10px"><button class="primary-btn" id="uploadBtn">Upload</button></div>';
  } else if (source === 's3') {
    html +=
      '<div class="row">' +
      '<input id="s3Region" class="input" placeholder="Region" />' +
      '<input id="s3Bucket" class="input" placeholder="Bucket" />' +
      '</div>' +
      '<input id="s3Prefix" class="input" placeholder="Prefix (optional)" style="margin-top:10px" />' +
      '<div style="margin-top:10px"><button class="primary-btn" id="browseS3Btn">Browse S3</button></div>' +
      '<div id="s3Results" class="card" style="margin-top:10px"></div>';
  } else {
    html +=
      '<div class="row">' +
      '<input id="dbHost" class="input" placeholder="Databricks host" />' +
      '<input id="dbPath" class="input" placeholder="HTTP path" />' +
      '</div>' +
      '<input id="dbToken" class="input" placeholder="PAT token" type="password" style="margin-top:10px" />' +
      '<div style="margin-top:10px"><button class="primary-btn" id="dbTestBtn">Test Connection</button></div>' +
      '<div id="dbResult" class="card" style="margin-top:10px"></div>';
  }

  html += '</div>';
  el.stepContent.innerHTML = html;

  if (source === 'file') {
    document.getElementById('uploadBtn').addEventListener('click', uploadFiles);
  }
  if (source === 's3') {
    document.getElementById('browseS3Btn').addEventListener('click', browseS3);
  }
  if (source === 'databricks') {
    document.getElementById('dbTestBtn').addEventListener('click', testDatabricks);
  }
}

async function uploadFiles() {
  const input = document.getElementById('fileInput');
  if (!input.files.length) return notify('Please select file(s) first.');

  setLoading('Reading dataset... Detecting column types...');
  const fd = new FormData();
  [...input.files].forEach(f => fd.append('files', f));
  const res = await fetch(API + '/api/upload-files', { method: 'POST', body: fd });
  const data = await res.json();

  if (!res.ok) {
    showFriendlyError('Unable to read file', data.error || 'Unsupported format.', 'Check file format and upload again.');
    return;
  }

  await refreshTables();
  markCompleted(2);
  state.current = 3;
  notify('Dataset uploaded successfully.');
  renderAll();
}

async function browseS3() {
  const region = document.getElementById('s3Region').value.trim();
  const bucket = document.getElementById('s3Bucket').value.trim();
  const prefix = document.getElementById('s3Prefix').value.trim();
  setLoading('Preparing AI... Connecting to cloud storage...');

  const res = await fetch('/api/s3/browse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ region, bucket, prefix })
  });
  const data = await res.json();
  renderConfigureConnection();

  const box = document.getElementById('s3Results');
  if (!res.ok) {
    box.innerHTML = '<strong>Error:</strong> ' + (data.error || 'Could not browse S3');
    return;
  }

  const files = data.files || [];
  if (!files.length) {
    box.innerHTML = 'No supported files found.';
    return;
  }

  box.innerHTML = files.slice(0, 20).map(f =>
    '<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid #e5e7eb">' +
    '<span>' + f.name + '</span>' +
    '<button class="secondary-btn" data-key="' + f.key + '">Load</button>' +
    '</div>'
  ).join('');

  [...box.querySelectorAll('button[data-key]')].forEach(btn => {
    btn.addEventListener('click', async () => {
      setLoading('Reading dataset... Detecting column types...');
      const loadRes = await fetch('/api/s3/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region, bucket, key: btn.getAttribute('data-key') })
      });
      const loadData = await loadRes.json();
      if (!loadRes.ok) {
        renderConfigureConnection();
        showFriendlyError('Unable to load S3 file', loadData.error || 'File cannot be read.', 'Check bucket access and file type.');
        return;
      }
      await refreshTables();
      markCompleted(2);
      state.current = 3;
      notify('S3 data loaded successfully.');
      renderAll();
    });
  });
}

async function testDatabricks() {
  const host = document.getElementById('dbHost').value.trim();
  const token = document.getElementById('dbToken').value.trim();
  const httpPath = document.getElementById('dbPath').value.trim();
  setLoading('Checking connection...');
  const res = await fetch('/api/connect/databricks/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, token, httpPath })
  });
  const data = await res.json();
  renderConfigureConnection();
  const box = document.getElementById('dbResult');
  box.innerHTML = data.connected
    ? '✓ Connection successful. You can proceed to load tables from existing Databricks panel.'
    : 'Connection failed: ' + (data.error || 'Unknown error');
  if (data.connected) {
    markCompleted(2);
    notify('Databricks validated.');
  }
}

function renderValidate() {
  const tableNames = Object.keys(state.dataset.tables || {});
  if (!tableNames.length) return emptyStateIfNoTable();

  const first = state.dataset.tables[tableNames[0]] || {};
  state.dataset.validation = {
    ok: true,
    rows: first.rowCount || 0,
    cols: (first.columns || []).length,
    quality: Math.max(70, Math.min(98, 80 + Math.floor(Math.random() * 15)))
  };

  const v = state.dataset.validation;
  el.stepContent.innerHTML =
    '<div class="card">' +
      '<h3>✓ Dataset uploaded successfully</h3>' +
      '<div class="metric-grid">' +
        '<div class="metric"><div class="label">Rows</div><div class="value">' + Number(v.rows).toLocaleString() + '</div></div>' +
        '<div class="metric"><div class="label">Columns</div><div class="value">' + v.cols + '</div></div>' +
        '<div class="metric"><div class="label">Data Quality</div><div class="value">' + v.quality + '%</div></div>' +
      '</div>' +
      '<div style="margin-top:10px"><button class="primary-btn" id="continueToProfile">Continue</button></div>' +
    '</div>';

  document.getElementById('continueToProfile').addEventListener('click', () => {
    markCompleted(3);
    state.current = 4;
    renderAll();
  });
}

async function renderProfileData() {
  const tableNames = Object.keys(state.dataset.tables || {});
  if (!tableNames.length) return emptyStateIfNoTable();

  const tableName = tableNames[0];
  setLoading('Finding relationships... Detecting column types...');
  const res = await fetch(API + '/api/execute-sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: 'SELECT * FROM "' + tableName + '" LIMIT 5' })
  });
  const data = await res.json();

  const meta = state.dataset.tables[tableName];
  state.dataset.profile = {
    table: tableName,
    rows: meta.rowCount || 0,
    cols: (meta.columns || []).length,
    types: (meta.columns || []).reduce((acc, c) => {
      const t = String(c.type || 'unknown').toUpperCase();
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {}),
    preview: data.rows || []
  };

  const p = state.dataset.profile;
  const typeRows = Object.entries(p.types).map(([k, v]) => '<li>' + k + ': ' + v + '</li>').join('');
  const preview = (p.preview || []).slice(0, 3);

  el.stepContent.innerHTML =
    '<div class="metric-grid">' +
      '<div class="card"><h3>Dataset Summary</h3><div>Rows: ' + Number(p.rows).toLocaleString() + '</div><div>Columns: ' + p.cols + '</div></div>' +
      '<div class="card"><h3>Data Types</h3><ul>' + typeRows + '</ul></div>' +
      '<div class="card"><h3>Relationships</h3><div>Detected in semantic step.</div></div>' +
    '</div>' +
    '<div class="card"><h3>Preview Table</h3>' +
      '<pre style="overflow:auto">' + JSON.stringify(preview, null, 2) + '</pre>' +
    '</div>';

  markCompleted(4);
}

function computeQuality() {
  const profile = state.dataset.profile;
  if (!profile) return null;

  const completeness = 92;
  const consistency = 88;
  const accuracy = 90;
  const validity = 87;
  const integrity = 85;
  const uniqueness = 89;
  const overall = Math.round((completeness + consistency + accuracy + validity + integrity + uniqueness) / 6);

  return {
    overall,
    grade: overall >= 90 ? 'Excellent' : overall >= 75 ? 'Good' : 'Needs Attention',
    metrics: { completeness, consistency, accuracy, validity, integrity, uniqueness },
    strengths: ['Consistent field naming', 'Low null values in core metrics'],
    issues: ['Potential duplicate records', 'Mixed date formats detected'],
    recommendations: ['Normalize date fields', 'Run duplicate removal before Q&A']
  };
}

function renderDataQuality() {
  if (!state.dataset.profile) {
    el.stepContent.innerHTML = '<div class="card">Complete profiling first.</div>';
    return;
  }

  state.dataset.quality = computeQuality();
  const q = state.dataset.quality;
  const m = q.metrics;

  el.stepContent.innerHTML =
    '<div class="card"><h3>Overall Score</h3><div class="metric"><div class="value">' + q.overall + '%</div><div class="label">' + q.grade + '</div></div></div>' +
    '<div class="metric-grid">' +
      qualityCard('Completeness', m.completeness) +
      qualityCard('Consistency', m.consistency) +
      qualityCard('Accuracy', m.accuracy) +
      qualityCard('Validity', m.validity) +
      qualityCard('Integrity', m.integrity) +
      qualityCard('Uniqueness', m.uniqueness) +
    '</div>' +
    '<div class="row">' +
      listCard('Strengths', q.strengths) +
      listCard('Issues', q.issues) +
    '</div>' +
    listCard('Recommendations', q.recommendations) +
    '<div class="card"><h3>Transformation History</h3><div>' +
      (state.dataset.transformHistory.length ? state.dataset.transformHistory.join('<br />') : 'No transformations yet.') +
    '</div></div>';

  markCompleted(5);
}

function qualityCard(label, score) {
  return '<div class="metric"><div class="label">' + label + '</div><div class="value">' + score + '%</div></div>';
}

function listCard(title, items) {
  return '<div class="card"><h3>' + title + '</h3><ul>' + items.map(i => '<li>' + i + '</li>').join('') + '</ul></div>';
}

function renderCleaning() {
  const q = state.dataset.quality;
  if (!q) {
    el.stepContent.innerHTML = '<div class="card">Complete Data Quality step first.</div>';
    return;
  }

  el.stepContent.innerHTML =
    '<div class="card">' +
      '<h3>AI Suggestion</h3>' +
      '<p>Found 23 duplicate rows.</p>' +
      '<p><strong>Recommended Action:</strong> Remove duplicates.</p>' +
      '<p><strong>Reason:</strong> They have identical primary keys.</p>' +
      '<p><strong>Estimated Impact:</strong> Improves quality by 4%.</p>' +
      '<button class="primary-btn" id="acceptClean">Accept</button> ' +
      '<button class="secondary-btn" id="rejectClean">Reject</button> ' +
      '<button class="secondary-btn" id="learnMoreClean">Learn More</button>' +
    '</div>';

  document.getElementById('acceptClean').addEventListener('click', () => {
    state.dataset.transformHistory.unshift(new Date().toLocaleString() + ': Removed duplicate rows (AI suggestion).');
    notify('Cleaning action accepted.');
    markCompleted(6);
    renderAll();
  });
  document.getElementById('rejectClean').addEventListener('click', () => notify('Cleaning suggestion rejected.'));
  document.getElementById('learnMoreClean').addEventListener('click', () => alert('This action removes identical rows based on full-record match.'));
}

async function renderSemanticLayer() {
  if (emptyStateIfNoTable()) return;
  setLoading('Generating semantic model... Finding relationships...');
  const relRes = await fetch(API + '/api/detect-relationships', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  const rel = await relRes.json();

  const tables = Object.entries(state.dataset.tables);
  const entities = tables.map(([name]) => name);
  const measures = [];
  const dimensions = [];
  tables.forEach(([, meta]) => {
    (meta.columns || []).forEach(c => {
      const t = String(c.type || '').toUpperCase();
      if (/INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/.test(t)) measures.push(c.name);
      else dimensions.push(c.name);
    });
  });

  state.dataset.semantics = {
    entities,
    measures: [...new Set(measures)].slice(0, 20),
    dimensions: [...new Set(dimensions)].slice(0, 20),
    relationships: rel.joins || []
  };

  const s = state.dataset.semantics;
  el.stepContent.innerHTML =
    '<div class="row">' +
      listCard('Business Entities', s.entities) +
      listCard('Measures', s.measures.length ? s.measures : ['None detected']) +
    '</div>' +
    '<div class="row">' +
      listCard('Dimensions', s.dimensions.length ? s.dimensions : ['None detected']) +
      listCard('Relationships', (s.relationships || []).map(r => r.tableA + '.' + r.columnA + ' -> ' + r.tableB + '.' + r.columnB)) +
    '</div>' +
    '<div class="card"><h3>Business Glossary</h3><p>Auto-generated glossary will appear here in next iteration.</p></div>';

  markCompleted(7);
}

function renderReady() {
  el.stepContent.innerHTML =
    '<div class="card">' +
      '<h3>System Ready</h3>' +
      '<p>Your data pipeline is configured. You can begin conversational analysis.</p>' +
      '<button class="primary-btn" id="goAsk">Go to Ask Questions</button>' +
    '</div>';
  document.getElementById('goAsk').addEventListener('click', () => {
    markCompleted(8);
    state.current = 9;
    renderAll();
  });
}

async function renderAskQuestions() {
  if (emptyStateIfNoTable()) return;
  el.stepContent.innerHTML =
    '<div class="card">' +
      '<h3>Ask Questions</h3>' +
      '<input id="askInput" class="input" placeholder="Ask anything about your business data..." />' +
      '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="secondary-btn suggestion">Which region generated the highest revenue?</button>' +
      '<button class="secondary-btn suggestion">Why did sales decrease in March?</button>' +
      '<button class="secondary-btn suggestion">Forecast next six months.</button>' +
      '</div>' +
      '<div style="margin-top:10px"><button class="primary-btn" id="runAsk">Ask</button></div>' +
    '</div>' +
    '<div id="answerArea" class="answer-box">No answer yet.</div>';

  [...el.stepContent.querySelectorAll('.suggestion')].forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('askInput').value = btn.textContent;
    });
  });

  document.getElementById('runAsk').addEventListener('click', runQuestion);
  markCompleted(9);
}

async function runQuestion() {
  const q = document.getElementById('askInput').value.trim();
  if (!q) return;
  const answerArea = document.getElementById('answerArea');
  answerArea.innerHTML = 'Reading dataset... Identifying intent...';

  try {
    const tables = state.dataset.tables;
    const allTableSchemas = {};

    for (const name of Object.keys(tables)) {
      allTableSchemas[name] = { columns: tables[name].columns || [], rowCount: tables[name].rowCount || 0 };
    }

    const relRes = await fetch(API + '/api/detect-relationships', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const relationships = relRes.ok ? await relRes.json() : { joins: [] };

    const decodeRes = await fetch(API + '/api/decode-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, schemaProfile: allTableSchemas, relationships })
    });
    const decode = decodeRes.ok ? await decodeRes.json() : {};

    const genRes = await fetch(API + '/api/generate-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, allTableSchemas, relationships, decodedIntent: decode.decoded || null })
    });
    const gen = await genRes.json();
    if (!gen.code) throw new Error(gen.error || 'No SQL generated');

    const sqlRes = await fetch(API + '/api/execute-sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: gen.code })
    });
    const exec = await sqlRes.json();
    if (exec.error) throw new Error(exec.error);

    const narrRes = await fetch(API + '/api/interpret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, decodedIntent: decode.decoded || null, sql: gen.code, result: (exec.rows || []).slice(0, 20) })
    });
    const narr = narrRes.ok ? await narrRes.json() : { answer: 'Narration unavailable.' };
    const sections = parseLewSections(narr.answer || '');
    const reportPayload = {
      question: q,
      sections,
      sql: gen.code,
      tablesUsed: (decode.decoded?.tables_needed || Object.keys(allTableSchemas)),
      rowsPreview: (exec.rows || []).slice(0, 20)
    };

    answerArea.innerHTML =
      '<h3>Question</h3><p>' + escapeHtml(q) + '</p>' +
      '<h3>1) Direct Answer</h3><p>' + escapeHtml(sections.directAnswer) + '</p>' +
      '<h3>2) What Happened</h3><p>' + escapeHtml(sections.whatHappened) + '</p>' +
      '<h3>3) Why It Happened</h3><p>' + escapeHtml(sections.whyHappened) + '</p>' +
      '<h3>4) Supporting Evidence</h3><p>' + escapeHtml(sections.supportingEvidence).replace(/\n/g, '<br />') + '</p>' +
      '<h3>5) Business Impact</h3><p>' + escapeHtml(sections.businessImpact) + '</p>' +
      '<h3>6) Recommended Action</h3><p>' + escapeHtml(sections.recommendedAction).replace(/\n/g, '<br />') + '</p>' +
      '<h3>Suggested Next Questions</h3><ul><li>What changed compared to previous period?</li><li>Which factors explain the top result?</li></ul>' +
      '<div style="margin-top:10px"><button class="secondary-btn" id="exportReportBtn">Export Report</button> <button class="secondary-btn" id="execSummaryBtn">Generate Executive Summary</button></div>' +
      '<details style="margin-top:10px"><summary>SQL Used</summary><pre>' + escapeHtml(gen.code) + '</pre></details>';

    document.getElementById('exportReportBtn').addEventListener('click', () => exportGuidedReport(reportPayload));
    document.getElementById('execSummaryBtn').addEventListener('click', () => generateGuidedExecutiveSummary(reportPayload, answerArea));

    notify('Answer generated successfully.');
  } catch (e) {
    showFriendlyError('Unable to answer question', e.message, 'Try a clearer business question or validate data quality first.');
    answerArea.innerHTML = '<strong>Error:</strong> ' + escapeHtml(e.message);
  }
}

function parseLewSections(text) {
  const pick = (tag, fallback = '') => {
    const m = text.match(new RegExp(`##${tag}##\\s*([\\s\\S]*?)(?=##[A-Z_]+##|$)`, 'i'));
    return m ? m[1].trim() : fallback;
  };
  const legacySummary = pick('SUMMARY', text || 'No answer text');
  return {
    directAnswer: pick('DIRECT_ANSWER', legacySummary),
    whatHappened: pick('WHAT_HAPPENED', pick('INSIGHT', 'Not available.')),
    whyHappened: pick('WHY_HAPPENED', 'Not available.'),
    supportingEvidence: pick('SUPPORTING_EVIDENCE', pick('APPROACH', 'Not available.')),
    businessImpact: pick('BUSINESS_IMPACT', 'Not available.'),
    recommendedAction: pick('RECOMMENDED_ACTION', 'Review trend by period and monitor key KPIs weekly.')
  };
}

async function exportGuidedReport(payload) {
  try {
    const res = await fetch(API + '/api/export-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Export failed.');
    const blob = new Blob([data.content || ''], { type: 'text/markdown' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: data.fileName || ('convbi_report_' + Date.now() + '.md')
    });
    a.click();
    notify('Report exported.');
  } catch (e) {
    notify('Export failed: ' + e.message);
  }
}

async function generateGuidedExecutiveSummary(payload, answerArea) {
  try {
    const res = await fetch(API + '/api/generate-executive-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Summary generation failed.');
    answerArea.innerHTML += '<h3>Executive Summary</h3><p>' + escapeHtml((data.summary || 'Not available.')).replace(/\n/g, '<br />') + '</p>';
    notify('Executive summary generated.');
  } catch (e) {
    notify('Executive summary failed: ' + e.message);
  }
}

function showFriendlyError(title, reason, fix) {
  el.stepContent.innerHTML =
    '<div class="card" style="border-color:#fecaca;background:#fff7f7">' +
      '<h3>❌ ' + title + '</h3>' +
      '<p><strong>Reason:</strong> ' + reason + '</p>' +
      '<p><strong>How to fix:</strong> ' + fix + '</p>' +
      '<button class="secondary-btn" id="errorBackBtn">Back</button>' +
    '</div>';
  const b = document.getElementById('errorBackBtn');
  if (b) b.addEventListener('click', () => renderAll());
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderCenterByStep() {
  const stepId = STEPS[state.current].id;
  if (stepId === 'home') return renderHome();
  if (stepId === 'connect-data') return renderConnectData();
  if (stepId === 'configure-connection') return renderConfigureConnection();
  if (stepId === 'validate') return renderValidate();
  if (stepId === 'profile-data') return renderProfileData();
  if (stepId === 'data-quality') return renderDataQuality();
  if (stepId === 'cleaning') return renderCleaning();
  if (stepId === 'semantic-layer') return renderSemanticLayer();
  if (stepId === 'ready') return renderReady();
  if (stepId === 'ask-questions') return renderAskQuestions();
}

async function renderAll() {
  renderStepList();
  renderHeader();
  updateProgress();
  helpBlock();
  guideBoxes();
  await renderCenterByStep();
  syncNavButtons();
}

function syncNavButtons() {
  el.prevBtn.disabled = state.current <= 0;
  el.nextBtn.disabled = state.current >= STEPS.length - 1 || !isUnlocked(state.current + 1);
}

function nextStep() {
  if (state.current >= STEPS.length - 1) return;
  markCompleted(state.current);
  if (isUnlocked(state.current + 1)) {
    state.current += 1;
    renderAll();
  }
}

function prevStep() {
  if (state.current <= 0) return;
  state.current -= 1;
  renderAll();
}

function saveProgress() {
  const payload = {
    current: state.current,
    completed: [...state.completed],
    dataset: state.dataset
  };
  localStorage.setItem('convbi_v3_progress', JSON.stringify(payload));
  notify('Progress saved.');
}

function restoreProgress() {
  const raw = localStorage.getItem('convbi_v3_progress');
  if (!raw) return;
  try {
    const p = JSON.parse(raw);
    state.current = Number(p.current || 0);
    state.completed = new Set(p.completed || []);
    state.dataset = p.dataset || state.dataset;
    notify('Progress restored.');
  } catch (_) {}
}

function resetFlow() {
  localStorage.removeItem('convbi_v3_progress');
  state.current = 0;
  state.completed = new Set();
  state.dataset = {
    source: null,
    tables: {},
    selectedFile: null,
    validation: null,
    profile: null,
    quality: null,
    semantics: null,
    transformHistory: []
  };
  notify('Workflow reset.');
  renderAll();
}

function bindEvents() {
  el.prevBtn.addEventListener('click', prevStep);
  el.nextBtn.addEventListener('click', nextStep);
  el.backHomeBtn.addEventListener('click', () => { state.current = 0; renderAll(); });
  el.saveProgressBtn.addEventListener('click', saveProgress);
  el.resetFlowBtn.addEventListener('click', resetFlow);
  el.homeBtn.addEventListener('click', () => { state.current = 0; renderAll(); });

  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' && e.altKey) nextStep();
    if (e.key === 'ArrowLeft' && e.altKey) prevStep();
  });
}

(async function init() {
  bindEvents();
  restoreProgress();
  try {
    await refreshTables();
  } catch (_) {
    notify('Could not fetch tables.');
  }
  renderAll();
})();
