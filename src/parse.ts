import type { FeedItem } from './config.ts';

/**
 * Parses RSS 2.0 *and* Atom documents into FeedItem[].
 *
 * The previous implementation only understood `<item>` + `<link>`, so a feed
 * that switched to Atom would silently return zero items. Both dialects are
 * handled here, and a zero-item result is surfaced to the caller so it can be
 * treated as a failure rather than "nothing new today".
 */
export function parseFeed(xml: string): FeedItem[] {
	const items: FeedItem[] = [];
	const blocks = xml.match(/<(item|entry)[\s\S]*?<\/\1>/g) ?? [];

	for (const block of blocks) {
		const title = matchTag(block, 'title');
		const link = matchLink(block);
		const pubDate = matchTag(block, 'pubdate') ?? matchTag(block, 'published') ?? matchTag(block, 'updated') ?? matchTag(block, 'date');
		const description = matchTag(block, 'description') ?? matchTag(block, 'summary') ?? matchTag(block, 'content');

		if (!title || !link) continue;

		items.push({
			title: decodeEntities(stripCdata(title)).trim(),
			link: decodeEntities(stripCdata(link)).trim(),
			...(pubDate ? { pubDate: formatDisplayDate(decodeEntities(stripCdata(pubDate))) } : {}),
			...(description ? { description: summarize(decodeEntities(stripCdata(description))) } : {}),
		});
	}

	return items;
}

/** `<title>`, `<title><![CDATA[…]]></title>` and namespaced variants. */
function matchTag(block: string, tag: string): string | undefined {
	const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
	const match = block.match(pattern);
	return match?.[1];
}

/** RSS: `<link>url</link>` (optionally CDATA). Atom: `<link href="url" …/>`. */
function matchLink(block: string): string | undefined {
	const href = block.match(/<link[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i)?.[1];
	if (href) return href;

	const inner = matchTag(block, 'link');
	if (!inner) return undefined;

	return inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() || undefined;
}

function stripCdata(value: string): string {
	return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
		.replace(/&nbsp;/gi, ' ')
		.replace(/&quot;/g, '"')
		.replace(/&apos;|&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

/** og:title / twitter:title / JSON-LD / <title> — stable metadata, unlike hashed CSS-module classes. */
export function extractArticleTitle(html: string): string {
	return extractMeta(html, 'og:title') || extractMeta(html, 'twitter:title') || extractJsonLdField(html, 'headline') || extractTagText(html, 'title');
}

export function extractArticleDescription(html: string): string {
	const raw = extractMeta(html, 'og:description') || extractMeta(html, 'twitter:description') || extractJsonLdField(html, 'description');
	return raw ? summarize(raw) : '';
}

export function extractArticleDate(html: string): string | undefined {
	for (const key of ['article:published_time', 'og:article:published_time', 'datePublished', 'pubdate', 'date']) {
		const value = extractMeta(html, key);
		if (value) return formatDisplayDate(value);
	}

	const timeText = extractTagText(html, 'time');
	return timeText || undefined;
}

function extractMeta(html: string, key: string): string {
	const escaped = escapeRegExp(key);
	const patterns = [
		new RegExp(`<meta[^>]*\\bproperty=["']${escaped}["'][^>]*\\bcontent=["']([^"']*)["']`, 'i'),
		new RegExp(`<meta[^>]*\\bcontent=["']([^"']*)["'][^>]*\\bproperty=["']${escaped}["']`, 'i'),
		new RegExp(`<meta[^>]*\\bname=["']${escaped}["'][^>]*\\bcontent=["']([^"']*)["']`, 'i'),
		new RegExp(`<meta[^>]*\\bcontent=["']([^"']*)["'][^>]*\\bname=["']${escaped}["']`, 'i'),
	];

	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match?.[1]) return decodeEntities(match[1]).trim();
	}

	return '';
}

function extractTagText(html: string, tag: string): string {
	const escaped = escapeRegExp(tag);
	const match = html.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
	if (!match?.[1]) return '';

	return decodeEntities(match[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Breadth-first walk of JSON-LD nodes (incl. `@graph`) looking for `field`. */
function extractJsonLdField(html: string, field: string): string {
	const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
	const queue: unknown[] = [];

	for (const block of blocks) {
		const json = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
		try {
			queue.push(JSON.parse(json));
		} catch {
			// Ignore malformed JSON-LD blocks.
		}
	}

	while (queue.length > 0) {
		const node = queue.shift();
		if (Array.isArray(node)) {
			queue.push(...node);
			continue;
		}
		if (!node || typeof node !== 'object') continue;

		const record = node as Record<string, unknown>;
		if (typeof record[field] === 'string' && record[field].trim()) return record[field].trim();
		if (Array.isArray(record['@graph'])) queue.push(...(record['@graph'] as unknown[]));
		if (record.mainEntity && typeof record.mainEntity === 'object') queue.push(record.mainEntity);
	}

	return '';
}

/** RFC-822/ISO dates become `Oct 9, 2026`; already-formatted values pass through. */
export function formatDisplayDate(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return value.trim();

	return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeCodePoint(code: number): string {
	if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
	try {
		return String.fromCodePoint(code);
	} catch {
		return '';
	}
}

/** Strips markup and truncates on a word boundary — used for Telegram excerpts. */
export function summarize(html: string, maxLength = 220): string {
	const text = decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
	if (text.length <= maxLength) return text;

	const cut = text.slice(0, maxLength);
	const lastSpace = cut.lastIndexOf(' ');
	return `${cut.slice(0, lastSpace > maxLength * 0.6 ? lastSpace : cut.length)}…`;
}
