import { describe, expect, it } from "vitest";
import { call, callJson, deviceAccount, emailCode, emailAccount, newEmail, save, testEnv, text } from "./helpers";

// The guest types their address on the host's device, and the code they get.
async function bring(host: { token: string }, email: string, remember: boolean, extra: Record<string, unknown> = {}) {
	const { code, challenge } = await emailCode(email, { hostToken: host.token });
	return callJson("POST", "/guest/email/verify", { token: host.token, body: { email, code, challenge, remember, game: "test", device_label: "Living room Apple TV", ...extra } });
}

describe("guests", () => {
	it("brings a profile with an email: the host gets a guest token that can only load and save", async () => {
		const host = await deviceAccount("Host");
		const guest = await emailAccount("Inês");
		const lent = (await bring(host, guest.email, false)).body;
		expect(lent).toMatchObject({ kind: "guest", account_id: guest.id, display_name: "Inês" });

		expect((await save(lent.token, "character", "inês's character", 0)).status).toBe(200);
		expect(await text(await call("GET", "/saves/test/character", { token: guest.token }))).toBe("inês's character");
		// Never more than load and save.
		expect((await call("DELETE", "/account", { token: lent.token })).status).toBe(403);
		expect((await call("GET", "/grants", { token: lent.token })).status).toBe(403);
		expect((await call("POST", "/guest/email/start", { token: lent.token, body: { email: newEmail(), game: "test" } })).status).toBe(403);
		// Nor lobbies or the account's details.
		expect((await call("POST", "/lobbies", { token: lent.token, body: { game: "test" } })).status).toBe(403);
		expect((await call("GET", "/account", { token: lent.token })).status).toBe(403);
		// And only this game's saves.
		expect((await call("GET", "/saves/small", { token: lent.token })).status).toBe(403);
		// The session lasts the configured hours at most.
		expect(lent.expires_at - Date.now() / 1000).toBeLessThanOrEqual(testEnv.GUEST_TOKEN_HOURS * 3600 + 1);
	});

	it("gives an address with no account a new one, named by the host's device", async () => {
		const host = await deviceAccount("Host");
		const brought = await bring(host, newEmail("visitor"), false, { display_name: "Visitor" });
		expect(brought.body.display_name).toBe("Visitor");
		expect((await save(brought.body.token, "character", "data", 0)).status).toBe(200);
	});

	it("needs the guest's code, and refuses the host's own address", async () => {
		const host = await emailAccount("Host");
		const guest = await emailAccount("Guest");
		const { challenge, code } = await emailCode(guest.email, { hostToken: host.token });
		const wrong = code === "000000" ? "111111" : "000000";
		expect((await callJson("POST", "/guest/email/verify", { token: host.token, body: { email: guest.email, challenge, code: wrong, game: "test" } })).body.error).toBe("wrong_code");
		expect((await bring(host, host.email, false)).body.error).toBe("same_account");
	});

	it("remembers a guest on the host device until the guest revokes it", async () => {
		const host = await deviceAccount("Host");
		const guest = await emailAccount("Inês");
		const lent = (await bring(host, guest.email, true)).body;
		expect(lent.kind).toBe("grant");
		expect(lent.token).toMatch(/^g_/);
		expect((await save(lent.token, "character", "data", 0)).status).toBe(200);

		const grants = await callJson("GET", "/grants", { token: guest.token });
		expect(grants.body.grants).toHaveLength(1);
		expect(grants.body.grants[0].device_label).toBe("Living room Apple TV");
		await callJson("DELETE", `/grants/${grants.body.grants[0].id}`, { token: guest.token });
		expect((await call("GET", "/saves/test", { token: lent.token })).status).toBe(401);
	});

	it("forgets a remembered guest from the host, with the grant itself", async () => {
		const host = await deviceAccount("Host");
		const guest = await emailAccount("Visitor");
		const lent = (await bring(host, guest.email, true)).body;
		const forgotten = await callJson("DELETE", "/grants/current", { token: lent.token });
		expect(forgotten.body).toMatchObject({ account_deleted: false });
		expect((await call("GET", "/saves/test", { token: lent.token })).status).toBe(401);
		// The guest's own account is untouched.
		expect((await call("GET", "/account", { token: guest.token })).status).toBe(200);
	});
});
