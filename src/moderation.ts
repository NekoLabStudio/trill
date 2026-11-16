// Players' tools against abuse, and the operator's: reports about a player someone played with
// (reviewed by the operator, kept for 90 days), blocks (never matched with, never let into the
// blocker's lobbies) and bans from multiplayer (set by the operator with `npm run moderate`, or
// automatic: after repeated removals for cheating, AUTO_BAN, or enough players' reports,
// REPORT_RULES, which can also reset a player's name). Reports and blocks only ever name players met
// in a lobby, so they go through the lobby.

import { resetDisplayName } from "./accounts";
import type { Env, ReportRule } from "./env";
import { HttpError } from "./http";
import { DAY, now } from "./time";

export const REPORT_REASONS = ["cheating", "abuse", "name", "other"] as const;
const MAX_DETAILS = 500;
const MAX_BLOCKED_LISTED = 200;

export async function requireNotBanned(env: Env, accountId: string): Promise<void> {
	const row = await env.DB.prepare("SELECT banned_until FROM accounts WHERE id = ?").bind(accountId).first<{ banned_until: number }>();
	if (row && row.banned_until > now()) {
		throw new HttpError(403, "banned", "This account can't play online for now.", { banned_until: row.banned_until });
	}
}

// A report from a player, or (automatic) from a lobby's anti-cheat, which REPORT_RULES leave out
// as AUTO_BAN already counts those removals.
export async function report(env: Env, game: string, reporterId: string, reportedId: string, reason: unknown, details: unknown, automatic = false): Promise<void> {
	if (reporterId === reportedId || typeof reason !== "string" || !(REPORT_REASONS as readonly string[]).includes(reason)) {
		return;
	}
	const text = typeof details === "string" ? details.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, MAX_DETAILS) : "";
	await env.DB.prepare("INSERT INTO reports (id, game, reporter_id, reported_id, reason, details, automatic, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(crypto.randomUUID(), game, reporterId, reportedId, reason, text, automatic ? 1 : 0, now())
		.run();
	if (!automatic) {
		await applyReportRules(env, reportedId, reason);
	}
}

// Whether a rule's reports about this player now come from enough different players. Each player
// counts once however often they report, accounts newer than min_reporter_age_days don't count
// (so one person can't make several to report with), and reports already acted on don't count
// again. When the rule is met, its reports are marked as acted on.
async function reportRuleMet(env: Env, rule: ReportRule | undefined, reportedId: string, reason: string): Promise<boolean> {
	if (!rule || !Array.isArray(rule.reasons) || !rule.reasons.includes(reason) || !(rule.reporters > 0)) {
		return false;
	}
	const time = now();
	const reasons = JSON.stringify(rule.reasons);
	const counted = await env.DB.prepare(
		`SELECT COUNT(DISTINCT reports.reporter_id) AS n FROM reports JOIN accounts ON accounts.id = reports.reporter_id
		 WHERE reports.reported_id = ?1 AND reports.reason IN (SELECT value FROM json_each(?2))
		   AND reports.automatic = 0 AND reports.actioned = 0 AND reports.created_at > ?3 AND accounts.created_at <= ?4`,
	)
		.bind(reportedId, reasons, time - rule.within_days * DAY, time - (rule.min_reporter_age_days ?? 0) * DAY)
		.first<{ n: number }>();
	if ((counted?.n ?? 0) < rule.reporters) {
		return false;
	}
	await env.DB.prepare("UPDATE reports SET actioned = 1 WHERE reported_id = ? AND reason IN (SELECT value FROM json_each(?)) AND automatic = 0 AND actioned = 0")
		.bind(reportedId, reasons)
		.run();
	return true;
}

async function applyReportRules(env: Env, reportedId: string, reason: string): Promise<void> {
	const rules = env.REPORT_RULES;
	if (await reportRuleMet(env, rules?.rename, reportedId, reason)) {
		await resetDisplayName(env, reportedId);
	}
	if (rules?.ban && (await reportRuleMet(env, rules.ban, reportedId, reason))) {
		await autoBan(env, reportedId, rules.ban.ban_days);
	}
}

export async function block(env: Env, accountId: string, blockedId: string): Promise<void> {
	if (accountId !== blockedId) {
		await env.DB.prepare("INSERT OR IGNORE INTO blocks (account_id, blocked_id, created_at) VALUES (?, ?, ?)").bind(accountId, blockedId, now()).run();
	}
}

// Everyone this player blocked or was blocked by: never matched together.
export async function blockedEitherWay(env: Env, accountId: string): Promise<string[]> {
	const rows = await env.DB.prepare(
		`SELECT blocked_id AS id FROM blocks WHERE account_id = ?1
		 UNION SELECT account_id AS id FROM blocks WHERE blocked_id = ?1 LIMIT ?2`,
	)
		.bind(accountId, MAX_BLOCKED_LISTED)
		.all<{ id: string }>();
	return rows.results.map((row) => row.id);
}

// The players who blocked this one, who won't let them into their lobbies.
export async function blockedBy(env: Env, accountId: string): Promise<string[]> {
	const rows = await env.DB.prepare("SELECT account_id FROM blocks WHERE blocked_id = ? LIMIT ?").bind(accountId, MAX_BLOCKED_LISTED).all<{ account_id: string }>();
	return rows.results.map((row) => row.account_id);
}

// Forever, for a ban with no end: the year 3000.
const FOREVER = 32_503_680_000;

// A lobby removed this player for cheating. With AUTO_BAN set, enough of these within its window
// ban the player from multiplayer, each ban longer than the last (the last length repeats; null
// is forever). A ban starts the count again.
export async function recordCheatKick(env: Env, accountId: string, game: string): Promise<void> {
	const time = now();
	await env.DB.prepare("INSERT INTO cheat_kicks (account_id, game, at) VALUES (?, ?, ?)").bind(accountId, game, time).run();
	const rule = env.AUTO_BAN;
	if (!rule || !Array.isArray(rule.ban_days) || rule.ban_days.length === 0) {
		return;
	}
	const since = time - rule.within_days * DAY;
	const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM cheat_kicks WHERE account_id = ? AND at > ?").bind(accountId, since).first<{ n: number }>();
	if ((recent?.n ?? 0) < rule.kicks) {
		return;
	}
	await autoBan(env, accountId, rule.ban_days);
}

// An automatic ban, its length from the account's count of automatic bans (whatever caused them):
// ban_days[n] days for the nth, the last repeating, null for forever. Starts the cheating count
// again.
async function autoBan(env: Env, accountId: string, banDays: (number | null)[]): Promise<void> {
	if (!Array.isArray(banDays) || banDays.length === 0) {
		return;
	}
	const account = await env.DB.prepare("SELECT auto_bans FROM accounts WHERE id = ?").bind(accountId).first<{ auto_bans: number }>();
	const length = banDays[Math.min(account?.auto_bans ?? 0, banDays.length - 1)];
	const until = length === null ? FOREVER : now() + length * DAY;
	await env.DB.batch([
		env.DB.prepare("UPDATE accounts SET banned_until = MAX(banned_until, ?), auto_bans = auto_bans + 1 WHERE id = ?").bind(until, accountId),
		env.DB.prepare("DELETE FROM cheat_kicks WHERE account_id = ?").bind(accountId),
	]);
}
