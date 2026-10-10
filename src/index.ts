import { ALL_SOURCE_NAMES, FEEDS, HTML_SOURCES } from './config.ts';
import type { Env } from './config.ts';
import { maybeSendHeartbeat } from './health.ts';
import { processFeed, processHtmlSource } from './sources.ts';

/**
 * AI Radar — polls AI labs' blogs/RSS and announces new model releases to Telegram.
 *
 * - `scheduled` runs every 5 minutes (see wrangler.jsonc), sources in parallel.
 * - `fetch` exposes a plain health endpoint for uptime checks.
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (pathname === '/healthz' || pathname === '/health') {
			let kvReachable = true;
			try {
				await env.NEW_AI_CHECKER_KV.get('heartbeat:v2:sent');
			} catch {
				kvReachable = false;
			}

			return Response.json({
				ok: kvReachable,
				sources: ALL_SOURCE_NAMES.length,
				telegram: {
					botTokenSet: Boolean(env.TELEGRAM_BOT_TOKEN),
					chatIdSet: Boolean(env.TELEGRAM_CHAT_ID),
				},
				kvReachable,
				lastHeartbeat: kvReachable ? await env.NEW_AI_CHECKER_KV.get('heartbeat:v2:sent') : null,
			});
		}

		return new Response('AI Radar is alive!', { headers: { 'content-type': 'text/plain' } });
	},

	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.passThroughOnException();

		// Sources run concurrently: one slow or failing host must not stall the rest.
		const results = await Promise.allSettled([
			...FEEDS.map((feed) => processFeed(feed, env)),
			...HTML_SOURCES.map((source) => processHtmlSource(source, env)),
		]);

		for (const result of results) {
			if (result.status === 'rejected') {
				console.error('Source processing failed:', result.reason);
			}
		}

		// Daily digest / dead-man switch — must never fail the run itself.
		await maybeSendHeartbeat(env);
	},
};
