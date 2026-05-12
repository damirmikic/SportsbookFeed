// Shared Turso client and schema initialisation for all Netlify Functions.
// Uses the HTTP transport — no native binaries, works in Netlify serverless.

const crypto = require('crypto');
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
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    deleted_at TIMESTAMP,
    active     INTEGER DEFAULT 1,
    role       TEXT NOT NULL DEFAULT 'trader'
  );

  CREATE TABLE IF NOT EXISTS pending_overrides (
    key        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS templates (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TIMESTAMP
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

  CREATE TABLE IF NOT EXISTS trader_presence (
    trader_id   TEXT PRIMARY KEY,
    league_code TEXT,
    league_name TEXT,
    last_seen   TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (trader_id) REFERENCES traders(id)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id          TEXT PRIMARY KEY,
    trader_id   TEXT,
    entity      TEXT NOT NULL,
    action      TEXT NOT NULL,
    before_json TEXT,
    after_json  TEXT,
    ts          TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS odds_history (
    event_id TEXT NOT NULL,
    period   TEXT NOT NULL,
    market   TEXT NOT NULL,
    prices   TEXT NOT NULL,
    ts       TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_odds_history_event_ts
    ON odds_history (event_id, ts);

  CREATE INDEX IF NOT EXISTS idx_odds_history_ts
    ON odds_history (ts);

  CREATE INDEX IF NOT EXISTS idx_trader_presence_last_seen
    ON trader_presence (last_seen);
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

  const traderColumns = new Set((await db.execute('PRAGMA table_info(traders)')).rows.map(row => row.name));
  if (!traderColumns.has('failed_attempts')) {
    await db.execute('ALTER TABLE traders ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0');
  }
  if (!traderColumns.has('locked_until')) {
    await db.execute('ALTER TABLE traders ADD COLUMN locked_until TEXT');
  }
  if (!traderColumns.has('deleted_at')) {
    await db.execute('ALTER TABLE traders ADD COLUMN deleted_at TIMESTAMP');
  }

  if (!traderColumns.has('role')) {
    await db.execute("ALTER TABLE traders ADD COLUMN role TEXT NOT NULL DEFAULT 'trader'");
  }

  const templateColumns = new Set((await db.execute('PRAGMA table_info(templates)')).rows.map(row => row.name));
  if (!templateColumns.has('deleted_at')) {
    await db.execute('ALTER TABLE templates ADD COLUMN deleted_at TIMESTAMP');
  }
}

function stableJson(value) {
  return value == null ? null : JSON.stringify(value);
}

async function writeAuditLog(db, { traderId = null, entity, action, before = null, after = null }) {
  await db.execute({
    sql: `INSERT INTO audit_log (id, trader_id, entity, action, before_json, after_json, ts)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [
      crypto.randomUUID(),
      traderId ? String(traderId) : null,
      String(entity),
      String(action),
      stableJson(before),
      stableJson(after),
    ],
  });
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

module.exports = { getClient, initSchema, ok, err, writeAuditLog };
