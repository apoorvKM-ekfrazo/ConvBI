'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const cm   = require('./connection-manager');

let multer, XLSX, Papa;
try { multer = require('multer'); } catch (_) {}
try { XLSX   = require('xlsx');   } catch (_) {}
try { Papa   = require('papaparse'); } catch (_) {}

// ── multer storage: temp directory ───────────────────────────────────────────
function buildMulter() {
  if (!multer) throw new Error('multer not installed. Run: npm install multer');
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename:    (req, file, cb) => cb(null, `convbi_${Date.now()}_${file.originalname}`)
  });
  return multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500 MB
}

// ── parse one file and register as DuckDB table(s) ───────────────────────────
async function parseAndRegister(filePath, originalName, sourceMeta = {}, opts = {}) {
  const ext  = path.extname(originalName).toLowerCase().replace('.', '');
  const base = path.basename(originalName, path.extname(originalName))
    .replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');

  const defaultMeta = { source: 'file', sourceLabel: originalName };
  const meta = { ...defaultMeta, ...sourceMeta };  // caller can override source/sourceLabel

  const results = [];

  if (ext === 'csv' || ext === 'tsv') {
    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = parseCSVText(text, ext === 'tsv' ? '\t' : ',');
    if (!parsed.length) throw new Error(`No rows found in ${originalName}`);
    const r = await cm.registerTable(base, parsed, meta);
    results.push({ ...r, sheetName: null });

  } else if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') {
    if (!XLSX) throw new Error('xlsx package not installed. Run: npm install xlsx');
    const wb = XLSX.readFile(filePath);
    const requestedSheets = Array.isArray(opts.sheetNames) ? opts.sheetNames.map(String) : [];
    const selectedSheets = requestedSheets.length ? wb.SheetNames.filter(n => requestedSheets.includes(n)) : wb.SheetNames;
    for (const sheetName of selectedSheets) {
      const ws   = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
      if (!rows.length) continue;
      const tableName = `${base}_${sheetName}`.replace(/[^a-zA-Z0-9_]/g, '_');
      const r = await cm.registerTable(tableName, rows, { ...meta, sourceLabel: meta.sourceLabel + ` → ${sheetName}` });
      results.push({ ...r, sheetName });
    }

    if (requestedSheets.length && !results.length) {
      throw new Error(`No rows found in selected sheets for ${originalName}`);
    }

  } else if (ext === 'parquet') {
    const r = await cm.registerFromFile(base, filePath, 'parquet', meta);
    results.push({ ...r, sheetName: null });

  } else if (ext === 'json') {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rows = Array.isArray(raw) ? raw : (raw.data || raw.rows || Object.values(raw).find(Array.isArray) || [raw]);
    if (!rows.length) throw new Error('No rows in JSON');
    const r = await cm.registerTable(base, rows, meta);
    results.push({ ...r, sheetName: null });

  } else {
    throw new Error(`Unsupported file type: .${ext}`);
  }

  return results;
}

// ── simple CSV parser (fallback if papaparse unavailable) ────────────────────
function parseCSVText(text, delimiter = ',') {
  if (Papa) {
    const r = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true, delimiter });
    return r.data || [];
  }
  // built-in fallback
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0], delimiter).map(h =>
    h.trim().toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'')
  );
  return lines.slice(1).map(line => {
    const vals = splitCSVLine(line, delimiter);
    const row  = {};
    headers.forEach((h, i) => {
      const v = (vals[i] ?? '').trim();
      const n = parseFloat(v);
      row[h]  = !isNaN(n) && v !== '' ? n : v;
    });
    return row;
  }).filter(r => Object.values(r).some(v => v !== ''));
}

function splitCSVLine(line, delimiter = ',') {
  const result = [];
  let field = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i+1] === '"') { field += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === delimiter && !inQ) {
      result.push(field); field = '';
    } else {
      field += ch;
    }
  }
  result.push(field);
  return result;
}

// ── attach upload routes to an Express app ───────────────────────────────────
function attachRoutes(app) {
  const upload = buildMulter();

  // POST /api/upload-excel-sheet-names
  app.post('/api/upload-excel-sheet-names', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    if (!['.xlsx', '.xls', '.xlsm'].includes(ext)) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ error: 'Only Excel files are supported for sheet listing.' });
    }

    try {
      if (!XLSX) throw new Error('xlsx package not installed. Run: npm install xlsx');
      const wb = XLSX.readFile(req.file.path);
      return res.json({ sheetNames: wb.SheetNames || [] });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    } finally {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
  });

  // POST /api/upload-files
  app.post('/api/upload-files', upload.array('files'), async (req, res) => {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files uploaded.' });

    let excelSelection = { mode: 'workbook', perFile: [] };
    try {
      if (req.body && req.body.excelSelection) {
        const parsed = JSON.parse(req.body.excelSelection);
        if (parsed && typeof parsed === 'object') excelSelection = parsed;
      }
    } catch (_) {}

    const tables  = [];
    const errors  = [];

    for (let idx = 0; idx < req.files.length; idx++) {
      const file = req.files[idx];
      try {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const isExcel = ['.xlsx', '.xls', '.xlsm'].includes(ext);
        const perFile = Array.isArray(excelSelection.perFile) ? excelSelection.perFile[idx] : null;
        const sheetNames = isExcel && excelSelection.mode === 'selected' && perFile && Array.isArray(perFile.sheets)
          ? perFile.sheets
          : [];

        const registered = await parseAndRegister(file.path, file.originalname, {}, { sheetNames });
        tables.push(...registered);
      } catch (e) {
        errors.push({ file: file.originalname, error: e.message });
      } finally {
        try { fs.unlinkSync(file.path); } catch (_) {}
      }
    }

    if (!tables.length && errors.length) {
      return res.status(400).json({ error: errors[0].error, errors });
    }
    res.json({ tables, errors: errors.length ? errors : undefined });
  });
}

module.exports = { attachRoutes, parseAndRegister, parseCSVText };
