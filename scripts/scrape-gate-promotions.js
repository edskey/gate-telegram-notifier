const { execFile, execFileSync } = require('child_process');
const crypto = require('crypto');
const { setTimeout: delay } = require('timers/promises');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const ORIGIN = 'https://www.gate.com';
const CANDY_DROP_URL = `${ORIGIN}/ru/candy-drop`;
const LAUNCHPOOL_URL = `${ORIGIN}/ru/launchpool`;
const FUTURES_POINTS_URL = `${ORIGIN}/ru/futures/points/upcoming`;
const FUTURES_LOTTERY_URL = `${ORIGIN}/ru/futures/points/ended?section=lottery`;
const ANNOUNCEMENTS_ACTIVITY_URL = `${ORIGIN}/ru/announcements/activity`;
const ANNOUNCEMENT_ARTICLE_LIMIT = 15;
const REWARD_HUB_CATEGORY_IDS = {
  fast: [14, 213, 1066, 1],
  'half-hour': [17],
  hourly: [1037, 7],
};
const KNOWN_CATEGORIES = [...new Set(Object.values(REWARD_HUB_CATEGORY_IDS).flat())]
  .map((id) => `${ORIGIN}/ru/rewards_hub/activity-center-${id}-ongoing`);
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

function findChrome() {
  const candidates = [process.env.CHROME_PATH, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
    .filter(Boolean);
  for (const command of candidates) {
    try {
      execFileSync(command, ['--version'], { stdio: 'ignore' });
      return command;
    } catch { /* try the next executable */ }
  }
  throw new Error('Chrome executable was not found on the scheduler');
}

async function dumpPageOnce(chrome, url, virtualTimeBudget, { windowSize } = {}) {
  const { stdout } = await execFileAsync(chrome, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    ...(windowSize ? [`--window-size=${windowSize}`] : []),
    `--user-agent=${USER_AGENT}`,
    `--virtual-time-budget=${virtualTimeBudget}`,
    '--run-all-compositor-stages-before-draw',
    '--dump-dom',
    url,
  ], { timeout: 45000, maxBuffer: 50 * 1024 * 1024 });
  if (!stdout || stdout.length < 500) throw new Error(`Gate returned an empty page for ${url}`);
  return stdout;
}

async function dumpPage(chrome, url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await dumpPageOnce(chrome, url, 8000 + ((attempt - 1) * 6000));
    } catch (error) {
      lastError = error;
      const reason = String(error.message || error).replace(/\s+/g, ' ').slice(0, 500);
      process.stderr.write(`Gate page attempt ${attempt}/${attempts} failed for ${url}: ${reason}\n`);
      if (attempt < attempts) await delay(1000 * (2 ** (attempt - 1)));
    }
  }
  throw new Error(`Gate page failed after ${attempts} attempts for ${url}: ${lastError?.message || lastError}`);
}

function decodeHtml(value) {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
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

function discoverCategories(html) {
  const urls = new Set(KNOWN_CATEGORIES);
  const hrefPattern = /href=(?:"([^"]+)"|'([^']+)')/gi;
  let match;
  while ((match = hrefPattern.exec(html)) !== null) {
    let url;
    try { url = new URL(match[1] || match[2], ORIGIN); } catch { continue; }
    if (/\/rewards_hub\/activity-center-\d+-ongoing$/i.test(url.pathname)) {
      urls.add(`${url.origin}/ru${url.pathname.replace(/^\/ru/, '')}`);
    }
  }
  return [...urls];
}

function isPromotionLink(url, text) {
  if (/\/(?:campaigns\/\d+|referral\/earn-together|competition\/[^/?#]+|launchpool\/[^/?#]+)/i.test(url.pathname)) {
    return true;
  }
  return /(?:Обратный отсчет|Countdown|Ends? in)/i.test(text) && !/activity-center-/i.test(url.pathname);
}

function promotionUrls(url) {
  if (url.origin !== ORIGIN) {
    const stableUrl = `${url.origin}${url.pathname}`;
    return { id: stableUrl, url: stableUrl };
  }
  const pathWithoutLocale = url.pathname.replace(/^\/(?:ru|en)(?=\/)/i, '');
  return {
    id: `${ORIGIN}${pathWithoutLocale}`,
    url: `${ORIGIN}/ru${pathWithoutLocale}`,
  };
}

function extractPromotions(html) {
  const promotions = [];
  const anchorPattern = /<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html)) !== null) {
    let url;
    try { url = new URL(match[1] || match[2], ORIGIN); } catch { continue; }
    const text = decodeHtml(match[3]).slice(0, 900);
    if (!text || !isPromotionLink(url, text)) continue;
    const normalized = promotionUrls(url);
    promotions.push({ ...normalized, text });
  }
  return promotions;
}

function extractAnnouncementArticles(html, limit = ANNOUNCEMENT_ARTICLE_LIMIT) {
  const articles = new Map();
  const anchorPattern = /<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html)) !== null && articles.size < limit) {
    let url;
    try { url = new URL(match[1] || match[2], ORIGIN); } catch { continue; }
    const slug = url.pathname.match(/\/announcements\/article\/(\d+)$/i)?.[1];
    const title = decodeHtml(match[3]).slice(0, 500);
    if (!slug || !title || articles.has(slug)) continue;
    articles.set(slug, {
      id: `announcement:${slug}`,
      url: `${ORIGIN}/ru/announcements/article/${slug}`,
      title,
    });
  }
  return [...articles.values()];
}

function extractAnnouncementCampaigns(html, article = {}) {
  const headingMatch = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const heading = headingMatch ? decodeHtml(headingMatch[1]).slice(0, 900) : '';
  const text = heading || String(article.title || '').slice(0, 900);
  return extractPromotions(html)
    .filter((promotion) => /\/campaigns\/\d+$/i.test(new URL(promotion.id).pathname))
    .map((promotion) => ({ ...promotion, text: text || promotion.text }));
}

function balancedDiv(html, startIndex) {
  const divPattern = /<\/?div\b[^>]*>/gi;
  divPattern.lastIndex = startIndex;
  let depth = 0;
  let match;
  while ((match = divPattern.exec(html)) !== null) {
    if (/^<\/div/i.test(match[0])) depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(startIndex, divPattern.lastIndex);
  }
  return null;
}

function normalizeTimer(value) {
  return value
    .replace(/\s*:\s*/g, ':')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseGateNumber(value) {
  const compact = String(value).replace(/[\s\u00a0]/g, '');
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(compact)) return Number(compact.replace(/,/g, ''));
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(compact)) {
    return Number(compact.replace(/\./g, '').replace(',', '.'));
  }
  return Number(compact.replace(',', '.'));
}

function extractFixedRewardDetails(html) {
  const unique = new Map();
  const poolPattern = /<div\b[^>]*\bid=(?:"prize-pool-[^"]+"|'prize-pool-[^']+')[^>]*>/gi;
  let poolStart;
  while ((poolStart = poolPattern.exec(html)) !== null) {
    const poolHtml = balancedDiv(html, poolStart.index);
    if (!poolHtml) continue;
    const text = decodeHtml(poolHtml);
    if (!/^(?:Fixed Rewards|Зафиксированные награды)/i.test(text)) continue;

    const capLabel = /(?:Individual Cap|Индивидуальный лимит)/i.exec(text);
    if (!capLabel) continue;
    const heading = text.slice(0, capLabel.index);
    const capText = text.slice(capLabel.index + capLabel[0].length);
    const amountPattern = /([0-9][0-9\s.,]*)\s*([A-Z][A-Z0-9._-]*)/gi;
    const headingAmounts = [...heading.matchAll(amountPattern)];
    const capMatch = amountPattern.exec(capText);
    if (headingAmounts.length === 0 || !capMatch) continue;

    const totalMatch = headingAmounts.at(-1);
    const totalAmount = parseGateNumber(totalMatch[1]);
    const individualCap = parseGateNumber(capMatch[1]);
    const totalSymbol = totalMatch[2].toUpperCase();
    const capSymbol = capMatch[2].toUpperCase();
    if (!Number.isFinite(totalAmount) || !Number.isFinite(individualCap) || individualCap <= 0 || totalSymbol !== capSymbol) {
      continue;
    }
    const detail = {
      totalAmount,
      individualCap,
      symbol: capSymbol,
      hasCandy: /\bcand(?:y|ies)\b/i.test(text),
    };
    unique.set(JSON.stringify(detail), detail);
  }
  if (unique.size === 0) throw new Error('Could not parse the Fixed Rewards pool and Individual Cap');
  return [...unique.values()][0];
}

function extractCandyDrops(html) {
  const candyDrops = [];
  const cardPattern = /<div\b[^>]*class=(?:"[^"]*\bcursor-pointer\b[^"]*"|'[^']*\bcursor-pointer\b[^']*')[^>]*>/gi;
  let cardStart;
  while ((cardStart = cardPattern.exec(html)) !== null) {
    const cardHtml = balancedDiv(html, cardStart.index);
    if (!cardHtml) continue;
    const linkMatch = cardHtml.match(/<a\b[^>]*href=(?:"([^"]*\/candy-drop\/detail\/[^"]+)"|'([^']*\/candy-drop\/detail\/[^']+)')[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const text = decodeHtml(cardHtml);
    if (!/(?:Start(?:s)? in|Начинается в)/i.test(text)) continue;

    const rawHref = linkMatch[1] || linkMatch[2];
    let parsedUrl;
    try { parsedUrl = new URL(rawHref, ORIGIN); } catch { continue; }
    const slugMatch = parsedUrl.pathname.match(/\/candy-drop\/detail\/([^/?#]+)/i);
    if (!slugMatch) continue;
    const slug = slugMatch[1];
    const name = decodeHtml(linkMatch[3]).trim();
    const poolMatch = text.match(/([0-9][0-9\s.,]*\s+[$A-Z][A-Z0-9._-]*)\s*≈\s*([0-9][0-9\s.,]*\s+USDT)/i);
    const timerMatch = text.match(/(?:Start(?:s)? in|Начинается в)\s+([0-9Dд:\s]+)/i);
    const hasShared = /(?:Share(?:d)? Rewards|Разделите награды)/i.test(text);
    const hasFixed = /(?:Fixed Rewards|Зафиксированные награды)/i.test(text);
    const candyTypes = [
      hasShared ? 'Разделите награды' : null,
      hasFixed ? 'Зафиксированные награды' : null,
    ].filter(Boolean);

    if (!name || !poolMatch || !timerMatch || candyTypes.length === 0) {
      throw new Error(`Could not parse every Upcoming CandyDrop field for ${slug}`);
    }
    candyDrops.push({
      id: `candy:${slug}`,
      url: `${ORIGIN}/ru/candy-drop/detail/${slug}`,
      name: name.slice(0, 200),
      pool: `${poolMatch[1]} ≈ ${poolMatch[2]}`.replace(/\s+/g, ' ').trim(),
      candyType: candyTypes.join(' и '),
      startIn: normalizeTimer(timerMatch[1]),
    });
  }
  return candyDrops;
}

function extractLaunchpoolPromotions(html) {
  const promotions = new Map();
  const anchorPattern = /<a\b[^>]*href=(?:"([^"]*\/launchpool\/[^"#]+)"|'([^']*\/launchpool\/[^'#]+)')[^>]*>([\s\S]*?)<\/a>/gi;
  let anchorMatch;
  while ((anchorMatch = anchorPattern.exec(html)) !== null) {
    let parsedUrl;
    try { parsedUrl = new URL(anchorMatch[1] || anchorMatch[2], ORIGIN); } catch { continue; }
    const pathMatch = parsedUrl.pathname.match(/\/(?:ru|en)?\/?launchpool\/([^/?#]+)/i);
    if (!pathMatch) continue;

    const windowStart = Math.max(0, anchorMatch.index - 50000);
    const prefix = html.slice(windowStart, anchorMatch.index);
    const divPattern = /<div\b[^>]*>/gi;
    const starts = [];
    let divMatch;
    while ((divMatch = divPattern.exec(prefix)) !== null) starts.push(windowStart + divMatch.index);

    let cardHtml;
    for (const start of starts.slice(-35).reverse()) {
      const candidate = balancedDiv(html, start);
      if (!candidate || !candidate.includes(anchorMatch[0])) continue;
      const candidateText = decodeHtml(candidate);
      if (
        /(?:Всего\s*Наград|Total Rewards)/i.test(candidateText) &&
        /(?:Период\s*стейкинга|Staking Period)/i.test(candidateText) &&
        /(?:Заканчивается\s*в|Ends? in|Начинается\s*в|Starts? in)/i.test(candidateText)
      ) {
        cardHtml = candidate;
        break;
      }
    }
    if (!cardHtml) continue;

    const text = decodeHtml(cardHtml);
    const project = decodeHtml(anchorMatch[3]).trim().slice(0, 100);
    const rewardsMatch = text.match(
      /(?:Всего\s*Наград|Total Rewards)\s*([0-9][0-9\s.,]*\s*[A-Z][A-Z0-9._-]*)\s*(?:≈|~)\s*((?:[0-9][0-9\s.,]*|--)\s*USDT)/i
    );
    const periodMatch = text.match(
      /(?:Период\s*стейкинга|Staking Period)\s*([0-9][0-9\s.,]*\s*(?:дня\s*\(дней\)|дн(?:я|ей)?|days?))/i
    );
    if (!project || !rewardsMatch || !periodMatch) continue;

    const projectKey = parsedUrl.searchParams.get('pid') || decodeURIComponent(pathMatch[1]);
    const localizedPath = parsedUrl.pathname.replace(/^\/(?:ru|en)(?=\/)/i, '/ru');
    const pidQuery = parsedUrl.searchParams.get('pid');
    const url = `${ORIGIN}${localizedPath}${pidQuery ? `?pid=${encodeURIComponent(pidQuery)}` : ''}`;
    const id = `launchpool:${projectKey}`;
    promotions.set(id, {
      id,
      url,
      project,
      totalRewards: `${rewardsMatch[1]} ≈ ${rewardsMatch[2]}`.replace(/\s+/g, ' ').trim(),
      stakingPeriod: periodMatch[1].replace(/\s+/g, ' ').trim(),
    });
  }
  return [...promotions.values()];
}

function parseLaunchpoolPage(html) {
  const text = decodeHtml(html);
  if (!/Launchpool/i.test(text)) {
    process.stderr.write('Warning: Gate Launchpool heading not found on page\n');
    return [];
  }
  const promotions = extractLaunchpoolPromotions(html);
  const ongoingCount = Number(text.match(/(?:В\s*процессе|Ongoing)\s*\((\d+)\)/i)?.[1] || 0);
  const upcomingCount = Number(text.match(/(?:Предстоящие|Upcoming)\s*\((\d+)\)/i)?.[1] || 0);
  const expected = ongoingCount + upcomingCount;
  if (expected > promotions.length) {
    process.stderr.write(`Notice: Gate Launchpool extracted ${promotions.length} cards (expected ~${expected})\n`);
  }
  return promotions;
}

function extractFuturesPointPromotions(html) {
  const promotions = new Map();
  const labelPattern = /(?:Мин\.\s*требуемые\s*баллы|Minimum Required Points)/gi;
  let labelMatch;
  while ((labelMatch = labelPattern.exec(html)) !== null) {
    const windowStart = Math.max(0, labelMatch.index - 50000);
    const prefix = html.slice(windowStart, labelMatch.index);
    const divPattern = /<div\b[^>]*>/gi;
    const starts = [];
    let divMatch;
    while ((divMatch = divPattern.exec(prefix)) !== null) starts.push(windowStart + divMatch.index);

    let cardHtml;
    for (const start of starts.slice(-30).reverse()) {
      const candidate = balancedDiv(html, start);
      if (!candidate) continue;
      const candidateText = normalizeTimer(decodeHtml(candidate));
      const minLabelCount = candidateText.match(/(?:Мин\.\s*требуемые\s*баллы|Minimum Required Points)/gi)?.length || 0;
      const spentLabelCount = candidateText.match(/(?:Потраченные\s*баллы|Points Spent)/gi)?.length || 0;
      if (
        minLabelCount === 1 &&
        spentLabelCount === 1 &&
        /(?:Аирдроп\s*начнется\s*через|Airdrop starts in)/i.test(candidateText) &&
        /(?:Предстоящие|Upcoming)/i.test(candidateText)
      ) {
        // This is the smallest complete card boundary. Do not climb to a
        // parent grid looking for Voucher Amount: that can combine fields and
        // countdowns from adjacent cards into a changing phantom event.
        cardHtml = candidate;
        break;
      }
    }
    if (!cardHtml) continue;

    const text = normalizeTimer(decodeHtml(cardHtml));
    const minMatch = text.match(/(?:Мин\.\s*требуемые\s*баллы|Minimum Required Points)\s*:?\s*([0-9][0-9\s.,]*)/i);
    const spentMatch = text.match(/(?:Потраченные\s*баллы|Points Spent)\s*:?\s*([0-9][0-9\s.,]*)/i);
    const voucherMatch = text.match(/(?:Сумма\s*ваучера|Voucher Amount)\s*:?\s*([0-9][0-9\s.,]*\s*[A-Z][A-Z0-9._-]*)/i);
    const timerMatch = text.match(
      /(?:Аирдроп\s*начнется\s*через|Airdrop starts in)\s*:?\s*((?:[0-9]+\s*[ДD]\s*)?[0-9]{1,2}:[0-9]{2}:[0-9]{2})/i
    );
    if (!minMatch || !spentMatch || !voucherMatch || !timerMatch) continue;

    const minPoints = String(parseGateNumber(minMatch[1]));
    const spentPoints = String(parseGateNumber(spentMatch[1]));
    const voucherAmount = voucherMatch[1].replace(/\s+/g, ' ').trim();
    const startsIn = timerMatch[1].replace(/\s+/g, '').replace(/D/i, 'Д');
    // Keep compatibility with IDs already stored before the card-boundary fix.
    // The prior correct voucher card used an empty descriptor; only the
    // cross-card phantom included a changing countdown in that descriptor.
    const signature = ['', minPoints, spentPoints, voucherAmount].join('|');
    const id = `futures-points:${crypto.createHash('sha256').update(signature).digest('hex')}`;
    promotions.set(id, {
      id,
      url: FUTURES_POINTS_URL,
      minPoints,
      spentPoints,
      voucherAmount,
      startsIn,
    });
  }
  return [...promotions.values()];
}

function extractFuturesLotteryPromotions(html) {
  const promotions = new Map();
  const labelPattern = /(?:Сумма\s*награды|Reward Amount)/gi;
  let labelMatch;
  while ((labelMatch = labelPattern.exec(html)) !== null) {
    const windowStart = Math.max(0, labelMatch.index - 50000);
    const prefix = html.slice(windowStart, labelMatch.index);
    const divPattern = /<div\b[^>]*>/gi;
    const starts = [];
    let divMatch;
    while ((divMatch = divPattern.exec(prefix)) !== null) starts.push(windowStart + divMatch.index);

    let cardHtml;
    for (const start of starts.slice(-30).reverse()) {
      const candidate = balancedDiv(html, start);
      if (!candidate) continue;
      const candidateText = decodeHtml(candidate);
      if (
        /(?:Сумма\s*награды|Reward Amount)/i.test(candidateText) &&
        /(?:Мин\.\s*баллов\s*требуется|Minimum Points Required)/i.test(candidateText) &&
        /(?:Выигрышные\s*слоты|Winning Slots)/i.test(candidateText) &&
        /(?:Время\s*розыгрыша|Draw Time)/i.test(candidateText) &&
        /(?:Объявлено|Анонсировано|Announced)/i.test(candidateText)
      ) {
        cardHtml = candidate;
        break;
      }
    }
    if (!cardHtml) continue;

    const text = decodeHtml(cardHtml);
    const rewardMatch = text.match(
      /(?:Сумма\s*награды|Reward Amount)\s*:?[\s]*([0-9][0-9\s.,]*\s*[A-Z][A-Z0-9._-]*)/i
    );
    const minMatch = text.match(
      /(?:Мин\.\s*баллов\s*требуется|Minimum Points Required)\s*:?\s*([0-9][0-9\s.,]*)/i
    );
    const slotsMatch = text.match(
      /(?:Выигрышные\s*слоты|Winning Slots)\s*:?\s*([0-9][0-9\s.,]*)/i
    );
    const drawTimeMatch = text.match(
      /(?:Время\s*розыгрыша|Draw Time)\s*:?\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/i
    );
    if (!rewardMatch || !minMatch || !slotsMatch || !drawTimeMatch) continue;

    const rewardAmount = rewardMatch[1].replace(/\s+/g, ' ').trim();
    const minPoints = String(parseGateNumber(minMatch[1]));
    const winningSlotsNumber = parseGateNumber(slotsMatch[1]);
    if (!Number.isFinite(Number(minPoints)) || !Number.isFinite(winningSlotsNumber)) continue;
    const winningSlots = String(winningSlotsNumber);
    const signature = [rewardAmount, minPoints, winningSlots, drawTimeMatch[1]].join('|');
    const id = `futures-lottery:${crypto.createHash('sha256').update(signature).digest('hex')}`;
    promotions.set(id, {
      id,
      url: FUTURES_LOTTERY_URL,
      rewardAmount,
      minPoints,
      winningSlots,
    });
  }
  return [...promotions.values()];
}

function parseFuturesLotteryPage(html) {
  const text = decodeHtml(html);
  if (!/(?:Счастливый\s*розыгрыш|Lucky Draw)/i.test(text)) {
    process.stderr.write('Warning: Futures Points Lucky Draw section heading not found\n');
    return [];
  }
  const promotions = extractFuturesLotteryPromotions(html);
  const announcedCountMatch = text.match(/(?:Анонсировано|Announced)\s*\((\d+)\)/i);
  if (announcedCountMatch && Number(announcedCountMatch[1]) > 0 && promotions.length === 0) {
    process.stderr.write(`Notice: Gate Lottery tab indicated ${announcedCountMatch[1]} announced cards, but 0 cards matched current parser selectors\n`);
  }
  return promotions;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function collectCandyDrops(chrome) {
  const candyHtml = await dumpPage(chrome, CANDY_DROP_URL);
  if (!/(?:Upcoming|Предстоящие)/i.test(decodeHtml(candyHtml))) {
    throw new Error('Headless Chrome could not verify the CandyDrop Upcoming section');
  }
  const candyDrops = extractCandyDrops(candyHtml);
  return mapWithConcurrency(candyDrops, 2, async (candyDrop) => {
    if (!/Зафиксированные награды/i.test(candyDrop.candyType)) return candyDrop;
    const detailHtml = await dumpPage(chrome, candyDrop.url);
    return { ...candyDrop, fixedRewards: extractFixedRewardDetails(detailHtml) };
  });
}

async function collectLaunchpools(chrome) {
  const budgets = [15000, 24000, 33000];
  let lastError;
  for (let attempt = 0; attempt < budgets.length; attempt += 1) {
    try {
      const html = await dumpPageOnce(chrome, LAUNCHPOOL_URL, budgets[attempt], { windowSize: '1440,1200' });
      return parseLaunchpoolPage(html);
    } catch (error) {
      lastError = error;
      const reason = String(error.message || error).replace(/\s+/g, ' ').slice(0, 500);
      process.stderr.write(`Gate Launchpool attempt ${attempt + 1}/${budgets.length} failed: ${reason}\n`);
      if (attempt < budgets.length - 1) await delay(1000 * (2 ** attempt));
    }
  }
  throw new Error(`Gate Launchpool failed after ${budgets.length} attempts: ${lastError?.message || lastError}`);
}

async function collectAnnouncementCampaigns(chrome) {
  let indexHtml;
  try {
    indexHtml = await dumpPage(chrome, ANNOUNCEMENTS_ACTIVITY_URL);
  } catch (error) {
    process.stderr.write(`Gate announcements index dump failed: ${error.message}\n`);
    return { promotions: [], articleCount: 0, failedArticleCount: 0 };
  }
  const decoded = decodeHtml(indexHtml);
  const articles = extractAnnouncementArticles(indexHtml);
  const isVerified = articles.length > 0 || /(?:Latest Events|Последние события|Анонсы|Активности|События|Announcements|Activity|Events)/i.test(decoded);
  if (!isVerified) {
    process.stderr.write('Warning: Gate announcements page did not match verification signatures\n');
    return { promotions: [], articleCount: 0, failedArticleCount: 0 };
  }
  if (articles.length === 0) {
    return { promotions: [], articleCount: 0, failedArticleCount: 0 };
  }

  const articleResults = await mapWithConcurrency(articles.slice(0, 8), 3, async (article) => {
    try {
      const html = await dumpPage(chrome, article.url);
      return { article, promotions: extractAnnouncementCampaigns(html, article) };
    } catch (error) {
      const reason = String(error.message || error).replace(/\s+/g, ' ').slice(0, 500);
      process.stderr.write(`Gate announcement article failed for ${article.url}: ${reason}\n`);
      return { article, promotions: [], error: reason };
    }
  });
  const unique = new Map();
  for (const result of articleResults) {
    for (const promotion of result.promotions) {
      if (!unique.has(promotion.id)) unique.set(promotion.id, promotion);
    }
  }
  return {
    promotions: [...unique.values()],
    articleCount: articles.length,
    failedArticleCount: articleResults.filter((result) => result.error).length,
  };
}

function categoryUrlsFor(source) {
  return (REWARD_HUB_CATEGORY_IDS[source] || [])
    .map((id) => `${ORIGIN}/ru/rewards_hub/activity-center-${id}-ongoing`);
}

async function collectRewardHubPromotions(chrome, source) {
  const categories = categoryUrlsFor(source);
  const htmlPages = await mapWithConcurrency(categories, 3, (url) => dumpPage(chrome, url));
  const unique = new Map();
  for (let index = 0; index < htmlPages.length; index += 1) {
    const html = htmlPages[index];
    const pagePromotions = extractPromotions(html);
    const pageText = decodeHtml(html);
    if (pagePromotions.length === 0 && !/(?:Rewards Hub|Центр наград|Нет (?:доступных )?(?:акций|заданий)|No (?:activities|tasks))/i.test(pageText)) {
      throw new Error(`Headless Chrome could not verify the Rewards Hub page ${categories[index]}`);
    }
    for (const promotion of pagePromotions) {
      if (!unique.has(promotion.id)) unique.set(promotion.id, promotion);
    }
  }
  return {
    promotions: [...unique.values()],
    categories,
    promotionScan: { complete: true, pageCount: categories.length },
  };
}

async function collectFastPromotions(chrome) {
  const rewardHub = await collectRewardHubPromotions(chrome, 'fast');
  const [futuresPointsHtml, futuresLotteryHtml] = await mapWithConcurrency(
    [FUTURES_POINTS_URL, FUTURES_LOTTERY_URL],
    2,
    (url) => dumpPage(chrome, url)
  );
  if (!/(?:Скоро|Upcoming)/i.test(decodeHtml(futuresPointsHtml))) {
    throw new Error('Headless Chrome could not verify the Futures Points upcoming section');
  }
  return {
    ...rewardHub,
    futuresPoints: extractFuturesPointPromotions(futuresPointsHtml),
    futuresLottery: parseFuturesLotteryPage(futuresLotteryHtml),
  };
}

async function collectHalfHourlyPromotions(chrome) {
  const rewardHub = await collectRewardHubPromotions(chrome, 'half-hour');
  const announcements = await collectAnnouncementCampaigns(chrome);
  return {
    ...rewardHub,
    announcementCampaigns: announcements.promotions,
    announcements: {
      articles: announcements.articleCount,
      failedArticles: announcements.failedArticleCount,
      campaigns: announcements.promotions.length,
    },
  };
}

async function collectHourlyPromotions(chrome) {
  const rewardHub = await collectRewardHubPromotions(chrome, 'hourly');
  let launchpools = [];
  try {
    launchpools = await collectLaunchpools(chrome);
  } catch (error) {
    process.stderr.write(`Launchpool collection error: ${error.message}\n`);
  }
  return { ...rewardHub, launchpools };
}

function mergePayloads(...payloads) {
  const merged = {};
  for (const payload of payloads) {
    for (const [key, value] of Object.entries(payload)) {
      if (Array.isArray(value)) merged[key] = [...(merged[key] || []), ...value];
      else merged[key] = value;
    }
  }
  if (merged.promotions) {
    merged.promotions = [...new Map(merged.promotions.map((item) => [item.id, item])).values()];
  }
  if (merged.categories) merged.categories = [...new Set(merged.categories)];
  if (merged.promotionScan) {
    merged.promotionScan = { complete: true, pageCount: merged.categories?.length || 0 };
  }
  return merged;
}

function requestedSource() {
  const argument = process.argv.find((value) => value.startsWith('--source='));
  const source = argument?.slice('--source='.length) || process.env.GATE_SCRAPE_SOURCE || 'all';
  if (!['all', 'announcements', 'candy', 'core', 'fast', 'half-hour', 'hourly', 'launchpool', 'lottery'].includes(source)) {
    throw new Error(`Unknown scrape source: ${source}`);
  }
  return source;
}

async function main() {
  const chrome = findChrome();
  const source = requestedSource();
  const payload = {};
  if (source === 'all') {
    const fast = await collectFastPromotions(chrome);
    const halfHourly = await collectHalfHourlyPromotions(chrome);
    const hourly = await collectHourlyPromotions(chrome);
    Object.assign(payload, mergePayloads(fast, halfHourly, hourly), {
      candyDrops: await collectCandyDrops(chrome),
    });
  } else if (source === 'candy') {
    payload.candyDrops = await collectCandyDrops(chrome);
  } else if (source === 'announcements') {
    const announcements = await collectAnnouncementCampaigns(chrome);
    payload.announcementCampaigns = announcements.promotions;
    payload.announcements = {
      articles: announcements.articleCount,
      failedArticles: announcements.failedArticleCount,
      campaigns: announcements.promotions.length,
    };
  } else if (source === 'launchpool') {
    payload.launchpools = await collectLaunchpools(chrome);
  } else if (source === 'lottery') {
    payload.futuresLottery = parseFuturesLotteryPage(await dumpPage(chrome, FUTURES_LOTTERY_URL));
  } else if (source === 'fast') {
    Object.assign(payload, await collectFastPromotions(chrome));
  } else if (source === 'half-hour') {
    Object.assign(payload, await collectHalfHourlyPromotions(chrome));
  } else if (source === 'hourly') {
    Object.assign(payload, await collectHourlyPromotions(chrome));
  } else {
    const fast = await collectFastPromotions(chrome);
    const halfHourly = await collectHalfHourlyPromotions(chrome);
    const hourly = await collectHourlyPromotions(chrome);
    Object.assign(payload, mergePayloads(fast, halfHourly, hourly));
  }

  process.stderr.write(
    `Collected ${source}: ${payload.categories?.length || 0} categories, ` +
    `${payload.promotions?.length || 0} promotions, ${payload.announcementCampaigns?.length || 0} announcement campaigns, ` +
    `${payload.candyDrops?.length || 0} Upcoming CandyDrops, ` +
    `${payload.launchpools?.length || 0} active Launchpools, ` +
    `${payload.futuresPoints?.length || 0} Futures Points promotions, ` +
    `${payload.futuresLottery?.length || 0} announced lottery cards, and ` +
    `${payload.announcements?.campaigns || 0} campaigns from ${payload.announcements?.articles || 0} recent announcements\n`
  );
  process.stdout.write(JSON.stringify(payload));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  categoryUrlsFor,
  decodeHtml,
  discoverCategories,
  extractAnnouncementArticles,
  extractAnnouncementCampaigns,
  extractCandyDrops,
  extractFixedRewardDetails,
  extractFuturesLotteryPromotions,
  extractFuturesPointPromotions,
  extractLaunchpoolPromotions,
  extractPromotions,
  parseLaunchpoolPage,
  parseFuturesLotteryPage,
  parseGateNumber,
};
