const { getClient, initSchema, ok, err } = require('./db');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return ok({});

  const db = getClient();
  await initSchema(db);

  if (event.httpMethod === 'GET') {
    const leagueCode = event.queryStringParameters?.league;
    let rows;
    if (leagueCode) {
      rows = (await db.execute({
        sql: 'SELECT data FROM offer_snapshot WHERE league_code = ?',
        args: [String(leagueCode)],
      })).rows;
    } else {
      rows = (await db.execute('SELECT data FROM offer_snapshot ORDER BY updated_at DESC')).rows;
    }
    const events = rows.flatMap(r => {
      try { return JSON.parse(r.data).events || []; } catch { return []; }
    });
    return ok({ events, updatedAt: new Date().toISOString() });
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return err('Invalid JSON'); }
    const { leagueCode, events } = body;
    if (!leagueCode) return err('leagueCode required');
    if (!Array.isArray(events)) return err('events must be an array');

    await db.batch([
      { sql: 'DELETE FROM offer_snapshot WHERE league_code = ?', args: [String(leagueCode)] },
      {
        sql: `INSERT INTO offer_snapshot (league_code, data, updated_at) VALUES (?, ?, datetime('now'))`,
        args: [String(leagueCode), JSON.stringify({ leagueCode, events })],
      },
    ], 'write');

    return ok({ ok: true });
  }

  return err('Method not allowed', 405);
};
