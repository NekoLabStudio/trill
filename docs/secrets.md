# Secrets

Secrets are kept by Cloudflare, never in `wrangler.jsonc`. `npm run setup` generates the two every instance needs and `npm run configure` sets the rest; by hand, `npx wrangler secret put <NAME>` asks for each value. Secrets are never shown again once set.

| Secret | For |
|---|---|
| `IDENTITY_SECRET` | Keying the hashes of email addresses and platform IDs (see below). Required |
| `SESSION_SECRET` | Signing sign-in tokens and keying email codes (see below). Required |
| `SMTP2GO_API_KEY` | Sending codes through SMTP2GO (`EMAIL_DRIVER` `smtp2go`) |
| `STEAM_WEB_API_KEY` | Steam sign-in, and checking Steam players own the game: a publisher Web API key from Steamworks |
| `PLAY_GAMES_CLIENTS` | Google Play Games sign-in: JSON, `{"<game>": {"client_id": "...", "client_secret": "..."}}`, each game's OAuth web client |
| `PLAY_INTEGRITY_SERVICE_ACCOUNT` | Checking Google Play players own the game: the JSON key of a service account (see [Ownership](ownership.md)) |
| `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` | Cloudflare's TURN service, from Realtime in the dashboard (see [TURN](turn.md)) |
| `TURN_SERVERS` | Or your own TURN servers: a JSON array of `RTCIceServer` objects |
| `TURN_SECRET` | With your own coturn servers, their shared secret (`use-auth-secret`), so each player gets credentials of their own |

## Identity secret

Email addresses and platform IDs are only stored as an HMAC made with `IDENTITY_SECRET`. **If you lose it, no existing player can be matched to their account again.** Keep a copy somewhere safe.

To replace it, use Rotate the identity secret in `npm run configure`. It asks for the current secret and checks it against an email address you have an account with, so a mistyped one can't lose your players. Then it keeps the current one as `IDENTITY_SECRET_PREVIOUS`, makes a new `IDENTITY_SECRET`, raises `IDENTITY_KEY_VERSION`, deploys and shows the new secret to keep. Each player is matched under the old secret the next time they sign in and saved again under the new one. It won't rotate again while players are still waiting to move from the last rotation.

## Session secret

`SESSION_SECRET` signs sign-in tokens and keys the email codes. Replacing it signs everyone out (games sign in again on their own) and voids codes waiting to be used; nothing else is lost. Replace it straight away if it may have leaked.
