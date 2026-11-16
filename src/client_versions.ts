// Game versions a game's settings allow online (min_version and max_version, both optional;
// without them, every version is). A Purr game sends its ID and version with every request
// (X-Purr-Game and X-Game-Version, from its application/config/version), so a game can turn
// away versions that are too old to play online, or too new for this service.

import type { Env } from "./env";
import { HttpError } from "./http";

// Compares dotted versions part by part as numbers ("1.10.0" > "1.9.2"); a part that isn't a
// number counts as 0, and a missing part as 0 ("1.2" == "1.2.0").
export function compareVersions(a: string, b: string): number {
	const parts = (version: string) => version.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
	const left = parts(a);
	const right = parts(b);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const difference = (left[i] ?? 0) - (right[i] ?? 0);
		if (difference !== 0) {
			return Math.sign(difference);
		}
	}
	return 0;
}

export function checkClientVersion(env: Env, request: Request): void {
	const game = request.headers.get("x-purr-game") ?? "";
	if (!game || !Object.hasOwn(env.GAMES, game)) {
		return;
	}
	const { min_version, max_version } = env.GAMES[game];
	if (!min_version && !max_version) {
		return;
	}
	const version = request.headers.get("x-game-version") ?? "";
	const range = { min_version: min_version ?? null, max_version: max_version ?? null };
	if (min_version && (!version || compareVersions(version, min_version) < 0)) {
		throw new HttpError(426, "update_required", `This version of the game can't play online any more: update it to ${min_version} or later.`, range);
	}
	if (max_version && version && compareVersions(version, max_version) > 0) {
		throw new HttpError(426, "version_unsupported", `This version of the game is newer than the online services support (up to ${max_version}).`, range);
	}
}
