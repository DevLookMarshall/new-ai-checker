import { ensureSubscriber } from '../lib/radar.js';
import { escapeHtml, sendHtmlMessage } from '../lib/telegram.js';

export default async function (myChatMember) {
	const chat = myChatMember?.chat;
	if (!chat?.id) return { ignored: true };

	const status = myChatMember?.new_chat_member?.status;
	const active = status === 'administrator' || status === 'member';

	if (chat.type === 'channel' || chat.type === 'group' || chat.type === 'supergroup') {
		await ensureSubscriber(chat, active);

		const actorId = myChatMember?.from?.id;
		const title = escapeHtml(chat.title || chat.username || String(chat.id));
		if (actorId) {
			if (active) {
				await sendHtmlMessage(
					actorId,
					[
						`📢 <b>کانال/گروه «${title}» به AI Radar متصل شد!</b>`,
						'',
						`شناسه: <code>${escapeHtml(String(chat.id))}</code>`,
						'از این پس خبرهای جدید مدل‌های هوش مصنوعی همراه با <b>ترجمه فارسی و تحلیل تخصصی</b> به‌صورت خودکار در این کانال ارسال می‌شود.',
						'',
						'💡 برای ارسال خودکار هر ۵ دقیقه، کافیست در Cloudflare Worker هم متغیر <code>TELEGRAM_CHANNEL_ID</code> یا <code>TELEGRAM_CHAT_ID</code> را روی همین شناسه تنظیم کنید.',
					].join('\n'),
				);
			} else {
				await sendHtmlMessage(
					actorId,
					`🔕 دسترسی ربات در «${title}» برداشته شد و ارسال خودکار به آن متوقف گردید.`,
				);
			}
		}
		return { ok: true, chatId: String(chat.id), active };
	}

	return { ignored: true };
}
