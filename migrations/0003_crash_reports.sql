-- Crash reports games send from players who agreed to it. Nothing says who sent one: no account,
-- no address. Reports with the same signature (the top of the backtrace) are one crash, counted
-- here; the newest few of each keep their text in crash_reports. Both go after 90 days.
CREATE TABLE crash_groups (
	game TEXT NOT NULL,
	signature TEXT NOT NULL,
	title TEXT NOT NULL,
	count INTEGER NOT NULL DEFAULT 0,
	first_version TEXT NOT NULL DEFAULT '',
	last_version TEXT NOT NULL DEFAULT '',
	first_seen_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL,
	PRIMARY KEY (game, signature)
);
CREATE INDEX crash_groups_by_time ON crash_groups (last_seen_at);

CREATE TABLE crash_reports (
	id TEXT PRIMARY KEY,
	game TEXT NOT NULL,
	signature TEXT NOT NULL,
	version TEXT NOT NULL DEFAULT '',
	report TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX crash_reports_by_signature ON crash_reports (game, signature, created_at);
CREATE INDEX crash_reports_by_time ON crash_reports (game, created_at);
