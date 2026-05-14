const crypto = require('crypto');
const { getClient, initSchema, ok, err } = require('./db.js');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return ok({});

  const db = getClient();
  await initSchema(db);

  const params = event.queryStringParameters || {};
  const type = params.type;
  const id = params.id;
  const leagueCode = params.leagueCode;

  try {
    if (event.httpMethod === 'GET') {
      if (type === 'leagues') {
        const result = await db.execute('SELECT * FROM manual_leagues ORDER BY created_at DESC');
        return ok(result.rows);
      }
      if (type === 'events' && leagueCode) {
        const result = await db.execute({
          sql: 'SELECT * FROM manual_events WHERE league_code = ? ORDER BY starts ASC',
          args: [leagueCode],
        });
        return ok(result.rows);
      }
      return err('type required; for events also leagueCode');
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');

      if (type === 'leagues') {
        const { name, created_by } = body;
        if (!name || !name.trim()) return err('name required');
        const newId = crypto.randomUUID();
        const code = 'MANUAL_' + newId.replace(/-/g, '').substring(0, 12).toUpperCase();
        await db.execute({
          sql: `INSERT INTO manual_leagues (id, name, code, created_by) VALUES (?, ?, ?, ?)`,
          args: [newId, name.trim(), code, created_by || null],
        });
        const row = (await db.execute({ sql: 'SELECT * FROM manual_leagues WHERE id = ?', args: [newId] })).rows[0];
        return ok(row, 201);
      }

      if (type === 'events') {
        const { league_code, home, away, starts, input_mode, lh, la, rho, home_odds, draw_odds, away_odds, over_odds, under_odds, ou_line } = body;
        if (!league_code || !home || !away || !starts) return err('league_code, home, away, starts required');
        const newId = crypto.randomUUID();
        await db.execute({
          sql: `INSERT INTO manual_events
                  (id, league_code, home, away, starts, input_mode, lh, la, rho,
                   home_odds, draw_odds, away_odds, over_odds, under_odds, ou_line)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            newId, league_code, home.trim(), away.trim(), starts,
            input_mode || 'odds',
            lh != null ? Number(lh) : null,
            la != null ? Number(la) : null,
            rho != null ? Number(rho) : 0,
            home_odds  != null ? Number(home_odds)  : null,
            draw_odds  != null ? Number(draw_odds)  : null,
            away_odds  != null ? Number(away_odds)  : null,
            over_odds  != null ? Number(over_odds)  : null,
            under_odds != null ? Number(under_odds) : null,
            ou_line    != null ? Number(ou_line)    : 2.5,
          ],
        });
        const row = (await db.execute({ sql: 'SELECT * FROM manual_events WHERE id = ?', args: [newId] })).rows[0];
        return ok(row, 201);
      }

      return err('type must be leagues or events');
    }

    if (event.httpMethod === 'PUT') {
      if (!id) return err('id required');
      const body = JSON.parse(event.body || '{}');

      if (type === 'leagues') {
        const { name } = body;
        if (!name || !name.trim()) return err('name required');
        await db.execute({
          sql: `UPDATE manual_leagues SET name = ?, updated_at = datetime('now') WHERE id = ?`,
          args: [name.trim(), id],
        });
        return ok({ ok: true });
      }

      if (type === 'events') {
        const { home, away, starts, input_mode, lh, la, rho, home_odds, draw_odds, away_odds, over_odds, under_odds, ou_line } = body;
        if (!home || !away || !starts) return err('home, away, starts required');
        await db.execute({
          sql: `UPDATE manual_events
                SET home = ?, away = ?, starts = ?, input_mode = ?,
                    lh = ?, la = ?, rho = ?,
                    home_odds = ?, draw_odds = ?, away_odds = ?,
                    over_odds = ?, under_odds = ?, ou_line = ?,
                    updated_at = datetime('now')
                WHERE id = ?`,
          args: [
            home.trim(), away.trim(), starts,
            input_mode || 'odds',
            lh != null ? Number(lh) : null,
            la != null ? Number(la) : null,
            rho != null ? Number(rho) : 0,
            home_odds  != null ? Number(home_odds)  : null,
            draw_odds  != null ? Number(draw_odds)  : null,
            away_odds  != null ? Number(away_odds)  : null,
            over_odds  != null ? Number(over_odds)  : null,
            under_odds != null ? Number(under_odds) : null,
            ou_line    != null ? Number(ou_line)    : 2.5,
            id,
          ],
        });
        return ok({ ok: true });
      }

      return err('type must be leagues or events');
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return err('id required');

      if (type === 'leagues') {
        const rows = (await db.execute({ sql: 'SELECT code FROM manual_leagues WHERE id = ?', args: [id] })).rows;
        if (rows.length) {
          await db.batch([
            { sql: 'DELETE FROM manual_events WHERE league_code = ?', args: [rows[0].code] },
            { sql: 'DELETE FROM manual_leagues WHERE id = ?', args: [id] },
          ], 'write');
        }
        return ok({ ok: true });
      }

      if (type === 'events') {
        await db.execute({ sql: 'DELETE FROM manual_events WHERE id = ?', args: [id] });
        return ok({ ok: true });
      }

      return err('type must be leagues or events');
    }

    return err('Method not allowed', 405);
  } catch (e) {
    console.error('manual-data error:', e);
    return err(e.message, 500);
  }
};
