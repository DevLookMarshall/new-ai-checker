import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HTML_SOURCES } from '../src/config.ts';
import { discoverLinks, isArticlePath, processHtmlSource, toAbsoluteUrl } from '../src/sources.ts';
import { articleHtml, createFetchRouter, FakeKv, makeEnv } from './helpers.ts';

const SOURCE = HTML_SOURCES[0]; // Anthropic
const LISTING = 'https://www.anthropic.com/news';

const LISTING_HTML = `<!doctype html><html><body>
	<a href="/news/claude-4">Claude 4</a>
	<a href="https://www.anthropic.com/news/claude-5">Claude 5</a>
	<a href="/news/claude-4">Claude 4 (dup)</a>
	<a href="/news">News index (not an article)</a>
	<a href="/news/tags/safety">Safety tag (not an article)</a>
	<a href="/about">About (not an article)</a>
</body></html>`;

test('toAbsoluteUrl resolves relative links against the base', () => {
	assert.equal(toAbsoluteUrl('https://x.ai', '/news/foo'), 'https://x.ai/news/foo');
	assert.equal(toAbsoluteUrl('https://x.ai/', 'news/foo'), 'https://x.ai/news/foo');
	assert.equal(toAbsoluteUrl('https://x.ai', 'https://x.ai/news/foo'), 'https://x.ai/news/foo');
});

test('isArticlePath keeps section/slug URLs and drops indices', () => {
	assert.equal(isArticlePath('https://www.anthropic.com/news/claude-5'), true);
	assert.equal(isArticlePath('https://www.anthropic.com/news'), false);
	assert.equal(isArticlePath('https://www.anthropic.com/'), false);
	assert.equal(isArticlePath('https://www.anthropic.com/news/tags/safety'), false);
	assert.equal(isArticlePath('https://ai.meta.com/blog/categories/llama'), false);
});

test('discoverLinks extracts and dedupes article links', () => {
	const links = discoverLinks(LISTING_HTML, SOURCE);
	assert.deepEqual(links, ['https://www.anthropic.com/news/claude-4', 'https://www.anthropic.com/news/claude-5']);
});

function setup(): { kv: FakeKv; router: ReturnType<typeof createFetchRouter>; calls: string[] } {
	const kv = new FakeKv();
	const router = createFetchRouter();
	const calls: string[] = [];
	router.routes.push(
		{
			match: (url) => url === LISTING,
			handle: () => new Response(LISTING_HTML, { status: 200 }),
		},
		{
			match: (url) => url === 'https://www.anthropic.com/news/claude-4',
			handle: (url) => {
				calls.push(url);
				return new Response(articleHtml('Claude 4 architecture deep dive'), { status: 200, headers: { 'content-type': 'text/html' } });
			},
		},
		{
			match: (url) => url === 'https://www.anthropic.com/news/claude-5',
			handle: (url) => {
				calls.push(url);
				return new Response(articleHtml('Introducing Claude 5 Ultra', 'Our most intelligent model yet.'), {
					status: 200,
					headers: { 'content-type': 'text/html' },
				});
			},
		},
	);
	router.install();
	return { kv, router, calls };
}

test('HTML listing baselines silently, then announces only new model articles', async () => {
	const { kv, router, calls } = setup();
	try {
		const env = makeEnv(kv);
		await processHtmlSource(SOURCE, env);
		assert.equal(router.sent.length, 0, 'baseline must not send messages');
		assert.equal(calls.length, 0, 'baseline must not download articles');

		await processHtmlSource(SOURCE, env);
		assert.equal(router.sent.length, 0, 'baselined articles are already seen');

		// A brand-new article appears on the listing.
		router.routes.length = 0;
		router.routes.push(
			{
				match: (url) => url === LISTING,
				handle: () =>
					new Response(LISTING_HTML.replace('/news/claude-4', '/news/claude-6'), { status: 200 }),
			},
			{
				match: (url) => url === 'https://www.anthropic.com/news/claude-6',
				handle: (url) => {
					calls.push(url);
					return new Response(articleHtml('Introducing Claude 6 Opus'), { status: 200, headers: { 'content-type': 'text/html' } });
				},
			},
		);

		await processHtmlSource(SOURCE, env);
		assert.equal(router.sent.length, 1);
		assert.match(String(router.sent[0].text), /Introducing Claude 6 Opus/);
		assert.equal(calls.length, 1, 'only the unseen article is downloaded');

		await processHtmlSource(SOURCE, env);
		assert.equal(router.sent.length, 1, 'no duplicate on the next run');
	} finally {
		router.restore();
	}
});

test('permanently broken articles stop being retried after bounded attempts', async () => {
	const { kv, router, calls } = setup();
	try {
		const env = makeEnv(kv);
		await processHtmlSource(SOURCE, env);
		assert.equal(calls.length, 0);

		router.routes.length = 0;
		router.routes.push(
			{
				match: (url) => url === LISTING,
				handle: () => new Response(LISTING_HTML.replace('/news/claude-4', '/news/gone'), { status: 200 }),
			},
			{
				match: (url) => url === 'https://www.anthropic.com/news/gone',
				handle: (url) => {
					calls.push(url);
					return new Response('', { status: 404 });
				},
			},
		);

		for (let run = 0; run < 5; run++) await processHtmlSource(SOURCE, env);
		assert.equal(calls.length, 1, 'a 404 article is marked seen immediately, not re-fetched');
		assert.equal(router.sent.length, 0);
	} finally {
		router.restore();
	}
});

test('title-less articles are retried a bounded number of times, then skipped', async () => {
	const { kv, router, calls } = setup();
	try {
		const env = makeEnv(kv);
		await processHtmlSource(SOURCE, env);

		router.routes.length = 0;
		router.routes.push(
			{
				match: (url) => url === LISTING,
				handle: () => new Response(LISTING_HTML.replace('/news/claude-4', '/news/js-shell'), { status: 200 }),
			},
			{
				match: (url) => url === 'https://www.anthropic.com/news/js-shell',
				handle: (url) => {
					calls.push(url);
					return new Response('<html><body>loading…</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
				},
			},
		);

		for (let run = 0; run < 5; run++) await processHtmlSource(SOURCE, env);
		assert.equal(calls.length, 3, 'title-less article fetched at most 3 times, then marked seen');
		assert.equal(router.sent.length, 0);
	} finally {
		router.restore();
	}
});
