#!/usr/bin/env node
// Changes this instance's settings and secrets: its games and their sign-ins, email, TURN,
// moderation, retention, limits, and rotating the identity secret. Each question shows the
// current value, which Enter keeps. Nothing changes until the summary at the end is confirmed;
// then wrangler.jsonc is written, the secrets are stored and the instance deployed.
//
//   npm run configure
//   npm run configure -- --dry-run   asks, then shows what it would change

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ask, confirm, dryRun, quote, requireInstanceFolder, run, say, secretNames, sql, start, wrangler } from "./cli.mjs";
import { Changes, editEmail, editGames, editModeration, editRateLimits, editRetention, editTurn } from "./settings.mjs";

// Rotating the identity secret, which every player's identities are kept under (hashed). The
// current secret becomes IDENTITY_SECRET_PREVIOUS, under which identities are still found and
// moved to the new one as players sign in. Checked first: a wrong secret would lose everyone.
function rotateIdentitySecret(changes) {
	say();
	say("Every player's identities (platforms, devices, emails) are kept hashed with the identity secret.");
	say("Rotating it moves them to a new one as players sign in. It needs the current secret, which");
	say("setup showed once; if it's lost, it can't be rotated.");
	if (!confirm("rotate", "Rotate the identity secret?", false)) {
		return;
	}
	const version = Number(changes.get(["vars", "IDENTITY_KEY_VERSION"]) ?? 1);
	if (changes.hasSecret("IDENTITY_SECRET_PREVIOUS")) {
		const [[{ n: waiting }]] = sql(`SELECT COUNT(*) AS n FROM identities WHERE key_version < ${version}`, '[{"results": [{"n": 0}]}]');
		if (waiting > 0) {
			say(`${waiting} identities haven't moved to the current secret since the last rotation (their players`);
			say("haven't signed in since). Rotating again would lose them, so it has to wait.");
			return;
		}
	}
	const current = ask("identity_secret", "The current identity secret");
	const email = (ask("identity_check_email", "An email address with an account here (yours, say), to check it")).trim().toLowerCase();
	const hash = createHmac("sha256", current).update(`email:${email}`).digest("hex");
	const [[{ n: found }]] = sql(`SELECT COUNT(*) AS n FROM identities WHERE identity_hash = ${quote(hash)}`, '[{"results": [{"n": 1}]}]');
	if (!found) {
		say("No account has that address under that secret: either the secret or the address is wrong.");
		say("Nothing was changed.");
		return;
	}
	changes.newIdentitySecret = randomBytes(32).toString("base64url");
	changes.setSecret("IDENTITY_SECRET_PREVIOUS", current);
	changes.setSecret("IDENTITY_SECRET", changes.newIdentitySecret);
	changes.set(["vars", "IDENTITY_KEY_VERSION"], version + 1, "Identity key version");
}

// Writes the settings, stores the secrets and deploys, once the changes are confirmed.
function save(changes) {
	const summary = changes.summary();
	if (summary.length === 0) {
		say("Nothing changed.");
		return;
	}
	say();
	say("Changes:");
	for (const line of summary) {
		say(`  ${line}`);
	}
	if (!confirm("save", "Save these changes?", true)) {
		say("Nothing was changed.");
		return;
	}
	if (changes.settingsChanged) {
		if (dryRun) {
			say("  would write wrangler.jsonc");
		} else {
			writeFileSync("wrangler.jsonc", changes.text());
		}
		// A new identity key version only means something deployed with the new secret.
		if (changes.newIdentitySecret || confirm("deploy", "Deploy now?", true)) {
			run(wrangler("deploy"), { capture: true });
			if (!dryRun) {
				say("Deployed.");
			}
		} else {
			say("Deploy with `npx wrangler deploy` when you're ready.");
		}
	}
	for (const name of changes.dropped) {
		run(wrangler("secret", "delete", name), { capture: true });
	}
	if (Object.keys(changes.secrets).length > 0) {
		run(wrangler("secret", "bulk"), { input: JSON.stringify(changes.secrets), capture: true });
		if (!dryRun) {
			say("Secrets stored.");
		}
	}
	if (changes.newIdentitySecret) {
		say();
		say("Keep the new identity secret somewhere safe, such as a password manager, in place of the old one:");
		say(`  ${changes.newIdentitySecret}`);
	}
	if (changes.settingsChanged && existsSync(".git")) {
		say("Commit wrangler.jsonc, so this instance's repository keeps the change.");
	}
}

async function main() {
	requireInstanceFolder();
	const changes = new Changes(readFileSync("wrangler.jsonc", "utf8"), secretNames());
	const sections = [
		["Games", (c) => editGames(c), () => Object.keys(changes.get(["vars", "GAMES"]) ?? {}).join(", ") || "none"],
		["Email", editEmail],
		["TURN", editTurn],
		["Moderation (automatic bans, action on reports, the daily email)", editModeration],
		["Retention and save limits", editRetention],
		["Rate limits", editRateLimits],
		["Rotate the identity secret", rotateIdentitySecret],
	];
	for (;;) {
		say();
		say("What would you like to change?");
		sections.forEach(([title, , detail], index) => say(`  ${index + 1}. ${title}${detail ? ` (${detail()})` : ""}`));
		const answer = ask("menu", "A number, or Enter when you're done");
		if (!answer) {
			break;
		}
		const section = sections[Number(answer) - 1];
		if (section) {
			section[1](changes);
		}
	}
	save(changes);
}

start(main);
