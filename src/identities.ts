// Identities (platform accounts, devices and email addresses), stored only as HMAC-SHA256 of "provider:provider_user_id" with the
// IDENTITY_SECRET. To rotate the secret: set the old one as IDENTITY_SECRET_PREVIOUS, the new one
// as IDENTITY_SECRET, and bump IDENTITY_KEY_VERSION. Each identity is then matched under the old
// key the next time it signs in and saved again under the new one.

import type { Env } from "./env";
import { createAccount, findAccount, setDisplayName, type Account } from "./accounts";
import { hmacHex } from "./crypto";
import { HttpError } from "./http";
import { now } from "./time";

export type Provider = "steam" | "game_center" | "play_games" | "device" | "email";

export function identityHash(secret: string, provider: Provider, providerUserId: string): Promise<string> {
	return hmacHex(secret, `${provider}:${providerUserId}`);
}

// The account an identity belongs to, re-saving it under the current key if it was found under
// the previous one; null if it's unknown.
export async function findIdentityAccount(env: Env, provider: Provider, providerUserId: string): Promise<Account | null> {
	const hash = await identityHash(env.IDENTITY_SECRET, provider, providerUserId);
	const current = await env.DB.prepare("SELECT account_id FROM identities WHERE identity_hash = ?").bind(hash).first<{ account_id: string }>();
	if (current) {
		return findAccount(env, current.account_id);
	}
	if (!env.IDENTITY_SECRET_PREVIOUS) {
		return null;
	}
	const oldHash = await identityHash(env.IDENTITY_SECRET_PREVIOUS, provider, providerUserId);
	const old = await env.DB.prepare("SELECT account_id FROM identities WHERE identity_hash = ?").bind(oldHash).first<{ account_id: string }>();
	if (!old) {
		return null;
	}
	await env.DB.prepare("UPDATE identities SET identity_hash = ?, key_version = ? WHERE identity_hash = ?")
		.bind(hash, env.IDENTITY_KEY_VERSION, oldHash)
		.run();
	return findAccount(env, old.account_id);
}

// Adds the identity to the account; false if it already belongs to one (another request may
// have just added it). A ban kept from a deleted account with this identity comes back with it.
export async function addIdentity(env: Env, accountId: string, provider: Provider, providerUserId: string): Promise<boolean> {
	const hash = await identityHash(env.IDENTITY_SECRET, provider, providerUserId);
	const added = await env.DB.prepare("INSERT OR IGNORE INTO identities (identity_hash, key_version, provider, account_id) VALUES (?, ?, ?, ?)")
		.bind(hash, env.IDENTITY_KEY_VERSION, provider, accountId)
		.run();
	if (added.meta.changes !== 1) {
		return false;
	}
	await restoreBan(env, accountId, provider, providerUserId);
	return true;
}

// The ban a deleted account with this identity left behind (banned_identities), if it hasn't
// ended, put on the account. Looked up under the previous key too, while the key is rotated.
export async function restoreBan(env: Env, accountId: string, provider: Provider, providerUserId: string): Promise<void> {
	const hashes = [await identityHash(env.IDENTITY_SECRET, provider, providerUserId)];
	if (env.IDENTITY_SECRET_PREVIOUS) {
		hashes.push(await identityHash(env.IDENTITY_SECRET_PREVIOUS, provider, providerUserId));
	}
	for (const hash of hashes) {
		await env.DB.prepare(
			`UPDATE accounts SET
			   banned_until = MAX(banned_until, (SELECT banned_until FROM banned_identities WHERE identity_hash = ?2)),
			   auto_bans = MAX(auto_bans, (SELECT auto_bans FROM banned_identities WHERE identity_hash = ?2))
			 WHERE id = ?1 AND EXISTS (SELECT 1 FROM banned_identities WHERE identity_hash = ?2 AND banned_until > ?3)`,
		)
			.bind(accountId, hash, now())
			.run();
	}
}

// Signs in with a verified identity: its account, or a new one if it's unknown.
export async function signInWithIdentity(
	env: Env,
	provider: Provider,
	providerUserId: string,
	displayName: string,
): Promise<{ account: Account; created: boolean }> {
	const existing = await findIdentityAccount(env, provider, providerUserId);
	if (existing) {
		await setDisplayName(env, existing.id, displayName);
		return { account: (await findAccount(env, existing.id)) ?? existing, created: false };
	}
	const account = await createAccount(env, displayName);
	if (!(await addIdentity(env, account.id, provider, providerUserId))) {
		// Two first sign-ins at once: the other one's account wins, and this one goes.
		await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(account.id).run();
		return { account: (await findIdentityAccount(env, provider, providerUserId))!, created: false };
	}
	return { account, created: true };
}

export async function hasEmail(env: Env, accountId: string): Promise<boolean> {
	return (await env.DB.prepare("SELECT 1 FROM identities WHERE account_id = ? AND provider = 'email'").bind(accountId).first()) !== null;
}

export async function listProviders(env: Env, accountId: string): Promise<Provider[]> {
	const rows = await env.DB.prepare("SELECT provider FROM identities WHERE account_id = ? ORDER BY provider").bind(accountId).all<{ provider: Provider }>();
	return rows.results.map((row) => row.provider);
}

export function requireGame(env: Env, game: string) {
	// Only the games listed, never anything inherited ("constructor").
	const settings = Object.hasOwn(env.GAMES, game) ? env.GAMES[game] : undefined;
	if (!settings) {
		throw new HttpError(404, "unknown_game", `This service isn't set up for the game "${game}".`);
	}
	return settings;
}
