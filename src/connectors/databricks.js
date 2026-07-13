'use strict';
// Databricks SQL connector — rebuilt cleanly using the REST statement API
// (does not require @databricks/sql — uses plain fetch which is built-in to Node 18+)

const cm = require('./connection-manager');
const profiles = require('./connection-profiles');

function parseHost(raw) {
  return raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function extractWarehouseId(httpPath) {
  const m = httpPath.match(/\/warehouses\/([a-f0-9]+)/i);
  return m ? m[1] : null;
}

function defaultDatabricksCreds() {
  return {
    host: String(process.env.DATABRICKS_HOST || '').trim(),
    token: String(process.env.DATABRICKS_TOKEN || '').trim(),
    httpPath: String(process.env.DATABRICKS_HTTP_PATH || '').trim()
  };
}

function hasDatabricksCreds(creds) {
  return !!(creds.host && creds.token && creds.httpPath);
}

function resolveConnection(body = {}) {
  const profileId = String(body.profileId || '').trim();
  if (profileId) {
    const p = profiles.get('databricks', profileId);
    if (!p) throw new Error('Saved Databricks connection not found.');
    return {
      mode: 'saved',
      profileId: p.id,
      profileName: p.name,
      host: parseHost(p.host),
      token: String(p.token || '').trim(),
      httpPath: String(p.httpPath || '').trim()
    };
  }

  const host = parseHost(String(body.host || '').trim());
  const token = String(body.token || '').trim();
  const httpPath = String(body.httpPath || '').trim();
  if (host && token && httpPath) {
    return {
      mode: 'new',
      profileName: String(body.profileName || '').trim(),
      host,
      token,
      httpPath
    };
  }

  const wantsDefault = !!body.useDefault || (!host && !token && !httpPath);
  if (wantsDefault) {
    const d = defaultDatabricksCreds();
    if (!hasDatabricksCreds(d)) throw new Error('Default Databricks credentials are not configured in backend env.');
    return {
      mode: 'default',
      host: parseHost(d.host),
      token: d.token,
      httpPath: d.httpPath
    };
  }

  throw new Error('Missing Databricks connection details.');
}

function registerSuccessfulConnection(conn) {
  if (conn.mode === 'new') {
    return profiles.upsertDatabricks({
      host: conn.host,
      token: conn.token,
      httpPath: conn.httpPath,
      name: conn.profileName
    });
  }
  if (conn.mode === 'saved' && conn.profileId) {
    return profiles.touch('databricks', conn.profileId);
  }
  return null;
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
      wait_timeout: '30s',
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

  // GET /api/connect/databricks/profiles
  app.get('/api/connect/databricks/profiles', (req, res) => {
    const def = defaultDatabricksCreds();
    const defaultAvailable = hasDatabricksCreds(def);
    res.json({
      defaultAvailable,
      defaultConnection: defaultAvailable
        ? {
            id: 'default',
            name: 'Backend Default',
            host: parseHost(def.host),
            httpPath: def.httpPath
          }
        : null,
      saved: profiles.list('databricks')
    });
  });

  // POST /api/connect/databricks/test
  app.post('/api/connect/databricks/test', async (req, res) => {
    try {
      const conn = resolveConnection(req.body || {});
      await databricksSQL(conn.host, conn.token, conn.httpPath, 'SELECT 1 AS ping');
      const savedProfile = registerSuccessfulConnection(conn);
      res.json({
        connected: true,
        host: parseHost(conn.host),
        mode: conn.mode,
        usedProfileId: savedProfile?.id || conn.profileId || null,
        usedProfileName: savedProfile?.name || conn.profileName || null
      });
    } catch (e) {
      res.json({ connected: false, error: e.message });
    }
  });

  // POST /api/connect/databricks/browse
  app.post('/api/connect/databricks/browse', async (req, res) => {
    const { catalog, schema } = req.body || {};
    try {
      const conn = resolveConnection(req.body || {});
      const savedProfile = registerSuccessfulConnection(conn);
      const payload = {
        mode: conn.mode,
        usedProfileId: savedProfile?.id || conn.profileId || null,
        usedProfileName: savedProfile?.name || conn.profileName || null
      };

      if (!catalog) {
        const r = await databricksSQL(conn.host, conn.token, conn.httpPath, 'SHOW CATALOGS');
        const catalogs = r.rows.map(row => Object.values(row)[0]).filter(Boolean);
        return res.json({ ...payload, catalogs });
      }
      if (!schema) {
        const r = await databricksSQL(conn.host, conn.token, conn.httpPath, `SHOW SCHEMAS IN \`${catalog}\``);
        const schemas = r.rows.map(row => row.databaseName || Object.values(row)[0]).filter(Boolean);
        return res.json({ ...payload, schemas });
      }
      const r = await databricksSQL(conn.host, conn.token, conn.httpPath, `SHOW TABLES IN \`${catalog}\`.\`${schema}\``);
      const tables = r.rows.map(row => ({ name: row.tableName || Object.values(row)[0], isTemporary: row.isTemporary === 'true' })).filter(t => t.name);
      res.json({ ...payload, tables });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/connect/databricks/preview
  app.post('/api/connect/databricks/preview', async (req, res) => {
    const { catalog, schema, table } = req.body || {};
    if (!catalog || !schema || !table) return res.status(400).json({ error: 'Missing catalog, schema, or table.' });
    if (!/^[\w`.]+$/.test(table)) return res.status(400).json({ error: 'Invalid table identifier.' });
    try {
      const conn = resolveConnection(req.body || {});
      registerSuccessfulConnection(conn);
      const fullName = `\`${catalog}\`.\`${schema}\`.\`${table}\``;
      const r = await databricksSQL(conn.host, conn.token, conn.httpPath, `SELECT * FROM ${fullName} LIMIT 20`);
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/connect/databricks/load
  app.post('/api/connect/databricks/load', async (req, res) => {
    const { catalog, schema, tableIds, limit = 50000 } = req.body || {};
    if (!Array.isArray(tableIds) || !tableIds.length) {
      return res.status(400).json({ error: 'Missing tableIds.' });
    }

    const safeLimit = Math.min(parseInt(limit, 10) || 50000, 200000);
    const loaded = [], errors = [];

    try {
      const conn = resolveConnection(req.body || {});
      const savedProfile = registerSuccessfulConnection(conn);

      for (const tableId of tableIds) {
        if (!/^[\w`.]+$/.test(tableId)) {
          errors.push({ tableId, error: 'Invalid table identifier' });
          continue;
        }
        const fullName = catalog && schema
          ? `\`${catalog}\`.\`${schema}\`.\`${tableId}\``
          : tableId;
        try {
          const r = await databricksSQL(conn.host, conn.token, conn.httpPath, `SELECT * FROM ${fullName} LIMIT ${safeLimit}`);
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
      res.json({
        tables: loaded,
        errors: errors.length ? errors : undefined,
        mode: conn.mode,
        usedProfileId: savedProfile?.id || conn.profileId || null,
        usedProfileName: savedProfile?.name || conn.profileName || null
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { attachRoutes };
