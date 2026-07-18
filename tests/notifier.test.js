const assert = require('node:assert/strict');
const test = require('node:test');

const { discoverCategories, extractPromotions } = require('../scripts/scrape-gate-promotions');
const handler = require('../api/check');

test('scraper discovers new sectors and extracts stable promotion links', () => {
  const html = `
    <a href="/ru/rewards_hub/activity-center-9999-ongoing">Новый раздел</a>
    <a href="/campaigns/5534?ref=home">
      <span>Карнавал прогнозов: делите 500 000 USDT</span>
      <span>Обратный отсчет: 02:00:00</span>
    </a>`;
  const categories = discoverCategories(html);
  const promotions = extractPromotions(html);

  assert(categories.includes('https://www.gate.com/ru/rewards_hub/activity-center-9999-ongoing'));
  assert.deepEqual(promotions, [{
    id: 'https://www.gate.com/campaigns/5534',
    url: 'https://www.gate.com/campaigns/5534',
    text: 'Карнавал прогнозов: делите 500 000 USDT Обратный отсчет: 02:00:00',
  }]);
});

test('protected POST uses scheduler promotions and sends a test to a channel', async (context) => {
  Object.assign(process.env, {
    CHECK_SECRET: 'test-check-secret',
    GATE_API_KEY: 'test-gate-key',
    GATE_API_SECRET: 'test-gate-secret',
    UPSTASH_REDIS_REST_URL: 'https://redis.test',
    UPSTASH_REDIS_REST_TOKEN: 'test-redis-token',
    TELEGRAM_BOT_TOKEN: 'test-telegram-token',
    TELEGRAM_CHAT_ID: '  @ggwp_announcements  ',
  });

  const telegramBodies = [];
  const sideEffects = [];
  context.mock.method(global, 'fetch', async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('https://api.gateio.ws/')) {
      return new Response(JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]), { status: 200 });
    }
    if (target === 'https://redis.test') {
      const command = JSON.parse(options.body);
      if (command[0] === 'SET' && !command.includes('NX')) sideEffects.push('save-state');
      const result = command[0] === 'SET' && command.includes('NX') ? 'OK' : null;
      return new Response(JSON.stringify({ result }), { status: 200 });
    }
    if (target.startsWith('https://api.telegram.org/')) {
      sideEffects.push('send-telegram');
      telegramBodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${target}`);
  });

  const req = {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-check-secret',
      'x-gate-bot-test': 'true',
    },
    query: {},
    body: {
      promotions: [{
        id: 'https://www.gate.com/campaigns/5534',
        url: 'https://www.gate.com/campaigns/5534',
        text: 'Карнавал прогнозов: делите 500 000 USDT',
      }],
      categories: ['https://www.gate.com/ru/rewards_hub/activity-center-1-ongoing'],
    },
  };
  let status;
  let responseBody;
  const res = {
    status(value) { status = value; return this; },
    setHeader() {},
    end(value) { responseBody = JSON.parse(value); },
  };

  await handler(req, res);

  assert.equal(status, 200);
  assert.equal(responseBody.promotions, 1);
  assert.equal(responseBody.transactions, 4);
  assert.equal(responseBody.testNotification, true);
  assert.equal(telegramBodies.length, 1);
  assert.equal(telegramBodies[0].chat_id, '@ggwp_announcements');
  assert.match(telegramBodies[0].text, /Тестовое уведомление/);
  assert.match(telegramBodies[0].text, /Карнавал прогнозов/);
  assert.deepEqual(sideEffects, ['send-telegram', 'save-state']);
});
