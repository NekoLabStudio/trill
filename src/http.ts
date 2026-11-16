// JSON responses and errors. Every error is {"error": "<code>", "message": "<for developers>"}.

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly extra: Record<string, unknown> = {},
	) {
		super(message);
	}
}

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function errorResponse(error: HttpError): Response {
	return json({ error: error.code, message: error.message, ...error.extra }, error.status);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
	try {
		const body = await request.json();
		if (body && typeof body === "object" && !Array.isArray(body)) {
			return body as Record<string, unknown>;
		}
	} catch {
		// Falls through to the error below.
	}
	throw new HttpError(400, "bad_request", "The body must be a JSON object.");
}

export function requireString(body: Record<string, unknown>, key: string, maxLength = 4096): string {
	const value = body[key];
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
		throw new HttpError(400, "bad_request", `"${key}" must be a string of 1 to ${maxLength} characters.`);
	}
	return value;
}

export function optionalString(body: Record<string, unknown>, key: string, maxLength: number): string {
	const value = body[key];
	if (value === undefined || value === null) {
		return "";
	}
	if (typeof value !== "string" || value.length > maxLength) {
		throw new HttpError(400, "bad_request", `"${key}" must be a string of at most ${maxLength} characters.`);
	}
	return value;
}
