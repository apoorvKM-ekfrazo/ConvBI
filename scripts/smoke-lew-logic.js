'use strict';

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3001';
const SAMPLE_CSV = process.env.SMOKE_SAMPLE_CSV || path.join(process.cwd(), 'shift_data_template.csv');

const REQUIRED_TAGS = [
  '##DIRECT_ANSWER##',
  '##WHAT_HAPPENED##',
  '##WHY_HAPPENED##',
  '##SUPPORTING_EVIDENCE##',
  '##BUSINESS_IMPACT##',
  '##RECOMMENDED_ACTION##'
];

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`${url} failed: ${data.error || resp.statusText}`);
  return data;
}

function parseSections(text) {
  const src = String(text || '');
  const tags = [
    'DIRECT_ANSWER',
    'WHAT_HAPPENED',
    'WHY_HAPPENED',
    'SUPPORTING_EVIDENCE',
    'BUSINESS_IMPACT',
    'RECOMMENDED_ACTION'
  ];
  const out = {};
  for (const t of tags) {
    const re = new RegExp(`##${t}##\\s*([\\s\\S]*?)(?=##(?:${tags.join('|')})##|$)`, 'i');
    const m = src.match(re);
    out[t] = m ? m[1].trim() : '';
  }
  return out;
}

async function uploadSampleCsv() {
  if (!fs.existsSync(SAMPLE_CSV)) {
    throw new Error(`Sample CSV not found: ${SAMPLE_CSV}`);
  }
  const bytes = fs.readFileSync(SAMPLE_CSV);
  const form = new FormData();
  form.append('files', new Blob([bytes], { type: 'text/csv' }), path.basename(SAMPLE_CSV));
  const resp = await fetch(`${BASE_URL}/api/upload-files`, { method: 'POST', body: form });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`/api/upload-files failed: ${data.error || resp.statusText}`);
  return data;
}

(async () => {
  try {
    console.log(`[smoke] Base URL: ${BASE_URL}`);

    const ping = await fetch(`${BASE_URL}/api/ping`).then(r => r.json());
    if (ping.status !== 'ok') throw new Error('Ping failed');
    console.log('[smoke] Ping OK');

    await uploadSampleCsv();
    console.log('[smoke] Upload OK');

    const tablesData = await fetch(`${BASE_URL}/api/tables`).then(r => r.json());
    const tableNames = Object.keys(tablesData.tables || {});
    if (!tableNames.length) throw new Error('No tables after upload');
    console.log(`[smoke] Tables loaded: ${tableNames.join(', ')}`);

    const semanticModel = await fetch(`${BASE_URL}/api/semantic-model`).then(r => r.json());
    if (!semanticModel.semanticModel) throw new Error('Semantic model missing');
    console.log('[smoke] Semantic model OK');

    const question = 'Which shift has the highest total actual_units?';
    const relationships = await postJson(`${BASE_URL}/api/detect-relationships`, {});
    const decode = await postJson(`${BASE_URL}/api/decode-intent`, {
      question,
      schemaProfile: tablesData.tables,
      relationships,
      conversationContext: []
    });
    if (!decode.decoded) throw new Error('Intent decode missing');
    console.log('[smoke] Intent decode OK');

    const gen = await postJson(`${BASE_URL}/api/generate-code`, {
      question,
      allTableSchemas: tablesData.tables,
      relationships,
      decodedIntent: decode.decoded
    });
    if (!gen.code) throw new Error('SQL generation missing');
    console.log('[smoke] SQL generation OK');

    const exec = await postJson(`${BASE_URL}/api/execute-sql`, { sql: gen.code });
    if (!Array.isArray(exec.rows)) throw new Error('Execution rows missing');
    console.log(`[smoke] SQL execution OK (${exec.rows.length} rows)`);

    const interp = await postJson(`${BASE_URL}/api/interpret`, {
      question,
      decodedIntent: decode.decoded,
      sql: gen.code,
      result: exec.rows.slice(0, 30)
    });
    const answer = String(interp.answer || '');
    const missing = REQUIRED_TAGS.filter(t => !answer.includes(t));
    if (missing.length) throw new Error(`Narration missing tags: ${missing.join(', ')}`);
    const sections = parseSections(answer);
    for (const [k, v] of Object.entries(sections)) {
      if (!v) throw new Error(`Empty section: ${k}`);
    }
    console.log('[smoke] 6-part Lew narration OK');

    const summary = await postJson(`${BASE_URL}/api/generate-executive-summary`, {
      question,
      sections: {
        directAnswer: sections.DIRECT_ANSWER,
        whatHappened: sections.WHAT_HAPPENED,
        whyHappened: sections.WHY_HAPPENED,
        supportingEvidence: sections.SUPPORTING_EVIDENCE,
        businessImpact: sections.BUSINESS_IMPACT,
        recommendedAction: sections.RECOMMENDED_ACTION
      },
      sql: gen.code,
      rowsPreview: exec.rows.slice(0, 20)
    });
    const summaryText = String(summary.summary || '');
    if (!summaryText.includes('Key Finding:') || !summaryText.includes('Business Impact:') || !summaryText.includes('Next Best Action:')) {
      throw new Error('Executive summary does not match required format');
    }
    console.log('[smoke] Executive summary format OK');

    const report = await postJson(`${BASE_URL}/api/export-report`, {
      question,
      sections: {
        directAnswer: sections.DIRECT_ANSWER,
        whatHappened: sections.WHAT_HAPPENED,
        whyHappened: sections.WHY_HAPPENED,
        supportingEvidence: sections.SUPPORTING_EVIDENCE,
        businessImpact: sections.BUSINESS_IMPACT,
        recommendedAction: sections.RECOMMENDED_ACTION
      },
      sql: gen.code,
      tablesUsed: decode.decoded.tables_needed || tableNames,
      generatedAt: new Date().toISOString()
    });
    const reportText = String(report.content || '');
    if (!reportText.includes('## 1) Direct Answer') || !reportText.includes('## 6) Recommended Action')) {
      throw new Error('Report export missing required sections');
    }
    if (/powerpoint|pptx|\.ppt/i.test(reportText)) {
      throw new Error('Report contains forbidden PPT references');
    }
    console.log('[smoke] Report export OK');

    console.log('[smoke] PASS');
    process.exit(0);
  } catch (e) {
    console.error('[smoke] FAIL:', e.message);
    process.exit(1);
  }
})();
