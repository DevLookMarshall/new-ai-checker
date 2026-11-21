import { EndpointError } from 'sdk';
import { analyzeCustomInput, analyzeReleaseById } from '../lib/radar.js';

export default async function (input, ctx) {
	const userId = ctx?.initData?.user?.id;
	if (!userId) {
		throw new EndpointError('Missing Telegram user identity', { code: 'UNAUTHORIZED' });
	}

	if (input?.id !== undefined && input?.id !== null) {
		const item = await analyzeReleaseById(Number(input.id));
		if (!item) {
			throw new EndpointError('Release item not found', { code: 'NOT_FOUND' });
		}
		return { item };
	}

	const rawText = typeof input?.text === 'string' ? input.text.trim() : '';
	if (!rawText) {
		throw new EndpointError('Provide release id or text to analyze', { code: 'INVALID_INPUT' });
	}

	const result = await analyzeCustomInput(rawText);
	return { custom: result };
}
