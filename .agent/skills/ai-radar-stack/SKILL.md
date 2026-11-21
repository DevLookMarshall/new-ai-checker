---
name: ai-radar-stack
description: Architecture, CI/CD, Cloudflare Workers, and optional Telegram Serverless (tgcloud) conventions for the AI Radar (new-ai-checker) project.
---

# AI Radar (`new-ai-checker`) Engineering & Deploy Skill

## 1. Cloudflare Worker Rules (`src/`, `wrangler.jsonc`)
- Runtime target: TypeScript on Cloudflare Workers (`compatibility_date: 2026-09-26`).
- Primary Cron schedule: `*/5 * * * *` via `scheduled()` handler in `src/index.ts`.
- State persistence: Workers KV namespace bound as `NEW_AI_CHECKER_KV`. Never leak bot tokens or chat IDs in `wrangler.jsonc`; store secrets via `wrangler secret put`.
- Validation before any push: always run `npm run check` (`tsc --noEmit && node --test tests/*.test.ts`).
- Manual deploy: `npx wrangler deploy`. Dev cron test: `npx wrangler dev --test-scheduled`.

## 2. Telegram Serverless (`tgcloud/`, `dist/`, `tgcloud.jsonc`) Rules (when Mini App is enabled)
- Relative imports inside `tgcloud/` MUST end with `.js` (`from '../schema.js'`).
- SDK imports: `import { db, fetch, InputFile } from 'sdk'` and `import { table, integer, text, real, boolean, json, eq, and, or, desc, asc, sql } from 'sdk/db'`.
- Do NOT use `.references()` / `foreignKey()` in `schema.js`; do NOT drop existing tables/columns without `.deprecated('reason')`.
- Avoid `AbortController` / `signal` and `setTimeout` wrappers around `sdk.fetch` inside `tgcloud/` isolates — invoke `await fetch(url, options)` directly.
- Authenticate Mini App endpoints strictly via `ctx.initData.user.id`.
- For RTL Android Telegram WebView Mini Apps (`dist/`): use `overflow-x: clip; width: 100%`, `letter-spacing: 0` on Persian text, and bump cache-busting `?v=...` query params in `dist/index.html` on every release.

## 3. GitHub & CI/CD Conventions
- Default branch: `main`.
- CI runs on every push/PR (`.github/workflows/ci.yml`).
- Auto-deploy workflow (`.github/workflows/deploy.yml`) gates both `wrangler deploy` and `tgcloud --no-pager push --force` on passing `npm run check`.
