import { EndpointError } from 'sdk';
import { ensureSubscriber, getDashboardData } from '../lib/radar.js';

export default async function (input, ctx) {
	const user = ctx?.initData?.user;
	if (!user?.id) {
		throw new EndpointError('Missing Telegram user identity', { code: 'UNAUTHORIZED' });
	}

	const desired = Boolean(input?.subscribed);
	await ensureSubscriber(
		{
			id: user.id,
			type: 'private',
			username: user.username,
			first_name: user.first_name,
			last_name: user.last_name,
		},
		desired,
	);

	return getDashboardData(user.id);
}
