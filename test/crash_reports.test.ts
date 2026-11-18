import { describe, expect, it } from "vitest";
import { cleanUp } from "../src/cleanup";
import { CRASH_REPORT_DAYS, KEPT_PER_CRASH, redact, signatureOf } from "../src/crash_reports";
import { DAY, now } from "../src/time";
import { callJson, deviceAccount, testEnv } from "./helpers";

// A report as the engine writes one for a crash in a script, with a load address of its own.
function scriptCrash(func = "explode", line = 8, address = "100d22878") {
	return `The run of the game that started 2026-11-18 19:00:00 UTC didn't end cleanly.

Engine: Purr v0.2.1
GPU: Apple M4 Max (Metal 4.0)

ERROR: something earlier
   GDScript backtrace (most recent call first):
       [0] unrelated (res://menu.gd:3)
================================================================
handle_crash: Program crashed with signal 5
Dumping the backtrace. Please include this when reporting the bug.
[0] ${address} (main+52878) - rust_eh_personality + 200540
[1] 183fe8144 (libsystem_platform.dylib+4144) - _sigtramp + 56
[2] 1052cde2c (main+45fde2c) - TT_RunIns + 14715348
-- END OF C++ BACKTRACE --
================================================================
GDScript backtrace (most recent call first):
    [0] ${func} (res://player.gd:${line})
    [1] _process (res://player.gd:20)
-- END OF GDSCRIPT BACKTRACE --
`;
}

function nativeCrash(load: string) {
	return `Engine: Purr v0.2.1
handle_crash: Program crashed with signal 11
Dumping the backtrace. Please include this when reporting the bug.
[0] ${load}878 (main+52878) - rust_eh_personality + 200540
[1] ${load}144 (libsystem_platform.dylib+4144) - _sigtramp + 56
[2] ${load}e2c (main+45fde2c) - TT_RunIns + 14715348
[3] ${load}434 (main+1b9434) - main + 1135216
-- END OF C++ BACKTRACE --
`;
}

const send = (token: string, report: string, game = "test", version = "1.2.3") =>
	callJson("POST", "/crash-reports", { token, body: { game, report }, headers: { "x-game-version": version } });

const group = (signature: string) => testEnv.DB.prepare("SELECT * FROM crash_groups WHERE signature = ?").bind(signature).first<any>();

describe("crash reports", () => {
	it("need a session, and nothing in them says who sent them", async () => {
		expect((await callJson("POST", "/crash-reports", { body: { game: "test", report: scriptCrash() } })).status).toBe(401);
		const player = await deviceAccount();
		const sent = await send(player.token, scriptCrash("only_mine", 41));
		expect(sent.status).toBe(200);
		const { signature } = await signatureOf("test", scriptCrash("only_mine", 41));
		const rows = await testEnv.DB.prepare("SELECT * FROM crash_reports WHERE signature = ?").bind(signature).all<any>();
		expect(rows.results).toHaveLength(1);
		expect(JSON.stringify(rows.results[0])).not.toContain(player.id);
		expect(Object.keys(rows.results[0]).sort()).toEqual(["created_at", "game", "id", "report", "signature", "version"]);
	});

	it("count the same crash once, with its versions, whatever the run's own addresses", async () => {
		const first = await deviceAccount();
		const second = await deviceAccount();
		await send(first.token, scriptCrash("jump", 12, "100d22878"), "test", "1.0");
		await send(second.token, scriptCrash("jump", 12, "200a11111"), "test", "1.1");
		const { signature, title } = await signatureOf("test", scriptCrash("jump", 12));
		expect(title).toBe("jump (res://player.gd:12)");
		const crash = await group(signature);
		expect(crash.count).toBe(2);
		expect([crash.first_version, crash.last_version]).toEqual(["1.0", "1.1"]);
	});

	it("group by the crash's own backtrace, not an error's before it", async () => {
		expect((await signatureOf("test", scriptCrash("a"))).signature).not.toBe((await signatureOf("test", scriptCrash("b"))).signature);
		expect((await signatureOf("test", scriptCrash())).title).not.toContain("unrelated");
	});

	it("group a crash in the engine by its place in the build, past the crash handler", async () => {
		const one = await signatureOf("test", nativeCrash("1000"));
		const two = await signatureOf("test", nativeCrash("7fff"));
		expect(one.signature).toBe(two.signature);
		expect(one.title).toBe("(main+45fde2c) - TT_RunIns + 14715348");
	});

	it("put runs closed without a backtrace together", async () => {
		const killed = await signatureOf("test", "Engine: Purr v0.2.1\n\nThe end of its log:\nloading level 3\n");
		expect(killed.title).toContain("No backtrace");
		expect(killed.signature).toBe((await signatureOf("test", "Engine: Purr\nsomething else entirely\n")).signature);
	});

	it("lose email and IP addresses, and keep what only looks like them", () => {
		const text = "Saved to /Users/ada/Library and C:\\Users\\Ada Lovelace\\Saves; /home/ada/.local; "
			+ "Signed in as ada@example.com, peer 203.0.113.9 and 2001:db8::1 (fe80::1%en0); "
			+ "Node::_notification at 19:22:25, driver 31.0.15.3699, mac 4.8.0";
		const clean = redact(text);
		expect(clean).not.toMatch(/ada@|203\.0\.113\.9|2001:db8|fe80|Users.ada|home.ada/i);
		expect(clean).toContain("Saved to ~/Library and ~\\Saves; ~/.local;");
		expect(clean).toContain("[email]");
		expect(clean).toContain("Node::_notification at 19:22:25, driver 31.0.15.3699, mac 4.8.0");
	});

	it("are stored without the addresses in them", async () => {
		const player = await deviceAccount();
		await send(player.token, scriptCrash("stored_clean", 5) + "connected to 198.51.100.7 as bo@example.org\n");
		const { signature } = await signatureOf("test", scriptCrash("stored_clean", 5));
		const row = await testEnv.DB.prepare("SELECT report FROM crash_reports WHERE signature = ?").bind(signature).first<{ report: string }>();
		expect(row!.report).not.toMatch(/198\.51\.100\.7|bo@example/);
	});

	it("keep the newest few of a crash in full, and count the rest", async () => {
		const report = scriptCrash("often", 99);
		for (let i = 0; i < KEPT_PER_CRASH + 2; i++) {
			await send((await deviceAccount()).token, report);
		}
		const { signature } = await signatureOf("test", report);
		expect((await group(signature)).count).toBe(KEPT_PER_CRASH + 2);
		const kept = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM crash_reports WHERE signature = ?").bind(signature).first<{ n: number }>();
		expect(kept!.n).toBe(KEPT_PER_CRASH);
	});

	it("stop storing new crashes for the day past the limit, but still count known ones", async () => {
		const known = scriptCrash("known_before", 1);
		await send((await deviceAccount()).token, known, "small");
		testEnv.MAX_CRASH_REPORT_BYTES_PER_DAY = 1;
		try {
			const player = await deviceAccount();
			expect((await send(player.token, scriptCrash("brand_new", 2), "small")).status).toBe(200);
			expect(await group((await signatureOf("small", scriptCrash("brand_new", 2))).signature)).toBeNull();
			await send(player.token, known, "small");
			expect((await group((await signatureOf("small", known)).signature)).count).toBe(2);
		} finally {
			delete testEnv.MAX_CRASH_REPORT_BYTES_PER_DAY;
		}
	});

	it("are limited for each account", async () => {
		const player = await deviceAccount();
		const statuses = [];
		for (let i = 0; i < 8; i++) {
			statuses.push((await send(player.token, scriptCrash(`burst_${i}`, i))).status);
		}
		expect(statuses).toContain(429);
	});

	it("are redacted in time however the text is made to be slow", () => {
		const started = Date.now();
		redact("a@" + "b".repeat(60000));
		redact("b".repeat(60000) + "@");
		redact("0".repeat(60000));
		redact("1:".repeat(30000));
		redact("C:\\Users\\" + "x".repeat(60000));
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("are refused when too large, or when the game doesn't take them", async () => {
		const player = await deviceAccount();
		expect((await send(player.token, "x".repeat(70000))).status).toBe(400);
		expect((await send(player.token, "é".repeat(40000))).body.error).toBe("too_large");
		expect((await send(player.token, scriptCrash(), "no_crashes")).body.error).toBe("crash_reports_off");
		expect((await send(player.token, scriptCrash(), "nonexistent")).body.error).toBe("unknown_game");
	});

	it("go after 90 days, with crashes nobody has had since", async () => {
		const report = scriptCrash("old_news", 7);
		await send((await deviceAccount()).token, report);
		const { signature } = await signatureOf("test", report);
		const long_ago = now() - (CRASH_REPORT_DAYS + 1) * DAY;
		await testEnv.DB.prepare("UPDATE crash_reports SET created_at = ? WHERE signature = ?").bind(long_ago, signature).run();
		await testEnv.DB.prepare("UPDATE crash_groups SET last_seen_at = ? WHERE signature = ?").bind(long_ago, signature).run();
		await cleanUp(testEnv);
		expect(await group(signature)).toBeNull();
		expect(await testEnv.DB.prepare("SELECT 1 FROM crash_reports WHERE signature = ?").bind(signature).first()).toBeNull();
	});
});
