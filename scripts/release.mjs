// What setup.mjs and update.mjs share: which files come from Trill and which are the instance's
// own, finding Trill's latest stable release, and fetching it.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPOSITORY = "NekoLabStudio/trill";
// The release an instance was set up from or last updated to.
export const VERSION_FILE = ".trill-version";
// The files Trill provides: an update replaces them. Everything else is the instance's own,
// above all wrangler.jsonc (its settings), src/email-templates/custom/ (its emails) and
// .dev.vars (local secrets). The default wrangler.jsonc of each release is kept beside the
// instance's, so an update can tell what the next release changes in it.
export const UPSTREAM_PATHS = ["src", "migrations", "test", "scripts", "package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "README.md", ".gitignore"];
export const KEPT_INSIDE_UPSTREAM = ["src/email-templates/custom"];
export const UPSTREAM_CONFIG = ".trill-upstream/wrangler.jsonc";

// The newest stable release's tag ("v1.2.3"), from GitHub's "latest release" (which skips
// pre-releases and drafts).
export async function latestRelease() {
	const response = await fetch(`https://github.com/${REPOSITORY}/releases/latest`, { redirect: "manual" });
	const location = response.headers.get("location") ?? "";
	const match = /\/releases\/tag\/(v\d+\.\d+\.\d+)$/.exec(location);
	if (!match) {
		throw new Error(`Couldn't find Trill's latest release (GitHub answered ${response.status}).`);
	}
	return match[1];
}

// Trill from a release (its trill.tar.gz), in a temporary folder:
// { dir, cleanup }.
export async function fetchRelease(tag) {
	const scratch = mkdtempSync(join(tmpdir(), "trill-"));
	const cleanup = () => rmSync(scratch, { recursive: true, force: true });
	const response = await fetch(`https://github.com/${REPOSITORY}/releases/download/${tag}/trill.tar.gz`);
	if (!response.ok) {
		cleanup();
		throw new Error(`Couldn't download Trill ${tag} (GitHub answered ${response.status}).`);
	}
	const dir = join(scratch, "online");
	mkdirSync(dir);
	writeFileSync(join(scratch, "online.tar.gz"), Buffer.from(await response.arrayBuffer()));
	execFileSync("tar", ["-xzf", join(scratch, "online.tar.gz"), "-C", dir]);
	if (!existsSync(join(dir, "wrangler.jsonc"))) {
		cleanup();
		throw new Error(`Trill ${tag} has no service in it.`);
	}
	return { dir, cleanup };
}

// Copies Trill's files from a release into the instance, leaving the instance's own alone.
export function copyUpstream(from, to) {
	const kept = new Map();
	for (const path of KEPT_INSIDE_UPSTREAM) {
		if (existsSync(join(to, path))) {
			const saved = mkdtempSync(join(tmpdir(), "trill-kept-"));
			cpSync(join(to, path), saved, { recursive: true });
			kept.set(path, saved);
		}
	}
	for (const path of UPSTREAM_PATHS) {
		rmSync(join(to, path), { recursive: true, force: true });
		if (existsSync(join(from, path))) {
			cpSync(join(from, path), join(to, path), { recursive: true });
		}
	}
	for (const [path, saved] of kept) {
		cpSync(saved, join(to, path), { recursive: true });
		rmSync(saved, { recursive: true, force: true });
	}
	cpSync(join(from, "wrangler.jsonc"), join(to, UPSTREAM_CONFIG));
}

export function readVersion(dir) {
	return existsSync(join(dir, VERSION_FILE)) ? readFileSync(join(dir, VERSION_FILE), "utf8").trim() : "";
}

export function writeVersion(dir, tag) {
	writeFileSync(join(dir, VERSION_FILE), `${tag}\n`);
}
