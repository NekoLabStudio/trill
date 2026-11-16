#!/usr/bin/env node
// Sets up an instance of Purr's online services on your Cloudflare account, from this folder:
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
import { ask, confirm, dryRun, isScripted, requireInstanceFolder, run, say, start, wrangler } from "./cli.mjs";
import { configure } from "./configure.mjs";
import { UPSTREAM_CONFIG, readVersion } from "./release.mjs";

function slug(text) {
	return text.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

async function main() {
	requireInstanceFolder();
	say("Purr online services setup");
	say(readVersion(".") ? `Version: ${readVersion(".")}` : "");
	say();

	// 1. Cloudflare.
	// Signed out, whoami fails; that's the answer, not an error.
	const whoami = run(wrangler("whoami"), { capture: true, pretend: "You are logged in", allowFail: true });
	if (!/logged in/i.test(whoami)) {
		say("Sign in to Cloudflare in the browser window that opens.");
		run(wrangler("login"));
	}

	// 2. What this instance is.
	const name = slug(ask("name", "A name for this instance (the Worker, database and bucket are named after it)", "purr-online")) || "purr-online";
	const games = {};
	say();
	say("The games this instance serves. Each game sends its ID (online/game in its project).");
	do {
		const id = slug(ask("game_id", "Game ID", Object.keys(games).length === 0 ? "my-game" : ""));
		if (!id) {
			break;
		}
		const game = { name: ask("game_name", `${id}: its name, for emails`, id) };
		const steam = ask("steam_app_id", `${id}: Steam App ID (empty if not on Steam)`);
		if (/^\d+$/.test(steam)) {
			game.steam_app_id = Number(steam);
		}
		const bundles = ask("bundle_ids", `${id}: Apple bundle IDs for Game Center, comma-separated (empty if none)`);
		if (bundles) {
			game.bundle_ids = bundles.split(",").map((bundle) => bundle.trim()).filter(Boolean);
		}
		games[id] = game;
	} while (!isScripted && confirm("more_games", "Add another game?", false));

	say();
	say("Email: sign-in codes go out through Cloudflare's Email Sending (needs Workers Paid and your");
	say("domain onboarded in Cloudflare) or SMTP2GO (an API key from your SMTP2GO account).");
	const emailDriver = /^s/i.test(ask("email_driver", "cloudflare or smtp2go", "cloudflare")) ? "smtp2go" : "cloudflare";
	const emailFrom = ask("email_from", 'Send emails from ("Name <address>")', `${Object.values(games)[0]?.name ?? "Purr"} <noreply@example.com>`);
	const secrets = {};
	if (emailDriver === "smtp2go") {
		secrets.SMTP2GO_API_KEY = ask("smtp2go_api_key", "SMTP2GO API key");
	}
	if (Object.values(games).some((game) => game.steam_app_id)) {
		const key = ask("steam_web_api_key", "Steam publisher Web API key, for Steam sign-in (empty to add later)");
		if (key) {
			secrets.STEAM_WEB_API_KEY = key;
		}
	}
	say();
	say("TURN relays players who can't connect directly. Cloudflare's TURN service needs a key from");
	say("Realtime in the Cloudflare dashboard; without one, players only get Cloudflare's STUN server.");
	const turnId = ask("turn_key_id", "Cloudflare TURN key ID (empty to skip)");
	if (turnId) {
		secrets.TURN_KEY_ID = turnId;
		secrets.TURN_KEY_API_TOKEN = ask("turn_key_api_token", "Cloudflare TURN key API token");
	}

	// 3. The database and the saves bucket.
	say();
	say("Creating the database and the saves bucket...");
	const databases = JSON.parse(run(wrangler("d1", "list", "--json"), { capture: true, pretend: "[]" }) || "[]");
	let databaseId = databases.find((database) => database.name === name)?.uuid;
	if (!databaseId) {
		const created = run(wrangler("d1", "create", name), { capture: true, pretend: '"database_id": "00000000-0000-0000-0000-000000000000"' });
		databaseId = /database_id["\s:=]+"([0-9a-f-]{36})"/.exec(created)?.[1];
		if (!databaseId) {
			throw new Error("Couldn't read the new database's ID from Wrangler.");
		}
	}
	const buckets = run(wrangler("r2", "bucket", "list"), { capture: true, pretend: "" });
	if (!new RegExp(`name:\\s*${name}-saves\\b`).test(buckets)) {
		run(wrangler("r2", "bucket", "create", `${name}-saves`));
	}
	// Saves set aside (when accounts join) go after 30 days.
	run(wrangler("r2", "bucket", "lifecycle", "add", `${name}-saves`, "discarded-saves", "discarded/", "--expire-days", "30", "--force"), { capture: true });

	// 4. The settings. The release's own wrangler.jsonc is kept first, so updates can show what
	// changes in it.
	if (!existsSync(UPSTREAM_CONFIG) && !dryRun) {
		mkdirSync(".purr-upstream", { recursive: true });
		copyFileSync("wrangler.jsonc", UPSTREAM_CONFIG);
	}
	const config = configure(readFileSync("wrangler.jsonc", "utf8"), { name, databaseId, games, emailDriver, emailFrom });
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

	const existing = run(wrangler("secret", "list", "--format", "json"), { capture: true, pretend: "[]" });
	const have = new Set((() => {
		try {
			return JSON.parse(existing).map((secret) => secret.name);
		} catch {
			return [];
		}
	})());
	let identitySecret = "";
	if (!have.has("IDENTITY_SECRET")) {
		identitySecret = randomBytes(32).toString("base64url");
		secrets.IDENTITY_SECRET = identitySecret;
	}
	if (!have.has("SESSION_SECRET")) {
		secrets.SESSION_SECRET = randomBytes(32).toString("base64url");
	}
	if (Object.keys(secrets).length > 0) {
		run(wrangler("secret", "bulk"), { input: JSON.stringify(secrets) });
	}

	// 6. A git repository for the instance.
	if (!existsSync(".git") && confirm("git", "Make this folder a git repository, with a first commit?", true)) {
		run(["git", "init", "-q"]);
		run(["git", "add", "-A"]);
		run(["git", "commit", "-q", "-m", `Purr online services ${readVersion(".") || ""}`.trim()]);
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
	say(`In each game's project, set online/url to that address and online/game to its ID (${Object.keys(games).join(", ")}).`);
	if (identitySecret) {
		say();
		say("Keep this identity secret somewhere safe, such as a password manager. If it's ever lost,");
		say("no existing player can be matched to their account again:");
		say(`  ${identitySecret}`);
	}
	if (emailDriver === "cloudflare") {
		say();
		say("Email: onboard the sender's domain under Email Service > Email Sending in the Cloudflare");
		say("dashboard, if you haven't, and make sure the account is on Workers Paid.");
	}
	say();
	say("Later, `npm run update` brings in Purr's newest release.");
}

start(main);
