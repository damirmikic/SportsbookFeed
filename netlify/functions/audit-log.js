const { getClient, initSchema, ok, err } = require('./db');

function cors(statusCode = 200) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: '',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors();

  try {
    const db = getClient();
    await initSchema(db);

    if (event.httpMethod !== 'GET') return err('Method not allowed', 405);

    const limit = Math.min(Math.max(parseInt(event.queryStringParameters?.limit || '100', 10), 1), 250);
    const result = await db.execute({
      sql: `SELECT audit_log.id,
                   audit_log.trader_id,
                   traders.name AS trader_name,
                   audit_log.entity,
                   audit_log.action,
                   audit_log.before_json,
                   audit_log.after_json,
                   audit_log.ts
            FROM audit_log
            LEFT JOIN traders ON traders.id = audit_log.trader_id
            ORDER BY audit_log.ts DESC
            LIMIT ?`,
      args: [limit],
    });

    return ok(result.rows.map((row) => ({
      id: row.id,
      trader_id: row.trader_id,
      trader_name: row.trader_name,
      entity: row.entity,
      action: row.action,
      before: row.before_json ? JSON.parse(row.before_json) : null,
      after: row.after_json ? JSON.parse(row.after_json) : null,
      ts: row.ts,
    })));
  } catch (error) {
    console.error('audit-log function failed', error);
    return err(error.message || 'Internal server error', 500);
  }
};
