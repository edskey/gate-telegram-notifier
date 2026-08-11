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

function promotionContent(promotion) {
  const timerPattern = /(?:Обратный отсчет|Countdown|Ends? in)\s*:?\s*([0-9Dд:\s]+)/i;
  const timerMatch = String(promotion.text).match(timerPattern);
  const timer = timerMatch
    ? timerMatch[1].replace(/\s*:\s*/g, ':').replace(/\s+/g, ' ').trim()
    : 'время не найдено';
  const text = String(promotion.text).replace(timerPattern, ' ').replace(/\s+/g, ' ').trim();
  return [
    escapeTelegramHtml(text),
    `🔵 <b><u>Таймер: ${escapeTelegramHtml(timer)}</u></b>`,
    '',
    `🔵 <b>Промка:</b> <a href="${escapeTelegramHtml(promotion.url)}">Открыть</a>`,
  ].join('\n');
}

function formatPromotion(promotion) {
  return `🆕 <b>Новая промоакция Gate</b>\n\n${promotionContent(promotion)}`;
}

async function coinGeckoUsdPrice(symbol) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (normalizedSymbol === 'USDT' || normalizedSymbol === 'USDC') return 1;

  const apiKey = env('COINGECKO_API_KEY', false)?.trim();
  if (!normalizedSymbol || !apiKey) return null;

  const headers = {
    Accept: 'application/json',
    'x-cg-demo-api-key': apiKey,
  };
  try {
    const searchResponse = await fetch(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(normalizedSymbol)}`,
      { headers, signal: AbortSignal.timeout(5000) }
    );
    if (!searchResponse.ok) return null;
    const search = await searchResponse.json();
    const coin = (search.coins || []).find((item) =>
      String(item.symbol || '').toUpperCase() === normalizedSymbol
    );
    if (!coin?.id) return null;
    const priceResponse = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coin.id)}&vs_currencies=usd`,
      { headers, signal: AbortSignal.timeout(5000) }
    );
    if (!priceResponse.ok) return null;
    const price = Number((await priceResponse.json())?.[coin.id]?.usd);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

function formatNumber(value, maximumFractionDigits = 6) {
  return Number(value).toLocaleString('ru-RU', { maximumFractionDigits });
}

async function formatCandyDrop(candyDrop) {
  const heading = 'Новый CandyDrop Upcoming';
  const rows = [
    `👇 <b>${heading}</b>`,
    '',
    `🔵 <b>Проект:</b> ${escapeTelegramHtml(candyDrop.name)}`,
    `🔵 Бабки не проблема (пул): <b>${escapeTelegramHtml(candyDrop.pool)}</b>`,
    `🔵 <b>Тип кендика:</b> ${escapeTelegramHtml(candyDrop.candyType)}`,
    `🔵 <b><u>Ебашим через: ${escapeTelegramHtml(candyDrop.startIn)}</u></b>`,
  ];
  if (candyDrop.fixedRewards) {
    const fixed = candyDrop.fixedRewards;
    const price = await coinGeckoUsdPrice(fixed.symbol);
    const reward = price === null
      ? 'не нашел цену/не залистилось'
      : `${formatNumber(fixed.individualCap)} ${fixed.symbol} ≈ $${formatNumber(fixed.individualCap * price)}`;
    const places = fixed.hasCandy
      ? 'Вычисляем мануально, там кендики, я бот, меня починят'
      : formatNumber(fixed.totalAmount / fixed.individualCap, 2);
    rows.push(
      `🔵 <b>Фикс награда:</b> <b>${escapeTelegramHtml(reward)}</b>`,
      `🔵 <b>Мест в палате:</b> ${escapeTelegramHtml(places)}`
    );
  }
  rows.push('', `🔵 <b>Промка:</b> <a href="${escapeTelegramHtml(candyDrop.url)}">Открыть</a>`);
  return rows.join('\n');
}

function formatFuturesPoints(promotion) {
  const timerMatch = promotion.startsIn.match(/^(?:([0-9]+Д))?([0-9]{1,2}:[0-9]{2}:[0-9]{2})$/i);
  const timer = timerMatch
    ? [timerMatch[1], timerMatch[2]].filter(Boolean).map((part) => `<b>${escapeTelegramHtml(part)}</b>`).join(' ')
    : `<b>${escapeTelegramHtml(promotion.startsIn)}</b>`;
  return [
    '👇 <b>Новая промоакция Futures Points</b>',
    '',
    `🔵 <b>Мин. требуемые баллы:</b> <b>${escapeTelegramHtml(promotion.minPoints)}</b>`,
    `🔵 <b>Потраченные баллы:</b> <b>${escapeTelegramHtml(promotion.spentPoints)}</b>`,
    `🔵 <b>Сумма ваучера:</b> <b>${escapeTelegramHtml(promotion.voucherAmount)}</b>`,
    `🔵 <b><u>Ебашим через:</u></b> ${timer}`,
    '',
    `🔵 <b>Промка:</b> <a href="${escapeTelegramHtml(promotion.url)}">Открыть</a>`,
  ].join('\n');
}

function formatFuturesLottery(promotion, { test = false } = {}) {
  const heading = test
    ? 'Тест: Счастливый розыгрыш — Анонсировано'
    : 'Счастливый розыгрыш — Анонсировано';
  return [
    `👇 <b>${heading}</b>`,
    '',
    `🔵 <b>Сумма награды:</b> <b>${escapeTelegramHtml(promotion.rewardAmount)}</b>`,
    `🔵 <b>Мин. баллов требуется:</b> <b>${escapeTelegramHtml(promotion.minPoints)}</b>`,
    `🔵 <b>Выигрышные слоты:</b> <b>${escapeTelegramHtml(formatNumber(promotion.winningSlots, 0))}</b>`,
    '',
    `🔵 <b>Промка:</b> <a href="${escapeTelegramHtml(promotion.url)}">Открыть</a>`,
  ].join('\n');
}

function formatLaunchpool(promotion) {
  return [
    '👇 <b>Новый Launchpool</b>',
    '',
    `🔵 <b>Проект:</b> <b>${escapeTelegramHtml(promotion.project)}</b>`,
    `🔵 <b>Всего наград:</b> <b>${escapeTelegramHtml(promotion.totalRewards)}</b>`,
    `🔵 <b>Период стейкинга:</b> <b>${escapeTelegramHtml(promotion.stakingPeriod)}</b>`,
    '',
    `🔵 <b>Промка:</b> <a href="${escapeTelegramHtml(promotion.url)}">Открыть</a>`,
  ].join('\n');
}

function requestBody(req) {
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return null; }
  }
  return body && typeof body === 'object' ? body : null;
}

function promotionsFromRequest(req) {
  const body = requestBody(req);
  if (!body || !Array.isArray(body.promotions) || body.promotions.length === 0) return null;
  const promotions = body.promotions.slice(0, MAX_SENT_IDS).map((item) => ({
    id: String(item.id || item.url || '').slice(0, 1000),
    url: String(item.url || '').slice(0, 2000),
    text: String(item.text || '').slice(0, 900),
  })).filter((item) => item.id && item.url && item.text);
  if (promotions.length === 0) return null;
  const categories = Array.isArray(body.categories) ? body.categories.slice(0, 100) : [];
  const announcements = body.announcements && typeof body.announcements === 'object' ? {
    articles: Number(body.announcements.articles) || 0,
    failedArticles: Number(body.announcements.failedArticles) || 0,
    campaigns: Number(body.announcements.campaigns) || 0,
  } : undefined;
  return {
    promotions,
    categories,
    announcements,
    sourceCounts: { scheduler_browser: promotions.length },
  };
}

function announcementCampaignsFromRequest(req) {
  const body = requestBody(req);
  if (!body || !Array.isArray(body.announcementCampaigns)) return null;
  const announcementCampaigns = body.announcementCampaigns.slice(0, MAX_SENT_IDS).map((item) => ({
    id: String(item.id || item.url || '').slice(0, 1000),
    url: String(item.url || '').slice(0, 2000),
    text: String(item.text || '').slice(0, 900),
  })).filter((item) => item.id && item.url && item.text);
  if (announcementCampaigns.length !== body.announcementCampaigns.slice(0, MAX_SENT_IDS).length) return null;
  return { announcementCampaigns };
}

function normalizeCandyDrop(item) {
  const fixed = item.fixedRewards && typeof item.fixedRewards === 'object' ? {
    totalAmount: Number(item.fixedRewards.totalAmount),
    individualCap: Number(item.fixedRewards.individualCap),
    symbol: String(item.fixedRewards.symbol || '').slice(0, 30).toUpperCase(),
    hasCandy: item.fixedRewards.hasCandy === true,
  } : null;
  const candyDrop = {
    id: String(item.id || item.url || '').slice(0, 1000),
    url: String(item.url || '').slice(0, 2000),
    name: String(item.name || '').slice(0, 200),
    pool: String(item.pool || '').slice(0, 300),
    candyType: String(item.candyType || '').slice(0, 300),
    startIn: String(item.startIn || '').slice(0, 100),
    ...(fixed ? { fixedRewards: fixed } : {}),
  };
  const validFixed = !/Зафиксированные награды/i.test(candyDrop.candyType) || (
    fixed && Number.isFinite(fixed.totalAmount) && fixed.totalAmount > 0 &&
    Number.isFinite(fixed.individualCap) && fixed.individualCap > 0 && fixed.symbol
  );
  if (!/Зафиксированные награды/i.test(candyDrop.candyType)) delete candyDrop.fixedRewards;
  return candyDrop.id && candyDrop.url && candyDrop.name && candyDrop.pool && candyDrop.candyType &&
    candyDrop.startIn && validFixed ? candyDrop : null;
}

function candyDropsFromRequest(req) {
  const body = requestBody(req);
  if (!body || !Array.isArray(body.candyDrops)) return null;
  const candyDrops = body.candyDrops.slice(0, MAX_SENT_IDS).map(normalizeCandyDrop).filter(Boolean);
  if (candyDrops.length !== body.candyDrops.slice(0, MAX_SENT_IDS).length) return null;
  return { candyDrops };
}

function futuresPointsFromRequest(req) {
  const body = requestBody(req);
  if (!body || !Array.isArray(body.futuresPoints)) return null;
  const futuresPoints = body.futuresPoints.slice(0, MAX_SENT_IDS).map((item) => ({
    id: String(item.id || '').slice(0, 1000),
    url: String(item.url || '').slice(0, 2000),
    minPoints: String(item.minPoints || '').slice(0, 100),
    spentPoints: String(item.spentPoints || '').slice(0, 100),
    voucherAmount: String(item.voucherAmount || '').slice(0, 200),
    startsIn: String(item.startsIn || '').slice(0, 100),
  })).filter((item) => item.id && item.url && item.minPoints && item.spentPoints && item.voucherAmount && item.startsIn);
  if (futuresPoints.length !== body.futuresPoints.slice(0, MAX_SENT_IDS).length) return null;
  return { futuresPoints };
}

function futuresLotteryFromRequest(req) {
  const body = requestBody(req);
  if (!body || !Array.isArray(body.futuresLottery)) return null;
  const futuresLottery = body.futuresLottery.slice(0, MAX_SENT_IDS).map((item) => ({
    id: String(item.id || '').slice(0, 1000),
    url: String(item.url || '').slice(0, 2000),
    rewardAmount: String(item.rewardAmount || '').slice(0, 200),
    minPoints: String(item.minPoints || '').slice(0, 100),
    winningSlots: String(item.winningSlots || '').slice(0, 100),
  })).filter((item) => item.id && item.url && item.rewardAmount && item.minPoints && item.winningSlots);
  if (futuresLottery.length !== body.futuresLottery.slice(0, MAX_SENT_IDS).length) return null;
  return { futuresLottery };
}

function launchpoolsFromRequest(req) {
  const body = requestBody(req);
  if (!body || !Array.isArray(body.launchpools)) return null;
  const launchpools = body.launchpools.slice(0, MAX_SENT_IDS).map((item) => ({
    id: String(item.id || '').slice(0, 1000),
    url: String(item.url || '').slice(0, 2000),
    project: String(item.project || '').slice(0, 100),
    totalRewards: String(item.totalRewards || '').slice(0, 300),
    stakingPeriod: String(item.stakingPeriod || '').slice(0, 100),
  })).filter((item) => item.id && item.url && item.project && item.totalRewards && item.stakingPeriod);
  if (launchpools.length !== body.launchpools.slice(0, MAX_SENT_IDS).length) return null;
  return { launchpools };
}

async function sendTelegram(text, { silent = false } = {}) {
  const token = env('TELEGRAM_BOT_TOKEN').trim();
  const chatId = env('TELEGRAM_CHAT_ID').trim();
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_notification: silent,
    }),
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
  const testNotification = req.method === 'POST' && req.headers['x-gate-bot-test'] === 'true';
  const body = requestBody(req);
  const hasPayload = (name) => body && Object.prototype.hasOwnProperty.call(body, name);
  const hasPromotions = hasPayload('promotions');
  const hasAnnouncementCampaigns = hasPayload('announcementCampaigns');
  const hasCandyDrops = hasPayload('candyDrops');
  const hasFuturesPoints = hasPayload('futuresPoints');
  const hasFuturesLottery = hasPayload('futuresLottery');
  const hasLaunchpools = hasPayload('launchpools');
  const scheduledPromotions = hasPromotions ? promotionsFromRequest(req) : null;
  const scheduledAnnouncementCampaigns = hasAnnouncementCampaigns ? announcementCampaignsFromRequest(req) : null;
  const scheduledCandyDrops = hasCandyDrops ? candyDropsFromRequest(req) : null;
  const scheduledFuturesPoints = hasFuturesPoints ? futuresPointsFromRequest(req) : null;
  const scheduledFuturesLottery = hasFuturesLottery ? futuresLotteryFromRequest(req) : null;
  const scheduledLaunchpools = hasLaunchpools ? launchpoolsFromRequest(req) : null;
  // Partner transaction history is a commission/trade ledger, not a source of
  // promotion cards. Never couple it to scheduled POST payloads: doing so can
  // flood Telegram with unrelated trades when the transaction baseline moves.
  // Keep it available only for an explicitly enabled manual GET diagnostic.
  const checkTransactions = req.method === 'GET' && process.env.ENABLE_PARTNER_TRANSACTION_ALERTS === 'true';
  const skipped = Symbol('skipped');

  let acquiredLock = false;
  try {
    acquiredLock = (await redis(['SET', LOCK_KEY, '1', 'NX', 'EX', 30])) === 'OK';
    if (!acquiredLock) {
      res.setHeader('Retry-After', '2');
      return respond(res, 503, { ok: false, retryable: 'check_already_running' });
    }

    const limit = Math.min(Math.max(Number(process.env.TRANSACTION_PAGE_SIZE || 100), 1), 100);
    const [
      activityResult,
      promotionResult,
      announcementCampaignResult,
      candyDropResult,
      futuresPointsResult,
      futuresLotteryResult,
      launchpoolResult,
      savedState,
    ] = await Promise.all([
      checkTransactions
        ? gateGet('/rebate/partner/transaction_history', { page: 1, limit })
        : Promise.resolve(skipped),
      !hasPromotions
        ? Promise.resolve(skipped)
        : scheduledPromotions
        ? Promise.resolve(scheduledPromotions)
        : Promise.reject(new Error('Promotion payload from scheduler browser is missing or empty')),
      !hasAnnouncementCampaigns
        ? Promise.resolve(skipped)
        : scheduledAnnouncementCampaigns
        ? Promise.resolve(scheduledAnnouncementCampaigns)
        : Promise.reject(new Error('Announcement campaign payload from scheduler browser is invalid')),
      !hasCandyDrops
        ? Promise.resolve(skipped)
        : scheduledCandyDrops
        ? Promise.resolve(scheduledCandyDrops)
        : Promise.reject(new Error('CandyDrop payload from scheduler browser is missing or invalid')),
      !hasFuturesPoints
        ? Promise.resolve(skipped)
        : scheduledFuturesPoints
        ? Promise.resolve(scheduledFuturesPoints)
        : Promise.reject(new Error('Futures Points payload from scheduler browser is missing or invalid')),
      !hasFuturesLottery
        ? Promise.resolve(skipped)
        : scheduledFuturesLottery
        ? Promise.resolve(scheduledFuturesLottery)
        : Promise.reject(new Error('Futures Points lottery payload from scheduler browser is missing or invalid')),
      !hasLaunchpools
        ? Promise.resolve(skipped)
        : scheduledLaunchpools
        ? Promise.resolve(scheduledLaunchpools)
        : Promise.reject(new Error('Launchpool payload from scheduler browser is missing or invalid')),
      loadState(),
    ].map((promise) => Promise.resolve(promise).then(
      (value) => value === skipped ? { skipped: true } : { ok: true, value },
      (error) => ({ ok: false, error })
    )));

    const state = savedState.ok && savedState.value ? savedState.value : {};
    const result = {
      ok: true,
      initialized: [],
      sent: {
        transactions: 0,
        promotions: 0,
        announcementCampaigns: 0,
        candyDrops: 0,
        futuresPoints: 0,
        futuresLottery: 0,
        launchpools: 0,
      },
      errors: {},
    };
    const deliveries = [];
    const currentIdsBySource = {};

    if (activityResult.skipped) {
      // A source-specific scheduler request must not touch unrelated state.
    } else if (activityResult.ok) {
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

    if (promotionResult.skipped) {
      // A source-specific scheduler request must not touch unrelated state.
    } else if (promotionResult.ok) {
      const { promotions, categories, announcements, sourceCounts } = promotionResult.value;
      const currentIds = promotions.map((promotion) => promotion.id);
      const known = initializeSource(state, 'promotions', currentIds);
      if (known.initialized) result.initialized.push('promotions');
      const seen = new Set([
        ...(known.sentIds || []),
        ...(state.announcementCampaigns?.sentIds || []),
      ]);
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
      if (announcements) result.announcements = announcements;
      result.promotionSources = sourceCounts;
      result.sent.promotions = fresh.length;
    } else {
      result.errors.promotions = promotionResult.error.message;
    }

    if (announcementCampaignResult.skipped) {
      // A source-specific scheduler request must not touch unrelated state.
    } else if (announcementCampaignResult.ok) {
      const { announcementCampaigns } = announcementCampaignResult.value;
      const currentIds = announcementCampaigns.map((promotion) => promotion.id);
      const known = initializeSource(state, 'announcementCampaigns', currentIds);
      if (known.initialized) result.initialized.push('announcementCampaigns');
      const seen = new Set([
        ...(known.sentIds || []),
        ...(state.promotions?.sentIds || []),
        ...(currentIdsBySource.promotions || []),
      ]);
      const fresh = known.initialized
        ? []
        : announcementCampaigns.filter((promotion) => !seen.has(promotion.id));
      deliveries.push(...fresh.reverse().map((promotion) => ({
        source: 'announcementCampaigns',
        id: promotion.id,
        text: formatPromotion(promotion),
      })));
      state.announcementCampaigns = { sentIds: uniqueIds(known.sentIds || []) };
      currentIdsBySource.announcementCampaigns = currentIds;
      result.announcementCampaigns = announcementCampaigns.length;
      result.sent.announcementCampaigns = fresh.length;
    } else {
      result.errors.announcementCampaigns = announcementCampaignResult.error.message;
    }

    if (candyDropResult.skipped) {
      // A source-specific scheduler request must not touch unrelated state.
    } else if (candyDropResult.ok) {
      const { candyDrops } = candyDropResult.value;
      const currentIds = candyDrops.map((candyDrop) => candyDrop.id);
      const known = initializeSource(state, 'candyDrops', currentIds);
      if (known.initialized) result.initialized.push('candyDrops');
      const seen = new Set(known.sentIds || []);
      const fresh = known.initialized ? [] : candyDrops.filter((candyDrop) => !seen.has(candyDrop.id));
      deliveries.push(...fresh.reverse().map((candyDrop) => ({
        source: 'candyDrops',
        id: candyDrop.id,
        candyDrop,
      })));
      state.candyDrops = { sentIds: uniqueIds(known.sentIds || []) };
      currentIdsBySource.candyDrops = currentIds;
      result.candyDrops = candyDrops.length;
      result.sent.candyDrops = fresh.length;
    } else {
      result.errors.candyDrops = candyDropResult.error.message;
    }

    if (futuresPointsResult.skipped) {
      // A source-specific scheduler request must not touch unrelated state.
    } else if (futuresPointsResult.ok) {
      const { futuresPoints } = futuresPointsResult.value;
      const currentIds = futuresPoints.map((promotion) => promotion.id);
      const known = initializeSource(state, 'futuresPoints', currentIds);
      if (known.initialized) result.initialized.push('futuresPoints');
      const seen = new Set(known.sentIds || []);
      const fresh = known.initialized ? [] : futuresPoints.filter((promotion) => !seen.has(promotion.id));
      deliveries.push(...fresh.reverse().map((promotion) => ({
        source: 'futuresPoints',
        id: promotion.id,
        text: formatFuturesPoints(promotion),
      })));
      state.futuresPoints = { sentIds: uniqueIds(known.sentIds || []) };
      currentIdsBySource.futuresPoints = currentIds;
      result.futuresPoints = futuresPoints.length;
      result.sent.futuresPoints = fresh.length;
    } else {
      result.errors.futuresPoints = futuresPointsResult.error.message;
    }

    if (futuresLotteryResult.skipped) {
      // A source-specific scheduler request must not touch unrelated state.
    } else if (futuresLotteryResult.ok) {
      const { futuresLottery } = futuresLotteryResult.value;
      const currentIds = futuresLottery.map((promotion) => promotion.id);
      const known = initializeSource(state, 'futuresLottery', currentIds);
      if (known.initialized) result.initialized.push('futuresLottery');
      const seen = new Set(known.sentIds || []);
      const fresh = known.initialized ? [] : futuresLottery.filter((promotion) => !seen.has(promotion.id));
      deliveries.push(...fresh.reverse().map((promotion) => ({
        source: 'futuresLottery',
        id: promotion.id,
        text: formatFuturesLottery(promotion),
      })));
      state.futuresLottery = { sentIds: uniqueIds(known.sentIds || []) };
      currentIdsBySource.futuresLottery = currentIds;
      result.futuresLottery = futuresLottery.length;
      result.sent.futuresLottery = fresh.length;
    } else {
      result.errors.futuresLottery = futuresLotteryResult.error.message;
    }

    if (launchpoolResult.skipped) {
      // A source-specific scheduler request must not touch unrelated state.
    } else if (launchpoolResult.ok) {
      const { launchpools } = launchpoolResult.value;
      const currentIds = launchpools.map((promotion) => promotion.id);
      const known = initializeSource(state, 'launchpools', currentIds);
      if (known.initialized) result.initialized.push('launchpools');
      const seen = new Set(known.sentIds || []);
      const fresh = known.initialized ? [] : launchpools.filter((promotion) => !seen.has(promotion.id));
      deliveries.push(...fresh.reverse().map((promotion) => ({
        source: 'launchpools',
        id: promotion.id,
        text: formatLaunchpool(promotion),
      })));
      state.launchpools = { sentIds: uniqueIds(known.sentIds || []) };
      currentIdsBySource.launchpools = currentIds;
      result.launchpools = launchpools.length;
      result.sent.launchpools = fresh.length;
    } else {
      result.errors.launchpools = launchpoolResult.error.message;
    }

    state.initializedAt = state.initializedAt || new Date().toISOString();
    state.checkedAt = new Date().toISOString();
    // Save a new-source baseline before sending, then checkpoint every
    // accepted message. A partial Telegram failure retries only the remaining
    // items on the next scheduler run.
    await saveState(state);
    for (const delivery of deliveries) {
      await sendTelegram(delivery.candyDrop ? await formatCandyDrop(delivery.candyDrop) : delivery.text);
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
    if (testNotification) {
      await sendTelegram(formatFuturesLottery({
        url: 'https://www.gate.com/ru/futures/points/ended?section=lottery',
        rewardAmount: '15 USD1',
        minPoints: '70',
        winningSlots: '7000',
      }, { test: true }), { silent: true });
      result.testNotification = true;
      result.testNotifications = 1;
    }
    const hasErrors = Object.keys(result.errors).length > 0;
    result.ok = !hasErrors;
    return respond(res, hasErrors ? 502 : 200, result);
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
