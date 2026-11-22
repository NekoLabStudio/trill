import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { call, callJson, deviceAccount, testEnv } from "./helpers";
import { verifyAppTransaction } from "../src/providers/app_store";
import { now, DAY } from "../src/time";

const STEAM_ID = "76561198000000101";
let nextSteamId = 76561198000000200n;

// Steam's two calls: the ticket names a new Steam ID each time (unless given one);
// CheckAppOwnership says whether it owns the app (by app ID).
function steam(owns: Record<string, boolean>, steamId = String(nextSteamId++)) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		if (url.pathname.includes("AuthenticateUserTicket")) {
			return Response.json({ response: { params: { result: "OK", steamid: steamId, ownersteamid: steamId } } });
		}
		if (url.pathname.includes("CheckAppOwnership")) {
			return Response.json({ appownership: { ownsapp: owns[url.searchParams.get("appid") ?? ""] ?? false } });
		}
		return new Response("unexpected", { status: 500 });
	});
}

async function ownershipRow(accountId: string, game: string) {
	return testEnv.DB.prepare("SELECT source, checked_at FROM ownership WHERE account_id = ? AND game = ?").bind(accountId, game).first<{ source: string; checked_at: number }>();
}

describe("ownership", () => {
	it("leaves games that don't check alone", async () => {
		const fetchSpy = steam({});
		const signedIn = await callJson("POST", "/auth/steam", { body: { game: "test", ticket: "ab".repeat(20) } });
		expect(signedIn.status).toBe(200);
		expect(fetchSpy.mock.calls.some(([input]) => String(input).includes("CheckAppOwnership"))).toBe(false);
		fetchSpy.mockRestore();
	});

	it("lets in a Steam player who owns the game, and records only that", async () => {
		const fetchSpy = steam({ "480": true }, STEAM_ID);
		const signedIn = await callJson("POST", "/auth/steam", { body: { game: "checked", ticket: "ab".repeat(20) } });
		fetchSpy.mockRestore();
		expect(signedIn.status).toBe(200);
		expect((await ownershipRow(signedIn.body.account_id, "checked"))?.source).toBe("steam");
		const rows = await testEnv.DB.prepare("SELECT * FROM ownership").all();
		expect(JSON.stringify(rows.results)).not.toContain(STEAM_ID);
	});

	it("turns away a Steam player who doesn't own it, even where the game is sold elsewhere too", async () => {
		const fetchSpy = steam({});
		const refused = await callJson("POST", "/auth/steam", { body: { game: "checked", ticket: "cd".repeat(20) } });
		fetchSpy.mockRestore();
		expect(refused.status).toBe(403);
		expect(refused.body.error).toBe("not_owned");
	});

	it("counts a Playtest's app ID as owning the game", async () => {
		const fetchSpy = steam({ "481": true });
		const signedIn = await callJson("POST", "/auth/steam", { body: { game: "required", ticket: "ef".repeat(20) } });
		fetchSpy.mockRestore();
		expect(signedIn.status).toBe(200);
	});

	it("lets a device account in without proof only where the game is sold elsewhere too", async () => {
		const secret = crypto.randomUUID() + crypto.randomUUID();
		expect((await call("POST", "/auth/device", { body: { game: "checked", secret } })).status).toBe(200);
		const accounts = () => testEnv.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first<number>("n");
		const before = await accounts();
		const refused = await callJson("POST", "/auth/device", { body: { game: "required", secret: crypto.randomUUID() + crypto.randomUUID() } });
		expect(refused.status).toBe(403);
		expect(refused.body.error).toBe("not_owned");
		// Turned away before an account was made for it.
		expect(await accounts()).toBe(before);
	});

	it("takes a Steam ticket as proof for an account of another kind", async () => {
		const secret = crypto.randomUUID() + crypto.randomUUID();
		const fetchSpy = steam({ "480": true });
		const signedIn = await callJson("POST", "/auth/device", { body: { game: "required", secret, ownership: { steam_ticket: "ab".repeat(20) } } });
		fetchSpy.mockRestore();
		expect(signedIn.status).toBe(200);
		expect((await ownershipRow(signedIn.body.account_id, "required"))?.source).toBe("steam");

		// Proven within the day: the next sign-in doesn't ask Steam again.
		const again = steam({});
		expect((await call("POST", "/auth/device", { body: { game: "required", secret } })).status).toBe(200);
		expect(again).not.toHaveBeenCalled();
		again.mockRestore();
	});

	it("treats a forged proof as none", async () => {
		const forged = { app_transaction: "eyJhbGciOiJFUzI1NiJ9.eyJidW5kbGVJZCI6ImNvbS5leGFtcGxlLnJlcXVpcmVkIn0.c2ln" };
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await call("POST", "/auth/device", { body: { game: "checked", secret: crypto.randomUUID() + crypto.randomUUID(), ownership: forged } })).status).toBe(200);
		expect((await call("POST", "/auth/device", { body: { game: "required", secret: crypto.randomUUID() + crypto.randomUUID(), ownership: forged } })).status).toBe(403);
		error.mockRestore();
	});

	it("keeps a recent proof when the store can't be asked, then stops", async () => {
		const secret = crypto.randomUUID() + crypto.randomUUID();
		const owned = steam({ "480": true });
		const first = await callJson("POST", "/auth/device", { body: { game: "required", secret, ownership: { steam_ticket: "ab".repeat(20) } } });
		owned.mockRestore();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const down = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));
		await testEnv.DB.prepare("UPDATE ownership SET checked_at = ? WHERE account_id = ?").bind(now() - 2 * DAY, first.body.account_id).run();
		expect((await call("POST", "/auth/device", { body: { game: "required", secret, ownership: { steam_ticket: "ab".repeat(20) } } })).status).toBe(200);
		await testEnv.DB.prepare("UPDATE ownership SET checked_at = ? WHERE account_id = ?").bind(now() - 8 * DAY, first.body.account_id).run();
		expect((await call("POST", "/auth/device", { body: { game: "required", secret, ownership: { steam_ticket: "ab".repeat(20) } } })).status).toBe(403);
		down.mockRestore();
		error.mockRestore();
	});

	it("guards the game's routes when ownership is required, whichever game the session came from", async () => {
		const player = await deviceAccount();
		const saves = await callJson("GET", "/saves/required", { token: player.token });
		expect(saves.status).toBe(403);
		expect(saves.body.error).toBe("not_owned");
		expect((await callJson("POST", "/lobbies", { token: player.token, body: { game: "required" } })).body.error).toBe("not_owned");
		expect((await call("GET", "/saves/checked", { token: player.token })).status).toBe(200);
	});

	it("gives TURN to an account that showed it owns the game", async () => {
		const secret = crypto.randomUUID() + crypto.randomUUID();
		const fetchSpy = steam({ "480": true });
		const owner = (await callJson("POST", "/auth/device", { body: { game: "required", secret, ownership: { steam_ticket: "ab".repeat(20) } } })).body;
		fetchSpy.mockRestore();
		const { body: lobby } = await callJson("POST", "/lobbies", { token: owner.token, body: { game: "required" } });
		const response = await call("GET", `/lobbies/${lobby.code}/socket?game=required`, { token: owner.token, headers: { upgrade: "websocket" } });
		const socket = response.webSocket!;
		const welcome = new Promise<any>((resolve) => socket.addEventListener("message", (event) => resolve(JSON.parse(event.data as string)), { once: true }));
		socket.accept();
		expect((await welcome).ice_servers[0].urls).toBe("turn:turn.example.com:3478");
		socket.close();
	});

	it("lets one Steam account's tickets prove a few other accounts, without locking any out", async () => {
		const owner = "76561198000000999";
		const secrets = Array.from({ length: 6 }, () => crypto.randomUUID() + crypto.randomUUID());
		const fetchSpy = steam({ "480": true }, owner);
		for (const secret of secrets.slice(0, 5)) {
			expect((await call("POST", "/auth/device", { body: { game: "required", secret, ownership: { steam_ticket: "ab".repeat(20) } } })).status).toBe(200);
		}
		const accounts = () => testEnv.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first<number>("n");
		const before = await accounts();
		const sixth = await callJson("POST", "/auth/device", { body: { game: "required", secret: secrets[5], ownership: { steam_ticket: "ab".repeat(20) } } });
		expect(sixth.body.error).toBe("not_owned");
		expect(await accounts()).toBe(before);
		// The first five keep it at their next check.
		await testEnv.DB.prepare("UPDATE ownership SET checked_at = checked_at - 2 * 86400").run();
		expect((await call("POST", "/auth/device", { body: { game: "required", secret: secrets[0], ownership: { steam_ticket: "ab".repeat(20) } } })).status).toBe(200);
		fetchSpy.mockRestore();
	});

	it("only lets a host who owns the game bring guests where it must be owned", async () => {
		const host = await deviceAccount();
		const refused = await callJson("POST", "/guest/email/start", { token: host.token, body: { email: "guest@example.com", game: "required" } });
		expect(refused.body.error).toBe("not_owned");
	});

	it("treats a proof that isn't a JWS object as none", async () => {
		const notAnObject = { app_transaction: `${btoa("null")}.${btoa("null")}.c2ln` };
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await call("POST", "/auth/device", { body: { game: "checked", secret: crypto.randomUUID() + crypto.randomUUID(), ownership: notAnObject } })).status).toBe(200);
		error.mockRestore();
	});

	it("hands out challenges only it can have signed", async () => {
		const { body } = await callJson("GET", "/ownership/challenge?game=required");
		expect(body.challenge.split(".")).toHaveLength(3);
		expect((await call("GET", "/ownership/challenge?game=nope")).status).toBe(404);
	});

	it("checks Play Integrity's verdict against the challenge", async () => {
		const key = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
		const pkcs8 = btoa(String.fromCharCode(...new Uint8Array((await crypto.subtle.exportKey("pkcs8", key.privateKey)) as ArrayBuffer)));
		const env = testEnv as unknown as Record<string, unknown>;
		env.PLAY_INTEGRITY_SERVICE_ACCOUNT = JSON.stringify({ client_email: "trill@example.iam.gserviceaccount.com", private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n` });
		const challenge = async () => (await callJson("GET", "/ownership/challenge?game=required")).body.challenge as string;
		let current = await challenge();
		const verdict = (licensing: string, requestHash?: string) =>
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url.startsWith("https://oauth2.googleapis.com/token")) {
					return Response.json({ access_token: "token" });
				}
				return Response.json({
					tokenPayloadExternal: {
						requestDetails: { requestHash: requestHash ?? current, requestPackageName: "com.example.required", timestampMillis: String(Date.now()) },
						accountDetails: { appLicensingVerdict: licensing },
					},
				});
			});
		const proof = () => ({ play_integrity: "t".repeat(40), challenge: current });
		const signIn = () => callJson("POST", "/auth/device", { body: { game: "required", secret: crypto.randomUUID() + crypto.randomUUID(), ownership: proof() } });

		let fetchSpy = verdict("LICENSED");
		const licensed = await signIn();
		expect(licensed.status).toBe(200);
		expect((await ownershipRow(licensed.body.account_id, "required"))?.source).toBe("google_play");

		// A challenge proves one sign-in only.
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await signIn()).status).toBe(403);
		fetchSpy.mockRestore();

		current = await challenge();
		fetchSpy = verdict("UNLICENSED");
		expect((await signIn()).body.error).toBe("not_owned");
		fetchSpy.mockRestore();

		// A token asked for another request proves nothing.
		current = await challenge();
		fetchSpy = verdict("LICENSED", "something else");
		expect((await signIn()).status).toBe(403);
		fetchSpy.mockRestore();
		error.mockRestore();
		delete env.PLAY_INTEGRITY_SERVICE_ACCOUNT;
	});
});

describe("App Store proofs", () => {
	// A chain shaped like Apple's: a P-384 root, an intermediate (a CA, with Apple's mark) and a
	// P-256 leaf (with Apple's receipt mark) that signs the JWS.
	async function chain(options: { leafMark?: boolean } = {}) {
		const x509 = await import("@peculiar/x509");
		x509.cryptoProvider.set(crypto);
		const root = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign", "verify"])) as CryptoKeyPair;
		const intermediate = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign", "verify"])) as CryptoKeyPair;
		const leaf = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
		const notBefore = new Date(Date.now() - DAY * 1000);
		const notAfter = new Date(Date.now() + 365 * DAY * 1000);
		const rootCert = await x509.X509CertificateGenerator.createSelfSigned({
			serialNumber: "01",
			name: "CN=Test Root CA",
			notBefore,
			notAfter,
			keys: root,
			signingAlgorithm: { name: "ECDSA", hash: "SHA-384" },
			extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
		});
		const intermediateCert = await x509.X509CertificateGenerator.create({
			serialNumber: "02",
			subject: "CN=Test Intermediate",
			issuer: rootCert.subject,
			notBefore,
			notAfter,
			publicKey: intermediate.publicKey,
			signingKey: root.privateKey,
			signingAlgorithm: { name: "ECDSA", hash: "SHA-384" },
			extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.Extension("1.2.840.113635.100.6.2.1", false, new Uint8Array([5, 0]))],
		});
		const leafCert = await x509.X509CertificateGenerator.create({
			serialNumber: "03",
			subject: "CN=Test Leaf",
			issuer: intermediateCert.subject,
			notBefore,
			notAfter,
			publicKey: leaf.publicKey,
			signingKey: intermediate.privateKey,
			signingAlgorithm: { name: "ECDSA", hash: "SHA-384" },
			extensions: options.leafMark === false ? [] : [new x509.Extension("1.2.840.113635.100.6.11.1", false, new Uint8Array([5, 0]))],
		});
		const der = (cert: { rawData: ArrayBuffer }) => btoa(String.fromCharCode(...new Uint8Array(cert.rawData)));
		const sign = async (payload: unknown) => {
			const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
			const head = `${encode({ alg: "ES256", x5c: [der(leafCert), der(intermediateCert), der(rootCert)] })}.${encode(payload)}`;
			const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, leaf.privateKey, new TextEncoder().encode(head)));
			return `${head}.${btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
		};
		return { root: der(rootCert), sign };
	}

	it("accepts an AppTransaction signed through the root", async () => {
		const { root, sign } = await chain();
		const jws = await sign({ bundleId: "com.example.required", receiptType: "Production", appTransactionId: "7" });
		expect((await verifyAppTransaction(jws, root)).bundleId).toBe("com.example.required");
	});

	it("refuses one from another root, without Apple's mark, or tampered with", async () => {
		const good = await chain();
		const other = await chain();
		const jws = await good.sign({ bundleId: "com.example.required", receiptType: "Production" });
		await expect(verifyAppTransaction(jws, other.root)).rejects.toThrow();
		const unmarked = await chain({ leafMark: false });
		await expect(verifyAppTransaction(await unmarked.sign({ bundleId: "x", receiptType: "Production" }), unmarked.root)).rejects.toThrow();
		const [head, , signature] = jws.split(".");
		const tampered = `${head}.${btoa(JSON.stringify({ bundleId: "com.example.required", receiptType: "Sandbox" })).replace(/=+$/, "")}.${signature}`;
		await expect(verifyAppTransaction(tampered, good.root)).rejects.toThrow();
	});

	it("is built on Apple Root CA G3", async () => {
		const { APPLE_ROOT_CA_G3 } = await import("../src/providers/app_store");
		const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(atob(APPLE_ROOT_CA_G3), (c) => c.charCodeAt(0)));
		expect([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe("63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179");
	});
});
