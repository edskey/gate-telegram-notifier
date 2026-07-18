# Gate partner Telegram notifier

Serverless bot for **new Partner Activity transactions** on Gate. It uses a
read-only Gate API v4 key, persists processed events in Upstash Redis, and sends
each new transaction once to Telegram.

## What is implemented

- `GET`/`POST /api/check`: protected trigger endpoint.
- Gate API v4 HMAC-SHA512 signing and a request to
  `/rebate/partner/transaction_history`.
- First run is a baseline; it sends no old transactions.
- Durable deduplication in Upstash Redis.
- Telegram notifications for later transactions.
- GitHub Actions trigger every five minutes for Vercel Hobby.

The actual response fields and the relationship between Gate UI filters
`activity_type=3&activity_status=1` and API filters must be confirmed with the
partner key. The implementation deliberately does not guess those filters.

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
7. Run the workflow manually once. A `200` response with `initialized: true`
   proves Gate, Redis, and the endpoint work and creates the no-spam baseline.

## Free-plan scheduling

Vercel Hobby itself permits cron only once daily. The included GitHub Actions
workflow invokes Vercel every five minutes, which is GitHub's shortest scheduled
interval. Scheduled Actions can be delayed; this bot therefore detects new
transaction IDs instead of assuming exact five-minute execution. Do not set a
Gate API-key IP allowlist for Vercel Hobby because its outgoing IP is dynamic.

## Next validation step

After the read-only Gate key is ready, invoke `/api/check` manually once and
inspect its Vercel function log/result. We will then map the real transaction
fields and, if Gate supports it, add the precise equivalent of the UI's status
and type filters. Rewards Hub requires a separate authenticated API check; its
"claimable" status is not established by this project yet.
