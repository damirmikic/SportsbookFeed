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

function requireTraderId(event) {
  const traderId = event.queryStringParameters?.traderId;
  if (!traderId) throw new Error('Query param traderId is required');
  return String(traderId);
}

function mapRows(rows, keyField, valueField, parser = (value) => value) {
  const out = {};
  rows.forEach((row) => {
    out[row[keyField]] = parser(row[valueField], row);
  });
  return out;
}

async function readTraderEntity(db, traderId, entity) {
  if (entity === 'overrides') {
    const result = await db.execute({ sql: 'SELECT key, value FROM trader_overrides WHERE trader_id = ?', args: [traderId] });
    return mapRows(result.rows, 'key', 'value');
  }
  if (entity === 'meta') {
    const result = await db.execute({ sql: 'SELECT key, data FROM trader_override_meta WHERE trader_id = ?', args: [traderId] });
    return mapRows(result.rows, 'key', 'data', JSON.parse);
  }
  if (entity === 'modes') {
    const result = await db.execute({ sql: 'SELECT event_id, mode FROM trader_modes WHERE trader_id = ?', args: [traderId] });
    const out = {};
    result.rows.forEach((row) => { out[row.event_id] = row.mode; });
    return out;
  }
  if (entity === 'lambdas') {
    const result = await db.execute({ sql: 'SELECT event_id, data FROM trader_lambdas WHERE trader_id = ?', args: [traderId] });
    return mapRows(result.rows, 'event_id', 'data', JSON.parse);
  }
  if (entity === 'favorites') {
    const result = await db.execute({ sql: 'SELECT league_code FROM trader_favorites WHERE trader_id = ?', args: [traderId] });
    return result.rows.map((row) => row.league_code);
  }
  if (entity === 'prefs') {
    const result = await db.execute({ sql: 'SELECT expanded_groups FROM trader_prefs WHERE trader_id = ?', args: [traderId] });
    return { expandedGroups: result.rows[0]?.expanded_groups ? JSON.parse(result.rows[0].expanded_groups) : [] };
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors();

  try {
    const db = getClient();
    await initSchema(db);
    const traderId = requireTraderId(event);

    if (event.httpMethod === 'GET') {
      const [overridesRes, metaRes, modesRes, lambdasRes, favoritesRes, prefsRes] = await Promise.all([
        db.execute({ sql: 'SELECT key, value FROM trader_overrides WHERE trader_id = ?', args: [traderId] }),
        db.execute({ sql: 'SELECT key, data FROM trader_override_meta WHERE trader_id = ?', args: [traderId] }),
        db.execute({ sql: 'SELECT event_id, mode FROM trader_modes WHERE trader_id = ?', args: [traderId] }),
        db.execute({ sql: 'SELECT event_id, data FROM trader_lambdas WHERE trader_id = ?', args: [traderId] }),
        db.execute({ sql: 'SELECT league_code FROM trader_favorites WHERE trader_id = ?', args: [traderId] }),
        db.execute({ sql: 'SELECT expanded_groups FROM trader_prefs WHERE trader_id = ?', args: [traderId] }),
      ]);

      const overrides = mapRows(overridesRes.rows, 'key', 'value');
      const overrideMeta = mapRows(metaRes.rows, 'key', 'data', JSON.parse);
      const modes = {};
      modesRes.rows.forEach((row) => {
        modes[row.event_id] = row.mode;
      });
      const lambdas = mapRows(lambdasRes.rows, 'event_id', 'data', JSON.parse);
      const favorites = favoritesRes.rows.map((row) => row.league_code);
      const expandedGroups = prefsRes.rows[0]?.expanded_groups ? JSON.parse(prefsRes.rows[0].expanded_groups) : [];

      return ok({ overrides, overrideMeta, modes, lambdas, favorites, expandedGroups });
    }

    if (event.httpMethod === 'POST') {
      const entity = event.queryStringParameters?.entity;
      const body = parseBody(event);
      const statements = [];
      const before = await readTraderEntity(db, traderId, entity);
      let after = body;

      if (entity === 'overrides') {
        statements.push({ sql: 'DELETE FROM trader_overrides WHERE trader_id = ?', args: [traderId] });
        Object.entries(body || {}).forEach(([key, value]) => {
          statements.push({
            sql: 'INSERT INTO trader_overrides (trader_id, key, value) VALUES (?, ?, ?)',
            args: [traderId, String(key), String(value)],
          });
        });
      } else if (entity === 'meta') {
        statements.push({ sql: 'DELETE FROM trader_override_meta WHERE trader_id = ?', args: [traderId] });
        Object.entries(body || {}).forEach(([key, value]) => {
          statements.push({
            sql: 'INSERT INTO trader_override_meta (trader_id, key, data) VALUES (?, ?, ?)',
            args: [traderId, String(key), JSON.stringify(value)],
          });
        });
      } else if (entity === 'modes') {
        statements.push({ sql: 'DELETE FROM trader_modes WHERE trader_id = ?', args: [traderId] });
        Object.entries(body || {}).forEach(([eventId, mode]) => {
          if (mode !== 'manual') return;
          statements.push({
            sql: 'INSERT INTO trader_modes (trader_id, event_id, mode) VALUES (?, ?, ?)',
            args: [traderId, String(eventId), 'manual'],
          });
        });
      } else if (entity === 'lambdas') {
        statements.push({ sql: 'DELETE FROM trader_lambdas WHERE trader_id = ?', args: [traderId] });
        Object.entries(body || {}).forEach(([eventId, data]) => {
          statements.push({
            sql: 'INSERT INTO trader_lambdas (trader_id, event_id, data) VALUES (?, ?, ?)',
            args: [traderId, String(eventId), JSON.stringify(data)],
          });
        });
      } else if (entity === 'favorites') {
        after = Array.isArray(body) ? body : [];
        statements.push({ sql: 'DELETE FROM trader_favorites WHERE trader_id = ?', args: [traderId] });
        (Array.isArray(body) ? body : []).forEach((leagueCode) => {
          statements.push({
            sql: 'INSERT INTO trader_favorites (trader_id, league_code) VALUES (?, ?)',
            args: [traderId, String(leagueCode)],
          });
        });
      } else if (entity === 'prefs') {
        const expandedGroups = Array.isArray(body?.expandedGroups) ? body.expandedGroups : [];
        after = { expandedGroups };
        statements.push({
          sql: `INSERT INTO trader_prefs (trader_id, expanded_groups)
                VALUES (?, ?)
                ON CONFLICT(trader_id) DO UPDATE SET expanded_groups = excluded.expanded_groups`,
          args: [traderId, JSON.stringify(expandedGroups)],
        });
      } else {
        return err('Unsupported trader-state entity', 400);
      }

      await db.batch(statements, 'write');
      await writeAuditLog(db, { traderId, entity: `trader:${entity}`, action: 'replace', before, after });
      return ok({ ok: true });
    }

    return err('Method not allowed', 405);
  } catch (error) {
    console.error('trader-state function failed', error);
    return err(error.message || 'Internal server error', error.message?.includes('traderId') ? 400 : 500);
  }
};
