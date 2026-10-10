import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Env } from '../src/config.ts';
import { buildMessage, escapeHtml, sendTelegramMessage } from '../src/telegram.ts';

function envWith(secrets: Partial<Env> = {}): Env {
	return {
		TELEGRAM_BOT_TOKEN: 'test-token',
		TELEGRAM_CHAT_ID: '12345',
		NEW_AI_CHECKER_KV: null as unknown as KVNamespace,
		...secrets,
	};
}

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function mockFetch(handler: FetchHandler): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		return handler(url, init);
	}) as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

test('escapeHtml neutralizes Telegram HTML injection', () => {
	assert.equal(escapeHtml('<b> & "x"'), '&lt;b&gt; &amp; "x"');
});

test('buildMessage escapes the headline and keeps the link', () => {
	const message = buildMessage('OpenAI', {
		title: 'Introducing <b>GPT-6</b> & more',
		link: 'https://openai.com/index/gpt-6',
		pubDate: 'Oct 9, 2026',
		description: 'Our smartest model yet.',
	});

	assert.match(message, /🧠 <b>Introducing &lt;b&gt;GPT-6&lt;\/b&gt; &amp; more<\/b>/);
	assert.match(message, /🔗 https:\/\/openai\.com\/index\/gpt-6/);
	assert.match(message, /📅 Oct 9, 2026/);
	assert.match(message, /💬 Our smartest model yet\./);
});

test('sendTelegramMessage returns ok on a successful call', async () => {
	let body: Record<string, unknown> = {};
	const restore = mockFetch((url, init) => {
		assert.match(url, /api\.telegram\.org\/bottest-token\/sendMessage/);
		body = JSON.parse(String(init?.body));
		return new Response('{"ok":true}', { status: 200 });
	});
	try {
		const result = await sendTelegramMessage(envWith(), 'hello', 'https://example.com/a');
		assert.deepEqual(result, { ok: true });
		assert.equal(body.chat_id, '12345');
		assert.equal(body.parse_mode, 'HTML');
		assert.deepEqual((body.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard, [[{ text: 'Read more →', url: 'https://example.com/a' }]]);
	} finally {
		restore();
	}
});

test('sendTelegramMessage honours 429 retry_after', async () => {
	const restore = mockFetch(() => new Response('{"ok":false,"error_code":429,"parameters":{"retry_after":3}}', { status: 429 }));
	try {
		const result = await sendTelegramMessage(envWith(), 'hello');
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.action, 'retry');
		assert.equal(result.ok === false && result.retryAfterMs, 3000);
	} finally {
		restore();
	}
});

test('sendTelegramMessage classifies 400/403 as permanent (give-up)', async () => {
	const restore = mockFetch(() => new Response('{"ok":false,"error_code":400,"description":"chat not found"}', { status: 400 }));
	try {
		const result = await sendTelegramMessage(envWith(), 'hello');
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.action, 'give-up');
	} finally {
		restore();
	}
});

test('sendTelegramMessage retries on 5xx and on network errors', async () => {
	const restore = mockFetch(() => new Response('oops', { status: 502 }));
	try {
		const result = await sendTelegramMessage(envWith(), 'hello');
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.action, 'retry');
	} finally {
		restore();
	}

	const restore2 = mockFetch(() => {
		throw new TypeError('fetch failed');
	});
	try {
		const result = await sendTelegramMessage(envWith(), 'hello');
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.action, 'retry');
	} finally {
		restore2();
	}
});

test('sendTelegramMessage skips (not retries) when secrets are missing', async () => {
	const result = await sendTelegramMessage(envWith({ TELEGRAM_BOT_TOKEN: '' }), 'hello');
	assert.equal(result.ok, false);
	assert.equal(result.ok === false && result.action, 'skip');
});
