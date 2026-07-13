'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const profiles = require('./connection-profiles');

let S3Client, ListObjectsV2Command, GetObjectCommand;
try {
  const sdk = require('@aws-sdk/client-s3');
  S3Client               = sdk.S3Client;
  ListObjectsV2Command   = sdk.ListObjectsV2Command;
  GetObjectCommand       = sdk.GetObjectCommand;
} catch (_) {}

const SUPPORTED_EXTS = /\.(csv|tsv|json|parquet|xlsx|xls|xlsm)$/i;

function mask(value = '', keep = 4) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.length <= keep) return '*'.repeat(Math.max(4, s.length));
  return `${'*'.repeat(Math.max(4, s.length - keep))}${s.slice(-keep)}`;
}

function defaultS3Creds() {
  return {
    region: String(process.env.AWS_DEFAULT_REGION || '').trim(),
    accessKeyId: String(process.env.AWS_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(process.env.AWS_SECRET_ACCESS_KEY || '').trim(),
    bucket: String(process.env.AWS_S3_BUCKET || '').trim(),
    prefix: String(process.env.AWS_S3_PREFIX || '').trim()
  };
}

function hasS3Creds(c) {
  return !!(c.region && c.accessKeyId && c.secretAccessKey && c.bucket);
}

function resolveConnection(body = {}) {
  const profileId = String(body.profileId || '').trim();
  if (profileId) {
    const p = profiles.get('s3', profileId);
    if (!p) throw new Error('Saved S3 connection not found.');
    return {
      mode: 'saved',
      profileId: p.id,
      profileName: p.name,
      region: p.region,
      accessKeyId: p.accessKeyId,
      secretAccessKey: p.secretAccessKey,
      bucket: p.bucket,
      prefix: String(body.prefix ?? p.prefix ?? '').trim()
    };
  }

  const manual = {
    region: String(body.region || '').trim(),
    accessKeyId: String(body.accessKeyId || '').trim(),
    secretAccessKey: String(body.secretAccessKey || '').trim(),
    bucket: String(body.bucket || '').trim(),
    prefix: String(body.prefix || '').trim()
  };

  if (hasS3Creds(manual)) {
    return {
      mode: 'new',
      profileName: String(body.profileName || '').trim(),
      ...manual
    };
  }

  const wantsDefault = !!body.useDefault || (!manual.region && !manual.accessKeyId && !manual.secretAccessKey && !manual.bucket);
  if (wantsDefault) {
    const d = defaultS3Creds();
    if (!hasS3Creds(d)) throw new Error('Default S3 credentials are not configured in backend env.');
    return {
      mode: 'default',
      region: d.region,
      accessKeyId: d.accessKeyId,
      secretAccessKey: d.secretAccessKey,
      bucket: d.bucket,
      prefix: String(body.prefix || d.prefix || '').trim()
    };
  }

  throw new Error('Missing S3 connection details.');
}

function registerSuccessfulConnection(conn) {
  if (conn.mode === 'new') {
    return profiles.upsertS3({
      region: conn.region,
      accessKeyId: conn.accessKeyId,
      secretAccessKey: conn.secretAccessKey,
      bucket: conn.bucket,
      prefix: conn.prefix,
      name: conn.profileName
    });
  }
  if (conn.mode === 'saved' && conn.profileId) {
    return profiles.touch('s3', conn.profileId);
  }
  return null;
}

function makeClient(region, accessKeyId, secretAccessKey) {
  if (!S3Client) throw new Error('@aws-sdk/client-s3 not installed. Run: npm install @aws-sdk/client-s3');
  return new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
    followRegionRedirects: true   // auto-follow bucket redirect if region is off
  });
}

// List all supported files in bucket/prefix (up to 500)
async function listFiles(region, accessKeyId, secretAccessKey, bucket, prefix = '') {
  const client = makeClient(region, accessKeyId, secretAccessKey);
  const files  = [];
  let token;

  do {
    const resp = await client.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix,
      MaxKeys: 200, ContinuationToken: token
    }));

    for (const obj of resp.Contents || []) {
      if (SUPPORTED_EXTS.test(obj.Key)) {
        files.push({
          key:          obj.Key,
          name:         path.basename(obj.Key),
          ext:          path.extname(obj.Key).toLowerCase().slice(1),
          sizeBytes:    obj.Size,
          sizeLabel:    formatBytes(obj.Size),
          lastModified: obj.LastModified
        });
      }
    }

    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token && files.length < 500);

  return files;
}

// Download one file from S3 → temp → parse → register in DuckDB
async function loadFile(region, accessKeyId, secretAccessKey, bucket, key) {
  const client = makeClient(region, accessKeyId, secretAccessKey);

  const resp   = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const ext    = path.extname(key).toLowerCase().slice(1);
  const base   = path.basename(key, path.extname(key))
    .replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  const tmpPath = path.join(os.tmpdir(), `convbi_s3_${Date.now()}_${base}.${ext}`);

  // Collect stream → buffer → write
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  fs.writeFileSync(tmpPath, Buffer.concat(chunks));

  // Reuse the file-upload parser — pass S3 source metadata directly
  const { parseAndRegister } = require('./file-upload');
  let results;
  try {
    results = await parseAndRegister(tmpPath, path.basename(key), {
      source:      's3',
      sourceLabel: `s3://${bucket}/${key}`
    });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }

  return results;
}

function formatBytes(b) {
  if (b < 1024)       return b + ' B';
  if (b < 1048576)    return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}

// ── Express routes ────────────────────────────────────────────────────────────
function attachRoutes(app) {

  // GET /api/connect/s3/profiles
  app.get('/api/connect/s3/profiles', (req, res) => {
    const d = defaultS3Creds();
    const defaultAvailable = hasS3Creds(d);
    res.json({
      defaultAvailable,
      defaultConnection: defaultAvailable
        ? {
            id: 'default',
            name: 'Backend Default',
            region: d.region,
            bucket: d.bucket,
            prefix: d.prefix,
            accessKeyIdMask: mask(d.accessKeyId)
          }
        : null,
      saved: profiles.list('s3')
    });
  });

  // GET /api/s3/defaults — return env-var defaults so UI can pre-fill
  app.get('/api/s3/defaults', (req, res) => {
    const d = defaultS3Creds();
    res.json({
      region: d.region,
      accessKeyId: d.accessKeyId,
      secretAccessKey: d.secretAccessKey ? '••••••••' : '',
      bucket: d.bucket,
      hasEnvCreds: hasS3Creds(d)
    });
  });

  // POST /api/s3/browse — list files in bucket (falls back to env vars)
  app.post('/api/s3/browse', async (req, res) => {
    try {
      const conn = resolveConnection(req.body || {});
      const files = await listFiles(conn.region, conn.accessKeyId, conn.secretAccessKey, conn.bucket, conn.prefix);
      const savedProfile = registerSuccessfulConnection(conn);
      res.json({
        files,
        bucket: conn.bucket,
        prefix: conn.prefix,
        mode: conn.mode,
        usedProfileId: savedProfile?.id || conn.profileId || null,
        usedProfileName: savedProfile?.name || conn.profileName || null
      });
    } catch (e) {
      let msg = e.message || String(e);
      const region = String(req.body?.region || '').trim();
      const bucket = String(req.body?.bucket || '').trim();
      if (/PermanentRedirect|specified endpoint/i.test(msg) && region && bucket)
        msg = `Bucket "${bucket}" is not in region "${region}". Open the S3 console, find the actual bucket region, and enter it in the Region field.`;
      else if (/InvalidAccessKeyId|AccessDenied|NoCredentialProvider/i.test(msg))
        msg = 'Invalid credentials. Check your Access Key ID and Secret Access Key.';
      else if (/NoSuchBucket/i.test(msg) && bucket)
        msg = `Bucket "${bucket}" does not exist in region "${region}".`;
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/s3/load — download + register one file (falls back to env vars)
  app.post('/api/s3/load', async (req, res) => {
    const key = String(req.body?.key || '').trim();
    if (!key) return res.status(400).json({ error: 'Missing key.' });
    try {
      const conn = resolveConnection(req.body || {});
      const tables = await loadFile(conn.region, conn.accessKeyId, conn.secretAccessKey, conn.bucket, key);
      const savedProfile = registerSuccessfulConnection(conn);
      res.json({
        tables,
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
