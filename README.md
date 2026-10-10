# AI Radar (`new-ai-checker`)

A Cloudflare Worker that polls AI labs' blogs / RSS feeds every 5 minutes and
announces **genuine new model releases** to a Telegram chat.

## How it works

```
cron (*/5) ─▶ processFeed (RSS/Atom × 3) ─┐
             processHtmlSource (scrape × 3) ─┤─▶ classify ─▶ Telegram ─▶ KV (seen)
                                            └─▶ health + daily heartbeat
```

* **RSS sources** (`FEEDS` in `src/config.ts`): OpenAI, Google DeepMind, Google AI.
  Parsed by `parseFeed()` (`src/parse.ts`), which understands RSS 2.0 **and**
  Atom. `ETag` / `If-Modified-Since` are stored in KV so unchanged feeds
  answer `304` instead of re-downloading.
* **HTML sources** (`HTML_SOURCES`): Anthropic, Meta AI, xAI — labs with no
  usable feed. The listing page is scraped for article links, then each
  *unseen* article is fetched once and its title/date/description is read from
  stable metadata (`og:title` → `twitter:title` → JSON-LD `headline` →
  `<title>`), never from CSS classes.
* **Classifier** (`src/classifier.ts`): scores each headline instead of
  keyword-matching — release signal (+2), versioned product name (+2),
  leads-with-model (+2), known family (+1), model vocabulary (+1), minus
  case-study/corporate-news penalties. Threshold 3 (2 for versioned
  announcements). Deliberately title-only: descriptions mention models in
  every customer story.
* **Delivery** (`src/telegram.ts` → `src/sources.ts`): `parse_mode: HTML`,
  4096-char cap, "Read more →" button. Telegram `429/5xx` → item stays unseen
  (retried next run, `retry_after` honoured); `400/403/404` → marked seen so
  one bad message can't loop forever. Max 3 announcements per source per run.
* **State** (`src/sources.ts` + `src/ids.ts`): `state:v2:<source>` (init marker
  + HTTP validators), `seen:<sha256(canonical URL)>` (1-year TTL — longer than
  any feed's "recent" window so items can't re-announce), `attempt:<…>` for
  unparseable articles. **Empty parses never initialise state** — a blocked
  fetch can't fake a baseline and flood the chat on recovery.
* **Health** (`src/health.ts`): per-source failure counters, Telegram alert
  after 3 consecutive failures (1h cooldown), and a daily heartbeat digest
  that doubles as a dead-man switch (if it stops, the cron itself is broken).

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in bot token + chat id for local dev

npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

KV namespace is already bound in `wrangler.jsonc`
(`NEW_AI_CHECKER_KV`). To recreate it: `npx wrangler kv namespace create NEW_AI_CHECKER_KV`.

## Commands

```bash
npm run dev        # local dev (cron simulated)
npm test           # 38 tests (node:test, no deps)
npm run typecheck  # tsc --noEmit
npm run check      # typecheck + tests
npm run deploy     # wrangler deploy
```

## Endpoints

* `GET /health` / `/healthz` — `{ ok, sources, telegram: { botTokenSet, chatIdSet }, kvReachable, lastHeartbeat }`
* `GET /` — `AI Radar is alive!`

## Adding a source

1. Prefer a real feed → append to `FEEDS`. Only if none exists, add an
   `HtmlSource` entry (`url` = listing page, `linkPattern` = article-URL
   regex) — see `src/config.ts`.
2. Add regression tests: unit (parse/classify) in `tests/`, plus fixtures
   under `tests/fixtures/` captured from the live feed.
3. Bump nothing else — `ALL_SOURCE_NAMES`, health, and heartbeat pick it up
   automatically.

## Repo layout

```
src/  index.ts (entry)  config.ts (registry+consts)  sources.ts (pipeline)
      classifier.ts  parse.ts  telegram.ts  ids.ts  health.ts
tests/  *.test.ts + helpers.ts (FakeKv + fetch router) + fixtures/
```
