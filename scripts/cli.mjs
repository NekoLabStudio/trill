// What the command-line scripts (setup, configure, update, moderate) share: questions, output,
// running commands (with --dry-run printing them instead), the database and this instance's
// settings and secrets.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";

export const args = process.argv.slice(2);
export const dryRun = args.includes("--dry-run");
// Scripted answers, for tests: a JSON object of question keys to answers. A list answers the
// same question again and again, in turn (a menu, say).
const scripted = process.env.PURR_SCRIPT_ANSWERS ? JSON.parse(process.env.PURR_SCRIPT_ANSWERS) : null;
export const isScripted = scripted !== null;

// Questions read from the terminal itself, so the scripts also work when piped into a shell.
export function ask(key, question, fallback = "") {
	if (scripted) {
		if (!(key in scripted)) {
			return fallback;
		}
		const answer = Array.isArray(scripted[key]) ? scripted[key].shift() : scripted[key];
		if (answer === undefined) {
			throw new Error(`No scripted answer left for "${key}".`);
		}
		return String(answer) || fallback;
	}
	process.stdout.write(`${question}${fallback ? ` [${fallback}]` : ""}: `);
	const tty = openSync("/dev/tty", "r");
	const buffer = Buffer.alloc(1024);
	let line = "";
	for (;;) {
		const read = readSync(tty, buffer, 0, buffer.length, null);
		line += buffer.toString("utf8", 0, read);
		if (read === 0 || line.includes("\n")) {
			break;
		}
	}
	closeSync(tty);
	return line.trim() || fallback;
}

export function confirm(key, question, fallback) {
	return /^y/i.test(ask(key, `${question} (y/n)`, fallback ? "y" : "n"));
}

export function say(text = "") {
	process.stdout.write(`${text}\n`);
}

// Runs a command. In a dry run, prints it and returns `pretend`.
export function run(command, { input, capture = false, pretend = "", allowFail = false } = {}) {
	if (dryRun) {
		say(`  would run: ${command.join(" ")}${input ? " (with input)" : ""}`);
		return pretend;
	}
	const result = spawnSync(command[0], command.slice(1), {
		input,
		encoding: "utf8",
		stdio: capture || input ? ["pipe", "pipe", allowFail ? "pipe" : "inherit"] : "inherit",
		env: { ...process.env, CI: input || capture ? "1" : process.env.CI ?? "" },
	});
	if (result.status !== 0 && !allowFail) {
		throw new Error(`${command.join(" ")} failed.`);
	}
	return result.stdout ?? "";
}

export const wrangler = (...commandArgs) => ["npx", "wrangler", ...commandArgs];

export function requireInstanceFolder() {
	if (!existsSync("wrangler.jsonc") || !existsSync("src/index.ts")) {
		throw new Error("Run this from the online services' folder.");
	}
}

export function databaseName() {
	return /"database_name":\s*"([^"]+)"/.exec(readFileSync("wrangler.jsonc", "utf8"))?.[1] ?? "";
}

// --local works on the local development database instead (wrangler dev's), optionally in
// --persist-to's folder.
export const local = args.includes("--local");
const persistTo = args.includes("--persist-to") ? args[args.indexOf("--persist-to") + 1] : "";
export const positional = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--persist-to");

// Runs SQL on the database, returning each statement's rows. Wrangler can't bind values, so only
// checked IDs, numbers and quoted text (see quote) ever go into a statement.
export function sql(statement, pretend = "[]") {
	const target = local ? ["--local", ...(persistTo ? ["--persist-to", persistTo] : [])] : ["--remote"];
	const out = run(wrangler("d1", "execute", databaseName(), ...target, "--json", "--yes", "--command", statement), { capture: true, pretend });
	return JSON.parse(out).map((result) => result.results ?? []);
}

export function quote(text) {
	return `'${text.replace(/[\p{Cc}\p{Cf}]/gu, "").replaceAll("'", "''")}'`;
}

// The names of the deployed Worker's secrets (never their values).
export function secretNames() {
	const out = run(wrangler("secret", "list", "--format", "json"), { capture: true, pretend: "[]", allowFail: true });
	try {
		return JSON.parse(out).map((secret) => secret.name);
	} catch {
		return [];
	}
}

// Runs a script's main function, showing only the message of what went wrong.
export function start(main) {
	main().catch((error) => {
		process.stderr.write(`\n${error.message}\n`);
		process.exit(1);
	});
}
