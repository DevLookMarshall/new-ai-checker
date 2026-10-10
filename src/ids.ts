/** Canonical-URL + stable-ID helpers for KV `seen` keys. */

/** Query parameters that identify a click, not a page. */
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_[ceid]$|ref$|ref_src$|igshid$|vero_|pk_|mtm_|yclid$)/i;

/**
 * Normalizes a URL so the same article always produces the same `seen` key:
 * lower-cased host, no fragment, no tracking parameters, no trailing slash.
 * (The old RSS path hashed `link|title`, so an edited headline re-announced
 * the same URL.)
 */
export function canonicalizeUrl(raw: string): string {
	try {
		const url = new URL(raw);
		for (const key of [...url.searchParams.keys()]) {
			if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
		}
		const path = url.pathname.replace(/\/+$/, '');
		const query = url.searchParams.toString();
		return `${url.origin.toLowerCase()}${path}${query ? `?${query}` : ''}`;
	} catch {
		return raw.split('#')[0];
	}
}

async function sha256Hex(data: string): Promise<string> {
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
	return Array.from(new Uint8Array(hash))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/** URL-only identity for both RSS and HTML sourced articles. */
export async function seenKey(link: string): Promise<string> {
	return `seen:${await sha256Hex(canonicalizeUrl(link))}`;
}

/** Used to bound retry attempts on article pages that can never be parsed. */
export async function attemptKey(link: string): Promise<string> {
	return `attempt:${await sha256Hex(canonicalizeUrl(link))}`;
}
