#!/usr/bin/env node
// Brings this instance up to Purr's newest stable release: replaces the files that come from Purr
// (src/, migrations/, tests and scripts) and keeps the instance's own (custom email templates,
// secrets). wrangler.jsonc gets what the release adds to its settings, and defaults the instance
// never changed follow the release's; anything else is listed for you. Then it notes a restore
// point for the database, applies new migrations and offers to deploy.
//
//   npm run update                  the newest stable release
//   npm run update -- v1.2.3        a particular release
//   npm run update -- --dry-run     says what it would do

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { args, confirm, databaseName, dryRun, requireInstanceFolder, run, say, start, wrangler } from "./cli.mjs";
import { UPSTREAM_CONFIG, copyUpstream, fetchRelease, latestRelease, readVersion, writeVersion } from "./release.mjs";
import { mergeRelease } from "./settings.mjs";

const wanted = args.find((arg) => /^v\d+\.\d+\.\d+$/.test(arg));

function list(title, lines) {
	if (lines.length > 0) {
		say();
		say(title);
		for (const line of lines) {
			say(`  ${line}`);
		}
	}
}

async function main() {
	requireInstanceFolder();
	const current = readVersion(".");
	const tag = wanted ?? (await latestRelease());
	if (current === tag) {
		say(`Already on Purr ${tag}.`);
		return;
	}
	say(`Updating from ${current || "an unknown version"} to Purr ${tag}...`);
	if (!dryRun && spawnSync("git", ["diff", "--quiet", "HEAD"], { stdio: "ignore" }).status === 1) {
		throw new Error("Commit or put aside your changes first, so the update's changes are easy to review.");
	}

	const release = await fetchRelease(tag);
	try {
		const before = existsSync(UPSTREAM_CONFIG) ? readFileSync(UPSTREAM_CONFIG, "utf8") : "";
		const after = readFileSync(`${release.dir}/wrangler.jsonc`, "utf8");
		if (dryRun) {
			say("  would replace src/ (keeping src/email-templates/custom/), migrations/, test/, scripts/ and the package files");
		} else {
			copyUpstream(release.dir, ".");
			writeVersion(".", tag);
		}
		if (before) {
			const merged = mergeRelease(readFileSync("wrangler.jsonc", "utf8"), before, after);
			if (!dryRun) {
				writeFileSync("wrangler.jsonc", merged.text);
			}
			list("New settings from the release, added to wrangler.jsonc:", merged.added);
			list("Defaults you hadn't changed, now the release's:", merged.updated);
			list("Defaults the release changed that you had set yourself (yours are kept; see its upgrade notes):", merged.kept);
			list("Settings the release no longer uses (you can remove them from wrangler.jsonc):", merged.unused);
			list("New resources the release needs, which you create (see its upgrade notes):", merged.resources);
		} else {
			say();
			say("This instance doesn't have the last release's own wrangler.jsonc to compare with, so yours is");
			say("untouched; copy over what you need from the release's:");
			spawnSync("git", ["diff", "--no-index", "--no-prefix", "--", "wrangler.jsonc", `${release.dir}/wrangler.jsonc`], { stdio: "inherit" });
		}
	} finally {
		release.cleanup();
	}

	run(["npm", "install", "--no-audit", "--no-fund"], { capture: true });
	// D1 keeps 30 days of history: where it stands now is the way back if a migration goes wrong.
	const database = databaseName();
	const info = run(wrangler("d1", "time-travel", "info", database, "--json"), { capture: true, pretend: '{"bookmark": "(bookmark)"}', allowFail: true });
	const bookmark = (() => {
		try {
			return JSON.parse(info).bookmark ?? "";
		} catch {
			return "";
		}
	})();
	run(wrangler("d1", "migrations", "apply", database, "--remote"), { capture: true });
	say();
	say(`Updated to Purr ${tag}.`);
	if (bookmark) {
		say("If the database needs to go back to how it was before the update:");
		say(`  npx wrangler d1 time-travel restore ${database} --bookmark=${bookmark}`);
	}
	if (confirm("deploy", "Deploy it now?", true)) {
		run(wrangler("deploy"), { capture: true });
		say(dryRun ? "" : "Deployed. Commit the changes with git.");
	} else {
		say("Deploy with `npx wrangler deploy` when you're ready, and commit the changes with git.");
	}
}

start(main);
