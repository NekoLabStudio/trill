// The App Store: the client sends StoreKit's AppTransaction, a JWS Apple signs to say this Apple
// account got the app from the App Store (or TestFlight: "Sandbox"). It's checked as Apple's own
// server library checks it: three certificates in the header, the second signed by Apple Root CA
// G3 (built in here, never taken from the request), the first by the second, each in date, with
// Apple's marks for App Store receipts (leaf 1.2.840.113635.100.6.11.1) and its intermediate
// (1.2.840.113635.100.6.2.1), then the JWS's ES256 signature with the first's key.

import { AsnConvert } from "@peculiar/asn1-schema";
import { BasicConstraints, Certificate, id_ce_basicConstraints } from "@peculiar/asn1-x509";
import { fromBase64url } from "../crypto";
import { HttpError } from "../http";

// https://www.apple.com/certificateauthority/AppleRootCA-G3.cer (SHA-256 63:34:3A:BF:...:3E:91:79).
export const APPLE_ROOT_CA_G3 =
	"MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==";

const LEAF_MARK = "1.2.840.113635.100.6.11.1";
const INTERMEDIATE_MARK = "1.2.840.113635.100.6.2.1";
// Clocks a little apart don't fail a certificate on its first or last day.
const MAX_SKEW_MS = 60_000;

// The curves' OIDs as DER, as they sit in a key's parameters.
const CURVES: Record<string, { name: string; size: number }> = {
	"06082a8648ce3d030107": { name: "P-256", size: 32 }, // 1.2.840.10045.3.1.7
	"06052b81040022": { name: "P-384", size: 48 }, // 1.3.132.0.34
};
const HASHES: Record<string, string> = {
	"1.2.840.10045.4.3.2": "SHA-256",
	"1.2.840.10045.4.3.3": "SHA-384",
};

export interface AppTransaction {
	bundleId: string;
	receiptType: string; // "Production", "Sandbox" (TestFlight), "Xcode" or "LocalTesting"
	appTransactionId?: string; // The same for one Apple account's download of the app everywhere.
	originalPurchaseDate?: number;
}

function invalid(message: string): HttpError {
	return new HttpError(401, "invalid_proof", message);
}

function base64(text: string): Uint8Array {
	return fromBase64url(text.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""));
}

// The bytes of a DER element's first child (a certificate's tbsCertificate, as signed).
function firstChild(der: Uint8Array): Uint8Array {
	const lengthAt = (offset: number): [number, number] => {
		const first = der[offset];
		if (first < 0x80) {
			return [first, 1];
		}
		const count = first & 0x7f;
		let length = 0;
		for (let i = 1; i <= count; i++) {
			length = length * 256 + der[offset + i];
		}
		return [length, 1 + count];
	};
	const [, outerHeader] = lengthAt(1);
	const start = 1 + outerHeader;
	const [length, header] = lengthAt(start + 1);
	return der.subarray(start, start + 1 + header + length);
}

// An ECDSA signature as DER (SEQUENCE of two INTEGERs) to the r and s WebCrypto takes.
function rawSignature(der: Uint8Array, size: number): Uint8Array {
	const raw = new Uint8Array(size * 2);
	let offset = 2;
	if (der[1] & 0x80) {
		offset += der[1] & 0x7f;
	}
	for (let part = 0; part < 2; part++) {
		if (der[offset] !== 0x02) {
			throw invalid("A certificate's signature isn't ECDSA.");
		}
		let length = der[offset + 1];
		let value = der.subarray(offset + 2, offset + 2 + length);
		offset += 2 + length;
		while (value.length > size && value[0] === 0) {
			value = value.subarray(1);
		}
		if (value.length > size) {
			throw invalid("A certificate's signature is malformed.");
		}
		raw.set(value, part * size + size - value.length);
	}
	return raw;
}

async function publicKey(certificate: Certificate): Promise<{ key: CryptoKey; size: number }> {
	const info = certificate.tbsCertificate.subjectPublicKeyInfo;
	const parameters = info.algorithm.parameters ? [...new Uint8Array(info.algorithm.parameters)].map((byte) => byte.toString(16).padStart(2, "0")).join("") : "";
	const curve = Object.hasOwn(CURVES, parameters) ? CURVES[parameters] : undefined;
	if (info.algorithm.algorithm !== "1.2.840.10045.2.1" || !curve) {
		throw invalid("A certificate's key isn't on a curve Apple uses.");
	}
	const key = await crypto.subtle.importKey("spki", AsnConvert.serialize(info), { name: "ECDSA", namedCurve: curve.name }, false, ["verify"]);
	return { key, size: curve.size };
}

async function signedBy(der: Uint8Array, certificate: Certificate, issuer: Certificate): Promise<boolean> {
	const hash = Object.hasOwn(HASHES, certificate.signatureAlgorithm.algorithm) ? HASHES[certificate.signatureAlgorithm.algorithm] : undefined;
	if (!hash) {
		return false;
	}
	const { key, size } = await publicKey(issuer);
	const signature = rawSignature(new Uint8Array(certificate.signatureValue), size);
	return crypto.subtle.verify({ name: "ECDSA", hash }, key, signature, firstChild(der));
}

function sameName(a: Certificate["tbsCertificate"]["subject"], b: Certificate["tbsCertificate"]["issuer"]): boolean {
	const first = new Uint8Array(AsnConvert.serialize(a));
	const second = new Uint8Array(AsnConvert.serialize(b));
	return first.length === second.length && first.every((byte, i) => byte === second[i]);
}

function hasExtension(certificate: Certificate, id: string): boolean {
	return (certificate.tbsCertificate.extensions ?? []).some((extension) => extension.extnID === id);
}

function isAuthority(certificate: Certificate): boolean {
	const extension = (certificate.tbsCertificate.extensions ?? []).find((each) => each.extnID === id_ce_basicConstraints);
	return extension !== undefined && AsnConvert.parse(extension.extnValue, BasicConstraints).cA;
}

function inDate(certificate: Certificate, time: number): boolean {
	const validity = certificate.tbsCertificate.validity;
	return validity.notBefore.getTime().getTime() <= time + MAX_SKEW_MS && validity.notAfter.getTime().getTime() >= time - MAX_SKEW_MS;
}

// The AppTransaction's contents once its signature checks out, or a 401 (invalid_proof).
export async function verifyAppTransaction(jws: string, root = APPLE_ROOT_CA_G3): Promise<AppTransaction> {
	const parts = jws.split(".");
	if (parts.length !== 3 || jws.length > 16384) {
		throw invalid("The AppTransaction isn't a JWS.");
	}
	let header: { alg?: string; x5c?: string[] };
	let payload: AppTransaction;
	try {
		header = JSON.parse(new TextDecoder().decode(fromBase64url(parts[0])));
		payload = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])));
	} catch {
		throw invalid("The AppTransaction isn't a JWS.");
	}
	if (header === null || typeof header !== "object" || payload === null || typeof payload !== "object") {
		throw invalid("The AppTransaction isn't a JWS.");
	}
	if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length !== 3) {
		throw invalid("The AppTransaction isn't signed the way the App Store signs.");
	}
	let leafDer: Uint8Array;
	let intermediateDer: Uint8Array;
	let leaf: Certificate;
	let intermediate: Certificate;
	let rootCertificate: Certificate;
	try {
		leafDer = base64(header.x5c[0]);
		intermediateDer = base64(header.x5c[1]);
		leaf = AsnConvert.parse(leafDer, Certificate);
		intermediate = AsnConvert.parse(intermediateDer, Certificate);
		rootCertificate = AsnConvert.parse(base64(root), Certificate);
	} catch {
		throw invalid("The AppTransaction's certificates can't be read.");
	}
	const time = Date.now();
	const chained =
		sameName(rootCertificate.tbsCertificate.subject, intermediate.tbsCertificate.issuer) &&
		(await signedBy(intermediateDer, intermediate, rootCertificate)) &&
		sameName(intermediate.tbsCertificate.subject, leaf.tbsCertificate.issuer) &&
		(await signedBy(leafDer, leaf, intermediate)) &&
		isAuthority(intermediate) &&
		hasExtension(leaf, LEAF_MARK) &&
		hasExtension(intermediate, INTERMEDIATE_MARK) &&
		inDate(leaf, time) &&
		inDate(intermediate, time) &&
		inDate(rootCertificate, time);
	if (!chained) {
		throw invalid("The AppTransaction isn't signed by the App Store.");
	}
	const { key } = await publicKey(leaf);
	const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
	if (!valid || typeof payload.bundleId !== "string" || typeof payload.receiptType !== "string") {
		throw invalid("The AppTransaction's signature doesn't match.");
	}
	return payload;
}
