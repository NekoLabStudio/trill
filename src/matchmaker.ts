// Matchmaking: one Durable Object per game, ranked mode and lobby size, holding the WebSockets of
// the players waiting (hibernating in between). Players are grouped with others of a similar
// rating, nearest first (distance stands in for latency: players can't measure it before they're
// connected), within a rating range and a distance that both widen the longer they wait, and
// never with someone either of them blocked. A player's approximate location (Cloudflare's, from
// their connection) stays on their socket while they wait and is never stored.
// A group gets a new ranked lobby, hosted by whoever waited longest, and each player its code;
// they then join it like any lobby, and the host reports the result there.
//
// Messages, as JSON text, to a waiting player: {"type": "waiting", "players": n} when they
// join, and {"type": "matched", "code"} when a lobby is ready. The player closes the socket then
// (closing it here could lose the message on the way); sockets left open are closed later.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { randomCode } from "./crypto";

// The rating difference accepted at first, how much it widens, and how often.
const WINDOW_START = 100;
const WINDOW_GROWTH = 50;
const WINDOW_STEP_MS = 5_000;
const WINDOW_MAX = 1_000;
// The distance accepted at first, how much it widens each step, and when it stops mattering.
const DISTANCE_START_KM = 1_500;
const DISTANCE_GROWTH_KM = 1_500;
const DISTANCE_ANY_KM = 20_000;
// How often a queue with players waiting looks for a match again.
const RETRY_MS = 2_000;
// A matched player's socket still open after this long is closed.
const MATCHED_GRACE_MS = 10_000;

interface Waiting {
	account_id: string;
	rating: number;
	blocked: string[];
	since: number;
	// Latitude and longitude, roughly (the connection's city), if known.
	location: [number, number] | null;
	// When they were sent a lobby's code.
	matched_at?: number;
}

export class Matchmaker extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		// The Worker vouches for these (it sets them after checking the caller's token).
		const accountId = request.headers.get("x-account-id") ?? "";
		const size = Number(request.headers.get("x-size"));
		const game = request.headers.get("x-game") ?? "";
		const mode = request.headers.get("x-mode") ?? "";
		if (this.waiting().some((player) => player.account_id === accountId)) {
			return new Response("Already waiting.", { status: 409 });
		}
		await this.ctx.storage.put({ size, game, mode });
		const player: Waiting = {
			account_id: accountId,
			rating: Number(request.headers.get("x-rating")),
			blocked: (request.headers.get("x-blocked") ?? "").split(",").filter(Boolean),
			since: Date.now(),
			location: parseLocation(request.headers.get("x-location")),
		};
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment(player);
		server.send(JSON.stringify({ type: "waiting", players: this.waiting().length }));
		// Matching runs from the alarm, just after this answer, so a player matched straight away
		// has their connection open before the lobby's code is sent and the socket closed.
		await this.ctx.storage.setAlarm(Date.now() + 50);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(): Promise<void> {
		// Nothing to say while waiting.
	}

	async alarm(): Promise<void> {
		await this.match();
		// Matched players who never closed their socket.
		let lingering = false;
		for (const socket of this.ctx.getWebSockets()) {
			const matchedAt = (socket.deserializeAttachment() as Waiting).matched_at;
			if (matchedAt && Date.now() - matchedAt > MATCHED_GRACE_MS) {
				socket.close(1000, "Matched.");
			} else if (matchedAt) {
				lingering = true;
			}
		}
		if (lingering && this.sockets().length === 0) {
			await this.ctx.storage.setAlarm(Date.now() + MATCHED_GRACE_MS);
		}
	}

	// The sockets still waiting (a matched one stays until its player closes it).
	private sockets(): WebSocket[] {
		return this.ctx.getWebSockets().filter((socket) => !(socket.deserializeAttachment() as Waiting).matched_at);
	}

	private waiting(): Waiting[] {
		return this.sockets().map((socket) => socket.deserializeAttachment() as Waiting);
	}

	// Groups as many players as it can, oldest first, then checks again later if anyone's left.
	private async match(): Promise<void> {
		const size = (await this.ctx.storage.get<number>("size")) ?? 2;
		const time = Date.now();
		let sockets = this.sockets();
		let matched = true;
		while (matched && sockets.length >= size) {
			matched = false;
			const players = sockets.map((socket) => ({ socket, player: socket.deserializeAttachment() as Waiting }));
			players.sort((a, b) => a.player.since - b.player.since);
			for (const first of players) {
				const steps = (player: Waiting) => Math.floor((time - player.since) / WINDOW_STEP_MS);
				const window = (player: Waiting) => Math.min(WINDOW_MAX, WINDOW_START + WINDOW_GROWTH * steps(player));
				const reach = (player: Waiting) => DISTANCE_START_KM + DISTANCE_GROWTH_KM * steps(player);
				const group = [first];
				// Nearest first; among players as near, the closest rating.
				const candidates = players
					.filter((other) => other !== first)
					.sort(
						(a, b) =>
							distanceKm(a.player.location, first.player.location) - distanceKm(b.player.location, first.player.location) ||
							Math.abs(a.player.rating - first.player.rating) - Math.abs(b.player.rating - first.player.rating),
					);
				for (const candidate of candidates) {
					if (group.length === size) {
						break;
					}
					const fits = group.every(
						(member) =>
							Math.abs(member.player.rating - candidate.player.rating) <= Math.max(window(member.player), window(candidate.player)) &&
							withinReach(distanceKm(member.player.location, candidate.player.location), Math.max(reach(member.player), reach(candidate.player))) &&
							!member.player.blocked.includes(candidate.player.account_id) &&
							!candidate.player.blocked.includes(member.player.account_id),
					);
					if (fits) {
						group.push(candidate);
					}
				}
				if (group.length === size) {
					await this.startLobby(group.map((entry) => entry.socket), first.player.account_id);
					sockets = this.sockets();
					matched = true;
					break;
				}
			}
		}
		if (sockets.length > 0) {
			await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
		}
	}

	private async startLobby(sockets: WebSocket[], hostAccountId: string): Promise<void> {
		const game = (await this.ctx.storage.get<string>("game")) ?? "";
		const mode = (await this.ctx.storage.get<string>("mode")) ?? "";
		for (let attempt = 0; attempt < 5; attempt++) {
			const code = randomCode();
			if (await this.env.LOBBIES.getByName(code).create(game, hostAccountId, mode)) {
				for (const socket of sockets) {
					socket.serializeAttachment({ ...(socket.deserializeAttachment() as Waiting), matched_at: Date.now() });
					socket.send(JSON.stringify({ type: "matched", code }));
				}
				return;
			}
		}
	}
}

function parseLocation(header: string | null): [number, number] | null {
	const [latitude, longitude] = (header ?? "").split(",").map(Number);
	return Number.isFinite(latitude) && Number.isFinite(longitude) && header ? [latitude, longitude] : null;
}

// Great-circle distance; 0 when either location is unknown, so players without one match anyone.
export function distanceKm(a: [number, number] | null, b: [number, number] | null): number {
	if (!a || !b) {
		return 0;
	}
	const radians = (degrees: number) => (degrees * Math.PI) / 180;
	const [lat1, lon1] = a.map(radians);
	const [lat2, lon2] = b.map(radians);
	const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
	return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function withinReach(distance: number, reach: number): boolean {
	return reach >= DISTANCE_ANY_KM || distance <= reach;
}
