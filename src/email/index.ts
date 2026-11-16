// Sending email, through the driver the EMAIL_DRIVER setting names. Each driver is one file in
// this folder with one function; to support another provider, add a file and list it below.
// The service sends players their sign-in codes, and never keeps or logs their address; and,
// with MODERATION_EMAIL set, the operator a daily list of reported players.

import type { Env } from "../env";
import { HttpError } from "../http";
import { sendWithCloudflare } from "./cloudflare";
import { sendWithLog } from "./log";
import { sendWithSmtp2go } from "./smtp2go";

export interface Email {
	to: string;
	subject: string;
	text: string;
	html: string;
}

export type EmailDriver = (env: Env, email: Email) => Promise<void>;

const drivers: Record<string, EmailDriver> = {
	cloudflare: sendWithCloudflare,
	smtp2go: sendWithSmtp2go,
	log: sendWithLog,
};

export async function sendEmail(env: Env, email: Email): Promise<void> {
	const driver = drivers[env.EMAIL_DRIVER];
	if (!driver) {
		throw new HttpError(501, "not_configured", `There's no email driver called "${env.EMAIL_DRIVER}" (EMAIL_DRIVER).`);
	}
	try {
		await driver(env, email);
	} catch (error) {
		// The provider's own message could include the address, so only its kind is kept.
		console.error("Sending an email failed", error instanceof Error ? error.name : "unknown");
		throw new HttpError(502, "email_failed", "The email couldn't be sent; try again in a moment.");
	}
}

// "Name <address>" or a bare address, as EMAIL_FROM holds it.
export function parseSender(sender: string): { name: string; email: string } {
	const match = /^\s*(.*?)\s*<([^<>\s]+)>\s*$/.exec(sender);
	return match ? { name: match[1], email: match[2] } : { name: "", email: sender.trim() };
}
