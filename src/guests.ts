// Device grants: the long-lived tokens a host device keeps for a remembered guest (who brought
// their profile with their email, see email_accounts.ts). The guest sees and revokes them on
// their own device; the host forgets one with the grant itself.

import type { Env } from "./env";
import type { Caller } from "./sessions";
import { deleteIfOrphaned } from "./accounts";
import { HttpError } from "./http";

// "Devices that remember you", on the player's own device.
export async function listGrants(env: Env, caller: Caller) {
	const rows = await env.DB.prepare("SELECT id, device_label, created_at, last_used_at FROM device_grants WHERE account_id = ? ORDER BY created_at")
		.bind(caller.accountId)
		.all();
	return { grants: rows.results };
}

export async function revokeGrant(env: Env, caller: Caller, grantId: string) {
	const result = await env.DB.prepare("DELETE FROM device_grants WHERE id = ? AND account_id = ?").bind(grantId, caller.accountId).run();
	if (result.meta.changes === 0) {
		throw new HttpError(404, "unknown_grant", "No such device on this account.");
	}
	return { revoked: grantId };
}

// The host forgetting a remembered guest, with the grant itself. (An account with neither an
// identity nor a grant left can't be reached, so it's deleted with its saves.)
export async function forgetGrant(env: Env, caller: Caller) {
	if (!caller.grantId) {
		throw new HttpError(400, "bad_request", "Forget with the device grant itself.");
	}
	await env.DB.prepare("DELETE FROM device_grants WHERE id = ?").bind(caller.grantId).run();
	const deleted = await deleteIfOrphaned(env, caller.accountId);
	return { forgotten: caller.grantId, account_deleted: deleted };
}
