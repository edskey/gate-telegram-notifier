const crypto = require('crypto');

const GATE_PREFIX = '/api/v4';
const STATE_KEY = 'gate-partner-bot:sent-transaction-ids:v1';
const LOCK_KEY = 'gate-partner-bot:check-lock:v1';
const MAX_SENT_IDS = 500;

function env(name, required = true) {
  const value = process.env[name];
  if (required && !value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function respond(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function matchesSecret(req) {
  const expected = process.env.CHECK_SECRET;
  if (!expected) return false;
  const fromHeader = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const supplied = fromHeader || req.query?.secret || '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sha512(value) {
  return crypto.createHash('sha512').update(value).digest('hex');
}

async function gateGet(path, params = {}) {
  const base = env('GATE_API_BASE_URL', false) || 'https://api.gateio.ws';
  const query = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null)
  ).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const apiPath = `${GATE_PREFIX}${path}`;
  const signaturePayload = `GET\n${apiPath}\n${query}\n${sha512('')}\n${timestamp}`;
  const signature = crypto
    .createHmac('sha512', env('GATE_API_SECRET'))
    .update(signaturePayload)
    .digest('hex');
  const url = `${base}${apiPath}${query ? `?${query}` : ''}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      KEY: env('GATE_API_KEY'),
      Timestamp: timestamp,
      SIGN: signature,
    },
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!response.ok) {
    throw new Error(`Gate ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function redis(command) {
  const base = env('UPSTASH_REDIS_REST_URL').replace(/\/$/, '');
  const response = await fetch(base, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env('UPSTASH_REDIS_REST_TOKEN')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(`Upstash: ${result.error || response.status}`);
  return result.result;
}

async function loadState() {
  const raw = await redis(['GET', STATE_KEY]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveState(state) {
  const ttl = Number(process.env.STATE_TTL_SECONDS || 60 * 60 * 24 * 30);
  await redis(['SET', STATE_KEY, JSON.stringify(state), 'EX', ttl]);
}

function recordsFrom(response) {
  if (Array.isArray(response)) return response;
  for (const key of ['data', 'list', 'items', 'records']) {
    if (Array.isArray(response?.[key])) return response[key];
    if (Array.isArray(response?.data?.[key])) return response.data[key];
  }
  return [];
}

function eventId(record) {
  for (const key of ['id', 'transaction_id', 'trade_id', 'record_id', 'order_id']) {
    if (record?.[key] !== undefined && record[key] !== null) return `${key}:${record[key]}`;
  }
  // A fallback keeps the bot usable if Gate returns a new response shape. The
  // real API response will be inspected before production alerts are enabled.
  return `hash:${crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex')}`;
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatTransaction(record) {
  const rows = [
    ['ID', eventId(record)],
    ['Пользователь', record.user_id ?? record.uid ?? record.user ?? record.email],
    ['Тип', record.type ?? record.business_type ?? record.source],
    ['Объём', record.volume ?? record.amount ?? record.trade_volume],
    ['Комиссия', record.commission ?? record.rebate_amount ?? record.fee],
    ['Время', record.create_time ?? record.time ?? record.created_at],
  ].filter(([, value]) => value !== undefined);
  return `🟢 Новая активность партнёра Gate\n${rows.map(([k, v]) => `${k}: ${formatValue(v)}`).join('\n')}`;
}

async function sendTelegram(text) {
  const response = await fetch(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env('TELEGRAM_CHAT_ID'), text }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(`Telegram: ${body.description || response.status}`);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return respond(res, 405, { error: 'method_not_allowed' });
  }
  if (!matchesSecret(req)) return respond(res, 401, { error: 'unauthorized' });

  let acquiredLock = false;
  try {
    // A scheduler retry can overlap the previous invocation. Redis makes this
    // lock atomic, so two functions cannot notify about the same fresh record.
    acquiredLock = (await redis(['SET', LOCK_KEY, '1', 'NX', 'EX', 30])) === 'OK';
    if (!acquiredLock) return respond(res, 202, { ok: true, skipped: 'check_already_running' });

    const limit = Math.min(Math.max(Number(process.env.TRANSACTION_PAGE_SIZE || 100), 1), 100);
    const response = await gateGet('/rebate/partner/transaction_history', { page: 1, limit });
    const records = recordsFrom(response);
    const currentIds = records.map(eventId);
    const state = await loadState();

    // First successful run establishes a baseline. This intentionally avoids a
    // flood of old notifications after deploying the bot.
    if (!state) {
      await saveState({ sentIds: currentIds.slice(0, MAX_SENT_IDS), initializedAt: new Date().toISOString() });
      return respond(res, 200, { ok: true, initialized: true, records: records.length, sent: 0 });
    }

    const seen = new Set(state.sentIds || []);
    const fresh = records.filter((record) => !seen.has(eventId(record)));
    for (const record of fresh.reverse()) await sendTelegram(formatTransaction(record));
    const sentIds = [...currentIds, ...(state.sentIds || [])].filter((id, index, all) => all.indexOf(id) === index).slice(0, MAX_SENT_IDS);
    await saveState({ sentIds, initializedAt: state.initializedAt, checkedAt: new Date().toISOString() });
    return respond(res, 200, { ok: true, initialized: false, records: records.length, sent: fresh.length });
  } catch (error) {
    console.error(error);
    return respond(res, 500, { ok: false, error: error.message });
  } finally {
    if (acquiredLock) {
      try { await redis(['DEL', LOCK_KEY]); } catch (error) { console.error('Could not release lock', error); }
    }
  }
};
