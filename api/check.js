const crypto = require('crypto');

const GATE_PREFIX = '/api/v4';
const STATE_KEY = 'gate-partner-bot:state:v2';
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
    throw new Error(`Gate ${apiPath} ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
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
  for (const key of ['data', 'list', 'items', 'records', 'activities', 'activity_list', 'activity_types', 'type_list']) {
    if (Array.isArray(response?.[key])) return response[key];
    if (Array.isArray(response?.data?.[key])) return response.data[key];
  }
  return [];
}

function eventId(record) {
  for (const key of ['id', 'transaction_id', 'trade_id', 'record_id', 'order_id']) {
    if (record?.[key] !== undefined && record[key] !== null) return `${key}:${record[key]}`;
  }
  return `hash:${crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex')}`;
}

function uniqueIds(ids) {
  return [...new Set(ids)].slice(0, MAX_SENT_IDS);
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
  return `🟢 <b>Новая активность партнёра Gate</b>\n\n${rows
    .map(([key, value]) => `<b>${escapeTelegramHtml(key)}:</b> ${escapeTelegramHtml(formatValue(value))}`)
    .join('\n')}`;
}

function escapeTelegramHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPromotion(promotion) {
  return `🆕 <b>Новая промоакция Gate</b>\n\n${escapeTelegramHtml(promotion.text)}\n\n🔗 <a href="${escapeTelegramHtml(promotion.url)}">Открыть акцию</a>`;
}

function formatPromotionTest(promotion, index, total) {
  return `🧪 <b>Тест уведомления ${index}/${total}</b>\n\n${escapeTelegramHtml(promotion.text)}\n\n🔗 <a href="${escapeTelegramHtml(promotion.url)}">Открыть акцию</a>`;
}

function promotionsFromRequest(req) {
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return null; }
  }
  if (!body || !Array.isArray(body.promotions) || body.promotions.length === 0) return null;
  const promotions = body.promotions.slice(0, MAX_SENT_IDS).map((item) => ({
    id: String(item.id || item.url || '').slice(0, 1000),
    url: String(item.url || '').slice(0, 2000),
    text: String(item.text || '').slice(0, 900),
  })).filter((item) => item.id && item.url && item.text);
  if (promotions.length === 0) return null;
  const categories = Array.isArray(body.categories) ? body.categories.slice(0, 100) : [];
  return {
    promotions,
    categories,
    sourceCounts: { scheduler_browser: promotions.length },
  };
}

async function sendTelegram(text) {
  const token = env('TELEGRAM_BOT_TOKEN').trim();
  const chatId = env('TELEGRAM_CHAT_ID').trim();
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    let botName = 'unknown';
    try {
      const identityResponse = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const identity = await identityResponse.json();
      if (identity.ok && identity.result?.username) botName = `@${identity.result.username}`;
    } catch { /* keep the original Telegram error */ }
    throw new Error(
      `Telegram sendMessage: ${body.description || response.status}; bot=${botName}; chat=${JSON.stringify(chatId)}`
    );
  }
}

function initializeSource(state, name, currentIds) {
  const legacyTransactionIds = name === 'transactions' ? state?.sentIds : undefined;
  const source = state?.[name];
  if (source?.sentIds || legacyTransactionIds) {
    return { sentIds: source?.sentIds || legacyTransactionIds, initialized: false };
  }
  return { sentIds: currentIds, initialized: true };
}

async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return respond(res, 405, { error: 'method_not_allowed' });
  }
  if (!matchesSecret(req)) return respond(res, 401, { error: 'unauthorized' });
  const testNotification = req.headers['x-gate-bot-test'] === 'true';
  const scheduledPromotions = promotionsFromRequest(req);

  let acquiredLock = false;
  try {
    acquiredLock = (await redis(['SET', LOCK_KEY, '1', 'NX', 'EX', 30])) === 'OK';
    if (!acquiredLock) return respond(res, 202, { ok: true, skipped: 'check_already_running' });

    const limit = Math.min(Math.max(Number(process.env.TRANSACTION_PAGE_SIZE || 100), 1), 100);
    const [activityResult, promotionResult, savedState] = await Promise.all([
      gateGet('/rebate/partner/transaction_history', { page: 1, limit }),
      scheduledPromotions
        ? Promise.resolve(scheduledPromotions)
        : Promise.reject(new Error('Promotion payload from scheduler browser is missing or empty')),
      loadState(),
    ].map((promise) => Promise.resolve(promise).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    )));

    const state = savedState.ok && savedState.value ? savedState.value : {};
    const result = { ok: true, initialized: [], sent: { transactions: 0, promotions: 0 }, errors: {} };
    const deliveries = [];
    const currentIdsBySource = {};
    let testPromotions = [];

    if (activityResult.ok) {
      const records = recordsFrom(activityResult.value);
      const currentIds = records.map(eventId);
      const known = initializeSource(state, 'transactions', currentIds);
      if (known.initialized) result.initialized.push('transactions');
      const seen = new Set(known.sentIds || []);
      const fresh = known.initialized ? [] : records.filter((record) => !seen.has(eventId(record)));
      deliveries.push(...fresh.reverse().map((record) => ({
        source: 'transactions',
        id: eventId(record),
        text: formatTransaction(record),
      })));
      state.transactions = { sentIds: uniqueIds(known.sentIds || []) };
      currentIdsBySource.transactions = currentIds;
      result.transactions = records.length;
      result.sent.transactions = fresh.length;
    } else {
      result.errors.transactions = activityResult.error.message;
    }

    if (promotionResult.ok) {
      const { promotions, categories, sourceCounts } = promotionResult.value;
      const currentIds = promotions.map((promotion) => promotion.id);
      const known = initializeSource(state, 'promotions', currentIds);
      if (known.initialized) result.initialized.push('promotions');
      const seen = new Set(known.sentIds || []);
      const fresh = known.initialized ? [] : promotions.filter((promotion) => !seen.has(promotion.id));
      deliveries.push(...fresh.reverse().map((promotion) => ({
        source: 'promotions',
        id: promotion.id,
        text: formatPromotion(promotion),
      })));
      state.promotions = { sentIds: uniqueIds(known.sentIds || []) };
      currentIdsBySource.promotions = currentIds;
      result.promotions = promotions.length;
      result.categories = categories.length;
      result.promotionSources = sourceCounts;
      result.sent.promotions = fresh.length;
      if (testNotification) {
        testPromotions = promotions.slice(0, 3);
        result.testNotification = true;
        result.testNotifications = testPromotions.length;
      }
    } else {
      result.errors.promotions = promotionResult.error.message;
    }

    if (!activityResult.ok && !promotionResult.ok) {
      return respond(res, 502, { ...result, ok: false });
    }

    state.initializedAt = state.initializedAt || new Date().toISOString();
    state.checkedAt = new Date().toISOString();
    // Save a new-source baseline before sending, then checkpoint every
    // accepted message. A partial Telegram failure retries only the remaining
    // items on the next scheduler run.
    await saveState(state);
    for (const delivery of deliveries) {
      await sendTelegram(delivery.text);
      state[delivery.source].sentIds = uniqueIds([
        delivery.id,
        ...(state[delivery.source].sentIds || []),
      ]);
      state.checkedAt = new Date().toISOString();
      await saveState(state);
    }
    for (const [source, currentIds] of Object.entries(currentIdsBySource)) {
      state[source].sentIds = uniqueIds([...currentIds, ...(state[source].sentIds || [])]);
    }
    state.checkedAt = new Date().toISOString();
    await saveState(state);
    for (const [index, promotion] of testPromotions.entries()) {
      await sendTelegram(formatPromotionTest(promotion, index + 1, testPromotions.length));
    }
    return respond(res, 200, result);
  } catch (error) {
    console.error(error);
    return respond(res, 500, { ok: false, error: error.message });
  } finally {
    if (acquiredLock) {
      try { await redis(['DEL', LOCK_KEY]); } catch (error) { console.error('Could not release lock', error); }
    }
  }
}

module.exports = handler;
