// Google Play: the client sends a Play Integrity token (a standard request whose requestHash is
// the service's challenge). Google decodes it for the game's service account
// (PLAY_INTEGRITY_SERVICE_ACCOUNT, the JSON key of a service account in the Google Cloud project
// linked to the game in the Play Console). appLicensingVerdict LICENSED means the player got the
// game from Google Play; Google refuses to decode a token twice, so a captured one can't be
// replayed, and the challenge ties it to one request.

import { base64url, fromBase64url } from "../crypto";
import { HttpError } from "../http";

export type Licensing = "LICENSED" | "UNLICENSED" | "UNEVALUATED";

export interface IntegrityVerdict {
	requestHash: string;
	packageName: string;
	timestampMillis: number;
	licensing: Licensing;
}

interface ServiceAccount {
	client_email: string;
	private_key: string;
}

function unavailable(message: string): HttpError {
	return new HttpError(502, "provider_unavailable", message);
}

function serviceAccount(json: string | undefined): ServiceAccount {
	let account: Partial<ServiceAccount> = {};
	try {
		account = json ? JSON.parse(json) : {};
	} catch {
		// Falls through to the error below.
	}
	if (!account.client_email || !account.private_key) {
		throw new HttpError(501, "not_configured", "Play Integrity isn't set up (PLAY_INTEGRITY_SERVICE_ACCOUNT).");
	}
	return account as ServiceAccount;
}

// The last access token, kept while it lasts (an isolate serves many requests), so each check is
// one call to Google rather than two.
let cached: { email: string; token: string; until: number } | null = null;

// An access token for the service account, from a JWT it signs (Google's server-to-server OAuth).
async function accessToken(account: ServiceAccount): Promise<string> {
	if (cached && cached.email === account.client_email && cached.until > Date.now()) {
		return cached.token;
	}
	const pem = account.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
	const key = await crypto.subtle.importKey(
		"pkcs8",
		fromBase64url(pem.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const time = Math.floor(Date.now() / 1000);
	const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
	const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
		iss: account.client_email,
		scope: "https://www.googleapis.com/auth/playintegrity",
		aud: "https://oauth2.googleapis.com/token",
		iat: time,
		exp: time + 600,
	})}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${base64url(signature)}` }),
	});
	if (!response.ok) {
		throw unavailable(`Google's token server answered ${response.status}.`);
	}
	const body = (await response.json()) as { access_token?: string; expires_in?: number };
	if (!body.access_token) {
		throw unavailable("Google's token server gave no access token.");
	}
	cached = { email: account.client_email, token: body.access_token, until: Date.now() + Math.max(0, (body.expires_in ?? 3600) - 120) * 1000 };
	return body.access_token;
}

export async function decodeIntegrityToken(serviceAccountJson: string | undefined, packageName: string, token: string): Promise<IntegrityVerdict> {
	if (!/^[A-Za-z0-9._-]{16,8192}$/.test(token)) {
		throw new HttpError(401, "invalid_proof", "The Play Integrity token isn't one.");
	}
	const account = serviceAccount(serviceAccountJson);
	const response = await fetch(`https://playintegrity.googleapis.com/v1/${encodeURIComponent(packageName)}:decodeIntegrityToken`, {
		method: "POST",
		headers: { authorization: `Bearer ${await accessToken(account)}`, "content-type": "application/json" },
		body: JSON.stringify({ integrity_token: token }),
	});
	if (response.status === 400) {
		throw new HttpError(401, "invalid_proof", "Google couldn't decode the Play Integrity token.");
	}
	// A key rotated or revoked since: the next check gets a new token.
	if (response.status === 401 || response.status === 403) {
		cached = null;
	}
	if (!response.ok) {
		throw unavailable(`Play Integrity answered ${response.status}.`);
	}
	const body = (await response.json()) as {
		tokenPayloadExternal?: {
			requestDetails?: { requestHash?: string; requestPackageName?: string; timestampMillis?: string };
			accountDetails?: { appLicensingVerdict?: Licensing };
		};
	};
	const payload = body.tokenPayloadExternal;
	return {
		requestHash: payload?.requestDetails?.requestHash ?? "",
		packageName: payload?.requestDetails?.requestPackageName ?? "",
		timestampMillis: Number(payload?.requestDetails?.timestampMillis ?? 0),
		licensing: payload?.accountDetails?.appLicensingVerdict ?? "UNEVALUATED",
	};
}
