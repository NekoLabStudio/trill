// Accounts: created on first sign-in, deleted by the player or by the daily cleanup. Deleting one
// removes its identities and grants (by cascade) and its saves.

import type { Env } from "./env";
import { HttpError } from "./http";
import { deleteAllSaves } from "./saves";
import { now } from "./time";

export interface Account {
	id: string;
	display_name: string;
	name_chosen: number;
	created_at: number;
	last_seen_at: number;
}

// Display names are shown to other players (in lobbies, for one): no control or direction
// characters, no surrounding space, and at most MAX_NAME_LENGTH characters (a platform's name
// is cut to that; a chosen one must fit).
export const MAX_NAME_LENGTH = 24;
// Shown for a player with no name, such as one whose name was reset.
export const DEFAULT_NAME = "Player";

export function cleanName(name: string): string {
	return [...name.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").trim()].slice(0, MAX_NAME_LENGTH).join("").trim();
}

// A name a person typed for themselves (chosen) is kept; a platform's is replaced at sign-in
// until they choose one.
export async function createAccount(env: Env, displayName: string, chosen = false): Promise<Account> {
	const time = now();
	const name = cleanName(displayName);
	const account: Account = { id: crypto.randomUUID(), display_name: name, name_chosen: chosen && name ? 1 : 0, created_at: time, last_seen_at: time };
	await env.DB.prepare("INSERT INTO accounts (id, display_name, name_chosen, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
		.bind(account.id, account.display_name, account.name_chosen, account.created_at, account.last_seen_at)
		.run();
	return account;
}

export async function findAccount(env: Env, id: string): Promise<Account | null> {
	return env.DB.prepare("SELECT id, display_name, name_chosen, created_at, last_seen_at FROM accounts WHERE id = ?").bind(id).first<Account>();
}

// A platform's name for the player, at sign-in: used until the player chooses their own.
export async function setDisplayName(env: Env, id: string, displayName: string): Promise<void> {
	const name = cleanName(displayName);
	if (name) {
		await env.DB.prepare("UPDATE accounts SET display_name = ? WHERE id = ? AND name_chosen = 0").bind(name, id).run();
	}
}

// The name the player chose, kept whatever platform they sign in with.
export async function chooseDisplayName(env: Env, id: string, displayName: unknown): Promise<{ display_name: string; name_chosen: true }> {
	const name = typeof displayName === "string" ? cleanName(displayName) : "";
	if (!name || (typeof displayName === "string" && [...displayName.trim()].length > MAX_NAME_LENGTH)) {
		throw new HttpError(400, "bad_name", `A name is 1 to ${MAX_NAME_LENGTH} characters.`);
	}
	await env.DB.prepare("UPDATE accounts SET display_name = ?, name_chosen = 1 WHERE id = ?").bind(name, id).run();
	return { display_name: name, name_chosen: true };
}

// Clears a name other players objected to. A platform's name comes back at the next sign-in;
// otherwise the game asks the player to choose a new one.
export async function resetDisplayName(env: Env, id: string): Promise<void> {
	await env.DB.prepare("UPDATE accounts SET display_name = '', name_chosen = 0 WHERE id = ?").bind(id).run();
}

// The row goes first, which ends its sessions and grants, so no save can be written while its
// saves are swept. A ban outlives the account: its identities' hashes are kept with the ban until
// it ends (banned_identities), so signing in again doesn't start clean.
export async function deleteAccount(env: Env, id: string): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO banned_identities (identity_hash, banned_until, auto_bans)
			 SELECT identities.identity_hash, accounts.banned_until, accounts.auto_bans FROM identities JOIN accounts ON accounts.id = identities.account_id
			 WHERE accounts.id = ?1 AND accounts.banned_until > ?2
			 ON CONFLICT (identity_hash) DO UPDATE SET banned_until = MAX(banned_until, excluded.banned_until), auto_bans = MAX(auto_bans, excluded.auto_bans)`,
		).bind(id, now()),
		env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(id),
	]);
	await deleteAllSaves(env, id);
}

// An account must always keep at least one identity or device grant: one left with neither
// (its identities moved to another account, say) is deleted.
export async function deleteIfOrphaned(env: Env, id: string): Promise<boolean> {
	const kept = await env.DB.prepare(
		"SELECT (SELECT COUNT(*) FROM identities WHERE account_id = ?1) + (SELECT COUNT(*) FROM device_grants WHERE account_id = ?1) AS n",
	)
		.bind(id)
		.first<{ n: number }>();
	if (kept && kept.n > 0) {
		return false;
	}
	await deleteAccount(env, id);
	return true;
}
