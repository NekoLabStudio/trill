#!/usr/bin/env node
// Works through the crash reports players' games have sent, on this instance's database: lists
// the crashes of the last 90 days, the most frequent first, shows a crash's reports, and deletes
// one once it's fixed.
//
//   npm run crashes                         the crashes, to read one by one
//   npm run crashes -- version <version>    only those seen in that game version
//   npm run crashes -- show <crash>         a crash's newest report (its ID is in the list)
//   npm run crashes -- delete <crash>       forgets a crash, once it's fixed
//
// Add --local to work on the local development database instead (wrangler dev's).

import { ask, positional, quote, requireInstanceFolder, say, sql, start } from "./cli.mjs";

const MAX_LISTED = 50;
const CRASH_ID = /^[0-9a-f]{16}$/;

function crashId(text) {
	const id = (text ?? "").trim().toLowerCase();
	if (!CRASH_ID.test(id)) {
		throw new Error(`"${text ?? ""}" isn't a crash's ID (16 letters and digits, from the list).`);
	}
	return id;
}

const date = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function versions(crash) {
	if (!crash.first_version) {
		return "";
	}
	return crash.first_version === crash.last_version ? `version ${crash.first_version}` : `versions ${crash.first_version} to ${crash.last_version}`;
}

function list(version) {
	const filter = version ? `WHERE EXISTS (SELECT 1 FROM crash_reports WHERE crash_reports.game = crash_groups.game AND crash_reports.signature = crash_groups.signature AND crash_reports.version = ${quote(version)})` : "";
	const crashes = sql(`SELECT * FROM crash_groups ${filter} ORDER BY count DESC, last_seen_at DESC LIMIT ${MAX_LISTED}`)[0];
	if (crashes.length === 0) {
		say(version ? `No crashes in version ${version}.` : "No crashes have been reported.");
		return crashes;
	}
	crashes.forEach((crash, index) => {
		const seen = [versions(crash), `last ${date(crash.last_seen_at)}`, `first ${date(crash.first_seen_at)}`].filter(Boolean).join("; ");
		say(`${String(index + 1).padStart(3)}. ${crash.title}`);
		say(`     ${plural(crash.count, "report")} from ${crash.game}; ${seen}; ${crash.signature}`);
	});
	return crashes;
}

function findCrash(id) {
	const [crash] = sql(`SELECT * FROM crash_groups WHERE signature = ${quote(id)}`)[0];
	if (!crash) {
		throw new Error(`There's no crash ${id}.`);
	}
	return crash;
}

// The crash and one of its reports in full: the newest, or the one so many before it.
function show(id, older = 0) {
	const crash = findCrash(id);
	const kept = sql(`SELECT COUNT(*) AS n FROM crash_reports WHERE game = ${quote(crash.game)} AND signature = ${quote(id)}`)[0][0].n;
	say(crash.title);
	say(`${plural(crash.count, "report")} from ${crash.game}, ${[versions(crash), `last ${date(crash.last_seen_at)}`, `first ${date(crash.first_seen_at)}`].filter(Boolean).join(", ")}`);
	const [report] = sql(
		`SELECT version, report, created_at FROM crash_reports WHERE game = ${quote(crash.game)} AND signature = ${quote(id)}
		 ORDER BY created_at DESC LIMIT 1 OFFSET ${older}`,
	)[0];
	if (!report) {
		say("No report of it is kept in full.");
		return 0;
	}
	say();
	say(`Report ${older + 1} of the ${kept} kept, sent ${date(report.created_at)}${report.version ? ` from version ${report.version}` : ""}:`);
	say();
	say(report.report.trimEnd());
	return kept;
}

function remove(id) {
	const crash = findCrash(id);
	sql(`DELETE FROM crash_reports WHERE game = ${quote(crash.game)} AND signature = ${quote(id)}; DELETE FROM crash_groups WHERE game = ${quote(crash.game)} AND signature = ${quote(id)}`);
	say("Forgotten. If it happens again, it's listed again.");
}

// Going through the crashes one at a time.
function review(version) {
	for (;;) {
		const crashes = list(version);
		if (crashes.length === 0) {
			return;
		}
		say();
		const choice = ask("crash", "Read which crash? (number or ID, empty to finish)");
		if (!choice) {
			return;
		}
		try {
			reviewOne(crashId(/^\d+$/.test(choice) && Number(choice) <= crashes.length ? crashes[Number(choice) - 1].signature : choice));
		} catch (error) {
			say(error.message);
		}
		say();
	}
}

function reviewOne(id) {
	let older = 0;
	for (;;) {
		say();
		const kept = show(id, older);
		say();
		const more = older + 1 < kept;
		const action = ask("action", `${more ? "older, " : ""}delete (once it's fixed), or empty to go back`).toLowerCase();
		if (action === "older" && more) {
			older++;
		} else if (action === "delete") {
			remove(id);
			return;
		} else {
			return;
		}
	}
}

async function main() {
	requireInstanceFolder();
	const [command, target] = positional;
	const actions = {
		show: () => show(crashId(target)),
		delete: () => remove(crashId(target)),
		version: () => {
			if (!target) {
				throw new Error("Give a version, as the game has it (application/config/version).");
			}
			review(target);
		},
	};
	if (!command) {
		review();
	} else if (actions[command]) {
		actions[command]();
	} else {
		throw new Error(`There's no "${command}". Use show, delete or version, or nothing to go through the crashes.`);
	}
}

start(main);
