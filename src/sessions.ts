// Who is calling. Two kinds of bearer token:
// - Session tokens (signed, not stored): "account" sessions come from signing in on a platform
//   and can do everything; "guest" sessions come from a guest bringing their profile and can only load and save.
// - Device grant tokens ("g_..."; only their hash is stored): a remembered guest on a host
//   device. Revocable, and limited like guest sessions.

import type { Env } from "./env";
import { fromBase64url, base64url, hmacBase64url, randomToken, sha256Hex, timingSafeEqual } from "./crypto";
import { HttpError } from "./http";
import { now, DAY } from "./time";

export type Scope = "account" | "guest";

export interface Caller {
	accountId: string;
	scope: Scope;
	// Guest tokens and grants reach one game's saves only.
	game?: string;
	grantId?: string;
}

interface SessionPayload {
	a: string; // account
	s: Scope;
	x: number; // expires
	e: number; // the account's session epoch when signed in
	g?: string; // the game, for guest sessions
}

const GRANT_PREFIX = "g_";

export async function createSession(env: Env, accountId: string, scope: Scope, game?: string): Promise<{ token: string; expires_at: number }> {
	const lifetime = scope === "account" ? env.SESSION_DAYS * DAY : env.GUEST_TOKEN_HOURS * 3600;
	const epoch = await env.DB.prepare("SELECT session_epoch FROM accounts WHERE id = ?").bind(accountId).first<number>("session_epoch");
	const payload: SessionPayload = { a: accountId, s: scope, x: now() + lifetime, e: epoch ?? 0, ...(scope === "guest" ? { g: game } : {}) };
	const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
	return { token: `${body}.${await hmacBase64url(env.SESSION_SECRET, body)}`, expires_at: payload.x };
}

export async function createGrant(env: Env, accountId: string, game: string, deviceLabel: string): Promise<{ id: string; token: string }> {
	const id = crypto.randomUUID();
	const token = GRANT_PREFIX + randomToken();
	const time = now();
	await env.DB.prepare(
		"INSERT INTO device_grants (id, account_id, game, device_label, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(id, accountId, game, deviceLabel, await sha256Hex(token), time, time)
		.run();
	return { id, token };
}

// The caller of a request, or a 401.
export async function authenticate(env: Env, request: Request): Promise<Caller> {
	const header = request.headers.get("authorization") ?? "";
	const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
	const caller = token.startsWith(GRANT_PREFIX) ? await grantCaller(env, token) : await sessionCaller(env, token);
	if (!caller) {
		throw new HttpError(401, "unauthorised", "Sign in again: the token is missing, expired or revoked.");
	}
	await markSeen(env, caller.accountId);
	return caller;
}

// The caller, who must have a full account session (not a guest token or device grant).
export async function authenticateAccount(env: Env, request: Request): Promise<Caller> {
	const caller = await authenticate(env, request);
	if (caller.scope !== "account") {
		throw new HttpError(403, "forbidden", "Guest tokens and device grants can only load and save games.");
	}
	return caller;
}

async function sessionCaller(env: Env, token: string): Promise<Caller | null> {
	const [body, signature] = token.split(".");
	if (!body || !signature || !timingSafeEqual(signature, await hmacBase64url(env.SESSION_SECRET, body))) {
		return null;
	}
	let payload: SessionPayload;
	try {
		payload = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
	} catch {
		return null;
	}
	if (payload.x < now() || (payload.s !== "account" && payload.s !== "guest") || (payload.s === "guest" && !payload.g)) {
		return null;
	}
	// A deleted account's sessions stop working at once, and so do sessions from before its
	// epoch was raised (its email changed).
	const account = await env.DB.prepare("SELECT session_epoch FROM accounts WHERE id = ?").bind(payload.a).first<{ session_epoch: number }>();
	if (!account || account.session_epoch !== payload.e) {
		return null;
	}
	return { accountId: payload.a, scope: payload.s, game: payload.g };
}

async function grantCaller(env: Env, token: string): Promise<Caller | null> {
	const grant = await env.DB.prepare("SELECT id, account_id, game, last_used_at FROM device_grants WHERE token_hash = ?")
		.bind(await sha256Hex(token))
		.first<{ id: string; account_id: string; game: string; last_used_at: number }>();
	if (!grant || grant.last_used_at < now() - env.DEVICE_GRANT_DAYS * DAY) {
		return null;
	}
	if (grant.last_used_at < now() - DAY) {
		await env.DB.prepare("UPDATE device_grants SET last_used_at = ? WHERE id = ?").bind(now(), grant.id).run();
	}
	return { accountId: grant.account_id, scope: "guest", game: grant.game, grantId: grant.id };
}

async function markSeen(env: Env, accountId: string): Promise<void> {
	await env.DB.prepare("UPDATE accounts SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?")
		.bind(now(), accountId, now() - DAY)
		.run();
}
