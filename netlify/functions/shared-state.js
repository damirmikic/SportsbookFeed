const { getClient, initSchema, ok, err, writeAuditLog } = require('./db');

function cors(statusCode = 200) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: '',
  };
}

function parseBody(event) {
  if (!event.body) return null;
  try {
    return JSON.parse(event.body);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function rowMap(rows, keyField, valueField = 'data', parser = JSON.parse) {
  const out = {};
  rows.forEach((row) => {
    out[row[keyField]] = parser(row[valueField]);
  });
  return out;
}

function latestTimestamp(...values) {
  const times = values
    .filter(Boolean)
    .map((value) => {
      const text = String(value);
      return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
    })
    .filter((value) => Number.isFinite(value));
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

async function readSyncMeta(db) {
  const [templates, leagues, matches, suspensions] = await Promise.all([
    db.execute('SELECT MAX(updated_at) AS ts FROM templates'),
    db.execute('SELECT MAX(updated_at) AS ts FROM league_settings'),
    db.execute('SELECT MAX(updated_at) AS ts FROM match_templates'),
    db.execute('SELECT MAX(set_at) AS ts FROM suspensions'),
  ]);
  return {
    lastSharedPushAt: latestTimestamp(
      templates.rows[0]?.ts,
      leagues.rows[0]?.ts,
      matches.rows[0]?.ts,
      suspensions.rows[0]?.ts
    ),
  };
}

async function replaceRows(db, statements) {
  await db.batch(statements, 'write');
}

async function readSharedEntity(db, entity) {
  if (entity === 'templates') {
    const result = await db.execute('SELECT data FROM templates WHERE deleted_at IS NULL ORDER BY id');
    return result.rows.map((row) => JSON.parse(row.data));
  }
  if (entity === 'league-settings') {
    const result = await db.execute('SELECT league_code, data FROM league_settings');
    return rowMap(result.rows, 'league_code');
  }
  if (entity === 'match-templates') {
    const result = await db.execute('SELECT event_id, template_id FROM match_templates');
    const out = {};
    result.rows.forEach((row) => { out[row.event_id] = row.template_id; });
    return out;
  }
  if (entity === 'suspensions') {
    const result = await db.execute('SELECT key, status, set_by, set_at FROM suspensions');
    const out = {};
    result.rows.forEach((row) => {
      out[row.key] = { status: row.status, set_by: row.set_by, set_at: row.set_at };
    });
    return out;
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors();

  try {
    const db = getClient();
    await initSchema(db);

    if (event.httpMethod === 'GET') {
      const [templatesRes, leagueRes, matchRes, suspRes] = await Promise.all([
        db.execute('SELECT id, data FROM templates WHERE deleted_at IS NULL'),
        db.execute('SELECT league_code, data FROM league_settings'),
        db.execute('SELECT event_id, template_id FROM match_templates'),
        db.execute('SELECT key, status, set_by, set_at FROM suspensions'),
      ]);

      const templates = templatesRes.rows.map((row) => JSON.parse(row.data));
      const leagueSettings = rowMap(leagueRes.rows, 'league_code');
      const matchTemplates = {};
      matchRes.rows.forEach((row) => {
        matchTemplates[row.event_id] = row.template_id;
      });
      const suspensions = {};
      suspRes.rows.forEach((row) => {
        suspensions[row.key] = { status: row.status, set_by: row.set_by, set_at: row.set_at };
      });

      const syncMeta = await readSyncMeta(db);

      return ok({ templates, leagueSettings, matchTemplates, suspensions, syncMeta });
    }

    if (event.httpMethod === 'POST') {
      const entity = event.queryStringParameters?.entity;
      const body = parseBody(event);
      const traderId = event.queryStringParameters?.traderId || null;

      if (entity === 'templates') {
        const before = await readSharedEntity(db, entity);
        const templates = Array.isArray(body) ? body : [];
        const statements = [{ sql: `UPDATE templates SET deleted_at = datetime('now') WHERE deleted_at IS NULL`, args: [] }];
        templates.forEach((template) => {
          statements.push({
            sql: `INSERT INTO templates (id, data, updated_at, deleted_at)
                  VALUES (?, ?, datetime('now'), NULL)
                  ON CONFLICT(id) DO UPDATE SET
                    data = excluded.data,
                    updated_at = datetime('now'),
                    deleted_at = NULL`,
            args: [String(template.id), JSON.stringify(template)],
          });
        });
        await replaceRows(db, statements);
        await writeAuditLog(db, { traderId, entity, action: 'replace', before, after: templates });
        return ok({ ok: true, ...(await readSyncMeta(db)) });
      }

      if (entity === 'league-settings') {
        const before = await readSharedEntity(db, entity);
        const entries = Object.entries(body || {});
        const statements = [{ sql: 'DELETE FROM league_settings', args: [] }];
        entries.forEach(([leagueCode, data]) => {
          statements.push({
            sql: `INSERT INTO league_settings (league_code, data, updated_at) VALUES (?, ?, datetime('now'))`,
            args: [String(leagueCode), JSON.stringify(data)],
          });
        });
        await replaceRows(db, statements);
        await writeAuditLog(db, { traderId, entity, action: 'replace', before, after: body || {} });
        return ok({ ok: true, ...(await readSyncMeta(db)) });
      }

      if (entity === 'match-templates') {
        const before = await readSharedEntity(db, entity);
        const entries = Object.entries(body || {});
        const statements = [{ sql: 'DELETE FROM match_templates', args: [] }];
        entries.forEach(([eventId, templateId]) => {
          if (templateId == null || templateId === '') return;
          statements.push({
            sql: `INSERT INTO match_templates (event_id, template_id, set_by, updated_at) VALUES (?, ?, ?, datetime('now'))`,
            args: [String(eventId), String(templateId), traderId],
          });
        });
        await replaceRows(db, statements);
        await writeAuditLog(db, { traderId, entity, action: 'replace', before, after: body || {} });
        return ok({ ok: true, ...(await readSyncMeta(db)) });
      }

      if (entity === 'suspensions') {
        const before = await readSharedEntity(db, entity);
        const statements = [{ sql: 'DELETE FROM suspensions', args: [] }];
        Object.entries(body || {}).forEach(([key, data]) => {
          const status = typeof data === 'string' ? data : data?.status;
          if (!status || status === 'open') return;
          statements.push({
            sql: `INSERT INTO suspensions (key, status, set_by, set_at) VALUES (?, ?, ?, COALESCE(?, datetime('now')))`,
            args: [String(key), status, data?.set_by || traderId, data?.set_at || null],
          });
        });
        await replaceRows(db, statements);
        await writeAuditLog(db, { traderId, entity, action: 'replace', before, after: body || {} });
        return ok({ ok: true, ...(await readSyncMeta(db)) });
      }

      return err('Unsupported shared-state entity', 400);
    }

    return err('Method not allowed', 405);
  } catch (error) {
    console.error('shared-state function failed', error);
    return err(error.message || 'Internal server error', 500);
  }
};
