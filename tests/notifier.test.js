const assert = require('node:assert/strict');
const test = require('node:test');

const {
  categoryUrlsFor,
  discoverCategories,
  extractAnnouncementArticles,
  extractAnnouncementCampaigns,
  extractCandyDrops,
  extractFixedRewardDetails,
  extractFuturesLotteryPromotions,
  extractFuturesPointPromotions,
  extractLaunchpoolPromotions,
  extractPromotions,
} = require('../scripts/scrape-gate-promotions');

test('scheduler groups contain only the configured Rewards Hub categories', () => {
  assert.deepEqual(categoryUrlsFor('fast'), [14, 213, 1066, 1].map((id) =>
    `https://www.gate.com/ru/rewards_hub/activity-center-${id}-ongoing`
  ));
  assert.deepEqual(categoryUrlsFor('half-hour'), [
    'https://www.gate.com/ru/rewards_hub/activity-center-17-ongoing',
  ]);
  assert.deepEqual(categoryUrlsFor('hourly'), [1037, 7].map((id) =>
    `https://www.gate.com/ru/rewards_hub/activity-center-${id}-ongoing`
  ));
});
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
    url: 'https://www.gate.com/ru/campaigns/5534',
    text: 'Карнавал прогнозов: делите 500 000 USDT Обратный отсчет: 02:00:00',
  }]);
});

test('scraper follows Latest Events articles and extracts campaign links with Russian URLs', () => {
  const indexHtml = `
    <a href="/ru/announcements/article/100882">
      <span>Безумная среда Wealth Home Run</span><time>12 часов назад</time>
    </a>
    <a href="/en/announcements/article/100882">Duplicate locale</a>
    <a href="/ru/announcements/article/100881">Другой анонс</a>`;
  assert.deepEqual(extractAnnouncementArticles(indexHtml), [
    {
      id: 'announcement:100882',
      url: 'https://www.gate.com/ru/announcements/article/100882',
      title: 'Безумная среда Wealth Home Run 12 часов назад',
    },
    {
      id: 'announcement:100881',
      url: 'https://www.gate.com/ru/announcements/article/100881',
      title: 'Другой анонс',
    },
  ]);

  const articleHtml = `
    <article>
      <h1>Безумная среда Wealth Home Run: зарегистрируйтесь для участия</h1>
      <a href="https://www.gate.com/campaigns/5672?ref=announcement">Присоединиться сейчас</a>
    </article>`;
  assert.deepEqual(extractAnnouncementCampaigns(articleHtml), [{
    id: 'https://www.gate.com/campaigns/5672',
    url: 'https://www.gate.com/ru/campaigns/5672',
    text: 'Безумная среда Wealth Home Run: зарегистрируйтесь для участия',
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
    url: 'https://www.gate.com/ru/candy-drop/detail/SKHYG-350',
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

test('scraper extracts active Launchpools and keeps changing values out of the id', () => {
  const card = (usdtValue, timer) => `<div data-page-id="533">
    <div class="launchpool-card">
      <div><a href="/ru/launchpool/DOS?pid=533">DOS</a></div>
      <div>Всего Наград <b>1 410 000 DOS</b> <span>≈ ${usdtValue} USDT</span></div>
      <div>Период стейкинга <b>14 дня (дней)</b></div>
      <div>Заканчивается в ${timer}</div>
    </div>
  </div>`;
  const first = extractLaunchpoolPromotions(card('521 700', '13ДН. 22:19:10'));
  const changed = extractLaunchpoolPromotions(card('506 895', '13ДН. 21:59:10'));

  assert.equal(first.length, 1);
  assert.equal(first[0].id, changed[0].id);
  assert.deepEqual(first[0], {
    id: 'launchpool:533',
    url: 'https://www.gate.com/ru/launchpool/DOS?pid=533',
    project: 'DOS',
    totalRewards: '1 410 000 DOS ≈ 521 700 USDT',
    stakingPeriod: '14 дня (дней)',
  });
});

test('scraper extracts Futures Points upcoming cards and excludes the changing timer from the id', () => {
  const card = (timer) => `<div class="points-card">
    <h3>BTC Futures Voucher</h3>
    <div>Мин. требуемые баллы: <b>40</b></div>
    <div>Потраченные баллы: <b>20</b></div>
    <div>Сумма ваучера: <b>100 USDT</b></div>
    <div>Аирдроп начнется через <span>1Д</span> <span>${timer}</span></div>
  </div>`;
  const first = extractFuturesPointPromotions(card('15 : 26 : 37'));
  const later = extractFuturesPointPromotions(card('15 : 21 : 37'));

  assert.equal(first.length, 1);
  assert.equal(first[0].id, later[0].id);
  assert.match(first[0].id, /^futures-points:[a-f0-9]{64}$/);
  assert.deepEqual({ ...first[0], id: undefined }, {
    id: undefined,
    url: 'https://www.gate.com/ru/futures/points/upcoming',
    minPoints: '40',
    spentPoints: '20',
    voucherAmount: '100 USDT',
    startsIn: '1Д15:26:37',
  });
});

test('scraper extracts announced Futures Points lottery cards without price conversion', () => {
  const card = (drawTime, participants = '25 913') => `<div class="lottery-card">
    <div>Сумма награды</div><div><b>15</b> USD1</div><div>Объявлено</div>
    <div>Потрачено баллов</div><div>20</div>
    <div>Мин. баллов требуется</div><div>70</div>
    <div>Участники</div><div>${participants}</div>
    <div>Выигрышные слоты</div><div>7 000</div>
    <div>Время розыгрыша</div><div>${drawTime}</div>
  </div>`;
  const first = extractFuturesLotteryPromotions(card('2026-07-29 14:00:00'));
  const changedParticipants = extractFuturesLotteryPromotions(card('2026-07-29 14:00:00', '27 000'));
  const otherDraw = extractFuturesLotteryPromotions(card('2026-07-27 14:00:00'));

  assert.equal(first.length, 1);
  assert.equal(first[0].id, changedParticipants[0].id);
  assert.notEqual(first[0].id, otherDraw[0].id);
  assert.match(first[0].id, /^futures-lottery:[a-f0-9]{64}$/);
  assert.deepEqual({ ...first[0], id: undefined }, {
    id: undefined,
    url: 'https://www.gate.com/ru/futures/points/ended?section=lottery',
    rewardAmount: '15 USD1',
    minPoints: '70',
    winningSlots: '7000',
  });
});

test('protected POST creates a baseline without synthetic test messages', async (context) => {
  Object.assign(process.env, {
    CHECK_SECRET: 'test-check-secret',
    GATE_API_KEY: 'test-gate-key',
    GATE_API_SECRET: 'test-gate-secret',
    ENABLE_PARTNER_TRANSACTION_ALERTS: 'true',
    UPSTASH_REDIS_REST_URL: 'https://redis.test',
    UPSTASH_REDIS_REST_TOKEN: 'test-redis-token',
    TELEGRAM_BOT_TOKEN: 'test-telegram-token',
    TELEGRAM_CHAT_ID: '  @ggwp_announcements  ',
  });

  const telegramBodies = [];
  const sideEffects = [];
  let gateCalls = 0;
  context.mock.method(global, 'fetch', async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('https://api.gateio.ws/')) {
      gateCalls += 1;
      throw new Error('Scheduled promotion POST must not query partner transactions');
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
    },
    query: {},
    body: {
      promotions: [
        {
          id: 'https://www.gate.com/campaigns/5534',
          url: 'https://www.gate.com/campaigns/5534',
          text: 'Карнавал прогнозов: делите 500 000 USDT Обратный отсчет: 02:00:00',
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
      announcementCampaigns: [{
        id: 'https://www.gate.com/campaigns/5672',
        url: 'https://www.gate.com/ru/campaigns/5672',
        text: 'Безумная среда Wealth Home Run',
      }],
      candyDrops: [{
        id: 'candy:SKHYG-350',
        url: 'https://www.gate.com/ru/candy-drop/detail/SKHYG-350',
        name: 'SKHYG',
        pool: '1 000 SKHYG ≈ 171 350 USDT',
        candyType: 'Разделите награды и Зафиксированные награды',
        startIn: '08:01:48',
        fixedRewards: { totalAmount: 1000, individualCap: 10, symbol: 'SKHYG', hasCandy: true },
      }],
      futuresPoints: [],
      futuresLottery: [{
        id: 'futures-lottery:baseline',
        url: 'https://www.gate.com/ru/futures/points/ended?section=lottery',
        rewardAmount: '15 USD1',
        minPoints: '70',
        winningSlots: '7000',
      }],
      launchpools: [{
        id: 'launchpool:533',
        url: 'https://www.gate.com/ru/launchpool/DOS?pid=533',
        project: 'DOS',
        totalRewards: '1 410 000 DOS ≈ 521 700 USDT',
        stakingPeriod: '14 дня (дней)',
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
  assert.equal(responseBody.promotions, 3);
  assert.equal(responseBody.announcementCampaigns, 1);
  assert.equal(responseBody.sent.transactions, 0);
  assert.equal(gateCalls, 0);
  assert.equal(responseBody.candyDrops, 1);
  assert.equal(responseBody.futuresLottery, 1);
  assert.equal(responseBody.launchpools, 1);
  assert(responseBody.initialized.includes('announcementCampaigns'));
  assert(responseBody.initialized.includes('futuresLottery'));
  assert(responseBody.initialized.includes('launchpools'));
  assert.equal(telegramBodies.length, 0);
  assert.equal('testNotification' in responseBody, false);
  assert.deepEqual(sideEffects, [
    'save-state',
    'save-state',
  ]);
});

test('manual test header sends exactly one silent Futures Lottery example without changing source IDs', async (context) => {
  Object.assign(process.env, {
    CHECK_SECRET: 'test-check-secret',
    UPSTASH_REDIS_REST_URL: 'https://redis.test',
    UPSTASH_REDIS_REST_TOKEN: 'test-redis-token',
    TELEGRAM_BOT_TOKEN: 'test-telegram-token',
    TELEGRAM_CHAT_ID: '@ggwp_announcements',
  });
  let redisState = { futuresLottery: { sentIds: [] } };
  const messages = [];
  context.mock.method(global, 'fetch', async (url, options = {}) => {
    const target = String(url);
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
    if (target.includes('/sendMessage')) {
      messages.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${target}`);
  });

  let status;
  let responseBody;
  await handler({
    method: 'POST',
    headers: {
      authorization: 'Bearer test-check-secret',
      'x-gate-bot-test': 'true',
    },
    query: {},
    body: { futuresLottery: [] },
  }, {
    status(value) { status = value; return this; },
    setHeader() {},
    end(value) { responseBody = JSON.parse(value); },
  });

  assert.equal(status, 200);
  assert.equal(responseBody.testNotification, true);
  assert.equal(responseBody.testNotifications, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].disable_notification, true);
  assert.match(messages[0].text, /Тест: Счастливый розыгрыш — Анонсировано/);
  assert.match(messages[0].text, /Сумма награды:<\/b> <b>15 USD1<\/b>/);
  assert.deepEqual(redisState.futuresLottery.sentIds, []);
});

test('CandyDrop-only payload sends promptly without touching unrelated sources', async (context) => {
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
    candyDrops: { sentIds: [] },
    futuresPoints: { sentIds: ['futures-points:known'] },
    futuresLottery: { sentIds: ['futures-lottery:known'] },
    launchpools: { sentIds: ['launchpool:known'] },
  };
  const unrelatedState = {
    transactions: JSON.parse(JSON.stringify(redisState.transactions)),
    promotions: JSON.parse(JSON.stringify(redisState.promotions)),
    futuresPoints: JSON.parse(JSON.stringify(redisState.futuresPoints)),
    futuresLottery: JSON.parse(JSON.stringify(redisState.futuresLottery)),
    launchpools: JSON.parse(JSON.stringify(redisState.launchpools)),
  };
  const messages = [];
  let gateCalls = 0;

  context.mock.method(global, 'fetch', async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('https://api.gateio.ws/')) {
      gateCalls += 1;
      throw new Error('CandyDrop-only payload must not call the Gate Partner API');
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
    if (target.includes('/sendMessage')) {
      messages.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${target}`);
  });

  let status;
  let responseBody;
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer test-check-secret' },
    query: {},
    body: {
      candyDrops: [{
        id: 'candy:FAST-1',
        url: 'https://www.gate.com/ru/candy-drop/detail/FAST-1',
        name: 'FAST',
        pool: '1 000 FAST ≈ 100 USDT',
        candyType: 'Разделите награды',
        startIn: '00:30:00',
      }],
    },
  }, {
    status(value) { status = value; return this; },
    setHeader() {},
    end(value) { responseBody = JSON.parse(value); },
  });

  assert.equal(status, 200);
  assert.equal(gateCalls, 0);
  assert.deepEqual(responseBody.errors, {});
  assert.equal(responseBody.sent.candyDrops, 1);
  assert.equal(messages.length, 1);
  assert(messages[0].text.includes('FAST'));
  assert.deepEqual(redisState.transactions, unrelatedState.transactions);
  assert.deepEqual(redisState.promotions, unrelatedState.promotions);
  assert.deepEqual(redisState.futuresPoints, unrelatedState.futuresPoints);
  assert.deepEqual(redisState.futuresLottery, unrelatedState.futuresLottery);
  assert.deepEqual(redisState.launchpools, unrelatedState.launchpools);
  assert(redisState.candyDrops.sentIds.includes('candy:FAST-1'));
});

test('announcement campaigns baseline independently and avoid cross-source duplicates', async (context) => {
  Object.assign(process.env, {
    CHECK_SECRET: 'test-check-secret',
    UPSTASH_REDIS_REST_URL: 'https://redis.test',
    UPSTASH_REDIS_REST_TOKEN: 'test-redis-token',
    TELEGRAM_BOT_TOKEN: 'test-telegram-token',
    TELEGRAM_CHAT_ID: '@ggwp_announcements',
  });
  let redisState = {
    promotions: { sentIds: ['https://www.gate.com/campaigns/shared'] },
    announcementCampaigns: { sentIds: ['https://www.gate.com/campaigns/old'] },
  };
  const messages = [];
  context.mock.method(global, 'fetch', async (url, options = {}) => {
    const target = String(url);
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
    if (target.includes('/sendMessage')) {
      messages.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${target}`);
  });
  const promotions = [
    ['old', 'Old'],
    ['shared', 'Already sent by Activity Center'],
    ['new-one', 'New One'],
    ['new-two', 'New Two'],
  ].map(([slug, text]) => ({
    id: `https://www.gate.com/campaigns/${slug}`,
    url: `https://www.gate.com/ru/campaigns/${slug}`,
    text,
  }));
  const invoke = async () => {
    let status;
    let body;
    await handler({
      method: 'POST',
      headers: { authorization: 'Bearer test-check-secret' },
      query: {},
      body: { announcementCampaigns: promotions },
    }, {
      status(value) { status = value; return this; },
      setHeader() {},
      end(value) { body = JSON.parse(value); },
    });
    return { status, body };
  };

  const first = await invoke();
  assert.equal(first.status, 200);
  assert.equal(first.body.sent.announcementCampaigns, 2);
  assert.equal(messages.length, 2);
  assert(messages.some((message) => message.text.includes('New One')));
  assert(messages.some((message) => message.text.includes('New Two')));
  assert(!messages.some((message) => message.text.includes('Already sent by Activity Center')));

  const second = await invoke();
  assert.equal(second.status, 200);
  assert.equal(second.body.sent.announcementCampaigns, 0);
  assert.equal(messages.length, 2);
});

test('overlapping scheduler request returns a retryable status', async (context) => {
  Object.assign(process.env, {
    CHECK_SECRET: 'test-check-secret',
    UPSTASH_REDIS_REST_URL: 'https://redis.test',
    UPSTASH_REDIS_REST_TOKEN: 'test-redis-token',
  });
  context.mock.method(global, 'fetch', async (url, options = {}) => {
    assert.equal(String(url), 'https://redis.test');
    assert.deepEqual(JSON.parse(options.body), ['SET', 'gate-partner-bot:check-lock:v1', '1', 'NX', 'EX', 30]);
    return new Response(JSON.stringify({ result: null }), { status: 200 });
  });

  let status;
  let responseBody;
  const headers = {};
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer test-check-secret' },
    query: {},
    body: { candyDrops: [] },
  }, {
    status(value) { status = value; return this; },
    setHeader(name, value) { headers[name] = value; return this; },
    end(value) { responseBody = JSON.parse(value); },
  });

  assert.equal(status, 503);
  assert.equal(headers['Retry-After'], '2');
  assert.deepEqual(responseBody, { ok: false, retryable: 'check_already_running' });
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
        {
          id: 'https://www.gate.com/campaigns/one',
          url: 'https://www.gate.com/campaigns/one',
          text: 'Promo One Countdown: 01:00:00',
        },
        { id: 'https://www.gate.com/campaigns/two', url: 'https://www.gate.com/campaigns/two', text: 'Promo Two' },
      ],
      candyDrops: [],
      futuresPoints: [],
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
  const promoOneMessage = acceptedMessages.find((text) => text.includes('Promo One'));
  assert.match(promoOneMessage, /<b><u>Таймер: 01:00:00<\/u><\/b>/);
  assert.match(promoOneMessage, /<b>Промка:<\/b> <a href="https:\/\/www\.gate\.com\/campaigns\/one">Открыть<\/a>/);
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
    COINGECKO_API_KEY: 'test-coingecko-key',
  });
  let redisState = {
    transactions: { sentIds: ['id:1'] },
    promotions: { sentIds: ['https://www.gate.com/campaigns/known'] },
    candyDrops: { sentIds: ['candy:KNOWN-1'] },
    futuresPoints: { sentIds: ['futures-points:known'] },
    futuresLottery: { sentIds: ['futures-lottery:known'] },
    launchpools: { sentIds: ['launchpool:known'] },
  };
  const messages = [];
  const coinGeckoRequests = [];
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
      coinGeckoRequests.push({ target, headers: options.headers });
      return new Response(JSON.stringify({ coins: [{ id: 'new-token-2', symbol: 'NEW2' }] }), { status: 200 });
    }
    if (target.startsWith('https://api.coingecko.com/api/v3/simple/price')) {
      coinGeckoRequests.push({ target, headers: options.headers });
      return new Response(JSON.stringify({ 'new-token-2': { usd: 2.5 } }), { status: 200 });
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
          id: 'candy:KNOWN-1', url: 'https://www.gate.com/ru/candy-drop/detail/KNOWN-1',
          name: 'KNOWN', pool: '100 KNOWN ≈ 10 USDT', candyType: 'Разделите награды', startIn: '10:00:00',
        },
        {
          id: 'candy:NEW-1', url: 'https://www.gate.com/ru/candy-drop/detail/NEW-1',
          name: 'NEW1', pool: '1 000 NEW1 ≈ 100 USDT',
          candyType: 'Разделите награды и Зафиксированные награды', startIn: '09:00:00',
          fixedRewards: { totalAmount: 1000, individualCap: 10, symbol: 'USDC', hasCandy: false },
        },
        {
          id: 'candy:NEW-2', url: 'https://www.gate.com/ru/candy-drop/detail/NEW-2',
          name: 'NEW2', pool: '2 000 NEW2 ≈ 200 USDT',
          candyType: 'Разделите награды и Зафиксированные награды', startIn: '08:00:00',
          fixedRewards: { totalAmount: 2000, individualCap: 20, symbol: 'NEW2', hasCandy: false },
        },
      ],
      futuresPoints: [
        {
          id: 'futures-points:known',
          url: 'https://www.gate.com/ru/futures/points/upcoming',
          minPoints: '10', spentPoints: '5', voucherAmount: '25 USDT', startsIn: '01:00:00',
        },
        {
          id: 'futures-points:new',
          url: 'https://www.gate.com/ru/futures/points/upcoming',
          minPoints: '40', spentPoints: '20', voucherAmount: '100 USDT', startsIn: '1Д15:26:37',
        },
      ],
      futuresLottery: [
        {
          id: 'futures-lottery:known',
          url: 'https://www.gate.com/ru/futures/points/ended?section=lottery',
          rewardAmount: '3 GT', minPoints: '50', winningSlots: '5000',
        },
        {
          id: 'futures-lottery:new',
          url: 'https://www.gate.com/ru/futures/points/ended?section=lottery',
          rewardAmount: '15 USD1', minPoints: '70', winningSlots: '7000',
        },
      ],
      launchpools: [
        {
          id: 'launchpool:known', url: 'https://www.gate.com/ru/launchpool/known',
          project: 'KNOWN', totalRewards: '10 KNOWN ≈ 10 USDT', stakingPeriod: '7 дня (дней)',
        },
        {
          id: 'launchpool:533', url: 'https://www.gate.com/ru/launchpool/DOS?pid=533',
          project: 'DOS', totalRewards: '1 410 000 DOS ≈ 521 700 USDT', stakingPeriod: '14 дня (дней)',
        },
        {
          id: 'launchpool:534', url: 'https://www.gate.com/ru/launchpool/NEW?pid=534',
          project: 'NEW', totalRewards: '500 000 NEW ≈ 25 000 USDT', stakingPeriod: '10 дня (дней)',
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
  assert.equal(first.body.sent.futuresPoints, 1);
  assert.equal(first.body.sent.futuresLottery, 1);
  assert.equal(first.body.sent.launchpools, 2);
  assert.equal(messages.length, 6);
  assert(messages.some((message) => message.text.includes('NEW1')));
  assert(messages.some((message) => message.text.includes('NEW2')));
  assert(messages.every((message) => message.text.startsWith('👇')));
  assert(messages.every((message) => message.disable_notification === false));
  const stablecoinMessage = messages.find((message) => message.text.includes('NEW1'));
  assert.match(stablecoinMessage.text, /Фикс награда:<\/b> <b>10 USDC ≈ \$10<\/b>/);
  assert.equal(coinGeckoRequests.length, 2);
  assert(coinGeckoRequests.every(({ headers }) => headers['x-cg-demo-api-key'] === 'test-coingecko-key'));
  const fixedMessage = messages.find((message) => message.text.includes('NEW2'));
  assert.match(fixedMessage.text, /<b><u>Ебашим через: 08:00:00<\/u><\/b>/);
  assert.match(fixedMessage.text, /Фикс награда:<\/b> <b>20 NEW2 ≈ \$50<\/b>/);
  assert.match(fixedMessage.text, /Мест в палате:<\/b> 100/);
  assert.match(fixedMessage.text, /<b>Промка:<\/b> <a href="https:\/\/www\.gate\.com\/ru\/candy-drop\/detail\/NEW-2">Открыть<\/a>/);
  const futuresMessage = messages.find((message) => message.text.includes('Futures Points'));
  assert.match(futuresMessage.text, /Мин\. требуемые баллы:<\/b> <b>40<\/b>/);
  assert.match(futuresMessage.text, /Потраченные баллы:<\/b> <b>20<\/b>/);
  assert.match(futuresMessage.text, /Сумма ваучера:<\/b> <b>100 USDT<\/b>/);
  assert.match(futuresMessage.text, /Ебашим через:<\/u><\/b> <b>1Д<\/b> <b>15:26:37<\/b>/);
  const lotteryMessage = messages.find((message) => message.text.includes('Счастливый розыгрыш'));
  assert.match(lotteryMessage.text, /Сумма награды:<\/b> <b>15 USD1<\/b>/);
  assert.match(lotteryMessage.text, /Мин\. баллов требуется:<\/b> <b>70<\/b>/);
  assert.match(lotteryMessage.text, /Выигрышные слоты:<\/b> <b>7\s000<\/b>/);
  assert.match(lotteryMessage.text, /futures\/points\/ended\?section=lottery/);
  const launchpoolMessage = messages.find((message) => message.text.includes('Новый Launchpool') && message.text.includes('DOS'));
  assert.match(launchpoolMessage.text, /Всего наград:<\/b> <b>1 410 000 DOS ≈ 521 700 USDT<\/b>/);
  assert.match(launchpoolMessage.text, /Период стейкинга:<\/b> <b>14 дня \(дней\)<\/b>/);
  assert.match(launchpoolMessage.text, /launchpool\/DOS\?pid=533/);

  const second = await invoke();
  assert.equal(second.status, 200);
  assert.equal(second.body.sent.candyDrops, 0);
  assert.equal(second.body.sent.futuresPoints, 0);
  assert.equal(second.body.sent.futuresLottery, 0);
  assert.equal(second.body.sent.launchpools, 0);
  assert.equal(messages.length, 6);
});
