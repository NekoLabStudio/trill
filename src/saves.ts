// Saves, one per account, game and slot, in R2:
//   accounts/<account>/<game>/<slot>/current        the save; its version and summary as metadata
//   accounts/<account>/<game>/<slot>/backup/<n>     the two versions before it
//   discarded/<account>/<game>/<slot>/<time>        a save set aside (an R2 lifecycle rule deletes
//                                                   these after 30 days)
// A write names the version it replaces, so two devices can't silently overwrite each other.
// Only accounts with an email address keep saves here (others use their platform's cloud), and
// each game has a size and slot limit: the service can't tell a game save from any other data,
// so it holds as little as a game needs.

import type { Env } from "./env";
import { HttpError } from "./http";
import { hasEmail, requireGame } from "./identities";
import { now } from "./time";

const BACKUPS_KEPT = 2;
const MAX_SUMMARY_BYTES = 1024;
const NAME = /^[a-z0-9_-]{1,64}$/;

export interface SaveInfo {
	game: string;
	slot: string;
	version: number;
	summary: unknown;
	size: number;
	saved_at: number;
}

export function checkName(kind: string, name: string): string {
	if (!NAME.test(name)) {
		throw new HttpError(400, "bad_request", `A ${kind} is 1 to 64 lowercase letters, digits, "-" or "_".`);
	}
	return name;
}

function slotPrefix(accountId: string, game: string, slot: string): string {
	return `accounts/${accountId}/${game}/${slot}/`;
}

function info(object: R2Object): SaveInfo {
	const [, , game, slot] = object.key.split("/");
	let summary: unknown = null;
	try {
		summary = JSON.parse(object.customMetadata?.summary ?? "null");
	} catch {
		// A summary that isn't JSON stays null.
	}
	return {
		game,
		slot,
		version: Number(object.customMetadata?.version ?? 0),
		summary,
		size: object.size,
		saved_at: Math.floor(object.uploaded.getTime() / 1000),
	};
}

async function listAll(env: Env, prefix: string): Promise<R2Object[]> {
	const objects: R2Object[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.SAVES.list({ prefix, cursor, include: ["customMetadata"] });
		objects.push(...page.objects);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return objects;
}

// Every current save of an account, in one game or all of them.
export async function listSaves(env: Env, accountId: string, game?: string): Promise<SaveInfo[]> {
	const prefix = game ? `accounts/${accountId}/${game}/` : `accounts/${accountId}/`;
	return (await listAll(env, prefix)).filter((object) => object.key.endsWith("/current")).map(info);
}

export async function readSave(env: Env, accountId: string, game: string, slot: string): Promise<R2ObjectBody | null> {
	return env.SAVES.get(slotPrefix(accountId, game, slot) + "current");
}

export async function writeSave(
	env: Env,
	accountId: string,
	game: string,
	slot: string,
	data: ArrayBuffer,
	replacesVersion: number,
	summaryJson: string,
): Promise<number> {
	const settings = requireGame(env, game);
	const maxBytes = settings.max_save_bytes ?? env.MAX_SAVE_BYTES;
	const maxSlots = settings.max_save_slots ?? env.MAX_SAVE_SLOTS;
	if (data.byteLength > maxBytes) {
		throw new HttpError(413, "save_too_large", `A save can be at most ${maxBytes} bytes.`);
	}
	if (!(await hasEmail(env, accountId))) {
		throw new HttpError(403, "email_required", "Saves are kept here once the player adds an email address; until then, the platform's own cloud keeps them.");
	}
	if (new TextEncoder().encode(summaryJson).length > MAX_SUMMARY_BYTES) {
		throw new HttpError(400, "bad_request", `A save's summary can be at most ${MAX_SUMMARY_BYTES} bytes.`);
	}
	const key = slotPrefix(accountId, game, slot) + "current";
	const previous = await env.SAVES.get(key);
	const currentVersion = previous ? Number(previous.customMetadata?.version ?? 0) : 0;
	if (replacesVersion !== currentVersion) {
		throw new HttpError(409, "version_conflict", "Another device saved since this one last loaded.", { current_version: currentVersion });
	}
	if (!previous) {
		// A new slot is claimed in D1 first, counted in the same statement, so writes at the same
		// moment can't take more than the limit between them.
		const claimed = await env.DB.prepare(
			`INSERT OR IGNORE INTO save_slots (account_id, game, slot)
			 SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM save_slots WHERE account_id = ?1 AND game = ?2) < ?4`,
		)
			.bind(accountId, game, slot, maxSlots)
			.run();
		const held =
			claimed.meta.changes === 1 ||
			(await env.DB.prepare("SELECT 1 FROM save_slots WHERE account_id = ? AND game = ? AND slot = ?").bind(accountId, game, slot).first()) !== null;
		if (!held) {
			throw new HttpError(409, "too_many_slots", `A player can have at most ${maxSlots} saves in this game.`);
		}
	}

	const version = currentVersion + 1;
	// Only if nobody wrote in between: the same object as read, or still none at all.
	const onlyIf = previous ? { etagMatches: previous.etag } : new Headers({ "if-none-match": "*" });
	const written = await env.SAVES.put(key, data, { onlyIf, customMetadata: { version: String(version), summary: summaryJson } });
	if (!written) {
		throw new HttpError(409, "version_conflict", "Another device saved at the same moment.", { current_version: currentVersion });
	}

	if (previous) {
		await env.SAVES.put(slotPrefix(accountId, game, slot) + `backup/${String(currentVersion).padStart(10, "0")}`, await previous.arrayBuffer(), {
			customMetadata: previous.customMetadata,
		});
		const backups = (await listAll(env, slotPrefix(accountId, game, slot) + "backup/")).map((object) => object.key).sort();
		if (backups.length > BACKUPS_KEPT) {
			await env.SAVES.delete(backups.slice(0, backups.length - BACKUPS_KEPT));
		}
	}
	return version;
}

async function deleteKeys(env: Env, keys: string[]): Promise<void> {
	for (let i = 0; i < keys.length; i += 1000) {
		await env.SAVES.delete(keys.slice(i, i + 1000));
	}
}

export async function deleteAllSaves(env: Env, accountId: string): Promise<void> {
	await deleteKeys(env, (await listAll(env, `accounts/${accountId}/`)).map((object) => object.key));
}

// Moves every save of an account to discarded/, where the lifecycle rule deletes it after 30 days.
export async function discardAllSaves(env: Env, accountId: string): Promise<void> {
	for (const save of await listSaves(env, accountId)) {
		const object = await readSave(env, accountId, save.game, save.slot);
		if (object) {
			await env.SAVES.put(`discarded/${accountId}/${save.game}/${save.slot}/${now()}`, await object.arrayBuffer(), {
				customMetadata: object.customMetadata,
			});
		}
	}
	await deleteAllSaves(env, accountId);
}
