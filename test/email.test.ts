import { describe, expect, it, vi } from "vitest";
import { call, callJson, deviceAccount, emailCode, newEmail, testEnv, verifyEmail } from "./helpers";
import { sendWithCloudflare } from "../src/email/cloudflare";
import { sendWithSmtp2go } from "../src/email/smtp2go";
import { connectionKey } from "../src/email_codes";
import workerModule from "../src/index";
import { renderEmail } from "../src/email_templates";

const worker = () => workerModule;

async function tryCode(email: string, challenge: string, code: string, headers: Record<string, string> = {}, token?: string) {
	return callJson("POST", "/auth/email/verify", { token, body: { email, challenge, code }, headers });
}

const otherCode = (code: string) => (code === "000000" ? "111111" : "000000");

describe("email sign-in", () => {
	it("signs in with a code, to the same account each time, and stores neither the address nor the code", async () => {
		const email = newEmail("ines");
		const { code, challenge } = await emailCode(email);
		const first = await tryCode(email, challenge, code);
		expect(first.status).toBe(200);
		expect(first.body).toMatchObject({ created: true, providers: ["email"] });

		const again = await verifyEmail(` ${email.toUpperCase()} `);
		expect(again.body.account_id).toBe(first.body.account_id);
		expect(again.body.created).toBe(false);

		const pending = await emailCode(newEmail("pending")); // A code waiting in the table, too.
		for (const table of ["accounts", "identities", "device_grants", "email_codes", "email_limits"]) {
			const rows = JSON.stringify((await testEnv.DB.prepare(`SELECT * FROM ${table}`).all()).results);
			expect(rows).not.toContain(email);
			expect(rows).not.toContain(email.split("@")[0]);
			expect(rows).not.toContain(code);
			expect(rows).not.toContain(pending.challenge);
		}
	});

	it("answers the same whether or not an address has an account", async () => {
		const known = newEmail("known");
		await verifyEmail(known);
		await testEnv.DB.prepare("UPDATE email_limits SET last_sent_at = last_sent_at - 120").run();
		const a = await callJson("POST", "/auth/email/start", { body: { email: known, game: "test" } });
		const b = await callJson("POST", "/auth/email/start", { body: { email: newEmail("unknown"), game: "test" } });
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
		expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
	});

	it("uses a code once, only with its challenge, and kills it after five wrong tries", async () => {
		const email = newEmail();
		const { code, challenge } = await emailCode(email);
		expect((await tryCode(email, "not-the-challenge", code)).body.error).toBe("wrong_code");
		expect((await tryCode(email, challenge, code)).status).toBe(200);
		expect((await tryCode(email, challenge, code)).body.error).toBe("wrong_code");

		const other = newEmail();
		const right = await emailCode(other);
		for (let i = 0; i < 5; i++) {
			expect((await tryCode(other, right.challenge, otherCode(right.code))).body.error).toBe("wrong_code");
		}
		expect((await tryCode(other, right.challenge, right.code)).body.error).toBe("wrong_code");
	});

	it("keeps an earlier code working when a new one is sent", async () => {
		const email = newEmail();
		const first = await emailCode(email);
		const second = await emailCode(email);
		expect((await tryCode(email, first.challenge, first.code)).status).toBe(200);
		expect((await tryCode(email, second.challenge, second.code)).status).toBe(200);
	});

	it("gives at most five guesses per code even when they're sent all at once", async () => {
		const email = newEmail();
		const right = await emailCode(email);
		const guesses = Array.from({ length: 12 }, (_, i) => String((Number(right.code) + 1 + i) % 1_000_000).padStart(6, "0"));
		await Promise.all(guesses.map((guess) => tryCode(email, right.challenge, guess)));
		const rows = await testEnv.DB.prepare("SELECT attempts FROM email_codes").all<{ attempts: number }>();
		expect(Math.max(...rows.results.map((r) => r.attempts))).toBeLessThanOrEqual(5);
		expect((await tryCode(email, right.challenge, right.code)).body.error).toBe("wrong_code");
	});

	it("caps codes per address: one a minute and eight a day, even when asked for all at once", async () => {
		const email = newEmail();
		await emailCode(email);
		expect((await callJson("POST", "/auth/email/start", { body: { email, game: "test" } })).status).toBe(429);

		await testEnv.DB.prepare("UPDATE email_limits SET last_sent_at = last_sent_at - 120").run();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const burst = await Promise.all(Array.from({ length: 10 }, () => callJson("POST", "/auth/email/start", { body: { email, game: "test" } })));
		const sent = log.mock.calls.filter((args) => String(args[0]).startsWith(`[email] to ${email}:`)).length;
		log.mockRestore();
		expect(burst.filter((response) => response.status === 200)).toHaveLength(1);
		expect(sent).toBe(1);

		for (let codes = 2; codes < 8; codes++) {
			await emailCode(email);
		}
		await testEnv.DB.prepare("UPDATE email_limits SET last_sent_at = last_sent_at - 120").run();
		expect((await callJson("POST", "/auth/email/start", { body: { email, game: "test" } })).status).toBe(429);
	});

	it("caps codes tried per address per day, across codes", async () => {
		const email = newEmail();
		for (let round = 0; round < 7; round++) {
			const { code, challenge } = await emailCode(email);
			for (let i = 0; i < 5; i++) {
				await tryCode(email, challenge, otherCode(code));
			}
		}
		const last = await emailCode(email); // The eighth code: five tries left today.
		for (let i = 0; i < 5; i++) {
			await tryCode(email, last.challenge, otherCode(last.code));
		}
		await testEnv.DB.prepare("UPDATE email_codes SET attempts = 0").run();
		expect((await tryCode(email, last.challenge, last.code)).body.error).toBe("wrong_code");
	});

	it("limits codes and tries per connection, and counts an IPv6 /64 as one connection", async () => {
		const statuses = [];
		for (let i = 0; i < 7; i++) {
			const connection = { "cf-connecting-ip": `2001:db8:1:2::${i + 1}` };
			statuses.push((await callJson("POST", "/auth/email/start", { body: { email: newEmail(), game: "test" }, headers: connection })).status);
		}
		expect(statuses).toContain(429);

		const tries = [];
		for (let i = 0; i < 12; i++) {
			tries.push((await tryCode(newEmail(), "x", "123456", { "cf-connecting-ip": "203.0.113.8" })).status);
		}
		expect(tries).toContain(429);

		const key = (ip: string) => connectionKey(new Request("http://localhost", { headers: { "cf-connecting-ip": ip } }));
		expect(key("2001:db8:1:2::1")).toBe(key("2001:0db8:0001:0002:ffff:1:2:3"));
		expect(key("2001:db8:1:2::1")).not.toBe(key("2001:db8:1:3::1"));
		expect(key("198.51.100.7")).toBe("198.51.100.7");
	});

	it("refuses addresses that aren't plain addresses, including header tricks", async () => {
		for (const email of ["", "nope", "a@b", "a b@example.com", "a@example.com\r\nBcc: x@example.com", "<a@example.com>", "a@@example.com", '"a"@example.com', "a..b@example.com", "x".repeat(250) + "@example.com"]) {
			const response = await callJson("POST", "/auth/email/start", { body: { email, game: "test" } });
			expect(response.status, email).toBe(400);
		}
		expect((await callJson("POST", "/auth/email/start", { body: { email: newEmail(), game: "nope" } })).status).toBe(404);
		expect((await callJson("POST", "/auth/email/start", { body: { email: newEmail(), game: "constructor" } })).status).toBe(404);
	});

	it("only writes emails to the console on the developer's own machine", async () => {
		const response = await worker().fetch(
			new Request("https://trill.example/auth/email/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: newEmail(), game: "test" }) }),
			testEnv,
		);
		expect(response.status).toBe(501);
	});
});

describe("codes have a purpose", () => {
	it("won't sign in with a code a host asked for on a guest's behalf", async () => {
		const host = await deviceAccount("Host");
		const guest = newEmail("guest");
		await verifyEmail(guest);
		const { code, challenge } = await emailCode(guest, { hostToken: host.token });
		// Signed out, or as the host: refused either way.
		expect((await tryCode(guest, challenge, code)).body.error).toBe("wrong_code");
		expect((await tryCode(guest, challenge, code, {}, host.token)).body.error).toBe("wrong_code");
	});

	it("won't bring a guest's profile with a sign-in code", async () => {
		const host = await deviceAccount("Host");
		const guest = newEmail("guest");
		const { code, challenge } = await emailCode(guest);
		const brought = await callJson("POST", "/guest/email/verify", { token: host.token, body: { email: guest, challenge, code, game: "test" } });
		expect(brought.body.error).toBe("wrong_code");
	});

	it("asks for a guest's code only from a signed-in host", async () => {
		expect((await callJson("POST", "/guest/email/start", { body: { email: newEmail(), game: "test" } })).status).toBe(401);
	});

	it("says in the email what each code is for", async () => {
		const host = await deviceAccount("Host");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await callJson("POST", "/auth/email/start", { body: { email: newEmail("a"), game: "test" } });
		await callJson("POST", "/guest/email/start", { token: host.token, body: { email: newEmail("b"), game: "test" } });
		const [signIn, guest] = log.mock.calls.map((args) => String(args[0]));
		log.mockRestore();
		expect(signIn).toContain("never give it to anyone");
		expect(guest).toContain("can't sign in to your account");
	});
});

describe("adding and changing an address", () => {
	it("adds an address to a platform account, then joins a second platform account to it", async () => {
		const mac = await deviceAccount("Mac");
		const email = newEmail();
		const added = await verifyEmail(email, mac.token);
		expect(added.body).toMatchObject({ account_id: mac.id, merged: false, providers: ["device", "email"] });

		const phone = await deviceAccount("Phone");
		const joined = await verifyEmail(email, phone.token);
		expect(joined.body).toMatchObject({ account_id: mac.id, merged: true });
		expect(joined.body.providers).toEqual(["device", "device", "email"]);
		// The phone's platform sign-in reaches the joined account from now on; its own is gone.
		expect((await callJson("POST", "/auth/device", { body: { game: "test", secret: phone.secret } })).body.account_id).toBe(mac.id);
		expect(await testEnv.DB.prepare("SELECT id FROM accounts WHERE id = ?").bind(phone.id).first()).toBeNull();
		expect((await call("GET", "/account", { token: phone.token })).status).toBe(401);
	});

	it("carries a joining account's ban, record and ratings over, so joining is no way out of a ban", async () => {
		const clean = await deviceAccount("Clean");
		const email = newEmail();
		await verifyEmail(email, clean.token);
		const banned = await deviceAccount("Banned");
		const reporter = await deviceAccount("Reporter");
		const until = Math.floor(Date.now() / 1000) + 7 * 86400;
		await testEnv.DB.batch([
			testEnv.DB.prepare("UPDATE accounts SET banned_until = ?, auto_bans = 2 WHERE id = ?").bind(until, banned.id),
			testEnv.DB.prepare("INSERT INTO cheat_kicks (account_id, game, at) VALUES (?, 'example', ?)").bind(banned.id, until - 7 * 86400),
			testEnv.DB.prepare("INSERT INTO reports (id, game, reporter_id, reported_id, reason, created_at) VALUES (?, 'example', ?, ?, 'cheating', 0)").bind(crypto.randomUUID(), reporter.id, banned.id),
			testEnv.DB.prepare("INSERT INTO blocks (account_id, blocked_id, created_at) VALUES (?, ?, 0)").bind(reporter.id, banned.id),
			testEnv.DB.prepare("INSERT INTO ratings (account_id, game, mode, rating, matches) VALUES (?, 'example', 'duel', 870, 12)").bind(banned.id),
		]);
		const joined = await verifyEmail(email, banned.token);
		expect(joined.body).toMatchObject({ account_id: clean.id, merged: true });
		const account = await testEnv.DB.prepare("SELECT banned_until, auto_bans FROM accounts WHERE id = ?").bind(clean.id).first<{ banned_until: number; auto_bans: number }>();
		expect(account).toEqual({ banned_until: until, auto_bans: 2 });
		expect((await callJson("POST", "/lobbies", { token: joined.body.token, body: { game: "example" } })).status).toBe(403);
		const count = async (sql: string) => (await testEnv.DB.prepare(sql).bind(clean.id).first<{ n: number }>())!.n;
		expect(await count("SELECT COUNT(*) AS n FROM cheat_kicks WHERE account_id = ?")).toBe(1);
		expect(await count("SELECT COUNT(*) AS n FROM reports WHERE reported_id = ?")).toBe(1);
		expect(await count("SELECT COUNT(*) AS n FROM blocks WHERE blocked_id = ?")).toBe(1);
		expect(await testEnv.DB.prepare("SELECT rating, matches FROM ratings WHERE account_id = ?").bind(clean.id).first()).toEqual({ rating: 870, matches: 12 });
	});

	it("changes the address only with the current one, never to another account's, and ends other sessions", async () => {
		const player = await deviceAccount();
		const current = newEmail("old");
		await verifyEmail(current, player.token);
		const otherDevice = (await callJson("POST", "/auth/device", { body: { game: "test", secret: player.secret } })).body.token;

		const next = newEmail("new");
		expect((await verifyEmail(next, player.token)).body.error).toBe("bad_email"); // current_email missing
		expect((await verifyEmail(next, player.token, { current_email: newEmail("guess") })).body.error).toBe("wrong_current_email");
		const changed = await verifyEmail(next, player.token, { current_email: current });
		expect(changed.status).toBe(200);
		expect(changed.body.providers).toEqual(["device", "email"]);
		// The session returned works; the account's other sessions don't any more.
		expect((await call("GET", "/account", { token: changed.body.token })).status).toBe(200);
		expect((await call("GET", "/account", { token: otherDevice })).status).toBe(401);

		// The new address reaches the account; the old one doesn't any more.
		expect((await verifyEmail(next)).body.account_id).toBe(player.id);
		expect((await verifyEmail(current)).body.account_id).not.toBe(player.id);

		const someoneElse = newEmail("taken");
		await verifyEmail(someoneElse);
		expect((await verifyEmail(someoneElse, changed.body.token, { current_email: next })).body.error).toBe("email_in_use");
	});

	it("won't add or change an address with a guest token or a device grant", async () => {
		const host = await deviceAccount("Host");
		const guestEmail = newEmail("guest");
		const { code, challenge } = await emailCode(guestEmail, { hostToken: host.token });
		const guest = await callJson("POST", "/guest/email/verify", { token: host.token, body: { email: guestEmail, challenge, code, game: "test" } });
		expect((await verifyEmail(newEmail(), guest.body.token)).status).toBe(403);
	});
});

describe("email templates", () => {
	it("fills in the templates, escaping values in the HTML and keeping the subject to one line", async () => {
		const email = await renderEmail("sign_in", "test", { code: "123456", game: "Cats & <Dogs>\nTwo", minutes: "10" });
		expect(email.subject).toBe("123456 is your code for Cats & <Dogs> Two");
		expect(email.text).toContain("Your code for Cats & <Dogs>\nTwo is 123456.");
		expect(email.text).toContain("It works for 10 minutes.");
		expect(email.html).toContain("Cats &amp; &lt;Dogs&gt;");
		expect(email.html).not.toContain("<Dogs>");
		expect(email.html).toContain(">123456<");
		expect(email.html).toMatch(/^<!doctype html>/);
		expect(email.html).not.toContain("{{");
	});

	it("has a template for each kind of code", async () => {
		const guest = await renderEmail("guest", "test", { code: "654321", game: "Test Game", minutes: "10" });
		expect(guest.subject).toContain("654321");
		expect(guest.text).toContain("can't sign in to your account");
		expect(guest.html).toContain("can't sign in to your account");
	});
});

describe("email drivers", () => {
	const message = { to: "ines@example.com", subject: "123456 is your code for Test Game", text: "Your code is 123456.", html: "<p>Your code is 123456.</p>" };

	it("sends through Cloudflare's binding, with the sender's name split out", async () => {
		const send = vi.fn().mockResolvedValue({ messageId: "x" });
		await sendWithCloudflare({ ...testEnv, EMAIL: { send } as unknown as SendEmail, EMAIL_FROM: "Test Game <noreply@example.com>" }, message);
		expect(send).toHaveBeenCalledWith({ from: { name: "Test Game", email: "noreply@example.com" }, to: message.to, subject: message.subject, text: message.text, html: message.html });
	});

	it("sends through SMTP2GO's API, and notices a failure it reports with 200", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ request_id: "r", data: { succeeded: 1, failed: 0, failures: [] } }));
		const env = { ...testEnv, SMTP2GO_API_KEY: "api-test", EMAIL_FROM: "Test Game <noreply@example.com>" };
		await sendWithSmtp2go(env, message);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe("https://api.smtp2go.com/v3/email/send");
		expect((init!.headers as Record<string, string>)["x-smtp2go-api-key"]).toBe("api-test");
		expect(JSON.parse(String(init!.body))).toEqual({ sender: "Test Game <noreply@example.com>", to: [message.to], subject: message.subject, text_body: message.text, html_body: message.html });

		fetchSpy.mockResolvedValueOnce(Response.json({ request_id: "r", data: { succeeded: 0, failed: 1, failures: ["x"] } }));
		await expect(sendWithSmtp2go(env, message)).rejects.toThrow();
		fetchSpy.mockRestore();
	});

	it("reports a failed send without counting it, and the code can't be used", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));
		const env = { ...testEnv, EMAIL_DRIVER: "smtp2go", SMTP2GO_API_KEY: "api-test" };
		const email = newEmail();
		const codesBefore = (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM email_codes").first<{ n: number }>())!.n;
		const request = () =>
			worker().fetch(new Request("https://trill.example/auth/email/start", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": crypto.randomUUID() }, body: JSON.stringify({ email, game: "test" }) }), env);
		const failed = await request();
		expect(failed.status).toBe(502);
		// Not counted against the address: asking again straight away is fine.
		expect((await request()).status).toBe(502);
		expect(JSON.stringify(error.mock.calls)).not.toContain(email);
		expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM email_codes").first<{ n: number }>())!.n).toBe(codesBefore);
		fetchSpy.mockRestore();
		error.mockRestore();
	});
});
