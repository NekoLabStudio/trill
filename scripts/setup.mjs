#!/usr/bin/env node
// Sets up an instance of Trill on your Cloudflare account, from this folder:
// asks what it needs, creates the database and bucket, fills in wrangler.jsonc, applies the
// migrations, deploys, stores the secrets and makes the folder a git repository.
//
//   npm run setup               (or: node scripts/setup.mjs)
//   npm run setup -- --dry-run  prints the commands instead of running them
//
// Running it again is safe: it finds the database, bucket and secrets it made before.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ask, confirm, dryRun, isScripted, requireInstanceFolder, run, say, secretNames, start, wrangler } from "./cli.mjs";
import { Changes, editEmail, editGame, editTurn, slug } from "./settings.mjs";
import { UPSTREAM_CONFIG, readVersion } from "./release.mjs";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
	requireInstanceFolder();
	say("Trill setup");
	say(readVersion(".") ? `Version: ${readVersion(".")}` : "");
	say();

	// 1. Cloudflare.
	// Signed out, whoami fails; that's the answer, not an error.
	const whoami = run(wrangler("whoami"), { capture: true, pretend: "You are logged in", allowFail: true });
	if (!/logged in/i.test(whoami)) {
		say("Sign in to Cloudflare in the browser window that opens.");
		run(wrangler("login"));
	}

	// 2. What this instance is: its name, games, email and TURN (the same questions as `npm run
	// configure`, which changes them later). Run again, setup shows the answers it had.
	const changes = new Changes(readFileSync("wrangler.jsonc", "utf8"), secretNames());
	const name = slug(ask("name", "A name for this instance (the Worker, database and bucket are named after it)", changes.get(["name"]))) || "trill";
	// The release's example game makes way for the instance's own.
	if (same(Object.keys(changes.get(["vars", "GAMES"]) ?? {}), ["example"])) {
		changes.set(["vars", "GAMES"], {}, "Games");
	}
	say();
	say("The games this instance serves. Each game sends its ID (online/game in its project).");
	do {
		const known = Object.keys(changes.get(["vars", "GAMES"]) ?? {});
		const id = slug(ask("game_id", known.length > 0 ? `Game ID (Enter to keep ${known.join(", ")} as they are)` : "Game ID", known.length === 0 ? "my-game" : ""));
		if (!id) {
			break;
		}
		editGame(changes, id, { more: false });
	} while (!isScripted && confirm("more_games", "Add or change another game?", false));
	const games = Object.keys(changes.get(["vars", "GAMES"]) ?? {});
	editEmail(changes, `${changes.get(["vars", "GAMES", games[0], "name"]) ?? "Trill"} <noreply@example.com>`);
	editTurn(changes);

	// 3. The database and the saves bucket. Wrangler is told not to add them to wrangler.jsonc
	// itself: it would add second bindings beside the ones setup fills in.
	say();
	say("Creating the database and the saves bucket...");
	const databases = JSON.parse(run(wrangler("d1", "list", "--json"), { capture: true, pretend: "[]" }) || "[]");
	let databaseId = databases.find((database) => database.name === name)?.uuid;
	if (!databaseId) {
		const created = run(wrangler("d1", "create", name, "--update-config=false"), { capture: true, pretend: '"database_id": "00000000-0000-0000-0000-000000000000"' });
		databaseId = /database_id["\s:=]+"([0-9a-f-]{36})"/.exec(created)?.[1];
		if (!databaseId) {
			throw new Error("Couldn't read the new database's ID from Wrangler.");
		}
	}
	const buckets = run(wrangler("r2", "bucket", "list"), { capture: true, pretend: "" });
	if (!new RegExp(`name:\\s*${name}-saves\\b`).test(buckets)) {
		run(wrangler("r2", "bucket", "create", `${name}-saves`, "--update-config=false"));
	}
	// Saves set aside (when accounts join) go after 30 days. Added once: Cloudflare refuses a rule
	// that's already there, as it is when setup runs again.
	const rules = run(wrangler("r2", "bucket", "lifecycle", "list", `${name}-saves`), { capture: true, pretend: "", allowFail: true }) ?? "";
	if (!rules.includes("discarded-saves")) {
		run(wrangler("r2", "bucket", "lifecycle", "add", `${name}-saves`, "discarded-saves", "discarded/", "--expire-days", "30", "--force"), { capture: true });
	}

	// 4. The settings. The release's own wrangler.jsonc is kept first, so updates can show what
	// changes in it.
	if (!existsSync(UPSTREAM_CONFIG) && !dryRun) {
		mkdirSync(".trill-upstream", { recursive: true });
		copyFileSync("wrangler.jsonc", UPSTREAM_CONFIG);
	}
	changes.set(["name"], name, "Name");
	changes.set(["d1_databases", 0, "database_name"], name, "Database");
	changes.set(["d1_databases", 0, "database_id"], databaseId, "Database ID");
	changes.set(["r2_buckets", 0, "bucket_name"], `${name}-saves`, "Saves bucket");
	const config = changes.text();
	if (dryRun) {
		say("  would write wrangler.jsonc");
	} else {
		writeFileSync("wrangler.jsonc", config);
	}

	// 5. The database's tables, the Worker and its secrets.
	say("Setting up the database and deploying...");
	run(wrangler("d1", "migrations", "apply", name, "--remote"), { capture: true });
	const deployed = run(wrangler("deploy"), { capture: true, pretend: `https://${name}.example.workers.dev` });
	const url = /https:\/\/[^\s]+\.workers\.dev/.exec(deployed)?.[0] ?? "";

	const secrets = { ...changes.secrets };
	let identitySecret = "";
	if (!changes.hasSecret("IDENTITY_SECRET")) {
		identitySecret = randomBytes(32).toString("base64url");
		secrets.IDENTITY_SECRET = identitySecret;
	}
	if (!changes.hasSecret("SESSION_SECRET")) {
		secrets.SESSION_SECRET = randomBytes(32).toString("base64url");
	}
	for (const secretName of changes.dropped) {
		run(wrangler("secret", "delete", secretName), { capture: true });
	}
	if (Object.keys(secrets).length > 0) {
		run(wrangler("secret", "bulk"), { input: JSON.stringify(secrets) });
	}

	// 6. A git repository for the instance.
	if (!existsSync(".git") && confirm("git", "Make this folder a git repository, with a first commit?", true)) {
		run(["git", "init", "-q"]);
		run(["git", "add", "-A"]);
		run(["git", "commit", "-q", "-m", `Trill ${readVersion(".") || ""}`.trim()]);
		const hasGh = !dryRun && spawnSync("gh", ["--version"], { stdio: "ignore" }).status === 0;
		if ((hasGh || dryRun) && confirm("github", `Create a private GitHub repository called ${name} and push to it?`, false)) {
			run(["gh", "repo", "create", name, "--private", "--source", ".", "--push"]);
		}
	}

	say();
	say("Done.");
	if (url) {
		say(`The service is at ${url}`);
	}
	say(`In each game's project, set online/url to that address and online/game to its ID (${games.join(", ")}).`);
	if (identitySecret) {
		say();
		say("Keep this identity secret somewhere safe, such as a password manager. If it's ever lost,");
		say("no existing player can be matched to their account again:");
		say(`  ${identitySecret}`);
	}
	if (changes.get(["vars", "EMAIL_DRIVER"]) === "cloudflare") {
		say();
		say("Email: onboard the sender's domain under Email Service > Email Sending in the Cloudflare");
		say("dashboard, if you haven't, and make sure the account is on Workers Paid.");
	}
	say();
	say("Later, `npm run update` brings in Trill's newest release.");
}

start(main);
