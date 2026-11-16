// Cloudflare's Email Sending, through the Worker's EMAIL binding (send_email in wrangler.jsonc).
// Needs the Workers Paid plan and the sender's domain onboarded in Email Sending.

import type { Env } from "../env";
import { parseSender, type Email } from "./index";

export async function sendWithCloudflare(env: Env, email: Email): Promise<void> {
	if (!env.EMAIL) {
		throw new Error("The EMAIL binding is missing.");
	}
	await env.EMAIL.send({ from: parseSender(env.EMAIL_FROM), to: email.to, subject: email.subject, text: email.text, html: email.html });
}
