// Tests for the setup and update scripts (Node's own test runner: node --test scripts/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configure } from "./configure.mjs";
import { copyUpstream, UPSTREAM_CONFIG } from "./release.mjs";

const online = join(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerConfig = readFileSync(join(online, "wrangler.jsonc"), "utf8");
const strip = (text) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));

test("fills in wrangler.jsonc and keeps its comments", () => {
	const games = { "night-drive": { name: "Night Drive", steam_app_id: 4242, bundle_ids: ["com.example.nightdrive"] } };
	const out = configure(wranglerConfig, { name: "studio-online", databaseId: "11111111-2222-3333-4444-555555555555", games, emailDriver: "cloudflare", emailFrom: 'Night "Drive" <hi@example.com>' });
	const parsed = strip(out);
	assert.equal(parsed.name, "studio-online");
	assert.equal(parsed.d1_databases[0].database_name, "studio-online");
	assert.equal(parsed.d1_databases[0].database_id, "11111111-2222-3333-4444-555555555555");
	assert.equal(parsed.r2_buckets[0].bucket_name, "studio-online-saves");
	assert.deepEqual(parsed.vars.GAMES, games);
	assert.equal(parsed.vars.EMAIL_FROM, 'Night "Drive" <hi@example.com>');
	assert.equal(parsed.vars.EMAIL_DRIVER, "cloudflare");
	assert.ok(parsed.send_email);
	assert.ok(out.includes("// Worker logs stay off"));
});

test("drops Cloudflare's email binding for SMTP2GO", () => {
	const out = configure(wranglerConfig, { name: "x", databaseId: "d", games: { g: { name: "G" } }, emailDriver: "smtp2go", emailFrom: "G <g@example.com>" });
	const parsed = strip(out);
	assert.equal(parsed.vars.EMAIL_DRIVER, "smtp2go");
	assert.equal(parsed.send_email, undefined);
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
		const answers = { name: "Studio Online", game_id: "night-drive", game_name: "Night Drive", steam_app_id: "4242", email_driver: "smtp2go", email_from: "Night Drive <hi@example.com>", smtp2go_api_key: "api-x", steam_web_api_key: "", turn_key_id: "", git: "n" };
		const result = spawnSync("node", ["scripts/setup.mjs", "--dry-run"], { cwd: copy, encoding: "utf8", env: { ...process.env, PURR_SCRIPT_ANSWERS: JSON.stringify(answers) } });
		assert.equal(result.status, 0, result.stderr);
		const out = result.stdout;
		assert.match(out, /would run: npx wrangler d1 create studio-online\n/);
		assert.match(out, /would run: npx wrangler r2 bucket create studio-online-saves/);
		assert.match(out, /would run: npx wrangler r2 bucket lifecycle add studio-online-saves discarded-saves discarded\/ --expire-days 30 --force/);
		assert.match(out, /would run: npx wrangler d1 migrations apply studio-online --remote/);
		assert.match(out, /would run: npx wrangler deploy/);
		assert.match(out, /would run: npx wrangler secret bulk \(with input\)/);
		assert.match(out, /purr\/online\/game to its ID \(night-drive\)/);
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
