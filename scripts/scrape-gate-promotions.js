const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const ORIGIN = 'https://www.gate.com';
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
  if (/\/(?:campaigns\/\d+|candy-drop\/detail\/[^/?#]+|referral\/earn-together|competition\/[^/?#]+|launchpool\/[^/?#]+)/i.test(url.pathname)) {
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
  const htmlPages = [firstHtml, ...(await mapWithConcurrency(remaining, 3, (url) => dumpPage(chrome, url)))];
  const unique = new Map();
  for (const html of htmlPages) {
    for (const promotion of extractPromotions(html)) {
      if (!unique.has(promotion.id)) unique.set(promotion.id, promotion);
    }
  }
  if (unique.size === 0) throw new Error('Headless Chrome found no Gate promotion cards');
  process.stderr.write(`Discovered ${categories.length} categories and ${unique.size} promotions\n`);
  process.stdout.write(JSON.stringify({ promotions: [...unique.values()], categories }));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { decodeHtml, discoverCategories, extractPromotions };
