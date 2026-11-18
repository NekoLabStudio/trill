// Tests for the setup, configure and update scripts (Node's own test runner: node --test scripts/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { Changes, mergeRelease } from "./settings.mjs";
import { copyUpstream, UPSTREAM_CONFIG } from "./release.mjs";

const online = join(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerConfig = readFileSync(join(online, "wrangler.jsonc"), "utf8");

test("edits wrangler.jsonc in place and keeps its comments", () => {
	const changes = new Changes(wranglerConfig);
	changes.set(["name"], "studio-online", "Name");
	changes.set(["d1_databases", 0, "database_id"], "11111111-2222-3333-4444-555555555555", "Database ID");
	changes.set(["vars", "GAMES"], {}, "Games");
	changes.set(["vars", "GAMES", "night-drive"], { name: "Night Drive", steam_app_id: 4242 }, "night-drive");
	changes.set(["vars", "EMAIL_FROM"], 'Night "Drive" <hi@example.com>', "Emails from");
	changes.set(["ratelimits", 0, "simple", "limit"], 3, "New device accounts");
	const out = changes.text();
	const parsed = parse(out);
	assert.equal(parsed.name, "studio-online");
	assert.equal(parsed.d1_databases[0].database_id, "11111111-2222-3333-4444-555555555555");
	assert.deepEqual(parsed.vars.GAMES, { "night-drive": { name: "Night Drive", steam_app_id: 4242 } });
	assert.equal(parsed.vars.EMAIL_FROM, 'Night "Drive" <hi@example.com>');
	assert.equal(parsed.ratelimits[0].simple.limit, 3);
	assert.ok(out.includes("// Worker logs stay off"));
	assert.ok(out.includes("// New device accounts, per connection."));
});

test("drops Cloudflare's email binding, with its comment, for SMTP2GO", () => {
	const changes = new Changes(wranglerConfig);
	changes.set(["send_email"], undefined, "Cloudflare's email binding");
	const out = changes.text();
	assert.equal(parse(out).send_email, undefined);
	assert.ok(!out.includes("Cloudflare's Email Sending"));
});

test("only lists what still differs once everything is answered", () => {
	const changes = new Changes(wranglerConfig, ["SMTP2GO_API_KEY"]);
	changes.set(["vars", "SESSION_DAYS"], 7, "Session days");
	changes.set(["vars", "SESSION_DAYS"], 30, "Session days");
	changes.set(["vars", "MAX_SAVE_SLOTS"], 4, "Save slots");
	changes.setSecret("STEAM_WEB_API_KEY", "key");
	changes.dropSecret("SMTP2GO_API_KEY");
	changes.dropSecret("NEVER_SET");
	assert.deepEqual(changes.summary(), ["Save slots: 4", "Secret STEAM_WEB_API_KEY: set", "Secret SMTP2GO_API_KEY: removed"]);
});

test("an update adds the release's new settings and keeps the instance's own", () => {
	const before = `{
	"name": "purr-online",
	"ratelimits": [{ "name": "A_LIMITER", "simple": { "limit": 10, "period": 60 } }],
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Lobby"] }],
	"vars": { "GAMES": { "example": {} }, "SESSION_DAYS": 30, "MAX_SAVE_SLOTS": 8, "AUTO_BAN": { "kicks": 3 }, "OLD_SETTING": 1 }
}`;
	const after = `{
	"name": "purr-online",
	"ratelimits": [{ "name": "A_LIMITER", "simple": { "limit": 10, "period": 60 } }, { "name": "B_LIMITER", "simple": { "limit": 5, "period": 60 } }],
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Lobby"] }, { "tag": "v2", "new_sqlite_classes": ["Party"] }],
	"kv_namespaces": [{ "binding": "CACHE", "id": "x" }],
	"vars": { "GAMES": { "example": {} }, "SESSION_DAYS": 14, "MAX_SAVE_SLOTS": 10, "AUTO_BAN": { "kicks": 3 }, "NEW_SETTING": 5 }
}`;
	const instance = `// Mine.
{
	"name": "studio-online",
	"ratelimits": [{ "name": "A_LIMITER", "simple": { "limit": 10, "period": 60 } }],
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Lobby"] }],
	"vars": { "GAMES": { "night-drive": {} }, "SESSION_DAYS": 30, "MAX_SAVE_SLOTS": 4, "OLD_SETTING": 1 }
}`;
	const merged = mergeRelease(instance, before, after);
	const parsed = parse(merged.text);
	assert.ok(merged.text.startsWith("// Mine."));
	assert.equal(parsed.name, "studio-online");
	assert.deepEqual(parsed.vars.GAMES, { "night-drive": {} });
	// New: added.
	assert.equal(parsed.vars.NEW_SETTING, 5);
	assert.deepEqual(parsed.ratelimits.map((limiter) => limiter.name), ["A_LIMITER", "B_LIMITER"]);
	assert.deepEqual(parsed.migrations.map((migration) => migration.tag), ["v1", "v2"]);
	// A default never changed follows the release; one the instance set is kept and listed.
	assert.equal(parsed.vars.SESSION_DAYS, 14);
	assert.equal(parsed.vars.MAX_SAVE_SLOTS, 4);
	assert.match(merged.kept.join("\n"), /vars\.MAX_SAVE_SLOTS: yours is 4; the release's default changed from 8 to 10/);
	// Taken out on purpose (automatic bans off): stays out.
	assert.equal(parsed.vars.AUTO_BAN, undefined);
	assert.deepEqual(merged.unused, ["vars.OLD_SETTING"]);
	assert.deepEqual(merged.resources, ["kv_namespaces[binding=CACHE]"]);
	assert.equal(parsed.kv_namespaces, undefined);
});

test("configure, in a dry run with scripted answers, shows and makes the changes", () => {
	const copy = mkdtempSync(join(tmpdir(), "purr-configure-"));
	try {
		for (const path of ["wrangler.jsonc", "src", "scripts", "package.json"]) {
			cpSync(join(online, path), join(copy, path), { recursive: true });
		}
		symlinkSync(join(online, "node_modules"), join(copy, "node_modules"));
		const answers = {
			menu: ["1", "2", "6", ""],
			game: ["night-drive", ""],
			game_name: "Night Drive",
			steam_app_id: "4242",
			steam_web_api_key: "steam-key",
			bundle_ids: "com.example.night",
			email_driver: "smtp2go",
			email_from: "Night Drive <hi@example.com>",
			smtp2go_api_key: "api-x",
			rate_signup_limiter: "3",
		};
		const result = spawnSync("node", ["scripts/configure.mjs", "--dry-run"], { cwd: copy, encoding: "utf8", env: { ...process.env, PURR_SCRIPT_ANSWERS: JSON.stringify(answers) } });
		assert.equal(result.status, 0, result.stderr);
		const out = result.stdout;
		assert.match(out, /night-drive: Steam App ID: 4242/);
		assert.match(out, /night-drive: Apple bundle IDs: com\.example\.night/);
		assert.match(out, /Email sent with: smtp2go/);
		assert.match(out, /Cloudflare's email binding: removed/);
		assert.match(out, /New device accounts a minute, per connection: 3/);
		assert.match(out, /Secret STEAM_WEB_API_KEY: set/);
		assert.match(out, /Secret SMTP2GO_API_KEY: set/);
		assert.match(out, /would write wrangler\.jsonc/);
		assert.match(out, /would run: npx wrangler deploy/);
		assert.match(out, /would run: npx wrangler secret bulk \(with input\)/);
		assert.ok(!out.includes("api-x") && !out.includes("steam-key"), "secrets are never printed");
		assert.equal(readFileSync(join(copy, "wrangler.jsonc"), "utf8"), wranglerConfig);
	} finally {
		rmSync(copy, { recursive: true, force: true });
	}
});

test("an update replaces Purr's files and keeps the instance's own", () => {
	const instance = mkdtempSync(join(tmpdir(), "purr-instance-"));
	const release = mkdtempSync(join(tmpdir(), "purr-release-"));
	try {
		mkdirSync(join(instance, "src/email-templates/custom"), { recursive: true });
		writeFileSync(join(instance, "src/old.ts"), "old");
		writeFileSync(join(instance, "src/email-templates/custom/sign_in.html"), "mine");
		writeFileSync(join(instance, "wrangler.jsonc"), "my settings");
		writeFileSync(join(instance, ".dev.vars"), "SECRET=1");
		mkdirSync(join(release, "src/email-templates"), { recursive: true });
		writeFileSync(join(release, "src/new.ts"), "new");
		writeFileSync(join(release, "src/email-templates/sign_in.html"), "default");
		writeFileSync(join(release, "wrangler.jsonc"), "release settings");
		copyUpstream(release, instance);
		assert.ok(!existsSync(join(instance, "src/old.ts")));
		assert.equal(readFileSync(join(instance, "src/new.ts"), "utf8"), "new");
		assert.equal(readFileSync(join(instance, "src/email-templates/custom/sign_in.html"), "utf8"), "mine");
		assert.equal(readFileSync(join(instance, "wrangler.jsonc"), "utf8"), "my settings");
		assert.equal(readFileSync(join(instance, ".dev.vars"), "utf8"), "SECRET=1");
		assert.equal(readFileSync(join(instance, UPSTREAM_CONFIG), "utf8"), "release settings");
	} finally {
		rmSync(instance, { recursive: true, force: true });
		rmSync(release, { recursive: true, force: true });
	}
});

test("setup, in a dry run with scripted answers, runs the right commands", () => {
	const copy = mkdtempSync(join(tmpdir(), "purr-setup-"));
	try {
		for (const path of ["wrangler.jsonc", "src", "scripts", "package.json"]) {
			cpSync(join(online, path), join(copy, path), { recursive: true });
		}
		symlinkSync(join(online, "node_modules"), join(copy, "node_modules"));
		const answers = { name: "Studio Online", game_id: "night-drive", game_name: "Night Drive", steam_app_id: "4242", email_driver: "smtp2go", email_from: "Night Drive <hi@example.com>", smtp2go_api_key: "api-x", steam_web_api_key: "", turn_key_id: "", git: "n" };
		const result = spawnSync("node", ["scripts/setup.mjs", "--dry-run"], { cwd: copy, encoding: "utf8", env: { ...process.env, PURR_SCRIPT_ANSWERS: JSON.stringify(answers) } });
		assert.equal(result.status, 0, result.stderr);
		const out = result.stdout;
		assert.match(out, /would run: npx wrangler d1 create studio-online --update-config=false\n/);
		assert.match(out, /would run: npx wrangler r2 bucket create studio-online-saves --update-config=false\n/);
		assert.match(out, /would run: npx wrangler r2 bucket lifecycle add studio-online-saves discarded-saves discarded\/ --expire-days 30 --force/);
		assert.match(out, /would run: npx wrangler d1 migrations apply studio-online --remote/);
		assert.match(out, /would run: npx wrangler deploy/);
		assert.match(out, /would run: npx wrangler secret bulk \(with input\)/);
		assert.match(out, /set online\/url to that address and online\/game to its ID \(night-drive\)/);
		// A dry run changes nothing.
		assert.equal(readFileSync(join(copy, "wrangler.jsonc"), "utf8"), wranglerConfig);
	} finally {
		rmSync(copy, { recursive: true, force: true });
	}
});

test("moderate lists reported players and acts on them, on a local database", () => {
	const state = mkdtempSync(join(tmpdir(), "purr-moderate-"));
	const wranglerRun = (...args) => spawnSync("npx", ["wrangler", ...args, "--local", "--persist-to", state], { cwd: online, encoding: "utf8", env: { ...process.env, CI: "1" } });
	const moderate = (...args) => spawnSync("node", ["scripts/moderate.mjs", ...args, "--local", "--persist-to", state], { cwd: online, encoding: "utf8", env: { ...process.env, PURR_SCRIPT_ANSWERS: "{}" } });
	const query = (sql) => JSON.parse(wranglerRun("d1", "execute", "purr-online", "--json", "--command", sql).stdout)[0].results;
	const target = "11111111-1111-4111-8111-111111111111";
	const reporter = "22222222-2222-4222-8222-222222222222";
	try {
		assert.equal(wranglerRun("d1", "migrations", "apply", "purr-online").status, 0);
		query(`INSERT INTO accounts (id, display_name, name_chosen, created_at, last_seen_at) VALUES ('${target}', 'Rude name', 1, 1, 1), ('${reporter}', 'Reporter', 0, 1, 1);
		       INSERT INTO reports (id, game, reporter_id, reported_id, reason, details, created_at) VALUES ('r', 'g', '${reporter}', '${target}', 'name', 'not nice', 1763000000)`);

		const listed = moderate();
		assert.equal(listed.status, 0, listed.stderr);
		assert.match(listed.stdout, /1\. Rude name {2}11111111-1111-4111-8111-111111111111\n {5}1 report from 1 player: name/);
		assert.match(moderate("show", target).stdout, /name, by Reporter \(2222/);
		assert.match(moderate("show", target).stdout, /not nice/);

		assert.equal(moderate("ban", target, "forever").status, 0);
		assert.equal(query(`SELECT banned_until FROM accounts WHERE id = '${target}'`)[0].banned_until, 32503680000);
		assert.equal(moderate("unban", target).status, 0);
		assert.equal(moderate("rename", target).status, 0);
		assert.deepEqual(query(`SELECT display_name, name_chosen, banned_until FROM accounts WHERE id = '${target}'`)[0], { display_name: "", name_chosen: 0, banned_until: 0 });
		assert.equal(moderate("dismiss", target).status, 0);
		assert.match(moderate().stdout, /No one has been reported/);

		// Only account IDs and numbers reach the SQL.
		assert.match(moderate("ban", "x' OR 1=1 --", "1").stderr, /isn't an account ID/);
		assert.match(moderate("ban", target, "1; DROP TABLE accounts").stderr, /number of days/);
		assert.match(moderate("find", "'; DROP TABLE accounts; --").stdout, /No one has that name/);
		assert.equal(query("SELECT COUNT(*) AS n FROM accounts")[0].n, 2);
	} finally {
		rmSync(state, { recursive: true, force: true });
	}
});

test("crashes lists crashes, shows their reports and forgets them, on a local database", () => {
	const state = mkdtempSync(join(tmpdir(), "purr-crashes-"));
	const wranglerRun = (...args) => spawnSync("npx", ["wrangler", ...args, "--local", "--persist-to", state], { cwd: online, encoding: "utf8", env: { ...process.env, CI: "1" } });
	const crashes = (...args) => spawnSync("node", ["scripts/crashes.mjs", ...args, "--local", "--persist-to", state], { cwd: online, encoding: "utf8", env: { ...process.env, PURR_SCRIPT_ANSWERS: "{}" } });
	const query = (sql) => JSON.parse(wranglerRun("d1", "execute", "purr-online", "--json", "--command", sql).stdout)[0].results;
	const crash = "0123456789abcdef";
	try {
		assert.equal(wranglerRun("d1", "migrations", "apply", "purr-online").status, 0);
		query(`INSERT INTO crash_groups (game, signature, title, count, first_version, last_version, first_seen_at, last_seen_at) VALUES ('g', '${crash}', 'jump (res://player.gd:12)', 3, '1.0', '1.1', 1763000000, 1763100000);
		       INSERT INTO crash_reports (id, game, signature, version, report, created_at) VALUES ('a', 'g', '${crash}', '1.0', 'the older one', 1763000000), ('b', 'g', '${crash}', '1.1', 'Engine: Purr\nthe newest one', 1763100000)`);

		const listed = crashes();
		assert.equal(listed.status, 0, listed.stderr);
		assert.match(listed.stdout, /1\. jump \(res:\/\/player\.gd:12\)\n {5}3 reports from g; versions 1\.0 to 1\.1; last 2025-11-14 06:00; first 2025-11-13 02:13; 0123456789abcdef/);
		const shown = crashes("show", crash).stdout;
		assert.match(shown, /Report 1 of the 2 kept, sent 2025-11-14 06:00 from version 1\.1/);
		assert.match(shown, /the newest one/);
		const walked = spawnSync("node", ["scripts/crashes.mjs", "--local", "--persist-to", state], { cwd: online, encoding: "utf8", env: { ...process.env, PURR_SCRIPT_ANSWERS: JSON.stringify({ crash: ["1", ""], action: ["older", ""] }) } });
		assert.equal(walked.status, 0, walked.stderr);
		assert.match(walked.stdout, /the newest one[\s\S]*Report 2 of the 2 kept[\s\S]*the older one/);
		assert.match(crashes("version", "1.0").stdout, /jump/);
		assert.match(crashes("version", "9.9").stdout, /No crashes in version 9\.9/);
		assert.match(crashes("show", "x' OR 1=1 --").stderr, /isn't a crash's ID/);
		assert.match(crashes("version", "'; DROP TABLE crash_groups; --").stdout, /No crashes in version/);
		assert.equal(crashes("delete", crash).status, 0);
		assert.match(crashes().stdout, /No crashes have been reported/);
		assert.equal(query("SELECT COUNT(*) AS n FROM crash_reports")[0].n, 0);
	} finally {
		rmSync(state, { recursive: true, force: true });
	}
});
