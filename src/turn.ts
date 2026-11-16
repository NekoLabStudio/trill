// ICE servers for WebRTC: Cloudflare's TURN service when TURN_KEY_ID and TURN_KEY_API_TOKEN are
// set, a self-hosted list from TURN_SERVERS (a JSON array of RTCIceServer) otherwise, or just
// Cloudflare's STUN server, which has no TURN fallback.

import type { Env } from "./env";
import { HttpError } from "./http";

const CREDENTIALS_TTL = 86400;

export async function iceServers(env: Env): Promise<{ ice_servers: unknown[] }> {
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
		return { ice_servers: body.iceServers ?? [] };
	}
	if (env.TURN_SERVERS) {
		return { ice_servers: JSON.parse(env.TURN_SERVERS) };
	}
	return { ice_servers: [{ urls: "stun:stun.cloudflare.com:3478" }] };
}
