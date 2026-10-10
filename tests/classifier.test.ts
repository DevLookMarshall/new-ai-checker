import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { classifyModelRelease } from '../src/classifier.ts';
import { parseFeed } from '../src/parse.ts';

// Real headlines captured from the live feeds (see tests/fixtures/).
const MUST_MATCH = [
	'GPT-6 and Intelligent UI for everyone',
	'Introducing GPT-6.1 Sol',
	'Introducing dots',
	'Introducing Gemini 3.8 Flash and 3.8 Flash Cyber',
	'Gemini 4 Argon: our next era of frontier intelligence',
	'EmbeddingGemma 2: an open, lightweight multimodal embedding model',
	'Introducing WeatherNext 3, our most advanced and accurate global weather AI model',
	'Introducing Gemma 4 12B: a unified, encoder-free multimodal model',
	'Start building with Nano Banana 2 Lite and Gemini Omni Flash',
	'Claude 4.5 Opus is now available',
	'Introducing Llama 5: open weights for everyone',
];

const MUST_NOT_MATCH = [
	// Case studies / customer stories that merely mention a model.
	'Asana cuts model costs 76x in browser tests with GPT-6.1 Sol',
	'Harvey turns legal context into stronger drafts with GPT-6 Astra',
	'How Oracle turns days of work into minutes with ChatGPT and Codex',
	'LegalOn halves Codex costs while maintaining development speed',
	'Radisson Hotel Group brings hotel discovery into ChatGPT',
	'Sophos cuts threat investigation time by 96% with OpenAI Daybreak',
	'Proaction boosts sales 60% and saves 75+ hours with Codex',
	'Basis completes a tax workbook 2x faster with GPT-6 Astra',
	// Corporate / research / event news.
	'DevDay 2026 Recap',
	'Sam Altman’s remarks at the United Nations Security Council',
	'Google DeepMind and A24 announce first-of-its-kind research partnership',
	'Advancing Private AI Compute with secure, server-side memory',
	'Proactive cyber defense for governments and enterprises',
	'Two years of OpenAI Academy',
	'Investing in multi-agent AI safety research',
];

test('classifies genuine model-release headlines', () => {
	for (const title of MUST_MATCH) {
		const result = classifyModelRelease(title);
		assert.equal(result.matched, true, `expected match for "${title}" (score ${result.score}/${result.threshold}: ${result.reasons.join(', ')})`);
	}
});

test('rejects case studies and corporate news', () => {
	for (const title of MUST_NOT_MATCH) {
		const result = classifyModelRelease(title);
		assert.equal(result.matched, false, `expected NO match for "${title}" (score ${result.score}/${result.threshold}: ${result.reasons.join(', ')})`);
	}
});

function titles(file: string): string[] {
	const xml = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', file), 'utf8');
	return parseFeed(xml).map((item) => item.title);
}

test('live OpenAI fixture: recall on recent posts', () => {
	const recent = titles('openai-rss.xml').slice(0, 40);
	const matched = recent.filter((title) => classifyModelRelease(title).matched);

	// Historical baseline of the old keyword implementation: 1/40.
	assert.ok(matched.length >= 4, `only ${matched.length}/40 OpenAI headlines matched: ${matched.join(' | ')}`);
	assert.ok(matched.some((title) => title.includes('GPT-6')), 'flagship GPT-6 launch must be detected');
});

test('live DeepMind fixture: recall and precision on recent posts', () => {
	const recent = titles('deepmind-rss.xml').slice(0, 20);
	const matched = recent.filter((title) => classifyModelRelease(title).matched);

	// Historical baseline of the old keyword implementation: 7/40 across both feeds.
	assert.ok(matched.length >= 8, `only ${matched.length}/20 DeepMind headlines matched: ${matched.join(' | ')}`);
	assert.ok(matched.some((title) => title.includes('Gemini 4')), 'flagship Gemini 4 launch must be detected');
});
