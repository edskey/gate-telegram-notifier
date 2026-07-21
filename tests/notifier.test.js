const assert = require('node:assert/strict');
const test = require('node:test');

const {
  discoverCategories,
  extractCandyDrops,
  extractFixedRewardDetails,
  extractPromotions,
} = require('../scripts/scrape-gate-promotions');
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

test('scraper extracts only Upcoming CandyDrops with pool, type, and timer', () => {
  const html = `
    <div class="relative grid cursor-pointer">
      <div><h3><a href="/candy-drop/detail/SKHYG-350">SKHYG</a></h3>
        <span>Share Rewards</span><span>Fixed Rewards</span>
        <div>1 000 SKHYG</div><div>≈ 171 350 USDT</div>
      </div>
      <div>Task Type Futures Invite Friends</div>
      <div>Start in <span>08</span> : <span>01</span> : <span>48</span></div>
    </div>
    <div class="relative grid cursor-pointer">
      <h3><a href="/candy-drop/detail/OLD-1">OLD</a></h3>
      <span>Share Rewards</span><div>100 OLD ≈ 10 USDT</div><div>Ended</div>
    </div>`;

  assert.deepEqual(extractCandyDrops(html), [{
    id: 'candy:SKHYG-350',
    url: 'https://www.gate.com/en/candy-drop/detail/SKHYG-350',
    name: 'SKHYG',
    pool: '1 000 SKHYG ≈ 171 350 USDT',
    candyType: 'Разделите награды и Зафиксированные награды',
    startIn: '08:01:48',
  }]);
});

test('scraper isolates the Fixed Rewards pool and Individual Cap', () => {
  const html = `
    <div id="prize-pool-shared"><div>Share Rewards</div><h3>Share 70,000 RLUSD</h3>
      <div>Individual Cap</div><div>50 RLUSD</div></div>
    <div id="prize-pool-fixed"><div>Fixed Rewards</div>
      <h3>Deposit to share <b>22,500</b> RLUSD</h3>
      <section><div>Individual Cap</div><div>5 RLUSD</div></section>
      <div>Complete a deposit task</div></div>`;

  assert.deepEqual(extractFixedRewardDetails(html), {
    totalAmount: 22500,
    individualCap: 5,
    symbol: 'RLUSD',
    hasCandy: false,
  });
});

test('protected POST sends Rewards Hub, Upcoming, and Fixed Rewards test messages', async (context) => {
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
    if (target.startsWith('https://api.coingecko.com/api/v3/search')) {
      const query = new URL(target).searchParams.get('query');
      const coins = query === 'RLUSD' ? [{ id: 'ripple-usd', symbol: 'RLUSD' }] : [];
      return new Response(JSON.stringify({ coins }), { status: 200 });
    }
    if (target.startsWith('https://api.coingecko.com/api/v3/simple/price')) {
      return new Response(JSON.stringify({ 'ripple-usd': { usd: 1 } }), { status: 200 });
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
      candyDrops: [{
        id: 'candy:SKHYG-350',
        url: 'https://www.gate.com/en/candy-drop/detail/SKHYG-350',
        name: 'SKHYG',
        pool: '1 000 SKHYG ≈ 171 350 USDT',
        candyType: 'Разделите награды и Зафиксированные награды',
        startIn: '08:01:48',
        fixedRewards: { totalAmount: 1000, individualCap: 10, symbol: 'SKHYG', hasCandy: true },
      }],
      fixedCandyDropTest: {
        id: 'candy:RLUSD-347-fixed-test',
        url: 'https://www.gate.com/en/candy-drop/detail/RLUSD-347',
        name: 'RLUSD',
        pool: '262 500 RLUSD',
        candyType: 'Зафиксированные награды',
        startIn: 'событие завершено (тест)',
        fixedRewards: { totalAmount: 22500, individualCap: 5, symbol: 'RLUSD', hasCandy: false },
      },
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
  assert.equal(responseBody.candyDrops, 1);
  assert.equal(responseBody.testNotifications, 3);
  assert.equal(telegramBodies.length, 3);
  assert.equal(telegramBodies[0].chat_id, '@ggwp_announcements');
  assert.equal(telegramBodies[0].parse_mode, 'HTML');
  assert.match(telegramBodies[0].text, /Тест уведомления Rewards Hub/);
  assert.match(telegramBodies[0].text, /Карнавал прогнозов/);
  assert.match(telegramBodies[1].text, /^👇 <b>Тест CandyDrop Upcoming<\/b>/);
  assert.match(telegramBodies[1].text, /🔵 Бабки не проблема \(пул\): <b>1 000 SKHYG ≈ 171 350 USDT<\/b>/);
  assert.match(telegramBodies[1].text, /🔵 <b>Тип кендика:<\/b> Разделите награды и Зафиксированные награды/);
  assert.match(telegramBodies[1].text, /<b><u>Ебашим через: 08:01:48<\/u><\/b>/);
  assert.match(telegramBodies[1].text, /Награда:<\/b> <b>не нашел цену\/не залистилось<\/b>/);
  assert.match(telegramBodies[1].text, /Мест в палате:<\/b> Вычисляем мануально, там кендики, я бот, меня починят/);
  assert.match(telegramBodies[1].text, />Открыть CandyDrop<\/a>/);
  assert.match(telegramBodies[2].text, /^👇 <b>Тест CandyDrop Fixed Rewards<\/b>/);
  assert.match(telegramBodies[2].text, /Награда:<\/b> <b>5 RLUSD ≈ \$5<\/b>/);
  assert.match(telegramBodies[2].text, /Мест в палате:<\/b> 4\s?500/);
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
      candyDrops: [],
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

test('multiple new Upcoming CandyDrops are sent separately and not repeated', async (context) => {
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
    transactions: { sentIds: ['id:1'] },
    promotions: { sentIds: ['https://www.gate.com/campaigns/known'] },
    candyDrops: { sentIds: ['candy:KNOWN-1'] },
  };
  const messages = [];
  context.mock.method(global, 'fetch', async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('https://api.gateio.ws/')) {
      return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
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
    if (target.startsWith('https://api.coingecko.com/api/v3/search')) {
      return new Response(JSON.stringify({ coins: [] }), { status: 200 });
    }
    if (target.includes('/sendMessage')) {
      messages.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${target}`);
  });

  const request = () => ({
    method: 'POST',
    headers: { authorization: 'Bearer test-check-secret' },
    query: {},
    body: {
      promotions: [{
        id: 'https://www.gate.com/campaigns/known',
        url: 'https://www.gate.com/campaigns/known',
        text: 'Known promotion',
      }],
      candyDrops: [
        {
          id: 'candy:KNOWN-1', url: 'https://www.gate.com/en/candy-drop/detail/KNOWN-1',
          name: 'KNOWN', pool: '100 KNOWN ≈ 10 USDT', candyType: 'Разделите награды', startIn: '10:00:00',
        },
        {
          id: 'candy:NEW-1', url: 'https://www.gate.com/en/candy-drop/detail/NEW-1',
          name: 'NEW1', pool: '1 000 NEW1 ≈ 100 USDT', candyType: 'Разделите награды', startIn: '09:00:00',
        },
        {
          id: 'candy:NEW-2', url: 'https://www.gate.com/en/candy-drop/detail/NEW-2',
          name: 'NEW2', pool: '2 000 NEW2 ≈ 200 USDT',
          candyType: 'Разделите награды и Зафиксированные награды', startIn: '08:00:00',
          fixedRewards: { totalAmount: 2000, individualCap: 20, symbol: 'NEW2', hasCandy: false },
        },
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
  assert.equal(first.status, 200);
  assert.equal(first.body.sent.candyDrops, 2);
  assert.equal(messages.length, 2);
  assert(messages.some((message) => message.text.includes('NEW1')));
  assert(messages.some((message) => message.text.includes('NEW2')));
  assert(messages.every((message) => message.text.startsWith('👇')));

  const second = await invoke();
  assert.equal(second.status, 200);
  assert.equal(second.body.sent.candyDrops, 0);
  assert.equal(messages.length, 2);
});
