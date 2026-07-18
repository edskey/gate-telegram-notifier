const assert = require('node:assert/strict');
const test = require('node:test');

const { discoverCategories, extractPromotions } = require('../scripts/scrape-gate-promotions');
const handler = require('../api/check');

test('check endpoint rejects an invalid secret before external calls', async (context) => {
  process.env.CHECK_SECRET = 'correct-secret';
  context.mock.method(global, 'fetch', async () => {
    throw new Error('fetch must not be called for an unauthorized request');
  });
  let status;
  let body;
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer wrong-secret' },
    query: {},
    body: {},
  }, {
    status(value) { status = value; return this; },
    setHeader() {},
    end(value) { body = JSON.parse(value); },
  });
  assert.equal(status, 401);
  assert.deepEqual(body, { error: 'unauthorized' });
});

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

test('protected POST sends three formatted test promotions as separate messages', async (context) => {
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
      promotions: [
        {
          id: 'https://www.gate.com/campaigns/5534',
          url: 'https://www.gate.com/campaigns/5534',
          text: 'Карнавал прогнозов: делите 500 000 USDT',
        },
        {
          id: 'https://www.gate.com/campaigns/5535',
          url: 'https://www.gate.com/campaigns/5535',
          text: 'A & B <Special>',
        },
        {
          id: 'https://www.gate.com/campaigns/5536',
          url: 'https://www.gate.com/campaigns/5536',
          text: 'Третья тестовая акция',
        },
      ],
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
  assert.equal(responseBody.promotions, 3);
  assert.equal(responseBody.transactions, 4);
  assert.equal(responseBody.testNotification, true);
  assert.equal(responseBody.testNotifications, 3);
  assert.equal(telegramBodies.length, 3);
  assert.equal(telegramBodies[0].chat_id, '@ggwp_announcements');
  assert.equal(telegramBodies[0].parse_mode, 'HTML');
  assert.match(telegramBodies[0].text, /Тест уведомления 1\/3/);
  assert.match(telegramBodies[0].text, /Карнавал прогнозов/);
  assert.match(telegramBodies[1].text, /A &amp; B &lt;Special&gt;/);
  assert.match(telegramBodies[2].text, /Тест уведомления 3\/3/);
  assert(telegramBodies.every((body) => body.text.includes('>Открыть акцию</a>')));
  assert.deepEqual(sideEffects, [
    'save-state',
    'save-state',
    'send-telegram',
    'send-telegram',
    'send-telegram',
  ]);
});

test('multiple new promotions are separate and a partial failure retries only the remainder', async (context) => {
  context.mock.method(console, 'error', () => {});
  Object.assign(process.env, {
    CHECK_SECRET: 'test-check-secret',
    GATE_API_KEY: 'test-gate-key',
    GATE_API_SECRET: 'test-gate-secret',
    UPSTASH_REDIS_REST_URL: 'https://redis.test',
    UPSTASH_REDIS_REST_TOKEN: 'test-redis-token',
    TELEGRAM_BOT_TOKEN: 'test-telegram-token',
    TELEGRAM_CHAT_ID: '@ggwp_announcements',
  });

  let redisState = {
    initializedAt: '2026-07-18T00:00:00.000Z',
    transactions: { sentIds: ['id:1', 'id:2', 'id:3', 'id:4'] },
    promotions: { sentIds: ['https://www.gate.com/campaigns/old'] },
  };
  let failPromoOne = true;
  const acceptedMessages = [];
  const attemptedMessages = [];

  context.mock.method(global, 'fetch', async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('https://api.gateio.ws/')) {
      return new Response(JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]), { status: 200 });
    }
    if (target === 'https://redis.test') {
      const command = JSON.parse(options.body);
      if (command[0] === 'SET' && command.includes('NX')) {
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      }
      if (command[0] === 'GET') {
        return new Response(JSON.stringify({ result: JSON.stringify(redisState) }), { status: 200 });
      }
      if (command[0] === 'SET') redisState = JSON.parse(command[2]);
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    if (target.endsWith('/getMe')) {
      return new Response(JSON.stringify({ ok: true, result: { username: 'ggwp_gate_bot' } }), { status: 200 });
    }
    if (target.includes('/sendMessage')) {
      const body = JSON.parse(options.body);
      attemptedMessages.push(body.text);
      if (failPromoOne && body.text.includes('Promo One')) {
        return new Response(JSON.stringify({ ok: false, description: 'temporary test failure' }), { status: 400 });
      }
      acceptedMessages.push(body.text);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${target}`);
  });

  const request = () => ({
    method: 'POST',
    headers: { authorization: 'Bearer test-check-secret' },
    query: {},
    body: {
      promotions: [
        { id: 'https://www.gate.com/campaigns/old', url: 'https://www.gate.com/campaigns/old', text: 'Old' },
        { id: 'https://www.gate.com/campaigns/one', url: 'https://www.gate.com/campaigns/one', text: 'Promo One' },
        { id: 'https://www.gate.com/campaigns/two', url: 'https://www.gate.com/campaigns/two', text: 'Promo Two' },
      ],
      categories: [],
    },
  });
  const invoke = async () => {
    let status;
    let body;
    await handler(request(), {
      status(value) { status = value; return this; },
      setHeader() {},
      end(value) { body = JSON.parse(value); },
    });
    return { status, body };
  };

  const first = await invoke();
  assert.equal(first.status, 500);
  assert.match(first.body.error, /temporary test failure/);
  assert(redisState.promotions.sentIds.includes('https://www.gate.com/campaigns/two'));
  assert(!redisState.promotions.sentIds.includes('https://www.gate.com/campaigns/one'));

  failPromoOne = false;
  const second = await invoke();
  assert.equal(second.status, 200);
  assert.equal(second.body.sent.promotions, 1);
  assert.equal(acceptedMessages.filter((text) => text.includes('Promo Two')).length, 1);
  assert.equal(acceptedMessages.filter((text) => text.includes('Promo One')).length, 1);
  assert.equal(attemptedMessages.filter((text) => text.includes('Promo One')).length, 2);
  assert(redisState.promotions.sentIds.includes('https://www.gate.com/campaigns/one'));
});
