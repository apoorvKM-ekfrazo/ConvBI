'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

const app = express();
const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 3001;

// ── API keys (loaded from .env) ───────────────────────────────────────────────
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY is not set. Add it to your .env file.');
  process.exit(1);
}

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

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
function parseOpenAIAnswer(data) {
  if (!data) return null;
  if (typeof data === 'string') return data;
  if (data.error) return data.error.message || JSON.stringify(data.error);
  if (Array.isArray(data.choices) && data.choices[0]?.message?.content)
    return data.choices[0].message.content;
  return JSON.stringify(data);
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
  return m ? m[1].trim() : (text.includes('SELECT') || text.includes('WITH') ? text.trim() : null);
}
function isComplexQuestion(q) {
  const kw = ['trend','over time','compare','vs','versus','consistent','variable','outlier',
    'anomaly','rank all','leaderboard','percentage','proportion','improve','decline',
    'correlation','predict','forecast','future','next month','next year','next quarter',
    'chart','graph','visuali','plot','draw','bar chart','line chart','join','across',
    'between tables','relate','relationship'];
  return kw.some(k => q.toLowerCase().includes(k));
}

// ── /api/ping ─────────────────────────────────────────────────────────────────
app.get('/api/ping', (req, res) => res.json({ status: 'ok', version: 'v2' }));

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

// ════════════════════════════════════════════════════════════════════════════════
// LAYER 1 — INTENT DECODER
// ════════════════════════════════════════════════════════════════════════════════
const DECODE_INTENT_SYSTEM = `You are an analytical intent decoder for a multi-table BI dashboard.
Your ONLY job is to decode exactly what calculation or lookup the user wants.
Given a user question and the data schema, return a JSON object with EXACTLY these fields:
{
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

    const models = isComplexQuestion(question)
      ? [COMPLEX_MODEL, ...MODEL_CANDIDATES.filter(m => m !== COMPLEX_MODEL)]
      : MODEL_CANDIDATES;

    for (const model of models) {
      try {
        const resp = await fetch(OPENAI_ENDPOINT, {
          method: 'POST', headers: openaiHeaders(),
          body: JSON.stringify({
            model, max_tokens: 800, temperature: 0, top_p: 1, seed: 42,
            messages: [
              { role: 'system', content: DECODE_INTENT_SYSTEM + schemaCtx + rulesCtx + relCtx + convoCtx },
              { role: 'user',   content: `Question: ${question}` }
            ]
          })
        });
        const data = await resp.json();
        if (!resp.ok) { const m = data?.error?.message || ''; if (m.toLowerCase().includes('model')) continue; return res.status(resp.status).json({ error: m }); }
        if (data.system_fingerprint) console.log('[LLM] system_fingerprint:', data.system_fingerprint, 'model:', model);
        const decoded = extractJson(parseOpenAIAnswer(data));
        if (!decoded) return res.json({ decoded: null, error: 'Could not parse intent JSON' });
        return res.json({ decoded, model });
      } catch (_) {}
    }
    return res.status(500).json({ error: 'Could not decode intent.' });
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

    const models = isComplexQuestion(question)
      ? [COMPLEX_MODEL, ...MODEL_CANDIDATES.filter(m => m !== COMPLEX_MODEL)]
      : MODEL_CANDIDATES;

    for (const model of models) {
      try {
        const messages = [];
        if (previousCode && errorMessage) {
          messages.push({ role: 'user',      content: `Generate SQL to answer: ${question}` });
          messages.push({ role: 'assistant', content: '```sql\n' + previousCode + '\n```' });
          messages.push({ role: 'user',      content: `SQL error: "${errorMessage}". Fix and return only a corrected \`\`\`sql block.` });
        } else {
          messages.push({ role: 'user', content: `Generate SQL to answer: ${question}` });
        }

        const resp = await fetch(OPENAI_ENDPOINT, {
          method: 'POST', headers: openaiHeaders(),
          body: JSON.stringify({ model, max_tokens: 1800, temperature: 0, top_p: 1, seed: 42,
            messages: [{ role: 'system', content: sysPrompt }, ...messages] })
        });
        const data = await resp.json();
        if (!resp.ok) { const m = data?.error?.message || ''; if (m.toLowerCase().includes('model')) continue; return res.status(resp.status).json({ error: m }); }
        if (data.system_fingerprint) console.log('[LLM] system_fingerprint:', data.system_fingerprint, 'model:', model);
        const raw  = parseOpenAIAnswer(data);
        const code = extractSQLBlock(raw);
        if (!code) return res.json({ code: null, error: 'No SQL block in LLM response', raw });
        return res.json({ code, model, type: 'sql' });
      } catch (_) {}
    }
    return res.status(500).json({ error: 'Could not generate SQL.' });
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
4. If no rows matched, say it clearly and provide a practical next action.
5. Treat zero as valid data, not missing data.

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

app.post('/api/interpret', async (req, res) => {
  try {
    const { question, decodedIntent, executedCode, result, sql } = req.body;
    if (!question || result === undefined) return res.status(400).json({ error: 'Missing question or result.' });

    const intentCtx = decodedIntent
      ? `\nDECODED INTENT: ${decodedIntent.what_to_calculate || ''} | Aggregation: ${decodedIntent.aggregation_fn || ''} | Filters: ${(decodedIntent.filter_conditions||[]).join('; ')||'none'}`
      : '';
    const sqlCtx = (sql || executedCode) ? `\nSQL USED:\n${sql || executedCode}` : '';

    for (const model of MODEL_CANDIDATES) {
      try {
        const resp = await fetch(OPENAI_ENDPOINT, {
          method: 'POST', headers: openaiHeaders(),
          body: JSON.stringify({
            model, max_tokens: 700, temperature: 0.2, top_p: 0.9, seed: 42,
            messages: [
              { role: 'system', content: NARRATE_SYSTEM },
              { role: 'user',   content: `QUESTION: ${question}${intentCtx}${sqlCtx}\n\nRESULT: ${JSON.stringify(result)}` }
            ]
          })
        });
        const data = await resp.json();
        if (!resp.ok) { const m = data?.error?.message || ''; if (m.toLowerCase().includes('model')) continue; return res.status(resp.status).json({ error: m }); }
        const answer = parseOpenAIAnswer(data);
        return res.json({ answer, model });
      } catch (_) {}
    }
    return res.json({ answer: typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// /api/generate-executive-summary — concise executive summary from recent answers
app.post('/api/generate-executive-summary', async (req, res) => {
  try {
    const { question, sections, sql, rowsPreview } = req.body;
    if (!question || !sections) return res.status(400).json({ error: 'Missing question or sections.' });

    const system = 'You are an executive BI writer. Produce a concise, decision-ready summary in plain text with exactly three parts: Key Finding, Business Impact, Next Best Action. Keep under 140 words.';
    const user = `Question: ${question}\nSections: ${JSON.stringify(sections, null, 2)}\nSQL: ${sql || ''}\nRows Preview: ${JSON.stringify(rowsPreview || [], null, 2)}`;

    for (const model of MODEL_CANDIDATES) {
      try {
        const resp = await fetch(OPENAI_ENDPOINT, {
          method: 'POST', headers: openaiHeaders(),
          body: JSON.stringify({
            model, max_tokens: 260, temperature: 0.2, top_p: 0.9, seed: 42,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user }
            ]
          })
        });
        const data = await resp.json();
        if (!resp.ok) continue;
        const summary = parseOpenAIAnswer(data);
        if (summary) return res.json({ summary, model });
      } catch (_) {}
    }

    const fallback = [
      'Key Finding: ' + (sections.directAnswer || sections.summary || 'No direct finding available.'),
      'Business Impact: ' + (sections.businessImpact || sections.insight || 'Impact could not be determined.'),
      'Next Best Action: ' + (sections.recommendedAction || 'Validate assumptions, then monitor KPI trend weekly.')
    ].join('\n');
    res.json({ summary: fallback, model: 'fallback' });
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

    for (const model of [COMPLEX_MODEL, ...MODEL_CANDIDATES]) {
      try {
        const resp = await fetch(OPENAI_ENDPOINT, {
          method: 'POST', headers: openaiHeaders(),
          body: JSON.stringify({ model, max_tokens: 900, temperature: 0.3, top_p: 0.9, seed: 42,
            messages: [{ role: 'user', content: prompt }] })
        });
        const data = await resp.json();
        if (!resp.ok) continue;
        const story = extractJson(parseOpenAIAnswer(data));
        if (story) return res.json(story);
      } catch (_) {}
    }
    return res.status(500).json({ error: 'Could not generate story.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════════
// FALLBACK & LEGACY ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════════

// /api/ask — qualitative fallback (no data required)
app.post('/api/ask', async (req, res) => {
  try {
    const { question, summary } = req.body;
    if (!question || !summary) return res.status(400).json({ error: 'Missing question or summary.' });
    for (const model of MODEL_CANDIDATES) {
      try {
        const resp = await fetch(OPENAI_ENDPOINT, {
          method: 'POST', headers: openaiHeaders(),
          body: JSON.stringify({ model, max_tokens: 1000, messages: [
            { role: 'system', content: 'You are a sharp data analytics assistant. Answer concisely using the provided data. Lead with the key insight. Use numbers and percentages. Keep under 180 words. Plain text only.' },
            { role: 'user',   content: `Data summary:\n${summary}\n\nQuestion: ${question}` }
          ]})
        });
        const data = await resp.json();
        if (!resp.ok) continue;
        return res.json({ answer: parseOpenAIAnswer(data), model });
      } catch (_) {}
    }
    return res.status(500).json({ error: 'No model available.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// /api/summarize-dataset — executive summary for dashboard
app.post('/api/summarize-dataset', async (req, res) => {
  try {
    const { schemaProfile, stats, datasetName } = req.body;
    if (!schemaProfile) return res.status(400).json({ error: 'Missing schemaProfile.' });
    const statsCtx = stats ? `\n\nKEY STATISTICS:\n${JSON.stringify(stats, null, 2)}` : '';
    for (const model of MODEL_CANDIDATES) {
      try {
        const resp = await fetch(OPENAI_ENDPOINT, {
          method: 'POST', headers: openaiHeaders(),
          body: JSON.stringify({ model, max_tokens: 220, messages: [
            { role: 'system', content: 'You are a senior data analyst writing an executive summary for a BI dashboard. Write exactly 2-3 sentences describing the dataset\'s overall health, key metric trends, and notable patterns. Be specific with numbers. Plain text only, no markdown.' },
            { role: 'user',   content: `Dataset: "${datasetName || 'Dataset'}"\n\nSCHEMA:\n${typeof schemaProfile === 'string' ? schemaProfile : JSON.stringify(schemaProfile, null, 2)}${statsCtx}\n\nWrite the executive summary now.` }
          ]})
        });
        const data = await resp.json();
        if (!resp.ok) continue;
        const summary = parseOpenAIAnswer(data);
        if (summary) return res.json({ summary });
      } catch (_) {}
    }
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
