// Crash reports, sent by games (the engine's CrashReports) for players who agreed to it: the text
// of what the game ran on and the end of its log. Reports with the same signature, the top of
// the backtrace, are one crash with a count, so one a thousand players hit is one entry; the
// newest few of each keep their text. Nothing says who sent a report, and email and IP addresses
// in the text are removed before it's stored. The operator reads them with npm run crashes.

import type { Env } from "./env";
import { HttpError, requireString } from "./http";
import { requireGame } from "./identities";
import { DAY, now } from "./time";

export const MAX_CRASH_REPORT_BYTES = 65536;
// Reports kept in full for each crash; the rest only count.
export const KEPT_PER_CRASH = 10;
// What's kept in full for each game a day, at most, unless MAX_CRASH_REPORT_BYTES_PER_DAY says
// otherwise: past it, crashes already known still count, but nothing more is stored that day. Over
// the 90 days reports are kept, the default comes to 180 MB at most, well within D1's smallest plan.
export const DEFAULT_MAX_CRASH_REPORT_BYTES_PER_DAY = 2_000_000;
export const CRASH_REPORT_DAYS = 90;
const MAX_VERSION = 64;
const MAX_TITLE = 200;
const FRAMES = 3;

// Addresses a log may hold (a player's email, a server's or a peer's IP address), and a home
// folder, often named for the player, replaced. The engine does the same before sending.
export function redact(text: string): string {
	return text
		// A Mac's or Linux's short name has no spaces; a Windows one may.
		.replace(/(\/Users\/|\/home\/)[^/\s]{1,128}|[A-Za-z]:\\Users\\[^\\/\n]{1,128}?(?=\\|$)/gm, "~")
		// Every repeat is bounded, so no text can make these slow.
		.replace(/[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g, "[email]")
		.replace(/(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])/g, "[address]")
		.replace(/(?<![\w:])[0-9a-f:]{2,45}(?:%\w{1,16})?(?![\w:])/gi, (match) => {
			const ipv6 = /[0-9a-f]/i.test(match) && (match.includes("::") || match.split(":").length >= 4);
			return ipv6 ? "[address]" : match;
		});
}

// What groups a report with others of the same crash, and how the crash is listed. Only what the
// engine printed as it crashed counts (errors logged before it come with backtraces of their
// own): the top of its GDScript backtrace if the crash came from a script (the function and line,
// the same in every build), else the top of the engine's backtrace (the same within a build).
// A run with neither was closed by force, or stopped without saying why.
export async function signatureOf(game: string, report: string): Promise<{ signature: string; title: string }> {
	const lines = report.split("\n");
	const crashed = lines.findIndex((line) => line.includes("Dumping the backtrace"));
	const after = crashed < 0 ? [] : lines.slice(crashed + 1);
	let kind = "none";
	let frames: string[] = [];
	const script = after.findIndex((line) => line.includes("GDScript backtrace (most recent call first):"));
	if (script >= 0) {
		for (const line of after.slice(script + 1)) {
			const frame = /^\s*\[\d+\]\s+(.+?\(res:\/\/[^)]*\))\s*$/.exec(line);
			if (!frame) {
				break;
			}
			frames.push(frame[1]);
		}
		kind = "script";
	}
	if (frames.length === 0) {
		// Each frame's place in its binary, as every run of the same build has it, without the run's
		// own addresses ("[2] 1052cde2c (main+45fde2c) - TT_RunIns + 14715348" on a Mac,
		// "[3] /lib/libc.so.6(+0x42520) [0x7f3a...]" on Linux), past the crash handler's frames.
		const end = after.findIndex((line) => line.includes("END OF C++ BACKTRACE"));
		const native = after.slice(0, end < 0 ? undefined : end).flatMap((line) => {
			const frame = /^\s*\[\d+\]\s+(.+)$/.exec(line);
			if (!frame) {
				return [];
			}
			const place = frame[1].replace(/\[0x[0-9a-f]+\]/gi, "").replace(/^[0-9a-f]{6,}\s+/i, "").trim();
			return /_sigtramp|libsystem_platform|crash_handler|handle_crash|KiUserExceptionDispatcher/i.test(place) ? [] : [place];
		});
		// The first is the handler that caught the crash.
		frames = native.slice(1);
		kind = frames.length > 0 ? "native" : "none";
	}
	frames = frames.slice(0, FRAMES);
	const title = (frames[0] ?? "No backtrace: closed by force, or stopped without saying why").slice(0, MAX_TITLE);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode([game, kind, ...frames].join("\n")));
	const signature = [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return { signature, title };
}

// The game's version comes from X-Game-Version, as every request from a game says it.
export async function receiveCrashReport(env: Env, accountId: string, body: Record<string, unknown>, versionHeader: string | null): Promise<{ received: true }> {
	const game = requireString(body, "game", 64);
	const settings = requireGame(env, game);
	if (settings.crash_reports === false) {
		throw new HttpError(403, "crash_reports_off", "This game doesn't take crash reports.");
	}
	const text = requireString(body, "report", MAX_CRASH_REPORT_BYTES);
	if (new TextEncoder().encode(text).length > MAX_CRASH_REPORT_BYTES) {
		throw new HttpError(413, "too_large", `A crash report is at most ${MAX_CRASH_REPORT_BYTES} bytes.`);
	}
	const version = (versionHeader ?? "").trim().slice(0, MAX_VERSION);
	// By account, which isn't kept: one crashing install can't flood the service.
	if (env.CRASH_LIMITER) {
		const { success } = await env.CRASH_LIMITER.limit({ key: `account:${accountId}` });
		if (!success) {
			throw new HttpError(429, "rate_limited", "Too many crash reports; try again in a minute.");
		}
	}

	const report = redact(text);
	const { signature, title } = await signatureOf(game, report);
	const time = now();
	const known = await env.DB.prepare("SELECT 1 FROM crash_groups WHERE game = ? AND signature = ?").bind(game, signature).first();
	const today = await env.DB.prepare("SELECT COALESCE(SUM(LENGTH(CAST(report AS BLOB))), 0) AS stored FROM crash_reports WHERE game = ? AND created_at > ?")
		.bind(game, time - DAY)
		.first<{ stored: number }>();
	const full = (today?.stored ?? 0) + new TextEncoder().encode(report).length > (env.MAX_CRASH_REPORT_BYTES_PER_DAY ?? DEFAULT_MAX_CRASH_REPORT_BYTES_PER_DAY);
	if (full && !known) {
		return { received: true };
	}
	const statements = [
		env.DB.prepare(
			`INSERT INTO crash_groups (game, signature, title, count, first_version, last_version, first_seen_at, last_seen_at)
			 VALUES (?1, ?2, ?3, 1, ?4, ?4, ?5, ?5)
			 ON CONFLICT (game, signature) DO UPDATE SET count = count + 1, last_version = ?4, last_seen_at = ?5`,
		).bind(game, signature, title, version, time),
	];
	if (!full) {
		statements.push(
			env.DB.prepare("INSERT INTO crash_reports (id, game, signature, version, report, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), game, signature, version, report, time),
			env.DB.prepare(
				`DELETE FROM crash_reports WHERE game = ?1 AND signature = ?2 AND id NOT IN
				 (SELECT id FROM crash_reports WHERE game = ?1 AND signature = ?2 ORDER BY created_at DESC LIMIT ?3)`,
			).bind(game, signature, KEPT_PER_CRASH),
		);
	}
	await env.DB.batch(statements);
	return { received: true };
}
