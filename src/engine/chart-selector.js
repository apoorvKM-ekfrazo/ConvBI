'use strict';
/**
 * chart-selector.js — usefulness scoring for chart candidates.
 * Computes per-candidate scores with actual DuckDB queries; rejects flat/useless charts.
 */

const DARK_COLORS = ['#6F42C1','#007BFF','#00CCCC','#0DCAF0','#17A2B8','#D97706'];
const DARK_GRID   = { top:16, right:16, bottom:48, left:16, containLabel:true };
const DARK_AXIS   = {
  axisLine:  { lineStyle:{ color:'#E5E7EB' } },
  splitLine: { lineStyle:{ color:'#F3F4F6' } },
  axisLabel: { color:'#6B7280', fontSize:11 }
};
const DARK_TIP = { trigger:'axis', backgroundColor:'#FFFFFF', borderColor:'#E5E7EB', textStyle:{ color:'#111827', fontSize:12 } };

// ── Public API ────────────────────────────────────────────────────────────────

function mergeWhere(baseWhere = '', extraWhere = '') {
  const b = String(baseWhere || '').trim();
  const e = String(extraWhere || '').trim();
  if (b && e) return `(${b}) AND (${e})`;
  return b || e || '';
}

async function selectCharts(tableName, profile, interpretation, executeSQL, maxCharts = 4, options = {}) {
  const { columns, rowCount } = profile;
  if (!rowCount || rowCount < 2) return [];

  const measures   = columns.filter(c => c.semanticType === 'numeric'      && (c.cv || 0) >= 0.05);
  const dimensions = columns.filter(c => c.semanticType === 'categorical'  && c.distinctCount >= 2 && c.distinctCount <= 50);
  const timeColumns= columns.filter(c => c.semanticType === 'date');
  const primaryM   = (interpretation?.primary_measures   || []).slice(0, 2);
  const primaryD   = (interpretation?.primary_dimensions || []).slice(0, 2);

  // Sort primary columns first
  const rank = (arr, name) => { const i = arr.indexOf(name); return i < 0 ? 99 : i; };
  measures  .sort((a, b) => rank(primaryM, a.name) - rank(primaryM, b.name));
  dimensions.sort((a, b) => rank(primaryD, a.name) - rank(primaryD, b.name));

  // Generate candidate set
  const candidates = [];

  // time × measure → line (prefer interpretation's time_column)
  const timeCols = interpretation?.time_column
    ? [columns.find(c => c.name === interpretation.time_column), ...timeColumns].filter(Boolean)
    : timeColumns;
  for (const tc of timeCols.slice(0, 1)) {
    for (const mc of measures.slice(0, 3)) {
      candidates.push({ type: 'line', xCol: tc.name, yCol: mc.name });
    }
  }

  // dimension × measure → bar
  for (const dc of dimensions.slice(0, 3)) {
    for (const mc of measures.slice(0, 2)) {
      candidates.push({ type: 'bar', xCol: dc.name, yCol: mc.name });
    }
  }

  // small dimension (2–6) × measure → donut
  for (const dc of dimensions.filter(d => d.distinctCount >= 2 && d.distinctCount <= 6).slice(0, 2)) {
    for (const mc of measures.slice(0, 1)) {
      candidates.push({ type: 'donut', xCol: dc.name, yCol: mc.name });
    }
  }

  // measure × measure → scatter
  if (measures.length >= 2) {
    candidates.push({ type: 'scatter', xCol: measures[0].name, yCol: measures[1].name });
  }

  if (!candidates.length) return [];

  const scored = await Promise.all(
    candidates.map(c => _scoreCandidate(c, tableName, columns, rowCount, primaryM, executeSQL, options))
  );

  return scored
    .filter(c => c.score > 0 && c.option)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCharts);
}

// ── Scoring ───────────────────────────────────────────────────────────────────

async function _scoreCandidate(candidate, tableName, columns, rowCount, primaryM, executeSQL, options = {}) {
  const { xCol, yCol, type } = candidate;
  const xP = columns.find(c => c.name === xCol);
  const yP = columns.find(c => c.name === yCol);
  const filteredWhere = String(options.whereSql || '').trim();

  // Hard rejects
  if (!xP || !yP)                                               return { ...candidate, score: 0, option: null };
  if (['id-like','constant'].includes(xP.semanticType))         return { ...candidate, score: 0, option: null };
  if (['id-like','constant'].includes(yP.semanticType))         return { ...candidate, score: 0, option: null };
  if (xP.distinctCount > 50)                                    return { ...candidate, score: 0, option: null };
  if (rowCount < 2)                                             return { ...candidate, score: 0, option: null };

  let score = 0;

  // +15 both axes have < 5% nulls
  if ((xP.nullPct || 0) < 0.05 && (yP.nullPct || 0) < 0.05) score += 15;
  // +10 readable category count
  if (xP.semanticType === 'categorical' && xP.distinctCount >= 3 && xP.distinctCount <= 12) score += 10;
  // +5 date axes always readable
  if (xP.semanticType === 'date') score += 5;
  // +5 y is a primary measure
  if (primaryM.includes(yCol)) score += 5;

  let option = null;

  try {
    if (type === 'bar' || type === 'donut') {
      const whereSql = mergeWhere(filteredWhere, `"${xCol}" IS NOT NULL AND "${yCol}" IS NOT NULL`);
      const sql =
        `SELECT "${xCol}" AS grp, AVG("${yCol}") AS avg_val
         FROM "${tableName}"
         WHERE ${whereSql}
         GROUP BY "${xCol}" ORDER BY avg_val DESC`;
      const r = await executeSQL(sql);
      const rows   = r.rows || [];
      const vals   = rows.map(row => Number(row.avg_val)).filter(v => Number.isFinite(v));
      const labels = rows.map(row => String(row.grp));

      if (vals.length < 2) return { ...candidate, score: 0, option: null };

      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
      const groupCV  = mean !== 0 ? Math.sqrt(variance) / Math.abs(mean) : 0;

      // Hard reject: all bars within ±5% of each other → flat chart
      if (groupCV < 0.05) return { ...candidate, score: 0, option: null };

      // +30 bars actually differ (CV > 0.15)
      if (groupCV > 0.15) score += 30;

      // +20 clear leader (top >= 1.5× median)
      const sorted = [...vals].sort((a, b) => b - a);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (median !== 0 && sorted[0] >= 1.5 * Math.abs(median)) score += 20;

      option = type === 'donut'
        ? _donutOption(labels, vals, candidate)
        : _barOption(labels, vals, candidate);

    } else if (type === 'line') {
      const whereSql = mergeWhere(filteredWhere, `"${xCol}" IS NOT NULL AND "${yCol}" IS NOT NULL`);
      const sql =
        `SELECT CAST("${xCol}" AS VARCHAR) AS period, AVG("${yCol}") AS avg_val
         FROM "${tableName}"
         WHERE ${whereSql}
         GROUP BY "${xCol}" ORDER BY "${xCol}"`;
      const r = await executeSQL(sql);
      const rows   = r.rows || [];
      const vals   = rows.map(row => Number(row.avg_val)).filter(v => Number.isFinite(v));
      const labels = rows.map(row => String(row.period));

      if (vals.length < 2) return { ...candidate, score: 0, option: null };

      const mean   = vals.reduce((s, v) => s + v, 0) / vals.length;
      const stddev = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
      const range  = vals.length - 1;
      const slope  = (vals[vals.length - 1] - vals[0]) / Math.max(range, 1);

      // Hard reject: completely flat
      if (stddev === 0) return { ...candidate, score: 0, option: null };

      // +30 variation exists
      if (mean !== 0 && stddev / Math.abs(mean) > 0.15) score += 30;
      // +20 visible trend: |slope| × range > stddev
      if (stddev > 0 && Math.abs(slope) * range > stddev) score += 20;

      option = _lineOption(labels, vals, candidate);

    } else if (type === 'scatter') {
      const whereSql = mergeWhere(filteredWhere, `"${xCol}" IS NOT NULL AND "${yCol}" IS NOT NULL`);
      const sql =
        `SELECT "${xCol}" AS x, "${yCol}" AS y FROM "${tableName}"
         WHERE ${whereSql} LIMIT 500`;
      const r = await executeSQL(sql);
      const pts = (r.rows || [])
        .map(row => [Number(row.x), Number(row.y)])
        .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));

      if (pts.length < 2) return { ...candidate, score: 0, option: null };

      score += 15;   // scatter always gets base score if data exists
      option = _scatterOption(pts, candidate);
    }
  } catch (e) {
    console.warn('[chart-selector] scoring error:', e.message);
    return { ...candidate, score: 0, option: null };
  }

  return { ...candidate, score, option };
}

// ── ECharts option builders ───────────────────────────────────────────────────

function _title(candidate) {
  // Title is intentionally omitted — the client card header renders the label.
  // Returning an empty object keeps option shape valid without duplicating text.
  return {};
}

function _barOption(labels, vals, candidate) {
  return {
    grid:    DARK_GRID,
    tooltip: DARK_TIP,
    xAxis:   { type:'category', data:labels, ...DARK_AXIS,
               axisLabel:{ ...DARK_AXIS.axisLabel, rotate:labels.length > 5 ? 35 : 0 } },
    yAxis:   { type:'value', ...DARK_AXIS },
    series:  [{ type:'bar', data:vals,
      itemStyle:{ borderRadius:[4,4,0,0], color:{
        type:'linear', x:0,y:0,x2:0,y2:1,
        colorStops:[{offset:0,color:'#9d71d9'},{offset:1,color:'#6F42C1'}]
      }},
      label:{ show:labels.length <= 10, position:'top', color:'#6B7280', fontSize:10 }
    }]
  };
}

function _donutOption(labels, vals, candidate) {
  return {
    tooltip: { trigger:'item', backgroundColor:'#FFFFFF', borderColor:'#E5E7EB', textStyle:{ color:'#111827' } },
    legend:  { orient:'vertical', right:10, top:'center', textStyle:{ color:'#4B5563' } },
    series:  [{ type:'pie', radius:['42%','70%'], center:['40%','50%'],
      data: labels.map((l, i) => ({ name:l, value:vals[i], itemStyle:{ color:DARK_COLORS[i % DARK_COLORS.length] } })),
      label:    { color:'#6B7280', fontSize:11 },
      labelLine:{ lineStyle:{ color:'#E5E7EB' } }
    }]
  };
}

function _lineOption(labels, vals, candidate) {
  return {
    grid:    DARK_GRID,
    tooltip: DARK_TIP,
    xAxis:   { type:'category', data:labels, ...DARK_AXIS,
               axisLabel:{ ...DARK_AXIS.axisLabel, rotate:labels.length > 8 ? 30 : 0 } },
    yAxis:   { type:'value', ...DARK_AXIS },
    series:  [{ type:'line', data:vals, smooth:true,
      lineStyle:{ width:2.5, color:DARK_COLORS[0] },
      itemStyle:{ color:DARK_COLORS[0] },
      areaStyle:{ color:DARK_COLORS[0], opacity:0.08 },
      symbol:'circle', symbolSize:5
    }]
  };
}

function _scatterOption(pts, candidate) {
  return {
    grid:    DARK_GRID,
    tooltip: { trigger:'item', backgroundColor:'#FFFFFF', borderColor:'#E5E7EB', textStyle:{ color:'#111827' } },
    xAxis:   { type:'value', name:candidate.xCol.replace(/_/g,' '), nameLocation:'middle', nameGap:28,
               nameTextStyle:{ color:'#6B7280' }, ...DARK_AXIS },
    yAxis:   { type:'value', name:candidate.yCol.replace(/_/g,' '), nameLocation:'middle', nameGap:44,
               nameTextStyle:{ color:'#6B7280' }, ...DARK_AXIS },
    series:  [{ type:'scatter', data:pts, itemStyle:{ color:'#007BFF', opacity:0.55 }, symbolSize:6 }]
  };
}

module.exports = { selectCharts };
