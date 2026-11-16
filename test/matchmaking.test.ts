import { describe, expect, it } from "vitest";
import { call, callJson, deviceAccount, testEnv } from "./helpers";
import { eloChanges } from "../src/ratings";
import { distanceKm } from "../src/matchmaker";
import worker from "../src/index";

function nextMessage(socket: WebSocket, type: string): Promise<any> {
	return new Promise((resolve) => {
		const listener = (event: MessageEvent) => {
			const message = JSON.parse(event.data as string);
			if (message.type === type) {
				socket.removeEventListener("message", listener);
				resolve(message);
			}
		};
		socket.addEventListener("message", listener);
	});
}

async function queue(token: string, mode = "ranked", players = 2) {
	const response = await call("GET", `/matchmaking/test/${mode}/socket?players=${players}`, { token, headers: { upgrade: "websocket" } });
	expect(response.status).toBe(101);
	const socket = response.webSocket!;
	const matched = nextMessage(socket, "matched");
	socket.accept();
	return { socket, matched };
}

async function join(code: string, token: string) {
	const response = await call("GET", `/lobbies/${code}/socket?game=test`, { token, headers: { upgrade: "websocket" } });
	const socket = response.webSocket!;
	const welcome = nextMessage(socket, "welcome");
	socket.accept();
	return { socket, welcome: await welcome };
}

describe("ratings", () => {
	it("moves ratings like Elo, and as much for eight players as for two", () => {
		const [winner, loser] = eloChanges([1000, 1000]);
		expect(winner).toBeCloseTo(16);
		expect(loser).toBeCloseTo(-16);
		const upset = eloChanges([800, 1200]);
		expect(upset[0]).toBeGreaterThan(16);
		const eight = eloChanges(Array(8).fill(1000));
		expect(eight[0]).toBeCloseTo(16);
		expect(eight[7]).toBeCloseTo(-16);
		expect(eight.reduce((sum, change) => sum + change, 0)).toBeCloseTo(0);
	});
});

describe("matchmaking", () => {
	it("matches two waiting players into a ranked lobby, and the host's result moves their ratings", async () => {
		const mode = `ranked-${crypto.randomUUID().slice(0, 8)}`;
		const a = await deviceAccount("A");
		const b = await deviceAccount("B");
		const first = await queue(a.token, mode);
		const second = await queue(b.token, mode);
		const [matchedA, matchedB] = await Promise.all([first.matched, second.matched]);
		expect(matchedA.code).toBe(matchedB.code);

		const host = await join(matchedA.code, a.token);
		expect(host.welcome).toMatchObject({ peer_id: 1, ranked: true });
		const guest = await join(matchedA.code, b.token);
		// One player's word isn't enough: both must report the same ranking (the default majority).
		host.socket.send(JSON.stringify({ type: "result", ranking: [guest.welcome.peer_id, 1] }));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect((await callJson("GET", `/ratings/test/${mode}`, { token: b.token })).body.matches).toBe(0);
		const recorded = nextMessage(host.socket, "result_recorded");
		guest.socket.send(JSON.stringify({ type: "result", ranking: [guest.welcome.peer_id, 1] }));
		await recorded;

		expect((await callJson("GET", `/ratings/test/${mode}`, { token: b.token })).body).toEqual({ rating: 1016, matches: 1 });
		expect((await callJson("GET", `/ratings/test/${mode}`, { token: a.token })).body).toEqual({ rating: 984, matches: 1 });

		// Once per lobby.
		host.socket.send(JSON.stringify({ type: "result", ranking: [guest.welcome.peer_id, 1] }));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect((await callJson("GET", `/ratings/test/${mode}`, { token: b.token })).body.matches).toBe(1);
		host.socket.close();
		guest.socket.close();
	});

	it("needs a majority to agree, and ignores a ranking nobody else saw", async () => {
		const mode = `ranked-${crypto.randomUUID().slice(0, 8)}`;
		const players = await Promise.all(["A", "B", "C"].map((name) => deviceAccount(name)));
		const queued = await Promise.all(players.map((player) => queue(player.token, mode, 3)));
		const [{ code }] = await Promise.all(queued.map((entry) => entry.matched));
		const sockets = [];
		for (const player of players) {
			sockets.push(await join(code, player.token));
		}
		const ids = sockets.map((entry) => entry.welcome.peer_id);
		const honest = [ids[1], ids[2], ids[0]];
		const cheat = [ids[2], ids[1], ids[0]];
		sockets[2].socket.send(JSON.stringify({ type: "result", ranking: cheat }));
		sockets[0].socket.send(JSON.stringify({ type: "result", ranking: honest }));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect((await callJson("GET", `/ratings/test/${mode}`, { token: players[1].token })).body.matches).toBe(0);
		const recorded = nextMessage(sockets[2].socket, "result_recorded");
		sockets[1].socket.send(JSON.stringify({ type: "result", ranking: honest }));
		await recorded;
		// The honest ranking won: B first.
		expect((await callJson("GET", `/ratings/test/${mode}`, { token: players[1].token })).body.rating).toBeGreaterThan(1000);
		expect((await callJson("GET", `/ratings/test/${mode}`, { token: players[2].token })).body.rating).toBeLessThan(1016);
		sockets.forEach((entry) => entry.socket.close());
	});

	it("matches the nearest players first", async () => {
		const mode = `ranked-${crypto.randomUUID().slice(0, 8)}`;
		const queueAt = async (token: string, latitude: string, longitude: string) => {
			const request = new Request(`http://localhost/matchmaking/test/${mode}/socket?players=2`, {
				headers: { authorization: `Bearer ${token}`, upgrade: "websocket", "cf-connecting-ip": crypto.randomUUID() },
				cf: { latitude, longitude },
			} as RequestInit);
			const response = await worker.fetch(request, testEnv);
			const socket = response.webSocket!;
			const matched = nextMessage(socket, "matched");
			socket.accept();
			return { socket, matched };
		};
		const [london, sydney, paris] = await Promise.all(["London", "Sydney", "Paris"].map((name) => deviceAccount(name)));
		const a = await queueAt(london.token, "51.5", "-0.12");
		const b = await queueAt(sydney.token, "-33.87", "151.21");
		const c = await queueAt(paris.token, "48.86", "2.35");
		const [codeA, codeC] = await Promise.all([a.matched, c.matched]);
		expect(codeA.code).toBe(codeC.code);
		const sydneyMatched = await Promise.race([b.matched.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 300))]);
		expect(sydneyMatched).toBe(false);
		a.socket.close();
		b.socket.close();
		c.socket.close();
	});

	it("measures distance between coordinates", () => {
		expect(distanceKm([51.5, -0.12], [48.86, 2.35])).toBeCloseTo(343, -1);
		expect(distanceKm([51.5, -0.12], null)).toBe(0);
	});

	it("never records results for a lobby made by code", async () => {
		const a = await deviceAccount("A");
		const b = await deviceAccount("B");
		const { body: lobby } = await callJson("POST", "/lobbies", { token: a.token, body: { game: "test" } });
		const host = await join(lobby.code, a.token);
		expect(host.welcome.ranked).toBe(false);
		const guest = await join(lobby.code, b.token);
		host.socket.send(JSON.stringify({ type: "result", ranking: [guest.welcome.peer_id, 1] }));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM ratings WHERE account_id = ?").bind(b.id).first<{ n: number }>())!.n).toBe(0);
		host.socket.close();
		guest.socket.close();
	});

	it("doesn't match players who blocked each other", async () => {
		const mode = `ranked-${crypto.randomUUID().slice(0, 8)}`;
		const a = await deviceAccount("A");
		const b = await deviceAccount("B");
		await testEnv.DB.prepare("INSERT INTO blocks (account_id, blocked_id, created_at) VALUES (?, ?, 0)").bind(a.id, b.id).run();
		const first = await queue(a.token, mode);
		const second = await queue(b.token, mode);
		const outcome = await Promise.race([first.matched.then(() => "matched"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 300))]);
		expect(outcome).toBe("waiting");
		first.socket.close();
		second.socket.close();
	});

	it("refuses a bad lobby size, mode or game", async () => {
		const a = await deviceAccount();
		const ws = { upgrade: "websocket" };
		expect((await call("GET", "/matchmaking/test/ranked/socket?players=9", { token: a.token, headers: ws })).status).toBe(400);
		expect((await call("GET", "/matchmaking/test/Bad%20Mode/socket?players=2", { token: a.token, headers: ws })).status).toBe(400);
		expect((await call("GET", "/matchmaking/nope/ranked/socket?players=2", { token: a.token, headers: ws })).status).toBe(404);
	});
});

describe("checks in ranked lobbies", () => {
	it("doesn't count a result after a failed check", async () => {
		const mode = `ranked-${crypto.randomUUID().slice(0, 8)}`;
		const a = await deviceAccount("A");
		const b = await deviceAccount("B");
		const [first, second] = [await queue(a.token, mode), await queue(b.token, mode)];
		const { code } = await first.matched;
		await second.matched;
		const host = await join(code, a.token);
		const guest = await join(code, b.token);
		const checked = nextMessage(host.socket, "check_result");
		host.socket.send(JSON.stringify({ type: "check", name: "finish", value: "1" }));
		guest.socket.send(JSON.stringify({ type: "check", name: "finish", value: "2" }));
		expect((await checked).agreed).toBe(false);
		for (const player of [host, guest]) {
			player.socket.send(JSON.stringify({ type: "result", ranking: [guest.welcome.peer_id, 1] }));
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect((await callJson("GET", `/ratings/test/${mode}`, { token: b.token })).body.matches).toBe(0);
		host.socket.close();
		guest.socket.close();
	});
});
