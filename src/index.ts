// Purr online services: accounts without stored emails, passwords or platform IDs,
// cross-progression saves, linking platforms by email, local players and lobbies. Every route is
// listed here; the protocol is in README.md.

import type { Env } from "./env";
import { DEFAULT_NAME, chooseDisplayName, deleteAccount, findAccount } from "./accounts";
import { cleanUp } from "./cleanup";
import { sendModerationDigest } from "./moderation_digest";
import { HttpError, errorResponse, json, optionalString, readJson, requireString } from "./http";
import { listProviders, requireGame, signInWithIdentity, findIdentityAccount, type Provider } from "./identities";
import { verifyEmail, verifyGuestEmail } from "./email_accounts";
import { connectionKey, startEmail } from "./email_codes";
import { forgetGrant, listGrants, revokeGrant } from "./guests";
import { MAX_MEMBERS } from "./lobby";
import { blockedBy, blockedEitherWay, requireNotBanned } from "./moderation";
import { ratingOf } from "./ratings";
import { verifyGameCenter } from "./providers/game_center";
import { playGamesClient, verifyPlayGames } from "./providers/play_games";
import { verifySteamTicket } from "./providers/steam";
import { checkName, listSaves, readSave, writeSave } from "./saves";
import { authenticate, authenticateAccount, createSession, type Caller } from "./sessions";
import { iceServers } from "./turn";
import { checkClientVersion } from "./client_versions";
import { PROTOCOL, SERVICE_VERSION } from "./version";
import { randomCode, normaliseCode } from "./crypto";

export { Lobby } from "./lobby";
export { Matchmaker } from "./matchmaker";

const MAX_NAME = 64;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		let response: Response;
		try {
			checkClientVersion(env, request);
			response = await route(request, env);
		} catch (error) {
			if (error instanceof HttpError) {
				response = errorResponse(error);
			} else {
				// Nothing about the request is logged, only that something failed.
				console.error("Unexpected error", error instanceof Error ? error.name : "unknown");
				response = errorResponse(new HttpError(500, "internal_error", "Something went wrong on the server."));
			}
		}
		// Every answer says which protocol this service speaks, so clients can tell it's too old.
		if (response.status !== 101) {
			response = new Response(response.body, response);
			response.headers.set("x-purr-protocol", String(PROTOCOL));
		}
		return response;
	},

	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		await cleanUp(env);
		try {
			await sendModerationDigest(env);
		} catch (error) {
			console.error("Sending the moderation email failed", error instanceof Error ? error.message : "unknown");
		}
	},
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname.split("/").filter(Boolean);
	const method = request.method;
	const at = (...parts: string[]) => parts.length === path.length && parts.every((part, i) => part === "*" || part === path[i]);

	// What this service is: its version and protocol, for games to check.
	if (method === "GET" && at("version")) {
		return json({ version: SERVICE_VERSION, protocol: PROTOCOL });
	}

	// Email: codes, then signing in, adding or changing an address.
	if (method === "POST" && at("auth", "email", "start")) {
		const body = await readJson(request);
		return json(await startEmail(env, request, body.email, requireString(body, "game", MAX_NAME), "sign_in"));
	}
	if (method === "POST" && at("auth", "email", "verify")) {
		return json(await verifyEmail(env, request, await readJson(request)));
	}

	// Signing in with a platform.
	if (method === "POST" && at("auth", "*")) {
		return json(await signIn(request, env, path[1]));
	}

	// The signed-in account.
	if (method === "GET" && at("account")) {
		const caller = await authenticateAccount(env, request);
		const account = await findAccount(env, caller.accountId);
		return json({ ...account, name_chosen: Boolean(account?.name_chosen), providers: await listProviders(env, caller.accountId), scope: caller.scope });
	}
	if (method === "PUT" && at("account", "name")) {
		const caller = await authenticateAccount(env, request);
		return json(await chooseDisplayName(env, caller.accountId, (await readJson(request)).display_name));
	}
	if (method === "DELETE" && at("account")) {
		const caller = await authenticateAccount(env, request);
		await deleteAccount(env, caller.accountId);
		return json({ deleted: caller.accountId });
	}

	// Local players: a guest bringing their profile with their email, and remembered guests.
	if (method === "POST" && at("guest", "email", "start")) {
		// Only a signed-in host asks for a guest's code, and that code can't sign in.
		await authenticateAccount(env, request);
		const body = await readJson(request);
		return json(await startEmail(env, request, body.email, requireString(body, "game", MAX_NAME), "guest"));
	}
	if (method === "POST" && at("guest", "email", "verify")) {
		const host = await authenticateAccount(env, request);
		return json(await verifyGuestEmail(env, request, host, await readJson(request)));
	}
	if (method === "GET" && at("grants")) {
		return json(await listGrants(env, await authenticateAccount(env, request)));
	}
	if (method === "DELETE" && at("grants", "current")) {
		return json(await forgetGrant(env, await authenticate(env, request)));
	}
	if (method === "DELETE" && at("grants", "*")) {
		return json(await revokeGrant(env, await authenticateAccount(env, request), path[1]));
	}

	// Saves (guest tokens and device grants may use these).
	if (method === "GET" && at("saves", "*")) {
		const game = checkName("game", path[1]);
		requireGame(env, game);
		const caller = await authenticateSaves(env, request, game);
		return json({ saves: await listSaves(env, caller.accountId, game) });
	}
	if (method === "GET" && at("saves", "*", "*")) {
		const game = checkName("game", path[1]);
		requireGame(env, game);
		const caller = await authenticateSaves(env, request, game);
		const save = await readSave(env, caller.accountId, game, checkName("slot", path[2]));
		if (!save) {
			throw new HttpError(404, "no_save", "There's no save in that slot.");
		}
		return new Response(save.body, {
			headers: {
				"content-type": "application/octet-stream",
				"x-save-version": save.customMetadata?.version ?? "0",
				"x-save-summary": save.customMetadata?.summary ?? "null",
			},
		});
	}
	if (method === "PUT" && at("saves", "*", "*")) {
		const game = checkName("game", path[1]);
		const settings = requireGame(env, game);
		const caller = await authenticateSaves(env, request, game);
		const replaces = Number(request.headers.get("x-save-version") ?? "NaN");
		if (!Number.isInteger(replaces) || replaces < 0) {
			throw new HttpError(400, "bad_request", "X-Save-Version must be the version this save replaces (0 for a new slot).");
		}
		// Refused before reading the body when it's too big, so the body's length must be given
		// (writeSave checks the bytes too).
		const maxBytes = settings.max_save_bytes ?? env.MAX_SAVE_BYTES;
		const length = request.headers.get("content-length");
		if (length === null || !/^\d+$/.test(length)) {
			throw new HttpError(411, "length_required", "Send the save's length (Content-Length).");
		}
		if (Number(length) > maxBytes) {
			throw new HttpError(413, "save_too_large", `A save can be at most ${maxBytes} bytes.`);
		}
		const summary = request.headers.get("x-save-summary") ?? "null";
		try {
			JSON.parse(summary);
		} catch {
			throw new HttpError(400, "bad_request", "X-Save-Summary must be JSON.");
		}
		const version = await writeSave(env, caller.accountId, game, checkName("slot", path[2]), await request.arrayBuffer(), replaces, summary);
		return json({ version });
	}

	// Lobbies.
	if (method === "POST" && at("lobbies")) {
		const caller = await authenticateAccount(env, request);
		await limitAccount(env.LOBBY_LIMITER, caller, "Too many lobbies; try again in a minute.");
		await requireNotBanned(env, caller.accountId);
		const game = requireString(await readJson(request), "game", MAX_NAME);
		requireGame(env, game);
		for (let attempt = 0; attempt < 5; attempt++) {
			const code = randomCode();
			if (await env.LOBBIES.getByName(code).create(game, caller.accountId)) {
				return json({ code, max_members: MAX_MEMBERS });
			}
		}
		throw new HttpError(503, "busy", "Couldn't find a free lobby code; try again.");
	}
	if (method === "GET" && at("lobbies", "*", "socket")) {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			throw new HttpError(426, "upgrade_required", "Connect with a WebSocket.");
		}
		const code = normaliseCode(path[1]);
		const game = url.searchParams.get("game") ?? "";
		requireGame(env, game);
		const caller = await authenticateAccount(env, request);
		await limitAccount(env.LOBBY_LIMITER, caller, "Too many lobbies; try again in a minute.");
		if (!/^[0-9A-Z]{6}$/.test(code)) {
			throw new HttpError(404, "no_lobby", "No such lobby.");
		}
		await requireNotBanned(env, caller.accountId);
		const account = await findAccount(env, caller.accountId);
		// What the lobby trusts comes from here, never from the client's own headers.
		const headers = new Headers(request.headers);
		headers.set("x-account-id", caller.accountId);
		headers.set("x-display-name", encodeURIComponent(account?.display_name || DEFAULT_NAME));
		headers.set("x-game", game);
		headers.set("x-blocked-by", (await blockedBy(env, caller.accountId)).join(","));
		return env.LOBBIES.getByName(code).fetch(new Request(request, { headers }));
	}

	// Matchmaking and ratings, for a game's ranked modes.
	if (method === "GET" && at("matchmaking", "*", "*", "socket")) {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			throw new HttpError(426, "upgrade_required", "Connect with a WebSocket.");
		}
		const game = checkName("game", path[1]);
		requireGame(env, game);
		const mode = checkName("mode", path[2]);
		const players = Number(url.searchParams.get("players") ?? "2");
		if (!Number.isInteger(players) || players < 2 || players > MAX_MEMBERS) {
			throw new HttpError(400, "bad_request", `"players" must be 2 to ${MAX_MEMBERS}.`);
		}
		const caller = await authenticateAccount(env, request);
		await limitAccount(env.LOBBY_LIMITER, caller, "Too many lobbies; try again in a minute.");
		await requireNotBanned(env, caller.accountId);
		const headers = new Headers(request.headers);
		headers.set("x-account-id", caller.accountId);
		headers.set("x-rating", String((await ratingOf(env, caller.accountId, game, mode)).rating));
		headers.set("x-blocked", (await blockedEitherWay(env, caller.accountId)).join(","));
		headers.set("x-game", game);
		headers.set("x-mode", mode);
		headers.set("x-size", String(players));
		// Where the player connects from, roughly (Cloudflare's guess at the city), to match
		// nearby players first. Only ever set here, never taken from the client.
		const cf = request.cf as { latitude?: string; longitude?: string } | undefined;
		if (cf?.latitude && cf?.longitude) {
			headers.set("x-location", `${cf.latitude},${cf.longitude}`);
		} else {
			headers.delete("x-location");
		}
		return env.MATCHMAKERS.getByName(`${game}:${mode}:${players}`).fetch(new Request(request, { headers }));
	}
	if (method === "GET" && at("ratings", "*", "*")) {
		const caller = await authenticateAccount(env, request);
		const game = checkName("game", path[1]);
		requireGame(env, game);
		return json(await ratingOf(env, caller.accountId, game, checkName("mode", path[2])));
	}
	if (method === "GET" && at("turn")) {
		await authenticateAccount(env, request);
		return json(await iceServers(env));
	}

	throw new HttpError(404, "not_found", `No route for ${method} ${url.pathname}.`);
}

async function limitAccount(limiter: RateLimit, caller: Caller, message: string): Promise<void> {
	const { success } = await limiter.limit({ key: caller.accountId });
	if (!success) {
		throw new HttpError(429, "rate_limited", message);
	}
}

// The caller of a saves request, for this game: guest tokens and grants reach only the game
// they were given for. Limited per account and per connection.
async function authenticateSaves(env: Env, request: Request, game: string): Promise<Caller> {
	const caller = await authenticate(env, request);
	if (caller.game && caller.game !== game) {
		throw new HttpError(403, "forbidden", "This token is for another game's saves.");
	}
	await limitAccount(env.SAVE_LIMITER, caller, "Too many saves; try again in a minute.");
	const { success } = await env.SAVE_LIMITER.limit({ key: `connection:${connectionKey(request)}` });
	if (!success) {
		throw new HttpError(429, "rate_limited", "Too many saves from here; try again in a minute.");
	}
	return caller;
}

async function signIn(request: Request, env: Env, provider: string) {
	// Checked before asking Steam, Apple or Google, so nobody can spend the service's quota there.
	const { success } = await env.AUTH_LIMITER.limit({ key: connectionKey(request) });
	if (!success) {
		throw new HttpError(429, "rate_limited", "Too many sign-ins from here; try again in a minute.");
	}
	const body = await readJson(request);
	const displayName = optionalString(body, "display_name", MAX_NAME);
	let verified: { provider: Provider; id: string };

	if (provider === "device") {
		// A random secret the device keeps; it's the device's identity.
		const secret = requireString(body, "secret", 256);
		if (secret.length < 32) {
			throw new HttpError(400, "bad_request", '"secret" must be at least 32 random characters.');
		}
		verified = { provider: "device", id: secret };
		if (!(await findIdentityAccount(env, "device", secret))) {
			const { success } = await env.SIGNUP_LIMITER.limit({ key: connectionKey(request) });
			if (!success) {
				throw new HttpError(429, "rate_limited", "Too many new accounts from here; try again in a minute.");
			}
		}
	} else if (provider === "steam") {
		const game = requireGame(env, requireString(body, "game", MAX_NAME));
		if (!game.steam_app_id) {
			throw new HttpError(501, "not_configured", "Steam sign-in isn't set up for this game (steam_app_id).");
		}
		verified = { provider: "steam", id: await verifySteamTicket(env.STEAM_WEB_API_KEY, game.steam_app_id, requireString(body, "ticket")) };
	} else if (provider === "game_center") {
		const game = requireGame(env, requireString(body, "game", MAX_NAME));
		const id = await verifyGameCenter(
			{
				publicKeyUrl: requireString(body, "public_key_url", 512),
				signature: requireString(body, "signature"),
				salt: requireString(body, "salt", 256),
				timestamp: Number(body.timestamp),
				teamPlayerId: requireString(body, "team_player_id", 256),
				bundleId: requireString(body, "bundle_id", 256),
			},
			game.bundle_ids ?? [],
		);
		verified = { provider: "game_center", id };
	} else if (provider === "play_games") {
		const gameId = requireString(body, "game", MAX_NAME);
		const game = requireGame(env, gameId);
		if (!game.play_games) {
			throw new HttpError(501, "not_configured", "Google Play Games sign-in isn't set up for this game.");
		}
		verified = { provider: "play_games", id: await verifyPlayGames(playGamesClient(env.PLAY_GAMES_CLIENTS, gameId), requireString(body, "server_auth_code")) };
	} else {
		throw new HttpError(404, "unknown_provider", `No sign-in with "${provider}".`);
	}

	const { account, created } = await signInWithIdentity(env, verified.provider, verified.id, displayName);
	return {
		account_id: account.id,
		display_name: account.display_name,
		name_chosen: Boolean(account.name_chosen),
		created,
		providers: await listProviders(env, account.id),
		...(await createSession(env, account.id, "account")),
	};
}
