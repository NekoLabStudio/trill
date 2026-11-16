// The emails' wording and look, from the files in email-templates/: <name>.txt (a "Subject:"
// line, a blank line, then the plain-text body) and <name>.html (the HTML body, placed in
// layout.html). Placeholders: {{code}}, {{game}} and {{minutes}} in sign_in and guest; {{count}}
// and {{players}} in moderation (the operator's daily list, not for one game); {{subject}} and
// {{content}} in the layout.
//
// To make them your own, put files with the same names in email-templates/custom/ (or
// email-templates/custom/<game>/ for one game). They're used instead of the defaults, one file
// at a time, so updates to the defaults never clash with yours.
//
// This file sits at the top of src/ because the templates are uploaded beside the bundled Worker
// (find_additional_modules in wrangler.jsonc) and imported relative to it.

export interface Rendered {
	subject: string;
	text: string;
	html: string;
}

// A template module by path. The path is a plain variable on purpose: the bundler leaves the
// import alone, and the runtime finds the file among the uploaded templates.
function importTemplate(path: string): Promise<{ default: string }> {
	const specifier = `./email-templates/${path}`;
	return import(/* @vite-ignore */ specifier);
}

async function load(game: string, name: string): Promise<string> {
	for (const path of game ? [`custom/${game}/${name}`, `custom/${name}`] : [`custom/${name}`]) {
		try {
			return (await importTemplate(path)).default;
		} catch {
			// Not overridden: try the next.
		}
	}
	return (await importTemplate(name)).default;
}

function fill(template: string, values: Record<string, string>, escape: boolean): string {
	return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
		if (!(key in values)) {
			return match;
		}
		return escape ? escapeHtml(values[key]) : values[key];
	});
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export async function renderEmail(name: string, gameId: string, values: Record<string, string>): Promise<Rendered> {
	const text = await load(gameId, `${name}.txt`);
	const match = /^Subject:[ \t]*(.*)\r?\n\r?\n?([\s\S]*)$/.exec(text);
	if (!match) {
		throw new Error(`email-templates/${name}.txt must start with a "Subject:" line.`);
	}
	// A subject is one line, whatever the values hold.
	const subject = fill(match[1], values, false).replace(/[\r\n]+/g, " ").trim();
	const content = fill(await load(gameId, `${name}.html`), values, true);
	const html = fill(fill(await load(gameId, "layout.html"), { ...values, subject }, true), { content }, false);
	return { subject, text: fill(match[2], values, false).trim() + "\n", html };
}
