const crypto = require('crypto');

const GATE_PREFIX = '/api/v4';
const STATE_KEY = 'gate-partner-bot:state:v2';
const LOCK_KEY = 'gate-partner-bot:check-lock:v1';
const MAX_SENT_IDS = 500;
const DEFAULT_PROMOTION_PAGE = 'https://www.gate.com/ru/rewards_hub/activity-center-1-ongoing';

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
  return `🟢 Новая активность партнёра Gate\n${rows.map(([k, v]) => `${k}: ${formatValue(v)}`).join('\n')}`;
}

function decodeHtml(value) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function isPromotionPath(pathname) {
  return /\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:campaigns\/\d+|candy-drop\/detail\/[^/?#]+|referral\/earn-together|competition\/[^/?#]+|launchpool\/[^/?#]+)/i.test(pathname);
}

function extractPromotions(html, pageUrl) {
  const cards = [];
  const anchor = /<a\b[^>]*\bhref=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchor.exec(html)) !== null) {
    let url;
    try { url = new URL(match[1] || match[2], pageUrl); } catch { continue; }
    if (!isPromotionPath(url.pathname)) continue;
    const id = `${url.origin}${url.pathname}`;
    const text = decodeHtml(match[3]).slice(0, 700);
    if (text) cards.push({ id, url: id, text });
  }
  const unique = new Map();
  for (const card of cards) if (!unique.has(card.id)) unique.set(card.id, card);
  return [...unique.values()];
}

async function getPromotions() {
  const pageUrl = process.env.PROMOTION_PAGE_URL || DEFAULT_PROMOTION_PAGE;
  const response = await fetch(pageUrl, {
    headers: { Accept: 'text/html', 'User-Agent': 'GatePromotionNotifier/1.0' },
  });
  if (!response.ok) throw new Error(`Promotions page ${response.status}`);
  const promotions = extractPromotions(await response.text(), pageUrl);
  if (promotions.length === 0) throw new Error('Promotions page returned no recognizable promotion cards');
  return promotions;
}

function formatPromotion(promotion) {
  return `🆕 Новая промо-акция Gate\n${promotion.text}\n\n${promotion.url}`;
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

function initializeSource(state, name, currentIds) {
  const legacyTransactionIds = name === 'transactions' ? state?.sentIds : undefined;
  const source = state?.[name];
  if (source?.sentIds || legacyTransactionIds) {
    return { sentIds: source?.sentIds || legacyTransactionIds, initialized: false };
  }
  return { sentIds: currentIds, initialized: true };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return respond(res, 405, { error: 'method_not_allowed' });
  }
  if (!matchesSecret(req)) return respond(res, 401, { error: 'unauthorized' });

  let acquiredLock = false;
  try {
    acquiredLock = (await redis(['SET', LOCK_KEY, '1', 'NX', 'EX', 30])) === 'OK';
    if (!acquiredLock) return respond(res, 202, { ok: true, skipped: 'check_already_running' });

    const limit = Math.min(Math.max(Number(process.env.TRANSACTION_PAGE_SIZE || 100), 1), 100);
    const [activityResult, promotionResult, savedState] = await Promise.all([
      gateGet('/rebate/partner/transaction_history', { page: 1, limit }),
      getPromotions(),
      loadState(),
    ].map((promise) => Promise.resolve(promise).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    )));

    const state = savedState.ok && savedState.value ? savedState.value : {};
    const result = { ok: true, initialized: [], sent: { transactions: 0, promotions: 0 }, errors: {} };
    const messages = [];

    if (activityResult.ok) {
      const records = recordsFrom(activityResult.value);
      const currentIds = records.map(eventId);
      const known = initializeSource(state, 'transactions', currentIds);
      if (known.initialized) result.initialized.push('transactions');
      const seen = new Set(known.sentIds || []);
      const fresh = known.initialized ? [] : records.filter((record) => !seen.has(eventId(record)));
      messages.push(...fresh.reverse().map((record) => formatTransaction(record)));
      state.transactions = { sentIds: uniqueIds([...currentIds, ...(known.sentIds || [])]) };
      result.transactions = records.length;
      result.sent.transactions = fresh.length;
    } else {
      result.errors.transactions = activityResult.error.message;
    }

    if (promotionResult.ok) {
      const promotions = promotionResult.value;
      const currentIds = promotions.map((promotion) => promotion.id);
      const known = initializeSource(state, 'promotions', currentIds);
      if (known.initialized) result.initialized.push('promotions');
      const seen = new Set(known.sentIds || []);
      const fresh = known.initialized ? [] : promotions.filter((promotion) => !seen.has(promotion.id));
      messages.push(...fresh.reverse().map((promotion) => formatPromotion(promotion)));
      state.promotions = { sentIds: uniqueIds([...currentIds, ...(known.sentIds || [])]) };
      result.promotions = promotions.length;
      result.sent.promotions = fresh.length;
    } else {
      result.errors.promotions = promotionResult.error.message;
    }

    if (!activityResult.ok && !promotionResult.ok) {
      return respond(res, 502, { ...result, ok: false });
    }

    state.initializedAt = state.initializedAt || new Date().toISOString();
    state.checkedAt = new Date().toISOString();
    await saveState(state);
    for (const message of messages) await sendTelegram(message);
    return respond(res, 200, result);
  } catch (error) {
    console.error(error);
    return respond(res, 500, { ok: false, error: error.message });
  } finally {
    if (acquiredLock) {
      try { await redis(['DEL', LOCK_KEY]); } catch (error) { console.error('Could not release lock', error); }
    }
  }
};
