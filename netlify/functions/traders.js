const crypto = require('crypto');
const { getClient, initSchema, ok, err } = require('./db');

function cors(statusCode = 200) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
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

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

function isValidPin(pin) {
  return /^\d{4,6}$/.test(String(pin || ''));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors();

  try {
    const db = getClient();
    await initSchema(db);

    if (event.httpMethod === 'GET') {
      const result = await db.execute(
        'SELECT id, name, color FROM traders WHERE active = 1 ORDER BY name COLLATE NOCASE'
      );
      return ok(result.rows);
    }

    if (event.httpMethod === 'POST') {
      const params = new URLSearchParams(event.queryStringParameters || {});
      const body = parseBody(event);

      if (params.get('verify') === '1') {
        const { id, pin } = body;
        if (!id || !isValidPin(pin)) return err('Valid trader id and 4-6 digit PIN are required', 400);
        const result = await db.execute({
          sql: 'SELECT pin_hash FROM traders WHERE id = ? AND active = 1',
          args: [String(id)],
        });
        const row = result.rows[0];
        return ok({ ok: !!row && row.pin_hash === hashPin(pin) });
      }

      const { name, color, pin } = body;
      if (!name?.trim()) return err('Trader name is required', 400);
      if (!isValidPin(pin)) return err('PIN must be 4-6 digits', 400);

      const trader = {
        id: crypto.randomUUID(),
        name: name.trim(),
        color: color || '#3b82f6',
        pinHash: hashPin(pin),
      };

      await db.execute({
        sql: 'INSERT INTO traders (id, name, color, pin_hash) VALUES (?, ?, ?, ?)',
        args: [trader.id, trader.name, trader.color, trader.pinHash],
      });

      return ok({ id: trader.id, name: trader.name, color: trader.color }, 201);
    }

    if (event.httpMethod === 'PUT') {
      const id = event.queryStringParameters?.id;
      if (!id) return err('Query param id is required', 400);

      const body = parseBody(event);
      const fields = [];
      const args = [];

      if (body.name?.trim()) {
        fields.push('name = ?');
        args.push(body.name.trim());
      }
      if (body.color) {
        fields.push('color = ?');
        args.push(body.color);
      }
      if (body.pin != null) {
        if (!isValidPin(body.pin)) return err('PIN must be 4-6 digits', 400);
        fields.push('pin_hash = ?');
        args.push(hashPin(body.pin));
      }
      if (!fields.length) return err('No valid fields to update', 400);

      args.push(String(id));
      await db.execute({
        sql: `UPDATE traders SET ${fields.join(', ')} WHERE id = ? AND active = 1`,
        args,
      });

      const result = await db.execute({
        sql: 'SELECT id, name, color FROM traders WHERE id = ? AND active = 1',
        args: [String(id)],
      });
      return ok(result.rows[0] || null);
    }

    return err('Method not allowed', 405);
  } catch (error) {
    console.error('traders function failed', error);
    return err(error.message || 'Internal server error', 500);
  }
};
