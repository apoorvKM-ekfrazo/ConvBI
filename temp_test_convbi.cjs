const fs = require('fs');
const code = fs.readFileSync('script.js','utf8');
const stub = `const window={addEventListener(){}}; const document={createElement(){return{href:'',download:'',click(){}}},getElementById(){return null},querySelectorAll(){return[]},querySelector(){return null}}; const Chart=function(){};`;
const api = new Function(stub + '\n' + code + '\nreturn { parseLocalInstruction, filterRows, executeParsedInstruction };')();
const csv = fs.readFileSync('shift_data_template.csv','utf8').trim().split(/\r?\n/);
const headers = csv[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g,'_'));
const rows = csv.slice(1).map(line => {
  const vals = line.split(',');
  const r = {};
  headers.forEach((h,i) => r[h] = (vals[i] || '').trim());
  return r;
}).map(r => ({
  ...r,
  target: parseFloat(r.target_units) || 0,
  actual: parseFloat(r.actual_units) || 0,
  wastage: parseFloat(r.wastage_units) || 0,
  downtime: parseFloat(r.downtime_minutes) || 0,
  headcount: parseFloat(r.headcount) || 0,
  utilisation: parseFloat(r.machine_utilisation_pct) || 0,
  efficiency: r.target_units ? Math.round((parseFloat(r.actual_units) || 0) / (parseFloat(r.target_units) || 1) * 100) : 0,
  productivity: parseFloat(r.headcount) ? parseFloat((parseFloat(r.actual_units) || 0) / parseFloat(r.headcount)).toFixed(1) : 0,
  shift: (r.shift || '').toUpperCase(),
  date: r.date
}));
function test(question){
  const instruction = api.parseLocalInstruction(question);
  const answer = api.executeParsedInstruction(instruction, rows, question);
  console.log('QUESTION:', question);
  console.log('INSTRUCTION:', JSON.stringify(instruction, null, 2));
  console.log('ANSWER:', answer);
  console.log('---');
}
[
  'calculate average wastage_units from 1/1/2025 to 1/3/2025',
  'list the days and the shift where the downtime was 0',
  'before 1/9/2025, when was the highest machine_utilisation_pct?'
].forEach(test);
