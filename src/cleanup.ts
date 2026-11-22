// The daily cleanup (a Cron Trigger): lapsed device grants, accounts unused for
// INACTIVE_ACCOUNT_DAYS (with their saves), accounts left with neither identity nor grant,
// spent email codes, and players' and crash reports older than 90 days. Discarded saves are deleted by the R2 lifecycle rule on discarded/ instead.

import type { Env } from "./env";
import { deleteAccount } from "./accounts";
import { CRASH_REPORT_DAYS } from "./crash_reports";
import { now, DAY } from "./time";

// Accounts deleted per run at most: each deletion lists and deletes its saves, and a run that ran
// out of time partway would leave saves behind with their account gone. The rest go the next day.
export const MAX_ACCOUNTS_PER_RUN = 200;

export async function cleanUp(env: Env): Promise<{ grants: number; accounts: number; codes: number }> {
	const time = now();
	const grants = await env.DB.prepare("DELETE FROM device_grants WHERE last_used_at < ?").bind(time - env.DEVICE_GRANT_DAYS * DAY).run();
	const codes = await env.DB.prepare("DELETE FROM email_codes WHERE expires_at <= ?").bind(time).run();
	// Reports are for the operator to act on soon; after 90 days they go.
	await env.DB.prepare("DELETE FROM reports WHERE created_at < ?").bind(time - 90 * DAY).run();
	// Crash reports, and crashes nobody has had for as long.
	await env.DB.prepare("DELETE FROM crash_reports WHERE created_at < ?").bind(time - CRASH_REPORT_DAYS * DAY).run();
	await env.DB.prepare("DELETE FROM crash_groups WHERE last_seen_at < ?").bind(time - CRASH_REPORT_DAYS * DAY).run();
	// Removals for cheating only count within AUTO_BAN's window.
	await env.DB.prepare("DELETE FROM cheat_kicks WHERE at < ?").bind(time - (env.AUTO_BAN?.within_days ?? 0) * DAY).run();
	// Bans kept from deleted accounts, once they've ended.
	await env.DB.prepare("DELETE FROM banned_identities WHERE banned_until <= ?").bind(time).run();
	// An address's counts, once its day is over (kept until then, as they still limit it).
	await env.DB.prepare("DELETE FROM email_limits WHERE day_started_at <= ?1 AND last_sent_at <= ?1").bind(time - DAY).run();
	// Ownership proven long ago no longer counts (ownership.ts) and is proven again at sign-in.
	await env.DB.prepare("DELETE FROM ownership WHERE checked_at < ?").bind(time - 30 * DAY).run();
	await env.DB.prepare("DELETE FROM ownership_proofs WHERE seen_at < ?").bind(time - 30 * DAY).run();
	await env.DB.prepare("DELETE FROM ownership_challenges WHERE expires_at < ?").bind(time).run();
	await env.DB.prepare("DELETE FROM turn_credentials WHERE day_started_at < ?").bind(time - DAY).run();

	const expired = await env.DB.prepare(
		`SELECT id FROM accounts
		 WHERE last_seen_at < ?1
		    OR (NOT EXISTS (SELECT 1 FROM identities WHERE account_id = accounts.id)
		        AND NOT EXISTS (SELECT 1 FROM device_grants WHERE account_id = accounts.id))
		 LIMIT ?2`,
	)
		.bind(time - env.INACTIVE_ACCOUNT_DAYS * DAY, MAX_ACCOUNTS_PER_RUN)
		.all<{ id: string }>();
	for (const account of expired.results) {
		await deleteAccount(env, account.id);
	}
	return { grants: grants.meta.changes, accounts: expired.results.length, codes: codes.meta.changes };
}
