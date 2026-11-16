// The daily email to the operator, with MODERATION_EMAIL set: the players reported in the last
// day, with how many reports, from how many players and why. It leaves out what reporters wrote
// (it could hold anything); `npm run moderate` shows that. No reports, no email.

import type { Env } from "./env";
import { sendEmail } from "./email";
import { renderEmail } from "./email_templates";
import { DAY, now } from "./time";

const MAX_LISTED = 50;

interface ReportedPlayer {
	id: string;
	name: string;
	reports: number;
	reporters: number;
	reasons: string;
	automatic: number;
}

export async function sendModerationDigest(env: Env): Promise<boolean> {
	if (!env.MODERATION_EMAIL) {
		return false;
	}
	const rows = await env.DB.prepare(
		`SELECT reports.reported_id AS id, accounts.display_name AS name, COUNT(*) AS reports,
		        COUNT(DISTINCT reports.reporter_id) AS reporters, group_concat(DISTINCT reports.reason) AS reasons,
		        SUM(reports.automatic) AS automatic
		 FROM reports JOIN accounts ON accounts.id = reports.reported_id
		 WHERE reports.created_at > ? GROUP BY reports.reported_id
		 ORDER BY reporters DESC, reports DESC LIMIT ?`,
	)
		.bind(now() - DAY, MAX_LISTED + 1)
		.all<ReportedPlayer>();
	const players = rows.results;
	if (players.length === 0) {
		return false;
	}
	const lines = players.slice(0, MAX_LISTED).map((player) => {
		const from = player.reporters === 1 ? "1 player" : `${player.reporters} players`;
		const counts = `${player.reports === 1 ? "1 report" : `${player.reports} reports`} from ${from}`;
		const automatic = player.automatic > 0 ? `, ${player.automatic} by the anti-cheat` : "";
		return `${player.name || "(no name)"} (${player.id}): ${counts}${automatic}; ${player.reasons.split(",").join(", ")}`;
	});
	if (players.length > MAX_LISTED) {
		lines.push("...and more.");
	}
	const listed = Math.min(players.length, MAX_LISTED);
	const values = { game: "Moderation", count: players.length > MAX_LISTED ? `${MAX_LISTED}+` : String(listed), players: lines.join("\n") };
	await sendEmail(env, { to: env.MODERATION_EMAIL, ...(await renderEmail("moderation", "", values)) });
	return true;
}
