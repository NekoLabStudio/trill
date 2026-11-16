import { describe, expect, it } from "vitest";
import { call, callJson, deviceAccount, emailCode, newEmail } from "./helpers";

describe("display names", () => {
	it("uses the platform's name until the player chooses one, then keeps theirs", async () => {
		const secret = "n".repeat(40);
		const first = await callJson("POST", "/auth/device", { body: { secret, display_name: "Platform Name" } });
		expect(first.body).toMatchObject({ display_name: "Platform Name", name_chosen: false });
		const renamed = await callJson("POST", "/auth/device", { body: { secret, display_name: "New Platform Name" } });
		expect(renamed.body.display_name).toBe("New Platform Name");

		const chosen = await callJson("PUT", "/account/name", { token: renamed.body.token, body: { display_name: "  Inês  " } });
		expect(chosen.body).toEqual({ display_name: "Inês", name_chosen: true });
		const again = await callJson("POST", "/auth/device", { body: { secret, display_name: "Platform Again" } });
		expect(again.body).toMatchObject({ display_name: "Inês", name_chosen: true });
		expect((await callJson("GET", "/account", { token: again.body.token })).body).toMatchObject({ display_name: "Inês", name_chosen: true });
	});

	it("allows names of 1 to 24 characters, in any script, without control characters", async () => {
		const player = await deviceAccount();
		const put = (display_name: unknown) => callJson("PUT", "/account/name", { token: player.token, body: { display_name } });
		expect((await put("ミチ🐱")).body.display_name).toBe("ミチ🐱");
		expect((await put("a‮b\u0000c")).body.display_name).toBe("abc");
		expect((await put("")).body.error).toBe("bad_name");
		expect((await put("\u0000\u0001")).body.error).toBe("bad_name");
		expect((await put("x".repeat(25))).body.error).toBe("bad_name");
		expect((await put("x".repeat(24))).status).toBe(200);
		expect((await put(42)).body.error).toBe("bad_name");
	});

	it("cuts a long platform name to fit", async () => {
		const signedIn = await callJson("POST", "/auth/device", { body: { secret: "m".repeat(40), display_name: "y".repeat(40) } });
		expect(signedIn.body.display_name).toBe("y".repeat(24));
	});

	it("won't let a guest token or grant change the name", async () => {
		const host = await deviceAccount("Host");
		const email = newEmail("guest");
		const { code, challenge } = await emailCode(email, { hostToken: host.token });
		const guest = await callJson("POST", "/guest/email/verify", { token: host.token, body: { email, code, challenge, game: "test" } });
		expect((await call("PUT", "/account/name", { token: guest.body.token, body: { display_name: "Hacked" } })).status).toBe(403);
	});
});

describe("names for guests", () => {
	it("keeps the name a guest typed for their new account, even after a platform signs them in", async () => {
		const host = await deviceAccount("Host");
		const email = newEmail("kid");
		const { code, challenge } = await emailCode(email, { hostToken: host.token });
		const guest = await callJson("POST", "/guest/email/verify", { token: host.token, body: { email, code, challenge, game: "test", display_name: "Kid" } });
		expect(guest.body.display_name).toBe("Kid");

		// Later, on their own device, they sign in with a platform and add the same address.
		const own = await callJson("POST", "/auth/device", { body: { secret: "k".repeat(40), display_name: "PlatformKid" } });
		const linked = await callJson("POST", "/auth/email/verify", { token: own.body.token, body: { email, ...(await emailCode(email)) } });
		expect(linked.body).toMatchObject({ merged: true, display_name: "Kid", name_chosen: true });
		const again = await callJson("POST", "/auth/device", { body: { secret: "k".repeat(40), display_name: "PlatformKid" } });
		expect(again.body.display_name).toBe("Kid");
	});
});
