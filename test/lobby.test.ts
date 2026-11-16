import { describe, expect, it } from "vitest";
import { call, callJson, deviceAccount, testEnv } from "./helpers";

function nextMessage(socket: WebSocket): Promise<any> {
	return new Promise((resolve) => socket.addEventListener("message", (event) => resolve(JSON.parse(event.data as string)), { once: true }));
}

async function join(code: string, token: string) {
	const response = await call("GET", `/lobbies/${code}/socket?game=test`, { token, headers: { upgrade: "websocket" } });
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
		expect(a.welcome).toEqual({ type: "welcome", peer_id: 1, members: [], ranked: false });

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

	it("gives STUN-only ICE servers when no TURN is configured", async () => {
		const player = await deviceAccount();
		expect((await callJson("GET", "/turn", { token: player.token })).body).toEqual({ ice_servers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
		expect(testEnv.TURN_KEY_ID).toBeUndefined();
	});
});
