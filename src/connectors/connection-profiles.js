'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_FILE = path.join(__dirname, '..', '..', 'connection-profiles.json');
const MAX_PER_PROVIDER = 25;

function blankStore() {
  return { databricks: [], s3: [] };
}

function ensureStoreShape(store) {
  const safe = store && typeof store === 'object' ? store : {};
  if (!Array.isArray(safe.databricks)) safe.databricks = [];
  if (!Array.isArray(safe.s3)) safe.s3 = [];
  return safe;
}

function readStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) return blankStore();
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    return ensureStoreShape(JSON.parse(raw));
  } catch (_) {
    return blankStore();
  }
}

function writeStore(store) {
  const safe = ensureStoreShape(store);
  fs.writeFileSync(STORE_FILE, JSON.stringify(safe, null, 2), 'utf8');
}

function mask(value = '', keep = 4) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.length <= keep) return '*'.repeat(Math.max(4, s.length));
  return `${'*'.repeat(Math.max(4, s.length - keep))}${s.slice(-keep)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function withUsage(profile) {
  return {
    ...profile,
    successCount: Number(profile.successCount || 0) + 1,
    lastUsedAt: nowIso()
  };
}

function sortByRecent(arr) {
  return [...arr].sort((a, b) => {
    const at = new Date(a.lastUsedAt || a.createdAt || 0).getTime();
    const bt = new Date(b.lastUsedAt || b.createdAt || 0).getTime();
    return bt - at;
  });
}

function trimProfiles(arr) {
  return sortByRecent(arr).slice(0, MAX_PER_PROVIDER);
}

function sanitizeDatabricks(p) {
  return {
    id: p.id,
    name: p.name,
    host: p.host,
    httpPath: p.httpPath,
    tokenMask: mask(p.token),
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt,
    successCount: Number(p.successCount || 0)
  };
}

function sanitizeS3(p) {
  return {
    id: p.id,
    name: p.name,
    region: p.region,
    bucket: p.bucket,
    prefix: p.prefix || '',
    accessKeyIdMask: mask(p.accessKeyId),
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt,
    successCount: Number(p.successCount || 0)
  };
}

function list(provider) {
  const store = readStore();
  const records = trimProfiles(store[provider] || []);
  return provider === 'databricks'
    ? records.map(sanitizeDatabricks)
    : records.map(sanitizeS3);
}

function get(provider, profileId) {
  const store = readStore();
  return (store[provider] || []).find(p => p.id === profileId) || null;
}

function touch(provider, profileId) {
  const store = readStore();
  const idx = (store[provider] || []).findIndex(p => p.id === profileId);
  if (idx < 0) return null;
  store[provider][idx] = withUsage(store[provider][idx]);
  store[provider] = trimProfiles(store[provider]);
  writeStore(store);
  return provider === 'databricks'
    ? sanitizeDatabricks(store[provider].find(p => p.id === profileId) || store[provider][0])
    : sanitizeS3(store[provider].find(p => p.id === profileId) || store[provider][0]);
}

function upsertDatabricks({ host, token, httpPath, name }) {
  const safeHost = String(host || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const safePath = String(httpPath || '').trim();
  const safeToken = String(token || '').trim();
  if (!safeHost || !safePath || !safeToken) throw new Error('Missing Databricks credentials.');

  const store = readStore();
  const records = store.databricks || [];
  const idx = records.findIndex(p => p.host === safeHost && p.httpPath === safePath);

  if (idx >= 0) {
    const current = records[idx];
    const updated = withUsage({
      ...current,
      token: safeToken,
      name: String(name || '').trim() || current.name
    });
    records[idx] = updated;
    store.databricks = trimProfiles(records);
    writeStore(store);
    return sanitizeDatabricks(updated);
  }

  const created = withUsage({
    id: crypto.randomUUID(),
    name: String(name || '').trim() || `Databricks ${safeHost}`,
    host: safeHost,
    httpPath: safePath,
    token: safeToken,
    createdAt: nowIso(),
    successCount: 0
  });

  records.push(created);
  store.databricks = trimProfiles(records);
  writeStore(store);
  return sanitizeDatabricks(created);
}

function upsertS3({ region, accessKeyId, secretAccessKey, bucket, prefix, name }) {
  const safeRegion = String(region || '').trim();
  const safeKey = String(accessKeyId || '').trim();
  const safeSecret = String(secretAccessKey || '').trim();
  const safeBucket = String(bucket || '').trim();
  const safePrefix = String(prefix || '').trim();
  if (!safeRegion || !safeKey || !safeSecret || !safeBucket) throw new Error('Missing S3 credentials.');

  const store = readStore();
  const records = store.s3 || [];
  const idx = records.findIndex(p => p.region === safeRegion && p.bucket === safeBucket && p.accessKeyId === safeKey);

  if (idx >= 0) {
    const current = records[idx];
    const updated = withUsage({
      ...current,
      secretAccessKey: safeSecret,
      prefix: safePrefix,
      name: String(name || '').trim() || current.name
    });
    records[idx] = updated;
    store.s3 = trimProfiles(records);
    writeStore(store);
    return sanitizeS3(updated);
  }

  const created = withUsage({
    id: crypto.randomUUID(),
    name: String(name || '').trim() || `S3 ${safeBucket}`,
    region: safeRegion,
    accessKeyId: safeKey,
    secretAccessKey: safeSecret,
    bucket: safeBucket,
    prefix: safePrefix,
    createdAt: nowIso(),
    successCount: 0
  });

  records.push(created);
  store.s3 = trimProfiles(records);
  writeStore(store);
  return sanitizeS3(created);
}

module.exports = {
  list,
  get,
  touch,
  upsertDatabricks,
  upsertS3,
  sanitizeDatabricks,
  sanitizeS3
};
