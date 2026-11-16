// Proving an email address: a 6-digit code sent to it, valid for ten minutes and single use.
//
// - Each code has a purpose: "sign_in" (signing in, adding or changing an address) or "guest"
//   (a host device loading and saving a guest's games). A code only works for its own purpose,
//   so a code typed on someone else's device can never sign them in to the account.
// - Asking for a code returns a challenge, which the same device must send back with the code:
//   codes for the same address don't cancel each other, and guesses are counted per challenge.
// - Per address, a code goes out at most once a minute and MAX_CODES_PER_DAY times a day, and at
//   most MAX_TRIES_PER_DAY codes are tried a day (a million possible codes each), so nobody can
//   flood an inbox or keep guessing. Both limits are one atomic statement each.
// - Only HMACs are stored: of the address (its identity hash), of the challenge and of the code.

import type { Env } from "./env";
import { hmacHex, randomToken, timingSafeEqual } from "./crypto";
import { sendEmail } from "./email";
import { renderEmail } from "./email_templates";
import { HttpError } from "./http";
import { identityHash, requireGame } from "./identities";
import { DAY, now } from "./time";

export type CodePurpose = "sign_in" | "guest";

export const EMAIL_CODE_LIFETIME = 600;
const MAX_ATTEMPTS = 5;
const RESEND_AFTER = 60;
const MAX_CODES_PER_DAY = 8;
const MAX_TRIES_PER_DAY = MAX_CODES_PER_DAY * MAX_ATTEMPTS;
const MAX_EMAIL_LENGTH = 254;

// The address as stored (hashed): trimmed and lower-cased. Strict on purpose: one "@", a dot in
// the domain, no spaces, quotes, angle brackets or control characters, so nothing a driver puts
// in a header can be bent into another one.
export function normaliseEmail(input: unknown): string {
	const email = typeof input === "string" ? input.trim().toLowerCase() : "";
	const valid =
		email.length > 0 &&
		email.length <= MAX_EMAIL_LENGTH &&
		/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email) &&
		!email.startsWith(".") &&
		!email.includes("..");
	if (!valid) {
		throw new HttpError(400, "bad_email", "That doesn't look like an email address.");
	}
	return email;
}

function challengeHash(env: Env, challenge: string): Promise<string> {
	return hmacHex(env.SESSION_SECRET, `email-challenge:${challenge}`);
}

function codeHash(env: Env, challengeHashValue: string, code: string): Promise<string> {
	return hmacHex(env.SESSION_SECRET, `email-code:${challengeHashValue}:${code}`);
}

// Six uniformly random digits.
function randomDigits(): string {
	const limit = 4_294_000_000; // The largest multiple of 1,000,000 below 2^32.
	for (;;) {
		const [value] = crypto.getRandomValues(new Uint32Array(1));
		if (value < limit) {
			return String(value % 1_000_000).padStart(6, "0");
		}
	}
}

async function limit(limiter: RateLimit, key: string, message: string): Promise<void> {
	const { success } = await limiter.limit({ key });
	if (!success) {
		throw new HttpError(429, "rate_limited", message);
	}
}

// Who's asking, for limits per connection: the IPv4 address, or an IPv6 address's /64 (one
// connection usually has a whole /64 to pick addresses from).
export function connectionKey(request: Request): string {
	const address = request.headers.get("cf-connecting-ip") ?? "unknown";
	if (!address.includes(":")) {
		return address;
	}
	const [head, tail = ""] = address.toLowerCase().split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
	return groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

// Sends a code to the address and returns the challenge to verify it with. Answers the same
// whether or not the address has an account.
export async function startEmail(
	env: Env,
	request: Request,
	emailInput: unknown,
	gameId: string,
	purpose: CodePurpose,
): Promise<{ sent: true; challenge: string; expires_at: number }> {
	const game = requireGame(env, gameId);
	const email = normaliseEmail(emailInput);
	if (env.EMAIL_DRIVER === "log" && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) {
		throw new HttpError(501, "not_configured", 'The "log" email driver is for local development only.');
	}
	await limit(env.EMAIL_LIMITER, `connection:${connectionKey(request)}`, "Too many codes from here; try again in a minute.");
	const emailHash = await identityHash(env.IDENTITY_SECRET, "email", email);
	const time = now();

	// The address's limits, checked and counted in one statement, so requests at the same moment
	// can't all slip through.
	const counted = await env.DB.prepare(
		`INSERT INTO email_limits (email_hash, day_started_at, last_sent_at, codes_today, tries_today) VALUES (?1, ?2, ?2, 1, 0)
		 ON CONFLICT (email_hash) DO UPDATE SET
		   codes_today = CASE WHEN day_started_at <= ?2 - ?4 THEN 1 ELSE codes_today + 1 END,
		   tries_today = CASE WHEN day_started_at <= ?2 - ?4 THEN 0 ELSE tries_today END,
		   day_started_at = CASE WHEN day_started_at <= ?2 - ?4 THEN ?2 ELSE day_started_at END,
		   last_sent_at = ?2
		 WHERE last_sent_at <= ?2 - ?5 AND (day_started_at <= ?2 - ?4 OR codes_today < ?3)
		 RETURNING codes_today`,
	)
		.bind(emailHash, time, MAX_CODES_PER_DAY, DAY, RESEND_AFTER)
		.first();
	if (!counted) {
		throw new HttpError(429, "rate_limited", "That address was just sent a code, or has had too many today; try again later.");
	}

	const code = randomDigits();
	const challenge = randomToken(24);
	const challengeHashValue = await challengeHash(env, challenge);
	const expires_at = time + EMAIL_CODE_LIFETIME;
	await env.DB.prepare("INSERT INTO email_codes (challenge_hash, email_hash, purpose, code_hash, attempts, expires_at) VALUES (?, ?, ?, ?, 0, ?)")
		.bind(challengeHashValue, emailHash, purpose, await codeHash(env, challengeHashValue, code), expires_at)
		.run();
	try {
		const values = { code, game: game.name || gameId, minutes: String(EMAIL_CODE_LIFETIME / 60) };
		await sendEmail(env, { to: email, ...(await renderEmail(purpose, gameId, values)) });
	} catch (error) {
		// Not sent: the code can't be used, and it doesn't count against the address.
		await env.DB.batch([
			env.DB.prepare("DELETE FROM email_codes WHERE challenge_hash = ?").bind(challengeHashValue),
			env.DB.prepare("UPDATE email_limits SET codes_today = codes_today - 1, last_sent_at = 0 WHERE email_hash = ?").bind(emailHash),
		]);
		throw error;
	}
	return { sent: true, challenge, expires_at };
}

// Checks a code for its purpose and uses it up: the address, normalised, if it's right.
export async function verifyEmailCode(
	env: Env,
	request: Request,
	emailInput: unknown,
	challengeInput: unknown,
	codeInput: unknown,
	purpose: CodePurpose,
): Promise<string> {
	await limit(env.VERIFY_LIMITER, `connection:${connectionKey(request)}`, "Too many tries from here; try again in a minute.");
	const email = normaliseEmail(emailInput);
	const challenge = typeof challengeInput === "string" ? challengeInput : "";
	const code = typeof codeInput === "string" ? codeInput.replace(/\s/g, "") : "";
	const wrong = new HttpError(400, "wrong_code", "That code is wrong or has expired. Ask for a new one if it keeps failing.");
	if (!/^\d{6}$/.test(code) || challenge.length === 0 || challenge.length > 64) {
		throw wrong;
	}
	const emailHash = await identityHash(env.IDENTITY_SECRET, "email", email);
	const challengeHashValue = await challengeHash(env, challenge);
	const time = now();

	// Every try counts against the address's day and the code's attempts before the code is
	// compared, each in one statement, so tries sent all at once can't get past either limit.
	const allowed = await env.DB.prepare(
		`UPDATE email_limits SET
		   tries_today = CASE WHEN day_started_at <= ?2 - ?4 THEN 1 ELSE tries_today + 1 END,
		   codes_today = CASE WHEN day_started_at <= ?2 - ?4 THEN 0 ELSE codes_today END,
		   day_started_at = CASE WHEN day_started_at <= ?2 - ?4 THEN ?2 ELSE day_started_at END
		 WHERE email_hash = ?1 AND (day_started_at <= ?2 - ?4 OR tries_today < ?3) RETURNING tries_today`,
	)
		.bind(emailHash, time, MAX_TRIES_PER_DAY, DAY)
		.first();
	if (!allowed) {
		throw wrong;
	}
	const row = await env.DB.prepare(
		`UPDATE email_codes SET attempts = attempts + 1
		 WHERE challenge_hash = ? AND email_hash = ? AND purpose = ? AND expires_at > ? AND attempts < ? RETURNING code_hash`,
	)
		.bind(challengeHashValue, emailHash, purpose, time, MAX_ATTEMPTS)
		.first<{ code_hash: string }>();
	if (!row || !timingSafeEqual(row.code_hash, await codeHash(env, challengeHashValue, code))) {
		throw wrong;
	}
	// Single use: only the request that deletes the row gets through.
	const used = await env.DB.prepare("DELETE FROM email_codes WHERE challenge_hash = ? AND code_hash = ?").bind(challengeHashValue, row.code_hash).run();
	if (used.meta.changes !== 1) {
		throw wrong;
	}
	return email;
}
