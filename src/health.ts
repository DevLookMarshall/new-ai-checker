import type { Env } from './config.ts';
import { ALL_SOURCE_NAMES, HEALTH_ALERT_COOLDOWN_MS, HEALTH_FAILURE_ALERT_THRESHOLD } from './config.ts';
import { sendTelegramMessage } from './telegram.ts';

/**
 * Source health tracking + the daily heartbeat.
 *
 * The original project failed silently: a blocked listing page, a feed that
 * changed format, or a missing secret only ever produced a `console.error`.
 * Now every run reports a result, three consecutive failures alert Telegram
 * (with a cooldown), and a once-a-day heartbeat doubles as a dead-man switch —
 * if it stops arriving, the cron itself is broken.
 */

interface HealthState {
	failures: number;
	lastOkAt: string;
	lastCount: number;
	lastError?: string;
	lastAlertAt?: string;
}

const healthKey = (source: string) => `health:v2:${source}`;
const statsKey = (day: string) => `stats:v2:${day}`;
const HEARTBEAT_KEY = 'heartbeat:v2:sent';

async function readHealth(env: Env, source: string): Promise<HealthState | null> {
	const raw = await env.NEW_AI_CHECKER_KV.get(healthKey(source));
	if (!raw) return null;
	try {
		return JSON.parse(raw) as HealthState;
	} catch {
		return null;
	}
}

function todayIso(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

/**
 * Records one source run. `ok` means "we fetched and parsed real content";
 * an empty parse is a failure — that is exactly how a redesigned listing page
 * or an RSS→Atom switch used to kill a source unnoticed.
 */
export async function reportSourceResult(env: Env, source: string, ok: boolean, count: number, note?: string): Promise<void> {
	try {
		const now = new Date().toISOString();
		const state = (await readHealth(env, source)) ?? { failures: 0, lastOkAt: '', lastCount: 0 };

		if (ok && count > 0) {
			const lastOk = state.lastOkAt ? Date.parse(state.lastOkAt) : 0;
			const shouldWrite = state.failures > 0 || !state.lastOkAt || Date.parse(now) - lastOk > 24 * 60 * 60 * 1000;
			if (shouldWrite) {
				const next: HealthState = { failures: 0, lastOkAt: now, lastCount: count };
				await env.NEW_AI_CHECKER_KV.put(healthKey(source), JSON.stringify(next));
			}
			return;
		}

		state.failures += 1;
		state.lastCount = count;
		state.lastError = note ?? 'unknown failure';

		if (state.failures >= HEALTH_FAILURE_ALERT_THRESHOLD) {
			const lastAlert = state.lastAlertAt ? Date.parse(state.lastAlertAt) : 0;
			if (Date.now() - lastAlert > HEALTH_ALERT_COOLDOWN_MS) {
				const sent = await sendTelegramMessage(
					env,
					[
						'⚠️ AI RADAR ALERT',
						'',
						`🏢 <b>${source}</b> has failed ${state.failures} runs in a row`,
						`📝 ${state.lastError}`,
						'',
						'No messages will be missed for sources that recover, but this source is not being checked successfully.',
					].join('\n'),
				);
				if (sent.ok) state.lastAlertAt = new Date().toISOString();
			}
		}

		await env.NEW_AI_CHECKER_KV.put(healthKey(source), JSON.stringify(state));
	} catch (error) {
		console.error(`Failed to record health for ${source}:`, error);
	}
}

/** Called after each successfully delivered announcement; feeds the daily digest. */
export async function recordAnnouncement(env: Env, source: string): Promise<void> {
	try {
		const day = todayIso();
		const current = Number((await env.NEW_AI_CHECKER_KV.get(statsKey(day))) ?? '0');
		await env.NEW_AI_CHECKER_KV.put(statsKey(day), String(current + 1), { expirationTtl: 60 * 60 * 24 * 7 });
		const perSourceKey = `${statsKey(day)}:${source}`;
		const perSource = Number((await env.NEW_AI_CHECKER_KV.get(perSourceKey)) ?? '0');
		await env.NEW_AI_CHECKER_KV.put(perSourceKey, String(perSource + 1), { expirationTtl: 60 * 60 * 24 * 7 });
	} catch (error) {
		console.error('Failed to record announcement:', error);
	}
}

/** Sends at most one heartbeat per calendar day. Safe to call every run. */
export async function maybeSendHeartbeat(env: Env): Promise<void> {
	try {
		const day = todayIso();
		if ((await env.NEW_AI_CHECKER_KV.get(HEARTBEAT_KEY)) === day) return;

		const yesterday = todayIso(new Date(Date.now() - 24 * 60 * 60 * 1000));
		const [yesterdayCount, todayCount] = [
			Number((await env.NEW_AI_CHECKER_KV.get(statsKey(yesterday))) ?? '0'),
			Number((await env.NEW_AI_CHECKER_KV.get(statsKey(day))) ?? '0'),
		];

		const health = await Promise.all(ALL_SOURCE_NAMES.map(async (name) => ({ name, state: await readHealth(env, name) })));
		const failing = health.filter((entry) => (entry.state?.failures ?? 0) >= HEALTH_FAILURE_ALERT_THRESHOLD);
		const healthy = health.length - failing.length;

		const lines = [
			'📡 AI RADAR DAILY HEARTBEAT',
			'',
			`🤖 ${yesterdayCount + todayCount} model announcement(s) in the last 24h`,
			`🩺 Sources healthy: ${healthy}/${health.length}`,
		];

		for (const entry of failing) {
			lines.push(`⚠️ ${entry.name}: ${entry.state?.failures} consecutive failures — ${entry.state?.lastError ?? 'unknown'}`);
		}

		const sent = await sendTelegramMessage(env, lines.join('\n'));
		if (sent.ok) {
			await env.NEW_AI_CHECKER_KV.put(HEARTBEAT_KEY, day, { expirationTtl: 60 * 60 * 24 * 3 });
		}
	} catch (error) {
		console.error('Heartbeat failed:', error);
	}
}
