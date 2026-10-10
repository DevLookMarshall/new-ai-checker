import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalizeUrl, seenKey } from '../src/ids.ts';

test('canonicalizeUrl strips fragments, tracking params and trailing slashes', () => {
	assert.equal(canonicalizeUrl('https://OpenAI.com/index/gpt-6/?utm_source=rss&utm_medium=feed#body'), 'https://openai.com/index/gpt-6');
	assert.equal(canonicalizeUrl('https://deepmind.google/blog/gemini-4/'), 'https://deepmind.google/blog/gemini-4');
	assert.equal(canonicalizeUrl('https://example.com/a?fbclid=abc&q=hello'), 'https://example.com/a?q=hello');
	assert.equal(canonicalizeUrl('https://example.com/'), 'https://example.com');
});

test('canonicalizeUrl keeps meaningful query params', () => {
	assert.equal(canonicalizeUrl('https://example.com/post?page=2&utm_campaign=x'), 'https://example.com/post?page=2');
});

test('canonicalizeUrl degrades gracefully on unparseable input', () => {
	assert.equal(canonicalizeUrl('not a url#fragment'), 'not a url');
});

test('seenKey is stable for the same article regardless of noise', async () => {
	const canonical = await seenKey('https://openai.com/index/gpt-6?utm_source=x');
	const noisy = await seenKey('https://openai.com/index/gpt-6/#section');
	assert.equal(canonical, noisy);
	assert.match(canonical, /^seen:[0-9a-f]{64}$/);
});

test('seenKey differs for different articles (URL-only identity)', async () => {
	const a = await seenKey('https://openai.com/index/gpt-6');
	const b = await seenKey('https://openai.com/index/gpt-6-1');
	assert.notEqual(a, b);
});
