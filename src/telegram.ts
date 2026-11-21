import type { PersianAnalysis } from './analyzer.ts';
import type { Env, FeedItem } from './config.ts';
import { TELEGRAM_MAX_RETRY_DELAY_MS } from './config.ts';

/**
 * `action` tells the caller what to do with the item being announced:
 *   retry    — transient failure (429/5xx/network); leave un-seen so the next run retries.
 *   give-up  — permanent rejection (400/403/404); the item is marked seen so a single
 *              unfixable message can't retry every run forever.
 *   skip     — local misconfiguration (missing secret); leave un-seen, fix the config.
 */
export type TelegramSendResult = { ok: true } | { ok: false; action: 'retry' | 'give-up' | 'skip'; reason: string; retryAfterMs?: number };

export function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildMessage(source: string, item: FeedItem, analysis?: PersianAnalysis): string {
	const lines = ['🚨 AI MODEL RADAR', '', `🏢 <b>${escapeHtml(source)}</b>`, `🧠 <b>${escapeHtml(item.title)}</b>`];

	if (analysis?.titleFa && analysis.titleFa !== item.title) {
		lines.push(`🇮🇷 <b>ترجمه:</b> ${escapeHtml(analysis.titleFa)}`);
	}
	if (item.pubDate) lines.push(`📅 ${escapeHtml(item.pubDate)}`);
	if (analysis?.descriptionFa) {
		lines.push(`💬 ${escapeHtml(analysis.descriptionFa)}`);
	} else if (item.description) {
		lines.push(`💬 ${escapeHtml(item.description)}`);
	}
	if (analysis?.analysisFa) {
		lines.push('', '📊 <b>تحلیل رادار:</b>', escapeHtml(analysis.analysisFa));
	}

	lines.push('', `🔗 ${item.link}`);

	return lines.join('\n');
}

async function sendToChatId(botToken: string, chatId: string, message: string, link?: string): Promise<TelegramSendResult> {
	const payload: Record<string, unknown> = {
		chat_id: chatId,
		text: message.slice(0, 4096),
		parse_mode: 'HTML',
		link_preview_options: { is_disabled: false },
	};
	if (link && /^https?:\/\//i.test(link)) {
		payload.reply_markup = { inline_keyboard: [[{ text: 'Read more →', url: link }]] };
	}

	try {
		const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(15_000),
		});

		const body = await response.text();
		let parsed: { ok?: boolean; error_code?: number; description?: string; parameters?: { retry_after?: number } } | null = null;
		try {
			parsed = JSON.parse(body);
		} catch {
			// Non-JSON body (HTML error page) — fall back to the HTTP status.
		}

		const errorCode = parsed?.error_code ?? response.status;

		if (response.ok && parsed?.ok !== false) return { ok: true };

		if (errorCode === 429) {
			const retryAfterMs = Math.min((parsed?.parameters?.retry_after ?? 2) * 1000, TELEGRAM_MAX_RETRY_DELAY_MS);
			return { ok: false, action: 'retry', reason: parsed?.description ?? 'rate limited', retryAfterMs };
		}

		if (errorCode >= 500 || response.status >= 500) {
			return { ok: false, action: 'retry', reason: parsed?.description ?? `HTTP ${response.status}` };
		}

		if (errorCode === 400 || errorCode === 403 || errorCode === 404) {
			return { ok: false, action: 'give-up', reason: parsed?.description ?? `HTTP ${response.status}` };
		}

		return { ok: false, action: 'retry', reason: parsed?.description ?? `HTTP ${response.status}` };
	} catch (error) {
		return { ok: false, action: 'retry', reason: error instanceof Error ? error.message : String(error) };
	}
}

export async function sendTelegramMessage(env: Env, message: string, link?: string): Promise<TelegramSendResult> {
	const targets = [env.TELEGRAM_CHAT_ID, env.TELEGRAM_CHANNEL_ID]
		.map((v) => v?.trim())
		.filter((v): v is string => Boolean(v));
	const uniqueTargets = [...new Set(targets)];

	if (!env.TELEGRAM_BOT_TOKEN || uniqueTargets.length === 0) {
		return { ok: false, action: 'skip', reason: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID is not set' };
	}

	let primaryResult: TelegramSendResult | null = null;
	for (const chatId of uniqueTargets) {
		const res = await sendToChatId(env.TELEGRAM_BOT_TOKEN, chatId, message, link);
		if (!primaryResult) primaryResult = res;
		if (!res.ok && primaryResult.ok) {
			console.error(`Telegram secondary target (${chatId}) failed: ${res.reason}`);
		}
	}

	return primaryResult ?? { ok: false, action: 'skip', reason: 'no target chat configured' };
}
