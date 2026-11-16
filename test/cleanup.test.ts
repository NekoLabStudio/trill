import { describe, expect, it } from "vitest";
import { MAX_ACCOUNTS_PER_RUN, cleanUp } from "../src/cleanup";
import { deviceAccount, emailAccount, emailCode, newEmail, save, testEnv } from "./helpers";
import { DAY, now } from "../src/time";

describe("the daily cleanup", () => {
	it("deletes an account unused for too long, with its saves, and keeps one in use", async () => {
		const old = await emailAccount("Long gone");
		await save(old.token, "character", "data", 0);
		const current = await deviceAccount("Still here");
		await testEnv.DB.prepare("UPDATE accounts SET last_seen_at = ? WHERE id = ?").bind(now() - (testEnv.INACTIVE_ACCOUNT_DAYS + 1) * DAY, old.id).run();

		const result = await cleanUp(testEnv);
		expect(result.accounts).toBeGreaterThanOrEqual(1);
		expect(await testEnv.DB.prepare("SELECT id FROM accounts WHERE id = ?").bind(old.id).first()).toBeNull();
		expect(await testEnv.DB.prepare("SELECT * FROM identities WHERE account_id = ?").bind(old.id).first()).toBeNull();
		expect((await testEnv.SAVES.list({ prefix: `accounts/${old.id}/` })).objects).toHaveLength(0);
		expect(await testEnv.DB.prepare("SELECT id FROM accounts WHERE id = ?").bind(current.id).first()).not.toBeNull();
	});

	it("deletes a limited number of accounts per run, the rest the next day", async () => {
		// Unused since the start of time (created_at 0 marks them as this test's).
		await testEnv.DB.batch(Array.from({ length: MAX_ACCOUNTS_PER_RUN + 3 }, () =>
			testEnv.DB.prepare("INSERT INTO accounts (id, display_name, created_at, last_seen_at) VALUES (?, '', 0, 0)").bind(crypto.randomUUID())));
		const left = async () => (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE created_at = 0").first<{ n: number }>())!.n;
		expect((await cleanUp(testEnv)).accounts).toBe(MAX_ACCOUNTS_PER_RUN);
		expect(await left()).toBe(3);
		await cleanUp(testEnv);
		expect(await left()).toBe(0);
	});

	it("drops lapsed device grants, and email codes once their day is over", async () => {
		await emailCode(newEmail());
		await testEnv.DB.prepare("UPDATE email_codes SET expires_at = ?").bind(now() - 1).run();
		await testEnv.DB.prepare("UPDATE email_limits SET day_started_at = ?1, last_sent_at = ?1").bind(now() - DAY - 1).run();
		const result = await cleanUp(testEnv);
		expect(result.codes).toBeGreaterThanOrEqual(1);
		expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM email_codes").first<{ n: number }>())!.n).toBe(0);
		expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM email_limits").first<{ n: number }>())!.n).toBe(0);
	});
});
