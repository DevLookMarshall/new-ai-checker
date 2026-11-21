import { EndpointError } from 'sdk';
import { ensureSubscriber, getDashboardData, runRadarScan } from '../lib/radar.js';

export default async function (input, ctx) {
	const user = ctx?.initData?.user;
	if (!user?.id) {
		throw new EndpointError('Missing Telegram user identity', { code: 'UNAUTHORIZED' });
	}

	await ensureSubscriber(
		{
			id: user.id,
			type: 'private',
			username: user.username,
			first_name: user.first_name,
			last_name: user.last_name,
		},
		true,
	);

	const onlySource = typeof input?.source === 'string' && input.source.trim() ? input.source.trim() : null;
	const summary = await runRadarScan({
		triggerChatId: user.id,
		onlySource,
		respectCooldown: true,
	});

	if (summary.throttled) {
		throw new EndpointError(`Cooldown active. Try again in ${summary.retryInSec}s`, {
			code: 'COOLDOWN',
			retryInSec: summary.retryInSec,
		});
	}

	const dashboard = await getDashboardData(user.id);
	return { summary, dashboard };
}
