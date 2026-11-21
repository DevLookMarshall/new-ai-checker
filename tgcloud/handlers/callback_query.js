import { api } from 'sdk';
import {
	analyzeReleaseById,
	ensureSubscriber,
	getDashboardData,
	listChannels,
	runRadarScan,
} from '../lib/radar.js';
import { MINI_APP_URL, sendHtmlMessage } from '../lib/telegram.js';
import {
	formatAnalysisCard,
	formatChannelGuide,
	formatLatestText,
	formatScanSummary,
	formatStatusText,
} from './message.js';

function mainKeyboard(isSubscribed = true) {
	return {
		inline_keyboard: [
			[{ text: '📡 باز کردن داشبورد و تحلیل فارسی', web_app: { url: MINI_APP_URL } }],
			[
				{ text: '🔍 بررسی الان (Scan)', callback_data: 'radar:scan' },
				{ text: '🧠 تحلیل آخرین مدل', callback_data: 'radar:analyze' },
			],
			[
				{ text: '📰 آخرین مدل‌ها', callback_data: 'radar:latest' },
				{ text: '📢 تنظیم کانال', callback_data: 'radar:channel' },
			],
			[
				{ text: '📊 وضعیت منابع', callback_data: 'radar:status' },
				{
					text: isSubscribed ? '🔕 لغو اعلان‌ها' : '🔔 فعال‌سازی اعلان‌ها',
					callback_data: isSubscribed ? 'radar:unsub' : 'radar:sub',
				},
			],
		],
	};
}

export default async function (callbackQuery) {
	const data = callbackQuery?.data || '';
	const chat =
		callbackQuery?.message?.chat ||
		(callbackQuery?.from
			? { id: callbackQuery.from.id, type: 'private', first_name: callbackQuery.from.first_name }
			: null);
	if (!chat?.id) return { ignored: true };

	const chatId = chat.id;

	try {
		if (data === 'radar:scan') {
			await api.answerCallbackQuery({
				callback_query_id: callbackQuery.id,
				text: '🔎 اسکن منابع شروع شد...',
			});
			await ensureSubscriber(chat, true);
			const summary = await runRadarScan({ triggerChatId: chatId, respectCooldown: true });
			await sendHtmlMessage(chatId, formatScanSummary(summary), mainKeyboard(true));
			return { ok: true, action: 'scan' };
		}

		if (data === 'radar:analyze') {
			await api.answerCallbackQuery({
				callback_query_id: callbackQuery.id,
				text: '🧠 در حال آماده‌سازی تحلیل فارسی...',
			});
			const dash = await getDashboardData(chatId);
			if (!dash.releases || dash.releases.length === 0) {
				await sendHtmlMessage(
					chatId,
					'هنوز مدلی ثبت نشده است. ابتدا «🔍 بررسی الان» را بزنید.',
					mainKeyboard(dash.isSubscribed),
				);
			} else {
				const latest = await analyzeReleaseById(dash.releases[0].id);
				await sendHtmlMessage(chatId, formatAnalysisCard(latest), mainKeyboard(dash.isSubscribed));
			}
			return { ok: true, action: 'analyze' };
		}

		if (data === 'radar:channel') {
			await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
			const [dash, channels] = await Promise.all([getDashboardData(chatId), listChannels()]);
			await sendHtmlMessage(chatId, formatChannelGuide(channels), mainKeyboard(dash.isSubscribed));
			return { ok: true, action: 'channel' };
		}

		if (data === 'radar:latest') {
			await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
			const dash = await getDashboardData(chatId);
			await sendHtmlMessage(chatId, formatLatestText(dash), mainKeyboard(dash.isSubscribed));
			return { ok: true, action: 'latest' };
		}

		if (data === 'radar:status') {
			await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
			const dash = await getDashboardData(chatId);
			await sendHtmlMessage(chatId, formatStatusText(dash), mainKeyboard(dash.isSubscribed));
			return { ok: true, action: 'status' };
		}

		if (data === 'radar:sub') {
			await ensureSubscriber(chat, true);
			await api.answerCallbackQuery({
				callback_query_id: callbackQuery.id,
				text: '🔔 اعلان‌ها فعال شد!',
			});
			await sendHtmlMessage(chatId, '🔔 اعلان‌های مدل‌های جدید هوش مصنوعی فعال شد.', mainKeyboard(true));
			return { ok: true, action: 'sub' };
		}

		if (data === 'radar:unsub') {
			await ensureSubscriber(chat, false);
			await api.answerCallbackQuery({
				callback_query_id: callbackQuery.id,
				text: '🔕 اعلان‌ها غیرفعال شد.',
			});
			await sendHtmlMessage(chatId, '🔕 اعلان‌ها غیرفعال شد.', mainKeyboard(false));
			return { ok: true, action: 'unsub' };
		}

		await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
		return { ok: true, action: 'noop' };
	} catch (err) {
		try {
			await api.answerCallbackQuery({
				callback_query_id: callbackQuery.id,
				text: 'خطا در پردازش درخواست',
				show_alert: true,
			});
		} catch {
			// Ignore expired callback query
		}
		throw err;
	}
}
