# Gate partner Telegram notifier

Serverless bot for **new Gate promotion cards**, **CandyDrop Upcoming cards**,
**active Launchpool cards**,
and **Futures Points upcoming airdrops and announced Lucky Draw cards**.
It persists processed links/events in Upstash Redis and sends each one once to
Telegram.

## What is implemented

- `GET`/`POST /api/check`: protected trigger endpoint.
- Gate API v4 signing remains available for an explicitly enabled manual
  diagnostic request. Scheduled workflows never send partner trade/commission
  records because those records are not promotion cards.
- GitHub Actions uses its preinstalled headless Chrome to read public Gate
  Activity Center cards. It sends the extracted IDs, text, and links to the
  protected Vercel endpoint; no account cookies or web session are used.
- The same core run reads the public Gate **Latest Events** announcements page,
  opens its 15 newest articles, and extracts arbitrary `/campaigns/<id>` links
  from the article bodies. This catches campaigns such as `/campaigns/5672`
  that are announced by Gate but never appear in the monitored Rewards Hub
  sectors. Campaign links sent to Telegram use the Russian `/ru/` route while
  deduplication keeps a locale-independent campaign ID.
  This source has its own first-run baseline, so deploying the feature does not
  publish a backlog of existing announcement campaigns. IDs are cross-checked
  against Activity Center promotions to prevent the same campaign being sent
  twice when Gate exposes it in both places.
- The same public browser run checks CandyDrop and keeps only cards marked
  `Start in`/`Upcoming`. It extracts the reward pool, reward type, countdown,
  and detail link into a separate deduplication source. For cards marked Fixed
  Rewards, it also opens the public detail page and extracts the fixed pool and
  Individual Cap. CoinGecko's Demo API is queried only when a new Fixed Rewards
  alert for a non-USDT/USDC token is actually sent, to calculate its approximate
  USD value. USDT and USDC are treated as approximately $1 without an API call.
- The public Futures Points `/ru/futures/points/upcoming` section is checked for
  new cards. Minimum required points, points spent, voucher amount, and the
  countdown are stored as a separate deduplication source.
- The public Futures Points Lucky Draw `Анонсировано` section is a separate
  source. It extracts the reward amount in the original token (without price
  conversion), minimum required points, and winning slots. Draw time is used
  only inside the stable event ID so identical-looking draws on different dates
  are still delivered once each. Its first run is a no-spam baseline.
- The public `/ru/launchpool` page is checked in its own lightweight workflow.
  Each active or upcoming project is keyed by its stable project ID/link, so
  changing APR values and countdowns do not create duplicate notifications.
  The alert includes the project, total rewards with Gate's displayed USDT
  equivalent, staking period, and Russian detail link. Existing cards become
  the first-run baseline and are not published retroactively.
- First run of every promotion source is a no-spam baseline.
- Durable deduplication in Upstash Redis.
- Telegram notifications for later promotion cards.
- Independent GitHub Actions triggers every five minutes for Vercel Hobby.
  CandyDrop and Launchpool run in their own lightweight workflows and do not
  wait for or fail with the slower Rewards Hub/Futures scan.
- Browser page loads are globally limited to two concurrent Chrome processes.
  Each failed or empty page is retried up to three times with a longer render
  budget before the workflow reports a real failure.

The scheduler starts with the known Activity Center categories and discovers
additional `activity-center-*-ongoing` links from the live page. It scans every
category plus recent Latest Events articles and deduplicates matching promotion
links across all sources. A failed announcement article is logged and retried on
the next run without deleting previously stored campaign IDs. The Gate partner
transaction ledger is disabled for scheduled POST runs; it can only be queried
manually when `ENABLE_PARTNER_TRANSACTION_ALERTS=true` is deliberately set.

## Setup

1. Create an API v4 key in Gate for the partner account with **Read-only**
   permissions only. Copy its key and secret once. Do not use account password,
   browser cookies, or a session token.
2. In Telegram, open `@BotFather`, send `/newbot`, choose its displayed name and
   username, then copy the token it returns. Send your new bot `/start`. To get
   a personal chat ID, open:
   `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates`, then read
   `result[0].message.chat.id`. For a group, add the bot, send a message, and
   read that group's `chat.id` the same way. Never commit the token or response.
3. Create a free [Upstash Redis](https://upstash.com/) database and copy its REST
   URL and REST token.
4. Import this repository into Vercel. Add every variable from `.env.example`
   in **Settings → Environment Variables**. Generate `CHECK_SECRET` with, for
   example, `openssl rand -hex 32`. Create a free CoinGecko Demo API key and
   store it as `COINGECKO_API_KEY`; never put the key in GitHub or the repository.
5. Deploy. The endpoint will be:
   `https://YOUR_PROJECT.vercel.app/api/check`.
6. In GitHub repository **Settings → Secrets and variables → Actions**, add:
   `VERCEL_CHECK_URL` (the URL above) and `CHECK_SECRET` (the same Vercel
   value). Enable Actions schedules if GitHub asks.
7. Run the workflow manually once. A `200` response with `initialized` entries
   proves the sources, Redis, and endpoint work and creates the no-spam
   baseline. Existing promotion cards are intentionally not published.

## Free-plan scheduling

Vercel Hobby itself permits cron only once daily. The included GitHub Actions
workflow invokes Vercel every five minutes, which is GitHub's shortest scheduled
interval. Scheduled Actions can be delayed; this bot therefore detects new
transaction IDs instead of assuming exact five-minute execution. Do not set a
Gate API-key IP allowlist for Vercel Hobby because its outgoing IP is dynamic.

## Current promotion trigger

The bot treats a newly appearing promotion-card link (for example,
`/campaigns/5534`) as a new promotion. It sends the card text and direct URL to
Telegram. Channel formatting can be changed independently without affecting the
deduplication rule.

The two manual GitHub Actions triggers run the same production checks as their
five-minute schedules unless their explicit test option is enabled. The protected
Vercel endpoint accepts source-specific payloads without clearing or changing
the state of omitted sources. If several genuinely new cards appear between
checks, each is sent as a separate message. Delivery state is checkpointed
after every accepted message, so a partial Telegram failure retries only the
remaining items.

For a one-off format check, manually run **Check Gate promotions and partner
activity** with `test_notification` enabled. It sends exactly one silent
Futures Lottery example and does not add the synthetic event to Redis state.
Scheduled runs always leave this option disabled.
