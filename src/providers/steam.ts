// Steam: the client sends a ticket from GetAuthTicketForWebApi("trill"), checked with
// Steam's AuthenticateUserTicket using the publisher Web API key. Whether the player owns the game
// is CheckAppOwnership, with the same key.

import { HttpError } from "../http";

export const STEAM_TICKET_IDENTITY = "trill";

// The Steam ID the ticket is for. A ticket is made for the app that's running, so a game's other
// app IDs (a Playtest's) are tried after its own.
export async function verifySteamTicket(apiKey: string | undefined, appIds: number | number[], ticket: string): Promise<string> {
	const ids = Array.isArray(appIds) ? appIds : [appIds];
	for (let i = 0; i < ids.length; i++) {
		try {
			return await verifyTicketForApp(apiKey, ids[i], ticket);
		} catch (error) {
			if (i === ids.length - 1 || !(error instanceof HttpError) || error.code !== "invalid_ticket") {
				throw error;
			}
		}
	}
	throw new HttpError(401, "invalid_ticket", "Steam didn't accept the ticket.");
}

async function verifyTicketForApp(apiKey: string | undefined, appId: number, ticket: string): Promise<string> {
	if (!apiKey) {
		throw new HttpError(501, "not_configured", "Steam sign-in isn't set up (STEAM_WEB_API_KEY).");
	}
	if (!/^[0-9a-fA-F]{16,4096}$/.test(ticket)) {
		throw new HttpError(400, "bad_request", '"ticket" must be the ticket as hex.');
	}
	const url = new URL("https://partner.steam-api.com/ISteamUserAuth/AuthenticateUserTicket/v1/");
	url.searchParams.set("key", apiKey);
	url.searchParams.set("appid", String(appId));
	url.searchParams.set("ticket", ticket);
	url.searchParams.set("identity", STEAM_TICKET_IDENTITY);
	const response = await fetch(url);
	if (!response.ok) {
		throw new HttpError(502, "provider_unavailable", `Steam answered ${response.status}.`);
	}
	const body = (await response.json()) as {
		response?: { params?: { result?: string; steamid?: string; vacbanned?: boolean; publisherbanned?: boolean }; error?: unknown };
	};
	const params = body.response?.params;
	if (params?.result !== "OK" || !params.steamid) {
		throw new HttpError(401, "invalid_ticket", "Steam didn't accept the ticket.");
	}
	if (params.publisherbanned) {
		throw new HttpError(403, "banned", "This Steam account is banned by the publisher.");
	}
	return params.steamid;
}

// Whether the player has a licence for any of these apps (the game, or a Playtest of it). Family
// Sharing and free weekends count: Steam lets those players play.
export async function steamOwnsAny(apiKey: string | undefined, steamId: string, appIds: number[]): Promise<boolean> {
	if (!apiKey) {
		throw new HttpError(501, "not_configured", "Steam isn't set up (STEAM_WEB_API_KEY).");
	}
	for (const appId of appIds) {
		const url = new URL("https://partner.steam-api.com/ISteamUser/CheckAppOwnership/v4/");
		url.searchParams.set("key", apiKey);
		url.searchParams.set("steamid", steamId);
		url.searchParams.set("appid", String(appId));
		const response = await fetch(url);
		if (!response.ok) {
			throw new HttpError(502, "provider_unavailable", `Steam answered ${response.status}.`);
		}
		const body = (await response.json()) as { appownership?: { ownsapp?: boolean } };
		if (body.appownership?.ownsapp === true) {
			return true;
		}
	}
	return false;
}
