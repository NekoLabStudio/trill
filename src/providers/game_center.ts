// Game Center: the client sends what fetchItems(forIdentityVerificationSignature:) returned.
// Apple signs teamPlayerID + bundleID + timestamp (big-endian UInt64) + salt with the key in the
// certificate at publicKeyURL. What makes the certificate Apple's is where it comes from: only
// Game Center's own certificate addresses are accepted (static.gc.apple.com/public-key/...),
// fetched over HTTPS without following redirects, so nobody else can serve one. It must also be
// issued to Apple Inc. and be in date. teamPlayerID is the same in all of one developer team's
// games.

import { AsnConvert } from "@peculiar/asn1-schema";
import { Certificate } from "@peculiar/asn1-x509";
import { fromBase64url } from "../crypto";
import { HttpError } from "../http";

// Signatures older than this are refused, so a captured one can't be replayed later.
const MAX_AGE_SECONDS = 15 * 60;
// The X.500 attribute for an organisation's name (O=).
const ORGANISATION = "2.5.4.10";

export interface GameCenterProof {
	publicKeyUrl: string;
	signature: string; // base64
	salt: string; // base64
	timestamp: number; // milliseconds since 1970, as Game Center gives it
	teamPlayerId: string;
	bundleId: string;
}

function base64(text: string): Uint8Array {
	return fromBase64url(text.replaceAll("+", "-").replaceAll("/", "_"));
}

export function signedData(proof: GameCenterProof): Uint8Array {
	const encoder = new TextEncoder();
	const player = encoder.encode(proof.teamPlayerId);
	const bundle = encoder.encode(proof.bundleId);
	const salt = base64(proof.salt);
	const data = new Uint8Array(player.length + bundle.length + 8 + salt.length);
	data.set(player, 0);
	data.set(bundle, player.length);
	new DataView(data.buffer).setBigUint64(player.length + bundle.length, BigInt(proof.timestamp), false);
	data.set(salt, player.length + bundle.length + 8);
	return data;
}

// Game Center's certificates: https://static.gc.apple.com/public-key/gc-prod-<n>.cer (and the
// sandbox's gc-sb-<n>.cer), nothing else: no other host, port, query or fragment.
export function isApplePublicKeyUrl(publicKeyUrl: string): boolean {
	try {
		const url = new URL(publicKeyUrl);
		return (
			url.protocol === "https:" &&
			url.hostname === "static.gc.apple.com" &&
			url.port === "" &&
			url.username === "" &&
			url.search === "" &&
			url.hash === "" &&
			/^\/public-key\/gc-(prod|sb)-\d{1,4}\.cer$/.test(url.pathname)
		);
	} catch {
		return false;
	}
}

export async function verifyGameCenter(proof: GameCenterProof, allowedBundleIds: string[], fetchCertificate = fetchDer): Promise<string> {
	if (!allowedBundleIds.includes(proof.bundleId)) {
		throw new HttpError(401, "invalid_signature", "The bundle ID isn't one of this game's.");
	}
	if (Math.abs(Date.now() - proof.timestamp) > MAX_AGE_SECONDS * 1000) {
		throw new HttpError(401, "invalid_signature", "The signature is too old; ask Game Center for a new one.");
	}
	if (!isApplePublicKeyUrl(proof.publicKeyUrl)) {
		throw new HttpError(401, "invalid_signature", "The public key must be one of Game Center's, from static.gc.apple.com.");
	}
	const certificate = AsnConvert.parse(await fetchCertificate(proof.publicKeyUrl), Certificate).tbsCertificate;
	const organisations = certificate.subject.flatMap((names) => names.filter((name) => name.type === ORGANISATION).map((name) => name.value.toString()));
	const time = new Date();
	if (!organisations.includes("Apple Inc.") || certificate.validity.notBefore.getTime() > time || certificate.validity.notAfter.getTime() < time) {
		throw new HttpError(401, "invalid_signature", "The certificate isn't a current Apple one.");
	}
	const key = await crypto.subtle.importKey(
		"spki",
		AsnConvert.serialize(certificate.subjectPublicKeyInfo),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
	const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64(proof.signature), signedData(proof));
	if (!valid) {
		throw new HttpError(401, "invalid_signature", "Game Center's signature doesn't match.");
	}
	return proof.teamPlayerId;
}

async function fetchDer(url: string): Promise<ArrayBuffer> {
	// A redirect could lead anywhere, so it's refused.
	const response = await fetch(url, { redirect: "manual", cf: { cacheTtl: 86400 } });
	if (!response.ok) {
		throw new HttpError(502, "provider_unavailable", `Apple's certificate server answered ${response.status}.`);
	}
	return response.arrayBuffer();
}
