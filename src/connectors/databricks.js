'use strict';
// Databricks SQL connector — rebuilt cleanly using the REST statement API
// (does not require @databricks/sql — uses plain fetch which is built-in to Node 18+)

const cm = require('./connection-manager');

function parseHost(raw) {
  return raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function extractWarehouseId(httpPath) {
  const m = httpPath.match(/\/warehouses\/([a-f0-9]+)/i);
  return m ? m[1] : null;
}

async function databricksSQL(hostname, token, httpPath, sql) {
  const warehouseId = extractWarehouseId(httpPath);
  if (!warehouseId) throw new Error('Could not parse warehouse_id from http_path. Expected pattern: /sql/1.0/warehouses/<id>');

  const url = `https://${parseHost(hostname)}/api/2.0/sql/statements`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      warehouse_id: warehouseId,
      statement:    sql,
      wait_timeout: '60s',
      format:       'JSON_ARRAY',
      disposition:  'INLINE'
    })
  });
  if (res.status === 403) throw new Error('Authentication failed — verify your Databricks PAT token');
  const result = await res.json();
  if (!res.ok || result.status?.state === 'FAILED') {
    const msg = result.status?.error?.message || result.message || JSON.stringify(result).slice(0, 400);
    throw new Error(msg);
  }
  const cols = result.manifest?.schema?.columns || [];
  const rows = (result.result?.data_array || []).map(row => {
    const obj = {};
    cols.forEach((c, i) => { obj[c.name] = row[i]; });
    return obj;
  });
  return { columns: cols.map(c => ({ name: c.name, type: c.type_text || 'STRING' })), rows };
}

function attachRoutes(app) {

  // POST /api/connect/databricks/test
  app.post('/api/connect/databricks/test', async (req, res) => {
    const { host, token, httpPath } = req.body;
    if (!host || !token || !httpPath) return res.status(400).json({ error: 'Missing host, token, or httpPath.' });
    try {
      await databricksSQL(host, token, httpPath, 'SELECT 1 AS ping');
      res.json({ connected: true, host: parseHost(host) });
    } catch (e) {
      res.json({ connected: false, error: e.message });
    }
  });

  // POST /api/connect/databricks/browse
  app.post('/api/connect/databricks/browse', async (req, res) => {
    const { host, token, httpPath, catalog, schema } = req.body;
    if (!host || !token || !httpPath) return res.status(400).json({ error: 'Missing connection params.' });
    try {
      if (!catalog) {
        const r = await databricksSQL(host, token, httpPath, 'SHOW CATALOGS');
        const catalogs = r.rows.map(row => Object.values(row)[0]).filter(Boolean);
        return res.json({ catalogs });
      }
      if (!schema) {
        const r = await databricksSQL(host, token, httpPath, `SHOW SCHEMAS IN \`${catalog}\``);
        const schemas = r.rows.map(row => row.databaseName || Object.values(row)[0]).filter(Boolean);
        return res.json({ schemas });
      }
      const r = await databricksSQL(host, token, httpPath, `SHOW TABLES IN \`${catalog}\`.\`${schema}\``);
      const tables = r.rows.map(row => ({ name: row.tableName || Object.values(row)[0], isTemporary: row.isTemporary === 'true' })).filter(t => t.name);
      res.json({ tables });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/connect/databricks/load
  app.post('/api/connect/databricks/load', async (req, res) => {
    const { host, token, httpPath, catalog, schema, tableIds, limit = 50000 } = req.body;
    if (!host || !token || !httpPath || !tableIds?.length)
      return res.status(400).json({ error: 'Missing connection params or tableIds.' });

    const safeLimit = Math.min(parseInt(limit, 10) || 50000, 200000);
    const loaded = [], errors = [];

    for (const tableId of tableIds) {
      // Validate tableId: allow only word chars, dots, backtick-wrapped segments
      if (!/^[\w`.]+$/.test(tableId)) {
        errors.push({ tableId, error: 'Invalid table identifier' });
        continue;
      }
      const fullName = catalog && schema
        ? `\`${catalog}\`.\`${schema}\`.\`${tableId}\``
        : tableId;
      try {
        const r = await databricksSQL(host, token, httpPath, `SELECT * FROM ${fullName} LIMIT ${safeLimit}`);
        const shortName = tableId.split('.').pop() || tableId;
        const reg = await cm.registerTable(shortName, r.rows, {
          source: 'databricks', sourceLabel: `Databricks: ${fullName}`,
          catalog, schema, originalTable: tableId
        });
        loaded.push(reg);
      } catch (e) {
        errors.push({ tableId, error: e.message });
      }
    }

    if (!loaded.length && errors.length) return res.status(500).json({ error: errors[0].error, errors });
    res.json({ tables: loaded, errors: errors.length ? errors : undefined });
  });
}

module.exports = { attachRoutes };
