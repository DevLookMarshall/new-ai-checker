export function parseFeed(xml) {
	const items = [];
	const blocks = xml.match(/<(item|entry)[\s\S]*?<\/\1>/g) ?? [];

	for (const block of blocks) {
		const title = matchTag(block, 'title');
		const link = matchLink(block);
		const pubDate =
			matchTag(block, 'pubdate') ??
			matchTag(block, 'published') ??
			matchTag(block, 'updated') ??
			matchTag(block, 'date');
		const description =
			matchTag(block, 'description') ??
			matchTag(block, 'summary') ??
			matchTag(block, 'content');

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

function matchTag(block, tag) {
	const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
	const match = block.match(pattern);
	return match?.[1];
}

function matchLink(block) {
	const href = block.match(/<link[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i)?.[1];
	if (href) return href;

	const inner = matchTag(block, 'link');
	if (!inner) return undefined;

	return inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() || undefined;
}

function stripCdata(value) {
	return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function decodeEntities(text) {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
		.replace(/&nbsp;/gi, ' ')
		.replace(/&quot;/g, '"')
		.replace(/&apos;|&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

export function extractArticleTitle(html) {
	return (
		extractMeta(html, 'og:title') ||
		extractMeta(html, 'twitter:title') ||
		extractJsonLdField(html, 'headline') ||
		extractTagText(html, 'title')
	);
}

export function extractArticleDescription(html) {
	const raw =
		extractMeta(html, 'og:description') ||
		extractMeta(html, 'twitter:description') ||
		extractJsonLdField(html, 'description');
	return raw ? summarize(raw) : '';
}

export function extractArticleDate(html) {
	for (const key of ['article:published_time', 'og:article:published_time', 'datePublished', 'pubdate', 'date']) {
		const value = extractMeta(html, key);
		if (value) return formatDisplayDate(value);
	}

	const timeText = extractTagText(html, 'time');
	return timeText || undefined;
}

function extractMeta(html, key) {
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

function extractTagText(html, tag) {
	const escaped = escapeRegExp(tag);
	const match = html.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
	if (!match?.[1]) return '';

	return decodeEntities(match[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function extractJsonLdField(html, field) {
	const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
	const queue = [];

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

		if (typeof node[field] === 'string' && node[field].trim()) return node[field].trim();
		if (Array.isArray(node['@graph'])) queue.push(...node['@graph']);
		if (node.mainEntity && typeof node.mainEntity === 'object') queue.push(node.mainEntity);
	}

	return '';
}

export function formatDisplayDate(value) {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return value.trim();

	return parsed.toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC',
	});
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeCodePoint(code) {
	if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
	try {
		return String.fromCodePoint(code);
	} catch {
		return '';
	}
}

export function summarize(html, maxLength = 220) {
	const text = decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
	if (text.length <= maxLength) return text;

	const cut = text.slice(0, maxLength);
	const lastSpace = cut.lastIndexOf(' ');
	return `${cut.slice(0, lastSpace > maxLength * 0.6 ? lastSpace : cut.length)}…`;
}
