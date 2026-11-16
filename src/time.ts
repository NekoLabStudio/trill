export const DAY = 86400;

// Unix time in seconds.
export function now(): number {
	return Math.floor(Date.now() / 1000);
}
