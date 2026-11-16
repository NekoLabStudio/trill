import { describe, expect, it, vi } from "vitest";
import { call, callJson, deviceAccount, testEnv } from "./helpers";
import { cleanUp } from "../src/cleanup";
import { DAY, now } from "../src/time";

function nextMessage(socket: WebSocket, type?: string): Promise<any> {
	return new Promise((resolve) => {
		const listener = (event: MessageEvent) => {
			const message = JSON.parse(event.data as string);
			if (!type || message.type === type) {
				socket.removeEventListener("message", listener);
				resolve(message);
			}
		};
		socket.addEventListener("message", listener);
	});
}

async function join(code: string, token: string) {
	const response = await call("GET", `/lobbies/${code}/socket?game=test`, { token, headers: { upgrade: "websocket" } });
	if (response.status !== 101) {
		return { status: response.status } as { status: number; socket?: WebSocket; welcome?: any };
	}
	const socket = response.webSocket!;
	const welcome = nextMessage(socket, "welcome");
	socket.accept();
	return { status: 101, socket, welcome: await welcome };
}

async function lobbyWith(host: { token: string }, guest: { token: string }) {
	const { body: lobby } = await callJson("POST", "/lobbies", { token: host.token, body: { game: "test" } });
	const a = await join(lobby.code, host.token);
	const joined = nextMessage(a.socket!, "joined");
	const b = await join(lobby.code, guest.token);
	await joined;
	return { code: lobby.code as string, host: a, guest: b };
}

describe("moderation in lobbies", () => {
	it("lets the host kick a player, who can't come back", async () => {
		const host = await deviceAccount("Host");
		const guest = await deviceAccount("Guest");
		const lobby = await lobbyWith(host, guest);
		const kicked = nextMessage(lobby.guest.socket!, "kicked");
		const left = nextMessage(lobby.host.socket!, "left");
		lobby.host.socket!.send(JSON.stringify({ type: "kick", peer_id: lobby.guest.welcome.peer_id }));
		expect(await kicked).toEqual({ type: "kicked" });
		expect((await left).peer_id).toBe(lobby.guest.welcome.peer_id);
		expect((await join(lobby.code, guest.token)).status).toBe(403);
		lobby.host.socket!.close();
	});

	it("only lets the host kick", async () => {
		const host = await deviceAccount("Host");
		const guest = await deviceAccount("Guest");
		const lobby = await lobbyWith(host, guest);
		lobby.guest.socket!.send(JSON.stringify({ type: "kick", peer_id: 1 }));
		// Still there: the host can still talk to the guest.
		const relayed = nextMessage(lobby.guest.socket!, "signal");
		lobby.host.socket!.send(JSON.stringify({ type: "signal", to: lobby.guest.welcome.peer_id, data: "still here" }));
		expect((await relayed).data).toBe("still here");
		lobby.host.socket!.close();
		lobby.guest.socket!.close();
	});

	it("records a report about a player in the lobby, and drops it after 90 days", async () => {
		const host = await deviceAccount("Host");
		const guest = await deviceAccount("Guest");
		const lobby = await lobbyWith(host, guest);
		lobby.guest.socket!.send(JSON.stringify({ type: "report", peer_id: 1, reason: "cheating", details: "Speed hack\u0000 on lap 2" }));
		lobby.guest.socket!.send(JSON.stringify({ type: "report", peer_id: 1, reason: "made-up reason" }));
		await new Promise((resolve) => setTimeout(resolve, 100));
		const rows = await testEnv.DB.prepare("SELECT * FROM reports WHERE reported_id = ?").bind(host.id).all<any>();
		expect(rows.results).toHaveLength(1);
		expect(rows.results[0]).toMatchObject({ reporter_id: guest.id, reason: "cheating", details: "Speed hack  on lap 2", game: "test" });

		await testEnv.DB.prepare("UPDATE reports SET created_at = ? WHERE reported_id = ?").bind(now() - 91 * DAY, host.id).run();
		await cleanUp(testEnv);
		expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE reported_id = ?").bind(host.id).first<{ n: number }>())!.n).toBe(0);
		lobby.host.socket!.close();
		lobby.guest.socket!.close();
	});

	it("keeps a blocked player out of the blocker's lobbies", async () => {
		const host = await deviceAccount("Host");
		const guest = await deviceAccount("Guest");
		const lobby = await lobbyWith(host, guest);
		lobby.host.socket!.send(JSON.stringify({ type: "block", peer_id: lobby.guest.welcome.peer_id }));
		await new Promise((resolve) => setTimeout(resolve, 100));
		lobby.guest.socket!.close();
		lobby.host.socket!.close();

		const { body: next } = await callJson("POST", "/lobbies", { token: host.token, body: { game: "test" } });
		const again = await join(next.code, host.token);
		expect((await join(next.code, guest.token)).status).toBe(403);
		again.socket!.close();
	});

	it("keeps a banned player out of multiplayer, and lets them save", async () => {
		const player = await deviceAccount();
		await testEnv.DB.prepare("UPDATE accounts SET banned_until = ? WHERE id = ?").bind(now() + DAY, player.id).run();
		const refused = await callJson("POST", "/lobbies", { token: player.token, body: { game: "test" } });
		expect(refused.status).toBe(403);
		expect(refused.body.error).toBe("banned");
		expect((await call("GET", "/matchmaking/test/ranked/socket?players=2", { token: player.token, headers: { upgrade: "websocket" } })).status).toBe(403);
		expect((await call("GET", "/saves/test", { token: player.token })).status).toBe(200);
	});
});

describe("a ban outliving the account", () => {
	it("comes back when a deleted banned account's player signs in again, and goes once it ends", async () => {
		const player = await deviceAccount("Banned");
		const until = now() + 7 * DAY;
		await testEnv.DB.prepare("UPDATE accounts SET banned_until = ?, auto_bans = 1 WHERE id = ?").bind(until, player.id).run();
		expect((await call("DELETE", "/account", { token: player.token })).status).toBe(200);
		// Only the identity's keyed hash and the ban are kept.
		const kept = await testEnv.DB.prepare("SELECT * FROM banned_identities").all();
		expect(kept.results).toHaveLength(1);
		expect(Object.keys(kept.results[0] as object).sort()).toEqual(["auto_bans", "banned_until", "identity_hash"]);
		expect(JSON.stringify(kept.results)).not.toContain(player.secret);

		const again = await callJson("POST", "/auth/device", { body: { game: "test", secret: player.secret } });
		expect(again.body.created).toBe(true);
		expect(await testEnv.DB.prepare("SELECT banned_until, auto_bans FROM accounts WHERE id = ?").bind(again.body.account_id).first()).toEqual({ banned_until: until, auto_bans: 1 });
		expect((await callJson("POST", "/lobbies", { token: again.body.token, body: { game: "example" } })).status).toBe(403);

		// Once the ban has ended, nothing is kept and a new account starts clean.
		await testEnv.DB.prepare("UPDATE banned_identities SET banned_until = ?").bind(now() - 1).run();
		await cleanUp(testEnv);
		expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM banned_identities").first<{ n: number }>())!.n).toBe(0);
	});

	it("keeps nothing when an account that isn't banned is deleted", async () => {
		const player = await deviceAccount("Fine");
		await call("DELETE", "/account", { token: player.token });
		expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM banned_identities").first<{ n: number }>())!.n).toBe(0);
	});
});

describe("host migration", () => {
	it("makes whoever has been in the lobby longest the host when the host leaves", async () => {
		const host = await deviceAccount("Host");
		const second = await deviceAccount("Second");
		const third = await deviceAccount("Third");
		const lobby = await lobbyWith(host, second);
		const joined = nextMessage(lobby.host.socket!, "joined");
		const c = await join(lobby.code, third.token);
		await joined;

		const promoted = nextMessage(lobby.guest.socket!, "host_changed");
		const told = nextMessage(c.socket!, "host_changed");
		lobby.host.socket!.close();
		expect(await promoted).toEqual({ type: "host_changed", old_peer_id: lobby.guest.welcome.peer_id, you: true });
		expect(await told).toEqual({ type: "host_changed", old_peer_id: lobby.guest.welcome.peer_id, you: false });

		// Signals for peer 1 now reach the new host.
		const relayed = nextMessage(lobby.guest.socket!, "signal");
		c.socket!.send(JSON.stringify({ type: "signal", to: 1, data: "hello new host" }));
		expect(await relayed).toEqual({ type: "signal", from: c.welcome.peer_id, data: "hello new host" });
		lobby.guest.socket!.close();
		c.socket!.close();
	});
});

describe("automatic bans", () => {
	it("bans after repeated removals for cheating, longer each time, then for good", async () => {
		const { recordCheatKick } = await import("../src/moderation");
		const player = await deviceAccount("Repeat offender");
		const bannedFor = async () => {
			const row = await testEnv.DB.prepare("SELECT banned_until FROM accounts WHERE id = ?").bind(player.id).first<{ banned_until: number }>();
			return row!.banned_until === 0 ? 0 : Math.round((row!.banned_until - now()) / DAY);
		};
		expect(testEnv.AUTO_BAN).toEqual({ kicks: 3, within_days: 30, ban_days: [1, 7, 30, null] });
		await recordCheatKick(testEnv, player.id, "test");
		await recordCheatKick(testEnv, player.id, "test");
		expect(await bannedFor()).toBe(0);
		for (const days of [1, 7, 30]) {
			for (let i = 0; i < 3; i++) {
				await recordCheatKick(testEnv, player.id, "test");
			}
			expect(await bannedFor()).toBe(days);
		}
		for (let i = 0; i < 3; i++) {
			await recordCheatKick(testEnv, player.id, "test");
		}
		expect(await bannedFor()).toBeGreaterThan(300 * 365);
		expect((await callJson("POST", "/lobbies", { token: player.token, body: { game: "test" } })).body.error).toBe("banned");
	});

	it("only counts removals within the window", async () => {
		const { recordCheatKick } = await import("../src/moderation");
		const player = await deviceAccount();
		await recordCheatKick(testEnv, player.id, "test");
		await recordCheatKick(testEnv, player.id, "test");
		await testEnv.DB.prepare("UPDATE cheat_kicks SET at = ? WHERE account_id = ?").bind(now() - 31 * DAY, player.id).run();
		await recordCheatKick(testEnv, player.id, "test");
		const row = await testEnv.DB.prepare("SELECT banned_until FROM accounts WHERE id = ?").bind(player.id).first<{ banned_until: number }>();
		expect(row!.banned_until).toBe(0);
	});

	it("counts a lobby's removal for cheating", async () => {
		const players = await Promise.all(["A", "B", "C"].map((name) => deviceAccount(name)));
		const { body: lobby } = await callJson("POST", "/lobbies", { token: players[0].token, body: { game: "strict" } });
		const sockets = [];
		for (const player of players) {
			const response = await call("GET", `/lobbies/${lobby.code}/socket?game=strict`, { token: player.token, headers: { upgrade: "websocket" } });
			const socket = response.webSocket!;
			const welcome = nextMessage(socket, "welcome");
			socket.accept();
			sockets.push({ socket, welcome: await welcome });
		}
		const kicked = nextMessage(sockets[2].socket, "kicked");
		for (const [index, value] of ["1", "1", "2"].entries()) {
			sockets[index].socket.send(JSON.stringify({ type: "check", name: "score", value }));
		}
		await kicked;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM cheat_kicks WHERE account_id = ?").bind(players[2].id).first<{ n: number }>())!.n).toBe(1);
		sockets[0].socket.close();
		sockets[1].socket.close();
	});
});

describe("report rules", () => {
	const rules = {
		ban: { reasons: ["cheating", "abuse"], reporters: 3, within_days: 7, min_reporter_age_days: 7, ban_days: [1, null] },
		rename: { reasons: ["name"], reporters: 2, within_days: 7, min_reporter_age_days: 7 },
	};
	const env = { ...testEnv, REPORT_RULES: rules };

	// Reporters whose accounts are old enough to count.
	async function reporters(count: number, ageDays = 30) {
		const accounts = await Promise.all(Array.from({ length: count }, (_, i) => deviceAccount(`Reporter ${i}`)));
		for (const account of accounts) {
			await testEnv.DB.prepare("UPDATE accounts SET created_at = ? WHERE id = ?").bind(now() - ageDays * DAY, account.id).run();
		}
		return accounts;
	}
	const account = (id: string) => testEnv.DB.prepare("SELECT display_name, name_chosen, banned_until FROM accounts WHERE id = ?").bind(id).first<any>();

	it("bans once enough different players report, longer the next time", async () => {
		const { report } = await import("../src/moderation");
		const target = await deviceAccount("Target");
		const [a, b, c, d, e, f] = await reporters(6);
		await report(env, "test", a.id, target.id, "cheating", "");
		await report(env, "test", a.id, target.id, "cheating", "again");
		await report(env, "test", b.id, target.id, "abuse", "");
		expect((await account(target.id)).banned_until).toBe(0);
		await report(env, "test", c.id, target.id, "cheating", "");
		expect(Math.round(((await account(target.id)).banned_until - now()) / DAY)).toBe(1);
		// Those reports were acted on; the next ban needs three new reporters, and is for good.
		await report(env, "test", d.id, target.id, "cheating", "");
		await report(env, "test", e.id, target.id, "cheating", "");
		expect(Math.round(((await account(target.id)).banned_until - now()) / DAY)).toBe(1);
		await report(env, "test", f.id, target.id, "cheating", "");
		expect((await account(target.id)).banned_until).toBeGreaterThan(now() + 300 * 365 * DAY);
	});

	it("resets the name after reports about it", async () => {
		const { report } = await import("../src/moderation");
		const target = await deviceAccount("Rude name");
		await callJson("PUT", "/account/name", { token: target.token, body: { display_name: "Ruder name" } });
		const [a, b] = await reporters(2);
		await report(env, "test", a.id, target.id, "name", "");
		expect((await account(target.id)).display_name).toBe("Ruder name");
		await report(env, "test", b.id, target.id, "name", "");
		expect(await account(target.id)).toMatchObject({ display_name: "", name_chosen: 0, banned_until: 0 });
	});

	it("doesn't count new accounts, other reasons, old reports or the anti-cheat's", async () => {
		const { report } = await import("../src/moderation");
		const target = await deviceAccount("Target");
		const [fresh] = await reporters(1, 1);
		const [a, b, c] = await reporters(3);
		await report(env, "test", fresh.id, target.id, "cheating", "");
		await report(env, "test", a.id, target.id, "other", "");
		await report(env, "test", b.id, target.id, "cheating", "", true);
		await report(env, "test", c.id, target.id, "cheating", "");
		await testEnv.DB.prepare("UPDATE reports SET created_at = ? WHERE reporter_id = ?").bind(now() - 8 * DAY, c.id).run();
		await report(env, "test", a.id, target.id, "cheating", "");
		expect((await account(target.id)).banned_until).toBe(0);
	});

	it("does nothing without REPORT_RULES", async () => {
		const { report } = await import("../src/moderation");
		const target = await deviceAccount("Target");
		for (const reporter of await reporters(6)) {
			await report(testEnv, "test", reporter.id, target.id, "cheating", "");
			await report(testEnv, "test", reporter.id, target.id, "name", "");
		}
		expect(await account(target.id)).toMatchObject({ display_name: "Target", banned_until: 0 });
	});
});

describe("the daily moderation email", () => {
	it("lists the players reported in the last day, without what reporters wrote", async () => {
		const { report } = await import("../src/moderation");
		const { sendModerationDigest } = await import("../src/moderation_digest");
		await testEnv.DB.prepare("DELETE FROM reports").run();
		const env = { ...testEnv, MODERATION_EMAIL: "mods@example.com" };
		expect(await sendModerationDigest(env)).toBe(false);

		const target = await deviceAccount("Digest target");
		const [a, b] = await Promise.all([deviceAccount("A"), deviceAccount("B")]);
		await report(env, "test", a.id, target.id, "cheating", "secret details");
		await report(env, "test", b.id, target.id, "name", "");
		await report(env, "test", b.id, target.id, "cheating", "", true);
		const old = await deviceAccount("Old news");
		await report(env, "test", a.id, old.id, "abuse", "");
		await testEnv.DB.prepare("UPDATE reports SET created_at = ? WHERE reported_id = ?").bind(now() - 2 * DAY, old.id).run();

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		expect(await sendModerationDigest(testEnv)).toBe(false);
		expect(await sendModerationDigest(env)).toBe(true);
		const sent = log.mock.calls.map((args) => String(args[0]));
		log.mockRestore();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("[email] to mods@example.com: Players reported today: 1");
		expect(sent[0]).toContain(`Digest target (${target.id}): 3 reports from 2 players, 1 by the anti-cheat; cheating, name`);
		expect(sent[0]).not.toContain("secret details");
		expect(sent[0]).not.toContain("Old news");
	});
});
