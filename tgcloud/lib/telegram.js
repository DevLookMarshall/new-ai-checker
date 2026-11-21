import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { subscribers } from '../schema.js';

export const MINI_APP_URL = 'https://app9270674008.tgcloud.ai/';

export function escapeHtml(text) {
	return String(text || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

export function buildAnnouncementMessage(source, item, analysis = null) {
	const lines = [
		'🚨 <b>AI MODEL RADAR | خبر مدل جدید</b>',
		'',
		`🏢 <b>منبع:</b> ${escapeHtml(source)}`,
		`🧠 <b>عنوان:</b> ${escapeHtml(item.title)}`,
	];

	if (analysis?.titleFa && analysis.titleFa !== item.title) {
		lines.push(`🇮🇷 <b>ترجمه فارسی:</b> ${escapeHtml(analysis.titleFa)}`);
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

	if (item.link) {
		lines.push('', `🔗 ${item.link}`);
	}
	return lines.join('\n');
}

export async function sendHtmlMessage(chatId, text, replyMarkup = undefined) {
	const payload = {
		chat_id: chatId,
		text: text.slice(0, 4096),
		parse_mode: 'HTML',
		link_preview_options: { is_disabled: false },
	};
	if (replyMarkup) {
		payload.reply_markup = replyMarkup;
	}

	try {
		await api.sendMessage(payload);
		return { ok: true };
	} catch (err) {
		const code = err?.code;
		const description = err?.description || err?.message || 'Telegram API error';
		if (code === 403 || code === 400) {
			return { ok: false, action: 'give-up', code, reason: description };
		}
		return { ok: false, action: 'retry', code, reason: description };
	}
}

export async function broadcastAnnouncement(source, item, analysis = null, fallbackChatId = null) {
	const message = buildAnnouncementMessage(source, item, analysis);
	const replyMarkup =
		item.link && /^https?:\/\//i.test(item.link)
			? { inline_keyboard: [[{ text: 'مطالعه خبر اصلی ↗️', url: item.link }]] }
			: undefined;

	const activeSubs = await db
		.select()
		.from(subscribers)
		.where(eq(subscribers.subscribed, true))
		.all();

	const targets = new Set(activeSubs.map((row) => String(row.chatId)));
	if (fallbackChatId !== null && fallbackChatId !== undefined) {
		targets.add(String(fallbackChatId));
	}

	if (targets.size === 0) {
		return { sent: 0, failed: 0, action: 'skip', reason: 'no active subscribers' };
	}

	let sent = 0;
	let failed = 0;
	let lastError = '';

	for (const chatId of targets) {
		const res = await sendHtmlMessage(chatId, message, replyMarkup);
		if (res.ok) {
			sent += 1;
		} else {
			failed += 1;
			lastError = res.reason;
			if (res.code === 403) {
				await db
					.update(subscribers)
					.set({ subscribed: false })
					.where(eq(subscribers.chatId, chatId))
					.run();
			}
		}
	}

	if (sent > 0) {
		return { sent, failed, action: 'sent' };
	}
	return { sent, failed, action: 'give-up', reason: lastError || 'delivery failed' };
}

export async function verifyAndTestChannel(channelRef, sendTest = true) {
	const normalized = String(channelRef || '').trim();
	if (!normalized) {
		throw new Error('شناسه یا یوزرنیم کانال خالی است.');
	}

	const chat = await api.getChat({ chat_id: normalized });
	const canonicalId = String(chat.id);
	const title = chat.title || (chat.username ? `@${chat.username}` : canonicalId);

	if (sendTest) {
		await api.sendMessage({
			chat_id: canonicalId,
			text: [
				'📡 <b>کانال با موفقیت به AI Radar متصل شد!</b>',
				'',
				'از این پس معرفی مدل‌های جدید هوش مصنوعی همراه با <b>ترجمه و تحلیل فارسی</b> به‌صورت خودکار در این کانال منتشر می‌شود.',
			].join('\n'),
			parse_mode: 'HTML',
		});
	}

	return {
		chatId: canonicalId,
		chatType: chat.type || 'channel',
		label: title,
	};
}
