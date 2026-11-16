import { describe, expect, it, vi } from "vitest";
import { call, callJson, deviceAccount, emailAccount, testEnv } from "./helpers";

describe("signing in", () => {
	it("creates an account for a new device and returns it for the same device", async () => {
		const secret = "a".repeat(40);
		const first = await callJson("POST", "/auth/device", { body: { secret, display_name: "Ivo" } });
		expect(first.status).toBe(200);
		expect(first.body.created).toBe(true);
		const again = await callJson("POST", "/auth/device", { body: { secret } });
		expect(again.body.created).toBe(false);
		expect(again.body.account_id).toBe(first.body.account_id);

		const account = await callJson("GET", "/account", { token: again.body.token });
		expect(account.body).toMatchObject({ id: first.body.account_id, display_name: "Ivo", providers: ["device"], scope: "account" });
	});

	it("refuses a short device secret and a bad token", async () => {
		expect((await call("POST", "/auth/device", { body: { secret: "short" } })).status).toBe(400);
		expect((await call("GET", "/account", { token: "nonsense" })).status).toBe(401);
		expect((await call("GET", "/account")).status).toBe(401);
	});

	it("signs in with Steam and stores no raw Steam ID", async () => {
		const steamId = "76561198000000042";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ response: { params: { result: "OK", steamid: steamId, ownersteamid: steamId, vacbanned: false, publisherbanned: false } } }),
		);
		const signedIn = await callJson("POST", "/auth/steam", { body: { game: "test", ticket: "ab".repeat(20), display_name: "Steamy" } });
		expect(signedIn.status).toBe(200);
		const url = new URL(String(fetchSpy.mock.calls[0][0]));
		expect(url.hostname).toBe("partner.steam-api.com");
		expect(url.searchParams.get("appid")).toBe("480");
		expect(url.searchParams.get("identity")).toBe("purr-online");
		fetchSpy.mockRestore();

		// Nothing in the database holds the raw ID.
		for (const table of ["accounts", "identities", "device_grants", "email_codes"]) {
			const rows = await testEnv.DB.prepare(`SELECT * FROM ${table}`).all();
			expect(JSON.stringify(rows.results)).not.toContain(steamId);
		}
	});

	it("refuses a Steam ticket Steam rejects", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ response: { error: { errorcode: 101 } } }));
		expect((await call("POST", "/auth/steam", { body: { game: "test", ticket: "ab".repeat(20) } })).status).toBe(401);
		fetchSpy.mockRestore();
	});

	it("matches an identity saved under the previous secret and re-saves it under the new one", async () => {
		const secret = "r".repeat(40);
		const first = await callJson("POST", "/auth/device", { body: { secret } });
		const rotated = { ...testEnv, IDENTITY_SECRET: "a-new-secret", IDENTITY_SECRET_PREVIOUS: testEnv.IDENTITY_SECRET, IDENTITY_KEY_VERSION: 2 };
		const { signInWithIdentity } = await import("../src/identities");
		const again = await signInWithIdentity(rotated, "device", secret, "");
		expect(again.account.id).toBe(first.body.account_id);
		const row = await testEnv.DB.prepare("SELECT key_version FROM identities WHERE account_id = ?").bind(first.body.account_id).first<{ key_version: number }>();
		expect(row?.key_version).toBe(2);
	});

	it("deletes an account with its identities and saves", async () => {
		const player = await emailAccount();
		await call("PUT", "/saves/test/main", { token: player.token, raw: "progress", headers: { "x-save-version": "0" } });
		expect((await callJson("DELETE", "/account", { token: player.token })).body.deleted).toBe(player.id);
		expect((await call("GET", "/account", { token: player.token })).status).toBe(401);
		expect((await testEnv.SAVES.list({ prefix: `accounts/${player.id}/` })).objects).toHaveLength(0);
		expect(await testEnv.DB.prepare("SELECT * FROM identities WHERE account_id = ?").bind(player.id).first()).toBeNull();
	});
});
