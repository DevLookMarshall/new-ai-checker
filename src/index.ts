import { ALL_SOURCE_NAMES, FEEDS, HTML_SOURCES } from './config.ts';
import type { Env } from './config.ts';
import { maybeSendHeartbeat } from './health.ts';
import { processFeed, processHtmlSource } from './sources.ts';

/**
 * AI Radar — polls AI labs' blogs/RSS and announces new model releases to Telegram.
 *
 * - `scheduled` runs every 5 minutes (see wrangler.jsonc), sources in parallel.
 * - `fetch` exposes a health endpoint for uptime checks, plus an optional
 *   secured manual trigger (`POST /run?source=<name>` with
 *   `Authorization: Bearer <TELEGRAM_BOT_TOKEN>`) — reuse the bot token as the
 *   shared secret so no new secret needs provisioning.
 */
async function runAllSources(env: Env): Promise<{ fulfilled: number; rejected: string[] }> {
	// Sources run concurrently: one slow or failing host must not stall the rest.
	const results = await Promise.allSettled([
		...FEEDS.map((feed) => processFeed(feed, env)),
		...HTML_SOURCES.map((source) => processHtmlSource(source, env)),
	]);

	const rejected: string[] = [];
	for (const result of results) {
		if (result.status === 'rejected') {
			console.error('Source processing failed:', result.reason);
			rejected.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
		}
	}

	return { fulfilled: results.length - rejected.length, rejected };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/healthz' || url.pathname === '/health') {
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

		if (url.pathname === '/run' && request.method === 'POST') {
			const bearer = request.headers.get('authorization') ?? '';
			if (!env.TELEGRAM_BOT_TOKEN || bearer !== `Bearer ${env.TELEGRAM_BOT_TOKEN}`) {
				return new Response('Unauthorized', { status: 401 });
			}

			const only = url.searchParams.get('source')?.toLowerCase();
			const feeds = only ? FEEDS.filter((feed) => feed.name.toLowerCase() === only) : FEEDS;
			const html = only ? HTML_SOURCES.filter((source) => source.name.toLowerCase() === only) : HTML_SOURCES;
			if (only && feeds.length === 0 && html.length === 0) {
				return Response.json({ ok: false, error: `unknown source "${only}"`, sources: ALL_SOURCE_NAMES }, { status: 404 });
			}

			const results = await Promise.allSettled([
				...feeds.map((feed) => processFeed(feed, env)),
				...html.map((source) => processHtmlSource(source, env)),
			]);
			const rejected = results
				.filter((result) => result.status === 'rejected')
				.map((result) => String((result as PromiseRejectedResult).reason));
			await maybeSendHeartbeat(env);
			return Response.json({ ok: rejected.length === 0, ran: results.length, failed: rejected.length, errors: rejected });
		}

		return new Response('AI Radar is alive!', { headers: { 'content-type': 'text/plain' } });
	},

	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.passThroughOnException();

		await runAllSources(env);

		// Daily digest / dead-man switch — must never fail the run itself.
		await maybeSendHeartbeat(env);
	},
};
