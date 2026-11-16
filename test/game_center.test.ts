import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { isApplePublicKeyUrl, signedData, verifyGameCenter, type GameCenterProof } from "../src/providers/game_center";
import { base64url } from "../src/crypto";

x509.cryptoProvider.set(crypto);

async function signedProof(subject: string, overrides: Partial<GameCenterProof> = {}) {
	const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 };
	const keys = (await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"])) as CryptoKeyPair;
	const certificate = await x509.X509CertificateGenerator.createSelfSigned({
		serialNumber: "01",
		name: subject,
		notBefore: new Date(Date.now() - 86400000),
		notAfter: new Date(Date.now() + 86400000),
		keys,
		signingAlgorithm: algorithm,
	});
	const proof: GameCenterProof = {
		publicKeyUrl: "https://static.gc.apple.com/public-key/gc-prod-11.cer",
		signature: "",
		salt: btoa("salty"),
		timestamp: Date.now(),
		teamPlayerId: "T:_abc123",
		bundleId: "com.example.test",
		...overrides,
	};
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, signedData(proof));
	proof.signature = base64url(signature).replaceAll("-", "+").replaceAll("_", "/");
	return { proof, der: async () => certificate.rawData };
}

describe("Game Center", () => {
	it("accepts Apple's signature over the player, bundle, time and salt", async () => {
		const { proof, der } = await signedProof("CN=Game Center, O=Apple Inc.");
		expect(await verifyGameCenter(proof, ["com.example.test"], der)).toBe("T:_abc123");
	});

	it("refuses a signature for another player, a non-Apple certificate, another game or an old one", async () => {
		const { proof, der } = await signedProof("CN=Game Center, O=Apple Inc.");
		await expect(verifyGameCenter({ ...proof, teamPlayerId: "T:_someone_else" }, ["com.example.test"], der)).rejects.toThrow();
		const fake = await signedProof("CN=Game Center, O=Not Apple");
		await expect(verifyGameCenter(fake.proof, ["com.example.test"], fake.der)).rejects.toThrow();
		await expect(verifyGameCenter(proof, ["com.example.other"], der)).rejects.toThrow();
		const old = await signedProof("CN=Game Center, O=Apple Inc.", { timestamp: Date.now() - 3600_000 });
		await expect(verifyGameCenter(old.proof, ["com.example.test"], old.der)).rejects.toThrow();
	});

	it("only fetches Game Center's own certificates, over HTTPS", () => {
		expect(isApplePublicKeyUrl("https://static.gc.apple.com/public-key/gc-prod-11.cer")).toBe(true);
		expect(isApplePublicKeyUrl("https://static.gc.apple.com/public-key/gc-sb-2.cer")).toBe(true);
		expect(isApplePublicKeyUrl("http://static.gc.apple.com/public-key/gc-prod-11.cer")).toBe(false);
		expect(isApplePublicKeyUrl("https://static.gc.apple.com/key.cer")).toBe(false);
		expect(isApplePublicKeyUrl("https://www.apple.com/public-key/gc-prod-11.cer")).toBe(false);
		expect(isApplePublicKeyUrl("https://static.gc.apple.com/public-key/gc-prod-11.cer?x=1")).toBe(false);
		expect(isApplePublicKeyUrl("https://static.gc.apple.com:8443/public-key/gc-prod-11.cer")).toBe(false);
		expect(isApplePublicKeyUrl("https://user@static.gc.apple.com/public-key/gc-prod-11.cer")).toBe(false);
		expect(isApplePublicKeyUrl("https://apple.com.evil.example/key.cer")).toBe(false);
		expect(isApplePublicKeyUrl("https://evilapple.com/key.cer")).toBe(false);
	});
});
