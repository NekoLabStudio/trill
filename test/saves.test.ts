import { describe, expect, it } from "vitest";
import { call, deviceAccount, emailAccount, save, testEnv, text } from "./helpers";

describe("saves", () => {
	it("writes, reads and lists a save", async () => {
		const player = await emailAccount();
		const written = await save(player.token, "main", "chapter one", 0, { level: 3, playtime: 600 });
		expect(written).toEqual({ status: 200, body: { version: 1 } });

		const read = await call("GET", "/saves/test/main", { token: player.token });
		expect(await text(read)).toBe("chapter one");
		expect(read.headers.get("x-save-version")).toBe("1");
		expect(JSON.parse(read.headers.get("x-save-summary")!)).toEqual({ level: 3, playtime: 600 });

		const list = (await (await call("GET", "/saves/test", { token: player.token })).json()) as any;
		expect(list.saves).toHaveLength(1);
		expect(list.saves[0]).toMatchObject({ game: "test", slot: "main", version: 1, summary: { level: 3, playtime: 600 } });
	});

	it("rejects a write from a device that hasn't seen the latest save", async () => {
		const player = await emailAccount();
		await save(player.token, "main", "one", 0);
		await save(player.token, "main", "two", 1);
		const stale = await save(player.token, "main", "older device", 1);
		expect(stale.status).toBe(409);
		expect(stale.body).toMatchObject({ error: "version_conflict", current_version: 2 });
		const fresh = await save(player.token, "main", "older device", 0);
		expect(fresh.status).toBe(409);
	});

	it("keeps the latest version and two backups", async () => {
		const player = await emailAccount();
		for (let version = 0; version < 5; version++) {
			expect((await save(player.token, "main", `v${version + 1}`, version)).status).toBe(200);
		}
		const backups = await testEnv.SAVES.list({ prefix: `accounts/${player.id}/test/main/backup/` });
		expect(backups.objects.map((object) => object.key.split("/").pop())).toEqual(["0000000003", "0000000004"]);
		expect(await (await testEnv.SAVES.get(`accounts/${player.id}/test/main/backup/0000000004`))!.text()).toBe("v4");
	});

	it("limits a save's size and a player's slots, per game", async () => {
		const player = await emailAccount();
		const tooBig = await save(player.token, "big", "x".repeat(testEnv.MAX_SAVE_BYTES + 1), 0);
		expect(tooBig.status).toBe(413);
		for (let slot = 0; slot < testEnv.MAX_SAVE_SLOTS; slot++) {
			expect((await save(player.token, `slot${slot}`, "data", 0)).status).toBe(200);
		}
		expect((await save(player.token, "one-too-many", "data", 0)).status).toBe(409);

		// A game with its own, smaller limits ("small": 16 bytes, 2 slots), counted on its own.
		const put = (slot: string, data: string) => call("PUT", `/saves/small/${slot}`, { token: player.token, raw: data, headers: { "x-save-version": "0" } });
		expect((await put("a", "x".repeat(17))).status).toBe(413);
		expect((await put("a", "fits")).status).toBe(200);
		expect((await put("b", "fits")).status).toBe(200);
		expect((await put("c", "fits")).status).toBe(409);
	});

	it("holds the slot limit even for new slots written at the same moment", async () => {
		const player = await emailAccount();
		const put = (slot: string) => call("PUT", `/saves/small/${slot}`, { token: player.token, raw: "data", headers: { "x-save-version": "0" } });
		const statuses = (await Promise.all(["a", "b", "c", "d", "e", "f"].map(put))).map((response) => response.status);
		expect(statuses.filter((status) => status === 200)).toHaveLength(2);
		expect((await testEnv.SAVES.list({ prefix: `accounts/${player.id}/small/` })).objects.filter((o) => o.key.endsWith("/current"))).toHaveLength(2);
	});

	it("needs a save's length before reading it", async () => {
		const player = await emailAccount();
		const stream = new ReadableStream({ start: (controller) => { controller.enqueue(new TextEncoder().encode("data")); controller.close(); } });
		const response = await call("PUT", "/saves/test/main", { token: player.token, raw: stream, headers: { "x-save-version": "0" } });
		expect(response.status).toBe(411);
	});

	it("keeps saves only for accounts with an email address", async () => {
		const player = await deviceAccount();
		const refused = await save(player.token, "main", "progress", 0);
		expect(refused.status).toBe(403);
		expect(refused.body.error).toBe("email_required");
		expect((await testEnv.SAVES.list({ prefix: `accounts/${player.id}/` })).objects).toHaveLength(0);
	});

	it("limits how often an account reads and writes", async () => {
		const player = await emailAccount();
		const statuses = [];
		for (let i = 0; i < 70; i++) {
			statuses.push((await call("GET", "/saves/test", { token: player.token })).status);
		}
		expect(statuses).toContain(429);
	});

	it("refuses unknown games and bad slot names", async () => {
		const player = await emailAccount();
		expect((await call("PUT", "/saves/nope/main", { token: player.token, raw: "x", headers: { "x-save-version": "0" } })).status).toBe(404);
		expect((await call("PUT", "/saves/test/Bad%20Slot", { token: player.token, raw: "x", headers: { "x-save-version": "0" } })).status).toBe(400);
	});
});
