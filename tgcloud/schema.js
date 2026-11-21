import { table, integer, text, boolean, index } from 'sdk/db';

export const sourcesState = table('sources_state', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull().unique(),
	initializedAt: text('initialized_at').notNull(),
	etag: text('etag'),
	lastModified: text('last_modified'),
	lastCount: integer('last_count').default(0),
	failures: integer('failures').default(0),
	lastOkAt: text('last_ok_at'),
	lastError: text('last_error'),
	lastAlertAt: text('last_alert_at'),
});

export const seenItems = table(
	'seen_items',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		urlHash: text('url_hash').notNull().unique(),
		link: text('link').notNull(),
		source: text('source').notNull(),
		title: text('title'),
		pubDate: text('pub_date'),
		description: text('description'),
		titleFa: text('title_fa'),
		descriptionFa: text('description_fa'),
		analysisFa: text('analysis_fa'),
		matched: boolean('matched').default(false),
		announced: boolean('announced').default(false),
		deliveryStatus: text('delivery_status'),
		detectedAt: integer('detected_at').notNull(),
	},
	(t) => ({
		sourceIdx: index('idx_seen_source').on(t.source),
		matchedIdx: index('idx_seen_matched_detected').on(t.matched, t.detectedAt),
	}),
);

export const articleAttempts = table('article_attempts', {
	urlHash: text('url_hash').primaryKey(),
	attempts: integer('attempts').default(0),
	updatedAt: integer('updated_at').notNull(),
});

export const subscribers = table('subscribers', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	chatId: text('chat_id').notNull().unique(),
	chatType: text('chat_type').default('private'),
	label: text('label'),
	subscribed: boolean('subscribed').default(true),
	createdAt: integer('created_at').notNull(),
});

export const meta = table('meta', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
});
