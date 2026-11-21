/**
 * Shared types, tuning constants and the source registry.
 *
 * Everything that used to live at the top of index.ts lives here so tests can
 * import the real production configuration without pulling in the Worker entry.
 */

export interface Env {
	TELEGRAM_BOT_TOKEN: string;
	TELEGRAM_CHAT_ID: string;
	TELEGRAM_CHANNEL_ID?: string;
	GEMINI_API_KEY?: string;
	OPENAI_API_KEY?: string;
	NEW_AI_CHECKER_KV: KVNamespace;
}

export interface FeedItem {
	title: string;
	link: string;
	/** Human-readable display date — parseFeed() normalizes raw pubDate values. */
	pubDate?: string;
	/** Short plain-text summary when the source provides one (excerpt for Telegram). */
	description?: string;
}

export interface FeedSource {
	name: string;
	url: string;
}

export interface HtmlSource {
	name: string;
	url: string;
	baseUrl: string;
	linkPattern: RegExp;
}

export const USER_AGENT = 'Mozilla/5.0 (compatible; AI-Radar/2.0)';
export const FETCH_TIMEOUT_MS = 15_000;

/**
 * Baseline/`seen` entries must outlive every article that can still sit in a
 * source's "recent" window. DeepMind's top-20 spans ~100 days, so the previous
 * 30-day TTL expired entries while the articles were still listed — which
 * re-announced them. One year is comfortably longer than any feed window while
 * still bounding KV growth.
 */
export const SEEN_TTL_SECONDS = 60 * 60 * 24 * 365;

export const MAX_ITEMS_PER_SOURCE = 20;
export const MAX_BASELINE_ITEMS = 100;

/** Flood guard: never announce more than this many items per source per run. */
export const MAX_ANNOUNCEMENTS_PER_RUN = 3;

/** Upper bound on honouring Telegram's `retry_after` inside one invocation. */
export const TELEGRAM_MAX_RETRY_DELAY_MS = 5_000;

/** Send an ops alert after this many consecutive failed runs for one source. */
export const HEALTH_FAILURE_ALERT_THRESHOLD = 3;
/** Don't re-alert for the same source more often than this. */
export const HEALTH_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * State keys are versioned: bumping this forces a silent one-time re-baseline
 * (current items marked seen with the corrected TTL, no messages sent) instead
 * of inheriting stale 30-day entries from an older deployment.
 */
export const STATE_VERSION = 'v2';

// Only genuine RSS/Atom endpoints belong here. HTML pages must use HTML_SOURCES instead:
// parsing an HTML page with parseFeed() silently yields zero items — and run-time guards
// in sources.ts now alert when that happens.
export const FEEDS: FeedSource[] = [
	{ name: 'OpenAI', url: 'https://openai.com/news/rss.xml' },
	{ name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml' },
	{ name: 'Google AI', url: 'https://blog.google/technology/ai/rss/' },
	// High-volume partner/community feeds — the classifier keeps them quiet
	// unless a headline is shaped like a genuine model launch.
	{ name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml' },
	{ name: 'NVIDIA', url: 'https://blogs.nvidia.com/feed/' },
	{ name: 'AWS ML', url: 'https://aws.amazon.com/blogs/machine-learning/feed/' },
];

// Companies that expose no usable RSS feed. Each listing page is scraped for article links,
// then each *unseen* article is fetched for its og:title / JSON-LD metadata.
export const HTML_SOURCES: HtmlSource[] = [
	{
		name: 'Anthropic',
		url: 'https://www.anthropic.com/news',
		baseUrl: 'https://www.anthropic.com',
		linkPattern: /href="((?:https?:\/\/(?:www\.)?anthropic\.com)?\/news\/[^"#]+)"/g,
	},
	{
		name: 'Meta AI',
		url: 'https://ai.meta.com/blog',
		baseUrl: 'https://ai.meta.com',
		linkPattern: /href="((?:https?:\/\/(?:www\.)?ai\.meta\.com)?\/blog\/[^"#]+)"/g,
	},
	{
		name: 'xAI',
		url: 'https://x.ai/news',
		baseUrl: 'https://x.ai',
		linkPattern: /href="((?:https?:\/\/(?:www\.)?x\.ai)?\/news\/[^"#]+)"/g,
	},
];

export const ALL_SOURCE_NAMES: string[] = [...FEEDS.map((feed) => feed.name), ...HTML_SOURCES.map((source) => source.name)];
