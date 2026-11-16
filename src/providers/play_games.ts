// Google Play Games: the client requests a server auth code, which is exchanged with Google for
// an access token, then the player is read from the Play Games API. The game-scoped player ID
// (gamePlayerId) is used: Google warns that the developer-wide key changes if a game moves to
// another developer account, so it isn't a stable key. A player's Play Games identity is
// therefore per game.

import { HttpError } from "../http";

export interface PlayGamesClient {
	client_id: string;
	client_secret: string;
}

export function playGamesClient(clientsJson: string | undefined, game: string): PlayGamesClient {
	let clients: Record<string, PlayGamesClient> = {};
	try {
		clients = clientsJson ? JSON.parse(clientsJson) : {};
	} catch {
		// Falls through to the error below.
	}
	const client = clients[game];
	if (!client?.client_id || !client.client_secret) {
		throw new HttpError(501, "not_configured", `Google Play Games sign-in isn't set up for "${game}" (PLAY_GAMES_CLIENTS).`);
	}
	return client;
}

export async function verifyPlayGames(client: PlayGamesClient, serverAuthCode: string): Promise<string> {
	const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code: serverAuthCode,
			client_id: client.client_id,
			client_secret: client.client_secret,
			grant_type: "authorization_code",
			redirect_uri: "",
		}),
	});
	if (!tokenResponse.ok) {
		throw new HttpError(401, "invalid_code", "Google didn't accept the server auth code.");
	}
	const { access_token } = (await tokenResponse.json()) as { access_token?: string };
	const playerResponse = await fetch("https://games.googleapis.com/games/v1/players/me", {
		headers: { authorization: `Bearer ${access_token}` },
	});
	if (!playerResponse.ok) {
		throw new HttpError(502, "provider_unavailable", `Google Play Games answered ${playerResponse.status}.`);
	}
	const player = (await playerResponse.json()) as { gamePlayerId?: string; playerId?: string };
	// Only the game-scoped ID, never the developer-wide one, so one player is never two accounts.
	const id = player.gamePlayerId;
	if (!id) {
		throw new HttpError(502, "provider_unavailable", "Google Play Games didn't say who the player is.");
	}
	return id;
}
