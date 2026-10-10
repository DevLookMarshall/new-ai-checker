import { classifyModelRelease } from './classifier.ts';
import type { Env, FeedItem, FeedSource, HtmlSource } from './config.ts';
import {
	FETCH_TIMEOUT_MS,
	MAX_ANNOUNCEMENTS_PER_RUN,
	MAX_BASELINE_ITEMS,
	MAX_ITEMS_PER_SOURCE,
	SEEN_TTL_SECONDS,
	STATE_VERSION,
	USER_AGENT,
} from './config.ts';
import { attemptKey, seenKey } from './ids.ts';
import { recordAnnouncement, reportSourceResult } from './health.ts';
import { extractArticleDate, extractArticleDescription, extractArticleTitle, parseFeed } from './parse.ts';
import { buildMessage, sendTelegramMessage } from './telegram.ts';

/**
 * Per-source runtime state: initialization marker + HTTP validators, in one key.
 *
 * The critical rule enforced here: state is only ever *created* from a
 * non-empty parse. An empty parse (blocked, redesigned, RSS→Atom switch) is
 * reported as a failure and leaves state untouched, so it can neither fake an
 * initialization (old bug: whole backlog announced on the next good run) nor
 * silently kill a source forever.
 */
export interface SourceState {
	initializedAt: string;
	etag?: string;
	lastModified?: string;
	lastCount: number;
}

const MAX_ARTICLE_ATTEMPTS = 3;

const stateKey = (name: string) => `state:${STATE_VERSION}:${name}`;

async function loadState(env: Env, name: string): Promise<SourceState | null> {
	const raw = await env.NEW_AI_CHECKER_KV.get(stateKey(name));
	if (!raw) return null;
	try {
		return JSON.parse(raw) as SourceState;
	} catch {
		return null;
	}
}

async function saveState(env: Env, name: string, state: SourceState): Promise<void> {
	await env.NEW_AI_CHECKER_KV.put(stateKey(name), JSON.stringify(state));
}

/** KV writes are quota-limited, so only persist when an HTTP validator/count changed. */
async function saveStateIfChanged(env: Env, name: string, previous: SourceState, next: SourceState): Promise<void> {
	if (previous.etag === next.etag && previous.lastModified === next.lastModified && previous.lastCount === next.lastCount) return;
	await saveState(env, name, next);
}

/** Conditional request headers — skipped entirely when there is no prior state. */
function conditionalHeaders(state: SourceState | null): Record<string, string> {
	const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
	if (state?.etag) headers['If-None-Match'] = state.etag;
	else if (state?.lastModified) headers['If-Modified-Since'] = state.lastModified;
	return headers;
}

function validatorsFrom(response: Response): { etag?: string; lastModified?: string } {
	return {
		etag: response.headers.get('etag') ?? undefined,
		lastModified: response.headers.get('last-modified') ?? undefined,
	};
}

async function markSeen(env: Env, key: string, payload: Record<string, unknown>): Promise<void> {
	await env.NEW_AI_CHECKER_KV.put(key, JSON.stringify(payload), { expirationTtl: SEEN_TTL_SECONDS });
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends one announcement and applies the deliver-first/persist-second rule.
 * Returns `sent` only after Telegram accepted it; anything else leaves the item
 * un-seen (except a permanent Telegram rejection, which is marked to stop an
 * infinite per-run retry loop).
 */
async function announceOnce(env: Env, source: string, item: FeedItem): Promise<'sent' | 'stopped'> {
	const message = buildMessage(source, item);

	let result = await sendTelegramMessage(env, message, item.link);

	// Honour Telegram's rate-limit pause once, within this invocation.
	if (!result.ok && result.action === 'retry' && result.retryAfterMs && result.retryAfterMs > 0) {
		await sleep(result.retryAfterMs);
		result = await sendTelegramMessage(env, message, item.link);
	}

	const key = await seenKey(item.link);

	if (result.ok) {
		await markSeen(env, key, { source, ...item, detectedAt: new Date().toISOString() });

		await recordAnnouncement(env, source);
		console.log(`ANNOUNCED [${source}]: ${item.title}`);
		return 'sent';
	}

	if (result.action === 'give-up') {
		console.error(`Telegram permanently rejected message [${source}] (${result.reason}): ${item.title}`);
		await markSeen(env, key, { source, ...item, delivery: 'failed', deliveryError: result.reason });
		return 'stopped';
	}

	// `retry` (next run) or `skip` (missing secret): stay un-seen and stop this
	// run — the remaining candidates would hit the exact same failure.
	console.error(`Telegram delivery not accepted (${result.action}: ${result.reason}); will retry next run: ${item.title}`);
	return 'stopped';
}

export async function processFeed(source: FeedSource, env: Env): Promise<void> {
	const state = await loadState(env, source.name);

	try {
		const response = await fetch(source.url, {
			headers: conditionalHeaders(state),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});

		if (response.status === 304 && state) {
			await reportSourceResult(env, source.name, true, state.lastCount, 'not modified');
			return;
		}

		if (!response.ok) {
			await reportSourceResult(env, source.name, false, 0, `${source.name} RSS failed: HTTP ${response.status}`);
			return;
		}

		const items = parseFeed(await response.text());
		console.log(`${source.name}: found ${items.length} items`);

		if (items.length === 0) {
			await reportSourceResult(env, source.name, false, 0, `${source.name} feed parsed 0 items (blocked or format changed?)`);
			return;
		}

		const next: SourceState = {
			initializedAt: state?.initializedAt ?? new Date().toISOString(),
			lastCount: items.length,
			...validatorsFrom(response),
		};

		if (!state) {
			// First successful run: baseline silently, never announce historical items.
			for (const item of items.slice(0, MAX_ITEMS_PER_SOURCE)) {
				await markSeen(env, await seenKey(item.link), { source: source.name, ...item, initializedAt: next.initializedAt });
			}
			await saveState(env, source.name, next);
			await reportSourceResult(env, source.name, true, items.length);
			console.log(`${source.name}: baselined ${Math.min(items.length, MAX_ITEMS_PER_SOURCE)} items (no messages sent).`);
			return;
		}

		await saveStateIfChanged(env, source.name, state, next);

		let sentCount = 0;
		for (const item of items.slice(0, MAX_ITEMS_PER_SOURCE)) {
			if (sentCount >= MAX_ANNOUNCEMENTS_PER_RUN) {
				console.log(`${source.name}: per-run announcement cap reached (${sentCount}); remaining candidates next run.`);
				break;
			}
			if (!classifyModelRelease(item.title).matched) continue;
			if (await env.NEW_AI_CHECKER_KV.get(await seenKey(item.link))) continue;

			const outcome = await announceOnce(env, source.name, item);
			if (outcome !== 'sent') break;
			sentCount += 1;
		}

		await reportSourceResult(env, source.name, true, items.length);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(`${source.name} processing error:`, error);
		await reportSourceResult(env, source.name, false, 0, `${source.name} error: ${reason}`);
	}
}

export async function processHtmlSource(source: HtmlSource, env: Env): Promise<void> {
	const state = await loadState(env, source.name);

	try {
		const response = await fetch(source.url, {
			headers: { ...conditionalHeaders(state), Accept: 'text/html,application/xhtml+xml' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});

		if (response.status === 304 && state) {
			await reportSourceResult(env, source.name, true, state.lastCount, 'not modified');
			return;
		}

		if (!response.ok) {
			await reportSourceResult(env, source.name, false, 0, `${source.name} listing failed: HTTP ${response.status}`);
			return;
		}

		const links = discoverLinks(await response.text(), source);
		console.log(`${source.name}: found ${links.length} article links`);

		if (links.length === 0) {
			await reportSourceResult(env, source.name, false, 0, `${source.name} listing parsed 0 links (redesigned page or blocked?)`);
			return;
		}

		const next: SourceState = {
			initializedAt: state?.initializedAt ?? new Date().toISOString(),
			lastCount: links.length,
			...validatorsFrom(response),
		};

		if (!state) {
			const baseline = links.slice(0, MAX_BASELINE_ITEMS);
			for (const link of baseline) {
				await markSeen(env, await seenKey(link), { source: source.name, link, initializedAt: next.initializedAt });
			}
			await saveState(env, source.name, next);
			await reportSourceResult(env, source.name, true, links.length);
			console.log(`${source.name}: baselined ${baseline.length} articles (no messages sent).`);
			return;
		}

		await saveStateIfChanged(env, source.name, state, next);

		let sentCount = 0;
		for (const link of links.slice(0, MAX_ITEMS_PER_SOURCE)) {
			if (sentCount >= MAX_ANNOUNCEMENTS_PER_RUN) {
				console.log(`${source.name}: per-run announcement cap reached (${sentCount}); remaining candidates next run.`);
				break;
			}

			const key = await seenKey(link);
			if (await env.NEW_AI_CHECKER_KV.get(key)) continue;

			// Only unseen links are downloaded, so a steady-state run costs almost no requests.
			const article = await fetchArticle(env, link);
			if (!article.ok) {
				console.error(`${source.name} article failed (${article.reason}): ${link}`);
				if (article.permanent) {
					await markSeen(env, key, { source: source.name, link, skipped: article.reason, processedAt: new Date().toISOString() });
				}
				continue;
			}

			const item = article.item;
			if (!classifyModelRelease(item.title).matched) {
				console.log(`${source.name} skipped: ${item.title}`);
				await markSeen(env, key, { source: source.name, ...item, processedAt: new Date().toISOString() });
				continue;
			}

			const outcome = await announceOnce(env, source.name, item);
			if (outcome !== 'sent') break;
			sentCount += 1;
		}

		await reportSourceResult(env, source.name, true, links.length);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(`${source.name} processing error:`, error);
		await reportSourceResult(env, source.name, false, 0, `${source.name} error: ${reason}`);
	}
}

export function discoverLinks(html: string, source: HtmlSource): string[] {
	// Fresh copy so the shared pattern's lastIndex can never leak between runs.
	const pattern = new RegExp(source.linkPattern.source, source.linkPattern.flags);
	const links: string[] = [];
	const seen = new Set<string>();

	for (const match of html.matchAll(pattern)) {
		const raw = match[1];
		if (!raw) continue;

		const url = toAbsoluteUrl(source.baseUrl, raw);
		if (seen.has(url) || !isArticlePath(url)) continue;

		seen.add(url);
		links.push(url);
	}

	return links;
}

export function toAbsoluteUrl(baseUrl: string, raw: string): string {
	if (/^https?:\/\//i.test(raw)) return raw;

	const base = baseUrl.replace(/\/+$/, '');
	return raw.startsWith('/') ? `${base}${raw}` : `${base}/${raw}`;
}

// Article URLs are shaped `<section>/<slug>`; anything shorter is a section index or site root,
// and taxonomy segments are navigation, not announcements.
const NAVIGATION_SEGMENT = /(^|\/)(tags?|categor(?:y|ies)|pages?|authors?|search|feeds?|archives?)(\/|$)/;

export function isArticlePath(url: string): boolean {
	const path = url
		.replace(/^https?:\/\/[^/]+/i, '')
		.toLowerCase()
		.replace(/\/+$/, '');
	const segments = path.split('/').filter(Boolean);

	if (segments.length < 2) return false;

	return !NAVIGATION_SEGMENT.test(path);
}

type ArticleResult = { ok: true; item: FeedItem } | { ok: false; permanent: boolean; reason: string };

/** Bounded retry counter for article pages that can never be parsed (KV, 2-day TTL). */
async function bumpAttempt(env: Env, link: string): Promise<number> {
	const key = await attemptKey(link);
	const attempts = Number((await env.NEW_AI_CHECKER_KV.get(key)) ?? '0') + 1;
	await env.NEW_AI_CHECKER_KV.put(key, String(attempts), { expirationTtl: 60 * 60 * 24 * 2 });
	return attempts;
}

async function fetchArticle(env: Env, link: string): Promise<ArticleResult> {
	try {
		const response = await fetch(link, {
			headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});

		if (!response.ok) {
			const permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
			return { ok: false, permanent, reason: `HTTP ${response.status}` };
		}

		const contentType = response.headers.get('content-type') ?? '';
		if (contentType && !/(html|xml|text\/plain)/i.test(contentType)) {
			return { ok: false, permanent: true, reason: `unexpected content-type ${contentType}` };
		}

		const html = await response.text();
		const title = extractArticleTitle(html);
		if (!title) {
			const attempts = await bumpAttempt(env, link);
			return { ok: false, permanent: attempts >= MAX_ARTICLE_ATTEMPTS, reason: `no extractable title (attempt ${attempts}/${MAX_ARTICLE_ATTEMPTS})` };
		}

		const pubDate = extractArticleDate(html);
		const description = extractArticleDescription(html);

		return {
			ok: true,
			item: { title, link, ...(pubDate ? { pubDate } : {}), ...(description ? { description } : {}) },
		};
	} catch (error) {
		return { ok: false, permanent: false, reason: error instanceof Error ? error.message : String(error) };
	}
}
