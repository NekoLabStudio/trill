import { describe, expect, it } from "vitest";
import { call, callJson, deviceAccount, testEnv } from "./helpers";

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

async function lobbyOf(count: number, game = "test") {
	const players = await Promise.all(Array.from({ length: count }, (_, i) => deviceAccount(`P${i}`)));
	const { body: lobby } = await callJson("POST", "/lobbies", { token: players[0].token, body: { game } });
	const sockets = [];
	for (const player of players) {
		const response = await call("GET", `/lobbies/${lobby.code}/socket?game=${game}`, { token: player.token, headers: { upgrade: "websocket" } });
		const socket = response.webSocket!;
		const welcome = nextMessage(socket, "welcome");
		socket.accept();
		sockets.push({ socket, welcome: await welcome, account: player.id });
	}
	return sockets;
}

const send = (socket: WebSocket, name: string, value: string) => socket.send(JSON.stringify({ type: "check", name, value }));

describe("checks", () => {
	it("tells everyone when they agree", async () => {
		const players = await lobbyOf(3);
		const results = players.map((player) => nextMessage(player.socket, "check_result"));
		players.forEach((player) => send(player.socket, "lap_1", "abc"));
		for (const result of await Promise.all(results)) {
			expect(result).toEqual({ type: "check_result", name: "lap_1", agreed: true, disagreeing: [] });
		}
		players.forEach((player) => player.socket.close());
	});

	it("names the player who differs from the majority, and reports them", async () => {
		const players = await lobbyOf(3);
		const result = nextMessage(players[0].socket, "check_result");
		send(players[0].socket, "score", "120");
		send(players[1].socket, "score", "120");
		send(players[2].socket, "score", "999");
		expect(await result).toEqual({ type: "check_result", name: "score", agreed: false, disagreeing: [players[2].welcome.peer_id] });
		await new Promise((resolve) => setTimeout(resolve, 100));
		const reports = await testEnv.DB.prepare("SELECT reason, details FROM reports WHERE reported_id = ?").bind(players[2].account).all<any>();
		expect(reports.results).toHaveLength(1);
		expect(reports.results[0].reason).toBe("cheating");
		expect(reports.results[0].details).toContain("score");
		players.forEach((player) => player.socket.close());
	});

	it("blames nobody without a majority", async () => {
		const players = await lobbyOf(2);
		const result = nextMessage(players[0].socket, "check_result");
		send(players[0].socket, "lap_2", "a");
		send(players[1].socket, "lap_2", "b");
		expect(await result).toEqual({ type: "check_result", name: "lap_2", agreed: false, disagreeing: [] });
		players.forEach((player) => player.socket.close());
	});

	it("settles with the players left when someone leaves before answering", async () => {
		const players = await lobbyOf(3);
		const result = nextMessage(players[0].socket, "check_result");
		send(players[0].socket, "lap_3", "same");
		send(players[1].socket, "lap_3", "same");
		players[2].socket.close();
		expect(await result).toMatchObject({ name: "lap_3", agreed: true });
		players[0].socket.close();
		players[1].socket.close();
	});

	it("counts each player's first answer only, and ignores bad names", async () => {
		const players = await lobbyOf(2);
		const result = nextMessage(players[0].socket, "check_result");
		send(players[0].socket, "bad name!", "x");
		send(players[0].socket, "lap_4", "x");
		send(players[0].socket, "lap_4", "y");
		send(players[1].socket, "lap_4", "x");
		expect(await result).toEqual({ type: "check_result", name: "lap_4", agreed: true, disagreeing: [] });
		players.forEach((player) => player.socket.close());
	});
});

const flag = (socket: WebSocket, peerId: number, reason: string) => socket.send(JSON.stringify({ type: "flag", peer_id: peerId, reason }));

describe("flags", () => {
	it("confirms a flag once most of the other players, and at least two, flag the same player", async () => {
		const players = await lobbyOf(4);
		const target = players[3].welcome.peer_id;
		let early = false;
		players[0].socket.addEventListener("message", (event) => {
			if (JSON.parse(event.data as string).type === "flagged") early = true;
		});
		flag(players[0].socket, target, "teleport");
		flag(players[0].socket, target, "teleport"); // The same player twice counts once.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(early).toBe(false);

		const flagged = players.map((player) => nextMessage(player.socket, "flagged"));
		flag(players[1].socket, target, "teleport");
		for (const result of await Promise.all(flagged)) {
			expect(result).toEqual({ type: "flagged", peer_id: target, reason: "teleport" });
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
		const reports = await testEnv.DB.prepare("SELECT details FROM reports WHERE reported_id = ?").bind(players[3].account).all<any>();
		expect(reports.results).toHaveLength(1);
		expect(reports.results[0].details).toContain("teleport");
		players.forEach((player) => player.socket.close());
	});

	it("never confirms a flag in a lobby of two, or from a player about themselves", async () => {
		const players = await lobbyOf(2);
		let flagged = false;
		for (const player of players) {
			player.socket.addEventListener("message", (event) => {
				if (JSON.parse(event.data as string).type === "flagged") flagged = true;
			});
		}
		flag(players[0].socket, players[1].welcome.peer_id, "teleport");
		flag(players[1].socket, players[1].welcome.peer_id, "teleport");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(flagged).toBe(false);
		players.forEach((player) => player.socket.close());
	});
});

describe("removing cheaters", () => {
	it("removes the player a check names, in a game with kick_cheaters on", async () => {
		const players = await lobbyOf(3, "strict");
		const kicked = nextMessage(players[2].socket, "kicked");
		const left = nextMessage(players[0].socket, "left");
		send(players[0].socket, "score", "1");
		send(players[1].socket, "score", "1");
		send(players[2].socket, "score", "2");
		expect(await kicked).toEqual({ type: "kicked" });
		expect((await left).peer_id).toBe(players[2].welcome.peer_id);
		players[0].socket.close();
		players[1].socket.close();
	});

	it("removes a flagged host, and the next player takes over", async () => {
		const players = await lobbyOf(3, "strict");
		const kicked = nextMessage(players[0].socket, "kicked");
		const promoted = nextMessage(players[1].socket, "host_changed");
		flag(players[1].socket, 1, "teleport");
		flag(players[2].socket, 1, "teleport");
		expect(await kicked).toEqual({ type: "kicked" });
		expect((await promoted).you).toBe(true);
		players[1].socket.close();
		players[2].socket.close();
	});

	it("leaves the player in a game without kick_cheaters", async () => {
		const players = await lobbyOf(3);
		let kicked = false;
		players[2].socket.addEventListener("message", (event) => {
			if (JSON.parse(event.data as string).type === "kicked") kicked = true;
		});
		const result = nextMessage(players[0].socket, "check_result");
		send(players[0].socket, "score", "1");
		send(players[1].socket, "score", "1");
		send(players[2].socket, "score", "2");
		await result;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(kicked).toBe(false);
		players.forEach((player) => player.socket.close());
	});
});
