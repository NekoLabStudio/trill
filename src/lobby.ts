// A lobby: one Durable Object per invite code, holding the players' WebSockets (hibernating
// between messages). It only relays WebRTC signalling: gameplay goes peer to peer (or through
// TURN), never through here. The creator is peer 1 (the host); everyone else gets a random peer
// ID, as Godot's WebRTCMultiplayerPeer expects.
//
// Messages, as JSON text:
//   to a player as they join  {"type": "welcome", "peer_id": n, "members": [{"peer_id", "display_name"}], "ranked": bool,
//                             "ice_servers": [...], "ice_expires_in": seconds (0: they don't end)}
//   from a player             {"type": "renew_ice"}: their TURN credentials are ending; they get
//                             {"type": "ice_servers", "ice_servers": [...], "ice_expires_in": seconds}
//                             (at most every RENEW_INTERVAL_MS). A player's credentials are revoked
//                             when they leave.
//   to the others             {"type": "joined", "peer_id": n, "display_name": "..."}
//                             {"type": "left", "peer_id": n}
//   from a player             {"type": "signal", "to": n, "data": ...}
//   relayed as                {"type": "signal", "from": n, "data": ...}
//   from a player             {"type": "report", "peer_id": n, "reason", "details"}, {"type": "block", "peer_id": n}
//   from the host             {"type": "kick", "peer_id": n}: the player gets {"type": "kicked"} and
//                             can't come back to this lobby
//   from a player             {"type": "result", "ranking": [peer IDs, first to last]}: what that
//                             player saw, in a ranked (matchmade) lobby, for everyone in it. Recorded
//                             once enough players sent the same ranking (the game's ranked_agreement),
//                             then everyone gets {"type": "result_recorded"}
//   from a player             {"type": "check", "name", "value"}: a value every player's game can
//                             work out at that moment (a hash). Once everyone in the lobby has sent
//                             theirs, everyone gets {"type": "check_result", "name", "agreed": bool,
//                             "disagreeing": [peer IDs]}: those who differ from the majority (reported
//                             as cheating unless the game turned that off). In a ranked lobby, a failed
//                             check stops the result from counting.
//   from a player             {"type": "flag", "peer_id": n, "reason"}: this player's game judged
//                             another's behaviour impossible (teleporting, say). When more than half
//                             of the other players, and at least two, flag the same player for the
//                             same reason within FLAG_WINDOW_MS, everyone gets {"type": "flagged",
//                             "peer_id", "reason"}, handled like a failed check.
//   Players named by a failed check or a confirmed flag are reported (report_failed_checks) and,
//   with the game's kick_cheaters on, removed from the lobby like a host kick, which counts
//   towards an automatic ban (AUTO_BAN).
//   to everyone, when the     {"type": "host_changed", "old_peer_id": n, "you": bool}: whoever has
//   host leaves               been in the lobby longest becomes the host, as peer 1 (games that don't
//                             migrate hosts end the session instead)

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { block, recordCheatKick, report } from "./moderation";
import { recordResult } from "./ratings";
import { STUN_ONLY, iceServers, revokeCredentials, type IceServers } from "./turn";

export const MAX_MEMBERS = 8;
const MAX_MESSAGE_BYTES = 16 * 1024;
// One account can be in a lobby twice at most (two windows of the same game while testing).
const MAX_SOCKETS_PER_ACCOUNT = 2;
// Signalling is a handful of messages per connection: a socket sending more than this in a window
// is closed.
const MESSAGE_BUDGET = 200;
const MESSAGE_WINDOW_MS = 10_000;
// A lobby nobody joins within this long is cleared.
const UNUSED_LIFETIME_MS = 10 * 60 * 1000;
// A player renews their TURN credentials once they near their end, never more often than this.
const RENEW_INTERVAL_MS = 30 * 60 * 1000;
// The Cloudflare usernames kept for a player, newest last (older ones have ended by then).
const MAX_TURN_USERNAMES = 3;

interface Member {
	peer_id: number;
	account_id: string;
	display_name: string;
	// The socket's message budget: when its window started, and how many it sent since.
	window_started: number;
	sent: number;
	// Kicked: closed by the lobby, no longer a member.
	gone?: boolean;
	// Joining: holds a place (counted against the lobby's limits) but isn't seen by the others, nor
	// sees them, until its welcome is sent.
	pending?: boolean;
	// When they joined: the longest here becomes host if the host leaves.
	joined_at: number;
	// Whether they get TURN credentials, which ones (Cloudflare's usernames, revoked when they
	// leave), and when they last got some.
	turn: boolean;
	turn_usernames: string[];
	turn_at: number;
}

// Close code for a kicked player.
const KICKED = 4001;
// Checks: names are short identifiers, values short strings (hashes), and a lobby keeps at most
// this many (a game checks at moments, not every frame).
const CHECK_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_CHECK_VALUE = 128;
const MAX_CHECKS = 256;

// Flags: how close together the flags must be, and the reasons' form.
const FLAG_WINDOW_MS = 10_000;
const FLAG_REASON = /^[A-Za-z0-9_.:-]{1,32}$/;

interface Flag {
	target: string; // account ID
	reason: string;
	by: string; // account ID
	at: number;
}

interface Check {
	values: Record<string, string>; // account ID -> value
	done: boolean;
}

export class Lobby extends DurableObject<Env> {
	// The creator's account, set when the lobby is made, and the ranked mode for a matchmade one.
	async create(game: string, hostAccountId: string, mode = ""): Promise<boolean> {
		if (await this.ctx.storage.get("game")) {
			return false;
		}
		await this.ctx.storage.put({ game, host: hostAccountId, mode, kicked: [], reported: false });
		await this.ctx.storage.setAlarm(Date.now() + UNUSED_LIFETIME_MS);
		return true;
	}

	async fetch(request: Request): Promise<Response> {
		const game = await this.ctx.storage.get<string>("game");
		if (!game) {
			return new Response("No such lobby.", { status: 404 });
		}
		// The Worker vouches for these (it sets them after checking the caller's token).
		if (request.headers.get("x-game") !== game) {
			return new Response("No such lobby.", { status: 404 });
		}
		const members = this.seats();
		if (members.length >= MAX_MEMBERS) {
			return new Response("The lobby is full.", { status: 409 });
		}
		const accountId = request.headers.get("x-account-id") ?? "";
		if (members.filter((member) => member.account_id === accountId).length >= MAX_SOCKETS_PER_ACCOUNT) {
			return new Response("Already in this lobby.", { status: 409 });
		}
		const host = await this.ctx.storage.get<string>("host");
		const kicked = (await this.ctx.storage.get<string[]>("kicked")) ?? [];
		const blockedBy = (request.headers.get("x-blocked-by") ?? "").split(",");
		if (kicked.includes(accountId) || (host && blockedBy.includes(host))) {
			return new Response("Not allowed in this lobby.", { status: 403 });
		}
		const displayName = decodeURIComponent(request.headers.get("x-display-name") ?? "");
		const turn = request.headers.get("x-turn") === "1";
		const member: Member = {
			peer_id: this.newPeerId(accountId === host, members),
			account_id: accountId,
			display_name: displayName,
			window_started: Date.now(),
			sent: 0,
			joined_at: Date.now(),
			turn,
			turn_usernames: [],
			turn_at: Date.now(),
			pending: true,
		};

		// The player takes their place before anything is awaited, so joins at the same moment are
		// checked against each other (D1 and fetch let other requests in while they wait).
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment(member);
		const ranked = Boolean(await this.ctx.storage.get<string>("mode"));
		const ice = turn ? await this.iceServers(accountId, request.headers.get("x-renews") === "1") : { servers: STUN_ONLY, usernames: [], expires_in: 0 };
		const current = server.deserializeAttachment() as Member;
		if (current.gone) {
			this.ctx.waitUntil(revokeCredentials(this.env, ice.usernames));
			return new Response(null, { status: 101, webSocket: client });
		}
		current.turn_usernames = ice.usernames;
		current.pending = false;
		server.serializeAttachment(current);
		const others = this.members().filter((each) => each.peer_id !== current.peer_id);
		server.send(JSON.stringify({ type: "welcome", peer_id: current.peer_id, members: others.map(publicMember), ranked, ice_servers: ice.servers, ice_expires_in: ice.expires_in }));
		this.broadcast({ type: "joined", ...publicMember(current) }, server);
		return new Response(null, { status: 101, webSocket: client });
	}

	// TURN credentials for a player joining or renewing; if the TURN service can't be reached, they
	// still join and connect directly where they can.
	private async iceServers(accountId: string, renews: boolean): Promise<IceServers> {
		try {
			return await iceServers(this.env, accountId, renews);
		} catch {
			console.error("Couldn't get TURN credentials for a player in a lobby");
			return { servers: STUN_ONLY, usernames: [], expires_in: 0 };
		}
	}

	// A player's credentials are ending: new ones, which their game moves its connections onto.
	private async renewIce(socket: WebSocket, member: Member): Promise<void> {
		if (!member.turn || Date.now() - member.turn_at < RENEW_INTERVAL_MS) {
			return;
		}
		member.turn_at = Date.now();
		socket.serializeAttachment(member);
		const ice = await this.iceServers(member.account_id, true);
		// The socket's attachment may have changed while waiting (a kick): read it again.
		const current = socket.deserializeAttachment() as Member;
		if (current.gone) {
			this.ctx.waitUntil(revokeCredentials(this.env, ice.usernames));
			return;
		}
		current.turn_usernames = [...current.turn_usernames, ...ice.usernames].slice(-MAX_TURN_USERNAMES);
		current.turn_at = member.turn_at;
		socket.serializeAttachment(current);
		socket.send(JSON.stringify({ type: "ice_servers", ice_servers: ice.servers, ice_expires_in: ice.expires_in }));
	}

	async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const sender = socket.deserializeAttachment() as Member;
		const time = Date.now();
		if (time - sender.window_started > MESSAGE_WINDOW_MS) {
			sender.window_started = time;
			sender.sent = 0;
		}
		sender.sent++;
		socket.serializeAttachment(sender);
		if (sender.sent > MESSAGE_BUDGET) {
			socket.close(1008, "Too many messages.");
			return;
		}
		if (typeof message !== "string" || message.length > MAX_MESSAGE_BYTES) {
			return;
		}
		let parsed: { type?: string; to?: unknown; peer_id?: unknown; data?: unknown; reason?: unknown; details?: unknown; ranking?: unknown; name?: unknown; value?: unknown };
		try {
			parsed = JSON.parse(message);
		} catch {
			return;
		}
		if (sender.gone || sender.pending) {
			return;
		}
		const isHost = sender.peer_id === 1;
		const target = typeof parsed.peer_id === "number" ? this.socketOf(parsed.peer_id) : null;
		const targetMember = target ? (target.deserializeAttachment() as Member) : null;
		const game = (await this.ctx.storage.get<string>("game")) ?? "";

		if (parsed.type === "signal" && typeof parsed.to === "number") {
			this.socketOf(parsed.to)?.send(JSON.stringify({ type: "signal", from: sender.peer_id, data: parsed.data }));
		} else if (parsed.type === "kick" && isHost && target && targetMember && targetMember.peer_id !== 1) {
			await this.kick(target, targetMember);
		} else if (parsed.type === "report" && targetMember) {
			await report(this.env, game, sender.account_id, targetMember.account_id, parsed.reason, parsed.details);
		} else if (parsed.type === "block" && targetMember) {
			await block(this.env, sender.account_id, targetMember.account_id);
		} else if (parsed.type === "result" && Array.isArray(parsed.ranking)) {
			await this.recordRanking(sender, isHost, game, parsed.ranking);
		} else if (parsed.type === "check" && typeof parsed.name === "string" && typeof parsed.value === "string") {
			await this.submitCheck(sender, game, parsed.name, parsed.value);
		} else if (parsed.type === "flag" && targetMember && typeof parsed.reason === "string") {
			await this.flag(sender, targetMember, game, parsed.reason);
		} else if (parsed.type === "renew_ice") {
			await this.renewIce(socket, sender);
		}
	}

	// The host removes a player, who can't come back to this lobby.
	// Removes a player, who can't come back to this lobby: every socket their account has here,
	// except the host's own when the host kicks someone on the same account (two windows while
	// testing). A cheating host can be removed too (byLobby), and the next host takes over.
	private async kick(target: WebSocket, member: Member, byLobby = false): Promise<void> {
		const kicked = (await this.ctx.storage.get<string[]>("kicked")) ?? [];
		kicked.push(member.account_id);
		await this.ctx.storage.put("kicked", kicked);
		let hostRemoved = false;
		for (const socket of this.ctx.getWebSockets()) {
			const each = socket.deserializeAttachment() as Member;
			if (each.account_id === member.account_id && !each.gone && (byLobby || each.peer_id !== 1)) {
				each.gone = true;
				socket.serializeAttachment(each);
				socket.send(JSON.stringify({ type: "kicked" }));
				socket.close(KICKED, byLobby ? "Removed for cheating." : "Removed by the host.");
				if (!each.pending) {
					this.broadcast({ type: "left", peer_id: each.peer_id }, socket);
				}
				hostRemoved ||= each.peer_id === 1;
			}
		}
		if (hostRemoved) {
			await this.promoteHost();
		}
	}

	// A ranked lobby's result, as one player saw it: everyone in the lobby, first to last. It's
	// recorded, once, when enough players sent the same ranking: by default more than half of
	// them, so no single player can change ratings on their own.
	private async recordRanking(sender: Member, isHost: boolean, game: string, ranking: unknown[]): Promise<void> {
		const mode = await this.ctx.storage.get<string>("mode");
		if (!mode || (await this.ctx.storage.get<boolean>("reported")) || (await this.ctx.storage.get<boolean>("contested"))) {
			return;
		}
		const members = this.members();
		const accounts = ranking.map((peerId) => members.find((member) => member.peer_id === peerId)?.account_id);
		const unique = new Set(accounts);
		const everyone = new Set(members.map((member) => member.account_id));
		if (accounts.includes(undefined) || unique.size !== accounts.length || unique.size < 2 || unique.size !== everyone.size) {
			return;
		}
		const agreement = this.env.GAMES[game]?.ranked_agreement ?? "majority";
		if (agreement === "host" && !isHost) {
			return;
		}
		const key = JSON.stringify(accounts);
		const results = (await this.ctx.storage.get<Record<string, string>>("results")) ?? {};
		results[sender.account_id] = key;
		await this.ctx.storage.put("results", results);
		const agreeing = Object.entries(results).filter(([account, result]) => result === key && everyone.has(account)).length;
		const needed = agreement === "host" ? 1 : agreement === "all" ? everyone.size : Math.floor(everyone.size / 2) + 1;
		if (agreeing < needed) {
			return;
		}
		await this.ctx.storage.put("reported", true);
		await recordResult(this.env, game, mode, accounts as string[]);
		for (const socket of this.ctx.getWebSockets()) {
			if (!(socket.deserializeAttachment() as Member).gone) {
				socket.send(JSON.stringify({ type: "result_recorded" }));
			}
		}
	}

	// A player's answer to a check. When everyone still in the lobby has answered, the majority's
	// value stands and anyone else disagreed.
	private async submitCheck(sender: Member, game: string, name: string, value: string): Promise<void> {
		if (!CHECK_NAME.test(name) || value.length === 0 || value.length > MAX_CHECK_VALUE) {
			return;
		}
		const checks = (await this.ctx.storage.get<Record<string, Check>>("checks")) ?? {};
		const check = checks[name] ?? (Object.keys(checks).length < MAX_CHECKS ? { values: {}, done: false } : null);
		if (!check || check.done || sender.account_id in check.values) {
			return;
		}
		check.values[sender.account_id] = value;
		checks[name] = check;
		await this.ctx.storage.put("checks", checks);
		await this.settleChecks(game);
	}

	// A player's game flags another's behaviour. Confirmed once more than half of the other
	// players, and at least two, flag the same player for the same reason within the window; then
	// it's handled like a failed check, once per player and reason in a lobby.
	private async flag(sender: Member, target: Member, game: string, reason: string): Promise<void> {
		if (!FLAG_REASON.test(reason) || sender.account_id === target.account_id) {
			return;
		}
		const time = Date.now();
		const flags = ((await this.ctx.storage.get<Flag[]>("flags")) ?? []).filter((flag) => time - flag.at <= FLAG_WINDOW_MS);
		const confirmed = (await this.ctx.storage.get<string[]>("confirmed_flags")) ?? [];
		const key = `${target.account_id}:${reason}`;
		if (confirmed.includes(key)) {
			return;
		}
		if (!flags.some((flag) => flag.target === target.account_id && flag.reason === reason && flag.by === sender.account_id)) {
			flags.push({ target: target.account_id, reason, by: sender.account_id, at: time });
		}
		await this.ctx.storage.put("flags", flags);

		const others = new Set(this.members().map((member) => member.account_id).filter((account) => account !== target.account_id));
		const flaggers = new Set(flags.filter((flag) => flag.target === target.account_id && flag.reason === reason && others.has(flag.by)).map((flag) => flag.by));
		if (flaggers.size < Math.max(2, Math.floor(others.size / 2) + 1)) {
			return;
		}
		confirmed.push(key);
		await this.ctx.storage.put("confirmed_flags", confirmed);
		await this.ctx.storage.put("contested", true);
		if (this.env.GAMES[game]?.report_failed_checks !== false) {
			await report(this.env, game, [...flaggers][0], target.account_id, "cheating", `Flagged by ${flaggers.size} other players: ${reason}.`, true);
		}
		this.broadcastAll({ type: "flagged", peer_id: target.peer_id, reason });
		if (this.env.GAMES[game]?.kick_cheaters) {
			await this.kickAccount(target.account_id);
		}
	}

	private async kickAccount(accountId: string): Promise<void> {
		for (const socket of this.ctx.getWebSockets()) {
			const member = socket.deserializeAttachment() as Member;
			if (member.account_id === accountId && !member.gone) {
				await this.kick(socket, member, true);
				await recordCheatKick(this.env, accountId, (await this.ctx.storage.get<string>("game")) ?? "");
				return;
			}
		}
	}

	// Settles every check everyone still here has answered (also when a player leaves).
	private async settleChecks(game: string): Promise<void> {
		const checks = (await this.ctx.storage.get<Record<string, Check>>("checks")) ?? {};
		const members = this.members();
		const accounts = [...new Set(members.map((member) => member.account_id))];
		let changed = false;
		for (const [name, check] of Object.entries(checks)) {
			if (check.done || accounts.length < 2 || !accounts.every((account) => account in check.values)) {
				continue;
			}
			check.done = true;
			changed = true;
			const counts = new Map<string, number>();
			for (const account of accounts) {
				counts.set(check.values[account], (counts.get(check.values[account]) ?? 0) + 1);
			}
			const [top, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
			const majority = topCount * 2 > accounts.length;
			const disagreeingAccounts = majority ? accounts.filter((account) => check.values[account] !== top) : [];
			const agreed = counts.size === 1;
			const disagreeing = members.filter((member) => disagreeingAccounts.includes(member.account_id)).map((member) => member.peer_id);
			if (!agreed) {
				await this.ctx.storage.put("contested", true);
			}
			if (disagreeingAccounts.length > 0 && this.env.GAMES[game]?.report_failed_checks !== false) {
				const reporter = accounts.find((account) => !disagreeingAccounts.includes(account))!;
				for (const account of disagreeingAccounts) {
					await report(this.env, game, reporter, account, "cheating", `Disagreed with the other players on the check "${name}".`, true);
				}
			}
			this.broadcastAll({ type: "check_result", name, agreed, disagreeing });
			if (this.env.GAMES[game]?.kick_cheaters) {
				for (const account of disagreeingAccounts) {
					await this.kickAccount(account);
				}
			}
		}
		if (changed) {
			await this.ctx.storage.put("checks", checks);
		}
	}

	async webSocketClose(socket: WebSocket): Promise<void> {
		await this.leave(socket);
	}

	async webSocketError(socket: WebSocket): Promise<void> {
		await this.leave(socket);
	}

	async alarm(): Promise<void> {
		if (this.ctx.getWebSockets().length === 0) {
			await this.ctx.storage.deleteAll();
		}
	}

	private async leave(socket: WebSocket): Promise<void> {
		const member = socket.deserializeAttachment() as Member;
		// The others drop this player's connections now anyway: their TURN credentials go too.
		if (member.turn_usernames?.length) {
			this.ctx.waitUntil(revokeCredentials(this.env, member.turn_usernames));
			member.turn_usernames = [];
			socket.serializeAttachment(member);
		}
		if (!member.gone && member.pending) {
			// Left while joining: the others never saw them.
			member.gone = true;
			socket.serializeAttachment(member);
		} else if (!member.gone) {
			member.gone = true;
			socket.serializeAttachment(member);
			this.broadcast({ type: "left", peer_id: member.peer_id }, socket);
			if (member.peer_id === 1) {
				await this.promoteHost();
			}
			// Checks waiting only on the player who left can settle now.
			await this.settleChecks((await this.ctx.storage.get<string>("game")) ?? "");
		}
		// The last one out clears the lobby.
		if (this.ctx.getWebSockets().filter((other) => other !== socket && !(other.deserializeAttachment() as Member).gone).length === 0) {
			await this.ctx.storage.deleteAll();
		}
	}

	// The host left: whoever has been here longest becomes peer 1 and the host.
	private async promoteHost(): Promise<void> {
		const remaining = this.ctx
			.getWebSockets()
			.filter((socket) => {
				const member = socket.deserializeAttachment() as Member;
				return !member.gone && !member.pending;
			})
			.sort((a, b) => (a.deserializeAttachment() as Member).joined_at - (b.deserializeAttachment() as Member).joined_at);
		if (remaining.length === 0) {
			return;
		}
		const next = remaining[0];
		const member = next.deserializeAttachment() as Member;
		const oldPeerId = member.peer_id;
		member.peer_id = 1;
		next.serializeAttachment(member);
		await this.ctx.storage.put("host", member.account_id);
		for (const socket of remaining) {
			socket.send(JSON.stringify({ type: "host_changed", old_peer_id: oldPeerId, you: socket === next }));
		}
	}

	// The players in the lobby, who see each other.
	private members(): Member[] {
		return this.seats().filter((member) => !member.pending);
	}

	// Everyone holding a place, players still joining too: what the lobby's limits count.
	private seats(): Member[] {
		return this.ctx
			.getWebSockets()
			.map((socket) => socket.deserializeAttachment() as Member)
			.filter((member) => !member.gone);
	}

	private socketOf(peerId: number): WebSocket | null {
		for (const socket of this.ctx.getWebSockets()) {
			const member = socket.deserializeAttachment() as Member;
			if (member.peer_id === peerId && !member.gone && !member.pending) {
				return socket;
			}
		}
		return null;
	}

	private newPeerId(isHost: boolean, members: Member[]): number {
		if (isHost && !members.some((member) => member.peer_id === 1)) {
			return 1;
		}
		let id: number;
		do {
			id = 2 + (crypto.getRandomValues(new Uint32Array(1))[0] % 0x7ffffffd);
		} while (members.some((member) => member.peer_id === id));
		return id;
	}

	private broadcastAll(message: unknown): void {
		const text = JSON.stringify(message);
		for (const socket of this.ctx.getWebSockets()) {
			const member = socket.deserializeAttachment() as Member;
			if (!member.gone && !member.pending) {
				socket.send(text);
			}
		}
	}

	private broadcast(message: unknown, except: WebSocket): void {
		const text = JSON.stringify(message);
		for (const socket of this.ctx.getWebSockets()) {
			const member = socket.deserializeAttachment() as Member;
			if (socket !== except && !member.gone && !member.pending) {
				socket.send(text);
			}
		}
	}
}

function publicMember(member: Member) {
	return { peer_id: member.peer_id, display_name: member.display_name };
}
