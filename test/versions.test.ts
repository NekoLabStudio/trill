import { describe, expect, it } from "vitest";
import { call, callJson } from "./helpers";
import { compareVersions } from "../src/client_versions";
import { PROTOCOL, SERVICE_VERSION } from "../src/version";

const as = (game: string, version?: string) => ({ "x-purr-game": game, ...(version ? { "x-game-version": version } : {}) });

describe("versions", () => {
	it("compares versions part by part", () => {
		expect(compareVersions("1.10.0", "1.9.2")).toBe(1);
		expect(compareVersions("1.2", "1.2.0")).toBe(0);
		expect(compareVersions("1.2.0-beta", "1.2.1")).toBe(-1);
	});

	it("says what the service is, on /version and on every answer", async () => {
		expect((await callJson("GET", "/version")).body).toEqual({ version: SERVICE_VERSION, protocol: PROTOCOL });
		expect((await call("GET", "/nope")).headers.get("x-purr-protocol")).toBe(String(PROTOCOL));
	});

	it("lets every version play when the game sets no range", async () => {
		const response = await call("POST", "/auth/device", { body: { game: "test", secret: "v".repeat(40) }, headers: as("test", "0.0.1") });
		expect(response.status).toBe(200);
	});

	it("turns away versions outside the game's range, and asks for an update", async () => {
		const tooOld = await callJson("POST", "/auth/device", { body: { game: "test", secret: "w".repeat(40) }, headers: as("versioned", "1.1.9") });
		expect(tooOld.status).toBe(426);
		expect(tooOld.body).toMatchObject({ error: "update_required", min_version: "1.2.0", max_version: "2.0" });
		const unknown = await callJson("POST", "/auth/device", { body: { game: "test", secret: "w".repeat(40) }, headers: as("versioned") });
		expect(unknown.body.error).toBe("update_required");
		const tooNew = await callJson("POST", "/auth/device", { body: { game: "test", secret: "w".repeat(40) }, headers: as("versioned", "2.0.1") });
		expect(tooNew.body.error).toBe("version_unsupported");
		expect((await call("POST", "/auth/device", { body: { game: "test", secret: "w".repeat(40) }, headers: as("versioned", "1.5") })).status).toBe(200);
		expect((await call("POST", "/auth/device", { body: { game: "test", secret: "w".repeat(40) }, headers: as("versioned", "2.0") })).status).toBe(200);
	});
});
