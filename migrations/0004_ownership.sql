-- Ownership: which accounts have shown they own a game (ownership.ts), for games that only play
-- online for players who bought them. Only where it was proven and when: no platform IDs.
CREATE TABLE ownership (
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	game TEXT NOT NULL,
	source TEXT NOT NULL CHECK (source IN ('steam', 'app_store', 'google_play')),
	checked_at INTEGER NOT NULL,
	PRIMARY KEY (account_id, game)
);
CREATE INDEX ownership_by_time ON ownership (checked_at);

-- The accounts one purchase proved, by a keyed hash of the App Store download's ID (or of a Steam
-- ID whose ticket came with another account's sign-in), so one purchase can't prove any number of
-- accounts. Kept for 30 days.
CREATE TABLE ownership_proofs (
	proof_hash TEXT NOT NULL,
	game TEXT NOT NULL,
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	seen_at INTEGER NOT NULL,
	PRIMARY KEY (proof_hash, game, account_id)
);
CREATE INDEX ownership_proofs_by_time ON ownership_proofs (seen_at);

-- Play Integrity challenges already used (each proves one sign-in), until they expire.
CREATE TABLE ownership_challenges (
	id TEXT PRIMARY KEY,
	expires_at INTEGER NOT NULL
);

-- TURN credentials given to each account today, against TURN_DAILY_CREDENTIALS.
CREATE TABLE turn_credentials (
	account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
	day_started_at INTEGER NOT NULL,
	issued INTEGER NOT NULL DEFAULT 0
);
