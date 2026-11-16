import { env } from "cloudflare:workers";
import { vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

export const testEnv = env as unknown as Env;

// Each request comes from its own connection unless the test names one, so limits per connection
// only show up in the tests about them.
export async function call(method: string, path: string, options: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: BodyInit } = {}) {
	const headers = new Headers(options.headers);
	if (!headers.has("cf-connecting-ip")) {
		headers.set("cf-connecting-ip", `198.51.100.${Math.floor(Math.random() * 250)}-${crypto.randomUUID()}`);
	}
	if (options.token) {
		headers.set("authorization", `Bearer ${options.token}`);
	}
	let body: BodyInit | undefined = options.raw;
	if (options.body !== undefined) {
		headers.set("content-type", "application/json");
		body = JSON.stringify(options.body);
	}
	if (typeof body === "string" && !headers.has("content-length")) {
		headers.set("content-length", String(new TextEncoder().encode(body).length));
	}
	return worker.fetch(new Request(`http://localhost${path}`, { method, headers, body }), testEnv);
}

export async function callJson(method: string, path: string, options: Parameters<typeof call>[2] = {}) {
	const response = await call(method, path, options);
	return { status: response.status, body: (await response.json()) as any };
}

// A new device account: its session token and account ID.
export async function deviceAccount(name = "Player") {
	const secret = crypto.randomUUID() + crypto.randomUUID();
	const { body } = await callJson("POST", "/auth/device", { body: { game: "test", secret, display_name: name } });
	return { token: body.token as string, id: body.account_id as string, secret };
}

export async function save(token: string, slot: string, data: string, replaces: number, summary: unknown = { level: 1 }) {
	return callJson("PUT", `/saves/test/${slot}`, {
		token,
		raw: data,
		headers: { "x-save-version": String(replaces), "x-save-summary": JSON.stringify(summary) },
	});
}

// A save's bytes as text (saves are served as binary).
export async function text(response: Response): Promise<string> {
	return new TextDecoder().decode(await response.arrayBuffer());
}

// A new address nobody has used yet.
export function newEmail(name = "player"): string {
	return `${name}.${crypto.randomUUID().slice(0, 8)}@example.com`;
}

// Asks for a code for the address (to sign in, or, with a host's token, for a guest) and returns
// it with its challenge, reading the code from the "log" email driver's output.
export async function emailCode(email: string, options: { headers?: Record<string, string>; hostToken?: string } = {}): Promise<{ code: string; challenge: string }> {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		// As if the last code was asked for a couple of minutes ago, past the one-a-minute limit.
		await testEnv.DB.prepare("UPDATE email_limits SET last_sent_at = last_sent_at - 120").run();
		const path = options.hostToken ? "/guest/email/start" : "/auth/email/start";
		const started = await callJson("POST", path, { token: options.hostToken, body: { email, game: "test" }, headers: options.headers });
		if (started.status !== 200) {
			throw new Error(`No code: ${JSON.stringify(started.body)}`);
		}
		const sent = log.mock.calls.map((args) => String(args[0])).find((line) => line.startsWith(`[email] to ${email.toLowerCase().trim()}:`));
		return { code: /code (?:for [^\n]+ )?is (\d{6})\./.exec(sent ?? "")![1], challenge: started.body.challenge };
	} finally {
		log.mockRestore();
	}
}

// Signs in with an address (proving it with a code), or adds it to the account the token is for.
export async function verifyEmail(email: string, token?: string, extra: Record<string, unknown> = {}) {
	const { code, challenge } = await emailCode(email);
	return callJson("POST", "/auth/email/verify", { token, body: { email, code, challenge, ...extra } });
}

// A new account with an email address, which is what keeps saves on the service.
export async function emailAccount(name = "Player") {
	const email = newEmail(name.toLowerCase().replace(/[^a-z]/g, ""));
	const { body } = await verifyEmail(email, undefined, { display_name: name });
	return { token: body.token as string, id: body.account_id as string, email };
}
