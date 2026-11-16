// Hashing, signing and random values, all with Web Crypto.

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
	const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	for (const byte of array) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
	const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4);
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function hmacHex(secret: string, message: string): Promise<string> {
	return hex(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message)));
}

export async function hmacBase64url(secret: string, message: string): Promise<string> {
	return base64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message)));
}

export async function sha256Hex(message: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", encoder.encode(message)));
}

export function randomToken(bytes = 32): string {
	return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

// Codes people type: no 0/O, 1/I/L or U, so they're hard to misread.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export function randomCode(length = 6): string {
	// Bytes past the largest multiple of the alphabet's size are skipped, so every character is
	// equally likely.
	const limit = 256 - (256 % CODE_ALPHABET.length);
	let code = "";
	while (code.length < length) {
		for (const value of crypto.getRandomValues(new Uint8Array(length))) {
			if (value < limit && code.length < length) {
				code += CODE_ALPHABET[value % CODE_ALPHABET.length];
			}
		}
	}
	return code;
}

export function normaliseCode(code: string): string {
	return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let difference = 0;
	for (let i = 0; i < a.length; i++) {
		difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return difference === 0;
}
