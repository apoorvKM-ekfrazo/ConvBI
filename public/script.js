'use strict';

// ── Global state ─────────────────────────────────────────────────────────────
const API = '';           // same origin
let loadedTables   = {}; // tableName → { rowCount, columns, source, ... }
let activeTableSet = new Set(); // tables in scope for current question
let pendingFiles   = []; // staged File objects before upload
let excelImportMode = 'workbook';
let excelSheetCatalog = {}; // fileKey -> sheet names discovered from backend
let excelSelectedSheets = {}; // fileKey -> selected sheet names
let selectedUploadType = '';
let voiceMgr       = null; // set by voice-manager.js
let savedInsights  = JSON.parse(localStorage.getItem('convbi_insights') || '[]');
let conversationTurns = []; // recent Q/A context for intent decoding
const answerPayloadStore = {}; // cardId -> payload for exports
let isLoadingDynamicChips = false;
let currentFollowupPrompts = [];
const askedFollowupPromptSet = new Set();
let tableLibraryView = localStorage.getItem('convbi_table_library_view') || 'grid';
let analyticsFlowStep = 1;
let selectedAnalyticsTables = new Set();
let glossaryMap = {};
const SIDEBAR_PIN_KEY = 'convbi_sidebar_pinned';
const DENSITY_MODE_KEY = 'convbi_density_mode';
const QA_DETAILS_KEY = 'convbi_qa_show_details';

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

const UPLOAD_TYPE_CONFIG = {
  csv: { label: 'CSV', accept: '.csv', pattern: /\.csv$/i },
  excel: { label: 'Excel', accept: '.xlsx,.xls,.xlsm', pattern: /\.(xlsx|xls|xlsm)$/i },
  json: { label: 'JSON', accept: '.json', pattern: /\.json$/i },
  parquet: { label: 'Parquet', accept: '.parquet', pattern: /\.parquet$/i }
};

const DI_STEPS = [
  { id: 1, title: 'Data Source', what: 'Select where your business data lives.', why: 'Source context determines the safest import path and validation checks.', help: 'Pick one source card and continue.' },
  { id: 2, title: 'File Selection', what: 'Choose data type or connect cloud source.', why: 'Correct source/type avoids parsing and schema errors.', help: 'For files, choose one type. For cloud, connect and load a table.' },
  { id: 3, title: 'Import Mode', what: 'Select workbook mode or sheet mode for Excel.', why: 'Mode controls whether every sheet or only selected sheets are imported.', help: 'Use sheet mode for targeted imports.' },
  { id: 4, title: 'Files', what: 'Add one or more files for import.', why: 'Batch import reduces repetitive setup.', help: 'Drag and drop works for the selected file type only.' },
  { id: 5, title: 'Sheet Selection', what: 'Pick sheets from workbooks when in Sheet Mode.', why: 'Sheet-level control reduces noise in analytics.', help: 'Use search, Select All, and Clear All to work faster.' },
  { id: 6, title: 'Import Summary', what: 'Review source, files, and mode before import.', why: 'A quick review prevents costly import mistakes.', help: 'Use Back if anything looks incorrect.' },
  { id: 7, title: 'Import Progress', what: 'Track exactly what the system is doing.', why: 'Transparent progress improves trust and troubleshooting.', help: 'Wait until import finishes and result is shown.' },
  { id: 8, title: 'Import Result', what: 'Review imported tables and any skipped items.', why: 'This is your decision point between Quick Start and Advanced setup.', help: 'Use Quick Start for faster onboarding or Advanced Setup for deeper review.' },
  { id: 9, title: 'Table Selection', what: 'Choose tables for analytics scope.', why: 'Scope control improves answer relevance and speed in larger datasets.', help: 'This step is skipped automatically for single-table imports.' },
  { id: 10, title: 'Table Structure', what: 'Validate schema and sample values.', why: 'Early structure checks prevent downstream query confusion.', help: 'Review key columns and detected types before continuing.' },
  { id: 11, title: 'Relationships & Glossary', what: 'Review relationships and complete glossary instructions.', why: 'Glossary setup is required for both single and multiple table imports.', help: 'Define business meanings clearly, then continue to Ready.' },
  { id: 12, title: 'Complete', what: 'Finalize and move to analytics.', why: 'Completing setup ensures reliable dashboard and Q&A flow.', help: 'Proceed to dashboard when ready.' }
];

let wizardStep = 1;
let wizardCompletedStep = 0;
let selectedDataSource = '';
let lastImportResult = null;
let quickStartUsed = false;

function maxAllowedWizardStep() {
  return Math.max(1, wizardCompletedStep + 1);
}

function updateWizardGuidance(stepId) {
  const def = DI_STEPS.find(s => s.id === stepId) || DI_STEPS[0];
  const stepHint = document.getElementById('diStepHint');
  if (stepHint) {
    stepHint.textContent = `${def.what} ${def.help}`;
    return;
  }
  const w = document.getElementById('diWhatText');
  const y = document.getElementById('diWhyText');
  const h = document.getElementById('diHelpText');
  if (w) w.textContent = def.what;
  if (y) y.textContent = def.why;
  if (h) h.textContent = def.help;
}

function renderWizardStepper() {
  const stepper = document.getElementById('diStepper');
  if (!stepper) return;
  const loadedNames = Object.keys(loadedTables || {});
  const hiddenSteps = new Set();
  if (selectedUploadType && selectedUploadType !== 'excel') {
    hiddenSteps.add(3);
    hiddenSteps.add(5);
  }
  if (selectedUploadType === 'excel' && excelImportMode !== 'selected') {
    hiddenSteps.add(5);
  }
  if (loadedNames.length === 1) {
    hiddenSteps.add(9);
  }
  if (quickStartUsed) {
    hiddenSteps.add(9);
    hiddenSteps.add(10);
  }

  const visibleSteps = DI_STEPS.filter(step => !hiddenSteps.has(step.id));
  stepper.innerHTML = visibleSteps.map((step, idx) => {
    const state = step.id < wizardStep ? 'done' : (step.id === wizardStep ? 'current' : 'disabled');
    const marker = step.id <= wizardCompletedStep ? '✓' : String(idx + 1);
    return `<div class="di-step-item ${state}" aria-current="${step.id === wizardStep ? 'step' : 'false'}"><div class="n">${marker}</div><div class="t">${escapeHtml(step.title)}</div></div>`;
  }).join('');
}

function showWizardStage(step) {
  for (let i = 1; i <= 12; i++) {
    const panel = document.getElementById(`diStage${i}`);
    if (panel) {
      panel.style.display = i === step ? '' : 'none';
      panel.classList.toggle('is-active', i === step);
    }
  }
}

function goToWizardStep(step, opts = {}) {
  const requested = Math.max(1, Math.min(12, Number(step) || 1));
  const force = !!opts.force;
  if (!force && requested > maxAllowedWizardStep()) {
    showError('Complete the current step before moving ahead.');
    return;
  }
  wizardStep = requested;
  showWizardStage(wizardStep);
  updateWizardGuidance(wizardStep);
  renderWizardStepper();

  if (wizardStep === 5) renderExcelImportSection();
  if (wizardStep === 6) renderImportSummary();
  if (wizardStep === 9) goToAnalyticsFlowStep(1);
  if (wizardStep === 10) goToAnalyticsFlowStep(2);
  if (wizardStep === 11) goToAnalyticsFlowStep(3);
}

function markWizardStepDone(step) {
  wizardCompletedStep = Math.max(wizardCompletedStep, step);
  renderWizardStepper();
}

function selectDataSource(source) {
  selectedDataSource = source;
  document.querySelectorAll('[data-source-card]').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-source-card') === source);
  });
  const btn = document.getElementById('diContinueSourceBtn');
  if (btn) btn.disabled = !selectedDataSource;
}

function continueFromSource() {
  if (!selectedDataSource) {
    showError('Select a data source to continue.');
    return;
  }
  markWizardStepDone(1);
  switchSourceTab(selectedDataSource);
  goToWizardStep(2, { force: true });
}

function continueFromType() {
  if (selectedDataSource === 'databricks' || selectedDataSource === 's3') {
    showSuccess('Connect and load data from this source to continue.');
    return;
  }
  if (!selectedUploadType) {
    showError('Choose a file type to continue.');
    return;
  }
  markWizardStepDone(2);
  if (selectedUploadType === 'excel') {
    goToWizardStep(3, { force: true });
    return;
  }
  goToWizardStep(4, { force: true });
  openFilePicker();
}

function continueFromExcelMode() {
  markWizardStepDone(3);
  goToWizardStep(4, { force: true });
  openFilePicker();
}

function continueFromFileSelection() {
  if (!pendingFiles.length) {
    showError('Select at least one file to continue.');
    return;
  }
  markWizardStepDone(4);
  if (selectedUploadType === 'excel' && excelImportMode === 'selected') {
    goToWizardStep(5, { force: true });
    renderExcelImportSection();
    return;
  }
  goToWizardStep(6, { force: true });
}

function continueFromExcelSheets() {
  const excelFiles = getPendingExcelFiles();
  for (const file of excelFiles) {
    const key = getFileKey(file);
    if (!(excelSelectedSheets[key] || []).length) {
      showError(`Select at least one sheet for ${file.name}.`);
      return;
    }
  }
  markWizardStepDone(5);
  goToWizardStep(6, { force: true });
}

function goBackFromFileSelection() {
  if (selectedUploadType === 'excel') goToWizardStep(3, { force: true });
  else goToWizardStep(2, { force: true });
}

function goBackFromSummary() {
  if (selectedUploadType === 'excel' && excelImportMode === 'selected') goToWizardStep(5, { force: true });
  else goToWizardStep(4, { force: true });
}

function continueFromImportResult() {
  quickStartUsed = false;
  markWizardStepDone(8);
  const names = Object.keys(loadedTables || {});
  if (!names.length) {
    showError('No imported tables found. Please import at least one table.');
    return;
  }

  if (names.length === 1) {
    selectedAnalyticsTables = new Set([names[0]]);
    activeTableSet = new Set(selectedAnalyticsTables);
    persistAnalyticsPreferences();
    syncQAAvailability();
    refreshTableContextBar();
    showSuccess('Single table detected. Table selection skipped. Review structure, then continue to glossary.');
    goToWizardStep(10, { force: true });
    return;
  }

  goToWizardStep(9, { force: true });
}

function quickStartAfterImport() {
  quickStartUsed = true;
  const names = Object.keys(loadedTables || {});
  if (!names.length) {
    showError('No imported tables found. Please import at least one table.');
    return;
  }

  selectedAnalyticsTables = new Set(names);
  activeTableSet = new Set(selectedAnalyticsTables);
  persistAnalyticsPreferences();
  syncQAAvailability();
  refreshTableContextBar();

  markWizardStepDone(8);
  markWizardStepDone(9);
  markWizardStepDone(10);

  if (names.length === 1) {
    showSuccess('Quick Start applied. Relationships skipped for single-table mode. Complete glossary to finish setup.');
  } else {
    showSuccess('Quick Start applied. Review relationships and complete glossary to finish setup.');
  }

  goToWizardStep(11, { force: true });
}

function filterExcelSheets() {
  const q = (document.getElementById('excelSheetSearch')?.value || '').trim().toLowerCase();
  document.querySelectorAll('[data-sheet-name]').forEach(el => {
    const wrap = el.closest('label');
    if (!wrap) return;
    const name = (el.getAttribute('data-sheet-name') || '').toLowerCase();
    wrap.style.display = !q || name.includes(q) ? '' : 'none';
  });
}

function selectAllExcelSheets(checked) {
  const value = !!checked;
  document.querySelectorAll('input[type="checkbox"][data-file-key][data-sheet-name]').forEach(input => {
    input.checked = value;
    const fileKey = input.getAttribute('data-file-key') || '';
    const sheetName = input.getAttribute('data-sheet-name') || '';
    toggleExcelSheetSelection(fileKey, sheetName, value);
  });
}

function renderImportSummary() {
  const host = document.getElementById('diImportSummary');
  if (!host) return;
  const cards = [
    { k: 'Source', v: selectedDataSource || 'Files' },
    { k: 'File Type', v: (UPLOAD_TYPE_CONFIG[selectedUploadType]?.label || selectedUploadType || 'Not selected').replace(' / TSV', '') },
    { k: 'Selected Files', v: String(pendingFiles.length) },
    { k: 'Import Mode', v: selectedUploadType === 'excel' ? (excelImportMode === 'selected' ? 'Sheet' : 'Workbook') : 'Standard' }
  ];
  host.innerHTML = cards.map(c => `<div class="di-summary-card"><div class="di-summary-k">${escapeHtml(c.k)}</div><div class="di-summary-v">${escapeHtml(c.v)}</div></div>`).join('');
}

function setImportProgress(pct, statusText, activeIndex = 0) {
  const bar = document.getElementById('diProgressBar');
  const pctEl = document.getElementById('diProgressPct');
  const st = document.getElementById('diProgressStatus');
  const list = document.getElementById('diProgressStages');
  const stages = ['Reading file', 'Validating schema', 'Detecting encoding', 'Creating tables', 'Importing records', 'Finalizing import'];
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (pctEl) pctEl.textContent = `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
  if (st) st.textContent = statusText || 'Processing...';
  if (list) {
    list.innerHTML = stages.map((s, idx) => `<div class="di-stage-chip ${idx <= activeIndex ? 'on' : ''}">${escapeHtml(s)}</div>`).join('');
  }
}

function renderImportResult(data = {}) {
  const host = document.getElementById('diImportResult');
  if (!host) return;
  const tables = Array.isArray(data.tables) ? data.tables : [];
  const errors = Array.isArray(data.errors) ? data.errors : [];
  const totalRows = tables.reduce((sum, t) => sum + Number(t.rowCount || 0), 0);
  const hasSuccess = tables.length > 0;
  const successCard = hasSuccess ? `
    <div class="di-result-good">
      <div style="font-size:16px;font-weight:700;margin-bottom:6px">✓ Import Completed Successfully</div>
      <div style="font-size:13px;color:var(--text-secondary)">Imported ${tables.length} table${tables.length !== 1 ? 's' : ''} with ${totalRows.toLocaleString()} rows.</div>
    </div>` : '';
  const imported = hasSuccess
    ? `<div class="di-summary-card" style="margin-bottom:10px"><div class="di-summary-k">Imported Tables</div><div class="di-summary-v" style="font-size:13px;font-weight:500">${tables.map(t => escapeHtml(t.tableName || t.name || '')).join(', ')}</div></div>`
    : '';
  const correctionHints = `
    <div style="margin-top:8px;font-size:12px;color:var(--text-secondary)">
      <div style="font-weight:600;margin-bottom:4px">Suggested correction</div>
      <div>Check file type, delimiter/encoding, and column headers. Then retry import.</div>
    </div>`;
  const skipped = errors.length
    ? `<div class="di-result-bad"><div style="font-size:13px;font-weight:700;margin-bottom:6px">Import Issues</div>${errors.map(e => `<div style="font-size:12px;margin-bottom:4px">${escapeHtml(e.file || e.tableId || 'Unknown')} — ${escapeHtml(e.error || 'Unknown reason')}</div>`).join('')}${correctionHints}</div>`
    : '';
  if (!hasSuccess && !errors.length) {
    host.innerHTML = '<div class="di-result-bad">No tables were imported. Please review input files and try again.</div>';
    return;
  }
  host.innerHTML = `${successCard}${imported}${skipped}`;
}

function goToDashboardOverview() {
  window.location.href = '/dashboard#overview';
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(name) {
  const hasData = Object.keys(loadedTables || {}).length > 0;
  const hasScope = selectedAnalyticsTables.size > 0;
  if ((name === 'qa' || name === 'dashboard') && !hasData) {
    showError('Load a table to begin.');
    return;
  }
  if ((name === 'qa' || name === 'dashboard') && hasData && !hasScope) {
    showError('Select at least one table in the Data Input wizard before analytics.');
    return;
  }

  document.querySelectorAll('[data-nav-tab]').forEach(t => {
    t.classList.toggle('active', t.getAttribute('data-nav-tab') === name);
  });
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(name)?.classList.add('active');
  if (name === 'qa') {
    refreshTableContextBar();
    loadDynamicQuestionChips();
  }
}

function handleLockedNav(event, el) {
  const hasData = Object.keys(loadedTables || {}).length > 0;
  const hasScope = selectedAnalyticsTables.size > 0;
  if (hasData && hasScope) return true;
  if (event) event.preventDefault();
  const reason = !hasData
    ? (el?.getAttribute('data-locked-title') || 'Load a table to begin.')
    : 'Select at least one table in the Data Input wizard before analytics.';
  showError(reason);
  return false;
}

function syncAppNavigationState() {
  const hasData = Object.keys(loadedTables || {}).length > 0;
  const hasScope = selectedAnalyticsTables.size > 0;
  const askNav = document.getElementById('askNav');
  const dashNav = document.getElementById('dashboardNav');
  [askNav, dashNav].forEach(el => {
    if (!el) return;
    el.classList.toggle('nav-lock', !(hasData && hasScope));
    if (!(hasData && hasScope)) {
      el.setAttribute('aria-disabled', 'true');
      el.setAttribute('title', !hasData ? 'Load a table to begin' : 'Select at least one table before analytics');
    } else {
      el.removeAttribute('aria-disabled');
      el.removeAttribute('title');
    }
  });
}

function updateLoadedTablesBadge() {
  const names = Object.keys(loadedTables || {});
  const badge = document.getElementById('tablesLoadedBadge');
  const ctx = document.getElementById('activeTablesContext');
  if (badge) badge.textContent = `Tables loaded: ${names.length}`;
  if (ctx) {
    ctx.textContent = names.length ? `Active tables: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}` : 'Active tables: none';
  }
}

function applyDensityMode(mode, persist = true) {
  const next = mode === 'comfortable' ? 'comfortable' : 'compact';
  document.body.classList.toggle('density-compact', next === 'compact');
  const btn = document.getElementById('densityToggleBtn');
  if (btn) btn.textContent = next === 'compact' ? 'Comfortable' : 'Compact';
  if (persist) localStorage.setItem(DENSITY_MODE_KEY, next);
}

function toggleDensityMode() {
  const isCompact = document.body.classList.contains('density-compact');
  applyDensityMode(isCompact ? 'comfortable' : 'compact');
}

function toggleQADetails(forceState) {
  const next = typeof forceState === 'boolean'
    ? forceState
    : !document.body.classList.contains('show-qa-advanced');
  document.body.classList.toggle('show-qa-advanced', next);
  const btn = document.getElementById('qaDetailsToggleBtn');
  if (btn) btn.textContent = next ? 'Hide analysis details' : 'Show analysis details';
  localStorage.setItem(QA_DETAILS_KEY, next ? 'true' : 'false');
}

function setTableLibraryView(mode) {
  tableLibraryView = mode === 'list' ? 'list' : 'grid';
  localStorage.setItem('convbi_table_library_view', tableLibraryView);
  const list = document.getElementById('tableLibraryList');
  const gridBtn = document.getElementById('tableViewGridBtn');
  const listBtn = document.getElementById('tableViewListBtn');
  if (list) {
    list.classList.toggle('table-library-grid', tableLibraryView === 'grid');
    list.classList.toggle('table-library-list', tableLibraryView === 'list');
  }
  if (gridBtn) gridBtn.classList.toggle('active', tableLibraryView === 'grid');
  if (listBtn) listBtn.classList.toggle('active', tableLibraryView === 'list');
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
  selectedDataSource = name;
  const filesPanel = document.getElementById('filesPanel');
  const dbPanel = document.getElementById('databricksPanel');
  const s3Panel = document.getElementById('s3Panel');
  if (filesPanel) filesPanel.style.display = name === 'files' ? '' : 'none';
  if (dbPanel) dbPanel.style.display = name === 'databricks' ? '' : 'none';
  if (s3Panel) s3Panel.style.display = name === 's3' ? '' : 'none';

  const continueBtn = document.getElementById('diContinueTypeBtn');
  if (continueBtn) {
    continueBtn.disabled = name === 'files' ? !selectedUploadType : true;
    continueBtn.textContent = name === 'files' ? 'Continue' : 'Load source data to continue';
  }

  document.querySelectorAll('[data-source-card]').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-source-card') === name);
  });

  const sourceContinue = document.getElementById('diContinueSourceBtn');
  if (sourceContinue) sourceContinue.disabled = !selectedDataSource;

  if (name === 'databricks') initDatabricksBrowser();
  if (name === 's3') initS3Panel();
}

function getFileKey(file) {
  return `${file.name}::${file.size}::${file.lastModified || 0}`;
}

function isExcelFile(file) {
  return /\.(xlsx|xls|xlsm)$/i.test(String(file?.name || ''));
}

function getPendingExcelFiles() {
  return pendingFiles.filter(isExcelFile);
}

function updateUploadTypeUI() {
  document.querySelectorAll('[data-upload-type]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-upload-type') === selectedUploadType);
  });

  const hint = document.getElementById('uploadTypeHint');
  if (hint) {
    hint.textContent = selectedUploadType
      ? `Selected: ${UPLOAD_TYPE_CONFIG[selectedUploadType]?.label || selectedUploadType}`
      : 'No type selected';
  }

  const workbookBtn = document.getElementById('excelModeWorkbookBtn');
  const selectedBtn = document.getElementById('excelModeSelectedBtn');
  if (workbookBtn) workbookBtn.classList.toggle('active', excelImportMode !== 'selected');
  if (selectedBtn) selectedBtn.classList.toggle('active', excelImportMode === 'selected');

  const continueBtn = document.getElementById('diContinueTypeBtn');
  if (continueBtn && selectedDataSource === 'files') {
    continueBtn.disabled = !selectedUploadType;
  }
}

function setUploadType(type) {
  if (!UPLOAD_TYPE_CONFIG[type]) return;

  if (selectedUploadType && selectedUploadType !== type && pendingFiles.length) {
    clearPendingFiles();
    showSuccess('Selection cleared because file type changed.');
  }

  selectedUploadType = type;
  const input = document.getElementById('fileInput');
  if (input) input.accept = UPLOAD_TYPE_CONFIG[type].accept;
  updateUploadTypeUI();
}

function fileMatchesSelectedType(file) {
  if (!selectedUploadType || !UPLOAD_TYPE_CONFIG[selectedUploadType]) return false;
  return UPLOAD_TYPE_CONFIG[selectedUploadType].pattern.test(String(file?.name || ''));
}

function openFilePicker() {
  if (!selectedUploadType) {
    showError('Choose a file type first: CSV, Excel, JSON, or Parquet.');
    return;
  }
  const input = document.getElementById('fileInput');
  if (!input) return;
  input.accept = UPLOAD_TYPE_CONFIG[selectedUploadType].accept;
  input.click();
}

function clearPendingFiles() {
  pendingFiles = [];
  excelSheetCatalog = {};
  excelSelectedSheets = {};

  const queue = document.getElementById('uploadQueue');
  if (queue) queue.style.display = 'none';
  const preview = document.getElementById('previewSection');
  if (preview) preview.style.display = 'none';
  const excel = document.getElementById('excelImportSection');
  if (excel) excel.style.display = 'none';

  const loadBtn = document.getElementById('loadBtn');
  if (loadBtn) {
    loadBtn.disabled = false;
    loadBtn.textContent = 'Import';
  }

  const continueBtn = document.getElementById('diContinueFileBtn');
  if (continueBtn) continueBtn.disabled = true;

  const input = document.getElementById('fileInput');
  if (input) input.value = '';
}

function removePendingFile(idx) {
  if (idx < 0 || idx >= pendingFiles.length) return;
  const file = pendingFiles[idx];
  pendingFiles.splice(idx, 1);
  if (file) {
    const key = getFileKey(file);
    delete excelSheetCatalog[key];
    delete excelSelectedSheets[key];
  }
  renderUploadQueue();
  renderPreviewFromPendingFiles();
  renderExcelImportSection();
}

function setExcelImportMode(mode) {
  excelImportMode = mode === 'selected' ? 'selected' : 'workbook';
  updateUploadTypeUI();
  renderExcelImportSection();
}

function toggleExcelSheetSelection(fileKey, sheetName, checked) {
  const current = new Set(excelSelectedSheets[fileKey] || []);
  if (checked) current.add(sheetName);
  else current.delete(sheetName);
  excelSelectedSheets[fileKey] = [...current];
}

async function fetchExcelSheetNames(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${API}/api/upload-excel-sheet-names`, { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Could not read sheets for ${file.name}`);
  return Array.isArray(data.sheetNames) ? data.sheetNames : [];
}

async function ensureExcelSheetCatalog() {
  const excelFiles = getPendingExcelFiles();
  for (const file of excelFiles) {
    const key = getFileKey(file);
    if (excelSheetCatalog[key]) continue;
    try {
      const names = await fetchExcelSheetNames(file);
      excelSheetCatalog[key] = names;
      if (!excelSelectedSheets[key]) excelSelectedSheets[key] = [...names];
    } catch (e) {
      excelSheetCatalog[key] = [];
      if (!excelSelectedSheets[key]) excelSelectedSheets[key] = [];
      showError(e.message);
    }
  }
}

function renderExcelSheetPicker() {
  const picker = document.getElementById('excelSheetPicker');
  if (!picker) return;
  const excelFiles = getPendingExcelFiles();

  picker.innerHTML = excelFiles.map(file => {
    const key = getFileKey(file);
    const sheetNames = excelSheetCatalog[key] || [];
    const selectedSet = new Set(excelSelectedSheets[key] || []);
    const options = sheetNames.length
      ? sheetNames.map((sheet, idx) => `
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin:3px 0;color:var(--t1)">
          <input type="checkbox" data-file-key="${escapeHtml(key)}" data-sheet-name="${escapeHtml(sheet)}" ${selectedSet.has(sheet) ? 'checked' : ''}>
          <span>${escapeHtml(sheet)}</span>
        </label>
      `).join('')
      : '<div style="font-size:12px;color:var(--t2)">No sheets found for this workbook.</div>';

    return `
      <details class="card" open style="padding:8px 10px;margin-bottom:8px">
        <summary style="font-size:12px;font-weight:700;color:var(--t1);cursor:pointer">${escapeHtml(file.name)}</summary>
        <div style="margin-top:6px">${options}</div>
      </details>
    `;
  }).join('');

  picker.querySelectorAll('input[type="checkbox"][data-file-key][data-sheet-name]').forEach(input => {
    input.addEventListener('change', e => {
      const fileKey = e.target.getAttribute('data-file-key') || '';
      const sheetName = e.target.getAttribute('data-sheet-name') || '';
      toggleExcelSheetSelection(fileKey, sheetName, e.target.checked);
    });
  });
}

async function renderExcelImportSection() {
  const section = document.getElementById('excelImportSection');
  const pickerWrap = document.getElementById('excelSheetPickerWrap');
  if (!section || !pickerWrap) return;

  const excelFiles = getPendingExcelFiles();
  if (!excelFiles.length) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  const selectedModeInput = document.querySelector('input[name="excelImportMode"][value="selected"]');
  const workbookModeInput = document.querySelector('input[name="excelImportMode"][value="workbook"]');
  if (selectedModeInput) selectedModeInput.checked = excelImportMode === 'selected';
  if (workbookModeInput) workbookModeInput.checked = excelImportMode !== 'selected';

  if (excelImportMode === 'selected') {
    pickerWrap.style.display = '';
    await ensureExcelSheetCatalog();
    renderExcelSheetPicker();
  } else {
    pickerWrap.style.display = 'none';
  }
}

function renderPreviewFromPendingFiles() {
  const continueBtn = document.getElementById('diContinueFileBtn');
  if (continueBtn) continueBtn.disabled = pendingFiles.length === 0;

  if (!pendingFiles.length) {
    const preview = document.getElementById('previewSection');
    if (preview) preview.style.display = 'none';
    return;
  }

  const names = pendingFiles.map(f => f.name).join(', ');
  const last = pendingFiles[pendingFiles.length - 1];
  if (/\.(csv|tsv)$/i.test(last.name)) {
    const reader = new FileReader();
    reader.onload = e => showCSVPreview(e.target.result, last.name);
    reader.readAsText(last);
  } else {
    document.getElementById('previewSection').style.display = '';
    document.getElementById('previewTable').innerHTML = `<tbody><tr><td colspan="4" style="padding:1rem;color:var(--t2)">${escapeHtml(names)}</td></tr></tbody>`;
    document.getElementById('rowCount').textContent = pendingFiles.length + ' file(s) staged for upload';
  }
}

function renderUploadQueue() {
  const queueWrap = document.getElementById('uploadQueue');
  const queueList = document.getElementById('uploadQueueList');
  if (!queueWrap || !queueList) return;
  if (pendingFiles.length <= 1) {
    queueWrap.style.display = 'none';
    return;
  }

  queueWrap.style.display = '';
  queueList.innerHTML = pendingFiles.map((f, idx) => `
    <div class="upload-row" id="uploadRow_${idx}">
      <div class="upload-meta">
        <span class="upload-state-icon" id="uploadState_${idx}">&#9711;</span>
        <span class="upload-name">${escapeHtml(f.name)}</span>
        <span class="upload-size">${(f.size / 1024).toFixed(1)} KB</span>
      </div>
      <button type="button" class="mini-btn" onclick="removePendingFile(${idx})" style="margin-left:auto">Remove</button>
      <div class="upload-progress"><span id="uploadBar_${idx}" style="width:0%"></span></div>
    </div>
  `).join('');
}

function setUploadVisualState(state) {
  pendingFiles.forEach((_, idx) => {
    const icon = document.getElementById(`uploadState_${idx}`);
    const bar = document.getElementById(`uploadBar_${idx}`);
    if (!icon || !bar) return;
    if (state === 'uploading') {
      icon.innerHTML = '&#8635;';
      bar.style.width = '60%';
    } else if (state === 'done') {
      icon.innerHTML = '&#10003;';
      bar.style.width = '100%';
    } else if (state === 'error') {
      icon.innerHTML = '&#9888;';
      bar.style.width = '100%';
    }
  });

  if (state === 'uploading') setImportProgress(62, 'Importing records...', 4);
  if (state === 'done') setImportProgress(100, 'Finalizing import...', 5);
  if (state === 'error') setImportProgress(100, 'Import failed. Review error details.', 5);
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

function syncQAAvailability() {
  const hasData = Object.keys(loadedTables || {}).length > 0;
  const hasScope = selectedAnalyticsTables.size > 0;
  const card = document.getElementById('qaQuestionCard');
  const guard = document.getElementById('qaGuardMessage');
  const input = document.getElementById('qaInput');
  const askBtn = document.getElementById('askBtn');
  const followupRail = document.getElementById('followupRail');

  if (card) card.style.display = (hasData && hasScope) ? '' : 'none';
  if (guard) {
    guard.style.display = (hasData && hasScope) ? 'none' : '';
    if (!hasData) {
      guard.innerHTML = '<strong>No dataset loaded.</strong> Use the Data Input wizard to import data before asking KPI/business questions.';
    } else if (!hasScope) {
      guard.innerHTML = '<strong>Analytics scope is not set.</strong> Use the Data Input wizard to select tables, review structure, and continue.';
    }
  }
  if (input) {
    input.disabled = !(hasData && hasScope);
    if (!(hasData && hasScope)) input.value = '';
  }
  if (askBtn) askBtn.disabled = !(hasData && hasScope);
  if (!(hasData && hasScope) && followupRail) followupRail.style.display = 'none';

  syncAppNavigationState();

  return hasData && hasScope;
}

function getDynamicChipFallback() {
  return [
    {
      label: 'KPI Insight Starters',
      prompts: [
        'Which KPI is currently underperforming the most?',
        'Which segment contributes most to business performance?',
        'What changed most in KPI performance versus previous period?'
      ]
    },
    {
      label: 'Business Decisions',
      prompts: [
        'What are the top 3 actions to improve this KPI?',
        'Which business area has the highest risk right now?',
        'What is the likely root cause behind the latest KPI drop?'
      ]
    }
  ];
}

function renderDynamicQuestionChips(categories) {
  const host = document.getElementById('dynamicQuestionChips');
  if (!host) return;

  const safeCategories = Array.isArray(categories) ? categories : [];
  if (!safeCategories.length) {
    host.innerHTML = '<div class="chip-category"><div class="chip-category-label">Suggested Questions</div><div class="chip-row"><span style="font-size:12px;color:var(--t2)">No suggestions available yet.</span></div></div>';
    return;
  }

  host.innerHTML = safeCategories.map(cat => {
    const label = escapeHtml(cat.label || 'Suggested Questions');
    const prompts = Array.isArray(cat.prompts) ? cat.prompts : [];
    const chips = prompts.map(p => `<button class="chip" data-chip-text="${escapeHtml(String(p))}">${escapeHtml(String(p))}</button>`).join('');
    return `<div class="chip-category"><div class="chip-category-label">${label}</div><div class="chip-row">${chips}</div></div>`;
  }).join('');

  host.querySelectorAll('.chip[data-chip-text]').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.getAttribute('data-chip-text') || '';
      const input = document.getElementById('qaInput');
      if (!input) return;
      input.value = text;
      input.focus();
    });
  });
}

async function loadDynamicQuestionChips() {
  const host = document.getElementById('dynamicQuestionChips');
  if (!host || isLoadingDynamicChips) return;
  isLoadingDynamicChips = true;

  try {
    const tableNames = [...selectedAnalyticsTables].filter(t => loadedTables[t]);
    const hasData = syncQAAvailability();
    if (!hasData || !tableNames.length) {
      return;
    }

    host.innerHTML = '<div class="chip-category"><div class="chip-category-label">Suggested Questions</div><div class="chip-row"><span style="font-size:12px;color:var(--t2)">Generating suggestions from your dataset...</span></div></div>';

    const activeTables = activeTableSet.size ? [...activeTableSet] : tableNames;
    const res = await fetch(`${API}/api/dataset-question-suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeTables, maxPerCategory: 4 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load question suggestions.');

    const categories = Array.isArray(data.categories) ? data.categories : [];
    renderDynamicQuestionChips(categories.length ? categories : getDynamicChipFallback());
  } catch (_) {
    renderDynamicQuestionChips([
      {
        label: 'Suggestions Unavailable',
        prompts: [
          'Could not generate KPI questions right now. Please refresh the page or restart the backend service.'
        ]
      }
    ]);
  } finally {
    isLoadingDynamicChips = false;
  }
}

function buildFollowupSuggestionsFallback(question, decoded, sections) {
  const q = String(question || '').toLowerCase();
  const direct = String(sections?.directAnswer || sections?.summary || '').toLowerCase();
  const suggestions = [];

  if (/total|sum|count|average|avg|max|min/.test(q)) {
    suggestions.push('Can you break this down by category?');
    suggestions.push('How does this compare with the previous period?');
  }
  if (/region|country|state|city|zone/.test(q + ' ' + direct)) {
    suggestions.push('Which region contributes the most to this result?');
  }
  if (/product|segment|customer|channel/.test(q + ' ' + direct)) {
    suggestions.push('Which product or segment is driving this outcome?');
  }
  if (/increase|decrease|decline|growth|trend|forecast/.test(q + ' ' + direct)) {
    suggestions.push('What is the likely trend for the next 3 periods?');
    suggestions.push('What factors are most correlated with this trend?');
  }

  if (decoded?.time_period && decoded.time_period !== 'all_time') {
    suggestions.push('Compare with the previous period using the same filter.');
  }
  if (/forecast|next quarter|next month|next six|prediction/.test(q)) {
    suggestions.push('Show the forecast confidence range.');
  }

  suggestions.push('What should be the top business action from this result?');
  suggestions.push('Show the top 5 contributors to this answer.');

  return Array.from(new Set(suggestions)).slice(0, 6);
}

async function fetchFollowupSuggestions(question, decoded, sections, rowsPreview) {
  try {
    const res = await fetch(`${API}/api/followup-suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        sections,
        decodedIntent: decoded || null,
        rowsPreview: (rowsPreview || []).slice(0, 20),
        conversationContext: conversationTurns.slice(-6)
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not generate follow-up suggestions.');
    const prompts = Array.isArray(data.suggestions) ? data.suggestions : [];
    if (!prompts.length) {
      return buildFollowupSuggestionsFallback(question, decoded, sections);
    }
    return prompts.slice(0, 6);
  } catch (_) {
    return buildFollowupSuggestionsFallback(question, decoded, sections);
  }
}

function normalizePromptText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function markFollowupAsAsked(prompt) {
  const n = normalizePromptText(prompt);
  if (n) askedFollowupPromptSet.add(n);
}

function renderFollowupButtons(rail, prompts) {
  rail.innerHTML = `
    <div style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--t3);margin-bottom:8px">Suggested Follow-up Questions</div>
    <div style="display:flex;gap:7px;flex-wrap:wrap">${prompts.map(p => `<button class="chip" data-followup-text="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('')}</div>`;

  rail.querySelectorAll('button[data-followup-text]').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.getAttribute('data-followup-text') || '';
      runFollowupPrompt(text);
    });
  });
}

function refreshFollowupRailCurrentList() {
  const rail = document.getElementById('followupRail');
  if (!rail) return;
  const visible = currentFollowupPrompts.filter(p => !askedFollowupPromptSet.has(normalizePromptText(p)));
  if (!visible.length) {
    rail.innerHTML = `
      <div style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--t3);margin-bottom:8px">Suggested Follow-up Questions</div>
      <div style="font-size:12px;color:var(--t2)">Generating next follow-up suggestions...</div>`;
    return;
  }
  renderFollowupButtons(rail, visible);
}

async function renderFollowupRail(question, decoded, sections, rowsPreview) {
  const rail = document.getElementById('followupRail');
  if (!rail) return;
  const prompts = await fetchFollowupSuggestions(question, decoded, sections, rowsPreview);
  const filtered = prompts.filter(p => !askedFollowupPromptSet.has(normalizePromptText(p)));
  currentFollowupPrompts = filtered;
  rail.style.display = '';
  if (!currentFollowupPrompts.length) {
    rail.innerHTML = `
      <div style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--t3);margin-bottom:8px">Suggested Follow-up Questions</div>
      <div style="font-size:12px;color:var(--t2)">No more follow-up suggestions for this thread. Ask another business question.</div>`;
    return;
  }
  renderFollowupButtons(rail, currentFollowupPrompts);
}

function runFollowupPrompt(prompt) {
  if (prompt === 'Refresh Dashboard') {
    localStorage.setItem('convbi_tables_updated', Date.now().toString());
    window.open('/dashboard', '_blank');
    return;
  }
  markFollowupAsAsked(prompt);
  currentFollowupPrompts = currentFollowupPrompts.filter(p => normalizePromptText(p) !== normalizePromptText(prompt));
  refreshFollowupRailCurrentList();
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
  if (!selectedUploadType) {
    showError('Choose a file type first before selecting files.');
    return;
  }

  const incoming = Array.from(files);
  const next = incoming.filter(fileMatchesSelectedType);
  const rejected = incoming.length - next.length;
  if (rejected > 0) {
    showError(`${rejected} file(s) ignored. Only ${UPLOAD_TYPE_CONFIG[selectedUploadType].label} files are allowed.`);
  }
  if (!next.length) return;

  const existing = new Set(pendingFiles.map(getFileKey));
  let added = 0;
  for (const file of next) {
    const key = getFileKey(file);
    if (existing.has(key)) continue;
    pendingFiles.push(file);
    existing.add(key);
    added++;
  }
  if (!added) {
    showError('Selected files are already staged.');
    return;
  }

  renderUploadQueue();
  renderPreviewFromPendingFiles();
  renderExcelImportSection();
  const input = document.getElementById('fileInput');
  if (input) input.value = '';
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
  const continueBtn = document.getElementById('diContinueFileBtn');
  if (continueBtn) continueBtn.textContent = pendingFiles.length ? `Continue (${pendingFiles.length} file${pendingFiles.length > 1 ? 's' : ''})` : 'Continue';
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
  if (!pendingFiles.length) {
    showError('Select at least one file before uploading.');
    return;
  }
  if (!selectedUploadType) {
    showError('Choose a file type before uploading.');
    return;
  }
  const btn = document.getElementById('loadBtn');
  quickStartUsed = false;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Importing...';
  }

  markWizardStepDone(6);
  goToWizardStep(7, { force: true });
  setImportProgress(8, 'Reading files...', 0);

  setUploadVisualState('uploading');

  const fd = new FormData();
  pendingFiles.forEach(f => fd.append('files', f));

  const excelSelection = {
    mode: excelImportMode,
    perFile: pendingFiles.map(f => {
      const key = getFileKey(f);
      return {
        name: f.name,
        size: f.size,
        sheets: isExcelFile(f)
          ? (excelImportMode === 'selected' ? (excelSelectedSheets[key] || []) : [])
          : []
      };
    })
  };

  if (excelImportMode === 'selected') {
    const excelFiles = getPendingExcelFiles();
    for (const file of excelFiles) {
      const key = getFileKey(file);
      if (!(excelSelectedSheets[key] || []).length) {
        showError(`Select at least one sheet for ${file.name}.`);
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Import';
        }
        goToWizardStep(6, { force: true });
        return;
      }
    }
  }

  fd.append('excelSelection', JSON.stringify(excelSelection));
  fd.append('selectedUploadType', selectedUploadType);

  try {
    setImportProgress(25, 'Validating schema...', 1);
    const res  = await fetch(`${API}/api/upload-files`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) {
      showError(data.error || 'Upload failed.');
      setUploadVisualState('error');
      renderImportResult({ tables: [], errors: data.errors || [{ file: 'Upload', error: data.error || 'Unknown failure' }] });
      goToWizardStep(8, { force: true });
      return;
    }

    setImportProgress(78, 'Creating tables...', 3);

    setUploadVisualState('done');

    setImportProgress(100, 'Finalizing import...', 5);
    markWizardStepDone(7);
    markWizardStepDone(8);

    lastImportResult = data;
    renderImportResult(data);

    clearPendingFiles();

    const count = data.tables.length;
    showSuccess(`${count} table${count>1?'s':''} loaded. Continue with table selection workflow.`);
    await refreshTableLibrary();
    goToWizardStep(8, { force: true });
  } catch (e) {
    setUploadVisualState('error');
    showError('Upload error: ' + e.message);
    renderImportResult({ tables: [], errors: [{ file: 'Upload', error: e.message }] });
    goToWizardStep(8, { force: true });
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Import';
    }
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
    loadAnalyticsPreferences();
    selectedAnalyticsTables = new Set([...selectedAnalyticsTables].filter(t => loadedTables[t]));
    activeTableSet = new Set(selectedAnalyticsTables);
    persistAnalyticsPreferences();
    renderTableLibrary();
    renderAnalyticsFlowSection();
    updateLoadedTablesBadge();
    syncQAAvailability();
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
  setTableLibraryView(tableLibraryView);

  const sourceIcon = s => s === 'databricks' ? '🔷' : s === 's3' ? '🟠' : '📄';
  list.innerHTML = names.map(name => {
    const t = loadedTables[name];
    return `<div class="ds-item">
      <span class="ds-dot" style="background:#7A2F8F"></span>
      <span class="ds-name">${escapeHtml(name)}</span>
      <span class="ds-badge">${sourceIcon(t.source||'file')} ${escapeHtml(t.source||'file')}</span>
      <span class="ds-rows">${(t.rowCount||0).toLocaleString()} rows</span>
      <span class="ds-rows">${(t.columns||[]).length} cols</span>
      <button class="ds-remove" title="Unload" onclick="removeTable('${escapeHtml(name)}')">✕</button>
    </div>`;
  }).join('');
}

function loadAnalyticsPreferences() {
  try {
    const storedTables = JSON.parse(localStorage.getItem('convbi_selected_tables') || '[]');
    selectedAnalyticsTables = new Set((storedTables || []).filter(t => loadedTables[t]));
  } catch (_) {
    selectedAnalyticsTables = new Set();
  }
  try {
    glossaryMap = JSON.parse(localStorage.getItem('convbi_glossary') || '{}') || {};
  } catch (_) {
    glossaryMap = {};
  }
}

function persistAnalyticsPreferences() {
  localStorage.setItem('convbi_selected_tables', JSON.stringify([...selectedAnalyticsTables]));
  localStorage.setItem('convbi_glossary', JSON.stringify(glossaryMap || {}));
}

function goToAnalyticsFlowStep(step) {
  const requested = Math.max(1, Math.min(3, Number(step) || 1));
  if (requested > 1 && !selectedAnalyticsTables.size) {
    showError('Select at least one table in Step 1 first.');
    analyticsFlowStep = 1;
  } else {
    analyticsFlowStep = requested;
  }

  const step1 = document.getElementById('flowStepSelect');
  const step2 = document.getElementById('flowStepStructure');
  const step3 = document.getElementById('flowStepRelation');
  if (step1) step1.style.display = analyticsFlowStep === 1 ? '' : 'none';
  if (step2) step2.style.display = analyticsFlowStep === 2 ? '' : 'none';
  if (step3) step3.style.display = analyticsFlowStep === 3 ? '' : 'none';

  if (analyticsFlowStep === 1) {
    wizardStep = 9;
    markWizardStepDone(8);
  }
  if (analyticsFlowStep === 2) {
    wizardStep = 10;
    markWizardStepDone(9);
  }
  if (analyticsFlowStep === 3) {
    wizardStep = 11;
    markWizardStepDone(10);
  }
  showWizardStage(wizardStep);
  renderWizardStepper();
  updateWizardGuidance(wizardStep);

  if (analyticsFlowStep === 2) renderAnalyticsStructureStep();
  if (analyticsFlowStep === 3) renderAnalyticsRelationStep();
}

function toggleAnalyticsTable(name) {
  if (!loadedTables[name]) return;
  selectedAnalyticsTables.has(name) ? selectedAnalyticsTables.delete(name) : selectedAnalyticsTables.add(name);
  persistAnalyticsPreferences();
  renderAnalyticsFlowStepSelect();
  syncQAAvailability();
}

function selectAllAnalyticsTables() {
  Object.keys(loadedTables).forEach(name => selectedAnalyticsTables.add(name));
  persistAnalyticsPreferences();
  renderAnalyticsFlowStepSelect();
  syncQAAvailability();
}

function clearAnalyticsTableSelection() {
  selectedAnalyticsTables.clear();
  persistAnalyticsPreferences();
  renderAnalyticsFlowStepSelect();
  syncQAAvailability();
}

function renderAnalyticsFlowStepSelect() {
  const host = document.getElementById('flowStepSelect');
  if (!host) return;
  const names = Object.keys(loadedTables);
  if (!names.length) {
    host.innerHTML = '<div class="no-data">Upload data first to start table selection.</div>';
    return;
  }

  if (names.length === 1 && !selectedAnalyticsTables.size) {
    selectedAnalyticsTables.add(names[0]);
    persistAnalyticsPreferences();
  }

  const singleAuto = names.length === 1
    ? `<div class="di-single-auto">✓ One table detected. The table has been selected automatically.</div>`
    : '';

  host.innerHTML = `
    ${singleAuto}
    ${names.length > 1 ? '<input class="input" id="flowTableSearch" placeholder="Search tables" oninput="filterFlowTables(this.value)" style="margin-bottom:10px;max-width:360px" />' : ''}
    <div class="flow-table-grid">
      ${names.map(name => {
        const checked = selectedAnalyticsTables.has(name);
        return `<div class="flow-table-item ${checked ? 'active' : ''}" data-flow-table="${escapeHtml(name).toLowerCase()}" onclick="toggleAnalyticsTable('${escapeHtml(name)}')">
          <div class="flow-table-head">
            <input type="checkbox" ${checked ? 'checked' : ''} tabindex="-1" aria-hidden="true" />
            <div class="flow-table-name">${escapeHtml(name)}</div>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="flow-actions">
      <button class="flow-btn-secondary" onclick="selectAllAnalyticsTables()">Select All</button>
      <button class="flow-btn-secondary" onclick="clearAnalyticsTableSelection()">Clear</button>
      <button class="submit-btn" onclick="goToStructureStep()">Continue</button>
    </div>
  `;
}

function filterFlowTables(query) {
  const q = String(query || '').trim().toLowerCase();
  document.querySelectorAll('[data-flow-table]').forEach(card => {
    const name = card.getAttribute('data-flow-table') || '';
    card.style.display = !q || name.includes(q) ? '' : 'none';
  });
}

async function goToStructureStep() {
  if (!selectedAnalyticsTables.size) {
    showError('Select at least one table to continue.');
    return;
  }
  markWizardStepDone(9);
  goToAnalyticsFlowStep(2);
  await renderAnalyticsStructureStep();
}

function sqlQuoteIdent(name) {
  return `"${String(name || '').replace(/"/g, '""')}"`;
}

async function renderAnalyticsStructureStep() {
  const host = document.getElementById('flowStepStructure');
  if (!host) return;
  host.innerHTML = '<div class="no-data">Loading schema details...</div>';

  const names = [...selectedAnalyticsTables].filter(n => loadedTables[n]);
  const cards = [];

  for (const name of names) {
    const meta = loadedTables[name] || {};
    let sampleRows = [];
    try {
      const res = await fetch(`${API}/api/execute-sql`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: `SELECT * FROM ${sqlQuoteIdent(name)} LIMIT 5` })
      });
      const data = await res.json();
      sampleRows = Array.isArray(data.rows) ? data.rows : [];
    } catch (_) {}

    const allCols = meta.columns || [];
    cards.push(`
      <div class="flow-structure-card">
        <div class="flow-table-head" style="margin-bottom:8px">
          <div class="flow-table-name">${escapeHtml(name)}</div>
        </div>
        <div class="flow-mini-table-wrap" style="margin-top:8px;margin-bottom:8px">
          <table class="flow-mini-table">
            <thead><tr><th>Column</th><th>Type</th></tr></thead>
            <tbody>${allCols.map(c => `<tr><td>${escapeHtml(c.name || '')}</td><td>${escapeHtml(c.type || '')}</td></tr>`).join('') || '<tr><td colspan="2">No columns detected</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    `);
  }

  host.innerHTML = `${cards.join('')}<div class="flow-actions"><button class="flow-btn-secondary" onclick="goToAnalyticsFlowStep(1)">Back</button><button class="submit-btn" onclick="goToRelationStep()">Continue</button></div>`;
}

function detectCommonColumns(tableNames) {
  const map = {};
  tableNames.forEach(t => {
    (loadedTables[t]?.columns || []).forEach(c => {
      const key = String(c.name || '').toLowerCase();
      if (!key) return;
      if (!map[key]) map[key] = [];
      map[key].push(t);
    });
  });
  return Object.entries(map)
    .filter(([, tables]) => tables.length > 1)
    .map(([col, tables]) => ({ col, tables }))
    .sort((a, b) => b.tables.length - a.tables.length)
    .slice(0, 20);
}

function getGlossaryCandidateColumns(selectedNames, joins = [], commons = [], includeAll = false) {
  const keys = new Set();
  const add = (tableName, columnName) => {
    if (!tableName || !columnName) return;
    keys.add(`${tableName}.${columnName}`);
  };

  joins.forEach(j => {
    add(j.tableA, j.columnA);
    add(j.tableB, j.columnB);
  });

  commons.forEach(c => {
    c.tables.forEach(t => add(t, c.col));
  });

  selectedNames.forEach(tableName => {
    const cols = loadedTables[tableName]?.columns || [];
    cols.forEach(c => {
      const col = String(c.name || '');
      if (includeAll || /date|time|id|name|amount|sales|revenue|profit|cost|qty|count|status/i.test(col)) {
        add(tableName, col);
      }
    });
  });

  return [...keys].sort();
}

async function goToRelationStep() {
  if (!selectedAnalyticsTables.size) {
    showError('Select at least one table first.');
    return;
  }
  markWizardStepDone(10);
  goToAnalyticsFlowStep(3);
  await renderAnalyticsRelationStep();
}

async function renderAnalyticsRelationStep(includeAllGlossary = false) {
  const host = document.getElementById('flowStepRelation');
  if (!host) return;
  host.innerHTML = '<div class="no-data">Loading relationships and glossary...</div>';

  const selectedNames = [...selectedAnalyticsTables].filter(n => loadedTables[n]);
  let relData = { joins: [], noRelation: [] };
  try {
    const relRes = await fetch(`${API}/api/detect-relationships`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    relData = relRes.ok ? await relRes.json() : relData;
  } catch (_) {}

  const joins = (relData.joins || []).filter(j => selectedNames.includes(j.tableA) && selectedNames.includes(j.tableB));
  const commons = detectCommonColumns(selectedNames);
  const singleTableMode = selectedNames.length === 1;

  const glossaryKeys = getGlossaryCandidateColumns(selectedNames, joins, commons, includeAllGlossary);
  const glossaryRows = glossaryKeys.map(key => {
    const [tableName, columnName] = key.split('.');
    return `
      <tr>
        <td>${escapeHtml(tableName || '')}</td>
        <td>${escapeHtml(columnName || '')}</td>
        <td><input class="flow-glossary-input" data-glossary-key="${escapeHtml(key)}" value="${escapeHtml(glossaryMap[key] || '')}" placeholder="Example: date2 means date of birth" /></td>
      </tr>
    `;
  });

  host.innerHTML = `
    ${singleTableMode ? '<div class="di-single-auto">Relationships are not required because only one table has been imported. Continue.</div>' : ''}
    <div class="flow-rel-grid">
      <div class="flow-rel-box">
        <div style="font-weight:700;margin-bottom:8px">Detected Join Relationships</div>
        ${singleTableMode ? '<div class="flow-rel-item">Single table mode: relationship setup is skipped.</div>' : ((joins.map(j => `<div class="flow-rel-item">${escapeHtml(j.tableA)}.${escapeHtml(j.columnA)} -> ${escapeHtml(j.tableB)}.${escapeHtml(j.columnB)}</div>`).join('')) || '<div class="flow-rel-item">No join relationships detected across selected tables.</div>')}
      </div>
      <div class="flow-rel-box">
        <div style="font-weight:700;margin-bottom:8px">Common Columns Across Tables</div>
        ${(commons.map(c => `<div class="flow-rel-item">${escapeHtml(c.col)} shared by ${escapeHtml(c.tables.join(', '))}</div>`).join('')) || '<div class="flow-rel-item">No common columns detected.</div>'}
      </div>
    </div>

    <div class="flow-rel-box" style="margin-top:10px">
      <div style="font-weight:700;margin-bottom:8px">Business Glossary (Column Instructions)</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">
        Showing ${glossaryKeys.length} important columns first for easy setup.
      </div>
      <div class="flow-mini-table-wrap">
        <table class="flow-glossary-table">
          <thead><tr><th>Table</th><th>Column</th><th>Business meaning / instruction</th></tr></thead>
          <tbody>${glossaryRows.join('') || '<tr><td colspan="3">No glossary candidates found.</td></tr>'}</tbody>
        </table>
      </div>
    </div>

    <div class="flow-actions">
      <button class="flow-btn-secondary" onclick="goToAnalyticsFlowStep(2)">Back</button>
      <button class="flow-btn-secondary" onclick="saveGlossaryFromUI()">Save Glossary</button>
      <button class="submit-btn" onclick="applyAnalyticsSelection()">Continue</button>
    </div>
  `;
}

function saveGlossaryFromUI() {
  document.querySelectorAll('[data-glossary-key]').forEach(input => {
    const key = input.getAttribute('data-glossary-key');
    const val = String(input.value || '').trim();
    if (!key) return;
    if (!val) delete glossaryMap[key];
    else glossaryMap[key] = val;
  });
  persistAnalyticsPreferences();
  showSuccess('Glossary saved for analytics context.');
}

function applyAnalyticsSelection() {
  if (!selectedAnalyticsTables.size) {
    showError('Choose tables before applying analytics scope.');
    return;
  }
  saveGlossaryFromUI();
  activeTableSet = new Set(selectedAnalyticsTables);
  persistAnalyticsPreferences();
  syncQAAvailability();
  refreshTableContextBar();
  markWizardStepDone(11);
  goToWizardStep(12, { force: true });
  showSuccess(`Analytics scope applied for ${selectedAnalyticsTables.size} table${selectedAnalyticsTables.size > 1 ? 's' : ''}.`);
}

function renderAnalyticsFlowSection() {
  const section = document.getElementById('analyticsFlowSection');
  if (!section) return;
  const hasData = Object.keys(loadedTables || {}).length > 0;
  section.style.display = 'none';
  if (!hasData) return;

  renderAnalyticsFlowStepSelect();
  if (wizardStep >= 10) renderAnalyticsStructureStep();
  if (wizardStep >= 11) renderAnalyticsRelationStep();
}

async function removeTable(name) {
  await fetch(`${API}/api/tables/${encodeURIComponent(name)}`, { method: 'DELETE' });
  selectedAnalyticsTables.delete(name);
  [...Object.keys(glossaryMap || {})]
    .filter(k => k.startsWith(`${name}.`))
    .forEach(k => delete glossaryMap[k]);
  persistAnalyticsPreferences();
  await refreshTableLibrary();
}

// ── Table context bar (which tables are in scope for the question) ─────────────
function refreshTableContextBar() {
  const bar   = document.getElementById('tableContextBar');
  const chips = document.getElementById('tableContextChips');
  if (!bar || !chips) return;
  syncQAAvailability();
  const names = [...selectedAnalyticsTables].filter(n => loadedTables[n]);
  if (!names.length) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = '';
  // Default: all active
  if (!activeTableSet.size) names.forEach(n => activeTableSet.add(n));
  [...activeTableSet].forEach(n => {
    if (!names.includes(n)) activeTableSet.delete(n);
  });
  chips.innerHTML = names.map(n =>
    `<button class="ctx-chip ${activeTableSet.has(n)?'ctx-chip-on':''}" onclick="toggleTableCtx('${escapeHtml(n)}')">${escapeHtml(n)}</button>`
  ).join('');
  loadDynamicQuestionChips();
}
function toggleTableCtx(name) {
  activeTableSet.has(name) ? activeTableSet.delete(name) : activeTableSet.add(name);
  refreshTableContextBar();
}
function selectAllTables() {
  [...selectedAnalyticsTables].forEach(n => activeTableSet.add(n));
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
          series:[{type:'line',data:keys.map(k=>+(byDate[k].reduce((a,b)=>a+b,0)/byDate[k].length).toFixed(2)),smooth:true,lineStyle:{width:2},itemStyle:{color:'#7A2F8F'},areaStyle:{opacity:0.08}}],
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
          series:[{type:'bar',data:keys.map(k=>+(groups[k].reduce((a,b)=>a+b,0)/groups[k].length).toFixed(2)),itemStyle:{color:'#3B82F6',borderRadius:[4,4,0,0]}}],
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
  const baseScope = selectedAnalyticsTables.size ? selectedAnalyticsTables : new Set(Object.keys(loadedTables));
  const inScope = activeTableSet.size ? activeTableSet : baseScope;
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

  const scope = [...selectedAnalyticsTables].filter(t => schemas[t]);
  if (scope.length) {
    rules += `\n\nANALYTICS SCOPE:\n- Prefer these tables first: ${scope.join(', ')}`;
  }

  const glossaryEntries = Object.entries(glossaryMap || {}).filter(([, v]) => String(v || '').trim());
  if (glossaryEntries.length) {
    rules += '\n\nBUSINESS GLOSSARY OVERRIDES:';
    glossaryEntries.slice(0, 120).forEach(([k, v]) => {
      rules += `\n- ${k}: ${String(v).trim()}`;
    });
  }
  return rules;
}

function buildGoldLayerContext(schemas, relationships) {
  const scopedTables = [...selectedAnalyticsTables].filter(t => schemas[t]);
  const glossaryEntries = Object.entries(glossaryMap || {})
    .filter(([, v]) => String(v || '').trim())
    .map(([k, v]) => ({ columnRef: k, meaning: String(v).trim() }))
    .slice(0, 200);

  const joinHints = Array.isArray(relationships?.joins)
    ? relationships.joins
      .filter(j => scopedTables.includes(j.tableA) && scopedTables.includes(j.tableB))
      .map(j => ({
        tableA: j.tableA,
        tableB: j.tableB,
        on: `${j.tableA}.${j.columnA} = ${j.tableB}.${j.columnB}`,
        confidence: j.confidence
      }))
      .slice(0, 50)
    : [];

  return {
    layer: 'gold',
    selectedTables: scopedTables,
    glossary: glossaryEntries,
    joinHints,
    note: 'Use glossary meanings and selected-table relationships as business truth before answering.'
  };
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

  markFollowupAsAsked(q);
  currentFollowupPrompts = currentFollowupPrompts.filter(p => normalizePromptText(p) !== normalizePromptText(q));
  refreshFollowupRailCurrentList();

  const tables = [...selectedAnalyticsTables].filter(t => loadedTables[t]);
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
      await renderFollowupRail(q, c.decoded || {}, sections, c.rows || []);
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
    const goldLayerContext = buildGoldLayerContext(allTableSchemas, relData);

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
        goldLayerContext,
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
          goldLayerContext,
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
      setWorkflowRuntime(9, 'Preparing direct answer with concise evidence.');
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
      if (isGenericDirectAnswer(sections.directAnswer || sections.summary || '')) {
        const betterDirectAnswer = synthesizeDirectAnswerFromResult(q, execData);
        sections.directAnswer = betterDirectAnswer;
        sections.summary = betterDirectAnswer;
      }
      renderAnswerCard(q, sections, sql, decoded, execData, allTableSchemas);
      setWorkflowRuntime(10, 'Follow-up prompts are ready for deeper exploration.');
      await renderFollowupRail(q, decoded || {}, sections, allRows);
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
  div.innerHTML = `<div class="msg-bubble thinking">
    <div class="thinking-status">
      <span>Reading table schema</span>
      <span>&#8594;</span>
      <span>Checking cache</span>
      <span>&#8594;</span>
      <span>Generating SQL</span>
      <span>&#8594;</span>
      <span>Running query</span>
    </div>
    <span class="think-label" id="${id}_lbl">Thinking...</span>
  </div>`;
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

function toTitleLabel(name) {
  return String(name || '').replace(/[_-]+/g, ' ').trim();
}

function isNumericLike(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  const n = Number(value);
  return Number.isFinite(n);
}

function formatMetricValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(2).replace(/\.00$/, '') + 'M';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(2).replace(/\.00$/, '') + 'K';
  return n.toFixed(2).replace(/\.00$/, '');
}

function synthesizeDirectAnswerFromResult(question, execData) {
  const rows = Array.isArray(execData?.rows) ? execData.rows : [];
  const columns = Array.isArray(execData?.columns) ? execData.columns : [];
  const q = String(question || '').toLowerCase();

  if (!rows.length) return 'No records matched the current question filters.';

  const sample = rows.slice(0, 25);
  const numericCols = columns
    .map(c => c.name)
    .filter(name => sample.some(r => isNumericLike(r?.[name])));
  const categoricalCols = columns
    .map(c => c.name)
    .filter(name => !numericCols.includes(name));

  const likelyCountCol = columns.map(c => c.name).find(n => /count|row_count|total_rows|records/i.test(String(n || '')));
  if (likelyCountCol && rows[0] && isNumericLike(rows[0][likelyCountCol])) {
    return `There are ${formatMetricValue(rows[0][likelyCountCol])} records for this question.`;
  }

  if (rows.length === 1) {
    const row = rows[0];
    if (numericCols.length === 1) {
      const m = numericCols[0];
      return `${toTitleLabel(m)} is ${formatMetricValue(row[m])}.`;
    }
    if (numericCols.length > 1) {
      const pairs = numericCols.slice(0, 3).map(m => `${toTitleLabel(m)} ${formatMetricValue(row[m])}`);
      return `Key results: ${pairs.join(', ')}.`;
    }
    const keys = Object.keys(row || {}).slice(0, 3);
    if (keys.length) {
      return `Top result: ${keys.map(k => `${toTitleLabel(k)} ${String(row[k] ?? '')}`).join(', ')}.`;
    }
  }

  const metric = numericCols[0] || null;
  const dimension = categoricalCols.find(c => !/date|time|month|year|quarter|week/i.test(String(c || ''))) || categoricalCols[0] || null;

  if (metric && dimension) {
    const ranked = [...rows].filter(r => isNumericLike(r?.[metric]));
    if (ranked.length) {
      const wantMin = /lowest|min|least|bottom|worst/.test(q);
      ranked.sort((a, b) => Number(a[metric]) - Number(b[metric]));
      const pick = wantMin ? ranked[0] : ranked[ranked.length - 1];
      const who = String(pick?.[dimension] ?? 'N/A');
      return `${toTitleLabel(dimension)} ${who} has ${wantMin ? 'the lowest' : 'the highest'} ${toTitleLabel(metric)} at ${formatMetricValue(pick?.[metric])}.`;
    }
  }

  if (metric) {
    const vals = rows.map(r => Number(r?.[metric])).filter(v => Number.isFinite(v));
    if (vals.length) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      return `${toTitleLabel(metric)} averages ${formatMetricValue(avg)} across ${vals.length} returned rows.`;
    }
  }

  return `Returned ${rows.length} rows; refine the question to focus on a KPI or comparison.`;
}

function isGenericDirectAnswer(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return true;
  return (
    /^the query completed successfully and returned\s+\d+\s+rows?\.?$/i.test(t) ||
    /^query returned\s+\d+\s+rows?\.?$/i.test(t) ||
    /^not available\.?$/i.test(t)
  );
}

// ── Render answer card ────────────────────────────────────────────────────────
function getSectionVisibility(question, decoded) {
  const q = String(question || '').toLowerCase();
  const intent = String(decoded?.intent_type || '').toLowerCase();

  const asksWhy = /\b(why|reason|cause|root cause|driver|driving|explain)\b/.test(q);
  const asksAction = /\b(recommend|recommendation|action|next step|what should|how can we|improve|mitigate)\b/.test(q);
  const asksImpact = /\b(impact|risk|opportunity|implication|effect|business impact|so what)\b/.test(q);
  const asksTrend = /\b(trend|over time|month|quarter|year|forecast|predict|growth|decline|increase|decrease)\b/.test(q);
  const asksComparison = /\b(compare|comparison|vs\.?|versus|difference|higher|lower|rank|top|bottom)\b/.test(q);
  const asksEvidence = /\b(evidence|proof|support|supporting|confidence|how do you know)\b/.test(q);

  const isLookup = intent === 'lookup';
  const isTrendLike = ['trend', 'comparison', 'ranking', 'aggregation', 'ratio', 'visualization'].includes(intent);
  const isRootCauseLike = intent === 'conditional' || asksWhy;

  return {
    whatHappened: !isLookup && (isTrendLike || asksTrend || asksComparison),
    whyHappened: isRootCauseLike,
    supportingEvidence: !isLookup && (isTrendLike || isRootCauseLike || asksEvidence || asksComparison),
    businessImpact: asksImpact || isRootCauseLike || intent === 'trend' || intent === 'comparison',
    recommendedAction: asksAction || isRootCauseLike
  };
}

function renderAnswerCard(question, sections, sql, decoded, execData, schemas, fromCache = false) {
  const msgs = document.getElementById('messages');
  const div  = document.createElement('div');
  div.className = 'msg bot answer-card-msg';

  const currentDirectAnswer = sections?.directAnswer || sections?.summary || '';
  if (isGenericDirectAnswer(currentDirectAnswer)) {
    const betterDirectAnswer = synthesizeDirectAnswerFromResult(question, execData);
    sections.directAnswer = betterDirectAnswer;
    sections.summary = betterDirectAnswer;
  }

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

  const hasUsefulText = value => {
    const v = String(value || '').trim();
    if (!v) return false;
    return !/^not available\.?$/i.test(v);
  };

  const hasExplanation = !!(
    hasUsefulText(sections.whatHappened) ||
    hasUsefulText(sections.whyHappened) ||
    hasUsefulText(sections.supportingEvidence) ||
    hasUsefulText(sections.businessImpact) ||
    hasUsefulText(sections.recommendedAction)
  );

  const sectionVisibility = getSectionVisibility(question, decoded);

  const showWhat = sectionVisibility.whatHappened && hasUsefulText(sections.whatHappened);
  const showWhy = sectionVisibility.whyHappened && hasUsefulText(sections.whyHappened);
  const showEvidence = sectionVisibility.supportingEvidence && hasUsefulText(sections.supportingEvidence);
  const showImpact = sectionVisibility.businessImpact && hasUsefulText(sections.businessImpact);
  const showAction = sectionVisibility.recommendedAction && hasUsefulText(sections.recommendedAction);

  const hasRelevantExplanation = !!(showWhat || showWhy || showEvidence || showImpact || showAction);

  const explanationHtml = hasExplanation && hasRelevantExplanation
    ? `
      <details class="answer-approach-detail" style="margin-top:10px">
        <summary class="approach-toggle">Explain this answer</summary>
        <div class="approach-body" style="margin-top:10px">
          ${showWhat ? `<div class="answer-insight"><strong>What happened:</strong> ${escapeHtml(sections.whatHappened)}</div>` : ''}
          ${showWhy ? `<div class="answer-insight"><strong>Why:</strong> ${escapeHtml(sections.whyHappened)}</div>` : ''}
          ${showEvidence ? `<div class="answer-insight"><strong>Evidence:</strong><br/>${escapeHtml(sections.supportingEvidence).replace(/\n/g,'<br/>')}</div>` : ''}
          ${showImpact ? `<div class="answer-insight"><strong>Business impact:</strong> ${escapeHtml(sections.businessImpact)}</div>` : ''}
          ${showAction ? `<div class="answer-insight"><strong>Recommended action:</strong><br/>${escapeHtml(sections.recommendedAction).replace(/\n/g,'<br/>')}</div>` : ''}
        </div>
      </details>`
    : '';

  const decisionSupportLine = showAction
    ? String(sections.recommendedAction).split(/\r?\n/).find(Boolean)
    : '';

  div.innerHTML = `
    <div class="msg-bubble answer-card" id="${cardId}">
      <div class="answer-meta">
        <div class="answer-tables">${tablesUsed.map(t=>`<span class="answer-table-chip">${escapeHtml(t)}</span>`).join('')}</div>
        ${fromCache ? '<span class="cached-badge">&#9889; cached</span>' : ''}
        ${joinInfo}
      </div>
      <div class="answer-summary"><strong>Answer:</strong> ${escapeHtml(sections.directAnswer || sections.summary || '')}</div>
      ${explanationHtml}
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
      ${decisionSupportLine ? `<div class="answer-insight" style="margin-top:10px"><strong>Decision support:</strong> ${escapeHtml(decisionSupportLine)}</div>` : ''}
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
  const input = document.getElementById('qaInput');
  if (!input || !btn) return;
  input.value = btn.textContent.trim();
  input.focus();
}

let queryHistory = [];
function saveToHistory(q, summary, sql) {
  queryHistory.unshift({ q, summary, sql, ts: new Date().toISOString() });
  if (queryHistory.length > 20) queryHistory.pop();
  localStorage.setItem('convbi_history', JSON.stringify(queryHistory));
}

function hasLewSections(text) {
  if (!text) return false;
  return String(text).includes('##DIRECT_ANSWER##');
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
        itemStyle:{color:['#7A2F8F','#3B82F6','#22C55E','#F59E0B'][i]}
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
        itemStyle:{color:'#7A2F8F',borderRadius:[4,4,0,0]},
        label:{show:limited.length<=12,position:'top',fontSize:10}}],
      tooltip:{trigger:'axis'}
    };
  } else if (numCols.length === 2 && rows.length >= 5) {
    option = {
      grid: {top:30,right:20,bottom:40,left:60},
      xAxis: {type:'value',name:numCols[0].name,nameLocation:'middle',nameGap:25,axisLabel:{fontSize:11}},
      yAxis: {type:'value',name:numCols[1].name,nameLocation:'middle',nameGap:40,axisLabel:{fontSize:11}},
      series: [{type:'scatter',data:rows.map(r=>[r[numCols[0].name],r[numCols[1].name]]),
        itemStyle:{color:'#7A2F8F',opacity:0.7}}],
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
  const srcState = document.getElementById('dbSourceState');
  if (!dot||!text) return;
  text.textContent = 'Connecting…';
  if (srcState) srcState.innerHTML = '&#9679; Connecting';
  try {
    const r    = await fetch(`${API}/api/databricks/status`);
    const data = await r.json();
    if (data.connected) {
      dot.className  = 'db-dot db-dot-ok';
      text.textContent = 'Connected to ' + data.hostname;
      if (srcState) srcState.innerHTML = '&#9650; Connected';
      loadDbCatalogs();
    } else {
      dot.className = 'db-dot db-dot-err';
      text.textContent = 'Error: ' + (data.error||'Not connected');
      if (srcState) srcState.innerHTML = '&#9679; Not connected';
    }
  } catch (e) {
    dot.className = 'db-dot db-dot-err';
    text.textContent = 'Could not reach Databricks API';
    if (srcState) srcState.innerHTML = '&#9679; Not connected';
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
      markWizardStepDone(7);
      markWizardStepDone(8);
      renderImportResult({
        tables: [{ tableName: safeName, rowCount: data.rows.length }],
        errors: []
      });
      goToWizardStep(8, { force: true });
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
        <span class="s3-ext-badge" style="font-size:10px;font-weight:700;background:var(--brand-primary);color:#fff;padding:2px 6px;border-radius:4px;min-width:38px;text-align:center;text-transform:uppercase">${escapeHtml(f.ext)}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(f.key)}">${escapeHtml(f.name)}</div>
          <div style="font-size:11px;color:var(--t2)">${escapeHtml(f.sizeLabel)} &bull; ${escapeHtml(f.key)}</div>
        </div>
        <button data-s3key="${escapeHtml(f.key)}" onclick="loadS3FileFromBtn(this)" style="font-size:12px;padding:4px 12px;background:var(--brand-primary);color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap">Load</button>
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
    markWizardStepDone(7);
    markWizardStepDone(8);
    renderImportResult({ tables, errors: [] });
    goToWizardStep(8, { force: true });
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

function setupScrollReveal() {
  const nodes = document.querySelectorAll('.reveal-on-scroll');
  if (!nodes.length || typeof IntersectionObserver === 'undefined') {
    nodes.forEach(n => n.classList.add('revealed'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.16 });
  nodes.forEach(n => io.observe(n));
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const loadBtn = document.getElementById('loadBtn');
  if (loadBtn) {
    loadBtn.disabled = false;
    loadBtn.textContent = 'Import';
  }

  selectedDataSource = 'files';
  selectDataSource('files');
  switchSourceTab('files');
  renderWizardStepper();
  updateWizardGuidance(1);
  goToWizardStep(1, { force: true });

  updateUploadTypeUI();
  await refreshTableLibrary();
  switchTab(getInitialTabFromUrl());
  setTableLibraryView(tableLibraryView);

  const railBtn = document.getElementById('railCollapseBtn');
  const rail = document.getElementById('leftRail');
  const shell = document.querySelector('.app-shell');

  const setRailPinnedState = (isPinned, persist = true) => {
    if (!rail || !shell || !railBtn) return;
    rail.classList.toggle('pinned', !!isPinned);
    shell.classList.toggle('rail-expanded', !!isPinned);
    railBtn.innerHTML = isPinned ? '&#128275;' : '&#128204;';
    railBtn.title = isPinned ? 'Unpin sidebar' : 'Pin sidebar';
    railBtn.setAttribute('aria-label', isPinned ? 'Unpin sidebar' : 'Pin sidebar');
    if (persist) localStorage.setItem(SIDEBAR_PIN_KEY, isPinned ? 'true' : 'false');
  };

  const syncRailShellState = () => {
    if (!rail || !shell) return;
    shell.classList.toggle('rail-expanded', rail.classList.contains('pinned'));
  };

  rail?.addEventListener('mouseenter', () => {
    if (!rail.classList.contains('pinned')) shell?.classList.add('rail-expanded');
  });

  rail?.addEventListener('mouseleave', () => {
    if (!rail.classList.contains('pinned')) shell?.classList.remove('rail-expanded');
  });

  railBtn?.addEventListener('click', () => {
    if (!rail) return;
    setRailPinnedState(!rail.classList.contains('pinned'));
  });
  setRailPinnedState(localStorage.getItem(SIDEBAR_PIN_KEY) === 'true', false);
  syncRailShellState();

  const themeBtn = document.getElementById('themeToggleBtn');
  const densityBtn = document.getElementById('densityToggleBtn');
  densityBtn?.addEventListener('click', toggleDensityMode);
  applyDensityMode(localStorage.getItem(DENSITY_MODE_KEY) || 'compact', false);

  themeBtn?.addEventListener('click', () => {
    const nextDark = !document.body.classList.contains('theme-dark');
    document.body.classList.toggle('theme-dark', nextDark);
    localStorage.setItem('convbi_theme', nextDark ? 'dark' : 'light');
    themeBtn.innerHTML = nextDark ? '&#9790;' : '&#9788;';
  });
  const storedTheme = localStorage.getItem('convbi_theme');
  if (storedTheme === 'dark') {
    document.body.classList.add('theme-dark');
    if (themeBtn) themeBtn.innerHTML = '&#9790;';
  }

  toggleQADetails(localStorage.getItem(QA_DETAILS_KEY) === 'true');

  const qaInput = document.getElementById('qaInput');
  qaInput?.addEventListener('input', () => {
    qaInput.style.height = 'auto';
    qaInput.style.height = Math.min(qaInput.scrollHeight, 132) + 'px';
  });

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

  setupScrollReveal();
})();
