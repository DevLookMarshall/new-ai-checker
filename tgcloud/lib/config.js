export const USER_AGENT = 'Mozilla/5.0 (compatible; AI-Radar/2.0)';

export const MAX_ITEMS_PER_SOURCE = 20;
export const MAX_BASELINE_ITEMS = 100;
export const MAX_ANNOUNCEMENTS_PER_RUN = 3;
export const MAX_ARTICLE_ATTEMPTS = 3;

export const HEALTH_FAILURE_ALERT_THRESHOLD = 3;
export const HEALTH_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
export const MINIAPP_SCAN_COOLDOWN_MS = 60 * 1000;

export const FEEDS = [
	{ name: 'OpenAI', url: 'https://openai.com/news/rss.xml' },
	{ name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml' },
	{ name: 'Google AI', url: 'https://blog.google/technology/ai/rss/' },
	{ name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml' },
	{ name: 'NVIDIA', url: 'https://blogs.nvidia.com/feed/' },
	{ name: 'AWS ML', url: 'https://aws.amazon.com/blogs/machine-learning/feed/' },
];

export const HTML_SOURCES = [
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

export const ALL_SOURCE_NAMES = [
	...FEEDS.map((feed) => feed.name),
	...HTML_SOURCES.map((source) => source.name),
];
