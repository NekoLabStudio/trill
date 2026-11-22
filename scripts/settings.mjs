// An instance's settings (wrangler.jsonc) and secrets: the questions that change them, shared by
// setup and configure, and the edits that make the changes while keeping the file's comments.
// Secrets are never read back, only their names: a question about one says whether it's set.

import { applyEdits, modify, parse } from "jsonc-parser";
import { ask, confirm, isScripted, say } from "./cli.mjs";

const FORMAT = { formattingOptions: { insertSpaces: false, tabSize: 1, eol: "\n" } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SEND_EMAIL_COMMENT = /\t\/\/ Cloudflare's Email Sending, for EMAIL_DRIVER "cloudflare"[^\n]*\n\t\/\/[^\n]*\n/;

function show(value) {
	if (value === undefined) {
		return "removed";
	}
	if (Array.isArray(value) && value.every((each) => typeof each !== "object" || each === null)) {
		return value.map((each) => (each === null ? "forever" : String(each))).join(", ");
	}
	return typeof value === "string" ? value : JSON.stringify(value);
}

function setIn(target, path, value) {
	for (const key of path.slice(0, -1)) {
		if (target[key] === null || typeof target[key] !== "object") {
			target[key] = typeof key === "number" ? [] : {};
		}
		target = target[key];
	}
	const last = path.at(-1);
	if (value !== undefined) {
		target[last] = structuredClone(value);
	} else if (Array.isArray(target)) {
		target.splice(last, 1);
	} else {
		delete target[last];
	}
}

// Edits to make to wrangler.jsonc, and secrets to set or remove, gathered as the questions are
// answered and only made once they're all confirmed.
export class Changes {
	constructor(text, secretNames = []) {
		this.original = text;
		this.config = parse(text);
		this.have = new Set(secretNames);
		this.edits = [];
		this.secrets = {};
		this.dropped = new Set();
		// Set by rotating the identity secret: shown once it's saved, and the change needs deploying.
		this.newIdentitySecret = "";
	}

	get(path) {
		return path.reduce((value, key) => value?.[key], this.config);
	}

	set(path, value, label) {
		if (same(this.get(path), value)) {
			return;
		}
		this.edits.push({ path, value, label });
		setIn(this.config, path, value);
	}

	hasSecret(name) {
		return name in this.secrets || (this.have.has(name) && !this.dropped.has(name));
	}

	setSecret(name, value) {
		this.secrets[name] = value;
		this.dropped.delete(name);
	}

	dropSecret(name) {
		delete this.secrets[name];
		if (this.have.has(name)) {
			this.dropped.add(name);
		}
	}

	get settingsChanged() {
		return this.summary().some((line) => !line.startsWith("Secret "));
	}

	get any() {
		return this.summary().length > 0;
	}

	// One line per change that's still a change once every answer is in.
	summary() {
		const original = parse(this.original);
		const lines = new Map();
		for (const edit of this.edits) {
			const key = JSON.stringify(edit.path);
			const now = this.get(edit.path);
			lines.delete(key);
			const was = edit.path.reduce((value, part) => value?.[part], original);
			if (!same(was, now)) {
				// Something new with its own settings (a game) is just "added": they follow.
				const added = was === undefined && now && typeof now === "object" && !Array.isArray(now);
				lines.set(key, `${edit.label}: ${added ? "added" : show(now)}`);
			}
		}
		return [
			...lines.values(),
			...Object.keys(this.secrets).map((name) => `Secret ${name}: ${this.have.has(name) ? "replaced" : "set"}`),
			...[...this.dropped].map((name) => `Secret ${name}: removed`),
		];
	}

	text() {
		let out = this.original;
		for (const edit of this.edits) {
			out = applyEdits(out, modify(out, edit.path, edit.value, FORMAT));
		}
		// Cloudflare's email binding is explained by a comment; it goes with the binding.
		return parse(out).send_email === undefined ? out.replace(SEND_EMAIL_COMMENT, "") : out;
	}
}

// Questions. Each shows the current value, which Enter keeps; "-" clears a value with a default.

function text(key, question, current = "") {
	const answer = ask(key, question, current);
	return answer === "-" ? "" : answer;
}

function invalid(message) {
	if (isScripted) {
		throw new Error(message);
	}
	say(message);
}

function number(key, question, current, { min = 0 } = {}) {
	for (;;) {
		const answer = text(key, question, current === undefined ? "" : String(current));
		if (answer === "") {
			return undefined;
		}
		if (/^\d+$/.test(answer) && Number(answer) >= min) {
			return Number(answer);
		}
		invalid(`That needs to be a whole number${min > 0 ? ` of at least ${min}` : ""}.`);
	}
}

function list(key, question, current = []) {
	return text(key, question, current.join(", "))
		.split(",")
		.map((each) => each.trim())
		.filter(Boolean);
}

// Ban lengths in days, from the first ban to the last (which repeats); "forever" is null.
function banDays(key, question, current) {
	for (;;) {
		const answer = list(key, question, (current ?? []).map((days) => (days === null ? "forever" : String(days))));
		if (answer.length > 0 && answer.every((each) => each === "forever" || /^\d+$/.test(each))) {
			return answer.map((each) => (each === "forever" ? null : Number(each)));
		}
		invalid('Give the lengths in days, from the first ban, such as "1, 7, 30, forever".');
	}
}

function choice(key, question, options, current) {
	for (;;) {
		const answer = text(key, `${question} (${options.join(", ")})`, current).toLowerCase();
		const match = options.find((option) => option.startsWith(answer) && answer !== "");
		if (match) {
			return match;
		}
		invalid(`Choose one of: ${options.join(", ")}.`);
	}
}

function secret(changes, name, key, question) {
	const answer = ask(key, `${question}${changes.hasSecret(name) ? " (set; Enter keeps it)" : " (empty to add later)"}`);
	if (answer) {
		changes.setSecret(name, answer);
	}
}

export function slug(textValue) {
	return textValue.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

// Games.

const GAME_DEFAULTS = { ranked_agreement: "majority", report_failed_checks: true, kick_cheaters: false, device_accounts: true, turn_needs_platform: true, check_ownership: false, other_stores: true, test_builds: true };
const REPORT_REASONS = ["cheating", "abuse", "name", "other"];

export function editGame(changes, id, { more = true } = {}) {
	const games = ["vars", "GAMES"];
	const isNew = !changes.get([...games, id]);
	if (isNew) {
		changes.set([...games, id], {}, id);
	}
	const game = () => changes.get([...games, id]) ?? {};
	const setting = (key, label, value) => {
		const empty = value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
		changes.set([...games, id, key], empty || same(value, GAME_DEFAULTS[key]) ? undefined : value, `${id}: ${label}`);
	};

	setting("name", "name", text("game_name", `${id}: its name, for emails`, game().name ?? id));
	setting("steam_app_id", "Steam App ID", number("steam_app_id", `${id}: Steam App ID (empty if not on Steam)`, game().steam_app_id, { min: 1 }));
	if (game().steam_app_id) {
		secret(changes, "STEAM_WEB_API_KEY", "steam_web_api_key", "Steam publisher Web API key, for Steam sign-in");
	}
	setting("bundle_ids", "Apple bundle IDs", list("bundle_ids", `${id}: Apple bundle IDs for Game Center, comma-separated (empty if none)`, game().bundle_ids));
	const playGames = confirm("play_games", `${id}: Google Play Games sign-in?`, Boolean(game().play_games));
	setting("play_games", "Play Games sign-in", playGames || undefined);
	if (playGames && (!changes.hasSecret("PLAY_GAMES_CLIENTS") || confirm("play_games_change", "Change the Play Games OAuth clients?", false))) {
		playGamesClients(changes);
	}

	// Only players who bought the game play online: new games start with it on. Who has to show
	// it depends on where the game is sold.
	const checking = confirm("check_ownership", `${id}: only let players who bought the game play online?`, game().check_ownership ?? isNew);
	setting("check_ownership", "only players who bought it play online", checking);
	if (checking) {
		const onPlatforms = Boolean(game().steam_app_id || game().bundle_ids?.length || game().play_games);
		const onlyThere = confirm("only_stores", `${id}: is it only sold on Steam, the App Store and Google Play (not itch.io, GOG or a DRM-free build)?`, game().other_stores === undefined ? onPlatforms : game().other_stores === false);
		setting("other_stores", "also sold where purchases can't be checked", !onlyThere);
		if (playGames) {
			setting("play_package", "Android package name", text("play_package", `${id}: its Android package name, for checking Google Play purchases`, game().play_package ?? ""));
			secret(changes, "PLAY_INTEGRITY_SERVICE_ACCOUNT", "play_integrity_service_account", "The JSON key of a service account in the Google Cloud project linked to the game, with the Play Integrity API on (one line)");
		}
	}

	if (!more || !confirm("game_more", `${id}: change its other settings (versions, save limits, ranked play, checks, test builds, TURN)?`, false)) {
		return;
	}
	setting("min_version", "oldest version that plays online", text("min_version", `${id}: the oldest game version that may play online (empty for any)`, game().min_version));
	setting("max_version", "newest version that plays online", text("max_version", `${id}: the newest game version that may play online (empty for any)`, game().max_version));
	setting("max_save_bytes", "largest save", number("max_save_bytes", `${id}: the largest save, in bytes (empty for the instance's limit)`, game().max_save_bytes, { min: 1 }));
	setting("max_save_slots", "save slots", number("max_save_slots", `${id}: save slots per player (empty for the instance's limit)`, game().max_save_slots, { min: 1 }));
	setting("ranked_agreement", "ranked results agreed by", choice("ranked_agreement", `${id}: whose reports make a ranked result count`, ["majority", "all", "host"], game().ranked_agreement ?? "majority"));
	setting("report_failed_checks", "report failed checks", confirm("report_failed_checks", `${id}: report players who fail a check or are flagged?`, game().report_failed_checks ?? true));
	setting("kick_cheaters", "remove cheaters", confirm("kick_cheaters", `${id}: also remove them from the lobby?`, game().kick_cheaters ?? false));
	if (game().steam_app_id) {
		setting("extra_steam_app_ids", "other Steam app IDs that count as owning it", list("extra_steam_app_ids", `${id}: other Steam app IDs whose players count as owning it, such as a Playtest (comma-separated, empty if none)`, (game().extra_steam_app_ids ?? []).map(String)).map(Number).filter((each) => Number.isInteger(each) && each > 0));
	}
	if (game().check_ownership) {
		setting("test_builds", "test builds count as owning it", confirm("test_builds", `${id}: let test builds (TestFlight) play online as if bought?`, game().test_builds ?? true));
	}
	setting("turn_needs_platform", "TURN only for platform players", confirm("turn_needs_platform", `${id}: TURN only for players signed in through Steam, Game Center or Play Games?`, game().turn_needs_platform ?? true));
}

// Play Games' OAuth clients are one secret for every game, which can't be read back, so each
// Play Games game's is asked for whenever one changes.
function playGamesClients(changes) {
	say("Play Games' OAuth web clients (from the Google Cloud project linked in the Play Console) are kept together: enter each Play Games game's.");
	const clients = {};
	for (const [id, game] of Object.entries(changes.get(["vars", "GAMES"]) ?? {})) {
		if (game.play_games) {
			const clientId = ask("play_games_client_id", `${id}: OAuth web client ID`);
			const clientSecret = ask("play_games_client_secret", `${id}: its client secret`);
			if (clientId && clientSecret) {
				clients[id] = { client_id: clientId, client_secret: clientSecret };
			}
		}
	}
	if (Object.keys(clients).length > 0) {
		changes.setSecret("PLAY_GAMES_CLIENTS", JSON.stringify(clients));
	}
}

export function editGames(changes) {
	for (;;) {
		say();
		say(`Games: ${Object.keys(changes.get(["vars", "GAMES"]) ?? {}).join(", ") || "none"}`);
		const answer = ask("game", "A game's ID to change or add, -ID to remove one, or Enter when done");
		if (!answer) {
			return;
		}
		const id = slug(answer.replace(/^-/, ""));
		if (!id) {
			continue;
		}
		if (answer.startsWith("-")) {
			if (changes.get(["vars", "GAMES", id]) && confirm("remove_game", `Remove ${id}? Its players can't sign in or play online until it's back`, false)) {
				changes.set(["vars", "GAMES", id], undefined, `${id}`);
			}
		} else {
			editGame(changes, id);
		}
	}
}

// Email.

export function editEmail(changes, fromFallback = "") {
	say();
	say("Email: sign-in codes go out through Cloudflare's Email Sending (needs Workers Paid and your");
	say("domain onboarded in Cloudflare) or SMTP2GO (an API key from your SMTP2GO account).");
	const driver = choice("email_driver", "Send emails with", ["cloudflare", "smtp2go"], changes.get(["vars", "EMAIL_DRIVER"]) ?? "cloudflare");
	changes.set(["vars", "EMAIL_DRIVER"], driver, "Email sent with");
	const current = changes.get(["vars", "EMAIL_FROM"]);
	const from = text("email_from", 'Send emails from ("Name <address>")', current && !current.includes("example.com") ? current : fromFallback || current);
	changes.set(["vars", "EMAIL_FROM"], from, "Emails from");
	if (driver === "smtp2go") {
		secret(changes, "SMTP2GO_API_KEY", "smtp2go_api_key", "SMTP2GO API key");
		changes.set(["send_email"], undefined, "Cloudflare's email binding");
	} else {
		changes.set(["send_email"], [{ name: "EMAIL" }], "Cloudflare's email binding");
		changes.dropSecret("SMTP2GO_API_KEY");
	}
}

// TURN.

export function editTurn(changes) {
	say();
	say("TURN relays players who can't connect directly. Cloudflare's TURN service needs a key from");
	say("Realtime in the Cloudflare dashboard; your own servers are a list of RTCIceServer objects. Without");
	say("TURN, players only get Cloudflare's STUN server.");
	const current = changes.hasSecret("TURN_KEY_ID") ? "cloudflare" : changes.hasSecret("TURN_SERVERS") ? "own" : "none";
	const kind = choice("turn", "TURN", ["cloudflare", "own", "none"], current);
	if (kind === "cloudflare") {
		secret(changes, "TURN_KEY_ID", "turn_key_id", "Cloudflare TURN key ID");
		secret(changes, "TURN_KEY_API_TOKEN", "turn_key_api_token", "Cloudflare TURN key API token");
		changes.dropSecret("TURN_SERVERS");
		changes.dropSecret("TURN_SECRET");
	} else if (kind === "own") {
		for (;;) {
			const answer = ask("turn_servers", `Your TURN servers, as a JSON array${changes.hasSecret("TURN_SERVERS") ? " (set; Enter keeps it)" : ""}`);
			if (!answer) {
				break;
			}
			try {
				if (Array.isArray(JSON.parse(answer))) {
					changes.setSecret("TURN_SERVERS", answer);
					break;
				}
			} catch {
				// Asked again below.
			}
			invalid('That needs to be a JSON array, such as [{"urls": "turn:turn.example.com:3478", "username": "u", "credential": "c"}].');
		}
		say("With coturn's shared secret (use-auth-secret), each player gets credentials of their own that end");
		say("after a few hours, instead of the fixed ones in that list.");
		secret(changes, "TURN_SECRET", "turn_secret", "coturn's shared secret");
		changes.dropSecret("TURN_KEY_ID");
		changes.dropSecret("TURN_KEY_API_TOKEN");
	} else {
		for (const name of ["TURN_KEY_ID", "TURN_KEY_API_TOKEN", "TURN_SERVERS", "TURN_SECRET"]) {
			changes.dropSecret(name);
		}
	}
}

// Moderation.

function reportRule(changes, kind, defaults) {
	const current = changes.get(["vars", "REPORT_RULES", kind]);
	const question = kind === "ban" ? "Ban players from multiplayer after enough reports?" : "Reset players' names after enough reports?";
	if (!confirm(`report_${kind}`, question, Boolean(current))) {
		return undefined;
	}
	const rule = { ...defaults, ...current };
	let reasons;
	for (;;) {
		reasons = list(`report_${kind}_reasons`, `  Which reasons count (${REPORT_REASONS.join(", ")})`, rule.reasons);
		if (reasons.length > 0 && reasons.every((reason) => REPORT_REASONS.includes(reason))) {
			break;
		}
		invalid(`Choose from: ${REPORT_REASONS.join(", ")}.`);
	}
	const result = {
		reasons,
		reporters: number(`report_${kind}_reporters`, "  From how many different players", rule.reporters, { min: 1 }) ?? defaults.reporters,
		within_days: number(`report_${kind}_within_days`, "  Within how many days", rule.within_days, { min: 1 }) ?? defaults.within_days,
		min_reporter_age_days: number(`report_${kind}_min_age`, "  Reporters' accounts at least this many days old", rule.min_reporter_age_days) ?? defaults.min_reporter_age_days,
	};
	if (kind === "ban") {
		result.ban_days = banDays("report_ban_days", "  Ban lengths in days, first ban first (forever for good)", rule.ban_days);
	}
	return result;
}

export function editModeration(changes) {
	say();
	const autoBan = changes.get(["vars", "AUTO_BAN"]);
	if (confirm("auto_ban", "Automatically ban players repeatedly removed for cheating (in games that remove cheaters)?", Boolean(autoBan))) {
		const current = autoBan ?? { kicks: 3, within_days: 30, ban_days: [1, 7, 30, null] };
		changes.set(
			["vars", "AUTO_BAN"],
			{
				kicks: number("auto_ban_kicks", "  After how many removals", current.kicks, { min: 1 }) ?? current.kicks,
				within_days: number("auto_ban_within_days", "  Within how many days", current.within_days, { min: 1 }) ?? current.within_days,
				ban_days: banDays("auto_ban_days", "  Ban lengths in days, first ban first (forever for good)", current.ban_days),
			},
			"Automatic bans",
		);
	} else {
		changes.set(["vars", "AUTO_BAN"], undefined, "Automatic bans");
	}
	const ban = reportRule(changes, "ban", { reasons: ["cheating", "abuse"], reporters: 5, within_days: 7, min_reporter_age_days: 7, ban_days: [1, 7, 30, null] });
	const rename = reportRule(changes, "rename", { reasons: ["name"], reporters: 3, within_days: 7, min_reporter_age_days: 7 });
	const rules = { ...(ban ? { ban } : {}), ...(rename ? { rename } : {}) };
	changes.set(["vars", "REPORT_RULES"], Object.keys(rules).length > 0 ? rules : undefined, "Action on reports");
	const email = text("moderation_email", "Email a daily list of reported players to (empty for none)", changes.get(["vars", "MODERATION_EMAIL"]) ?? "");
	changes.set(["vars", "MODERATION_EMAIL"], email || undefined, "Moderation email to");
}

// Retention and limits.

const NUMBERS = [
	["INACTIVE_ACCOUNT_DAYS", "inactive_account_days", "Delete accounts unused for this many days"],
	["DEVICE_GRANT_DAYS", "device_grant_days", "Forget a remembered guest on a device after this many days unused"],
	["GUEST_TOKEN_HOURS", "guest_token_hours", "A guest's session on someone else's device lasts this many hours"],
	["SESSION_DAYS", "session_days", "A signed-in session lasts this many days"],
	["MAX_SAVE_BYTES", "max_save_bytes_default", "The largest save, in bytes, for games without their own limit"],
	["MAX_SAVE_SLOTS", "max_save_slots_default", "Save slots per player, for games without their own limit"],
];

export function editRetention(changes) {
	say();
	for (const [name, key, question] of NUMBERS) {
		const value = number(key, question, changes.get(["vars", name]), { min: 1 });
		if (value !== undefined) {
			changes.set(["vars", name], value, question);
		}
	}
}

const RATE_LIMITS = {
	SIGNUP_LIMITER: "New device accounts a minute, per connection",
	AUTH_LIMITER: "Platform sign-ins a minute, per connection",
	EMAIL_LIMITER: "Email codes sent a minute, per connection",
	VERIFY_LIMITER: "Email codes checked a minute, per connection",
	SAVE_LIMITER: "Saves read and written a minute, per account and per connection",
	LOBBY_LIMITER: "Lobbies created or joined a minute, per account",
};

export function editRateLimits(changes) {
	say();
	(changes.get(["ratelimits"]) ?? []).forEach((limiter, index) => {
		const question = RATE_LIMITS[limiter.name] ?? `${limiter.name}, a minute`;
		const value = number(`rate_${limiter.name.toLowerCase()}`, question, limiter.simple?.limit, { min: 1 });
		if (value !== undefined) {
			changes.set(["ratelimits", index, "simple", "limit"], value, question);
		}
	});
}

// Updates: what a release's wrangler.jsonc adds or changes, applied to the instance's own.

// Entries of these lists are told apart by these keys (a rate limiter's name, a migration's tag).
const ENTRY_KEYS = ["name", "binding", "tag"];
// The instance's own: never touched by an update.
const OWN = [/^name$/, /^vars\.(GAMES|EMAIL_DRIVER|EMAIL_FROM|MODERATION_EMAIL|IDENTITY_KEY_VERSION|REPORT_RULES)$/, /^send_email/, /^d1_databases\[binding=DB\]/, /^r2_buckets\[binding=SAVES\]/];
// New resources a release might need: created by hand, so only mentioned.
const RESOURCES = /^(d1_databases|r2_buckets|kv_namespaces|queues|hyperdrive)/;

function entryKey(array) {
	return ENTRY_KEYS.find((key) => array.length > 0 && array.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry[key] === "string"));
}

const pathName = (path) => path.map((part, index) => (typeof part === "object" ? `[${part.key}=${part.id}]` : index > 0 ? `.${part}` : part)).join("");

// Every setting as path => value: objects are walked into, a list of named entries gives each
// entry, and anything else is one value.
function settings(value, path = [], out = new Map()) {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const [key, each] of Object.entries(value)) {
			settings(each, [...path, key], out);
		}
	} else if (Array.isArray(value) && entryKey(value)) {
		const key = entryKey(value);
		for (const entry of value) {
			const entryPath = [...path, { key, id: entry[key] }];
			out.set(pathName(entryPath), { path: entryPath, value: entry });
		}
	} else if (path.length > 0) {
		out.set(pathName(path), { path, value });
	}
	return out;
}

// The edit for one setting in the instance's file: in place where it is, or added.
function edit(text, path, value) {
	const config = parse(text);
	const concrete = [];
	let at = config;
	for (const part of path) {
		if (typeof part !== "object") {
			concrete.push(part);
			at = at?.[part];
			continue;
		}
		const index = Array.isArray(at) ? at.findIndex((entry) => entry?.[part.key] === part.id) : -1;
		if (index >= 0) {
			concrete.push(index);
			at = at[index];
		} else if (Array.isArray(at)) {
			return applyEdits(text, modify(text, [...concrete, at.length], value, { ...FORMAT, isArrayInsertion: true }));
		} else {
			return applyEdits(text, modify(text, concrete, [value], FORMAT));
		}
	}
	return applyEdits(text, modify(text, concrete, value, FORMAT));
}

// before and after are the releases' own files (the last one and the new one). New settings are
// added, defaults the instance never changed follow the release, and anything else is listed.
export function mergeRelease(instanceText, beforeText, afterText) {
	const own = (name) => OWN.some((pattern) => pattern.test(name));
	const instance = settings(parse(instanceText));
	const before = settings(parse(beforeText));
	const after = settings(parse(afterText));
	const report = { added: [], updated: [], kept: [], unused: [], resources: [] };
	let text = instanceText;
	for (const [name, { path, value }] of after) {
		if (own(name)) {
			continue;
		}
		const mine = instance.get(name);
		const old = before.get(name);
		if (!mine) {
			if (old) {
				continue; // Taken out of this instance on purpose.
			}
			if (RESOURCES.test(name)) {
				report.resources.push(name);
				continue;
			}
			text = edit(text, path, value);
			report.added.push(`${name}: ${show(value)}`);
		} else if (same(mine.value, value)) {
			continue;
		} else if (old && same(mine.value, old.value)) {
			text = edit(text, path, value);
			report.updated.push(`${name}: ${show(old.value)} to ${show(value)}`);
		} else if (old && !same(old.value, value)) {
			report.kept.push(`${name}: yours is ${show(mine.value)}; the release's default changed from ${show(old.value)} to ${show(value)}`);
		}
	}
	for (const name of before.keys()) {
		if (!after.has(name) && instance.has(name) && !own(name)) {
			report.unused.push(name);
		}
	}
	return { text, ...report };
}
