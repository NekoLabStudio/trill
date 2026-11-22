import { describe, expect, it, vi } from "vitest";
import { callJson, deviceAccount, testEnv } from "./helpers";
import { CREDENTIAL_SECONDS, iceServers, revokeCredentials } from "../src/turn";
import type { Env } from "../src/env";

describe("TURN credentials", () => {
	it("asks Cloudflare for credentials that last a session, and keeps their username to revoke", async () => {
		const player = await deviceAccount();
		const env = { ...testEnv, TURN_KEY_ID: "key", TURN_KEY_API_TOKEN: "token", TURN_SERVERS: undefined } as Env;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }, { urls: ["turn:turn.cloudflare.com:3478"], username: "abc123", credential: "secret" }] }, { status: 201 }),
		);
		const ice = await iceServers(env, player.id);
		expect(ice.usernames).toEqual(["abc123"]);
		expect(ice.expires_in).toBe(CREDENTIAL_SECONDS);
		expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).ttl).toBe(4 * 3600);
		fetchSpy.mockRestore();

		const revoke = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
		await revokeCredentials(env, ice.usernames);
		expect(String(revoke.mock.calls[0][0])).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key/credentials/abc123/revoke");
		expect(revoke.mock.calls[0][1]?.method).toBe("POST");
		revoke.mockRestore();
	});

	it("gives games that don't renew credentials long ones, as before", async () => {
		const player = await deviceAccount();
		const env = { ...testEnv, TURN_SECRET: "shared" } as Env;
		expect((await iceServers(env, player.id, false)).expires_in).toBe(12 * 3600);
	});

	it("gives each account a limited number a day, then STUN alone", async () => {
		const player = await deviceAccount();
		const env = { ...testEnv, TURN_SECRET: "shared", TURN_DAILY_CREDENTIALS: 2 } as Env;
		expect((await iceServers(env, player.id)).expires_in).toBe(CREDENTIAL_SECONDS);
		expect((await iceServers(env, player.id)).expires_in).toBe(CREDENTIAL_SECONDS);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const third = await iceServers(env, player.id);
		error.mockRestore();
		expect(third.expires_in).toBe(0);
		expect(JSON.stringify(third.servers)).not.toContain("turn:");
		// A day later, the count starts again.
		await testEnv.DB.prepare("UPDATE turn_credentials SET day_started_at = day_started_at - 86400 WHERE account_id = ?").bind(player.id).run();
		expect((await iceServers(env, player.id)).expires_in).toBe(CREDENTIAL_SECONDS);
	});

	it("makes coturn's credentials from the shared secret", async () => {
		const player = await deviceAccount();
		const env = { ...testEnv, TURN_SECRET: "shared" } as Env;
		const [server] = (await iceServers(env, player.id)).servers as { urls: string; username: string; credential: string }[];
		const [expiry] = server.username.split(":");
		expect(Number(expiry)).toBeGreaterThan(Date.now() / 1000 + CREDENTIAL_SECONDS - 60);
		const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("shared"), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
		const expected = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(server.username)))));
		expect(server.credential).toBe(expected);
	});

	it("leaves fixed self-hosted servers as they are", async () => {
		const player = await deviceAccount();
		const ice = await iceServers(testEnv, player.id);
		expect(ice).toEqual({ servers: JSON.parse(testEnv.TURN_SERVERS!), usernames: [], expires_in: 0 });
	});

	it("tells a player in a lobby when their credentials end, and ignores renewing too soon", async () => {
		const host = await deviceAccount();
		const { body: lobby } = await callJson("POST", "/lobbies", { token: host.token, body: { game: "open_relay" } });
		const { call } = await import("./helpers");
		const response = await call("GET", `/lobbies/${lobby.code}/socket?game=open_relay`, { token: host.token, headers: { upgrade: "websocket" } });
		const socket = response.webSocket!;
		const messages: any[] = [];
		const welcome = new Promise<any>((resolve) => socket.addEventListener("message", (event) => resolve(JSON.parse(event.data as string)), { once: true }));
		socket.accept();
		expect((await welcome).ice_expires_in).toBe(0);
		socket.addEventListener("message", (event) => messages.push(JSON.parse(event.data as string)));
		socket.send(JSON.stringify({ type: "renew_ice" }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(messages).toEqual([]);
		socket.close();
	});
});
