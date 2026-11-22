// ICE servers for WebRTC: Cloudflare's TURN service when TURN_KEY_ID and TURN_KEY_API_TOKEN are
// set, a self-hosted list from TURN_SERVERS (a JSON array of RTCIceServer) otherwise, or just
// Cloudflare's STUN server, which has no TURN fallback. Only players in a lobby get them (in its
// welcome, and renewed there while they stay), so nobody can take TURN credentials to relay their
// own traffic on the operator's bill without being in one.
//
// Credentials last CREDENTIAL_SECONDS: longer than most sessions, and the game moves its
// connections onto new ones before they end (games that don't renew get LEGACY_CREDENTIAL_SECONDS). Cloudflare's are revoked as soon as their player
// leaves the lobby; with TURN_SECRET, self-hosted ones (coturn's use-auth-secret) are made for each
// player too, and simply expire. Each account gets at most TURN_DAILY_CREDENTIALS sets a day.

import type { Env } from "./env";
import { base64url } from "./crypto";
import { HttpError } from "./http";
import { now, DAY } from "./time";

export const CREDENTIAL_SECONDS = 4 * 3600;
// For games built before credentials were renewed (they don't say they renew): long enough for a
// long session, as before.
export const LEGACY_CREDENTIAL_SECONDS = 12 * 3600;
// The default for TURN_DAILY_CREDENTIALS: a day of joining lobbies and renewing in them.
export const DEFAULT_DAILY_CREDENTIALS = 48;

export const STUN_ONLY = [{ urls: "stun:stun.cloudflare.com:3478" }];

export interface IceServers {
	servers: unknown[];
	// Cloudflare's usernames for these credentials, to revoke them when the player leaves.
	usernames: string[];
	// Seconds until the credentials end, or 0 when there are none.
	expires_in: number;
}

const NONE: IceServers = { servers: STUN_ONLY, usernames: [], expires_in: 0 };

// Counts a set against the account's day, and says whether it's still within it.
async function withinDailyLimit(env: Env, accountId: string): Promise<boolean> {
	const time = now();
	const row = await env.DB.prepare(
		`INSERT INTO turn_credentials (account_id, day_started_at, issued) VALUES (?1, ?2, 1)
		 ON CONFLICT DO UPDATE SET
		   issued = CASE WHEN day_started_at <= ?2 - ?3 THEN 1 ELSE issued + 1 END,
		   day_started_at = CASE WHEN day_started_at <= ?2 - ?3 THEN ?2 ELSE day_started_at END
		 RETURNING issued`,
	)
		.bind(accountId, time, DAY)
		.first<number>("issued");
	return (row ?? 0) <= (env.TURN_DAILY_CREDENTIALS ?? DEFAULT_DAILY_CREDENTIALS);
}

export async function iceServers(env: Env, accountId: string, renews = true): Promise<IceServers> {
	const lifetime = renews ? CREDENTIAL_SECONDS : LEGACY_CREDENTIAL_SECONDS;
	if (!(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) && !(env.TURN_SERVERS && env.TURN_SECRET)) {
		// Fixed self-hosted servers (no secret to make credentials with), or STUN alone.
		return env.TURN_SERVERS ? { servers: JSON.parse(env.TURN_SERVERS), usernames: [], expires_in: 0 } : NONE;
	}
	if (!(await withinDailyLimit(env, accountId))) {
		console.error("An account reached its TURN credentials for the day");
		return NONE;
	}
	if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
		const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
			method: "POST",
			headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ ttl: lifetime }),
		});
		if (!response.ok) {
			throw new HttpError(502, "provider_unavailable", `Cloudflare's TURN service answered ${response.status}.`);
		}
		const body = (await response.json()) as { iceServers?: { urls: string | string[]; username?: string }[] };
		const servers = body.iceServers ?? STUN_ONLY;
		const usernames = [...new Set(servers.map((server) => ("username" in server ? server.username : undefined)).filter((name): name is string => typeof name === "string"))];
		return { servers, usernames, expires_in: lifetime };
	}
	return { servers: await selfHostedCredentials(env.TURN_SERVERS!, env.TURN_SECRET!, lifetime), usernames: [], expires_in: lifetime };
}

// coturn's REST API credentials: the username is when they end (and something random), the
// password the username's HMAC-SHA1 with the shared secret, in base64.
async function selfHostedCredentials(serversJson: string, secret: string, lifetime: number): Promise<unknown[]> {
	const username = `${now() + lifetime}:${base64url(crypto.getRandomValues(new Uint8Array(9)))}`;
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username)));
	const credential = btoa(String.fromCharCode(...signature));
	return (JSON.parse(serversJson) as { urls: string | string[] }[]).map((server) => {
		const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
		return urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:")) ? { urls: server.urls, username, credential } : server;
	});
}

// Ends a player's Cloudflare credentials (they left the lobby). Failures are only logged: the
// credentials end on their own anyway.
export async function revokeCredentials(env: Env, usernames: string[]): Promise<void> {
	if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
		return;
	}
	for (const username of usernames) {
		try {
			const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/${encodeURIComponent(username)}/revoke`, {
				method: "POST",
				headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}` },
			});
			if (!response.ok && response.status !== 404) {
				console.error("Cloudflare's TURN service didn't revoke credentials", response.status);
			}
		} catch {
			console.error("Couldn't reach Cloudflare's TURN service to revoke credentials");
		}
	}
}
