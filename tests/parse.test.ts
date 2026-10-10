import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractArticleDate, extractArticleDescription, extractArticleTitle, formatDisplayDate, parseFeed, summarize } from '../src/parse.ts';

test('parses RSS 2.0 items with CDATA titles', () => {
	const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>
		<item>
			<title><![CDATA[Introducing GPT-6.1 Sol]]></title>
			<link>https://openai.com/index/gpt-6-1</link>
			<description><![CDATA[<p>Our most capable model &amp; fastest inference.</p>]]></description>
			<pubDate>Fri, 09 Oct 2026 07:00:00 GMT</pubDate>
		</item></channel></rss>`;

	const items = parseFeed(xml);
	assert.equal(items.length, 1);
	assert.equal(items[0].title, 'Introducing GPT-6.1 Sol');
	assert.equal(items[0].link, 'https://openai.com/index/gpt-6-1');
	assert.equal(items[0].pubDate, 'Oct 9, 2026');
	assert.equal(items[0].description, 'Our most capable model & fastest inference.');
});

test('parses RSS items with plain (non-CDATA) titles and escapes', () => {
	const xml = `<rss><channel><item>
		<title>Gemini 4 &amp; the next era</title>
		<link>https://deepmind.google/blog/gemini-4/</link>
	</item></channel></rss>`;

	const items = parseFeed(xml);
	assert.equal(items.length, 1);
	assert.equal(items[0].title, 'Gemini 4 & the next era');
});

test('parses Atom entries (link href, published, summary)', () => {
	const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
		<entry>
			<title>Introducing Claude 5</title>
			<link href="https://www.anthropic.com/news/claude-5" rel="alternate"/>
			<published>2026-10-01T12:00:00Z</published>
			<summary><![CDATA[The most intelligent model we have ever built.]]></summary>
		</entry>
	</feed>`;

	const items = parseFeed(xml);
	assert.equal(items.length, 1);
	assert.equal(items[0].title, 'Introducing Claude 5');
	assert.equal(items[0].link, 'https://www.anthropic.com/news/claude-5');
	assert.equal(items[0].pubDate, 'Oct 1, 2026');
	assert.equal(items[0].description, 'The most intelligent model we have ever built.');
});

test('returns zero items for non-feed content (caller treats as failure)', () => {
	assert.equal(parseFeed('<html><body>403 Forbidden</body></html>').length, 0);
	assert.equal(parseFeed('').length, 0);
});

test('formatDisplayDate normalizes RFC-822 and ISO dates, passes through unknown text', () => {
	assert.equal(formatDisplayDate('Tue, 06 Oct 2026 19:57:04 +0000'), 'Oct 6, 2026');
	assert.equal(formatDisplayDate('2026-09-30T20:01:45Z'), 'Sep 30, 2026');
	assert.equal(formatDisplayDate('sometime last week'), 'sometime last week');
});

test('summarize strips markup and truncates on a word boundary', () => {
	assert.equal(summarize('<p>Hello <b>world</b></p>'), 'Hello world');
	const long = `<p>${'word '.repeat(80)}</p>`;
	const summary = summarize(long);
	assert.ok(summary.endsWith('…'));
	assert.ok(summary.length <= 221);
});

test('extracts og:title / og:description / article date from article HTML', () => {
	const html = `<!doctype html><html><head>
		<title>Fallback Title</title>
		<meta property="og:title" content="Gemini 4 Argon &amp; friends" />
		<meta property="og:description" content="Our next era of frontier intelligence." />
		<meta name="article:published_time" content="2026-09-30T20:01:45Z" />
	</head><body></body></html>`;

	assert.equal(extractArticleTitle(html), 'Gemini 4 Argon & friends');
	assert.equal(extractArticleDescription(html), 'Our next era of frontier intelligence.');
	assert.equal(extractArticleDate(html), 'Sep 30, 2026');
});

test('extracts headline from JSON-LD when no og:title exists', () => {
	const html = `<html><head><script type="application/ld+json">
		{"@context":"https://schema.org","@type":"NewsArticle","headline":"Introducing SynthID Bio","description":"Watermarking models."}
	</script></head><body></body></html>`;

	assert.equal(extractArticleTitle(html), 'Introducing SynthID Bio');
	assert.equal(extractArticleDescription(html), 'Watermarking models.');
});
