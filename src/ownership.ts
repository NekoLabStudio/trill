// Whether a player owns the game, for games that only play online for players who bought them
// (check_ownership). Ownership belongs to the Purr account, per game, and is proven by the copy of
// the game the player signs in from, whatever they sign in with: a Steam ticket (CheckAppOwnership),
// the App Store's AppTransaction, or a Play Integrity token. Only that it's owned, where it was
// proven and when are kept: no platform IDs, and a purchase's ID (or a Steam ID whose ticket came
// from another account) only as a keyed hash, to limit how many accounts one purchase can prove.
//
// Two ways, by the game's other_stores:
// - sold elsewhere too (the default): checked wherever the copy can show it; a store that says
//   the player doesn't own the game turns them away, and a copy that can't say lets them in;
// - only on Steam, the App Store and Google Play: every account must show it.

import type { Env, GameSettings } from "./env";
import type { Caller } from "./sessions";
import { hmacBase64url, hmacHex, randomToken, timingSafeEqual } from "./crypto";
import { HttpError } from "./http";
import { verifyAppTransaction } from "./providers/app_store";
import { decodeIntegrityToken } from "./providers/play_integrity";
import { steamOwnsAny, verifySteamTicket } from "./providers/steam";
import { now, DAY } from "./time";

// A proof older than this is checked again at the next sign-in (refunds count).
const RECHECK_AFTER = DAY;
// When the store can't be asked, a proof this recent still counts, so an outage locks nobody out.
const GRACE = 7 * DAY;
// One App Store purchase, or one Steam account's tickets, prove at most this many accounts (a
// player with a few, or a family).
const ACCOUNTS_PER_PURCHASE = 5;
// How long a challenge for a Play Integrity token lasts.
const CHALLENGE_SECONDS = 600;

export type Source = "steam" | "app_store" | "google_play";

// purchase: what identifies the purchase across accounts, where one purchase could be shown by
// any number of them (an App Store download's ID).
type Verdict = { owned: true; source: Source; purchase?: string } | { owned: false } | null;

export function checksOwnership(settings: GameSettings): boolean {
	return settings.check_ownership === true;
}

export function requiresOwnership(settings: GameSettings): boolean {
	return settings.check_ownership === true && settings.other_stores === false;
}

// A one-off challenge, signed rather than stored: "<random>.<expiry>.<signature>".
export async function createChallenge(env: Env, game: string): Promise<{ challenge: string }> {
	const body = `${randomToken(16)}.${now() + CHALLENGE_SECONDS}`;
	return { challenge: `${body}.${await hmacBase64url(env.SESSION_SECRET, `challenge:${game}:${body}`)}` };
}

async function validChallenge(env: Env, game: string, challenge: string): Promise<boolean> {
	const parts = challenge.split(".");
	if (parts.length !== 3 || Number(parts[1]) < now()) {
		return false;
	}
	return timingSafeEqual(parts[2], await hmacBase64url(env.SESSION_SECRET, `challenge:${game}:${parts[0]}.${parts[1]}`));
}

// A challenge proves one sign-in: the first use spends it.
async function spendChallenge(env: Env, challenge: string): Promise<boolean> {
	const [random, expiry] = challenge.split(".");
	const spent = await env.DB.prepare("INSERT INTO ownership_challenges (id, expires_at) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(random, Number(expiry)).run();
	return spent.meta.changes === 1;
}

// What the copy's proof says: owned (and where), not owned, or nothing (no proof, or the store
// couldn't be asked).
async function verify(env: Env, game: string, settings: GameSettings, proof: Record<string, unknown>, steamId: string | null): Promise<Verdict> {
	const steamAppIds = settings.steam_app_id ? [settings.steam_app_id, ...(settings.extra_steam_app_ids ?? [])] : [];
	if ((steamId || typeof proof.steam_ticket === "string") && steamAppIds.length > 0) {
		const id = steamId ?? (await verifySteamTicket(env.STEAM_WEB_API_KEY, steamAppIds, proof.steam_ticket as string));
		if (!(await steamOwnsAny(env.STEAM_WEB_API_KEY, id, steamAppIds))) {
			return { owned: false };
		}
		// A Steam account signing in is its own proof; its ticket handed to other accounts counts
		// against the same limit as an App Store purchase.
		return { owned: true, source: "steam", purchase: steamId ? undefined : `steam:${id}` };
	}
	if (typeof proof.app_transaction === "string") {
		const transaction = await verifyAppTransaction(proof.app_transaction);
		if (!(settings.bundle_ids ?? []).includes(transaction.bundleId)) {
			throw new HttpError(401, "invalid_proof", "The AppTransaction is for another app.");
		}
		// TestFlight's are "Sandbox"; Xcode's and StoreKit testing's aren't signed by Apple at all.
		const tester = transaction.receiptType === "Sandbox";
		if (transaction.receiptType !== "Production" && !(tester && settings.test_builds !== false)) {
			return { owned: false };
		}
		// Without its download's ID, one leaked proof could prove any number of accounts: it says
		// nothing then.
		if (typeof transaction.appTransactionId !== "string" || transaction.appTransactionId === "") {
			return null;
		}
		return { owned: true, source: "app_store", purchase: `app_store:${transaction.appTransactionId}` };
	}
	if (typeof proof.play_integrity === "string" && typeof proof.challenge === "string") {
		if (!settings.play_package) {
			throw new HttpError(501, "not_configured", "Play Integrity isn't set up for this game (play_package).");
		}
		if (!(await validChallenge(env, game, proof.challenge)) || !(await spendChallenge(env, proof.challenge))) {
			throw new HttpError(401, "invalid_proof", "The challenge is unknown, used or expired; ask for a new one.");
		}
		const verdict = await decodeIntegrityToken(env.PLAY_INTEGRITY_SERVICE_ACCOUNT, settings.play_package, proof.play_integrity);
		// The client asks Play Integrity for a token with the challenge as its requestHash.
		if (verdict.packageName !== settings.play_package || !timingSafeEqual(verdict.requestHash, proof.challenge) || Math.abs(Date.now() - verdict.timestampMillis) > CHALLENGE_SECONDS * 1000) {
			throw new HttpError(401, "invalid_proof", "The Play Integrity token isn't for this request.");
		}
		if (verdict.licensing === "LICENSED") {
			return { owned: true, source: "google_play" };
		}
		return verdict.licensing === "UNLICENSED" ? { owned: false } : null;
	}
	return null;
}

// Whether one more account (or this one again) fits within the purchase's limit of accounts: an
// account refused here is never counted, so it can't push out the ones already in.
async function purchaseHasRoom(env: Env, game: string, accountId: string | null, purchase: string): Promise<boolean> {
	const others = await env.DB.prepare("SELECT COUNT(*) AS n FROM ownership_proofs WHERE proof_hash = ? AND game = ? AND seen_at > ? AND account_id != ?")
		.bind(await purchaseHash(env, purchase), game, now() - 30 * DAY, accountId ?? "")
		.first<number>("n");
	return (others ?? 0) < ACCOUNTS_PER_PURCHASE;
}

async function purchaseHash(env: Env, purchase: string): Promise<string> {
	return hmacHex(env.IDENTITY_SECRET, `purchase:${purchase}`);
}

async function lastProven(env: Env, accountId: string, game: string): Promise<number | null> {
	return env.DB.prepare("SELECT checked_at FROM ownership WHERE account_id = ? AND game = ?").bind(accountId, game).first<number>("checked_at");
}

// Whether the account has shown it owns the game recently enough to count (for TURN, and for the
// game's other routes when ownership is required).
export async function ownsGame(env: Env, accountId: string, game: string): Promise<boolean> {
	const checked = await lastProven(env, accountId, game);
	return checked !== null && checked > now() - GRACE;
}

// At every sign-in to the game (any provider, or email), in two steps around finding or making
// the account. Before: turns the player away (403 not_owned) when the game checks ownership and
// they don't own it, before an account is made for them. existingAccountId: the account the
// sign-in will reach, if it has one already; steamId: the player signed in with Steam, whose
// ticket is the proof. Returns what to record once the account is known.
export async function ownershipBeforeSignIn(env: Env, game: string, settings: GameSettings, existingAccountId: string | null, proof: unknown, steamId: string | null = null): Promise<Verdict> {
	if (!checksOwnership(settings)) {
		return null;
	}
	const checked = existingAccountId ? await lastProven(env, existingAccountId, game) : null;
	if (checked !== null && checked > now() - RECHECK_AFTER) {
		return null;
	}
	const given = proof !== null && typeof proof === "object" && !Array.isArray(proof) ? (proof as Record<string, unknown>) : {};
	let verdict: Verdict = null;
	try {
		verdict = await verify(env, game, settings, given, steamId);
	} catch (error) {
		// A store that can't be asked, or isn't set up, says nothing; a forged or stale proof
		// counts as none.
		if (!(error instanceof HttpError)) {
			throw error;
		}
		console.error("Couldn't check ownership", error.code);
	}
	if (verdict && !verdict.owned) {
		if (existingAccountId) {
			await env.DB.prepare("DELETE FROM ownership WHERE account_id = ? AND game = ?").bind(existingAccountId, game).run();
		}
		throw notOwned();
	}
	if (!verdict && requiresOwnership(settings) && !(checked !== null && checked > now() - GRACE)) {
		throw notOwned();
	}
	if (verdict?.owned && verdict.purchase && !(await purchaseHasRoom(env, game, existingAccountId, verdict.purchase))) {
		throw new HttpError(403, "not_owned", "This purchase has already shown it owns the game for too many accounts.");
	}
	return verdict;
}

// After: records what the copy proved for the account the sign-in reached.
export async function ownershipAfterSignIn(env: Env, game: string, accountId: string, verdict: Verdict): Promise<void> {
	if (!verdict?.owned) {
		return;
	}
	if (verdict.purchase) {
		// Counted and recorded in one statement, so sign-ins at the same moment can't overshoot.
		const time = now();
		const recorded = await env.DB.prepare(
			`INSERT INTO ownership_proofs (proof_hash, game, account_id, seen_at)
			 SELECT ?1, ?2, ?3, ?4
			 WHERE (SELECT COUNT(*) FROM ownership_proofs WHERE proof_hash = ?1 AND game = ?2 AND seen_at > ?5 AND account_id != ?3) < ?6
			 ON CONFLICT DO UPDATE SET seen_at = excluded.seen_at`,
		)
			.bind(await purchaseHash(env, verdict.purchase), game, accountId, time, time - 30 * DAY, ACCOUNTS_PER_PURCHASE)
			.run();
		if (recorded.meta.changes === 0) {
			throw new HttpError(403, "not_owned", "This purchase has already shown it owns the game for too many accounts.");
		}
	}
	await env.DB.prepare("INSERT INTO ownership (account_id, game, source, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET source = excluded.source, checked_at = excluded.checked_at")
		.bind(accountId, game, verdict.source, now())
		.run();
}

// On the game's routes (saves, lobbies, matchmaking) when ownership is required: a session from
// another game on the same service doesn't get round it. Guests play on their host's copy.
export async function requireOwner(env: Env, game: string, settings: GameSettings, caller: Caller): Promise<void> {
	if (requiresOwnership(settings) && caller.scope === "account" && !(await ownsGame(env, caller.accountId, game))) {
		throw notOwned();
	}
}

function notOwned(): HttpError {
	return new HttpError(403, "not_owned", "This game only plays online for players who bought it.");
}
