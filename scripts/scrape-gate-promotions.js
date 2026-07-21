const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const ORIGIN = 'https://www.gate.com';
const CANDY_DROP_URL = `${ORIGIN}/en/candy-drop`;
const FIXED_TEST_URL = `${ORIGIN}/en/candy-drop/detail/RLUSD-347`;
const KNOWN_CATEGORIES = [1, 4, 1066, 213, 14, 17, 12, 1037]
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

async function dumpPage(chrome, url) {
  const { stdout } = await execFileAsync(chrome, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    `--user-agent=${USER_AGENT}`,
    '--virtual-time-budget=8000',
    '--run-all-compositor-stages-before-draw',
    '--dump-dom',
    url,
  ], { timeout: 30000, maxBuffer: 50 * 1024 * 1024 });
  if (!stdout || stdout.length < 500) throw new Error(`Gate returned an empty page for ${url}`);
  return stdout;
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

function extractPromotions(html) {
  const promotions = [];
  const anchorPattern = /<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html)) !== null) {
    let url;
    try { url = new URL(match[1] || match[2], ORIGIN); } catch { continue; }
    const text = decodeHtml(match[3]).slice(0, 900);
    if (!text || !isPromotionLink(url, text)) continue;
    const stableUrl = `${url.origin}${url.pathname}`;
    promotions.push({ id: stableUrl, url: stableUrl, text });
  }
  return promotions;
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
      url: `${ORIGIN}/en/candy-drop/detail/${slug}`,
      name: name.slice(0, 200),
      pool: `${poolMatch[1]} ≈ ${poolMatch[2]}`.replace(/\s+/g, ' ').trim(),
      candyType: candyTypes.join(' и '),
      startIn: normalizeTimer(timerMatch[1]),
    });
  }
  return candyDrops;
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

async function main() {
  const chrome = findChrome();
  const firstHtml = await dumpPage(chrome, KNOWN_CATEGORIES[0]);
  const categories = discoverCategories(firstHtml);
  const remaining = categories.filter((url) => url !== KNOWN_CATEGORIES[0]);
  const [remainingPages, candyHtml] = await Promise.all([
    mapWithConcurrency(remaining, 3, (url) => dumpPage(chrome, url)),
    dumpPage(chrome, CANDY_DROP_URL),
  ]);
  const htmlPages = [firstHtml, ...remainingPages];
  const unique = new Map();
  for (const html of htmlPages) {
    for (const promotion of extractPromotions(html)) {
      if (!unique.has(promotion.id)) unique.set(promotion.id, promotion);
    }
  }
  if (unique.size === 0) throw new Error('Headless Chrome found no Gate promotion cards');
  if (!/(?:Upcoming|Предстоящие)/i.test(decodeHtml(candyHtml))) {
    throw new Error('Headless Chrome could not verify the CandyDrop Upcoming section');
  }
  const candyDrops = extractCandyDrops(candyHtml);
  const enrichedCandyDrops = await mapWithConcurrency(candyDrops, 2, async (candyDrop) => {
    if (!/Зафиксированные награды/i.test(candyDrop.candyType)) return candyDrop;
    const detailHtml = await dumpPage(chrome, candyDrop.url);
    return { ...candyDrop, fixedRewards: extractFixedRewardDetails(detailHtml) };
  });
  let fixedCandyDropTest;
  if (process.env.TEST_NOTIFICATION === 'true') {
    const fixedTestHtml = await dumpPage(chrome, FIXED_TEST_URL);
    fixedCandyDropTest = {
      id: 'candy:RLUSD-347-fixed-test',
      url: FIXED_TEST_URL,
      name: 'RLUSD',
      pool: '262 500 RLUSD',
      candyType: 'Зафиксированные награды',
      startIn: 'событие завершено (тест)',
      fixedRewards: extractFixedRewardDetails(fixedTestHtml),
    };
  }
  process.stderr.write(
    `Discovered ${categories.length} categories, ${unique.size} promotions, and ${enrichedCandyDrops.length} Upcoming CandyDrops\n`
  );
  process.stdout.write(JSON.stringify({
    promotions: [...unique.values()],
    candyDrops: enrichedCandyDrops,
    categories,
    ...(fixedCandyDropTest ? { fixedCandyDropTest } : {}),
  }));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  decodeHtml,
  discoverCategories,
  extractCandyDrops,
  extractFixedRewardDetails,
  extractPromotions,
  parseGateNumber,
};
