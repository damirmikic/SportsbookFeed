const { getClient, initSchema, ok, err } = require('./db');

const ACTIVE_WINDOW_MINUTES = 3;

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
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors();

  try {
    const db = getClient();
    await initSchema(db);

    if (event.httpMethod === 'GET') {
      const result = await db.execute({
        sql: `SELECT t.id, t.name, t.color, p.league_code, p.league_name, p.last_seen
              FROM trader_presence p
              JOIN traders t ON t.id = p.trader_id
              WHERE t.active = 1
                AND t.deleted_at IS NULL
                AND p.last_seen >= datetime('now', ?)
              ORDER BY p.last_seen DESC`,
        args: [`-${ACTIVE_WINDOW_MINUTES} minutes`],
      });
      return ok(result.rows);
    }

    if (event.httpMethod === 'POST') {
      const { traderId, leagueCode = null, leagueName = null } = parseBody(event);
      if (!traderId) return err('traderId is required', 400);

      await db.execute({
        sql: `INSERT INTO trader_presence (trader_id, league_code, league_name, last_seen)
              VALUES (?, ?, ?, datetime('now'))
              ON CONFLICT(trader_id) DO UPDATE SET
                league_code = excluded.league_code,
                league_name = excluded.league_name,
                last_seen = datetime('now')`,
        args: [String(traderId), leagueCode ? String(leagueCode) : null, leagueName ? String(leagueName) : null],
      });
      return ok({ ok: true });
    }

    return err('Method not allowed', 405);
  } catch (error) {
    console.error('trader-presence function failed', error);
    return err(error.message || 'Internal server error', 500);
  }
};
