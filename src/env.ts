import type { Lobby } from "./lobby";
import type { Matchmaker } from "./matchmaker";

export interface GameSettings {
	// The game's name in emails; the game's ID if it's missing.
	name?: string;
	steam_app_id?: number;
	bundle_ids?: string[];
	play_games?: boolean;
	// This game's save limits, if not the service's defaults (MAX_SAVE_BYTES, MAX_SAVE_SLOTS).
	max_save_bytes?: number;
	max_save_slots?: number;
	// How many players in a ranked lobby must report the same result before ratings change:
	// "majority" (the default, more than half), "all", or "host" (the host's alone).
	ranked_agreement?: "majority" | "all" | "host";
	// Whether players who disagree with the majority on a check, or whom the others flag, are
	// reported as cheating (true unless set to false).
	report_failed_checks?: boolean;
	// The game versions that may play online (application/config/version); either can be left out,
	// and without both every version can.
	min_version?: string;
	max_version?: string;
	// Whether those players are also removed from the lobby, as if the host kicked them (false
	// unless set to true).
	kick_cheaters?: boolean;
	// Whether players without a platform sign-in get an account for their device (true unless set
	// to false). A game that only ships where Steam, Game Center or Play Games signs players in can
	// turn them off, so nobody can make accounts for it with a single request.
	device_accounts?: boolean;
	// Whether only players signed in through Steam, Game Center or Play Games get TURN credentials
	// (true unless set to false). Those sign-ins are verified by the platform, so nobody can make
	// accounts in bulk to relay their own traffic on the operator's bill; other players get STUN
	// and connect directly where they can.
	turn_needs_platform?: boolean;
}

export interface Env {
	DB: D1Database;
	SAVES: R2Bucket;
	LOBBIES: DurableObjectNamespace<Lobby>;
	MATCHMAKERS: DurableObjectNamespace<Matchmaker>;
	EMAIL?: SendEmail;
	SIGNUP_LIMITER: RateLimit;
	AUTH_LIMITER: RateLimit;
	EMAIL_LIMITER: RateLimit;
	VERIFY_LIMITER: RateLimit;
	SAVE_LIMITER: RateLimit;
	LOBBY_LIMITER: RateLimit;

	GAMES: Record<string, GameSettings>;
	// Automatic bans: this many removals for cheating within within_days ban the player from
	// multiplayer, for ban_days[n] days on their nth ban (the last repeats; null is forever).
	AUTO_BAN?: { kicks: number; within_days: number; ban_days: (number | null)[] };
	// Automatic action on players' reports: reports with these reasons from this many different
	// players (each with an account at least min_reporter_age_days old) within within_days ban the
	// player (ban_days, as AUTO_BAN's) or reset their display name. Each rule is optional.
	REPORT_RULES?: { ban?: ReportRule & { ban_days: (number | null)[] }; rename?: ReportRule };
	EMAIL_DRIVER: string;
	EMAIL_FROM: string;
	// Where the daily list of reported players goes; no list without it.
	MODERATION_EMAIL?: string;
	SMTP2GO_API_URL?: string;
	INACTIVE_ACCOUNT_DAYS: number;
	DEVICE_GRANT_DAYS: number;
	GUEST_TOKEN_HOURS: number;
	SESSION_DAYS: number;
	MAX_SAVE_BYTES: number;
	MAX_SAVE_SLOTS: number;
	IDENTITY_KEY_VERSION: number;

	// Secrets.
	IDENTITY_SECRET: string;
	IDENTITY_SECRET_PREVIOUS?: string;
	SESSION_SECRET: string;
	STEAM_WEB_API_KEY?: string;
	PLAY_GAMES_CLIENTS?: string;
	SMTP2GO_API_KEY?: string;
	TURN_KEY_ID?: string;
	TURN_KEY_API_TOKEN?: string;
	TURN_SERVERS?: string;
}

export interface ReportRule {
	reasons: string[];
	reporters: number;
	within_days: number;
	min_reporter_age_days?: number;
}
