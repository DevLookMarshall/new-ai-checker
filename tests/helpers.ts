import type { Env } from '../src/config.ts';

/** Minimal in-memory KVNamespace good enough for pipeline tests. */
export class FakeKv {
	store = new Map<string, string>();
	writes = 0;

	async get(key: string): Promise<string | null> {
		return this.store.get(key) ?? null;
	}

	async put(key: string, value: string, _options?: unknown): Promise<void> {
		this.writes += 1;
		this.store.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}

	async list(): Promise<{ keys: { name: string }[]; list_complete: boolean }> {
		return { keys: [...this.store.keys()].map((name) => ({ name })), list_complete: true };
	}

	bind(): KVNamespace {
		return this as unknown as KVNamespace;
	}
}

export function makeEnv(kv: FakeKv, secrets: Partial<Env> = {}): Env {
	return {
		TELEGRAM_BOT_TOKEN: 'test-token',
		TELEGRAM_CHAT_ID: '42',
		NEW_AI_CHECKER_KV: kv.bind(),
		...secrets,
	};
}

export type TelegramMode = 'ok' | 'give-up' | 'retry' | 'unauthorized';

export interface FetchRecord {
	url: string;
	init?: RequestInit;
}

/** Builds a test fetch router; call `install()` to patch, `restore()` to unpatch. */
export function createFetchRouter(): {
	routes: { match: (url: string) => boolean; handle: (url: string, init?: RequestInit) => Response | Promise<Response> }[];
	requests: FetchRecord[];
	sent: Record<string, unknown>[];
	telegramMode: TelegramMode;
	install(): void;
	restore(): void;
} {
	const original = globalThis.fetch;
	const routes: { match: (url: string) => boolean; handle: (url: string, init?: RequestInit) => Response | Promise<Response> }[] = [];
	const requests: FetchRecord[] = [];
	const sent: Record<string, unknown>[] = [];
	const state = { telegramMode: 'ok' as TelegramMode };

	const router = {
		routes,
		requests,
		sent,
		get telegramMode() {
			return state.telegramMode;
		},
		set telegramMode(mode: TelegramMode) {
			state.telegramMode = mode;
		},
		install() {
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
				requests.push({ url, init });

				if (url.includes('api.telegram.org')) {
					sent.push(JSON.parse(String(init?.body)));
					switch (state.telegramMode) {
						case 'ok':
							return new Response('{"ok":true}', { status: 200 });
						case 'give-up':
							return new Response('{"ok":false,"error_code":400,"description":"chat not found"}', { status: 400 });
						case 'retry':
							return new Response('{"ok":false,"error_code":429,"parameters":{"retry_after":0}}', { status: 429 });
						default:
							return new Response('{"ok":false,"error_code":401,"description":"unauthorized"}', { status: 401 });
					}
				}

				const route = routes.find((candidate) => candidate.match(url));
				if (!route) throw new Error(`no route for ${url}`);
				return route.handle(url, init);
			}) as typeof fetch;
		},
		restore() {
			globalThis.fetch = original;
		},
	};

	return router;
}

export function rss(items: { title: string; link: string }[]): string {
	const body = items
		.map(
			(item) =>
				`<item><title><![CDATA[${item.title}]]></title><link>${item.link}</link><pubDate>Fri, 09 Oct 2026 07:00:00 GMT</pubDate></item>`,
		)
		.join('');
	return `<?xml version="1.0"?><rss version="2.0"><channel><title>Test Feed</title>${body}</channel></rss>`;
}

export const articleHtml = (title: string, description = 'A new model announcement.'): string =>
	`<!doctype html><html><head>
		<meta property="og:title" content="${title}" />
		<meta property="og:description" content="${description}" />
		<meta property="article:published_time" content="2026-10-09T07:00:00Z" />
	</head><body></body></html>`;
