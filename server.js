'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

const app = express();
const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 3001;

// ── AI Provider Manager config (Groq -> OpenAI optional) ─
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY      || '';
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY   || '';
const GROQ_API_KEY        = process.env.GROQ_API_KEY        || '';

const OPENAI_ENDPOINT      = process.env.OPENAI_ENDPOINT      || 'https://api.openai.com/v1/chat/completions';
const GROQ_ENDPOINT        = process.env.GROQ_ENDPOINT        || 'https://api.groq.com/openai/v1/chat/completions';

const ENABLE_OPENAI = String(process.env.ENABLE_OPENAI || 'true').toLowerCase() !== 'false';
const PROVIDER_ORDER = (process.env.AI_PROVIDER_ORDER || 'groq,openai')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean)
  .filter(p => ['groq', 'openai'].includes(p));

if (!OPENAI_API_KEY && !GROQ_API_KEY) {
  console.warn('[AI] No Groq/OpenAI keys found. ConvBI will use local deterministic fallback only.');
}

// ── Query result cache (LRU, 500 entries, persisted to disk) ──────────────────
const CACHE_FILE = path.join(__dirname, 'query-cache.json');
const queryCache = new Map();
try {
  if (fs.existsSync(CACHE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) queryCache.set(k, v);
  }
} catch (_) {}

function makeCacheKey(question, schemaHash, rowChecksum) {
  const q = question.toLowerCase().trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(`${q}|${schemaHash}|${rowChecksum}`).digest('hex').slice(0, 32);
}
function saveQueryCache() {
  try {
    const obj = {};
    for (const [k, v] of queryCache) obj[k] = v;
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch (_) {}
}
function putQueryCache(key, value) {
  if (queryCache.size >= 500) queryCache.delete(queryCache.keys().next().value);
  queryCache.set(key, value);
  saveQueryCache();
}

const MODEL_CANDIDATES = [process.env.OPENAI_MODEL || 'gpt-4.1-mini', process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o'];
const COMPLEX_MODEL    = process.env.OPENAI_COMPLEX_MODEL || 'gpt-4o';

const GROQ_MODEL           = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const GROQ_COMPLEX_MODEL   = process.env.GROQ_COMPLEX_MODEL || GROQ_MODEL;

// ── Connectors & engine (lazy — graceful if packages not installed yet) ───────
let cm, fileUpload, databricksConnector, s3Connector;
try {
  cm                 = require('./src/connectors/connection-manager');
  fileUpload         = require('./src/connectors/file-upload');
  databricksConnector = require('./src/connectors/databricks');
  s3Connector        = require('./src/connectors/s3');
} catch (e) {
  console.warn('Some connectors not loaded:', e.message);
}

let dataProfiler, chartSelector;
try {
  dataProfiler  = require('./src/engine/data-profiler');
  chartSelector = require('./src/engine/chart-selector');
} catch (e) {
  console.warn('Smart chart engines not loaded:', e.message);
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));
// Serve public/ first, then root for backward-compat legacy files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));

// ── Dashboard route ───────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── Register connector routes ─────────────────────────────────────────────────
if (fileUpload)          fileUpload.attachRoutes(app);
if (databricksConnector) databricksConnector.attachRoutes(app);
if (s3Connector)         s3Connector.attachRoutes(app);

// ── Helpers ───────────────────────────────────────────────────────────────────
function openaiHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` };
}

function providerHeaders(token, extra = {}) {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...extra };
}

function parseOpenAIAnswer(data) {
  if (!data) return null;
  if (typeof data === 'string') return data;
  if (data.error) return data.error.message || JSON.stringify(data.error);
  if (Array.isArray(data.choices) && data.choices[0]?.message?.content)
    return data.choices[0].message.content;
  return JSON.stringify(data);
}

function providerModel(provider, preferComplex = false, openaiModels = MODEL_CANDIDATES) {
  if (provider === 'groq') return preferComplex ? GROQ_COMPLEX_MODEL : GROQ_MODEL;
  if (provider === 'openai') return openaiModels;
  return null;
}

function groqModelCandidates(preferComplex = false) {
  const preferred = preferComplex ? GROQ_COMPLEX_MODEL : GROQ_MODEL;
  const backup = preferComplex ? GROQ_MODEL : GROQ_COMPLEX_MODEL;
  return [preferred, backup, 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile']
    .filter(Boolean)
    .filter((m, i, arr) => arr.indexOf(m) === i);
}

function providerAvailable(provider) {
  if (provider === 'groq') return !!GROQ_API_KEY;
  if (provider === 'openai') return ENABLE_OPENAI && !!OPENAI_API_KEY;
  return false;
}

async function callOpenAICompatible(endpoint, headers, payload) {
  const resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const error = data?.error?.message || data?.message || `Request failed (${resp.status})`;
    return { ok: false, error, status: resp.status };
  }
  return { ok: true, text: parseOpenAIAnswer(data), raw: data };
}

async function requestViaProviderManager({
  messages,
  max_tokens = 600,
  temperature = 0,
  top_p = 1,
  seed = 42,
  preferComplex = false,
  openaiModels = MODEL_CANDIDATES
}) {
  const payload = { messages, max_tokens, temperature, top_p, seed };
  const attempted = [];

  for (const provider of PROVIDER_ORDER) {
    if (!providerAvailable(provider)) {
      attempted.push({ provider, error: 'Provider not configured' });
      continue;
    }

    try {
      if (provider === 'groq') {
        let success = null;
        for (const model of groqModelCandidates(preferComplex)) {
          const out = await callOpenAICompatible(
            GROQ_ENDPOINT,
            providerHeaders(GROQ_API_KEY),
            { model, ...payload }
          );
          if (out.ok) {
            success = { ok: true, text: out.text, provider, model, raw: out.raw };
            break;
          }
          attempted.push({ provider, model, error: out.error, status: out.status });
        }
        if (success) return success;
        continue;
      }

      if (provider === 'openai') {
        const models = providerModel('openai', preferComplex, openaiModels) || [];
        let success = null;
        for (const model of models) {
          const out = await callOpenAICompatible(
            OPENAI_ENDPOINT,
            openaiHeaders(),
            { model, ...payload }
          );
          if (out.ok) { success = { ok: true, text: out.text, provider, model, raw: out.raw }; break; }
          attempted.push({ provider, model, error: out.error, status: out.status });
        }
        if (success) return success;
      }
    } catch (e) {
      attempted.push({ provider, error: e.message });
    }
  }

  return { ok: false, attempted };
}
function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text.trim()); } catch (_) {}
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s !== -1 && e > s) { try { return JSON.parse(text.slice(s, e+1)); } catch (__) {} }
  return null;
}
function extractSQLBlock(text) {
  if (!text) return null;
  const m = text.match(/```(?:sql)?\s*\n?([\s\S]*?)```/i);
  if (m) return m[1].trim();
  // Accept raw SQL even when model returns lowercase/select without code fences.
  return /^\s*(select|with)\b/i.test(text) ? text.trim() : null;
}

function toSafeIdent(name) {
  return String(name || '').replace(/"/g, '');
}

function pickBestTableName(allTableSchemas) {
  const names = Object.keys(allTableSchemas || {});
  if (!names.length) return null;
  if (names.length === 1) return names[0];
  const ranked = [...names].sort((a, b) => Number(allTableSchemas[b]?.rowCount || 0) - Number(allTableSchemas[a]?.rowCount || 0));
  return ranked[0];
}

function splitColumns(schema) {
  const cols = Array.isArray(schema?.columns) ? schema.columns : [];
  const numericRe = /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC|BIGINT|SMALLINT|TINYINT|HUGEINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT/i;
  const dateRe = /DATE|TIME|TIMESTAMP/i;
  const all = cols.map(c => ({ name: c?.name || '', type: String(c?.type || '') })).filter(c => c.name);
  const numeric = all.filter(c => numericRe.test(c.type)).map(c => c.name);
  const date = all.filter(c => dateRe.test(c.type) || /date|time|month|year|quarter|week/i.test(c.name)).map(c => c.name);
  const categorical = all
    .filter(c => !numeric.includes(c.name) && !date.includes(c.name))
    .map(c => c.name);
  return { all: all.map(c => c.name), numeric, date, categorical };
}

function buildDeterministicSQLFallback(question, allTableSchemas, decodedIntent) {
  const q = String(question || '').toLowerCase();
  const table = (decodedIntent?.tables_needed || []).find(t => allTableSchemas?.[t]) || pickBestTableName(allTableSchemas);
  if (!table) return null;

  const schema = allTableSchemas?.[table] || {};
  const { numeric, categorical } = splitColumns(schema);
  const metric = decodedIntent?.primary_metric || numeric[0] || null;
  const group = decodedIntent?.group_by?.[0] || categorical[0] || null;
  const safeTable = toSafeIdent(table);
  const safeMetric = metric ? toSafeIdent(metric) : null;
  const safeGroup = group ? toSafeIdent(group) : null;

  // COUNT-style questions
  if (/\bhow many\b|\bcount\b|\bnumber of\b|\brecords\b/.test(q)) {
    return `SELECT COUNT(*) AS row_count FROM "${safeTable}" ORDER BY row_count DESC`;
  }

  // AVG/MEAN questions
  if (safeMetric && /\baverage\b|\bavg\b|\bmean\b/.test(q)) {
    if (safeGroup && /\bby\b|\bper\b|\beach\b|\bgroup\b|\brank\b|\btop\b/.test(q)) {
      return `SELECT "${safeGroup}" AS category, AVG("${safeMetric}") AS avg_value FROM "${safeTable}" WHERE "${safeGroup}" IS NOT NULL GROUP BY "${safeGroup}" ORDER BY avg_value DESC`;
    }
    return `SELECT AVG("${safeMetric}") AS avg_value FROM "${safeTable}" ORDER BY avg_value DESC`;
  }

  // SUM/TOTAL questions
  if (safeMetric && /\btotal\b|\bsum\b/.test(q)) {
    if (safeGroup && /\bby\b|\bper\b|\beach\b|\bgroup\b|\brank\b|\btop\b/.test(q)) {
      return `SELECT "${safeGroup}" AS category, SUM("${safeMetric}") AS total_value FROM "${safeTable}" WHERE "${safeGroup}" IS NOT NULL GROUP BY "${safeGroup}" ORDER BY total_value DESC`;
    }
    return `SELECT SUM("${safeMetric}") AS total_value FROM "${safeTable}" ORDER BY total_value DESC`;
  }

  // MAX / highest
  if (safeMetric && /\bmax\b|\bhighest\b|\btop\b|\bbest\b/.test(q)) {
    if (safeGroup) {
      return `SELECT "${safeGroup}" AS category, MAX("${safeMetric}") AS max_value FROM "${safeTable}" WHERE "${safeGroup}" IS NOT NULL GROUP BY "${safeGroup}" ORDER BY max_value DESC LIMIT 10`;
    }
    return `SELECT MAX("${safeMetric}") AS max_value FROM "${safeTable}" ORDER BY max_value DESC`;
  }

  // MIN / lowest
  if (safeMetric && /\bmin\b|\blowest\b|\bsmallest\b|\bworst\b/.test(q)) {
    if (safeGroup) {
      return `SELECT "${safeGroup}" AS category, MIN("${safeMetric}") AS min_value FROM "${safeTable}" WHERE "${safeGroup}" IS NOT NULL GROUP BY "${safeGroup}" ORDER BY min_value ASC LIMIT 10`;
    }
    return `SELECT MIN("${safeMetric}") AS min_value FROM "${safeTable}" ORDER BY min_value ASC`;
  }

  // Generic grouped leaderboard
  if (safeMetric && safeGroup) {
    return `SELECT "${safeGroup}" AS category, AVG("${safeMetric}") AS value FROM "${safeTable}" WHERE "${safeGroup}" IS NOT NULL GROUP BY "${safeGroup}" ORDER BY value DESC LIMIT 20`;
  }

  // Last-resort deterministic query.
  return `SELECT * FROM "${safeTable}" ORDER BY 1 LIMIT 50`;
}
function isComplexQuestion(q) {
  const kw = ['trend','over time','compare','vs','versus','consistent','variable','outlier',
    'anomaly','rank all','leaderboard','percentage','proportion','improve','decline',
    'correlation','predict','forecast','future','next month','next year','next quarter',
    'chart','graph','visuali','plot','draw','bar chart','line chart','join','across',
    'between tables','relate','relationship'];
  return kw.some(k => q.toLowerCase().includes(k));
}

const LEW_SECTIONS = [
  'DIRECT_ANSWER',
  'WHAT_HAPPENED',
  'WHY_HAPPENED',
  'SUPPORTING_EVIDENCE',
  'BUSINESS_IMPACT',
  'RECOMMENDED_ACTION'
];

function parseLewSectionsText(text) {
  const parsed = {};
  const src = String(text || '');
  for (const tag of LEW_SECTIONS) {
    const re = new RegExp(`##${tag}##\\s*([\\s\\S]*?)(?=##(?:${LEW_SECTIONS.join('|')})##|$)`, 'i');
    const m = src.match(re);
    parsed[tag] = m ? m[1].trim() : '';
  }
  return parsed;
}

function hasAllLewSections(text) {
  const p = parseLewSectionsText(text);
  return LEW_SECTIONS.every(tag => !!p[tag]);
}

function renderLewSections(sections) {
  return [
    '##DIRECT_ANSWER##', sections.DIRECT_ANSWER || 'Not available.',
    '##WHAT_HAPPENED##', sections.WHAT_HAPPENED || 'Not available.',
    '##WHY_HAPPENED##', sections.WHY_HAPPENED || 'Not available.',
    '##SUPPORTING_EVIDENCE##', sections.SUPPORTING_EVIDENCE || '- Not available.',
    '##BUSINESS_IMPACT##', sections.BUSINESS_IMPACT || 'Not available.',
    '##RECOMMENDED_ACTION##', sections.RECOMMENDED_ACTION || '- Review the result with domain owners.'
  ].join('\n');
}

function makeLewFallbackNarrative(question, result) {
  const rows = Array.isArray(result) ? result : (result && typeof result === 'object' ? [result] : []);
  const count = rows.length;
  const first = rows[0] || {};
  const cols = Object.keys(first);
  const evidence = [
    `- Returned rows: ${count}`,
    cols.length ? `- Columns: ${cols.join(', ')}` : '- Columns: none',
    count ? `- First row snapshot keys: ${Object.keys(first).slice(0, 6).join(', ') || 'none'}` : '- No matching rows found'
  ].join('\n');

  return renderLewSections({
    DIRECT_ANSWER: count ? `The query completed successfully and returned ${count} row${count !== 1 ? 's' : ''}.` : 'No records matched those conditions.',
    WHAT_HAPPENED: count ? 'The requested analytical result was computed from the available dataset.' : 'No matching records were found for the requested conditions.',
    WHY_HAPPENED: count ? 'The result reflects the generated SQL filters, grouping, and aggregation logic.' : 'The selected filters or conditions were too restrictive for the current data.',
    SUPPORTING_EVIDENCE: evidence,
    BUSINESS_IMPACT: count ? 'Use this result to guide operational and KPI decisions with current evidence.' : 'Decision-making risk is higher without matching data; assumptions should be reviewed.',
    RECOMMENDED_ACTION: [
      '- Validate filters and time range.',
      '- Compare with previous period.',
      '- Monitor the related KPI weekly.'
    ].join('\n')
  });
}

function normalizeExecutiveSummary(text, sections) {
  const src = String(text || '').trim();
  const lines = src.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const getLine = prefix => lines.find(l => l.toLowerCase().startsWith(prefix.toLowerCase()));
  const kf = getLine('Key Finding:') || `Key Finding: ${sections?.directAnswer || sections?.summary || 'No direct finding available.'}`;
  const bi = getLine('Business Impact:') || `Business Impact: ${sections?.businessImpact || 'Impact could not be determined from available evidence.'}`;
  const nb = getLine('Next Best Action:') || `Next Best Action: ${sections?.recommendedAction || 'Validate assumptions, then monitor KPI trend weekly.'}`;
  return [kf, bi, nb].join('\n');
}

function normalizeChartSummary(text, fallback, chart) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const src = String(text || '').replace(/[\r\n]+/g, ' ').replace(/^["'`]+|["'`]+$/g, '').trim();
  const words = src.split(/\s+/).filter(Boolean).slice(0, 24);
  const clean = words.join(' ').replace(/[.,;:!?]+$/g, '');
  const nClean = norm(clean);
  const nTitle = norm(chart?.title || '');
  const nSub = norm(chart?.subtitle || '');
  const hasNumber = /\d/.test(clean);
  const weakPhrases = [
    'values are going up over time',
    'values are going down over time',
    'values are mostly stable over time',
    'the parts are fairly balanced',
    'there is no clear relationship here',
    'this chart shows the main data pattern'
  ];
  if (!clean) return fallback;
  if ((nTitle && (nClean === nTitle || nTitle.includes(nClean) || nClean.includes(nTitle))) ||
      (nSub && (nClean === nSub || nSub.includes(nClean) || nClean.includes(nSub)))) {
    return fallback;
  }
  if (!hasNumber || weakPhrases.some(p => nClean.includes(p))) return fallback;
  return clean;
}

const WORKFLOW_BLUEPRINT = {
  ingestion: {
    step: 1,
    name: 'Connect Business Data',
    capabilities: ['upload_csv_excel', 'connect_database', 'connect_data_warehouse', 'connect_cloud_storage']
  },
  discovery: {
    step: 2,
    name: 'Data Discovery & Understanding',
    capabilities: ['read_schema', 'detect_tables', 'detect_relationships', 'detect_data_types', 'identify_measures', 'identify_dimensions', 'build_metadata', 'create_semantic_model']
  },
  exploration: {
    step: 3,
    name: 'AI Business Data Exploration',
    capabilities: ['business_kpis', 'revenue', 'profit', 'sales', 'customer_behavior', 'product_performance', 'regional_performance', 'time_trends', 'seasonal_patterns', 'anomalies', 'risks', 'opportunities']
  },
  dashboard: {
    step: 4,
    name: 'Automatic Dashboard Generation',
    capabilities: ['executive_dashboard', 'kpi_cards', 'revenue_dashboard', 'sales_dashboard', 'profit_dashboard', 'customer_dashboard', 'product_dashboard', 'regional_dashboard', 'forecast_dashboard', 'auto_visualization_selection']
  },
  storytelling: {
    step: 5,
    name: 'AI Executive Insights & Storytelling',
    capabilities: ['executive_summary', 'key_findings', 'major_trends', 'business_risks', 'growth_opportunities', 'recommended_actions']
  },
  interaction: {
    step: 6,
    name: 'User Asks Business Question'
  },
  intent: {
    step: 7,
    name: 'Intent Understanding',
    capabilities: ['business_goal', 'kpi', 'required_data', 'filters', 'time_period', 'comparison', 'conversation_context']
  },
  analytics: {
    step: 8,
    name: 'Analytics Engine',
    capabilities: ['data_processing', 'business_calculations', 'kpi_computation', 'trend_analysis', 'correlation_analysis', 'forecasting', 'root_cause_analysis']
  },
  contextualStorytelling: {
    step: 9,
    name: 'Context-Aware Data Storytelling',
    capabilities: ['direct_answer', 'what_happened', 'why_happened', 'supporting_evidence', 'business_impact', 'recommendation']
  },
  followup: {
    step: 10,
    name: 'Conversational Follow-up'
  },
  decisionSupport: {
    step: 11,
    name: 'Decision Support',
    capabilities: ['business_actions', 'risk_mitigation', 'opportunity_identification', 'kpi_monitoring', 'strategic_recommendations']
  }
};

// ── /api/ping ─────────────────────────────────────────────────────────────────
app.get('/api/ping', (req, res) => res.json({ status: 'ok', version: 'v2' }));

// ── /api/workflow-blueprint ───────────────────────────────────────────────────
app.get('/api/workflow-blueprint', (req, res) => {
  res.json({ workflow: WORKFLOW_BLUEPRINT });
});

// ════════════════════════════════════════════════════════════════════════════════
// TABLE MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════════

// GET /api/tables — all registered tables with schemas
app.get('/api/tables', async (req, res) => {
  if (!cm) return res.json({ tables: {} });
  try {
    const tables = await cm.listTables();
    res.json({ tables });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/tables/:name — unload a table
app.delete('/api/tables/:name', async (req, res) => {
  if (!cm) return res.status(503).json({ error: 'Engine not available.' });
  try {
    await cm.removeTable(req.params.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tables/register — register a JS array directly (from browser state)
app.post('/api/tables/register', async (req, res) => {
  if (!cm) return res.status(503).json({ error: 'Engine not available.' });
  const { name, data, sourceMeta } = req.body;
  if (!name || !Array.isArray(data) || !data.length)
    return res.status(400).json({ error: 'Missing name or data array.' });
  try {
    const result = await cm.registerTable(name, data, sourceMeta || {});
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/execute-sql — run SQL against DuckDB
app.post('/api/execute-sql', async (req, res) => {
  if (!cm) return res.status(503).json({ error: 'DuckDB engine not available.' });
  const { sql } = req.body;
  if (!sql) return res.status(400).json({ error: 'Missing sql.' });

  // SQL injection guard: only allow SELECT/WITH
  const first = sql.trim().split(/\s+/)[0].toUpperCase();
  if (!['SELECT','WITH','SHOW','DESCRIBE','EXPLAIN'].includes(first))
    return res.status(400).json({ error: 'Only SELECT / WITH queries are permitted.' });

  try {
    const result = await cm.executeSQL(sql);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/detect-relationships
app.post('/api/detect-relationships', async (req, res) => {
  if (!cm) return res.json({ joins: [], noRelation: [] });
  try {
    const result = await cm.detectRelationships();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/semantic-model — metadata + semantic model for current registered tables
app.get('/api/semantic-model', async (req, res) => {
  if (!cm) return res.status(503).json({ error: 'Engine not available.' });
  try {
    const tables = await cm.listTables();
    const rel = await cm.detectRelationships();
    const model = { tables: {}, globalMeasures: [], globalDimensions: [], relationships: rel.joins || [] };
    const gm = new Set();
    const gd = new Set();

    for (const [tableName, meta] of Object.entries(tables || {})) {
      const cols = meta.columns || [];
      const measures = [];
      const dimensions = [];
      const dates = [];

      for (const c of cols) {
        const t = String(c.type || '').toUpperCase();
        if (/INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC|BIGINT|SMALLINT|TINYINT/.test(t)) {
          measures.push(c.name); gm.add(c.name);
        } else if (/DATE|TIME|TIMESTAMP/.test(t) || /date|time|month|year|quarter|week/i.test(c.name)) {
          dates.push(c.name); dimensions.push(c.name); gd.add(c.name);
        } else {
          dimensions.push(c.name); gd.add(c.name);
        }
      }

      model.tables[tableName] = {
        source: meta.source || 'file',
        rowCount: meta.rowCount || 0,
        measures,
        dimensions,
        dates,
        kpiCandidates: measures.slice(0, 6)
      };
    }

    model.globalMeasures = [...gm];
    model.globalDimensions = [...gd];
    res.json({ semanticModel: model });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/check-cache
app.post('/api/check-cache', (req, res) => {
  const { question, schemaHash, rowChecksum } = req.body;
  if (!question) return res.json({ hit: false });
  const key = makeCacheKey(question, schemaHash || '', rowChecksum || '');
  const cached = queryCache.get(key);
  if (cached) return res.json({ hit: true, cached, key });
  res.json({ hit: false, key });
});

// POST /api/save-cache
app.post('/api/save-cache', (req, res) => {
  const { key, value } = req.body;
  if (!key || !value) return res.status(400).json({ error: 'Missing key or value.' });
  putQueryCache(key, value);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// SMART CHARTS — CHANGE 3
// ════════════════════════════════════════════════════════════════════════════════

const INTERPRET_TABLE_SYSTEM = `You are a data analyst inspecting column statistics for a single database table.
Given column profiles (name, type, semanticType, distinctCount, nullPct, topValues, cv), return a JSON object:
{
  "primary_measures":   ["array of column names that are the main numeric KPIs for this table"],
  "primary_dimensions": ["array of column names best for grouping/segmentation"],
  "time_column":        "column name for the main time axis, or null",
  "entity_label":       "1 short sentence: what each row represents"
}
RULES:
- primary_measures: prefer columns with cv > 0.1, avoid id-like/constant columns.
- primary_dimensions: prefer 3-15 distinct values, avoid high-cardinality (>30) columns.
- time_column: prefer columns with semanticType='date'; null if none.
- Return ONLY valid JSON. No markdown, no extra text.`;

const KPI_RECOMMENDER_SYSTEM = `You are an expert BI analyst selecting the 5 most relevant KPI metrics across one or more tables.
You will receive compact table summaries with numeric column stats.
Return JSON only:
{
  "top_kpis": [
    { "table": "table_name", "column": "numeric_column", "why": "short reason" }
  ]
}
Rules:
- Return at most 5 KPIs.
- Choose actionable business metrics, not IDs/codes/index columns.
- Prefer columns with meaningful variation, low null impact, and stable numeric coverage.
- Prioritize business signals (sales, revenue, profit, margin, cost, amount, orders, units, rate).
- Never invent table/column names.
- Return ONLY valid JSON.`;

function scoreKpiCandidate(candidate) {
  const name = String(candidate?.column || '').toLowerCase();
  const spread = Number(candidate?.spread || 0);
  const nonZeroRatio = Number(candidate?.nonZeroRatio || 0);
  const cv = Number(candidate?.cv || 0);
  const sampleSize = Number(candidate?.sampleSize || 0);
  const nullPct = Number(candidate?.nullPct || 0);

  let score = 0;

  if (/revenue|sales|profit|margin|amount|value|gmv|arr|mrr/.test(name)) score += 30;
  if (/cost|expense|spend|price|income|orders?|units?|volume|quantity/.test(name)) score += 18;
  if (/rate|ratio|pct|percentage|conversion|churn|retention/.test(name)) score += 12;
  if (/(^|_)(id|key|code|zip|pin|index|idx)($|_)/.test(name)) score -= 25;

  score += Math.min(18, spread > 0 ? Math.log10(Math.abs(spread) + 1) * 5 : 0);
  score += Math.min(18, cv > 0 ? cv * 10 : 0);
  score += Math.min(14, nonZeroRatio * 14);
  score += Math.min(10, sampleSize >= 100 ? 10 : sampleSize * 0.1);
  score -= Math.min(14, Math.max(0, nullPct) * 14);

  return score;
}

function deterministicKpiRecommendations(candidates, limit = 5) {
  return [...candidates]
    .map(c => ({ ...c, _score: scoreKpiCandidate(c) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ table, column }) => ({ table, column, why: 'High business relevance and data quality.' }));
}

function buildKpiCandidateMap(inputTables) {
  const candidates = [];
  const byKey = new Map();

  for (const table of inputTables) {
    const tableName = String(table?.tableName || '').trim();
    if (!tableName) continue;
    const cols = Array.isArray(table?.numericColumns) ? table.numericColumns : [];
    for (const col of cols) {
      const colName = String(col?.column || '').trim();
      if (!colName) continue;
      const key = `${tableName}::${colName}`;
      const normalized = {
        table: tableName,
        column: colName,
        sampleSize: Number(col?.sampleSize || 0),
        nullPct: Number(col?.nullPct || 0),
        nonZeroRatio: Number(col?.nonZeroRatio || 0),
        spread: Number(col?.spread || 0),
        cv: Number(col?.cv || 0),
        sum: Number(col?.sum || 0),
        avg: Number(col?.avg || 0)
      };
      if (!byKey.has(key)) {
        byKey.set(key, normalized);
        candidates.push(normalized);
      }
    }
  }

  return { candidates, byKey };
}

// POST /api/recommend-kpis — AI + deterministic fallback KPI ranking
app.post('/api/recommend-kpis', async (req, res) => {
  try {
    const tables = Array.isArray(req.body?.tables) ? req.body.tables : [];
    if (!tables.length) return res.status(400).json({ error: 'Missing tables payload.' });

    const { candidates, byKey } = buildKpiCandidateMap(tables);
    if (!candidates.length) return res.json({ kpis: [], mode: 'empty' });

    const fallback = deterministicKpiRecommendations(candidates, 5);
    const compactTables = tables.map(t => ({
      tableName: t.tableName,
      rowCount: Number(t.rowCount || 0),
      numericColumns: (Array.isArray(t.numericColumns) ? t.numericColumns : []).slice(0, 24)
    }));

    const aiOut = await requestViaProviderManager({
      messages: [
        { role: 'system', content: KPI_RECOMMENDER_SYSTEM },
        { role: 'user', content: JSON.stringify({ tables: compactTables, limit: 5 }, null, 2) }
      ],
      max_tokens: 500,
      temperature: 0,
      top_p: 1,
      seed: 42
    });

    if (!aiOut.ok) {
      return res.json({ kpis: fallback, mode: 'fallback', attempted: aiOut.attempted || [] });
    }

    const parsed = extractJson(aiOut.text) || {};
    const top = Array.isArray(parsed?.top_kpis) ? parsed.top_kpis : [];
    const selected = [];
    const seen = new Set();

    for (const item of top) {
      const table = String(item?.table || '').trim();
      const column = String(item?.column || '').trim();
      if (!table || !column) continue;
      const key = `${table}::${column}`;
      if (!byKey.has(key) || seen.has(key)) continue;
      seen.add(key);
      selected.push({ table, column, why: String(item?.why || '').trim() || 'Selected by AI relevance scoring.' });
      if (selected.length >= 5) break;
    }

    if (selected.length < 5) {
      for (const f of fallback) {
        const key = `${f.table}::${f.column}`;
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push(f);
        if (selected.length >= 5) break;
      }
    }

    return res.json({ kpis: selected, mode: 'ai', provider: aiOut.provider, model: aiOut.model });
  } catch (e) {
    console.error('[/api/recommend-kpis] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/interpret-table — LLM interprets column profiles
app.post('/api/interpret-table', async (req, res) => {
  try {
    const { tableName, profile } = req.body;
    if (!tableName || !profile) return res.status(400).json({ error: 'Missing tableName or profile.' });

    const colSummary = (profile.columns || []).map(c => ({
      name: c.name, type: c.type, semanticType: c.semanticType,
      distinctCount: c.distinctCount, nullPct: +(c.nullPct||0).toFixed(3),
      cv: c.cv != null ? +c.cv.toFixed(3) : null,
      topValues: (c.topValues||[]).slice(0,3).map(v=>v.value)
    }));

    for (const model of MODEL_CANDIDATES) {
      try {
        const resp = await fetch(OPENAI_ENDPOINT, {
          method: 'POST', headers: openaiHeaders(),
          body: JSON.stringify({
            model, max_tokens: 400, temperature: 0, top_p: 1, seed: 42,
            messages: [
              { role: 'system', content: INTERPRET_TABLE_SYSTEM },
              { role: 'user',   content: `Table: "${tableName}"\nRow count: ${profile.rowCount}\nColumns:\n${JSON.stringify(colSummary, null, 2)}` }
            ]
          })
        });
        const data = await resp.json();
        if (!resp.ok) { const m = data?.error?.message||''; if (m.toLowerCase().includes('model')) continue; return res.status(resp.status).json({ error: m }); }
        const interp = extractJson(parseOpenAIAnswer(data));
        if (!interp) return res.json({ interpretation: null, error: 'Could not parse JSON' });
        return res.json({ interpretation: interp, model });
      } catch (_) {}
    }
    return res.status(500).json({ error: 'Could not interpret table.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/charts/:tableName — full pipeline: profile → interpret → score → ECharts options
app.get('/api/charts/:tableName', async (req, res) => {
  if (!cm)             return res.status(503).json({ error: 'DuckDB engine not available.' });
  if (!dataProfiler)   return res.status(503).json({ error: 'data-profiler not loaded.' });
  if (!chartSelector)  return res.status(503).json({ error: 'chart-selector not loaded.' });

  const { tableName } = req.params;
  try {
    // 1. Profile
    const profile = await dataProfiler.profileTable(tableName, sql => cm.executeSQL(sql));
    if (!profile.rowCount) return res.json({ charts: [], profile });

    // 2. Interpret (LLM)
    let interpretation = null;
    try {
      const colSummary = profile.columns.map(c => ({
        name: c.name, type: c.type, semanticType: c.semanticType,
        distinctCount: c.distinctCount, nullPct: +(c.nullPct||0).toFixed(3),
        cv: c.cv != null ? +c.cv.toFixed(3) : null,
        topValues: (c.topValues||[]).slice(0,3).map(v=>v.value)
      }));
      for (const model of MODEL_CANDIDATES) {
        try {
          const resp = await fetch(OPENAI_ENDPOINT, {
            method: 'POST', headers: openaiHeaders(),
            body: JSON.stringify({
              model, max_tokens: 400, temperature: 0, top_p: 1, seed: 42,
              messages: [
                { role: 'system', content: INTERPRET_TABLE_SYSTEM },
                { role: 'user',   content: `Table: "${tableName}"\nRow count: ${profile.rowCount}\nColumns:\n${JSON.stringify(colSummary, null, 2)}` }
              ]
            })
          });
          const data = await resp.json();
          if (!resp.ok) { if ((data?.error?.message||'').toLowerCase().includes('model')) continue; break; }
          interpretation = extractJson(parseOpenAIAnswer(data));
          if (interpretation) break;
        } catch (_) {}
      }
    } catch (_) {}

    // 3. Score and select charts
    const charts = await chartSelector.selectCharts(tableName, profile, interpretation, sql => cm.executeSQL(sql));

    res.json({ charts, profile, interpretation });
  } catch (e) {
    console.error('[/api/charts] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

function dq(name) {
  return `"${String(name || '').replace(/"/g, '""')}"`;
}

function buildChartSourceMeta({ tableName, type, xCol, yCol }) {
  const t = String(type || '').toLowerCase() === 'pie' ? 'donut' : String(type || '').toLowerCase();
  if (!tableName || !xCol || !yCol) {
    return {
      sql: '',
      jsBuilder: 'unknown-builder',
      origin: 'chart-source',
      note: 'SQL source is not available for this chart.'
    };
  }

  const qt = dq(tableName);
  const qx = dq(xCol);
  const qy = dq(yCol);

  if (t === 'bar' || t === 'donut') {
    return {
      sql:
`SELECT ${qx} AS grp, AVG(${qy}) AS avg_val
FROM ${qt}
WHERE ${qx} IS NOT NULL AND ${qy} IS NOT NULL
GROUP BY ${qx}
ORDER BY avg_val DESC`,
      jsBuilder: t === 'donut' ? '_donutOption' : '_barOption',
      origin: 'chart-source',
      note: ''
    };
  }

  if (t === 'line') {
    return {
      sql:
`SELECT CAST(${qx} AS VARCHAR) AS period, AVG(${qy}) AS avg_val
FROM ${qt}
WHERE ${qx} IS NOT NULL AND ${qy} IS NOT NULL
GROUP BY ${qx}
ORDER BY ${qx}`,
      jsBuilder: '_lineOption',
      origin: 'chart-source',
      note: ''
    };
  }

  if (t === 'scatter') {
    return {
      sql:
`SELECT ${qx} AS x, ${qy} AS y
FROM ${qt}
WHERE ${qx} IS NOT NULL AND ${qy} IS NOT NULL
LIMIT 500`,
      jsBuilder: '_scatterOption',
      origin: 'chart-source',
      note: ''
    };
  }

  return {
    sql: '',
    jsBuilder: 'unknown-builder',
    origin: 'chart-source',
    note: `No SQL template is defined for chart type "${t || 'unknown'}".`
  };
}

app.post('/api/chart-source', (req, res) => {
  try {
    const { tableName, type, xCol, yCol } = req.body || {};
    const source = buildChartSourceMeta({ tableName, type, xCol, yCol });
    res.json(source);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// LAYER 1 — INTENT DECODER
// ════════════════════════════════════════════════════════════════════════════════
const DECODE_INTENT_SYSTEM = `You are an analytical intent decoder for a multi-table BI dashboard.
Your ONLY job is to decode exactly what calculation or lookup the user wants.
Given a user question and the data schema, return a JSON object with EXACTLY these fields:
{
  "business_goal": "short phrase describing the business objective",
  "kpi": "name of KPI implied by the question, or null",
  "required_data": ["specific entities/columns needed to answer"],
  "filters": ["normalized filter conditions inferred from question/context"],
  "time_period": "explicit period inferred from question/context, or all_time",
  "comparison": "comparison pair if requested (e.g. Q1 vs Q2), else null",
  "conversation_context_used": "brief note describing how prior turns influenced interpretation",
  "intent_type": "aggregation|ranking|comparison|trend|lookup|ratio|conditional|visualization",
  "what_to_calculate": "one precise sentence describing what number/list/comparison to produce",
  "primary_metric": "exact column name from schema, or null",
  "secondary_metric": "exact column name if comparison/ratio, or null",
  "aggregation_fn": "SUM|AVG|COUNT|MAX|MIN|MEDIAN|RATIO|GROWTH_RATE|STDEV|null",
  "filter_conditions": ["array of plain-English filter descriptions"],
  "group_by": ["field names to group by, or empty array"],
  "time_scope": "all_time|specific_date|date_range|relative_period|null",
  "sort_by": "field and direction if ranking, or null",
  "limit": null,
  "tables_needed": ["list of table names required to answer this question"],
  "join_hint": "e.g. 'JOIN tableA ON tableA.machine_id = tableB.machine_id', or null if no join needed",
  "ambiguities": [],
  "needs_clarification": false,
  "clarification_prompt": null,
  "decoded_restatement": "Restate the question in unambiguous analytical terms with any assumptions you made."
}
RULES:
- CRITICAL: ALWAYS set needs_clarification=false and clarification_prompt=null. NEVER ask the user for more info. Make the best reasonable assumption and state it in decoded_restatement.
- Always fill business_goal, required_data, filters, and time_period using best-effort assumptions when the question is underspecified.
- conversation_context_used must summarize what was carried over from prior turns.
- For vague chart/visualization requests → intent_type='visualization', choose the most meaningful metric from available columns.
- 'Consistent', 'stable', 'most reliable' → aggregation_fn='STDEV'; most consistent = lowest STDEV.
- 'Unusual', 'anomaly', 'spike', 'outlier' → intent_type='conditional', what_to_calculate must mention IQR.
- For comparison questions with two periods → intent_type='comparison', filter_conditions has BOTH periods.
- For 'what percentage', 'what % of' → intent_type='ratio', aggregation_fn='RATIO'.
- If query spans multiple tables AND a join column is detectable from the relationship data, set join_hint.
- If tables have NO common column → tables_needed lists all needed tables, join_hint=null (independent analysis).
- Return ONLY valid JSON. No markdown, no text outside the JSON.`;

app.post('/api/decode-intent', async (req, res) => {
  try {
    const { question, schemaProfile, semanticRules, relationships, conversationContext } = req.body;
    if (!question) return res.status(400).json({ error: 'Missing question.' });

    const schemaCtx = schemaProfile
      ? `\n\nDATA SCHEMA:\n${typeof schemaProfile === 'string' ? schemaProfile : JSON.stringify(schemaProfile, null, 2)}`
      : '';
    const rulesCtx = semanticRules ? `\n\nBUSINESS RULES:\n${semanticRules}` : '';
    const relCtx   = relationships
      ? `\n\nDETECTED RELATIONSHIPS:\n${JSON.stringify(relationships, null, 2)}`
      : '';
    const convoCtx = Array.isArray(conversationContext) && conversationContext.length
      ? `\n\nCONVERSATION CONTEXT (recent turns):\n${JSON.stringify(conversationContext.slice(-6), null, 2)}`
      : '';

    const preferComplex = isComplexQuestion(question);
    const models = preferComplex
      ? [COMPLEX_MODEL, ...MODEL_CANDIDATES.filter(m => m !== COMPLEX_MODEL)]
      : MODEL_CANDIDATES;

    const out = await requestViaProviderManager({
      max_tokens: 800,
      temperature: 0,
      top_p: 1,
      seed: 42,
      preferComplex,
      openaiModels: models,
      messages: [
        { role: 'system', content: DECODE_INTENT_SYSTEM + schemaCtx + rulesCtx + relCtx + convoCtx },
        { role: 'user', content: `Question: ${question}` }
      ]
    });

    if (!out.ok) {
      return res.status(500).json({ error: 'Could not decode intent.', providerAttempts: out.attempted || [] });
    }

    const decoded = extractJson(out.text);
    if (!decoded) return res.json({ decoded: null, error: 'Could not parse intent JSON', provider: out.provider, model: out.model });
    return res.json({ decoded, provider: out.provider, model: out.model });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════════
// LAYER 2 — SQL CODE GENERATION (DuckDB)
// ════════════════════════════════════════════════════════════════════════════════

function buildSQLCodeGenPrompt(allTableSchemas, relationships, decodedIntent) {
  const schemaStr = JSON.stringify(allTableSchemas, null, 2);
  const relStr    = relationships ? JSON.stringify(relationships, null, 2) : '[]';
  const intentSection = decodedIntent ? `
DECODED INTENT — implement this exactly:
- WHAT TO CALCULATE: ${decodedIntent.what_to_calculate || 'N/A'}
- RESTATEMENT: ${decodedIntent.decoded_restatement || 'N/A'}
- PRIMARY METRIC: ${decodedIntent.primary_metric || 'N/A'}
- AGGREGATION: ${decodedIntent.aggregation_fn || 'N/A'}
- FILTERS: ${(decodedIntent.filter_conditions || []).join('; ') || 'none'}
- GROUP BY: ${(decodedIntent.group_by || []).join(', ') || 'none'}
- TABLES NEEDED: ${(decodedIntent.tables_needed || []).join(', ') || 'auto-detect'}
- JOIN HINT: ${decodedIntent.join_hint || 'none'}
` : '';

  return `You are a DuckDB SQL generator for an in-memory analytics database.
You have these tables available:

TABLE SCHEMAS:
${schemaStr}

DETECTED RELATIONSHIPS:
${relStr}
${intentSection}
DuckDB RULES:
1. Return ONLY a \`\`\`sql code block — no explanation, no extra text.
2. DuckDB supports: full ANSI SQL, window functions, LATERAL joins, LIST_AGG, STRUCT,
   date_trunc(), strftime(), percentile_cont(), corr(), regr_slope(), UNNEST, PIVOT.
3. Dates are stored as 'YYYY-MM-DD' strings. Use LIKE 'YYYY-MM%' for month filters.
   date_trunc('month', CAST(date_col AS DATE)) for grouping by month.
4. For multi-table questions with a known join: use JOIN / LEFT JOIN explicitly.
5. For tables with NO common column: use UNION ALL or answer from each table separately
   with a 'source_table' column identifying the origin.
6. Always alias columns clearly: SELECT AVG(efficiency) AS avg_efficiency.
7. NEVER reference table or column names not present in the schemas above.
8. IQR outlier pattern:
   WITH stats AS (SELECT percentile_cont(0.25) WITHIN GROUP (ORDER BY col) AS q1,
                         percentile_cont(0.75) WITHIN GROUP (ORDER BY col) AS q3
                  FROM "tablename"),
   outliers AS (SELECT t.* FROM "tablename" t, stats s
                WHERE t.col > s.q3 + 1.5*(s.q3-s.q1) OR t.col < s.q1 - 1.5*(s.q3-s.q1))
   SELECT * FROM outliers;
9. Standard deviation: STDDEV_POP(col) or STDDEV_SAMP(col)
10. Trend (period-over-period): use LAG() window function.
11. Linear regression forecast: regr_slope(y, x), regr_intercept(y, x) over ordered periods.
12. The final SELECT must return the answer rows — no trailing semicolons inside the block.
13. SQL INJECTION GUARD: only use table/column names from the schemas above.
14. Always include a deterministic ORDER BY clause at the end of the final SELECT to ensure consistent row ordering across identical queries.`;
}

app.post('/api/generate-code', async (req, res) => {
  try {
    const { question, schemaJson, semanticRules, decodedIntent,
            allTableSchemas, relationships, previousCode, errorMessage } = req.body;
    if (!question) return res.status(400).json({ error: 'Missing question.' });

    // Prefer allTableSchemas (v2); fall back to schemaJson (v1 compat)
    const schemas = allTableSchemas || (schemaJson ? { main: { columns: [], schemaJson } } : null);
    const sysPrompt = buildSQLCodeGenPrompt(schemas || {}, relationships || [], decodedIntent || null);

    const preferComplex = isComplexQuestion(question);
    const models = preferComplex
      ? [COMPLEX_MODEL, ...MODEL_CANDIDATES.filter(m => m !== COMPLEX_MODEL)]
      : MODEL_CANDIDATES;

    const messages = [];
    if (previousCode && errorMessage) {
      messages.push({ role: 'user', content: `Generate SQL to answer: ${question}` });
      messages.push({ role: 'assistant', content: '```sql\n' + previousCode + '\n```' });
      messages.push({ role: 'user', content: `SQL error: "${errorMessage}". Fix and return only a corrected \`\`\`sql block.` });
    } else {
      messages.push({ role: 'user', content: `Generate SQL to answer: ${question}` });
    }

    const out = await requestViaProviderManager({
      max_tokens: 1800,
      temperature: 0,
      top_p: 1,
      seed: 42,
      preferComplex,
      openaiModels: models,
      messages: [{ role: 'system', content: sysPrompt }, ...messages]
    });

    if (!out.ok) {
      const fallbackCode = buildDeterministicSQLFallback(question, schemas || {}, decodedIntent || null);
      if (fallbackCode) {
        return res.json({
          code: fallbackCode,
          model: 'fallback-local',
          provider: 'rule-engine',
          type: 'sql',
          fallbackReason: 'All providers failed'
        });
      }
      return res.status(500).json({ error: 'Could not generate SQL.', providerAttempts: out.attempted || [] });
    }

    const code = extractSQLBlock(out.text);
    if (!code) {
      const fallbackCode = buildDeterministicSQLFallback(question, schemas || {}, decodedIntent || null);
      if (fallbackCode) {
        return res.json({
          code: fallbackCode,
          model: 'fallback-local',
          provider: 'rule-engine',
          type: 'sql',
          fallbackReason: 'Provider returned non-SQL output'
        });
      }
      return res.json({ code: null, error: 'No SQL block in LLM response', raw: out.text, provider: out.provider, model: out.model });
    }
    return res.json({ code, model: out.model, provider: out.provider, type: 'sql' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════════
// LAYER 4 — NARRATION
// ════════════════════════════════════════════════════════════════════════════════
const NARRATE_SYSTEM = `You are a senior business data analyst narrating verified BI query results.
You receive the question, SQL used, decoded intent, and a sample of result rows.

CRITICAL RULES:
1. Never fabricate values. Use only provided result rows.
2. Never dump raw rows; summarize clearly for executives.
3. Keep each section concise and action-oriented.
4. In DIRECT_ANSWER, begin with the exact answer to the user's question in one sentence.
5. If no rows matched, say it clearly and provide a practical next action.
6. Treat zero as valid data, not missing data.

Return EXACTLY six sections with these markers, each on its own line:

##DIRECT_ANSWER##
1-2 sentences directly answering the question.

##WHAT_HAPPENED##
1-2 sentences describing the main observed change/pattern.

##WHY_HAPPENED##
1-2 sentences with the most likely explanation based on the result.

##SUPPORTING_EVIDENCE##
2-4 short bullet points with concrete evidence (numbers, ranking, trend points).

##BUSINESS_IMPACT##
1-2 sentences describing business impact (risk/opportunity/cost/revenue implications).

##RECOMMENDED_ACTION##
2-4 short bullet points with specific actions and monitoring suggestions.

Return plain text only. Do not include markdown code fences.`;

function buildFollowupSuggestionsFallback(question, sections, decodedIntent) {
  const q = String(question || '').toLowerCase();
  const answer = String(sections?.DIRECT_ANSWER || sections?.directAnswer || sections?.summary || '').toLowerCase();
  const suggestions = [];

  if (/total|sum|count|average|avg|max|min/.test(q)) {
    suggestions.push('Can you break this result down by the top categories?');
    suggestions.push('How does this metric compare with the previous period?');
  }
  if (/trend|forecast|next|growth|decline|increase|decrease/.test(q + ' ' + answer)) {
    suggestions.push('What is the projected value for the next 3 periods?');
    suggestions.push('Which factors are most associated with this trend?');
  }
  if (/region|country|state|city|zone/.test(q + ' ' + answer)) {
    suggestions.push('Which region contributes most to this result and why?');
  }
  if (/product|segment|customer|channel/.test(q + ' ' + answer)) {
    suggestions.push('Which product or customer segment drives the biggest impact?');
  }
  if (decodedIntent?.time_period && decodedIntent.time_period !== 'all_time') {
    suggestions.push('Show the same analysis for the immediately previous time period.');
  }

  suggestions.push('What is the most important business action from this result?');
  suggestions.push('Show the top 5 contributors behind this answer.');

  return Array.from(new Set(suggestions.map(s => String(s).trim()).filter(Boolean))).slice(0, 6);
}

app.post('/api/interpret', async (req, res) => {
  try {
    const { question, decodedIntent, executedCode, result, sql } = req.body;
    if (!question || result === undefined) return res.status(400).json({ error: 'Missing question or result.' });

    const intentCtx = decodedIntent
      ? `\nDECODED INTENT: ${decodedIntent.what_to_calculate || ''} | Aggregation: ${decodedIntent.aggregation_fn || ''} | Filters: ${(decodedIntent.filter_conditions||[]).join('; ')||'none'}`
      : '';
    const sqlCtx = (sql || executedCode) ? `\nSQL USED:\n${sql || executedCode}` : '';

    let out = await requestViaProviderManager({
      max_tokens: 700,
      temperature: 0.2,
      top_p: 0.9,
      seed: 42,
      preferComplex: false,
      openaiModels: MODEL_CANDIDATES,
      messages: [
        { role: 'system', content: NARRATE_SYSTEM },
        { role: 'user', content: `QUESTION: ${question}${intentCtx}${sqlCtx}\n\nRESULT: ${JSON.stringify(result)}` }
      ]
    });

    let answer = out.ok ? String(out.text || '') : '';

    if (out.ok && !hasAllLewSections(answer)) {
      const repair = await requestViaProviderManager({
        max_tokens: 700,
        temperature: 0,
        top_p: 1,
        seed: 42,
        preferComplex: false,
        openaiModels: MODEL_CANDIDATES,
        messages: [
          {
            role: 'system',
            content: `Rewrite content into EXACTLY these six markers with non-empty content:\n${LEW_SECTIONS.map(s => `##${s}##`).join('\n')}\nReturn plain text only.`
          },
          {
            role: 'user',
            content: `Question: ${question}${intentCtx}${sqlCtx}\n\nResult: ${JSON.stringify(result)}\n\nDraft:\n${answer}`
          }
        ]
      });
      if (repair.ok && hasAllLewSections(repair.text || '')) answer = String(repair.text || '');
    }

    if (!hasAllLewSections(answer)) {
      answer = makeLewFallbackNarrative(question, result);
      return res.json({ answer, model: 'fallback-local', provider: out.ok ? out.provider : 'rule-engine' });
    }

    answer = renderLewSections(parseLewSectionsText(answer));
    return res.json({ answer, model: out.model, provider: out.provider });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/followup-suggestions', async (req, res) => {
  try {
    const { question, sections, decodedIntent, rowsPreview } = req.body || {};
    if (!question) return res.status(400).json({ error: 'Missing question.' });

    const fallbackSuggestions = buildFollowupSuggestionsFallback(question, sections || {}, decodedIntent || {});

    const system = [
      'You are a BI copilot generating follow-up questions for the next user turn.',
      'Use the original question and answer context.',
      'Return ONLY valid JSON with this shape: {"suggestions":["...","..."]}.',
      'Generate 4 to 6 concise follow-up questions.',
      'Each suggestion must be answerable from business data and deepen analysis.',
      'Do not repeat the original question.'
    ].join(' ');

    const user = [
      `Original Question: ${question}`,
      `Answer Sections: ${JSON.stringify(sections || {}, null, 2)}`,
      `Decoded Intent: ${JSON.stringify(decodedIntent || {}, null, 2)}`,
      `Rows Preview: ${JSON.stringify((rowsPreview || []).slice(0, 20), null, 2)}`
    ].join('\n\n');

    const out = await requestViaProviderManager({
      max_tokens: 260,
      temperature: 0.2,
      top_p: 0.9,
      seed: 42,
      preferComplex: false,
      openaiModels: MODEL_CANDIDATES,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    });

    if (out.ok) {
      const parsed = extractJson(out.text || '');
      const suggestions = Array.isArray(parsed?.suggestions)
        ? parsed.suggestions.map(s => String(s || '').trim()).filter(Boolean)
        : [];
      if (suggestions.length) {
        return res.json({
          suggestions: Array.from(new Set(suggestions)).slice(0, 6),
          provider: out.provider,
          model: out.model
        });
      }
    }

    return res.json({ suggestions: fallbackSuggestions, model: out.ok ? out.model : 'fallback-local' });
  } catch (e) {
    const fallbackSuggestions = buildFollowupSuggestionsFallback(req.body?.question || '', req.body?.sections || {}, req.body?.decodedIntent || {});
    return res.json({ suggestions: fallbackSuggestions, model: 'fallback-local' });
  }
});

// /api/generate-executive-summary — concise executive summary from recent answers
app.post('/api/generate-executive-summary', async (req, res) => {
  try {
    const { question, sections, sql, rowsPreview } = req.body;
    if (!question || !sections) return res.status(400).json({ error: 'Missing question or sections.' });

    const system = 'You are an executive BI writer. Produce a concise, decision-ready summary in plain text with exactly three parts: Key Finding, Business Impact, Next Best Action. Keep under 140 words.';
    const user = `Question: ${question}\nSections: ${JSON.stringify(sections, null, 2)}\nSQL: ${sql || ''}\nRows Preview: ${JSON.stringify(rowsPreview || [], null, 2)}`;

    const out = await requestViaProviderManager({
      max_tokens: 260,
      temperature: 0.2,
      top_p: 0.9,
      seed: 42,
      preferComplex: false,
      openaiModels: MODEL_CANDIDATES,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    });
    if (out.ok) {
      const summary = normalizeExecutiveSummary(out.text, sections);
      if (summary) return res.json({ summary, provider: out.provider, model: out.model });
    }

    const fallback = normalizeExecutiveSummary([
      'Key Finding: ' + (sections.directAnswer || sections.summary || 'No direct finding available.'),
      'Business Impact: ' + (sections.businessImpact || sections.insight || 'Impact could not be determined.'),
      'Next Best Action: ' + (sections.recommendedAction || 'Validate assumptions, then monitor KPI trend weekly.')
    ].join('\n'), sections);
    res.json({ summary: fallback, model: 'fallback-local' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// /api/export-report — return a markdown business report for download
app.post('/api/export-report', (req, res) => {
  try {
    const { question, sections, sql, tablesUsed, generatedAt } = req.body;
    if (!question || !sections) return res.status(400).json({ error: 'Missing question or sections.' });

    const ts = generatedAt || new Date().toISOString();
    const report = [
      '# ConvBI Business Report',
      '',
      `Generated: ${ts}`,
      `Question: ${question}`,
      `Tables: ${(tablesUsed || []).join(', ') || 'N/A'}`,
      '',
      '## 1) Direct Answer',
      sections.directAnswer || sections.summary || 'N/A',
      '',
      '## 2) What Happened',
      sections.whatHappened || 'N/A',
      '',
      '## 3) Why It Happened',
      sections.whyHappened || 'N/A',
      '',
      '## 4) Supporting Evidence',
      sections.supportingEvidence || 'N/A',
      '',
      '## 5) Business Impact',
      sections.businessImpact || 'N/A',
      '',
      '## 6) Recommended Action',
      sections.recommendedAction || 'N/A',
      '',
      '## SQL Used',
      '```sql',
      sql || '-- Not available',
      '```',
      ''
    ].join('\n');

    res.json({ fileName: `convbi_report_${Date.now()}.md`, content: report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// DATA STORY (Dashboard narrative)
// ════════════════════════════════════════════════════════════════════════════════
function buildFallbackStory(tableSchemas, sampleData) {
  const tables = Object.entries(tableSchemas || {});
  const tableCount = tables.length;
  const totalRows = tables.reduce((sum, [, t]) => sum + Number(t?.rowCount || 0), 0);

  const numericTypeRe = /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC|BIGINT|SMALLINT|TINYINT|HUGEINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT/i;
  const dateTypeRe = /DATE|TIME|TIMESTAMP/i;

  let numericCols = 0;
  let dateCols = 0;
  let categoricalCols = 0;
  const sourceSet = new Set();

  for (const [, meta] of tables) {
    sourceSet.add((meta?.source || 'file').toLowerCase());
    for (const col of (meta?.columns || [])) {
      const type = String(col?.type || '');
      const name = String(col?.name || '');
      if (numericTypeRe.test(type)) numericCols++;
      else if (dateTypeRe.test(type) || /date|time|month|year|quarter|week/i.test(name)) dateCols++;
      else categoricalCols++;
    }
  }

  const sourceSummary = sourceSet.size > 1 ? 'multiple connected sources' : (sourceSet.values().next().value || 'file source');
  const rowsText = totalRows.toLocaleString();

  const headline = tableCount
    ? `Data loaded: ${tableCount} table${tableCount > 1 ? 's' : ''}, ${rowsText} rows ready for analysis.`
    : 'No tables are loaded yet for story generation.';

  const narrative = [
    tableCount
      ? `The dashboard is operating on ${tableCount} table${tableCount > 1 ? 's' : ''} from ${sourceSummary}, with ${rowsText} total records. The detected model currently includes ${numericCols} numeric field${numericCols !== 1 ? 's' : ''}, ${categoricalCols} categorical field${categoricalCols !== 1 ? 's' : ''}, and ${dateCols} time-related field${dateCols !== 1 ? 's' : ''}.`
      : 'Load one or more datasets to generate an executive data story and automated findings.',
    tableCount
      ? 'Story generation switched to local fallback mode because the external LLM endpoint is unavailable or rate-limited. Core charting, SQL analytics, and dashboard rendering remain available.'
      : 'Once data is loaded, the dashboard will automatically create KPI cards, chart candidates, and a narrative summary.'
  ].join('\n\n');

  const alerts = [];
  if (!tableCount) {
    alerts.push({
      severity: 'WARNING',
      finding: 'No data tables are currently loaded.',
      action: 'Upload a CSV/Excel/Parquet/JSON file or connect Databricks/S3 before refreshing the dashboard.'
    });
  }
  if (tableCount && !dateCols) {
    alerts.push({
      severity: 'INFO',
      finding: 'No explicit date/time fields detected in the loaded schema.',
      action: 'Add or map a date column to improve trend and forecast analysis quality.'
    });
  }
  if (tableCount && totalRows < 100) {
    alerts.push({
      severity: 'WARNING',
      finding: `Dataset volume is low (${rowsText} rows), so patterns may be unstable.`,
      action: 'Consider loading a longer time horizon or additional records before taking strategic action.'
    });
  }
  if (tableCount && alerts.length < 3) {
    alerts.push({
      severity: 'INFO',
      finding: 'Fallback narrative mode is active due to LLM unavailability.',
      action: 'Re-enable an LLM provider to restore richer AI-written storytelling.'
    });
  }

  return { headline, narrative, alerts: alerts.slice(0, 3) };
}

app.post('/api/generate-story', async (req, res) => {
  try {
    const { tableSchemas, sampleData } = req.body;
    if (!tableSchemas) return res.status(400).json({ error: 'Missing tableSchemas.' });

    const prompt = `You are a senior data analyst. Analyze these table schemas and sample data and write a data story.
Return ONLY valid JSON with this structure:
{
  "headline": "One bold sentence about the most important finding (≤15 words)",
  "narrative": "2-3 paragraphs explaining what the data shows, key trends, notable outliers, and business implications. Write for a business executive.",
  "alerts": [
    { "severity": "CRITICAL|WARNING|INFO", "finding": "specific finding", "action": "recommended action" }
  ]
}
Maximum 3 alerts. Return only JSON.

TABLE SCHEMAS:
${JSON.stringify(tableSchemas, null, 2)}

SAMPLE DATA (first 5 rows per table):
${JSON.stringify(sampleData || {}, null, 2)}`;

    const out = await requestViaProviderManager({
      max_tokens: 900,
      temperature: 0.3,
      top_p: 0.9,
      seed: 42,
      preferComplex: true,
      openaiModels: [COMPLEX_MODEL, ...MODEL_CANDIDATES],
      messages: [{ role: 'user', content: prompt }]
    });

    if (out.ok) {
      const story = extractJson(out.text);
      if (story) return res.json({ ...story, provider: out.provider, model: out.model });
    }

    const fallbackStory = buildFallbackStory(tableSchemas, sampleData || {});
    return res.json({
      ...fallbackStory,
      model: 'fallback-local',
      fallbackReason: out.ok ? 'Provider returned non-JSON payload' : ((out.attempted || []).map(a => `${a.provider}:${a.error}`).join(' | ') || 'LLM unavailable')
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// /api/chart-summary — very short AI summary for a single chart card
app.post('/api/chart-summary', async (req, res) => {
  try {
    const { chart, preview } = req.body || {};
    if (!chart) return res.status(400).json({ error: 'Missing chart metadata.' });

    const fallback = [
      chart.yCol ? String(chart.yCol).replace(/_/g, ' ') : '',
      chart.xCol ? `by ${String(chart.xCol).replace(/_/g, ' ')}` : ''
    ].join(' ').trim() || 'Notable pattern detected';

    const system = [
      'You summarize one BI chart using the provided chart data.',
      'Return exactly one plain-text sentence, 12 to 24 words.',
      'No markdown, no bullets, no quotes, no label prefix.',
      'Use simple business language that is easy to understand.',
      'MUST include at least one numeric evidence point from preview data (for example %, start/end value, share, or r value).',
      'Mention the relevant category or time labels when available.',
      'Avoid repeating the chart title.'
    ].join(' ');

    const user = `Chart metadata: ${JSON.stringify(chart || {})}\nPreview points: ${JSON.stringify(preview || {})}`;

    const out = await requestViaProviderManager({
      max_tokens: 40,
      temperature: 0.2,
      top_p: 0.9,
      seed: 42,
      preferComplex: false,
      openaiModels: MODEL_CANDIDATES,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    });

    if (out.ok) {
      const summary = normalizeChartSummary(out.text, fallback, chart);
      if (summary) return res.json({ summary, provider: out.provider, model: out.model });
    }

    return res.json({ summary: normalizeChartSummary('', fallback, chart), model: 'fallback-local' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// FALLBACK & LEGACY ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════════

// /api/ask — qualitative fallback (no data required)
app.post('/api/ask', async (req, res) => {
  try {
    const { question, summary } = req.body;
    if (!question || !summary) return res.status(400).json({ error: 'Missing question or summary.' });
    const out = await requestViaProviderManager({
      max_tokens: 1000,
      temperature: 0.2,
      top_p: 0.9,
      seed: 42,
      preferComplex: isComplexQuestion(question),
      openaiModels: MODEL_CANDIDATES,
      messages: [
        { role: 'system', content: 'You are a sharp data analytics assistant. Answer concisely using the provided data. Lead with the key insight. Use numbers and percentages. Keep under 180 words. Plain text only.' },
        { role: 'user', content: `Data summary:\n${summary}\n\nQuestion: ${question}` }
      ]
    });
    if (out.ok) return res.json({ answer: out.text, provider: out.provider, model: out.model });
    return res.status(500).json({ error: 'No model available.', providerAttempts: out.attempted || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// /api/summarize-dataset — executive summary for dashboard
app.post('/api/summarize-dataset', async (req, res) => {
  try {
    const { schemaProfile, stats, datasetName } = req.body;
    if (!schemaProfile) return res.status(400).json({ error: 'Missing schemaProfile.' });
    const statsCtx = stats ? `\n\nKEY STATISTICS:\n${JSON.stringify(stats, null, 2)}` : '';
    const out = await requestViaProviderManager({
      max_tokens: 220,
      temperature: 0.2,
      top_p: 0.9,
      seed: 42,
      preferComplex: false,
      openaiModels: MODEL_CANDIDATES,
      messages: [
        { role: 'system', content: 'You are a senior data analyst writing an executive summary for a BI dashboard. Write exactly 2-3 sentences describing the dataset\'s overall health, key metric trends, and notable patterns. Be specific with numbers. Plain text only, no markdown.' },
        { role: 'user', content: `Dataset: "${datasetName || 'Dataset'}"\n\nSCHEMA:\n${typeof schemaProfile === 'string' ? schemaProfile : JSON.stringify(schemaProfile, null, 2)}${statsCtx}\n\nWrite the executive summary now.` }
      ]
    });
    if (out.ok && out.text) return res.json({ summary: out.text, provider: out.provider, model: out.model });
    return res.status(500).json({ error: 'Could not generate summary.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// /api/schema-relationships — heuristic FK detection (legacy support)
function generateRelationshipDictionary(tableSchemas) {
  if (!tableSchemas || Object.keys(tableSchemas).length < 2) return [];
  const tables = Object.entries(tableSchemas), relationships = [], seen = new Set();
  for (let i = 0; i < tables.length; i++) {
    const [nameA, schemaA] = tables[i];
    const colsA = (schemaA.columns || []).map(c => (c.name || c).toLowerCase());
    for (let j = i + 1; j < tables.length; j++) {
      const [nameB, schemaB] = tables[j];
      const colsB = (schemaB.columns || []).map(c => (c.name || c).toLowerCase());
      for (const colA of colsA) {
        if (colsB.includes(colA)) {
          const key = `${nameA}.${colA}=${nameB}.${colA}`;
          if (!seen.has(key)) {
            seen.add(key);
            relationships.push({ table_a: nameA, key_a: colA, table_b: nameB, key_b: colA, confidence: 'high',
              join_expr: `Table '${nameA}' joins Table '${nameB}' on ${nameA}.${colA} = ${nameB}.${colA}` });
          }
        }
      }
    }
  }
  return relationships;
}
app.post('/api/schema-relationships', (req, res) => {
  try {
    const { tableSchemas } = req.body;
    if (!tableSchemas) return res.status(400).json({ error: 'Missing tableSchemas.' });
    res.json({ relationships: generateRelationshipDictionary(tableSchemas) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// /api/generate-code-validated — server-side SQL validation loop
app.post('/api/generate-code-validated', async (req, res) => {
  try {
    const { question, allTableSchemas, relationships, decodedIntent, maxRetries = 3 } = req.body;
    if (!question) return res.status(400).json({ error: 'Missing question.' });

    const sysPrompt = buildSQLCodeGenPrompt(allTableSchemas || {}, relationships || [], decodedIntent || null);
    const models    = isComplexQuestion(question)
      ? [COMPLEX_MODEL, ...MODEL_CANDIDATES.filter(m => m !== COMPLEX_MODEL)]
      : MODEL_CANDIDATES;

    const attempts = [];
    let finalCode  = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const model    = models[Math.min(attempt, models.length - 1)];
      const messages = [];
      if (attempt === 0) {
        messages.push({ role: 'user', content: `Generate SQL to answer: ${question}` });
      } else {
        const prev = attempts[attempt - 1];
        messages.push({ role: 'user',      content: `Generate SQL to answer: ${question}` });
        messages.push({ role: 'assistant', content: '```sql\n' + (prev.code || '') + '\n```' });
        messages.push({ role: 'user',      content: `SQL error: "${prev.error}". Fix and return only a corrected \`\`\`sql block.` });
      }

      try {
        const resp = await fetch(OPENAI_ENDPOINT, {
          method: 'POST', headers: openaiHeaders(),
          body: JSON.stringify({ model, max_tokens: 1800, temperature: 0,
            messages: [{ role: 'system', content: sysPrompt }, ...messages] })
        });
        const data = await resp.json();
        if (!resp.ok) { attempts.push({ code: null, error: 'LLM error', model }); continue; }
        const raw  = parseOpenAIAnswer(data);
        const code = extractSQLBlock(raw);
        if (!code) { attempts.push({ code: null, error: 'No SQL in response', model }); continue; }

        // Validate by dry-running against DuckDB if available
        if (cm) {
          const test = await cm.executeSQL(`EXPLAIN ${code}`).catch(() => null);
          if (test && test.error) {
            attempts.push({ code, error: test.error, model }); continue;
          }
        }
        finalCode = code;
        attempts.push({ code, error: null, model });
        break;
      } catch (_) {
        attempts.push({ code: null, error: 'LLM call failed', model });
      }
    }

    if (finalCode) return res.json({ code: finalCode, attempts: attempts.length, model: attempts.at(-1)?.model, type: 'sql' });
    const last = attempts.at(-1);
    if (last?.code) return res.json({ code: last.code, attempts: attempts.length, validationFailed: true, lastError: last.error, type: 'sql' });
    return res.status(500).json({ error: `Could not generate valid SQL after ${maxRetries} attempts.`, attempts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Legacy Databricks endpoints (kept for backward compat) ────────────────────
let DATABRICKS_CONFIG = null;
if (process.env.DATABRICKS_HOST) {
  DATABRICKS_CONFIG = {
    hostname:  process.env.DATABRICKS_HOST.trim(),
    http_path: (process.env.DATABRICKS_HTTP_PATH || '').trim(),
    token:     (process.env.DATABRICKS_TOKEN || '').trim()
  };
}

async function legacyDatabricksSQL(sql) {
  if (!DATABRICKS_CONFIG) throw new Error('Databricks not configured.');
  const { hostname, token, http_path } = DATABRICKS_CONFIG;
  const m = (http_path||'').match(/\/warehouses\/([a-f0-9]+)/);
  if (!m) throw new Error('Could not parse warehouse_id from http_path.');
  const resp = await fetch(`https://${hostname}/api/2.0/sql/statements`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ warehouse_id: m[1], statement: sql, wait_timeout: '30s', format: 'JSON_ARRAY', disposition: 'INLINE' })
  });
  const result = await resp.json();
  if (!resp.ok || result.status?.state === 'FAILED') throw new Error(result.status?.error?.message || result.message || JSON.stringify(result).slice(0,200));
  const columns = result.manifest?.schema?.columns || [];
  const rows = (result.result?.data_array || []).map(row => { const obj = {}; columns.forEach((col,i) => { obj[col.name] = row[i]; }); return obj; });
  return { columns: columns.map(c => ({ name: c.name, type: c.type_text || 'STRING' })), rows };
}

app.get('/api/databricks/status', async (req, res) => {
  if (!DATABRICKS_CONFIG) return res.json({ connected: false, error: 'databricks_config not found.' });
  try { await legacyDatabricksSQL('SELECT 1 AS ping'); res.json({ connected: true, hostname: DATABRICKS_CONFIG.hostname }); }
  catch (e) { res.json({ connected: false, error: e.message }); }
});
app.get('/api/databricks/catalogs', async (req, res) => {
  try { const r = await legacyDatabricksSQL('SHOW CATALOGS'); res.json({ catalogs: r.rows.map(row => row.catalog || Object.values(row)[0]).filter(Boolean) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/databricks/schemas', async (req, res) => {
  const { catalog } = req.body;
  if (!catalog) return res.status(400).json({ error: 'Missing catalog.' });
  try { const r = await legacyDatabricksSQL(`SHOW SCHEMAS IN \`${catalog}\``); res.json({ schemas: r.rows.map(row => row.databaseName||row.namespace||Object.values(row)[0]).filter(Boolean) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/databricks/tables', async (req, res) => {
  const { catalog, schema } = req.body;
  if (!catalog || !schema) return res.status(400).json({ error: 'Missing catalog or schema.' });
  try { const r = await legacyDatabricksSQL(`SHOW TABLES IN \`${catalog}\`.\`${schema}\``); res.json({ tables: r.rows.map(row => ({ name: row.tableName||Object.values(row)[0], isTemporary: row.isTemporary==='true'||row.isTemporary===true })).filter(t=>t.name) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/databricks/columns', async (req, res) => {
  const { catalog, schema, table } = req.body;
  if (!catalog||!schema||!table) return res.status(400).json({ error: 'Missing params.' });
  try { const r = await legacyDatabricksSQL(`DESCRIBE TABLE \`${catalog}\`.\`${schema}\`.\`${table}\``); res.json({ columns: r.rows.filter(row=>row.col_name&&!row.col_name.startsWith('#')) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/databricks/preview', async (req, res) => {
  const { catalog, schema, table } = req.body;
  if (!catalog||!schema||!table) return res.status(400).json({ error: 'Missing params.' });
  try { res.json(await legacyDatabricksSQL(`SELECT * FROM \`${catalog}\`.\`${schema}\`.\`${table}\` LIMIT 20`)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/databricks/load-table', async (req, res) => {
  const { catalog, schema, table, limit = 50000 } = req.body;
  if (!catalog||!schema||!table) return res.status(400).json({ error: 'Missing params.' });
  const safeLimit = Math.min(parseInt(limit,10)||50000, 200000);
  try {
    const r = await legacyDatabricksSQL(`SELECT * FROM \`${catalog}\`.\`${schema}\`.\`${table}\` LIMIT ${safeLimit}`);
    // Also register into DuckDB if engine available
    if (cm && r.rows.length) {
      const tname = table.replace(/[^a-zA-Z0-9_]/g,'_');
      await cm.registerTable(tname, r.rows, { source: 'databricks', sourceLabel: `${catalog}.${schema}.${table}` }).catch(()=>{});
    }
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/databricks/sql', async (req, res) => {
  const { sql } = req.body;
  if (!sql) return res.status(400).json({ error: 'Missing sql.' });
  const stmt = sql.trim().toUpperCase();
  if (/^(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/.test(stmt))
    return res.status(400).json({ error: 'Only SELECT / SHOW / DESCRIBE statements are allowed.' });
  try { res.json(await legacyDatabricksSQL(sql)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start server ──────────────────────────────────────────────────────────────
function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`\n  ConvBI v2 running at http://127.0.0.1:${port}`);
    console.log(`  Dashboard     → http://127.0.0.1:${port}/dashboard`);
    console.log(`  API ping      → http://127.0.0.1:${port}/api/ping\n`);
  });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') { console.warn(`Port ${port} busy, trying ${port+1}...`); startServer(port+1); }
    else { console.error(err); process.exit(1); }
  });
}
startServer(DEFAULT_PORT);
