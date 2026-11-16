#!/usr/bin/env node
// Reviews players' reports and acts on them, on this instance's database: lists the players
// reported in the last 90 days, shows what was reported, and bans from multiplayer, lifts a ban,
// resets a name or dismisses the reports.
//
//   npm run moderate                                 the reported players, to review one by one
//   npm run moderate -- show <account>               one player's reports
//   npm run moderate -- find <name>                  players with that name
//   npm run moderate -- ban <account> <days|forever>
//   npm run moderate -- unban <account>
//   npm run moderate -- rename <account>             clears the name; the player chooses another
//   npm run moderate -- dismiss <account>            deletes the reports about the player
//
// Add --local to work on the local development database instead (wrangler dev's).

import { args, ask, confirm, databaseName, requireInstanceFolder, run, say, start, wrangler } from "./cli.mjs";

// Forever, for a ban with no end: the year 3000 (as the service's own).
const FOREVER = 32_503_680_000;
const DAY = 86_400;
const MAX_LISTED = 50;
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const local = args.includes("--local");
const persistTo = args.includes("--persist-to") ? args[args.indexOf("--persist-to") + 1] : "";
const positional = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--persist-to");

// Runs SQL on the database, returning each statement's rows. Wrangler can't bind values, so only
// checked account IDs, numbers and quoted text (see quote) ever go into a statement.
function sql(statement) {
	const target = local ? ["--local", ...(persistTo ? ["--persist-to", persistTo] : [])] : ["--remote"];
	const out = run(wrangler("d1", "execute", databaseName(), ...target, "--json", "--yes", "--command", statement), { capture: true });
	return JSON.parse(out).map((result) => result.results ?? []);
}

function quote(text) {
	return `'${text.replace(/[\p{Cc}\p{Cf}]/gu, "").replaceAll("'", "''")}'`;
}

function accountId(text) {
	const id = (text ?? "").trim().toLowerCase();
	if (!ACCOUNT_ID.test(id)) {
		throw new Error(`"${text ?? ""}" isn't an account ID.`);
	}
	return id;
}

const time = () => Math.floor(Date.now() / 1000);
const date = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function banText(bannedUntil) {
	if (bannedUntil <= time()) {
		return "";
	}
	return bannedUntil >= FOREVER ? "banned for good" : `banned until ${date(bannedUntil)}`;
}

function findAccount(id) {
	const [account] = sql(`SELECT id, display_name, name_chosen, banned_until, auto_bans, created_at FROM accounts WHERE id = ${quote(id)}`)[0];
	if (!account) {
		throw new Error(`There's no account ${id}.`);
	}
	return account;
}

function listReported() {
	const players = sql(
		`SELECT reports.reported_id AS id, accounts.display_name AS name, accounts.banned_until AS banned_until,
		        COUNT(*) AS reports, COUNT(DISTINCT reports.reporter_id) AS reporters,
		        group_concat(DISTINCT reports.reason) AS reasons, MAX(reports.created_at) AS latest
		 FROM reports JOIN accounts ON accounts.id = reports.reported_id
		 GROUP BY reports.reported_id ORDER BY reporters DESC, latest DESC LIMIT ${MAX_LISTED}`,
	)[0];
	if (players.length === 0) {
		say("No one has been reported.");
		return players;
	}
	players.forEach((player, index) => {
		const ban = banText(player.banned_until);
		say(`${String(index + 1).padStart(3)}. ${player.name || "(no name)"}  ${player.id}`);
		say(`     ${plural(player.reports, "report")} from ${plural(player.reporters, "player")}: ${player.reasons.split(",").join(", ")}; latest ${date(player.latest)}${ban ? `; ${ban}` : ""}`);
	});
	return players;
}

function show(id) {
	const account = findAccount(id);
	const ban = banText(account.banned_until);
	say(`${account.display_name || "(no name)"}  ${account.id}`);
	say(`Account since ${date(account.created_at)}${account.name_chosen ? ", chose their name" : ""}${ban ? `, ${ban}` : ""}${account.auto_bans ? `, ${plural(account.auto_bans, "automatic ban")}` : ""}`);
	const reports = sql(
		`SELECT reports.created_at, reports.game, reports.reason, reports.details, reports.automatic, reports.actioned,
		        reporters.display_name AS reporter, reports.reporter_id
		 FROM reports JOIN accounts AS reporters ON reporters.id = reports.reporter_id
		 WHERE reports.reported_id = ${quote(id)} ORDER BY reports.created_at DESC LIMIT 100`,
	)[0];
	say(reports.length === 0 ? "No reports." : "");
	for (const report of reports) {
		const by = report.automatic ? "the anti-cheat" : `${report.reporter || "(no name)"} (${report.reporter_id})`;
		say(`${date(report.created_at)}  ${report.game}  ${report.reason}${report.actioned ? " (acted on automatically)" : ""}, by ${by}`);
		if (report.details) {
			say(`    ${report.details}`);
		}
	}
}

function ban(id, length) {
	findAccount(id);
	const forever = /^forever$/i.test(length ?? "");
	const days = Number(length);
	if (!forever && !(Number.isInteger(days) && days > 0 && days <= 36_500)) {
		throw new Error('A ban is a number of days, or "forever".');
	}
	const until = forever ? FOREVER : time() + days * DAY;
	sql(`UPDATE accounts SET banned_until = ${until} WHERE id = ${quote(id)}`);
	say(forever ? "Banned from multiplayer for good." : `Banned from multiplayer until ${date(until)}.`);
}

function unban(id) {
	findAccount(id);
	sql(`UPDATE accounts SET banned_until = 0 WHERE id = ${quote(id)}`);
	say("The ban is lifted.");
}

function rename(id) {
	findAccount(id);
	sql(`UPDATE accounts SET display_name = '', name_chosen = 0 WHERE id = ${quote(id)}`);
	say("The name is cleared. The player gets their platform's name back, or chooses a new one.");
}

function dismiss(id) {
	findAccount(id);
	sql(`DELETE FROM reports WHERE reported_id = ${quote(id)}`);
	say("The reports are dismissed.");
}

function find(name) {
	const text = (name ?? "").trim();
	if (!text) {
		throw new Error("Give a name to look for.");
	}
	const pattern = quote(`%${text.replace(/[\\%_]/g, (match) => `\\${match}`)}%`);
	const accounts = sql(`SELECT id, display_name, banned_until FROM accounts WHERE display_name LIKE ${pattern} ESCAPE '\\' ORDER BY display_name LIMIT ${MAX_LISTED}`)[0];
	say(accounts.length === 0 ? "No one has that name." : "");
	for (const account of accounts) {
		const status = banText(account.banned_until);
		say(`${account.display_name}  ${account.id}${status ? `  (${status})` : ""}`);
	}
}

// Going through the reported players one at a time.
function review() {
	for (;;) {
		const players = listReported();
		if (players.length === 0) {
			return;
		}
		say();
		const choice = ask("player", "Review which player? (number or account ID, empty to finish)");
		if (!choice) {
			return;
		}
		const id = /^\d+$/.test(choice) ? players[Number(choice) - 1]?.id : choice;
		try {
			reviewOne(accountId(id ?? choice));
		} catch (error) {
			say(error.message);
		}
		say();
	}
}

function reviewOne(id) {
	say();
	show(id);
	say();
	const action = ask("action", "ban, unban, rename, dismiss, or empty to go back").toLowerCase();
	if (action === "ban") {
		ban(id, ask("days", 'For how many days? (or "forever")', "7"));
	} else if (action === "unban") {
		unban(id);
	} else if (action === "rename") {
		rename(id);
	} else if (action === "dismiss") {
		dismiss(id);
		return;
	} else {
		return;
	}
	if (confirm("clear", "Dismiss their reports too?", true)) {
		dismiss(id);
	}
}

async function main() {
	requireInstanceFolder();
	const [command, target, extra] = positional;
	const actions = {
		show: () => show(accountId(target)),
		find: () => find(positional.slice(1).join(" ")),
		ban: () => ban(accountId(target), extra),
		unban: () => unban(accountId(target)),
		rename: () => rename(accountId(target)),
		dismiss: () => dismiss(accountId(target)),
	};
	if (!command) {
		review();
	} else if (actions[command]) {
		actions[command]();
	} else {
		throw new Error(`There's no "${command}". Use show, find, ban, unban, rename or dismiss, or nothing to review the reported players.`);
	}
}

start(main);
