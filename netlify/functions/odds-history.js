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
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function eventsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.events)) return payload.events;
  if (Array.isArray(payload?.matches)) return payload.matches;
  if (Array.isArray(payload?.leagues)) {
    return payload.leagues.flatMap((league) => Array.isArray(league.events) ? league.events : []);
  }
  return [];
}

function periodsFromEvent(event) {
  if (event.periods && !Array.isArray(event.periods)) return Object.entries(event.periods);
  if (event.periodOdds && !Array.isArray(event.periodOdds)) return Object.entries(event.periodOdds);
  const arr = Array.isArray(event.periods) ? event.periods : Object.values(event.periods || {});
  return arr.map((period, index) => [String(period.num ?? period.periodNumber ?? index), period]);
}

function pushSnapshot(out, eventId, period, market, prices) {
  if (prices == null) return;
  out.push({
    event_id: String(eventId),
    period: String(period),
    market,
    prices,
  });
}

function extractSnapshots(payload) {
  const snapshots = [];
  eventsFromPayload(payload).forEach((event) => {
    const eventId = event.id ?? event.eventId;
    if (eventId == null) return;

    periodsFromEvent(event).forEach(([periodKey, period]) => {
      const moneyline = period.moneyLine || period.moneyline;
      if (moneyline) {
        pushSnapshot(snapshots, eventId, periodKey, 'moneyline', {
          home: moneyline.homePrice ?? moneyline.home ?? null,
          draw: moneyline.drawPrice ?? moneyline.draw ?? null,
          away: moneyline.awayPrice ?? moneyline.away ?? null,
        });
      }

      (period.overUnder || period.totals || []).forEach((total) => {
        pushSnapshot(snapshots, eventId, periodKey, 'total', {
          points: total.points ?? total.line ?? null,
          over: total.overOdds ?? total.over ?? null,
          under: total.underOdds ?? total.under ?? null,
        });
      });

      (period.spreads || period.handicap || []).forEach((spread) => {
        pushSnapshot(snapshots, eventId, periodKey, 'spread', {
          homeSpread: spread.homeSpread ?? spread.hdp ?? spread.handicap ?? null,
          awaySpread: spread.awaySpread ?? null,
          home: spread.homeOdds ?? null,
          away: spread.awayOdds ?? null,
        });
      });

      const teamTotals = period.teamTotals || period.teamTotal;
      ['home', 'away'].forEach((side) => {
        const lines = teamTotals?.[`${side}Lines`] || teamTotals?.[side] || [];
        lines.forEach((line) => {
          pushSnapshot(snapshots, eventId, periodKey, `team_total_${side}`, {
            points: line.points ?? line.line ?? null,
            over: line.overOdds ?? line.over ?? null,
            under: line.underOdds ?? line.under ?? null,
          });
        });
      });
    });
  });
  return snapshots;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors();

  try {
    const db = getClient();
    await initSchema(db);

    if (event.httpMethod === 'POST') {
      const snapshots = extractSnapshots(parseBody(event));
      const statements = [
        { sql: `DELETE FROM odds_history WHERE ts < datetime('now', '-24 hours')`, args: [] },
      ];

      snapshots.forEach((snapshot) => {
        statements.push({
          sql: `INSERT INTO odds_history (event_id, period, market, prices, ts)
                VALUES (?, ?, ?, ?, datetime('now'))`,
          args: [snapshot.event_id, snapshot.period, snapshot.market, JSON.stringify(snapshot.prices)],
        });
      });

      await db.batch(statements, 'write');
      return ok({ ok: true, inserted: snapshots.length });
    }

    if (event.httpMethod === 'GET') {
      const eventId = event.queryStringParameters?.eventId;
      if (!eventId) return err('Query param eventId is required', 400);

      const result = await db.execute({
        sql: `SELECT event_id, period, market, prices, ts
              FROM odds_history
              WHERE event_id = ? AND ts >= datetime('now', '-24 hours')
              ORDER BY ts ASC`,
        args: [String(eventId)],
      });

      return ok(result.rows.map((row) => ({
        event_id: row.event_id,
        period: row.period,
        market: row.market,
        prices: JSON.parse(row.prices),
        ts: row.ts,
      })));
    }

    return err('Method not allowed', 405);
  } catch (error) {
    console.error('odds-history function failed', error);
    return err(error.message || 'Internal server error', 500);
  }
};
