'use strict';
/**
 * data-profiler.js — per-column statistical profiling using DuckDB SQL.
 * Called by /api/charts/:tableName to understand data before chart selection.
 */

function whereFragment(whereSql = '') {
  const w = String(whereSql || '').trim();
  return w ? ` WHERE ${w}` : '';
}

async function profileTable(tableName, executeSQL, options = {}) {
  const safeT = `"${tableName}"`;
  const whereSql = whereFragment(options.whereSql);

  const countRes = await executeSQL(`SELECT COUNT(*) AS n FROM ${safeT}${whereSql}`);
  const rowCount = Number(countRes.rows?.[0]?.n || 0);
  if (!rowCount) return { tableName, rowCount: 0, columns: [] };

  const descRes = await executeSQL(`DESCRIBE ${safeT}`);
  const rawCols = descRes.rows || [];

  // Profile up to 15 columns in parallel
  const profiles = await Promise.all(
    rawCols.slice(0, 15).map(col => _profileColumn(col, tableName, rowCount, executeSQL, options))
  );

  return { tableName, rowCount, columns: profiles };
}

async function _profileColumn(colDef, tableName, rowCount, executeSQL, options = {}) {
  const name   = colDef.column_name || colDef.name || '';
  const type   = colDef.column_type || colDef.type || 'VARCHAR';
  const safeC  = `"${name}"`;
  const safeT  = `"${tableName}"`;
  const whereSql = whereFragment(options.whereSql);

  const isNumericType = /^(INTEGER|INT|BIGINT|DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC|HUGEINT|UBIGINT|TINYINT|SMALLINT|UINTEGER|USMALLINT|UTINYINT|INT4|INT8|INT2|NUMBER|MONEY)/i.test(type);
  const isDateType    = /^(DATE|TIMESTAMP|TIME)/i.test(type);

  let nullCount = 0, distinctCount = 1;
  try {
    const r = await executeSQL(
      `SELECT (COUNT(*) - COUNT(${safeC})) AS nulls, COUNT(DISTINCT ${safeC}) AS dist FROM ${safeT}${whereSql}`
    );
    nullCount     = Number(r.rows?.[0]?.nulls ?? 0);
    distinctCount = Number(r.rows?.[0]?.dist  ?? 1);
  } catch (_) {}

  const nullPct       = rowCount > 0 ? nullCount / rowCount : 0;
  const distinctRatio = rowCount > 0 ? distinctCount / rowCount : 0;

  // Semantic classification
  const n = name.toLowerCase();
  const isIdName   = /\bid\b|_id$|^id_|\bkey\b|\bcode\b|uuid|guid/.test(n);
  const isDateName = /date|time|period|month|year|day|dt$|_at$|_on$/.test(n);

  let semanticType;
  if (distinctCount <= 1) {
    semanticType = 'constant';
  } else if (isIdName && distinctRatio > 0.9) {
    semanticType = 'id-like';
  } else if (!isIdName && !isNumericType && distinctRatio > 0.95 && distinctCount > 20) {
    semanticType = 'id-like';
  } else if (isDateType || (isDateName && !isNumericType)) {
    semanticType = 'date';
  } else if (isNumericType) {
    semanticType = 'numeric';
  } else if (distinctCount >= 2 && distinctCount <= 50) {
    semanticType = 'categorical';
  } else {
    semanticType = 'text';
  }

  const profile = { name, type, semanticType, nullPct, distinctCount, distinctRatio };

  // Numeric stats
  if (semanticType === 'numeric') {
    try {
      const r = await executeSQL(
        `SELECT MIN(${safeC}) AS mn, MAX(${safeC}) AS mx,
                AVG(${safeC}) AS avg, STDDEV_POP(${safeC}) AS sd
        FROM ${safeT}${whereSql ? `${whereSql} AND ${safeC} IS NOT NULL` : ` WHERE ${safeC} IS NOT NULL`}`
      );
      const row = r.rows?.[0] || {};
      profile.min    = Number(row.mn);
      profile.max    = Number(row.mx);
      profile.mean   = Number(row.avg);
      profile.stddev = Number(row.sd);
      profile.cv     = (row.avg && row.avg != 0) ? Math.abs(row.sd / row.avg) : 0;
      if (profile.cv < 0.02) profile.semanticType = semanticType = 'constant';
    } catch (_) {}
  }

  // Top values for categorical columns
  if (semanticType === 'categorical') {
    try {
      const r = await executeSQL(
        `SELECT ${safeC} AS val, COUNT(*) AS freq FROM ${safeT}
        ${whereSql ? `${whereSql} AND ${safeC} IS NOT NULL` : `WHERE ${safeC} IS NOT NULL`} GROUP BY ${safeC} ORDER BY freq DESC LIMIT 5`
      );
      profile.topValues = (r.rows || []).map(row => ({ value: row.val, freq: Number(row.freq) }));
      const total = profile.topValues.reduce((s, v) => s + v.freq, 0);
      if (total > 0) {
        profile.entropy = -profile.topValues.reduce((s, v) => {
          const p = v.freq / total;
          return s + (p > 0 ? p * Math.log2(p) : 0);
        }, 0);
      }
    } catch (_) {}
  }

  // Date range + granularity
  if (semanticType === 'date') {
    try {
      const r = await executeSQL(
        `SELECT MIN(${safeC}) AS mn, MAX(${safeC}) AS mx,
                COUNT(DISTINCT ${safeC}) AS nd FROM ${safeT}${whereSql ? `${whereSql} AND ${safeC} IS NOT NULL` : ` WHERE ${safeC} IS NOT NULL`}`
      );
      const row = r.rows?.[0] || {};
      profile.minDate = row.mn;
      profile.maxDate = row.mx;
      if (row.mn && row.mx) {
        const days = (new Date(String(row.mx)) - new Date(String(row.mn))) / 86_400_000;
        if (days > 0) {
          const ratio = Number(row.nd) / days;
          profile.granularity = ratio > 0.8 ? 'daily' : ratio > 0.1 ? 'weekly' : 'monthly';
        }
      }
    } catch (_) {}
  }

  return profile;
}

module.exports = { profileTable };
