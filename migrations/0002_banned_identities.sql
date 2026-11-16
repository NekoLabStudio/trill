-- A banned player deleting their account and signing in again would otherwise start clean. While
-- the ban lasts, the deleted account's identities are kept here, as the same keyed hashes as
-- identities.identity_hash (nothing readable), with the ban's end and the count of automatic
-- bans; an account that signs in with one of them takes the ban back. Rows go once the ban ends.
CREATE TABLE banned_identities (
	identity_hash TEXT PRIMARY KEY,
	banned_until INTEGER NOT NULL,
	auto_bans INTEGER NOT NULL DEFAULT 0
);
