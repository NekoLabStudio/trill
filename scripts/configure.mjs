// Fills in wrangler.jsonc for one instance of the online services: its name, database, bucket,
// games and email. It edits the known keys in place, so the file keeps its comments. Used by
// setup.mjs; tested in test/setup.test.ts.

// A JSON value written the way wrangler.jsonc writes it (one line).
const json = (value) => JSON.stringify(value).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{"/, '{ "').replace(/\}$/, " }").replace(/\{ \}/g, "{}");

function replaceOnce(text, pattern, replacement, what) {
	if (!pattern.test(text)) {
		throw new Error(`wrangler.jsonc doesn't have ${what} where setup expects it.`);
	}
	return text.replace(pattern, replacement);
}

// config: { name, databaseId, games: { id: { name, steam_app_id?, bundle_ids?, play_games? } },
//           emailDriver: "cloudflare" | "smtp2go", emailFrom }
export function configure(text, config) {
	let out = text;
	out = replaceOnce(out, /^(\t"name": )"[^"]*"/m, `$1"${config.name}"`, "the Worker's name");
	out = replaceOnce(out, /("database_name": )"[^"]*"/, `$1"${config.name}"`, "the database's name");
	out = replaceOnce(out, /("database_id": )"[^"]*"/, `$1"${config.databaseId}"`, "the database's ID");
	out = replaceOnce(out, /("bucket_name": )"[^"]*"/, `$1"${config.name}-saves"`, "the saves bucket");
	out = replaceOnce(out, /^(\t\t"GAMES": ).*,$/m, `$1${json(config.games)},`, "GAMES");
	out = replaceOnce(out, /^(\t\t"EMAIL_DRIVER": )"[^"]*"/m, `$1"${config.emailDriver}"`, "EMAIL_DRIVER");
	out = replaceOnce(out, /^(\t\t"EMAIL_FROM": )"[^"]*"/m, `$1${JSON.stringify(config.emailFrom)}`, "EMAIL_FROM");
	if (config.emailDriver !== "cloudflare") {
		// Without Cloudflare's email, the send_email binding (and its comment) would only get in
		// the way on the Free plan.
		out = replaceOnce(out, /\t\/\/ Cloudflare's Email Sending, for EMAIL_DRIVER "cloudflare"[^\n]*\n\t\/\/[^\n]*\n\t"send_email": \[[^\n]*\],\n/, "", "the send_email binding");
	}
	return out;
}
