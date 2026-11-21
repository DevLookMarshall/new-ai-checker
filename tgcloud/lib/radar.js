import { db, fetch } from 'sdk';
import { and, desc, eq } from 'sdk/db';
import { articleAttempts, meta, seenItems, sourcesState, subscribers } from '../schema.js';
import { analyzeReleasePersian } from './analyzer.js';
import { classifyModelRelease } from './classifier.js';
import {
	ALL_SOURCE_NAMES,
	FEEDS,
	HTML_SOURCES,
	MAX_ANNOUNCEMENTS_PER_RUN,
	MAX_ARTICLE_ATTEMPTS,
	MAX_BASELINE_ITEMS,
	MAX_ITEMS_PER_SOURCE,
	MINIAPP_SCAN_COOLDOWN_MS,
	USER_AGENT,
} from './config.js';
import { urlHash } from './ids.js';
import {
	extractArticleDate,
	extractArticleDescription,
	extractArticleTitle,
	parseFeed,
} from './parse.js';
import { broadcastAnnouncement, verifyAndTestChannel } from './telegram.js';

const META_LAST_SCAN_AT = 'last_scan_at';
const META_LAST_SCAN_SUMMARY = 'last_scan_summary';
const META_AI_PROVIDER = 'ai_provider';
const META_AI_KEY = 'ai_api_key';

const NAVIGATION_SEGMENT = /(^|\/)(tags?|categor(?:y|ies)|pages?|authors?|search|feeds?|archives?)(\/|$)/;

export function toAbsoluteUrl(baseUrl, raw) {
	if (/^https?:\/\//i.test(raw)) return raw;
	const base = baseUrl.replace(/\/+$/, '');
	return raw.startsWith('/') ? `${base}${raw}` : `${base}/${raw}`;
}

export function isArticlePath(url) {
	const path = url
		.replace(/^https?:\/\/[^/]+/i, '')
		.toLowerCase()
		.replace(/\/+$/, '');
	const segments = path.split('/').filter(Boolean);
	if (segments.length < 2) return false;
	return !NAVIGATION_SEGMENT.test(path);
}

export function discoverLinks(html, source) {
	const pattern = new RegExp(source.linkPattern.source, source.linkPattern.flags);
	const links = [];
	const seen = new Set();

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

function conditionalHeaders(state) {
	const headers = { 'User-Agent': USER_AGENT };
	if (state?.etag) headers['If-None-Match'] = state.etag;
	else if (state?.lastModified) headers['If-Modified-Since'] = state.lastModified;
	return headers;
}

export async function getMeta(key) {
	const row = await db.select().from(meta).where(eq(meta.key, key)).get();
	return row ? row.value : null;
}

export async function setMeta(key, value) {
	await db
		.insert(meta)
		.values({ key, value: String(value) })
		.onConflictDoUpdate({
			target: meta.key,
			set: { value: String(value) },
		})
		.run();
}

export async function getAiConfig() {
	const [provider, apiKey] = await Promise.all([getMeta(META_AI_PROVIDER), getMeta(META_AI_KEY)]);
	if (!provider || !apiKey) return null;
	return { provider, apiKey };
}

export async function setAiConfig(provider, apiKey) {
	await setMeta(META_AI_PROVIDER, provider);
	await setMeta(META_AI_KEY, apiKey);
}

export async function clearAiConfig() {
	await db.delete(meta).where(eq(meta.key, META_AI_PROVIDER)).run();
	await db.delete(meta).where(eq(meta.key, META_AI_KEY)).run();
}

async function upsertSourceState(name, values) {
	await db
		.insert(sourcesState)
		.values({ name, ...values })
		.onConflictDoUpdate({
			target: sourcesState.name,
			set: values,
		})
		.run();
}

async function markSeenItem(hash, item, flags) {
	const row = {
		urlHash: hash,
		link: item.link,
		source: flags.source,
		title: item.title ?? null,
		pubDate: item.pubDate ?? null,
		description: item.description ?? null,
		titleFa: flags.titleFa ?? null,
		descriptionFa: flags.descriptionFa ?? null,
		analysisFa: flags.analysisFa ?? null,
		matched: Boolean(flags.matched),
		announced: Boolean(flags.announced),
		deliveryStatus: flags.deliveryStatus,
		detectedAt: Date.now(),
	};

	await db
		.insert(seenItems)
		.values(row)
		.onConflictDoUpdate({
			target: seenItems.urlHash,
			set: {
				title: row.title,
				pubDate: row.pubDate,
				description: row.description,
				titleFa: row.titleFa,
				descriptionFa: row.descriptionFa,
				analysisFa: row.analysisFa,
				matched: row.matched,
				announced: row.announced,
				deliveryStatus: row.deliveryStatus,
				detectedAt: row.detectedAt,
			},
		})
		.run();
}

async function recordFailure(sourceName, existingState, note) {
	const failures = (existingState?.failures ?? 0) + 1;
	if (existingState) {
		await db
			.update(sourcesState)
			.set({
				failures,
				lastError: note,
			})
			.where(eq(sourcesState.name, sourceName))
			.run();
	}
	return { name: sourceName, status: 'failed', error: note, failures };
}

async function bumpAttempt(hash) {
	const existing = await db
		.select()
		.from(articleAttempts)
		.where(eq(articleAttempts.urlHash, hash))
		.get();
	const next = (existing?.attempts ?? 0) + 1;
	await db
		.insert(articleAttempts)
		.values({ urlHash: hash, attempts: next, updatedAt: Date.now() })
		.onConflictDoUpdate({
			target: articleAttempts.urlHash,
			set: { attempts: next, updatedAt: Date.now() },
		})
		.run();
	return next;
}

async function fetchArticle(link, hash) {
	try {
		const response = await fetch(link, {
			headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
		});

		if (!response.ok) {
			const permanent =
				response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
			return { ok: false, permanent, reason: `HTTP ${response.status}` };
		}

		const contentType = response.headers.get('content-type') ?? '';
		if (contentType && !/(html|xml|text\/plain)/i.test(contentType)) {
			return { ok: false, permanent: true, reason: `unexpected content-type ${contentType}` };
		}

		const html = await response.text();
		const title = extractArticleTitle(html);
		if (!title) {
			const attempts = await bumpAttempt(hash);
			return {
				ok: false,
				permanent: attempts >= MAX_ARTICLE_ATTEMPTS,
				reason: `no extractable title (${attempts}/${MAX_ARTICLE_ATTEMPTS})`,
			};
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

async function processFeedSource(source, triggerChatId, aiConfig) {
	const state = await db.select().from(sourcesState).where(eq(sourcesState.name, source.name)).get();

	try {
		const response = await fetch(source.url, { headers: conditionalHeaders(state) });

		if (response.status === 304 && state) {
			await db
				.update(sourcesState)
				.set({ failures: 0, lastOkAt: new Date().toISOString(), lastError: null })
				.where(eq(sourcesState.name, source.name))
				.run();
			return { name: source.name, status: 'not_modified', count: state.lastCount ?? 0, announced: [] };
		}

		if (!response.ok) {
			return recordFailure(source.name, state, `HTTP ${response.status}`);
		}

		const items = parseFeed(await response.text());
		if (items.length === 0) {
			return recordFailure(source.name, state, 'feed parsed 0 items');
		}

		const nowIso = new Date().toISOString();
		const etag = response.headers.get('etag') ?? null;
		const lastModified = response.headers.get('last-modified') ?? null;

		if (!state) {
			let baselineAnalyzed = 0;
			for (const item of items.slice(0, MAX_ITEMS_PER_SOURCE)) {
				const hash = await urlHash(item.link);
				const cls = classifyModelRelease(item.title);
				let analysis = null;
				if (cls.matched && baselineAnalyzed < 2) {
					analysis = await analyzeReleasePersian(source.name, item, cls, aiConfig);
					baselineAnalyzed += 1;
				}
				await markSeenItem(hash, item, {
					source: source.name,
					titleFa: analysis?.titleFa,
					descriptionFa: analysis?.descriptionFa,
					analysisFa: analysis?.analysisFa,
					matched: cls.matched,
					announced: false,
					deliveryStatus: 'baselined',
				});
			}
			await upsertSourceState(source.name, {
				initializedAt: nowIso,
				etag,
				lastModified,
				lastCount: items.length,
				failures: 0,
				lastOkAt: nowIso,
				lastError: null,
			});
			return { name: source.name, status: 'baselined', count: items.length, announced: [] };
		}

		await upsertSourceState(source.name, {
			initializedAt: state.initializedAt,
			etag,
			lastModified,
			lastCount: items.length,
			failures: 0,
			lastOkAt: nowIso,
			lastError: null,
		});

		const announced = [];
		for (const item of items.slice(0, MAX_ITEMS_PER_SOURCE)) {
			if (announced.length >= MAX_ANNOUNCEMENTS_PER_RUN) break;
			const hash = await urlHash(item.link);
			const existing = await db.select().from(seenItems).where(eq(seenItems.urlHash, hash)).get();
			if (existing) continue;

			const cls = classifyModelRelease(item.title);
			if (!cls.matched) {
				await markSeenItem(hash, item, {
					source: source.name,
					matched: false,
					announced: false,
					deliveryStatus: 'skipped',
				});
				continue;
			}

			const analysis = await analyzeReleasePersian(source.name, item, cls, aiConfig);
			const delivery = await broadcastAnnouncement(source.name, item, analysis, triggerChatId);
			if (delivery.action === 'sent') {
				await markSeenItem(hash, item, {
					source: source.name,
					titleFa: analysis.titleFa,
					descriptionFa: analysis.descriptionFa,
					analysisFa: analysis.analysisFa,
					matched: true,
					announced: true,
					deliveryStatus: 'sent',
				});
				announced.push({ source: source.name, ...item, ...analysis });
			} else if (delivery.action === 'give-up') {
				await markSeenItem(hash, item, {
					source: source.name,
					titleFa: analysis.titleFa,
					descriptionFa: analysis.descriptionFa,
					analysisFa: analysis.analysisFa,
					matched: true,
					announced: false,
					deliveryStatus: 'failed',
				});
				break;
			} else {
				await markSeenItem(hash, item, {
					source: source.name,
					titleFa: analysis.titleFa,
					descriptionFa: analysis.descriptionFa,
					analysisFa: analysis.analysisFa,
					matched: true,
					announced: false,
					deliveryStatus: 'unannounced',
				});
			}
		}

		return { name: source.name, status: 'ok', count: items.length, announced };
	} catch (error) {
		return recordFailure(source.name, state, error instanceof Error ? error.message : String(error));
	}
}

async function processHtmlSource(source, triggerChatId, aiConfig) {
	const state = await db.select().from(sourcesState).where(eq(sourcesState.name, source.name)).get();

	try {
		const response = await fetch(source.url, {
			headers: { ...conditionalHeaders(state), Accept: 'text/html,application/xhtml+xml' },
		});

		if (response.status === 304 && state) {
			await db
				.update(sourcesState)
				.set({ failures: 0, lastOkAt: new Date().toISOString(), lastError: null })
				.where(eq(sourcesState.name, source.name))
				.run();
			return { name: source.name, status: 'not_modified', count: state.lastCount ?? 0, announced: [] };
		}

		if (!response.ok) {
			return recordFailure(source.name, state, `HTTP ${response.status}`);
		}

		const links = discoverLinks(await response.text(), source);
		if (links.length === 0) {
			return recordFailure(source.name, state, 'listing parsed 0 links');
		}

		const nowIso = new Date().toISOString();
		const etag = response.headers.get('etag') ?? null;
		const lastModified = response.headers.get('last-modified') ?? null;

		if (!state) {
			for (const link of links.slice(0, MAX_BASELINE_ITEMS)) {
				const hash = await urlHash(link);
				await markSeenItem(
					hash,
					{ link },
					{
						source: source.name,
						matched: false,
						announced: false,
						deliveryStatus: 'baselined',
					},
				);
			}
			await upsertSourceState(source.name, {
				initializedAt: nowIso,
				etag,
				lastModified,
				lastCount: links.length,
				failures: 0,
				lastOkAt: nowIso,
				lastError: null,
			});
			return { name: source.name, status: 'baselined', count: links.length, announced: [] };
		}

		await upsertSourceState(source.name, {
			initializedAt: state.initializedAt,
			etag,
			lastModified,
			lastCount: links.length,
			failures: 0,
			lastOkAt: nowIso,
			lastError: null,
		});

		const announced = [];
		for (const link of links.slice(0, MAX_ITEMS_PER_SOURCE)) {
			if (announced.length >= MAX_ANNOUNCEMENTS_PER_RUN) break;
			const hash = await urlHash(link);
			const existing = await db.select().from(seenItems).where(eq(seenItems.urlHash, hash)).get();
			if (existing) continue;

			const article = await fetchArticle(link, hash);
			if (!article.ok) {
				if (article.permanent) {
					await markSeenItem(
						hash,
						{ link },
						{
							source: source.name,
							matched: false,
							announced: false,
							deliveryStatus: 'unparseable',
						},
					);
				}
				continue;
			}

			const item = article.item;
			const cls = classifyModelRelease(item.title);
			if (!cls.matched) {
				await markSeenItem(hash, item, {
					source: source.name,
					matched: false,
					announced: false,
					deliveryStatus: 'skipped',
				});
				continue;
			}

			const analysis = await analyzeReleasePersian(source.name, item, cls, aiConfig);
			const delivery = await broadcastAnnouncement(source.name, item, analysis, triggerChatId);
			if (delivery.action === 'sent') {
				await markSeenItem(hash, item, {
					source: source.name,
					titleFa: analysis.titleFa,
					descriptionFa: analysis.descriptionFa,
					analysisFa: analysis.analysisFa,
					matched: true,
					announced: true,
					deliveryStatus: 'sent',
				});
				announced.push({ source: source.name, ...item, ...analysis });
			} else if (delivery.action === 'give-up') {
				await markSeenItem(hash, item, {
					source: source.name,
					titleFa: analysis.titleFa,
					descriptionFa: analysis.descriptionFa,
					analysisFa: analysis.analysisFa,
					matched: true,
					announced: false,
					deliveryStatus: 'failed',
				});
				break;
			} else {
				await markSeenItem(hash, item, {
					source: source.name,
					titleFa: analysis.titleFa,
					descriptionFa: analysis.descriptionFa,
					analysisFa: analysis.analysisFa,
					matched: true,
					announced: false,
					deliveryStatus: 'unannounced',
				});
			}
		}

		return { name: source.name, status: 'ok', count: links.length, announced };
	} catch (error) {
		return recordFailure(source.name, state, error instanceof Error ? error.message : String(error));
	}
}

export async function ensureSubscriber(chat, subscribed = true) {
	if (!chat || chat.id === undefined || chat.id === null) return null;
	const chatId = String(chat.id);
	const label = chat.title || chat.username || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chatId;

	await db
		.insert(subscribers)
		.values({
			chatId,
			chatType: chat.type || 'private',
			label,
			subscribed,
			createdAt: Date.now(),
		})
		.onConflictDoUpdate({
			target: subscribers.chatId,
			set: {
				chatType: chat.type || 'private',
				label,
				subscribed,
			},
		})
		.run();

	return db.select().from(subscribers).where(eq(subscribers.chatId, chatId)).get();
}

export async function listChannels() {
	return db
		.select()
		.from(subscribers)
		.where(and(eq(subscribers.chatType, 'channel'), eq(subscribers.subscribed, true)))
		.all();
}

export async function addChannel(channelRef, sendTest = true) {
	const verified = await verifyAndTestChannel(channelRef, sendTest);
	await db
		.insert(subscribers)
		.values({
			chatId: verified.chatId,
			chatType: 'channel',
			label: verified.label,
			subscribed: true,
			createdAt: Date.now(),
		})
		.onConflictDoUpdate({
			target: subscribers.chatId,
			set: {
				chatType: 'channel',
				label: verified.label,
				subscribed: true,
			},
		})
		.run();

	return verified;
}

export async function removeChannel(chatId) {
	const normalized = String(chatId || '').trim();
	if (!normalized) return;
	await db
		.update(subscribers)
		.set({ subscribed: false })
		.where(eq(subscribers.chatId, normalized))
		.run();
}

export async function analyzeReleaseById(id) {
	const row = await db.select().from(seenItems).where(eq(seenItems.id, Number(id))).get();
	if (!row) return null;

	if (row.titleFa && row.analysisFa) {
		return row;
	}

	const aiConfig = await getAiConfig();
	const cls = row.title ? classifyModelRelease(row.title) : null;
	const analysis = await analyzeReleasePersian(
		row.source,
		{ title: row.title || row.link, link: row.link, description: row.description || '' },
		cls,
		aiConfig,
	);

	await db
		.update(seenItems)
		.set({
			titleFa: analysis.titleFa,
			descriptionFa: analysis.descriptionFa,
			analysisFa: analysis.analysisFa,
		})
		.where(eq(seenItems.id, row.id))
		.run();

	return db.select().from(seenItems).where(eq(seenItems.id, row.id)).get();
}

export async function analyzeCustomInput(rawText) {
	const text = String(rawText || '').trim();
	const aiConfig = await getAiConfig();
	const firstLine = text.split('\n')[0] || text;
	const cls = classifyModelRelease(firstLine);
	const analysis = await analyzeReleasePersian(
		'تحلیل دستی',
		{ title: firstLine, description: text.length > firstLine.length ? text : '' },
		cls,
		aiConfig,
	);
	return {
		...analysis,
		classification: cls,
	};
}

export async function runRadarScan({ triggerChatId = null, onlySource = null, respectCooldown = false } = {}) {
	if (respectCooldown) {
		const lastRaw = await getMeta(META_LAST_SCAN_AT);
		if (lastRaw) {
			const elapsed = Date.now() - Number(lastRaw);
			if (Number.isFinite(elapsed) && elapsed < MINIAPP_SCAN_COOLDOWN_MS) {
				const retryInSec = Math.ceil((MINIAPP_SCAN_COOLDOWN_MS - elapsed) / 1000);
				return { throttled: true, retryInSec };
			}
		}
	}

	const aiConfig = await getAiConfig();
	const filter = onlySource ? onlySource.trim().toLowerCase() : '';
	const feeds = filter ? FEEDS.filter((f) => f.name.toLowerCase() === filter) : FEEDS;
	const htmls = filter ? HTML_SOURCES.filter((s) => s.name.toLowerCase() === filter) : HTML_SOURCES;

	const tasks = [
		...feeds.map((feed) => processFeedSource(feed, triggerChatId, aiConfig)),
		...htmls.map((source) => processHtmlSource(source, triggerChatId, aiConfig)),
	];

	const settled = await Promise.allSettled(tasks);
	const results = [];
	const announcedItems = [];

	for (const res of settled) {
		if (res.status === 'fulfilled') {
			results.push(res.value);
			if (Array.isArray(res.value.announced)) {
				announcedItems.push(...res.value.announced);
			}
		} else {
			results.push({ name: 'unknown', status: 'failed', error: String(res.reason), announced: [] });
		}
	}

	const nowMs = Date.now();
	const summary = {
		throttled: false,
		scannedAt: new Date(nowMs).toISOString(),
		totalSources: results.length,
		baselined: results.filter((r) => r.status === 'baselined').length,
		notModified: results.filter((r) => r.status === 'not_modified').length,
		ok: results.filter((r) => r.status === 'ok').length,
		failed: results.filter((r) => r.status === 'failed').length,
		announcedItems,
		results,
	};

	await setMeta(META_LAST_SCAN_AT, String(nowMs));
	await setMeta(
		META_LAST_SCAN_SUMMARY,
		JSON.stringify({
			scannedAt: summary.scannedAt,
			totalSources: summary.totalSources,
			failed: summary.failed,
			announcedCount: announcedItems.length,
		}),
	);

	return summary;
}

export async function getDashboardData(userId = null) {
	const states = await db.select().from(sourcesState).all();
	const stateMap = new Map(states.map((s) => [s.name, s]));

	const sources = ALL_SOURCE_NAMES.map((name) => {
		const st = stateMap.get(name);
		const isFeed = FEEDS.some((f) => f.name === name);
		return {
			name,
			type: isFeed ? 'RSS' : 'HTML',
			initialized: Boolean(st),
			lastCount: st?.lastCount ?? 0,
			failures: st?.failures ?? 0,
			lastOkAt: st?.lastOkAt ?? null,
			lastError: st?.lastError ?? null,
		};
	});

	const releases = await db
		.select()
		.from(seenItems)
		.where(eq(seenItems.matched, true))
		.orderBy(desc(seenItems.detectedAt))
		.limit(30)
		.all();

	const totalSubscribers = await db.$count(subscribers, eq(subscribers.subscribed, true));
	const channels = await listChannels();
	const lastScanAtRaw = await getMeta(META_LAST_SCAN_AT);
	const aiConfig = await getAiConfig();

	let isSubscribed = false;
	if (userId !== null && userId !== undefined) {
		const sub = await db
			.select()
			.from(subscribers)
			.where(eq(subscribers.chatId, String(userId)))
			.get();
		isSubscribed = Boolean(sub?.subscribed);
	}

	return {
		sources,
		releases,
		channels: channels.map((c) => ({ chatId: c.chatId, label: c.label || c.chatId })),
		aiConfigured: Boolean(aiConfig),
		aiProvider: aiConfig?.provider || null,
		stats: {
			totalSources: ALL_SOURCE_NAMES.length,
			initializedSources: states.length,
			healthySources: sources.filter((s) => s.initialized && s.failures === 0).length,
			totalSubscribers,
			totalChannels: channels.length,
			lastScanAt: lastScanAtRaw ? new Date(Number(lastScanAtRaw)).toISOString() : null,
		},
		isSubscribed,
	};
}
