-- Accounts hold no email addresses, passwords or raw platform IDs: an identity (a platform
-- account, a device or an email address) is only ever stored as an HMAC of "provider:id"
-- (identities.identity_hash).

CREATE TABLE accounts (
	id TEXT PRIMARY KEY,
	display_name TEXT NOT NULL DEFAULT '',
	-- 1 once the player chose their name: platform sign-ins no longer replace it.
	name_chosen INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	-- Updated at most once a day.
	last_seen_at INTEGER NOT NULL,
	-- In every session token; raising it ends every session the account has.
	session_epoch INTEGER NOT NULL DEFAULT 0,
	-- Banned from multiplayer (lobbies and matchmaking) until this time; 0 if not.
	banned_until INTEGER NOT NULL DEFAULT 0,
	-- How many automatic bans the account has had, which sets the length of the next.
	auto_bans INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE identities (
	identity_hash TEXT PRIMARY KEY,
	key_version INTEGER NOT NULL,
	provider TEXT NOT NULL,
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE
);
CREATE INDEX identities_by_account ON identities (account_id);

-- Long-lived tokens a host device holds for a remembered guest, for one game's saves.
CREATE TABLE device_grants (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	game TEXT NOT NULL,
	device_label TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER NOT NULL
);
CREATE INDEX device_grants_by_account ON device_grants (account_id);

-- The slots an account has saves in, so the slot limit holds even for writes at the same moment.
CREATE TABLE save_slots (
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	game TEXT NOT NULL,
	slot TEXT NOT NULL,
	PRIMARY KEY (account_id, game, slot)
);

-- Codes emailed to prove an address, one row per code (a new one doesn't cancel the last).
-- Only HMACs are stored: of the challenge the client holds, of the code, and the address's
-- identity hash. "purpose" keeps a code for signing in apart from one for a guest on someone
-- else's device.
CREATE TABLE email_codes (
	challenge_hash TEXT PRIMARY KEY,
	email_hash TEXT NOT NULL,
	purpose TEXT NOT NULL CHECK (purpose IN ('sign_in', 'guest')),
	code_hash TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	expires_at INTEGER NOT NULL
);
CREATE INDEX email_codes_by_address ON email_codes (email_hash);

-- Per address and day: codes sent and codes tried, which cap flooding and guessing.
CREATE TABLE email_limits (
	email_hash TEXT PRIMARY KEY,
	day_started_at INTEGER NOT NULL,
	last_sent_at INTEGER NOT NULL,
	codes_today INTEGER NOT NULL DEFAULT 0,
	tries_today INTEGER NOT NULL DEFAULT 0
);

-- A player reporting another they played with (cheating, abuse...), for the operator to review.
-- Kept for 90 days. automatic: made by a lobby's anti-cheat rather than a player (never counted
-- by REPORT_RULES). actioned: already counted towards an automatic ban or rename.
CREATE TABLE reports (
	id TEXT PRIMARY KEY,
	game TEXT NOT NULL,
	reporter_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	reported_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	reason TEXT NOT NULL CHECK (reason IN ('cheating', 'abuse', 'name', 'other')),
	details TEXT NOT NULL DEFAULT '',
	automatic INTEGER NOT NULL DEFAULT 0,
	actioned INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);
CREATE INDEX reports_by_reported ON reports (reported_id, created_at);
CREATE INDEX reports_by_time ON reports (created_at);

-- Players a player never wants to be matched with or joined by.
CREATE TABLE blocks (
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	blocked_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (account_id, blocked_id)
);
CREATE INDEX blocks_by_blocked ON blocks (blocked_id);

-- A player's rating in one game's ranked mode (Elo, starting at 1000), from the results of
-- matchmade lobbies.
CREATE TABLE ratings (
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	game TEXT NOT NULL,
	mode TEXT NOT NULL,
	rating REAL NOT NULL DEFAULT 1000,
	matches INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (account_id, game, mode)
);

-- Times a lobby removed the player for cheating (a failed check or a confirmed flag), counted
-- towards an automatic ban (AUTO_BAN). Kept for AUTO_BAN's window.
CREATE TABLE cheat_kicks (
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	game TEXT NOT NULL,
	at INTEGER NOT NULL
);
CREATE INDEX cheat_kicks_by_account ON cheat_kicks (account_id, at);
