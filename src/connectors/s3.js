'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

let S3Client, ListObjectsV2Command, GetObjectCommand;
try {
  const sdk = require('@aws-sdk/client-s3');
  S3Client               = sdk.S3Client;
  ListObjectsV2Command   = sdk.ListObjectsV2Command;
  GetObjectCommand       = sdk.GetObjectCommand;
} catch (_) {}

const SUPPORTED_EXTS = /\.(csv|tsv|json|parquet|xlsx|xls|xlsm)$/i;

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

  // GET /api/s3/defaults — return env-var defaults so UI can pre-fill
  app.get('/api/s3/defaults', (req, res) => {
    res.json({
      region:          process.env.AWS_DEFAULT_REGION  || '',
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID   || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ? '••••••••' : '',
      bucket:          process.env.AWS_S3_BUCKET        || '',
      hasEnvCreds:     !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
    });
  });

  // POST /api/s3/browse — list files in bucket (falls back to env vars)
  app.post('/api/s3/browse', async (req, res) => {
    const region          = req.body.region          || process.env.AWS_DEFAULT_REGION   || '';
    const accessKeyId     = req.body.accessKeyId     || process.env.AWS_ACCESS_KEY_ID    || '';
    const secretAccessKey = req.body.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '';
    const bucket          = req.body.bucket          || process.env.AWS_S3_BUCKET         || '';
    const prefix          = req.body.prefix          || '';
    if (!region || !accessKeyId || !secretAccessKey || !bucket)
      return res.status(400).json({ error: 'Missing region, accessKeyId, secretAccessKey, or bucket.' });
    try {
      const files = await listFiles(region, accessKeyId, secretAccessKey, bucket, prefix);
      res.json({ files, bucket, prefix });
    } catch (e) {
      let msg = e.message || String(e);
      if (/PermanentRedirect|specified endpoint/i.test(msg))
        msg = `Bucket "${bucket}" is not in region "${region}". Open the S3 console, find the actual bucket region, and enter it in the Region field.`;
      else if (/InvalidAccessKeyId|AccessDenied|NoCredentialProvider/i.test(msg))
        msg = 'Invalid credentials. Check your Access Key ID and Secret Access Key.';
      else if (/NoSuchBucket/i.test(msg))
        msg = `Bucket "${bucket}" does not exist in region "${region}".`;
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/s3/load — download + register one file (falls back to env vars)
  app.post('/api/s3/load', async (req, res) => {
    const region          = req.body.region          || process.env.AWS_DEFAULT_REGION    || '';
    const accessKeyId     = req.body.accessKeyId     || process.env.AWS_ACCESS_KEY_ID     || '';
    const secretAccessKey = req.body.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '';
    const bucket          = req.body.bucket          || process.env.AWS_S3_BUCKET          || '';
    const key             = req.body.key             || '';
    if (!region || !accessKeyId || !secretAccessKey || !bucket || !key)
      return res.status(400).json({ error: 'Missing region, accessKeyId, secretAccessKey, bucket, or key.' });
    try {
      const tables = await loadFile(region, accessKeyId, secretAccessKey, bucket, key);
      res.json({ tables });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { attachRoutes };
