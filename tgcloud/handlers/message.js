import { api } from 'sdk';
import {
	addChannel,
	analyzeCustomInput,
	analyzeReleaseById,
	clearAiConfig,
	ensureSubscriber,
	getDashboardData,
	listChannels,
	removeChannel,
	runRadarScan,
	setAiConfig,
} from '../lib/radar.js';
import { escapeHtml, MINI_APP_URL, sendHtmlMessage } from '../lib/telegram.js';

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

export function formatStatusText(data) {
	const lines = [
		'📊 <b>وضعیت منابع AI Radar</b>',
		'',
		`🩺 منابع سالم: <b>${data.stats.healthySources}/${data.stats.totalSources}</b>`,
		`👥 مشترکین فعال: <b>${data.stats.totalSubscribers}</b>`,
		`📢 کانال‌های متصل: <b>${data.stats.totalChannels}</b>`,
		`🤖 موتور تحلیل: <b>${data.aiConfigured ? escapeHtml(data.aiProvider) : 'مترجم + تحلیلگر داخلی فارسی'}</b>`,
		`🕒 آخرین اسکن: <code>${escapeHtml(data.stats.lastScanAt || 'هنوز انجام نشده')}</code>`,
		'',
	];

	for (const s of data.sources) {
		const icon = !s.initialized ? '⚪' : s.failures > 0 ? '🔴' : '🟢';
		const detail = !s.initialized
			? 'در انتظار اولین اسکن'
			: s.failures > 0
				? `${s.failures} خطا (${escapeHtml(s.lastError || 'unknown')})`
				: `${s.lastCount} آیتم`;
		lines.push(`${icon} <b>${escapeHtml(s.name)}</b> (${s.type}) — ${detail}`);
	}

	return lines.join('\n');
}

export function formatLatestText(data) {
	if (!data.releases || data.releases.length === 0) {
		return '📰 هنوز مدل جدیدی در دیتابیس ثبت نشده است.\n\nبرای اولین اسکن و ثبت خط پایه روی «🔍 بررسی الان» بزنید یا دستور /check را بفرستید.';
	}

	const lines = ['📰 <b>آخرین مدل‌های شناسایی‌شده</b>', ''];
	for (const item of data.releases.slice(0, 8)) {
		const title = escapeHtml(item.titleFa || item.title || item.link);
		const source = escapeHtml(item.source);
		const date = item.pubDate ? ` (${escapeHtml(item.pubDate)})` : '';
		lines.push(`• <b>[${source}]</b> <a href="${escapeHtml(item.link)}">${title}</a>${date}`);
	}
	lines.push('', '💡 برای دریافت ترجمه و تحلیل کامل آخرین مدل، دستور /analyze را بزنید.');
	return lines.join('\n');
}

export function formatAnalysisCard(item) {
	const lines = [
		'🧠 <b>ترجمه و تحلیل فارسی AI Radar</b>',
		'',
		`🏢 <b>منبع:</b> ${escapeHtml(item.source || 'AI Lab')}`,
		`🇬🇧 <b>عنوان اصلی:</b> ${escapeHtml(item.title || '')}`,
		`🇮🇷 <b>ترجمه فارسی:</b> ${escapeHtml(item.titleFa || item.title || '')}`,
	];

	if (item.pubDate) lines.push(`📅 ${escapeHtml(item.pubDate)}`);
	if (item.descriptionFa || item.description) {
		lines.push('', `💬 <b>خلاصه:</b> ${escapeHtml(item.descriptionFa || item.description)}`);
	}
	if (item.analysisFa) {
		lines.push('', '📊 <b>تحلیل تخصصی:</b>', escapeHtml(item.analysisFa));
	}
	if (item.link) {
		lines.push('', `🔗 ${item.link}`);
	}
	return lines.join('\n');
}

export function formatChannelGuide(channels = []) {
	const lines = [
		'📢 <b>مدیریت ارسال خودکار به کانال تلگرام</b>',
		'',
		'برای اینکه اخبار جدید همراه با <b>ترجمه و تحلیل فارسی</b> در کانال شما منتشر شود:',
		'۱. یک کانال بسازید و ربات <b>@realainewsbot</b> را به عنوان <b>Admin</b> (با دسترسی Post Messages) به کانال اضافه کنید.',
		'۲. ربات به‌صورت خودکار کانال را ثبت می‌کند؛ یا می‌توانید دستور زیر را بفرستید:',
		'<code>/channel @YourChannelUsername</code> یا <code>/channel -1001234567890</code>',
	];

	if (channels.length > 0) {
		lines.push('', '✅ <b>کانال‌های متصل فعلی:</b>');
		for (const c of channels) {
			lines.push(`• ${escapeHtml(c.label || c.chatId)} (<code>${escapeHtml(c.chatId)}</code>)`);
		}
		lines.push('', 'برای قطع اتصال یک کانال: <code>/removechannel CHAT_ID</code>');
	} else {
		lines.push('', '⚪ هنوز هیچ کانالی متصل نشده است.');
	}

	return lines.join('\n');
}

export function formatScanSummary(summary) {
	if (summary.throttled) {
		return `⏳ لطفاً <b>${summary.retryInSec} ثانیه</b> دیگر دوباره امتحان کنید.`;
	}

	const lines = [
		'✅ <b>اسکن AI Radar کامل شد</b>',
		'',
		`📡 کل منابع بررسی‌شده: <b>${summary.totalSources}</b>`,
		`🆕 مدل‌های جدید اعلام‌شده: <b>${summary.announcedItems.length}</b>`,
	];

	if (summary.baselined > 0) {
		lines.push(`📌 ثبت خط پایه اولیه (Baseline): <b>${summary.baselined}</b> منبع`);
	}
	if (summary.notModified > 0) {
		lines.push(`⚡ بدون تغییر (304): <b>${summary.notModified}</b> منبع`);
	}
	if (summary.failed > 0) {
		lines.push(`⚠️ خطا در دریافت: <b>${summary.failed}</b> منبع`);
		for (const r of summary.results.filter((x) => x.status === 'failed')) {
			lines.push(`   • ${escapeHtml(r.name)}: <code>${escapeHtml(r.error || 'error')}</code>`);
		}
	}

	if (summary.baselined > 0 && summary.announcedItems.length === 0) {
		lines.push(
			'',
			'ℹ️ <i>در اولین اسکن، مقالات فعلی به‌عنوان خط پایه ذخیره شدند تا اسپم نشوند؛ از اسکن بعدی هر مدل جدید همراه با ترجمه و تحلیل فارسی برای شما و کانال متصل ارسال می‌شود.</i>',
		);
	}

	return lines.join('\n');
}

export default async function (message) {
	if (!message?.chat?.id) return { ignored: true };

	const chatId = message.chat.id;
	const rawText = (message.text || '').trim();
	const parts = rawText.split(/\s+/);
	const cmd = (parts[0] || '').split('@')[0].toLowerCase();
	const argText = rawText.slice((parts[0] || '').length).trim();

	if (cmd === '/start' || cmd === '/subscribe') {
		await ensureSubscriber(message.chat, true);
		try {
			await api.setChatMenuButton({
				chat_id: chatId,
				menu_button: {
					type: 'web_app',
					text: 'AI Radar',
					web_app: { url: MINI_APP_URL },
				},
			});
		} catch {
			// Ignore for group chats.
		}

		const welcome = [
			'📡 <b>به ربات AI Radar خوش آمدید!</b>',
			'',
			'این ربات وبلاگ‌ها و فیدهای ۹ آزمایشگاه اصلی هوش مصنوعی را رصد می‌کند و معرفی <b>مدل‌های جدید واقعی</b> را همراه با <b>ترجمه فارسی و تحلیل تخصصی</b> برای شما و کانال تلگرامتان می‌فرستد:',
			'• OpenAI · Google DeepMind · Google AI',
			'• Anthropic · Meta AI · xAI',
			'• Hugging Face · NVIDIA · AWS ML',
			'',
			'دستورهای سریع:',
			'• /check — اسکن زنده همه منابع',
			'• /analyze — ترجمه و تحلیل فارسی آخرین مدل (یا متن دلخواه)',
			'• /channel — اتصال کانال تلگرام برای ارسال خودکار',
			'• /latest — آخرین مدل‌های شناسایی‌شده',
			'• /status — وضعیت سلامت منابع',
			'• /setai — اتصال اختیاری کلید Gemini یا OpenAI برای تحلیل عمیق‌تر',
		].join('\n');

		await sendHtmlMessage(chatId, welcome, mainKeyboard(true));
		return { ok: true, command: cmd };
	}

	if (cmd === '/stop' || cmd === '/unsubscribe') {
		await ensureSubscriber(message.chat, false);
		await sendHtmlMessage(
			chatId,
			'🔕 اعلان‌های AI Radar برای این گفتگو غیرفعال شد. هر زمان خواستید با /start دوباره فعال کنید.',
			mainKeyboard(false),
		);
		return { ok: true, command: cmd };
	}

	if (cmd === '/status') {
		const data = await getDashboardData(chatId);
		await sendHtmlMessage(chatId, formatStatusText(data), mainKeyboard(data.isSubscribed));
		return { ok: true, command: cmd };
	}

	if (cmd === '/latest') {
		const data = await getDashboardData(chatId);
		await sendHtmlMessage(chatId, formatLatestText(data), mainKeyboard(data.isSubscribed));
		return { ok: true, command: cmd };
	}

	if (cmd === '/analyze') {
		const data = await getDashboardData(chatId);
		if (argText) {
			const res = await analyzeCustomInput(argText);
			await sendHtmlMessage(
				chatId,
				formatAnalysisCard({
					source: 'تحلیل دستی',
					title: argText.split('\n')[0],
					...res,
				}),
				mainKeyboard(data.isSubscribed),
			);
			return { ok: true, command: cmd, mode: 'custom' };
		}

		if (!data.releases || data.releases.length === 0) {
			await sendHtmlMessage(
				chatId,
				'هنوز مدلی در دیتابیس ثبت نشده است. ابتدا /check بزنید یا متن خبر انگلیسی را جلوی دستور بفرستید:\n<code>/analyze Introducing GPT-6 with open weights</code>',
				mainKeyboard(data.isSubscribed),
			);
			return { ok: true, command: cmd, mode: 'empty' };
		}

		const latest = await analyzeReleaseById(data.releases[0].id);
		await sendHtmlMessage(chatId, formatAnalysisCard(latest), mainKeyboard(data.isSubscribed));
		return { ok: true, command: cmd, mode: 'latest' };
	}

	if (cmd === '/channel' || cmd === '/setchannel' || cmd === '/channels') {
		const data = await getDashboardData(chatId);
		if (!argText) {
			const channels = await listChannels();
			await sendHtmlMessage(chatId, formatChannelGuide(channels), mainKeyboard(data.isSubscribed));
			return { ok: true, command: cmd };
		}

		try {
			const added = await addChannel(argText, true);
			await sendHtmlMessage(
				chatId,
				`✅ کانال <b>${escapeHtml(added.label)}</b> (<code>${escapeHtml(added.chatId)}</code>) با موفقیت متصل شد و یک پیام تست در آن ارسال گردید!`,
				mainKeyboard(data.isSubscribed),
			);
			return { ok: true, command: cmd, channel: added.chatId };
		} catch (err) {
			await sendHtmlMessage(
				chatId,
				`❌ اتصال کانال ناموفق بود: <code>${escapeHtml(err?.description || err?.message || 'Error')}</code>\n\nمطمئن شوید ربات <b>@realainewsbot</b> به عنوان <b>Admin</b> با دسترسی ارسال پیام به کانال اضافه شده است.`,
				mainKeyboard(data.isSubscribed),
			);
			return { ok: false, command: cmd };
		}
	}

	if (cmd === '/removechannel') {
		const data = await getDashboardData(chatId);
		if (!argText) {
			await sendHtmlMessage(chatId, 'مثال: <code>/removechannel -1001234567890</code>', mainKeyboard(data.isSubscribed));
			return { ok: true, command: cmd };
		}
		await removeChannel(argText);
		await sendHtmlMessage(chatId, `🔕 اتصال کانال <code>${escapeHtml(argText)}</code> حذف شد.`, mainKeyboard(data.isSubscribed));
		return { ok: true, command: cmd };
	}

	if (cmd === '/setai') {
		const data = await getDashboardData(chatId);
		const [providerRaw, keyRaw] = argText.split(/\s+/);
		const provider = (providerRaw || '').toLowerCase();
		if (!['gemini', 'openai'].includes(provider) || !keyRaw) {
			await sendHtmlMessage(
				chatId,
				'فرمت دستور:\n<code>/setai gemini YOUR_GEMINI_API_KEY</code>\nیا\n<code>/setai openai YOUR_OPENAI_API_KEY</code>\n\nبرای بازگشت به تحلیلگر داخلی رایگان: /clearai',
				mainKeyboard(data.isSubscribed),
			);
			return { ok: true, command: cmd };
		}
		await setAiConfig(provider, keyRaw);
		await sendHtmlMessage(
			chatId,
			`✅ کلید <b>${escapeHtml(provider)}</b> ذخیره شد. از این پس ترجمه و تحلیل فارسی با هوش مصنوعی ${escapeHtml(provider)} انجام می‌شود.`,
			mainKeyboard(data.isSubscribed),
		);
		return { ok: true, command: cmd };
	}

	if (cmd === '/clearai') {
		const data = await getDashboardData(chatId);
		await clearAiConfig();
		await sendHtmlMessage(chatId, '✅ موتور تحلیل به حالت داخلی بدون نیاز به کلید برگشت.', mainKeyboard(data.isSubscribed));
		return { ok: true, command: cmd };
	}

	if (cmd === '/check' || cmd === '/scan') {
		await ensureSubscriber(message.chat, true);
		const sourceArg = argText || null;
		await sendHtmlMessage(chatId, '🔎 در حال بررسی منابع هوش مصنوعی و آماده‌سازی تحلیل فارسی... لطفاً چند ثانیه صبر کنید.');
		const summary = await runRadarScan({ triggerChatId: chatId, onlySource: sourceArg });
		await sendHtmlMessage(chatId, formatScanSummary(summary), mainKeyboard(true));
		return { ok: true, command: cmd, announced: summary.announcedItems?.length ?? 0 };
	}

	if (cmd === '/help') {
		const help = [
			'🤖 <b>راهنمای کامل AI Radar</b>',
			'',
			'/start — عضویت و نمایش منوی اصلی',
			'/check — اسکن دستی تمام منابع هم‌اکنون',
			'/analyze — ترجمه و تحلیل فارسی آخرین مدل (یا متن دلخواه بعد از دستور)',
			'/channel — راهنما و اتصال کانال تلگرام برای ارسال خودکار',
			'/removechannel — قطع اتصال کانال',
			'/latest — نمایش آخرین مدل‌های شناسایی‌شده',
			'/status — وضعیت سلامت منابع و کانال‌ها',
			'/setai — تنظیم اختیاری کلید Gemini یا OpenAI',
			'/stop — توقف دریافت اعلان‌ها',
		].join('\n');
		const data = await getDashboardData(chatId);
		await sendHtmlMessage(chatId, help, mainKeyboard(data.isSubscribed));
		return { ok: true, command: cmd };
	}

	const data = await getDashboardData(chatId);
	await sendHtmlMessage(
		chatId,
		'برای شروع یا مدیریت رادار هوش مصنوعی از دکمه‌های زیر یا دستور /help استفاده کنید:',
		mainKeyboard(data.isSubscribed),
	);
	return { ok: true, command: 'fallback' };
}
