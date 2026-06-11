/**
 * Complex question test suite for shift_data_template.csv
 * Tests 50+ questions across:
 *   - Fast path (local regex)
 *   - Gold-standard path (simulated LLM-generated JS executed via new Function)
 * Run: node test_complex_questions.cjs
 */
const fs = require('fs');

// Load script.js into Node with browser stubs
const code = fs.readFileSync('script.js', 'utf8');
const stub = `
const window = { addEventListener() {} };
const document = {
  createElement() { return { href:'', download:'', click(){} }; },
  getElementById() { return null; },
  querySelectorAll() { return []; },
  querySelector() { return null; }
};
const Chart = function(){};
`;
const api = new Function(stub + '\n' + code + '\nreturn { parseLocalInstruction, executeParsedInstruction, questionHasUnresolvedDateContext, executeGeneratedCode };')();

// ── Load CSV ──────────────────────────────────────────────────────────────────
function parseDate(s) {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  return s;
}
const csvLines = fs.readFileSync('shift_data_template.csv','utf8').trim().split(/\r?\n/);
const headers = csvLines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g,'_'));
const data = csvLines.slice(1).map(line => {
  const vals = line.split(','); const r = {};
  headers.forEach((h, i) => r[h] = (vals[i] || '').trim()); return r;
}).map(r => ({
  ...r, date: parseDate(r.date),
  target: parseFloat(r.target_units) || 0, actual: parseFloat(r.actual_units) || 0,
  wastage: parseFloat(r.wastage_units) || 0, downtime: parseFloat(r.downtime_minutes) || 0,
  headcount: parseFloat(r.headcount) || 0, utilisation: parseFloat(r.machine_utilisation_pct) || 0,
  shift: (r.shift || '').toUpperCase()
})).map(r => ({
  ...r,
  efficiency: r.target > 0 ? Math.round(r.actual / r.target * 100) : null,
  productivity: r.headcount > 0 ? parseFloat((r.actual / r.headcount).toFixed(1)) : 0,
  wastageRate: (r.actual + r.wastage) > 0 ? parseFloat((r.wastage / (r.actual + r.wastage) * 100).toFixed(1)) : 0
}));

// ── Harness ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function approxEq(a, b, tol = 1) { return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol; }

function stripDates(s) { return s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '').replace(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, ''); }
function extractNum(result) {
  if (result === null || result === undefined) return null;
  if (typeof result === 'number') return result;
  const s = stripDates(String(result));
  const isMatch = s.match(/\bis\s+([\d,]+(?:\.\d+)?)/i) || s.match(/\bare\s+([\d,]+(?:\.\d+)?)/i);
  if (isMatch) return parseFloat(isMatch[1].replace(/,/g,''));
  const nums = [...s.matchAll(/([\d,]+(?:\.\d+)?)/g)].map(m => parseFloat(m[1].replace(/,/g,'')));
  const big = nums.find(n => n >= 10); return big !== undefined ? big : null;
}

// Fast-path test: run through parseLocalInstruction + executeParsedInstruction
function fastTest(label, question, checkFn) {
  const inst = api.parseLocalInstruction(question);
  const unresolved = api.questionHasUnresolvedDateContext(question, inst);
  let result = null;
  if (!unresolved && inst && inst.operation !== 'unknown') {
    result = api.executeParsedInstruction(inst, data, question);
  }
  const ok = checkFn(result, inst, unresolved);
  if (ok) { console.log(`  [PASS] ${label}`); passed++; }
  else { console.log(`  [FAIL] ${label} → got: ${JSON.stringify(result)}`); failed++; failures.push({ label, question, result, type:'fast' }); }
}

// Gold-standard path test: execute JS code snippet against data (simulates LLM-generated code)
function codeTest(label, jsCode, checkFn) {
  const exec = api.executeGeneratedCode(jsCode, data);
  const ok = exec.success && checkFn(exec.result);
  if (ok) { console.log(`  [PASS] ${label}`); passed++; }
  else {
    const msg = exec.success ? `result=${JSON.stringify(exec.result)}` : `error=${exec.error}`;
    console.log(`  [FAIL] ${label} → ${msg}`);
    failed++;
    failures.push({ label, jsCode: jsCode.slice(0,120)+'...', result: exec.success ? exec.result : exec.error, type:'code' });
  }
}

// ── SECTION 1: Simple aggregations (fast path) ──────────────────────────────
console.log('\n══════════ 1. SIMPLE AGGREGATIONS (fast path) ══════════');

fastTest('Total actual units produced', 'what is the total actual units produced', (r) => approxEq(extractNum(r), 1510549));
fastTest('Total wastage', 'total wastage units', (r) => approxEq(extractNum(r), 198502));
fastTest('Total downtime', 'total downtime minutes', (r) => approxEq(extractNum(r), 8714));
fastTest('Average efficiency', 'what is the average efficiency', (r) => approxEq(extractNum(r), 76.3, 1.5));
fastTest('Average productivity', 'average productivity score', (r) => approxEq(extractNum(r), 159.6, 2));
fastTest('Record count', 'how many shift records are loaded', (r) => approxEq(extractNum(r), 396));
fastTest('Average headcount', 'what is the average headcount per shift', (r) => approxEq(extractNum(r), 23.9, 1));
fastTest('Maximum single-shift production', 'what is the maximum actual units in a single shift', (r) => { const n = extractNum(r); return n > 5000 && n <= 10000; });
fastTest('Minimum efficiency', 'what is the minimum efficiency', (r) => { const n = extractNum(r); return n !== null && n >= 0 && n < 50; });
fastTest('Total actual (alternate)', 'sum of actual production', (r) => approxEq(extractNum(r), 1510549));

// ── SECTION 2: Shift-filtered aggregations (fast path) ──────────────────────
console.log('\n══════════ 2. SHIFT-FILTERED AGGREGATIONS (fast path) ══════════');

fastTest('Shift A total production', 'total actual units for shift A', (r) => approxEq(extractNum(r), 505366));
fastTest('Shift B total production', 'what is total production for shift B', (r) => approxEq(extractNum(r), 519674));
fastTest('Shift C total production', 'sum of actual units in shift C', (r) => approxEq(extractNum(r), 485509));
fastTest('Shift A average efficiency', 'average efficiency for shift A', (r) => approxEq(extractNum(r), 76.6, 2));
fastTest('Shift B average efficiency', 'what is shift B average efficiency', (r) => approxEq(extractNum(r), 78.7, 2));
fastTest('Shift C average efficiency', 'average efficiency shift C', (r) => approxEq(extractNum(r), 73.6, 2));
fastTest('Shift A record count', 'how many records for shift A', (r) => approxEq(extractNum(r), 132));
fastTest('Shift B total wastage', 'total wastage for shift B', (r) => { const n = extractNum(r); return n !== null && n > 0; });
fastTest('Shift A maximum downtime', 'maximum downtime for shift A', (r) => { const n = extractNum(r); return n !== null && n > 0; });

// ── SECTION 3: Explicit date-range queries (fast path) ──────────────────────
console.log('\n══════════ 3. EXPLICIT DATE RANGES (fast path) ══════════');

fastTest('Jan total (slash dates)', 'total actual from 1/1/2025 to 1/31/2025', (r) => approxEq(extractNum(r), 344637));
fastTest('Jan total (ISO dates)', 'total actual units from 2025-01-01 to 2025-01-31', (r) => approxEq(extractNum(r), 344637));
fastTest('Q1 total (ISO)', 'total actual from 2025-01-01 to 2025-03-31', (r) => { const n = extractNum(r); return n !== null && approxEq(n, 344637+324379+356518, 5); });
fastTest('Feb date range downtime', 'total downtime from 2025-02-01 to 2025-02-28', (r) => { const n = extractNum(r); return n !== null && n > 0; });

// ── SECTION 4: Conditional queries (fast path) ──────────────────────────────
console.log('\n══════════ 4. CONDITIONAL / LIST QUERIES (fast path) ══════════');

fastTest('Zero downtime list', 'list days and shift where downtime was 0', (r) => r && String(r).includes('Date:'));
fastTest('Count zero downtime', 'how many records have downtime 0', (r) => approxEq(extractNum(r), 10));
fastTest('Count zero downtime (zero word)', 'how many shifts had downtime of zero', (r) => approxEq(extractNum(r), 10));
fastTest('GroupBy shift production', 'show total production by shift', (r) => r && String(r).includes('A:') && String(r).includes('B:') && String(r).includes('C:'));
fastTest('GroupBy shift avg efficiency', 'average efficiency by shift', (r) => r && String(r).includes('A:') && String(r).includes('B:') && String(r).includes('C:'));

// ── SECTION 5: Month-name queries (LLM gold-standard path — code execution) ──
console.log('\n══════════ 5. MONTH-NAME QUERIES (simulated LLM code execution) ══════════');

codeTest('January total actual', `
  const years = [...new Set(data.map(r => r.date.slice(0,4)))].sort();
  const yr = years[years.length-1];
  const jan = data.filter(r => r.date >= yr+'-01-01' && r.date <= yr+'-01-31');
  const answer = jan.reduce((sum,r) => sum + r.actual, 0);
`, (r) => approxEq(r, 344637));

codeTest('February total actual', `
  const years = [...new Set(data.map(r => r.date.slice(0,4)))].sort();
  const yr = years[years.length-1];
  const feb = data.filter(r => r.date >= yr+'-02-01' && r.date <= yr+'-02-28');
  const answer = feb.reduce((sum,r) => sum + r.actual, 0);
`, (r) => approxEq(r, 324379));

codeTest('March total actual', `
  const years = [...new Set(data.map(r => r.date.slice(0,4)))].sort();
  const yr = years[years.length-1];
  const mar = data.filter(r => r.date >= yr+'-03-01' && r.date <= yr+'-03-31');
  const answer = mar.reduce((sum,r) => sum + r.actual, 0);
`, (r) => approxEq(r, 356518));

codeTest('March avg efficiency', `
  const years = [...new Set(data.map(r => r.date.slice(0,4)))].sort();
  const yr = years[years.length-1];
  const mar = data.filter(r => r.date >= yr+'-03-01' && r.date <= yr+'-03-31' && r.efficiency !== null);
  const answer = mar.length ? parseFloat((mar.reduce((s,r) => s+r.efficiency, 0) / mar.length).toFixed(1)) : null;
`, (r) => approxEq(r, 76.7, 0.5));

codeTest('March shift A total', `
  const years = [...new Set(data.map(r => r.date.slice(0,4)))].sort();
  const yr = years[years.length-1];
  const d = data.filter(r => r.date >= yr+'-03-01' && r.date <= yr+'-03-31' && r.shift === 'A');
  const answer = d.reduce((s,r) => s + r.actual, 0);
`, (r) => approxEq(r, 120907));

codeTest('April shift A avg efficiency', `
  const years = [...new Set(data.map(r => r.date.slice(0,4)))].sort();
  const yr = years[years.length-1];
  const d = data.filter(r => r.date >= yr+'-04-01' && r.date <= yr+'-04-30' && r.shift === 'A' && r.efficiency !== null);
  const answer = d.length ? parseFloat((d.reduce((s,r) => s+r.efficiency, 0) / d.length).toFixed(1)) : null;
`, (r) => approxEq(r, 76.4, 1));

// ── SECTION 6: Week-based queries (LLM gold-standard) ───────────────────────
console.log('\n══════════ 6. WEEK-BASED QUERIES (simulated LLM code execution) ══════════');

codeTest('Second week of February — total actual', `
  const years = [...new Set(data.map(r => r.date.slice(0,4)))].sort();
  const yr = years[years.length-1];
  const d = data.filter(r => r.date >= yr+'-02-08' && r.date <= yr+'-02-14');
  const answer = d.reduce((s,r) => s + r.actual, 0);
`, (r) => approxEq(r, 79599));

codeTest('Second week of February — avg efficiency', `
  const years = [...new Set(data.map(r => r.date.slice(0,4)))].sort();
  const yr = years[years.length-1];
  const d = data.filter(r => r.date >= yr+'-02-08' && r.date <= yr+'-02-14' && r.efficiency !== null);
  const answer = d.length ? parseFloat((d.reduce((s,r) => s+r.efficiency, 0) / d.length).toFixed(1)) : null;
`, (r) => approxEq(r, 75.8, 1));

codeTest('First week of January — total actual', `
  const years = [...new Set(data.map(r => r.date.slice(0,4)))].sort();
  const yr = years[years.length-1];
  const d = data.filter(r => r.date >= yr+'-01-01' && r.date <= yr+'-01-07');
  const answer = d.reduce((s,r) => s + r.actual, 0);
`, (r) => { return r !== null && r > 0 && r < 344637; });

codeTest('Third week of February — total actual', `
  const years = [...new Set(data.map(r => r.date.slice(0,4)))].sort();
  const yr = years[years.length-1];
  const d = data.filter(r => r.date >= yr+'-02-15' && r.date <= yr+'-02-21');
  const answer = d.reduce((s,r) => s + r.actual, 0);
`, (r) => approxEq(r, 82279));

codeTest('Best week in February (highest total)', `
  const years = [...new Set(data.map(r => r.date.slice(0,4)))].sort();
  const yr = years[years.length-1];
  const feb = data.filter(r => r.date >= yr+'-02-01' && r.date <= yr+'-02-28');
  const weeks = { w1: 0, w2: 0, w3: 0, w4: 0 };
  feb.forEach(r => {
    const d = parseInt(r.date.slice(8, 10));
    if (d <= 7) weeks.w1 += r.actual;
    else if (d <= 14) weeks.w2 += r.actual;
    else if (d <= 21) weeks.w3 += r.actual;
    else weeks.w4 += r.actual;
  });
  const best = Object.entries(weeks).sort((a,b) => b[1]-a[1])[0];
  const answer = { week: best[0], total: best[1] };
`, (r) => r && r.week === 'w3' && approxEq(r.total, 82279));

// ── SECTION 7: Quarter queries (LLM gold-standard) ──────────────────────────
console.log('\n══════════ 7. QUARTER QUERIES (simulated LLM code execution) ══════════');

codeTest('Q1 total actual', `
  const years = [...new Set(data.map(r => r.date.slice(0,4)))].sort();
  const yr = years[years.length-1];
  const q1 = data.filter(r => r.date >= yr+'-01-01' && r.date <= yr+'-03-31');
  const answer = q1.reduce((s,r) => s + r.actual, 0);
`, (r) => approxEq(r, 344637+324379+356518, 5));

codeTest('Q1 total wastage', `
  const years = [...new Set(data.map(r => r.date.slice(0,4)))].sort();
  const yr = years[years.length-1];
  const q1 = data.filter(r => r.date >= yr+'-01-01' && r.date <= yr+'-03-31');
  const answer = q1.reduce((s,r) => s + r.wastage, 0);
`, (r) => approxEq(r, 121315));

codeTest('Q2 shift B total downtime', `
  const years = [...new Set(data.map(r => r.date.slice(0,4)))].sort();
  const yr = years[years.length-1];
  const d = data.filter(r => r.date >= yr+'-04-01' && r.date <= yr+'-06-30' && r.shift === 'B');
  const answer = d.reduce((s,r) => s + r.downtime, 0);
`, (r) => approxEq(r, 997));

codeTest('Month with highest production', `
  const byMonth = {};
  data.forEach(r => { const m = r.date.slice(0,7); byMonth[m] = (byMonth[m] || 0) + r.actual; });
  const best = Object.entries(byMonth).sort((a,b) => b[1]-a[1])[0];
  const answer = { month: best[0], total: best[1] };
`, (r) => r && r.month === '2025-03' && approxEq(r.total, 356518));

// ── SECTION 8: Complex / multi-condition queries ────────────────────────────
console.log('\n══════════ 8. COMPLEX MULTI-CONDITION QUERIES ══════════');

codeTest('Shifts with efficiency > 100%', `
  const d = data.filter(r => r.efficiency !== null && r.efficiency > 100);
  const answer = d.length;
`, (r) => approxEq(r, 48));

codeTest('Shifts where downtime>40 AND efficiency<70', `
  const d = data.filter(r => r.downtime > 40 && r.efficiency !== null && r.efficiency < 70);
  const answer = d.length;
`, (r) => approxEq(r, 19));

codeTest('Average downtime when efficiency < 70%', `
  const d = data.filter(r => r.efficiency !== null && r.efficiency < 70);
  const answer = d.length ? parseFloat((d.reduce((s,r) => s+r.downtime, 0) / d.length).toFixed(1)) : null;
`, (r) => approxEq(r, 23.1, 0.5));

codeTest('Days with total downtime > 100 min', `
  const byDate = {};
  data.forEach(r => { byDate[r.date] = (byDate[r.date] || 0) + r.downtime; });
  const answer = Object.values(byDate).filter(v => v > 100).length;
`, (r) => approxEq(r, 10));

codeTest('% of shifts with any downtime', `
  const withDT = data.filter(r => r.downtime > 0).length;
  const answer = parseFloat((withDT / data.length * 100).toFixed(1));
`, (r) => approxEq(r, 97.5, 0.5));

codeTest('Shifts producing > 5000 units (above target)', `
  const answer = data.filter(r => r.actual > 5000).length;
`, (r) => approxEq(r, 50));

codeTest('Average efficiency when utilisation >= 95%', `
  const d = data.filter(r => r.utilisation >= 95 && r.efficiency !== null);
  const answer = d.length ? parseFloat((d.reduce((s,r) => s+r.efficiency, 0) / d.length).toFixed(1)) : null;
`, (r) => approxEq(r, 77.5, 1));

// ── SECTION 9: Ranking / Top-N queries ─────────────────────────────────────
console.log('\n══════════ 9. RANKING / TOP-N QUERIES ══════════');

codeTest('Top 3 production dates', `
  const byDate = {};
  data.forEach(r => { byDate[r.date] = (byDate[r.date] || 0) + r.actual; });
  const answer = Object.entries(byDate).sort((a,b) => b[1]-a[1]).slice(0,3).map(([date, total]) => ({ date, total }));
`, (r) => Array.isArray(r) && r.length === 3 && r[0].date === '2025-05-07');

codeTest('Worst production day', `
  const byDate = {};
  data.forEach(r => { byDate[r.date] = (byDate[r.date] || 0) + r.actual; });
  const worst = Object.entries(byDate).sort((a,b) => a[1]-b[1])[0];
  const answer = { date: worst[0], total: worst[1] };
`, (r) => r && r.date === '2025-01-01' && approxEq(r.total, 9293));

codeTest('Shift C worst efficiency day', `
  const d = data.filter(r => r.shift === 'C' && r.efficiency !== null);
  const worst = d.reduce((a,b) => b.efficiency < a.efficiency ? b : a);
  const answer = { date: worst.date, efficiency: worst.efficiency };
`, (r) => r && r.date === '2025-02-28' && approxEq(r.efficiency, 32));

codeTest('Shift B best efficiency day', `
  const d = data.filter(r => r.shift === 'B' && r.efficiency !== null);
  const best = d.reduce((a,b) => b.efficiency > a.efficiency ? b : a);
  const answer = { date: best.date, efficiency: best.efficiency };
`, (r) => r && r.date === '2025-02-06' && approxEq(r.efficiency, 121));

codeTest('Highest single shift production (date and shift)', `
  const best = data.reduce((a,b) => b.actual > a.actual ? b : a);
  const answer = { date: best.date, shift: best.shift, actual: best.actual };
`, (r) => r && r.date === '2025-03-25' && r.shift === 'A' && approxEq(r.actual, 6520));

codeTest('Which shift has most total wastage', `
  const byShift = {};
  data.forEach(r => { byShift[r.shift] = (byShift[r.shift] || 0) + r.wastage; });
  const best = Object.entries(byShift).sort((a,b) => b[1]-a[1])[0];
  const answer = { shift: best[0], wastage: best[1] };
`, (r) => r && r.shift === 'B');

codeTest('Month with most downtime', `
  const byMonth = {};
  data.forEach(r => { const m = r.date.slice(0,7); byMonth[m] = (byMonth[m] || 0) + r.downtime; });
  const best = Object.entries(byMonth).sort((a,b) => b[1]-a[1])[0];
  const answer = { month: best[0], downtime: best[1] };
`, (r) => r && r.month === '2025-04' && approxEq(r.downtime, 2163));

// ── SECTION 10: Trend / Comparison queries ──────────────────────────────────
console.log('\n══════════ 10. TREND / COMPARISON QUERIES ══════════');

codeTest('Monthly avg efficiency trend', `
  const byMonth = {};
  data.filter(r => r.efficiency !== null).forEach(r => {
    const m = r.date.slice(0,7);
    if (!byMonth[m]) byMonth[m] = { sum: 0, cnt: 0 };
    byMonth[m].sum += r.efficiency; byMonth[m].cnt++;
  });
  const answer = Object.entries(byMonth).sort().reduce((obj, [m, {sum, cnt}]) => {
    obj[m] = parseFloat((sum/cnt).toFixed(1)); return obj;
  }, {});
`, (r) => r && Math.abs((r['2025-01'] || 0) - 74.1) < 1 && Math.abs((r['2025-03'] || 0) - 76.7) < 1);

codeTest('Shift A vs B vs C avg efficiency comparison', `
  const byShift = {};
  data.filter(r => r.efficiency !== null).forEach(r => {
    if (!byShift[r.shift]) byShift[r.shift] = { sum: 0, cnt: 0 };
    byShift[r.shift].sum += r.efficiency; byShift[r.shift].cnt++;
  });
  const answer = Object.entries(byShift).reduce((obj, [s, {sum, cnt}]) => {
    obj[s] = parseFloat((sum/cnt).toFixed(1)); return obj;
  }, {});
`, (r) => r && Math.abs((r['A']||0) - 76.6) < 1 && Math.abs((r['B']||0) - 78.7) < 1 && Math.abs((r['C']||0) - 73.6) < 1);

codeTest('Shift improvement Jan vs May avg efficiency', `
  const getMonthShiftEff = (yr_m, shift) => {
    const d = data.filter(r => r.date.startsWith(yr_m) && r.shift === shift && r.efficiency !== null);
    return d.length ? parseFloat((d.reduce((s,r) => s+r.efficiency,0)/d.length).toFixed(1)) : null;
  };
  const answer = {
    A: { jan: getMonthShiftEff('2025-01','A'), may: getMonthShiftEff('2025-05','A') },
    B: { jan: getMonthShiftEff('2025-01','B'), may: getMonthShiftEff('2025-05','B') },
    C: { jan: getMonthShiftEff('2025-01','C'), may: getMonthShiftEff('2025-05','C') }
  };
`, (r) => r && Math.abs((r.A.jan||0) - 74.7) < 1 && Math.abs((r.A.may||0) - 80.4) < 1 && Math.abs((r.C.may||0) - 79.8) < 1);

codeTest('Avg wastage rate by shift', `
  const byShift = {};
  data.forEach(r => {
    if (!byShift[r.shift]) byShift[r.shift] = { sum: 0, cnt: 0 };
    byShift[r.shift].sum += r.wastageRate; byShift[r.shift].cnt++;
  });
  const answer = Object.entries(byShift).reduce((obj, [s,{sum,cnt}]) => {
    obj[s] = parseFloat((sum/cnt).toFixed(2)); return obj;
  }, {});
`, (r) => r && Math.abs((r['A']||0) - 11.1) < 0.5 && Math.abs((r['B']||0) - 12.06) < 0.5);

codeTest('Average utilisation by shift', `
  const byShift = {};
  data.forEach(r => {
    if (!byShift[r.shift]) byShift[r.shift] = { sum: 0, cnt: 0 };
    byShift[r.shift].sum += r.utilisation; byShift[r.shift].cnt++;
  });
  const answer = Object.entries(byShift).reduce((obj, [s,{sum,cnt}]) => {
    obj[s] = parseFloat((sum/cnt).toFixed(1)); return obj;
  }, {});
`, (r) => r && Math.abs((r['A']||0) - 95.5) < 0.5 && Math.abs((r['B']||0) - 95.5) < 0.5 && Math.abs((r['C']||0) - 95.2) < 0.5);

// ── SECTION 11: Edge cases & tricky phrasings ────────────────────────────────
console.log('\n══════════ 11. EDGE CASES & TRICKY PHRASINGS ══════════');

fastTest('Best shift (highest eff)', 'which shift has the highest efficiency', (r,inst,unresolved) => {
  // Either resolved locally returning B info, or correctly routed to LLM
  if (unresolved) return true;
  return r !== null;
});

codeTest('Days where efficiency was exactly 100%', `
  const d = data.filter(r => r.efficiency === 100);
  const answer = d.map(r => ({ date: r.date, shift: r.shift }));
`, (r) => Array.isArray(r));

codeTest('Year 2025 total production (full year filter)', `
  const d = data.filter(r => r.date.startsWith('2025'));
  const answer = d.reduce((s,r) => s + r.actual, 0);
`, (r) => approxEq(r, 1510549));

codeTest('Production by shift in February', `
  const years = [...new Set(data.map(r => r.date.slice(0,4)))].sort();
  const yr = years[years.length-1];
  const feb = data.filter(r => r.date >= yr+'-02-01' && r.date <= yr+'-02-28');
  const byShift = {};
  feb.forEach(r => { byShift[r.shift] = (byShift[r.shift] || 0) + r.actual; });
  const answer = byShift;
`, (r) => r && r['A'] !== undefined && r['B'] !== undefined && r['C'] !== undefined);

codeTest('Shift with highest avg headcount', `
  const byShift = {};
  data.forEach(r => {
    if (!byShift[r.shift]) byShift[r.shift] = { sum: 0, cnt: 0 };
    byShift[r.shift].sum += r.headcount; byShift[r.shift].cnt++;
  });
  const avgs = Object.entries(byShift).map(([s,{sum,cnt}]) => ({ shift: s, avg: sum/cnt }));
  const best = avgs.sort((a,b) => b.avg-a.avg)[0];
  const answer = best.shift;
`, (r) => r === 'C');

codeTest('Count shifts where productivity > 200 units/person', `
  const answer = data.filter(r => r.productivity > 200).length;
`, (r) => typeof r === 'number' && r >= 0);

// ── Final report ──────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
console.log(`PASSED: ${passed}   FAILED: ${failed}   TOTAL: ${passed+failed}`);
if (failures.length) {
  console.log('\n─── FAILURES ───');
  failures.forEach((f,i) => {
    console.log(`\n${i+1}. ${f.label} [${f.type}]`);
    if (f.type === 'fast') console.log(`   Q: "${f.question}"`);
    else console.log(`   Code: ${f.jsCode}`);
    console.log(`   Got: ${JSON.stringify(f.result)}`);
  });
}
