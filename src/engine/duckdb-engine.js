'use strict';

const fs   = require('fs');
const path = require('path');

// DuckDB compiled to WASM instead of the native `duckdb` addon: the native
// binary is an unsigned Windows .node file, which Smart App Control / WDAC
// environments refuse to dlopen (Code Integrity policy violation). The WASM
// build is plain bytecode executed by V8 like any other JS dependency, so it
// isn't subject to that native-code signing check, while still being real
// DuckDB — same SQL dialect (date_trunc, TRY_CAST, PIVOT, window functions,
// read_csv_auto/read_json_auto/read_parquet, etc.) that the rest of this app
// (and the AI SQL-generation prompt) already assumes.
let duckdb;
let pkgDir;
try {
  const entryPath = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
  duckdb = require(entryPath);
  pkgDir = path.dirname(path.dirname(entryPath)); // .../dist/duckdb-node-blocking.cjs → package root
} catch (_) {
  // Package not yet installed — engine will throw on first use with a helpful message
}

function bundlePaths() {
  const dist = path.join(pkgDir, 'dist');
  return {
    mvp: {
      mainModule: path.join(dist, 'duckdb-mvp.wasm'),
      mainWorker: path.join(dist, 'duckdb-node-mvp.worker.cjs'),
    },
    eh: {
      mainModule: path.join(dist, 'duckdb-eh.wasm'),
      mainWorker: path.join(dist, 'duckdb-node-eh.worker.cjs'),
    },
  };
}

class DuckDBEngine {
  constructor() {
    this._bindings = null;
    this._conn = null;
    this._initPromise = null;
    this._tables = new Map();        // tableName → { rowCount, columns, source, meta }
    this._fileSeq = 0;
  }

  async _init() {
    if (this._conn) return;
    if (this._initPromise) return this._initPromise;
    if (!duckdb) throw new Error('DuckDB engine not installed. Run: npm install @duckdb/duckdb-wasm');

    this._initPromise = (async () => {
      const logger = new duckdb.VoidLogger();
      this._bindings = await duckdb.createDuckDB(bundlePaths(), logger, duckdb.NODE_RUNTIME);
      await this._bindings.instantiate(() => {});
      await this._bindings.open({});
      this._conn = this._bindings.connect();
    })();
    return this._initPromise;
  }

  async _run(sql) {
    await this._init();
    this._conn.query(sql);
  }

  async _all(sql) {
    await this._init();
    const result = this._conn.query(sql);

    const dateFields = new Set();
    const tsFields    = new Set();
    for (const f of result.schema.fields) {
      const t = String(f.type);
      if (t.startsWith('Date'))      dateFields.add(f.name);
      else if (t.startsWith('Timestamp')) tsFields.add(f.name);
    }

    const rows = result.toArray().map(r => {
      const obj = r.toJSON();
      for (const k of Object.keys(obj)) {
        if (typeof obj[k] !== 'number') continue;
        if (dateFields.has(k)) obj[k] = new Date(obj[k]).toISOString().slice(0, 10);
        else if (tsFields.has(k)) obj[k] = new Date(obj[k]).toISOString();
      }
      return obj;
    });
    return sanitizeBigInt(rows);
  }

  // ── safe name: strip anything that isn't alphanumeric or underscore ──────────
  _safe(name) {
    return (name || 'table').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  }

  // ── register a JS array of rows as a virtual file DuckDB reads directly ─────
  async registerTable(name, data) {
    if (!Array.isArray(data) || !data.length) throw new Error('Data must be a non-empty array');
    await this._init();

    const safeName = this._safe(name);
    const virtualName = `mem_${safeName}_${Date.now()}_${this._fileSeq++}.json`;

    // Normalize date strings in data before saving
    const normalized = data.map(row => {
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = (typeof v === 'string' && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v.trim()))
          ? normalizeMDY(v.trim())
          : v;
      }
      return out;
    });

    this._bindings.registerFileText(virtualName, JSON.stringify(normalized));
    try {
      await this._run(`CREATE OR REPLACE TABLE "${safeName}" AS SELECT * FROM read_json_auto('${virtualName}', format='array')`);
    } finally {
      try { this._bindings.dropFile(virtualName); } catch (_) {}
    }

    await this._coerceNumericColumns(safeName);
    const schema = await this.getTableSchema(safeName);
    this._tables.set(safeName, { ...schema, source: 'api', originalName: name });
    return { tableName: safeName, rowCount: schema.rowCount, columns: schema.columns };
  }

  // ── register directly from a file path (CSV / Parquet / JSON) ───────────────
  async registerFromFile(name, filePath, fileType) {
    await this._init();
    const safeName = this._safe(name);
    const virtualName = `mem_${safeName}_${Date.now()}_${this._fileSeq++}${path.extname(filePath) || ''}`;

    this._bindings.registerFileBuffer(virtualName, fs.readFileSync(filePath));
    try {
      if (fileType === 'csv' || fileType === 'tsv') {
        const sep = fileType === 'tsv' ? "\\t" : ',';
        await this._run(`CREATE OR REPLACE TABLE "${safeName}" AS SELECT * FROM read_csv_auto('${virtualName}', delim='${sep}', header=true)`);
      } else if (fileType === 'parquet') {
        await this._run(`CREATE OR REPLACE TABLE "${safeName}" AS SELECT * FROM read_parquet('${virtualName}')`);
      } else if (fileType === 'json') {
        await this._run(`CREATE OR REPLACE TABLE "${safeName}" AS SELECT * FROM read_json_auto('${virtualName}')`);
      } else {
        throw new Error(`Unsupported file type: ${fileType}`);
      }
    } finally {
      try { this._bindings.dropFile(virtualName); } catch (_) {}
    }

    await this._coerceNumericColumns(safeName);
    const schema = await this.getTableSchema(safeName);
    this._tables.set(safeName, { ...schema, source: 'file', filePath });
    return { tableName: safeName, rowCount: schema.rowCount, columns: schema.columns };
  }

  // ── detect VARCHAR columns that are actually numbers wearing a costume
  // (currency symbols, thousands separators, stray quotes from bad CSV
  // quoting) and cast them to DOUBLE in place, so charting/stats treat them
  // as measures instead of silently excluding them. ─────────────────────────
  async _coerceNumericColumns(safeName) {
    const cols = await this._all(
      `SELECT column_name FROM information_schema.columns WHERE table_name='${safeName}' AND table_schema='main' AND data_type='VARCHAR' ORDER BY ordinal_position`
    );
    if (!cols.length) return;

    const allCols = await this._all(
      `SELECT column_name FROM information_schema.columns WHERE table_name='${safeName}' AND table_schema='main' ORDER BY ordinal_position`
    );

    let changed = false;
    const selects = [];
    for (const { column_name: name } of allCols) {
      const q = `"${name}"`;
      const isCandidate = cols.some(c => c.column_name === name);
      if (!isCandidate) { selects.push(q); continue; }

      const sample = await this._all(
        `SELECT ${q} AS v FROM "${safeName}" WHERE ${q} IS NOT NULL AND trim(${q}) != '' LIMIT 50`
      );
      const vals = sample.map(r => String(r.v));
      if (!vals.length) { selects.push(q); continue; }

      const stripped = vals.map(v => v.trim().replace(/^"+|"+$/g, '').replace(/^[$₹€£]\s*/, '').replace(/,/g, ''));
      const numericLike = stripped.filter(v => /^-?\d+(\.\d+)?$/.test(v));

      if (numericLike.length / vals.length >= 0.9) {
        selects.push(`TRY_CAST(REGEXP_REPLACE(REPLACE(${q}, '"', ''), '[^0-9.-]', '', 'g') AS DOUBLE) AS ${q}`);
        changed = true;
      } else {
        selects.push(q);
      }
    }

    if (changed) {
      await this._run(`CREATE OR REPLACE TABLE "${safeName}" AS SELECT ${selects.join(', ')} FROM "${safeName}"`);
    }
  }

  // ── execute arbitrary SQL with timeout ──────────────────────────────────────
  async executeSQL(sql, timeoutMs = 30000) {
    const start = Date.now();
    try {
      const rows = await Promise.race([
        this._all(sql),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Query timeout: exceeded 30 seconds')), timeoutMs)
        )
      ]);
      const executionTimeMs = Date.now() - start;
      const columns = rows.length > 0
        ? Object.keys(rows[0]).map(n => ({ name: n, type: inferType(rows[0][n]) }))
        : [];
      return { columns, rows, rowCount: rows.length, executionTimeMs };
    } catch (error) {
      return { error: error.message };
    }
  }

  // ── list all registered tables with schemas ──────────────────────────────────
  async listTables() {
    try {
      await this._init();
    } catch (_) {
      return {};
    }
    const rows = await this._all(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema='main'
       ORDER BY table_name, ordinal_position`
    ).catch(() => []);

    const tables = {};
    rows.forEach(r => {
      if (!tables[r.table_name]) {
        const meta = this._tables.get(r.table_name) || {};
        tables[r.table_name] = {
          columns: [],
          rowCount: meta.rowCount || 0,
          source:   meta.source || 'unknown',
          originalName: meta.originalName || r.table_name
        };
      }
      tables[r.table_name].columns.push({ name: r.column_name, type: r.data_type });
    });
    return tables;
  }

  // ── get full schema + samples for a single table ─────────────────────────────
  async getTableSchema(tableName) {
    const safeName = this._safe(tableName);

    const [colRows, countRows, sampleRows] = await Promise.all([
      this._all(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='${safeName}' AND table_schema='main' ORDER BY ordinal_position`),
      this._all(`SELECT COUNT(*) AS cnt FROM "${safeName}"`),
      this._all(`SELECT * FROM "${safeName}" LIMIT 3`)
    ]);

    const rowCount = Number(countRows[0]?.cnt || 0);
    const columns  = colRows.map(c => ({ name: c.column_name, type: c.data_type }));

    const NUMERIC = ['INTEGER','BIGINT','DOUBLE','FLOAT','DECIMAL','HUGEINT','SMALLINT','TINYINT','REAL','UBIGINT','UINTEGER','USMALLINT'];
    const DATETY  = ['DATE','TIMESTAMP'];

    const numericCols     = columns.filter(c => NUMERIC.some(t => c.type?.toUpperCase().startsWith(t))).map(c => c.name);
    const dateCols        = columns.filter(c => DATETY.some(t => c.type?.toUpperCase().startsWith(t)) || /date|time/i.test(c.name)).map(c => c.name);
    const categoricalCols = columns.filter(c => !numericCols.includes(c.name) && !dateCols.includes(c.name)).map(c => c.name);

    return { tableName: safeName, rowCount, columns, numericCols, dateCols, categoricalCols, sampleRows };
  }

  // ── heuristic relationship detection between all loaded tables ───────────────
  async detectRelationships() {
    const tables = await this.listTables();
    const names  = Object.keys(tables);
    const joins  = [];
    const noRelation = [];
    // Strip case + punctuation/spacing so "Product ID" / "product_id" / "ProductId"
    // are recognized as the same column instead of only matching verbatim.
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const tA = names[i], tB = names[j];
        const colsAOrig = tables[tA].columns.map(c => c.name);
        const colsBOrig = tables[tB].columns.map(c => c.name);
        const colsA = colsAOrig.map(c => c.toLowerCase());
        const colsB = colsBOrig.map(c => c.toLowerCase());

        const matchedA = new Set();
        const matchedB = new Set();
        let anyMatch = false;

        // 1) Exact (case-insensitive) matches
        for (let ai = 0; ai < colsA.length; ai++) {
          const bi = colsB.indexOf(colsA[ai]);
          if (bi === -1 || matchedB.has(bi)) continue;
          matchedA.add(ai); matchedB.add(bi); anyMatch = true;
          const origA = colsAOrig[ai], origB = colsBOrig[bi];
          const olap = await this._all(
            `SELECT COUNT(*) AS cnt FROM (
               SELECT DISTINCT "${origA}" FROM "${tA}"
               INTERSECT
               SELECT DISTINCT "${origB}" FROM "${tB}"
             )`
          ).catch(() => [{ cnt: 0 }]);
          joins.push({
            tableA: tA, columnA: origA,
            tableB: tB, columnB: origB,
            confidence: Number(olap[0]?.cnt || 0) > 0 ? 0.95 : 0.6,
            sampleOverlap: Number(olap[0]?.cnt || 0)
          });
        }

        // 2) Normalized matches among columns not already matched exactly —
        // catches naming-convention differences (spaces/underscores/case).
        for (let ai = 0; ai < colsA.length; ai++) {
          if (matchedA.has(ai)) continue;
          const na = norm(colsA[ai]);
          if (!na) continue;
          for (let bi = 0; bi < colsB.length; bi++) {
            if (matchedB.has(bi) || norm(colsB[bi]) !== na) continue;
            matchedA.add(ai); matchedB.add(bi); anyMatch = true;
            joins.push({
              tableA: tA, columnA: colsAOrig[ai],
              tableB: tB, columnB: colsBOrig[bi],
              confidence: 0.85, sampleOverlap: 0,
              note: 'Normalized name match'
            });
            break;
          }
        }

        // 3) Levenshtein-lite fuzzy match among whatever's still unmatched —
        // always attempted, even when this table pair already has exact/normalized matches.
        for (let ai = 0; ai < colsA.length; ai++) {
          if (matchedA.has(ai)) continue;
          for (let bi = 0; bi < colsB.length; bi++) {
            if (matchedB.has(bi) || colsA[ai] === colsB[bi]) continue;
            if (levenshtein(colsA[ai], colsB[bi]) <= 3) {
              matchedA.add(ai); matchedB.add(bi); anyMatch = true;
              joins.push({
                tableA: tA, columnA: colsAOrig[ai],
                tableB: tB, columnB: colsBOrig[bi],
                confidence: 0.4, sampleOverlap: 0,
                note: 'Fuzzy name match'
              });
              break;
            }
          }
        }

        if (!anyMatch) {
          noRelation.push(`${tA} has no common columns with ${tB} — treat as independent datasets`);
        }
      }
    }
    return { joins, noRelation };
  }

  // ── drop a table ─────────────────────────────────────────────────────────────
  async dropTable(name) {
    const safeName = this._safe(name);
    this._tables.delete(safeName);
    await this._run(`DROP TABLE IF EXISTS "${safeName}"`);
  }

  // ── registered table list (safe names only) ──────────────────────────────────
  getRegisteredNames() {
    return [...this._tables.keys()];
  }

  // ── validate a table name against registered list (SQL injection guard) ──────
  isRegistered(name) {
    return this._tables.has(this._safe(name));
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

// BIGINT/HUGEINT columns come back as native BigInt, which breaks JSON.stringify.
function sanitizeBigInt(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'bigint') return Number(val);
  if (val instanceof Date)     return val.toISOString().slice(0, 10);
  if (Array.isArray(val))      return val.map(sanitizeBigInt);
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = sanitizeBigInt(v);
    return out;
  }
  return val;
}

function normalizeMDY(str) {
  // M/D/YYYY → YYYY-MM-DD
  const [m, d, y] = str.split('/');
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

function inferType(val) {
  if (val === null || val === undefined) return 'unknown';
  if (typeof val === 'number') return Number.isInteger(val) ? 'INTEGER' : 'DOUBLE';
  if (typeof val === 'boolean') return 'BOOLEAN';
  return 'VARCHAR';
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

module.exports = new DuckDBEngine();
