import { describe, expect, it, vi } from "vitest";
import { call, callJson, deviceAccount, testEnv } from "./helpers";

function nextMessage(socket: WebSocket): Promise<any> {
	return new Promise((resolve) => socket.addEventListener("message", (event) => resolve(JSON.parse(event.data as string)), { once: true }));
}

async function join(code: string, token: string, game = "test") {
	const response = await call("GET", `/lobbies/${code}/socket?game=${game}`, { token, headers: { upgrade: "websocket" } });
	expect(response.status).toBe(101);
	const socket = response.webSocket!;
	const welcome = nextMessage(socket);
	socket.accept();
	return { socket, welcome: await welcome };
}

describe("lobbies", () => {
	it("joins by code and relays signalling between the players", async () => {
		const host = await deviceAccount("Host");
		const friend = await deviceAccount("Friend");
		const { body: lobby } = await callJson("POST", "/lobbies", { token: host.token, body: { game: "test" } });
		expect(lobby.code).toMatch(/^[0-9A-Z]{6}$/);

		const a = await join(lobby.code, host.token);
		expect(a.welcome).toEqual({ type: "welcome", peer_id: 1, members: [], ranked: false, ice_servers: [{ urls: "stun:stun.cloudflare.com:3478" }], ice_expires_in: 0 });

		const joined = nextMessage(a.socket);
		const b = await join(lobby.code.toLowerCase(), friend.token);
		expect(b.welcome.members).toEqual([{ peer_id: 1, display_name: "Host" }]);
		expect(await joined).toEqual({ type: "joined", peer_id: b.welcome.peer_id, display_name: "Friend" });

		const relayed = nextMessage(a.socket);
		b.socket.send(JSON.stringify({ type: "signal", to: 1, data: { offer: "sdp..." } }));
		expect(await relayed).toEqual({ type: "signal", from: b.welcome.peer_id, data: { offer: "sdp..." } });

		const left = nextMessage(a.socket);
		b.socket.close();
		expect(await left).toEqual({ type: "left", peer_id: b.welcome.peer_id });
		a.socket.close();
	});

	it("refuses unknown lobbies, malformed codes, another game's lobby and plain requests", async () => {
		const player = await deviceAccount();
		const ws = { upgrade: "websocket" };
		expect((await call("GET", "/lobbies/ZZZZZZ/socket?game=test", { token: player.token, headers: ws })).status).toBe(404);
		expect((await call("GET", "/lobbies/not-a-code-at-all/socket?game=test", { token: player.token, headers: ws })).status).toBe(404);
		expect((await call("GET", "/lobbies/ZZZZZZ/socket?game=test", { token: player.token })).status).toBe(426);

		const { body: lobby } = await callJson("POST", "/lobbies", { token: player.token, body: { game: "test" } });
		expect((await call("GET", `/lobbies/${lobby.code}/socket?game=small`, { token: player.token, headers: ws })).status).toBe(404);
		expect((await call("GET", `/lobbies/${lobby.code}/socket`, { token: player.token, headers: ws })).status).toBe(404);
	});

	it("passes on names in any script, and lets one account in twice at most", async () => {
		const player = await deviceAccount("ミチ 🐱");
		const { body: lobby } = await callJson("POST", "/lobbies", { token: player.token, body: { game: "test" } });
		const a = await join(lobby.code, player.token);
		const joined = nextMessage(a.socket);
		const b = await join(lobby.code, player.token);
		expect((await joined).display_name).toBe("ミチ 🐱");
		expect((await call("GET", `/lobbies/${lobby.code}/socket?game=test`, { token: player.token, headers: { upgrade: "websocket" } })).status).toBe(409);
		a.socket.close();
		b.socket.close();
	});

	it("gives TURN only to players in a lobby whom a platform signed in", async () => {
		const stunOnly = [{ urls: "stun:stun.cloudflare.com:3478" }];
		const turn = JSON.parse(testEnv.TURN_SERVERS!);
		const player = await deviceAccount();
		expect((await call("GET", "/turn", { token: player.token })).status).toBe(404);

		// A device account: STUN only.
		const { body: lobby } = await callJson("POST", "/lobbies", { token: player.token, body: { game: "test" } });
		const device = await join(lobby.code, player.token);
		expect(device.welcome.ice_servers).toEqual(stunOnly);

		// Signed in through Steam: TURN, even sending its own say-so for it.
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ response: { params: { result: "OK", steamid: "76561198000000077", ownersteamid: "76561198000000077", vacbanned: false, publisherbanned: false } } }),
		);
		const steam = (await callJson("POST", "/auth/steam", { body: { game: "test", ticket: "cd".repeat(20) } })).body;
		fetchSpy.mockRestore();
		const steamPlayer = await join(lobby.code, steam.token);
		expect(steamPlayer.welcome.ice_servers).toEqual(turn);
		const forged = await call("GET", `/lobbies/${lobby.code}/socket?game=test`, { token: player.token, headers: { upgrade: "websocket", "x-turn": "1" } });
		const forgedWelcome = nextMessage(forged.webSocket!);
		forged.webSocket!.accept();
		expect((await forgedWelcome).ice_servers).toEqual(stunOnly);

		// A game that gives TURN to everyone.
		const { body: open } = await callJson("POST", "/lobbies", { token: player.token, body: { game: "open_relay" } });
		const openPlayer = await join(open.code, player.token, "open_relay");
		expect(openPlayer.welcome.ice_servers).toEqual(turn);

		for (const socket of [device.socket, steamPlayer.socket, forged.webSocket!, openPlayer.socket]) {
			socket.close();
		}
	});
});
