import { EndpointError } from 'sdk';
import { addChannel, getDashboardData, removeChannel } from '../lib/radar.js';

export default async function (input, ctx) {
	const userId = ctx?.initData?.user?.id;
	if (!userId) {
		throw new EndpointError('Missing Telegram user identity', { code: 'UNAUTHORIZED' });
	}

	const action = String(input?.action || '').trim();
	const channel = String(input?.channel || '').trim();

	if (action === 'add') {
		if (!channel) {
			throw new EndpointError('شناسه یا یوزرنیم کانال را وارد کنید (مثلاً @my_channel).', {
				code: 'INVALID_CHANNEL',
			});
		}
		try {
			const added = await addChannel(channel, true);
			const dashboard = await getDashboardData(userId);
			return { added, dashboard };
		} catch (err) {
			throw new EndpointError(
				err?.description || err?.message || 'ربات نتوانست به کانال پیام بفرستد. مطمئن شوید ربات ادمین کانال است.',
				{ code: 'CHANNEL_ACCESS_FAILED' },
			);
		}
	}

	if (action === 'remove') {
		if (!channel) {
			throw new EndpointError('شناسه کانال مشخص نشده است.', { code: 'INVALID_CHANNEL' });
		}
		await removeChannel(channel);
		const dashboard = await getDashboardData(userId);
		return { removed: channel, dashboard };
	}

	throw new EndpointError('Unsupported channel action', { code: 'INVALID_ACTION' });
}
