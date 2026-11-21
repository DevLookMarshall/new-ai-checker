import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeReleasePersian, buildDeterministicAnalysis } from '../src/analyzer.ts';
import { classifyModelRelease } from '../src/classifier.ts';
import { buildMessage, sendTelegramMessage } from '../src/telegram.ts';
import { createFetchRouter, FakeKv, makeEnv } from './helpers.ts';

test('buildDeterministicAnalysis identifies open-weights and reasoning categories in Persian', () => {
	const item = {
		title: 'Introducing DeepSeek R2: Open-Weights Reasoning Model',
		link: 'https://example.com/deepseek-r2',
		description: 'A fast open-source reasoning model for coding and math.',
	};
	const cls = classifyModelRelease(item.title);
	const analysis = buildDeterministicAnalysis('Hugging Face', item, cls);

	assert.match(analysis, /دسته:/);
	assert.match(analysis, /امکان دانلود وزن‌ها|وزن‌باز/);
	assert.match(analysis, /امتیاز رادار:/);
});

test('analyzeReleasePersian translates title and summary via translation endpoint with fallback', async () => {
	const router = createFetchRouter();
	router.routes.push({
		match: (url) => url.startsWith('https://translate.googleapis.com/'),
		handle: () =>
			new Response(JSON.stringify([[['معرفی GPT-7', 'Introducing GPT-7', null, null, 1]]]), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
	});
	router.install();

	try {
		const res = await analyzeReleasePersian('OpenAI', {
			title: 'Introducing GPT-7',
			link: 'https://openai.com/index/gpt-7',
		});
		assert.equal(res.titleFa, 'معرفی GPT-7');
		assert.equal(res.usedLlm, false);
		assert.match(res.analysisFa, /تحلیل|دسته:/);
	} finally {
		router.restore();
	}
});

test('buildMessage renders Persian translation and analysis cleanly', () => {
	const message = buildMessage(
		'OpenAI',
		{
			title: 'Introducing GPT-7',
			link: 'https://openai.com/index/gpt-7',
			pubDate: 'Nov 21, 2026',
			description: 'Next-gen reasoning model.',
		},
		{
			titleFa: 'معرفی GPT-7',
			descriptionFa: 'مدل استدلالی نسل جدید.',
			analysisFa: '• دسته: مدل زبانی و استدلالی پیشرفته',
			usedLlm: false,
		},
	);

	assert.match(message, /🇮🇷 <b>ترجمه:<\/b> معرفی GPT-7/);
	assert.match(message, /💬 مدل استدلالی نسل جدید\./);
	assert.match(message, /📊 <b>تحلیل رادار:<\/b>/);
});

test('sendTelegramMessage also delivers to TELEGRAM_CHANNEL_ID when configured', async () => {
	const router = createFetchRouter();
	router.install();
	try {
		const env = makeEnv(new FakeKv(), {
			TELEGRAM_CHAT_ID: '111',
			TELEGRAM_CHANNEL_ID: '@my_ai_radar_channel',
		});
		const res = await sendTelegramMessage(env, 'hello channel', 'https://example.com');
		assert.deepEqual(res, { ok: true });
		assert.equal(router.sent.length, 2);
		assert.equal(router.sent[0].chat_id, '111');
		assert.equal(router.sent[1].chat_id, '@my_ai_radar_channel');
	} finally {
		router.restore();
	}
});
