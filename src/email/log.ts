// For local development only: writes the email to the console instead of sending it, so a code
// can be read from `wrangler dev`'s output. Never use it on a deployed service.

import type { Env } from "../env";
import type { Email } from "./index";

export async function sendWithLog(_env: Env, email: Email): Promise<void> {
	console.log(`[email] to ${email.to}: ${email.subject}\n${email.text}`);
}
