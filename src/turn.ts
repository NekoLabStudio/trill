// ICE servers for WebRTC: Cloudflare's TURN service when TURN_KEY_ID and TURN_KEY_API_TOKEN are
// set, a self-hosted list from TURN_SERVERS (a JSON array of RTCIceServer) otherwise, or just
// Cloudflare's STUN server, which has no TURN fallback. Only players joining a lobby get them (in
// its welcome), so nobody can take TURN credentials to relay their own traffic on the operator's
// bill without being in one, and they last for a long play session rather than a day.

import type { Env } from "./env";
import { HttpError } from "./http";

const CREDENTIALS_TTL = 12 * 3600;

export const STUN_ONLY = [{ urls: "stun:stun.cloudflare.com:3478" }];

export async function iceServers(env: Env): Promise<unknown[]> {
	if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
		const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
			method: "POST",
			headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ ttl: CREDENTIALS_TTL }),
		});
		if (!response.ok) {
			throw new HttpError(502, "provider_unavailable", `Cloudflare's TURN service answered ${response.status}.`);
		}
		const body = (await response.json()) as { iceServers?: unknown[] };
		return body.iceServers ?? STUN_ONLY;
	}
	if (env.TURN_SERVERS) {
		return JSON.parse(env.TURN_SERVERS);
	}
	return STUN_ONLY;
}
