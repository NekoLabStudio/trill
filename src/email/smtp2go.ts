// SMTP2GO, through its HTTP API. The API key is the SMTP2GO_API_KEY secret; the sender must be
// verified in the SMTP2GO account. SMTP2GO_API_URL can pick a region (https://eu-api.smtp2go.com/v3).

import type { Env } from "../env";
import type { Email } from "./index";

export async function sendWithSmtp2go(env: Env, email: Email): Promise<void> {
	if (!env.SMTP2GO_API_KEY) {
		throw new Error("SMTP2GO_API_KEY isn't set.");
	}
	const response = await fetch(`${env.SMTP2GO_API_URL || "https://api.smtp2go.com/v3"}/email/send`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json", "x-smtp2go-api-key": env.SMTP2GO_API_KEY },
		body: JSON.stringify({ sender: env.EMAIL_FROM, to: [email.to], subject: email.subject, text_body: email.text, html_body: email.html }),
	});
	// SMTP2GO can answer 200 and still report the email as failed.
	const body = (await response.json().catch(() => null)) as { data?: { succeeded?: number; failed?: number; error?: string } } | null;
	if (!response.ok || !body?.data || body.data.error || body.data.failed || body.data.succeeded !== 1) {
		throw new Error(`SMTP2GO answered ${response.status}.`);
	}
}
