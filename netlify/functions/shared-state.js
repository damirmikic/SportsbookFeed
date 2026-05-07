const { getClient, initSchema, ok, err } = require('./db');

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

async function replaceRows(db, statements) {
  await db.batch(statements, 'write');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors();

  try {
    const db = getClient();
    await initSchema(db);

    if (event.httpMethod === 'GET') {
      const [templatesRes, leagueRes, matchRes, suspRes] = await Promise.all([
        db.execute('SELECT id, data FROM templates'),
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

      return ok({ templates, leagueSettings, matchTemplates, suspensions });
    }

    if (event.httpMethod === 'POST') {
      const entity = event.queryStringParameters?.entity;
      const body = parseBody(event);

      if (entity === 'templates') {
        const templates = Array.isArray(body) ? body : [];
        const statements = [{ sql: 'DELETE FROM templates', args: [] }];
        templates.forEach((template) => {
          statements.push({
            sql: `INSERT INTO templates (id, data, updated_at) VALUES (?, ?, datetime('now'))`,
            args: [String(template.id), JSON.stringify(template)],
          });
        });
        await replaceRows(db, statements);
        return ok({ ok: true });
      }

      if (entity === 'league-settings') {
        const entries = Object.entries(body || {});
        const statements = [{ sql: 'DELETE FROM league_settings', args: [] }];
        entries.forEach(([leagueCode, data]) => {
          statements.push({
            sql: `INSERT INTO league_settings (league_code, data, updated_at) VALUES (?, ?, datetime('now'))`,
            args: [String(leagueCode), JSON.stringify(data)],
          });
        });
        await replaceRows(db, statements);
        return ok({ ok: true });
      }

      if (entity === 'match-templates') {
        const traderId = event.queryStringParameters?.traderId || null;
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
        return ok({ ok: true });
      }

      if (entity === 'suspensions') {
        const traderId = event.queryStringParameters?.traderId || null;
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
        return ok({ ok: true });
      }

      return err('Unsupported shared-state entity', 400);
    }

    return err('Method not allowed', 405);
  } catch (error) {
    console.error('shared-state function failed', error);
    return err(error.message || 'Internal server error', 500);
  }
};
