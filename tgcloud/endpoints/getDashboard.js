import { EndpointError } from 'sdk';
import { getDashboardData } from '../lib/radar.js';

export default async function (_input, ctx) {
	const userId = ctx?.initData?.user?.id;
	if (!userId) {
		throw new EndpointError('Missing Telegram user identity', { code: 'UNAUTHORIZED' });
	}

	return getDashboardData(userId);
}
