// What the command-line scripts (setup, update, moderate) share: questions, output, running
// commands (with --dry-run printing them instead) and reading this instance's settings.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";

export const args = process.argv.slice(2);
export const dryRun = args.includes("--dry-run");
// Scripted answers, for tests: a JSON object of question keys to answers.
const scripted = process.env.PURR_SCRIPT_ANSWERS ? JSON.parse(process.env.PURR_SCRIPT_ANSWERS) : null;
export const isScripted = scripted !== null;

// Questions read from the terminal itself, so the scripts also work when piped into a shell.
export function ask(key, question, fallback = "") {
	if (scripted) {
		return key in scripted ? String(scripted[key]) : fallback;
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

// Runs a script's main function, showing only the message of what went wrong.
export function start(main) {
	main().catch((error) => {
		process.stderr.write(`\n${error.message}\n`);
		process.exit(1);
	});
}
