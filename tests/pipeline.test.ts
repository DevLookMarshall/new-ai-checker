import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEEDS } from '../src/config.ts';
import worker from '../src/index.ts';
import { processFeed } from '../src/sources.ts';
import { createFetchRouter, FakeKv, makeEnv, rss } from './helpers.ts';

const FEED = { name: 'OpenAI', url: 'https://openai.com/news/rss.xml' };

const INITIAL = [
	{ title: 'Introducing GPT-6.1 Sol', link: 'https://openai.com/index/gpt-6-1' },
	{ title: ' GPT-6 and Intelligent UI for everyone', link: 'https://openai.com/index/gpt-6' },
];

const NEW_RELEASE = { title: 'Introducing GPT-7 Atlas', link: 'https://openai.com/index/gpt-7' };

function setup(feedBody: string, etag?: string): { kv: FakeKv; router: ReturnType<typeof createFetchRouter> } {
	const kv = new FakeKv();
	const router = createFetchRouter();
	router.routes.push({
		match: (url) => url === FEED.url,
		handle: () =>
			new Response(feedBody, {
				status: 200,
				headers: etag ? { etag } : {},
			}),
	});
	router.install();
	return { kv, router };
}

test('first successful run baselines silently (no announcements)', async () => {
	const { kv, router } = setup(rss(INITIAL));
	try {
		await processFeed(FEED, makeEnv(kv));

		assert.equal(router.sent.length, 0);
		assert.ok(kv.store.get('state:v2:OpenAI') !== undefined);
		const seen = [...kv.store.keys()].filter((key) => key.startsWith('seen:'));
		assert.equal(seen.length, 2);
	} finally {
		router.restore();
	}
});

test('only genuinely new, unseen releases are announced — exactly once', async () => {
	const { kv, router } = setup(rss(INITIAL));
	try {
		const env = makeEnv(kv);
		await processFeed(FEED, env);
		assert.equal(router.sent.length, 0);

		router.routes.length = 0;
		router.routes.push({ match: (url) => url === FEED.url, handle: () => new Response(rss([NEW_RELEASE, ...INITIAL]), { status: 200 }) });

		await processFeed(FEED, env);
		assert.equal(router.sent.length, 1);
		const text = String(router.sent[0].text);
		assert.match(text, /Introducing GPT-7 Atlas/);
		assert.match(text, /OpenAI/);

		await processFeed(FEED, env);
		assert.equal(router.sent.length, 1);
	} finally {
		router.restore();
	}
});

test('empty first response cannot fake an initialization (flood regression)', async () => {
	const { kv, router } = setup('<html><body>403 Forbidden</body></html>');
	try {
		const env = makeEnv(kv);
		await processFeed(FEED, env);
		assert.equal(kv.store.get('state:v2:OpenAI'), undefined);

		router.routes.length = 0;
		router.routes.push({ match: (url) => url === FEED.url, handle: () => new Response(rss(INITIAL), { status: 200 }) });

		await processFeed(FEED, env);
		// These are now treated as historical backlog: baselined, never announced.
		assert.equal(router.sent.length, 0);
		assert.ok(kv.store.get('state:v2:OpenAI') !== undefined);
	} finally {
		router.restore();
	}
});

test('zero-item parse after a healthy state is a failure and preserves state', async () => {
	const { kv, router } = setup(rss(INITIAL));
	try {
		const env = makeEnv(kv);
		await processFeed(FEED, env);
		const before = kv.store.get('state:v2:OpenAI');

		router.routes.length = 0;
		router.routes.push({ match: () => true, handle: () => new Response('<html>maintenance</html>', { status: 200 }) });
		await processFeed(FEED, env);

		assert.equal(kv.store.get('state:v2:OpenAI'), before);
		const health = JSON.parse(String(kv.store.get('health:v2:OpenAI')));
		assert.ok(health.failures >= 1);
	} finally {
		router.restore();
	}
});

test('conditional GET: sends If-None-Match and honours 304', async () => {
	const { kv, router } = setup(rss(INITIAL), '"abc123"');
	try {
		const env = makeEnv(kv);
		await processFeed(FEED, env);

		router.routes.length = 0;
		router.routes.push({
			match: (url) => url === FEED.url,
			handle: (_url, init) => {
				const headers = new Headers(init?.headers);
				assert.equal(headers.get('If-None-Match'), '"abc123"');
				return new Response(null, { status: 304 });
			},
		});

		await processFeed(FEED, env);
		assert.equal(router.sent.length, 0);
		const health = JSON.parse(String(kv.store.get('health:v2:OpenAI')));
		assert.equal(health.failures, 0);
	} finally {
		router.restore();
	}
});

test('transient Telegram failure stays retryable (unseen)', async () => {
	const { kv, router } = setup(rss(INITIAL));
	try {
		const env = makeEnv(kv);
		await processFeed(FEED, env);

		router.routes.length = 0;
		router.routes.push({ match: (url) => url === FEED.url, handle: () => new Response(rss([NEW_RELEASE, ...INITIAL]), { status: 200 }) });
		router.telegramMode = 'retry';

		await processFeed(FEED, env);
		assert.ok(router.sent.length >= 1); // the failed attempt(s)
		assert.ok([...kv.store.keys()].every((key) => !key.includes('gpt-7') || key.startsWith('health')), 'failed item must stay unseen');

		router.telegramMode = 'ok';
		await processFeed(FEED, env);
		assert.ok(router.sent.some((msg) => String(msg.text).includes('GPT-7')), 'must succeed on the next run');
	} finally {
		router.restore();
	}
});

test('permanent Telegram rejection is marked seen (loop stopped)', async () => {
	const { kv, router } = setup(rss(INITIAL));
	try {
		const env = makeEnv(kv);
		await processFeed(FEED, env);

		router.routes.length = 0;
		router.routes.push({ match: (url) => url === FEED.url, handle: () => new Response(rss([NEW_RELEASE, ...INITIAL]), { status: 200 }) });
		router.telegramMode = 'give-up';

		await processFeed(FEED, env);
		router.telegramMode = 'ok';
		const attempts = router.sent.length;
		await processFeed(FEED, env);
		assert.equal(router.sent.length, attempts, 'rejected item must not be re-attempted');
	} finally {
		router.restore();
	}
});

test('per-run announcement cap limits flood damage', async () => {
	const backlog = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ title: `Introducing GPT-${90 + n}.0 Ultra`, link: `https://openai.com/index/gpt-${90 + n}` }));
	const { kv, router } = setup(rss([backlog[0]]));
	try {
		const env = makeEnv(kv);
		await processFeed(FEED, env);
		assert.equal(router.sent.length, 0);

		router.routes.length = 0;
		router.routes.push({ match: (url) => url === FEED.url, handle: () => new Response(rss(backlog), { status: 200 }) });
		await processFeed(FEED, env);
		assert.equal(router.sent.length, 3, 'at most 3 announcements per source per run');

		await processFeed(FEED, env);
		assert.equal(router.sent.length, 6, 'remaining candidates surface on subsequent runs');
	} finally {
		router.restore();
	}
});

test('FEEDS registry includes the new high-volume partner feeds', () => {
	const names = FEEDS.map((feed) => feed.name);
	for (const expected of ['OpenAI', 'Google DeepMind', 'Google AI', 'Hugging Face', 'NVIDIA', 'AWS ML']) {
		assert.ok(names.includes(expected), `missing feed: ${expected}`);
	}
});

test('new partner feeds baseline + announce through the real pipeline', async () => {
	for (const feed of FEEDS.filter((f) => ['Hugging Face', 'NVIDIA', 'AWS ML'].includes(f.name))) {
		const kv = new FakeKv();
		const router = createFetchRouter();
		router.routes.push({
			match: (url) => url === feed.url,
			handle: () =>
				new Response(rss([{ title: 'Introducing Falcon ASR', link: 'https://example.com/falcon-asr' }]), { status: 200 }),
		});
		router.install();
		try {
			const env = makeEnv(kv);
			// First run baselines silently.
			await processFeed(feed, env);
			assert.equal(router.sent.length, 0);
			// A genuinely new model release announces exactly once.
			router.routes.length = 0;
			router.routes.push({
				match: (url) => url === feed.url,
				handle: () =>
					new Response(
						rss([
							{ title: 'Introducing Falcon ASR', link: 'https://example.com/falcon-asr' },
							{ title: `Introducing ${feed.name} Ultra 2`, link: 'https://example.com/ultra-2' },
						]),
						{ status: 200 },
					),
			});
			await processFeed(feed, env);
			assert.equal(router.sent.length, 1, `${feed.name} should announce the new release`);
		} finally {
			router.restore();
		}
	}
});

test('POST /run requires Bearer auth and 404s unknown sources', async () => {
	const env = makeEnv(new FakeKv());
	const noAuth = await worker.fetch(new Request('https://radar.test/run', { method: 'POST' }), env);
	assert.equal(noAuth.status, 401);
	const badSource = await worker.fetch(
		new Request('https://radar.test/run?source=nope', {
			method: 'POST',
			headers: { authorization: 'Bearer test-token' },
		}),
		env,
	);
	assert.equal(badSource.status, 404);
});

