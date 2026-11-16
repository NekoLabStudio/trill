// Steam: the client sends a ticket from GetAuthTicketForWebApi("purr-online"), checked with
// Steam's AuthenticateUserTicket using the publisher Web API key.

import { HttpError } from "../http";

export const STEAM_TICKET_IDENTITY = "purr-online";

export async function verifySteamTicket(apiKey: string | undefined, appId: number, ticket: string): Promise<string> {
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
