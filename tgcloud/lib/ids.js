const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_[ceid]$|ref$|ref_src$|igshid$|vero_|pk_|mtm_|yclid$)/i;

/**
 * Pure-string URL canonicalizer (tgcloud V8 isolate does not expose global `URL`).
 */
export function canonicalizeUrl(raw) {
	const withoutHash = String(raw || '').split('#')[0].trim();
	const match = withoutHash.match(/^(https?:\/\/[^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/i);
	if (!match) return withoutHash;

	const origin = match[1].toLowerCase();
	const path = (match[2] || '').replace(/\/+$/, '');
	const rawQuery = match[3] ? match[3].slice(1) : '';

	if (!rawQuery) {
		return `${origin}${path}`;
	}

	const kept = [];
	for (const part of rawQuery.split('&')) {
		if (!part) continue;
		const eqIdx = part.indexOf('=');
		const key = eqIdx === -1 ? part : part.slice(0, eqIdx);
		let decodedKey = key;
		try {
			decodedKey = decodeURIComponent(key);
		} catch {
			// keep raw key
		}
		if (!TRACKING_PARAM.test(decodedKey)) {
			kept.push(part);
		}
	}

	return `${origin}${path}${kept.length > 0 ? `?${kept.join('&')}` : ''}`;
}

export async function sha256Hex(data) {
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
	return Array.from(new Uint8Array(hash))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

export async function urlHash(link) {
	return sha256Hex(canonicalizeUrl(link));
}
