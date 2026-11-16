#!/usr/bin/env node
// Brings this instance up to Purr's newest stable release: replaces the files that come from Purr
// (src/, migrations/, tests and scripts), keeps the instance's own (wrangler.jsonc, custom email
// templates, secrets), shows what changed in the release's default settings, applies new database
// migrations and offers to deploy. Review the changes with git before committing them.
//
//   npm run update                  the newest stable release
//   npm run update -- v1.2.3        a particular release
//   npm run update -- --dry-run     says what it would do

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { args, databaseName, dryRun, requireInstanceFolder, run, say, start } from "./cli.mjs";
import { UPSTREAM_CONFIG, copyUpstream, fetchRelease, latestRelease, readVersion, writeVersion } from "./release.mjs";

const wanted = args.find((arg) => /^v\d+\.\d+\.\d+$/.test(arg));

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
		if (before && before !== after) {
			say();
			say("The release's default wrangler.jsonc changed. Yours is untouched; copy over what you need:");
			spawnSync("git", ["diff", "--no-index", "--no-prefix", "--", "-", `${release.dir}/wrangler.jsonc`], { input: before, stdio: ["pipe", "inherit", "inherit"] });
		}
	} finally {
		release.cleanup();
	}

	run(["npm", "install", "--no-audit", "--no-fund"]);
	run(["npx", "wrangler", "d1", "migrations", "apply", databaseName(), "--remote"]);
	say();
	say(`Updated to Purr ${tag}. Review the changes with git, then deploy with \`npx wrangler deploy\`.`);
}

start(main);
