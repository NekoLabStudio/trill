// Ratings for ranked modes: Elo, starting at 1000, updated from a matchmade lobby's result. A
// result ranks the players from first to last; each pair counts as a game between the two, and
// each player's change is the average over the players they met, so a lobby of eight moves
// ratings about as much as a lobby of two.

import type { Env } from "./env";

export const START_RATING = 1000;
const K = 32;

export async function ratingOf(env: Env, accountId: string, game: string, mode: string): Promise<{ rating: number; matches: number }> {
	const row = await env.DB.prepare("SELECT rating, matches FROM ratings WHERE account_id = ? AND game = ? AND mode = ?")
		.bind(accountId, game, mode)
		.first<{ rating: number; matches: number }>();
	return row ?? { rating: START_RATING, matches: 0 };
}

// The new ratings for players ranked first to last, from their current ones.
export function eloChanges(ratings: number[]): number[] {
	const changes = ratings.map(() => 0);
	const others = ratings.length - 1;
	for (let i = 0; i < ratings.length; i++) {
		for (let j = i + 1; j < ratings.length; j++) {
			const expected = 1 / (1 + 10 ** ((ratings[j] - ratings[i]) / 400));
			const change = (K * (1 - expected)) / others;
			changes[i] += change;
			changes[j] -= change;
		}
	}
	return changes;
}

export async function recordResult(env: Env, game: string, mode: string, ranking: string[]): Promise<void> {
	const current = await Promise.all(ranking.map((accountId) => ratingOf(env, accountId, game, mode)));
	const changes = eloChanges(current.map((entry) => entry.rating));
	await env.DB.batch(
		ranking.map((accountId, index) =>
			env.DB.prepare(
				`INSERT INTO ratings (account_id, game, mode, rating, matches) VALUES (?1, ?2, ?3, ?4, 1)
				 ON CONFLICT (account_id, game, mode) DO UPDATE SET rating = rating + ?5, matches = matches + 1`,
			).bind(accountId, game, mode, START_RATING + changes[index], changes[index]),
		),
	);
}
