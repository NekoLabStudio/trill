// Email on accounts. An address, proven with a code (email_codes.ts), can:
// - sign in: to the address's account, or a new one;
// - be added to the signed-in account, which is how a player brings their progress to every
//   platform: if the address already has an account, the caller's account joins it;
// - replace the account's address, given the current one too;
// - bring a guest's profile to someone else's device (the host gets a guest token or grant).

import type { Env } from "./env";
import type { Caller } from "./sessions";
import { createAccount, findAccount, type Account } from "./accounts";
import { verifyEmailCode, normaliseEmail } from "./email_codes";
import { HttpError, optionalString, requireString } from "./http";
import { addIdentity, findIdentityAccount, identityHash, listProviders, requireGame, restoreBan } from "./identities";
import { deleteAllSaves } from "./saves";
import { authenticate, createGrant, createSession } from "./sessions";

const MAX_NAME = 64;

async function session(env: Env, account: Account, created: boolean) {
	return {
		account_id: account.id,
		display_name: account.display_name,
		name_chosen: Boolean(account.name_chosen),
		created,
		providers: await listProviders(env, account.id),
		...(await createSession(env, account.id, "account")),
	};
}

// The address's account, or a new one for it.
async function accountForEmail(env: Env, email: string, displayName: string): Promise<{ account: Account; created: boolean }> {
	const existing = await findIdentityAccount(env, "email", email);
	if (existing) {
		return { account: existing, created: false };
	}
	// Someone typing their address also typed this name: it's theirs.
	const account = await createAccount(env, displayName, true);
	if (!(await addIdentity(env, account.id, "email", email))) {
		// Two first sign-ins at once: the other one's account wins.
		await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(account.id).run();
		return { account: (await findIdentityAccount(env, "email", email))!, created: false };
	}
	return { account, created: true };
}

// POST /auth/email/verify. Signed out, it signs in; with a full session, it adds or changes the
// account's address.
export async function verifyEmail(env: Env, request: Request, body: Record<string, unknown>) {
	let caller: Caller | null = null;
	if (request.headers.has("authorization")) {
		caller = await authenticate(env, request);
		if (caller.scope !== "account") {
			throw new HttpError(403, "forbidden", "Guest tokens and device grants can't add or change an email address.");
		}
	}
	const displayName = optionalString(body, "display_name", MAX_NAME);
	const email = await verifyEmailCode(env, request, body.email, body.challenge, body.code, "sign_in");

	if (!caller) {
		const { account, created } = await accountForEmail(env, email, displayName);
		return session(env, account, created);
	}

	const owner = await findIdentityAccount(env, "email", email);
	const providers = await listProviders(env, caller.accountId);
	if (providers.includes("email")) {
		// Changing the address: the current one must be named, and the new one must be free.
		const current = normaliseEmail(body.current_email);
		if ((await findIdentityAccount(env, "email", current))?.id !== caller.accountId) {
			throw new HttpError(403, "wrong_current_email", "That isn't this account's current email address.");
		}
		if (owner && owner.id !== caller.accountId) {
			throw new HttpError(409, "email_in_use", "That address already belongs to another account.");
		}
		if (!owner) {
			// One batch, so the account is never left without an address. Every other session the
			// account has ends: whoever changed the address keeps the one returned here.
			await env.DB.batch([
				env.DB.prepare("DELETE FROM identities WHERE account_id = ? AND provider = 'email'").bind(caller.accountId),
				env.DB.prepare("INSERT INTO identities (identity_hash, key_version, provider, account_id) VALUES (?, ?, 'email', ?)").bind(
					await identityHash(env.IDENTITY_SECRET, "email", email),
					env.IDENTITY_KEY_VERSION,
					caller.accountId,
				),
				env.DB.prepare("UPDATE accounts SET session_epoch = session_epoch + 1 WHERE id = ?").bind(caller.accountId),
			]);
			await restoreBan(env, caller.accountId, "email", email);
		}
		return { ...(await session(env, (await findAccount(env, caller.accountId))!, false)), merged: false };
	}

	if (!owner) {
		if (!(await addIdentity(env, caller.accountId, "email", email))) {
			throw new HttpError(409, "email_in_use", "That address was just added to another account.");
		}
		return { ...(await session(env, (await findAccount(env, caller.accountId))!, false)), merged: false };
	}

	// The address already has an account: the caller's joins it, in one batch (its identities and
	// grants move over and the old account goes). Accounts without an address keep no saves on the
	// service, so there are none to choose between; anything left under the old account is swept.
	// Its standing moves over too: a ban (the later end), its count of automatic bans, removals for
	// cheating, reports about it, blocks either way and ratings in modes the address's account hasn't
	// played. Left behind, joining an account would be a way out of a ban.
	const from = caller.accountId;
	const to = owner.id;
	await env.DB.batch([
		env.DB.prepare("UPDATE identities SET account_id = ?1 WHERE account_id = ?2").bind(to, from),
		env.DB.prepare("UPDATE device_grants SET account_id = ?1 WHERE account_id = ?2").bind(to, from),
		env.DB.prepare(
			`UPDATE accounts SET
			   banned_until = MAX(banned_until, (SELECT banned_until FROM accounts WHERE id = ?2)),
			   auto_bans = auto_bans + (SELECT auto_bans FROM accounts WHERE id = ?2)
			 WHERE id = ?1`,
		).bind(to, from),
		env.DB.prepare("UPDATE cheat_kicks SET account_id = ?1 WHERE account_id = ?2").bind(to, from),
		env.DB.prepare("UPDATE reports SET reported_id = ?1 WHERE reported_id = ?2 AND reporter_id != ?1").bind(to, from),
		env.DB.prepare("UPDATE reports SET reporter_id = ?1 WHERE reporter_id = ?2 AND reported_id != ?1").bind(to, from),
		env.DB.prepare("INSERT OR IGNORE INTO blocks (account_id, blocked_id, created_at) SELECT ?1, blocked_id, created_at FROM blocks WHERE account_id = ?2 AND blocked_id != ?1").bind(to, from),
		env.DB.prepare("INSERT OR IGNORE INTO blocks (account_id, blocked_id, created_at) SELECT account_id, ?1, created_at FROM blocks WHERE blocked_id = ?2 AND account_id != ?1").bind(to, from),
		env.DB.prepare("INSERT OR IGNORE INTO ratings (account_id, game, mode, rating, matches) SELECT ?1, game, mode, rating, matches FROM ratings WHERE account_id = ?2").bind(to, from),
		env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(from),
	]);
	await deleteAllSaves(env, caller.accountId);
	return { ...(await session(env, owner, false)), merged: true };
}

// POST /guest/email/verify, from the host's device with the host's session: the guest's account
// (a new one if the address has none), for loading and saving one game's saves only. It takes a
// "guest" code, which can't sign in.
export async function verifyGuestEmail(env: Env, request: Request, host: Caller, body: Record<string, unknown>) {
	const game = requireString(body, "game", MAX_NAME);
	requireGame(env, game);
	const email = await verifyEmailCode(env, request, body.email, body.challenge, body.code, "guest");
	const { account } = await accountForEmail(env, email, optionalString(body, "display_name", MAX_NAME));
	if (account.id === host.accountId) {
		throw new HttpError(400, "same_account", "That's this device's own account.");
	}
	const credentials =
		body.remember === true
			? { kind: "grant", token: (await createGrant(env, account.id, game, optionalString(body, "device_label", MAX_NAME))).token }
			: { kind: "guest", ...(await createSession(env, account.id, "guest", game)) };
	return { account_id: account.id, display_name: account.display_name, ...credentials };
}
