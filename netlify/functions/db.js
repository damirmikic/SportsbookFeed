// Shared Turso client and schema initialisation for all Netlify Functions.
// Uses the HTTP transport — no native binaries, works in Netlify serverless.

const { createClient } = require('@libsql/client/http');

let _client = null;

function getClient() {
  if (!_client) {
    if (!process.env.TURSO_CONNECTION_URL || !process.env.TURSO_AUTH_TOKEN) {
      throw new Error('TURSO_CONNECTION_URL and TURSO_AUTH_TOKEN env vars are required');
    }
    _client = createClient({
      url:       process.env.TURSO_CONNECTION_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _client;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS traders (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    color      TEXT NOT NULL DEFAULT '#3b82f6',
    pin_hash   TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    active     INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS templates (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS league_settings (
    league_code TEXT PRIMARY KEY,
    data        TEXT NOT NULL,
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS match_templates (
    event_id    TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    set_by      TEXT,
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS suspensions (
    key    TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'suspended',
    set_by TEXT,
    set_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trader_overrides (
    trader_id TEXT NOT NULL,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    PRIMARY KEY (trader_id, key)
  );

  CREATE TABLE IF NOT EXISTS trader_override_meta (
    trader_id TEXT NOT NULL,
    key       TEXT NOT NULL,
    data      TEXT NOT NULL,
    PRIMARY KEY (trader_id, key)
  );

  CREATE TABLE IF NOT EXISTS trader_modes (
    trader_id TEXT NOT NULL,
    event_id  TEXT NOT NULL,
    mode      TEXT NOT NULL DEFAULT 'manual',
    PRIMARY KEY (trader_id, event_id)
  );

  CREATE TABLE IF NOT EXISTS trader_lambdas (
    trader_id TEXT NOT NULL,
    event_id  TEXT NOT NULL,
    data      TEXT NOT NULL,
    PRIMARY KEY (trader_id, event_id)
  );

  CREATE TABLE IF NOT EXISTS trader_favorites (
    trader_id   TEXT NOT NULL,
    league_code TEXT NOT NULL,
    PRIMARY KEY (trader_id, league_code)
  );

  CREATE TABLE IF NOT EXISTS trader_prefs (
    trader_id       TEXT PRIMARY KEY,
    expanded_groups TEXT DEFAULT '[]'
  );
`;

async function initSchema(db) {
  // SQLite doesn't support multiple statements in one execute call via libSQL HTTP,
  // so we split on semicolons and run each statement individually.
  const statements = SCHEMA
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  for (const sql of statements) {
    await db.execute(sql);
  }
}

function ok(body, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

function err(message, status = 400) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ error: message }),
  };
}

module.exports = { getClient, initSchema, ok, err };
