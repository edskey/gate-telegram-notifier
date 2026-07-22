# Gate partner Telegram notifier

Serverless bot for **new Gate promotion cards**, **CandyDrop Upcoming cards**,
**Futures Points upcoming airdrops**, and **new Partner Activity transactions**.
It persists processed links/events in Upstash Redis and sends each one once to
Telegram.

## What is implemented

- `GET`/`POST /api/check`: protected trigger endpoint.
- Gate API v4 HMAC-SHA512 signing and a request to
  `/rebate/partner/transaction_history`.
- GitHub Actions uses its preinstalled headless Chrome to read public Gate
  Activity Center cards. It sends the extracted IDs, text, and links to the
  protected Vercel endpoint; no account cookies or web session are used.
- The same public browser run checks CandyDrop and keeps only cards marked
  `Start in`/`Upcoming`. It extracts the reward pool, reward type, countdown,
  and detail link into a separate deduplication source. For cards marked Fixed
  Rewards, it also opens the public detail page and extracts the fixed pool and
  Individual Cap. CoinGecko's keyless API is queried only when such a new alert
  is actually sent, to calculate the approximate USD value and available spots.
- The public Futures Points `/ru/futures/points/upcoming` section is checked for
  new cards. Minimum required points, points spent, voucher amount, and the
  countdown are stored as a separate deduplication source.
- First run is a baseline; it sends no old transactions.
- Durable deduplication in Upstash Redis.
- Telegram notifications for later transactions.
- GitHub Actions trigger every five minutes for Vercel Hobby.

The scheduler starts with the known Activity Center categories and discovers
additional `activity-center-*-ongoing` links from the live page. It scans every
category and deduplicates matching promotion links across sectors. The signed
Gate API remains the separate source for Partner Activity transactions.

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
   example, `openssl rand -hex 32`.
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

The manual GitHub Actions trigger runs the same production check as the
five-minute schedule; it does not send synthetic test messages. If several
genuinely new cards appear between checks, each is sent as a separate message.
Delivery state is checkpointed after every accepted message, so a partial
Telegram failure retries only the remaining items.
