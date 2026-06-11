'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

let duckdb;
try {
  duckdb = require('duckdb');
} catch (_) {
  // Package not yet installed — engine will throw on first use with a helpful message
}

class DuckDBEngine {
  constructor() {
    this._db   = null;
    this._conn = null;
    this._tables = new Map();        // tableName → { rowCount, columns, source, meta }
    this._queue  = [];
    this._active = 0;
    this.MAX_CONCURRENT = 4;
  }

  _init() {
    if (this._conn) return;
    if (!duckdb) throw new Error('DuckDB not installed. Run: npm install duckdb');
    this._db   = new duckdb.Database(':memory:');
    this._conn = this._db.connect();
  }

  _run(sql) {
    this._init();
    return new Promise((resolve, reject) => {
      this._conn.run(sql, err => (err ? reject(err) : resolve()));
    });
  }

  _all(sql) {
    this._init();
    return new Promise((resolve, reject) => {
      this._conn.all(sql, (err, rows) => (err ? reject(err) : resolve(sanitizeBigInt(rows || []))));
    });
  }

  // ── safe name: strip anything that isn't alphanumeric or underscore ──────────
  _safe(name) {
    return (name || 'table').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  }

  // ── write JS array to a temp JSON file, let DuckDB read it ──────────────────
  async registerTable(name, data) {
    if (!Array.isArray(data) || !data.length) throw new Error('Data must be a non-empty array');

    const safeName = this._safe(name);
    const tmpFile  = path.join(os.tmpdir(), `convbi_${safeName}_${Date.now()}.json`);
    const duckPath = tmpFile.replace(/\\/g, '/');

    try {
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
      fs.writeFileSync(tmpFile, JSON.stringify(normalized));
      await this._run(`CREATE OR REPLACE TABLE "${safeName}" AS SELECT * FROM read_json_auto('${duckPath}', format='array')`);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }

    const schema = await this.getTableSchema(safeName);
    this._tables.set(safeName, { ...schema, source: 'api', originalName: name });
    return { tableName: safeName, rowCount: schema.rowCount, columns: schema.columns };
  }

  // ── register directly from a file path (CSV / Parquet) ──────────────────────
  async registerFromFile(name, filePath, fileType) {
    const safeName = this._safe(name);
    const duckPath = filePath.replace(/\\/g, '/');

    if (fileType === 'csv' || fileType === 'tsv') {
      const sep = fileType === 'tsv' ? "\\t" : ',';
      await this._run(`CREATE OR REPLACE TABLE "${safeName}" AS SELECT * FROM read_csv_auto('${duckPath}', delim='${sep}', header=true)`);
    } else if (fileType === 'parquet') {
      await this._run(`CREATE OR REPLACE TABLE "${safeName}" AS SELECT * FROM read_parquet('${duckPath}')`);
    } else if (fileType === 'json') {
      await this._run(`CREATE OR REPLACE TABLE "${safeName}" AS SELECT * FROM read_json_auto('${duckPath}')`);
    } else {
      throw new Error(`Unsupported file type: ${fileType}`);
    }

    const schema = await this.getTableSchema(safeName);
    this._tables.set(safeName, { ...schema, source: 'file', filePath });
    return { tableName: safeName, rowCount: schema.rowCount, columns: schema.columns };
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
      this._init();
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

    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const tA   = names[i], tB = names[j];
        const colsA = tables[tA].columns.map(c => c.name.toLowerCase());
        const colsB = tables[tB].columns.map(c => c.name.toLowerCase());

        const exactMatches = colsA.filter(c => colsB.includes(c));
        if (exactMatches.length > 0) {
          for (const col of exactMatches) {
            const origA = tables[tA].columns.find(c => c.name.toLowerCase() === col)?.name || col;
            const origB = tables[tB].columns.find(c => c.name.toLowerCase() === col)?.name || col;
            // Quick overlap sample
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
        } else {
          // Levenshtein-lite: check shortened names
          let fuzzyFound = false;
          for (const ca of colsA) {
            for (const cb of colsB) {
              if (ca !== cb && levenshtein(ca, cb) <= 3) {
                joins.push({
                  tableA: tA, columnA: ca,
                  tableB: tB, columnB: cb,
                  confidence: 0.4,
                  sampleOverlap: 0,
                  note: 'Fuzzy name match'
                });
                fuzzyFound = true;
              }
            }
          }
          if (!fuzzyFound) {
            noRelation.push(`${tA} has no common columns with ${tB} — treat as independent datasets`);
          }
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

// DuckDB 1.x returns BIGINT as native BigInt and DATE as JS Date — both break JSON.stringify.
function sanitizeBigInt(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'bigint') return Number(val);
  if (val instanceof Date)     return val.toISOString().slice(0, 10); // DATE → 'YYYY-MM-DD'
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
