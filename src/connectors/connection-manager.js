'use strict';
// Central registry of all loaded tables — wraps duckdb-engine
const engine = require('../engine/duckdb-engine');

const connectionMeta = new Map(); // tableName → { source, sourceLabel, loadedAt }

async function registerTable(name, data, sourceMeta = {}) {
  const result = await engine.registerTable(name, data);
  connectionMeta.set(result.tableName, {
    source:      sourceMeta.source || 'file',
    sourceLabel: sourceMeta.sourceLabel || name,
    loadedAt:    new Date().toISOString(),
    ...sourceMeta
  });
  return result;
}

async function registerFromFile(name, filePath, fileType, sourceMeta = {}) {
  const result = await engine.registerFromFile(name, filePath, fileType);
  connectionMeta.set(result.tableName, {
    source:      sourceMeta.source || 'file',
    sourceLabel: sourceMeta.sourceLabel || name,
    loadedAt:    new Date().toISOString(),
    filePath,
    ...sourceMeta
  });
  return result;
}

async function listTables() {
  const tables = await engine.listTables();
  // Augment with connection meta
  for (const [name, info] of Object.entries(tables)) {
    const meta = connectionMeta.get(name) || {};
    tables[name] = { ...info, ...meta };
  }
  return tables;
}

async function removeTable(name) {
  await engine.dropTable(name);
  connectionMeta.delete(engine._safe(name));
}

async function getTableSchema(name) {
  return engine.getTableSchema(name);
}

async function detectRelationships() {
  return engine.detectRelationships();
}

async function executeSQL(sql, timeoutMs) {
  return engine.executeSQL(sql, timeoutMs);
}

function isRegistered(name) {
  return engine.isRegistered(name);
}

function getSafe(name) {
  return engine._safe(name);
}

module.exports = {
  registerTable, registerFromFile, listTables,
  removeTable, getTableSchema, detectRelationships,
  executeSQL, isRegistered, getSafe
};
