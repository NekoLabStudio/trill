# Protocol

Every request and response body is JSON unless said otherwise. Clients send `X-Trill-Game` (the game's ID) and `X-Game-Version` (its version) with every request; a version outside the game's `min_version` and `max_version` gets 426 `update_required` (too old, or no version) or `version_unsupported` (too new), with both limits. Every response has `X-Trill-Protocol`, and `GET /version` returns `{"version", "protocol"}`: the protocol goes up when a change means older clients can't talk to the service. Errors look like `{"error": "version_conflict", "message": "..."}`, with the HTTP status saying what kind of failure it is. Authenticated requests send `Authorization: Bearer <token>`.

There are three kinds of token:

- **Session tokens** come from signing in. They can do everything, and last `SESSION_DAYS`.
- **Guest tokens** come from a guest bringing their profile to someone else's device. They can only load and save, and last `GUEST_TOKEN_HOURS`.
- **Device grants** (starting `g_`) are kept by a host device for a remembered guest. They can only load and save, and can be revoked.

## Signing in

Each returns `{"account_id", "display_name", "created", "providers", "token", "expires_at"}`. `providers` lists the account's identities (`"steam"`, `"email"`, ...); an account with `"email"` keeps its saves on the service. An unknown identity gets a new account; a known one gets its account back. `display_name` is optional everywhere.

| Request | Body |
|---|---|
| `POST /auth/device` | `{"game", "secret"}`: at least 32 random characters the device keeps, for platforms with no sign-in. 403 `device_accounts_off` if the game turned device accounts off |
| `POST /auth/steam` | `{"game", "ticket"}`: the ticket from `GetAuthTicketForWebApi("trill")`, as hex |
| `POST /auth/game_center` | `{"game", "public_key_url", "signature", "salt", "timestamp", "team_player_id", "bundle_id"}`: what `fetchItems(forIdentityVerificationSignature:)` returned (signature and salt as base64, timestamp in milliseconds) |
| `POST /auth/play_games` | `{"game", "server_auth_code"}`: a server auth code for the game's web client |

Every sign-in can also send `ownership`, the copy's proof of purchase, for games that only play online for players who bought them (the game's `check_ownership`): `{"steam_ticket"}` (a ticket as for `/auth/steam`), `{"app_transaction"}` (StoreKit's AppTransaction, as its JWS) or `{"play_integrity", "challenge"}` (a Play Integrity token from a standard request whose `requestHash` is the challenge; each challenge proves one sign-in). Steam's sign-in needs none: its ticket is the proof. A player who doesn't own the game, or whose copy can't show it where the game is only sold on Steam, the App Store and Google Play, gets 403 `not_owned`. `GET /ownership/challenge?game=<game>` returns `{"challenge"}`, valid for 10 minutes.

Game Center identities use `teamPlayerID`, so one identity covers all of a developer team's games. Google Play Games identities use the game-scoped player ID, which Google recommends because the developer-wide key changes if a game moves to another developer account. A player's Play Games identity is therefore separate for each game.

## Email

1. `POST /auth/email/start` with `{"email", "game"}` emails a 6-digit code, valid for 10 minutes, and returns `{"sent": true, "challenge", "expires_at"}`. Keep the challenge: only the device that asked can use the code. It answers the same whether or not the address has an account. An address gets a new code at most once a minute and 8 times a day (429 `rate_limited` otherwise), and a new code doesn't cancel an earlier one. `400 bad_email` means it isn't a plain address.
2. `POST /auth/email/verify` with `{"email", "challenge", "code", "game"}` (and `ownership`, as for the sign-ins) uses the code up. A code allows 5 tries, and an address 40 a day; `400 wrong_code` covers wrong, used and expired codes alike. What it does depends on who asks:
   - **Signed out:** signs in to the address's account, or makes one (with `display_name`, optionally). Returns the same as the platform sign-ins.
   - **With a session for an account without an email:** adds the address. If the address already has an account, the caller's account joins it: its platform identities and remembered-guest grants move over, and its old token stops working. Returns the sign-in fields plus `"merged"`; keep the new `token`. The caller's account never kept saves on the service, so the game offers the choice between this device's saves and the account's.
   - **With a session for an account that has an email:** changes it. Send `current_email` too; 403 `wrong_current_email` if it doesn't match, 409 `email_in_use` if the new address already belongs to another account. Every other session the account has ends; keep the new `token`.

Guest tokens and device grants can't add or change an address. Codes for signing in and codes for a guest (below) are different: each only works for its own purpose, and the emails say which is which.

## The account

- `GET /account`: `{"id", "display_name", "created_at", "last_seen_at", "providers", "scope"}`.
- `DELETE /account`: deletes the account, its identities, its device grants and all its saves.

## Saves

Saves are kept per account, game and slot (lowercase letters, digits, `-` and `_`), and only for accounts with an email address: the others get 403 `email_required` and use their platform's cloud. Each save has a version. A write names the version it replaces, and is refused if another device saved since, so nothing is overwritten silently. The last two versions are kept as backups. Each game has a size and slot limit (413 `save_too_large`, 409 `too_many_slots`), and an account can read and write 60 times a minute.

- `GET /saves/<game>`: `{"saves": [{"game", "slot", "version", "summary", "size", "saved_at"}]}`
- `GET /saves/<game>/<slot>`: the save's bytes, with `X-Save-Version` and `X-Save-Summary` headers. 404 if the slot is empty.
- `PUT /saves/<game>/<slot>`: the save's bytes as the body (with `Content-Length`; 411 without), `X-Save-Version` as the version it replaces (`0` for an empty slot), and optionally `X-Save-Summary` (JSON, up to 1 KB, such as `{"level": 4, "playtime": 7200, "last_played": 1731600000}`, shown when the player has to choose between two saves). Returns `{"version"}`, or 409 `version_conflict` with `current_version`.

## Local players

Player 1 is the device's own signed-in account. Other local players are guests.

- **Plain guests and local profiles** need nothing from the service: a plain guest's progress lives in player 1's save, and a local profile (a guest remembered on this device) keeps its saves with player 1's.
- **Bringing your profile:** the guest types their address on the host's device, which calls `POST /guest/email/start` with the host's session and `{"email", "game"}` (the same answer as above), then `POST /guest/email/verify` with the host's session and `{"email", "challenge", "code", "game", "remember", "device_label", "display_name"}`. The guest's code can't sign in to their account, only bring their profile. It returns `{"account_id", "display_name", "kind", "token"}`: a guest token (`"kind": "guest"`), or with `"remember": true` a device grant (`"kind": "grant"`). An address without an account gets a new one, named `display_name`. A local profile adding an email does the same, with `"remember": true`, then uploads its saves.
- **Forgetting:** `DELETE /grants/current` with a device grant as the token forgets that guest on this device.
- **Devices that remember you**, on the player's own device: `GET /grants` lists them and `DELETE /grants/<id>` revokes one.

Guest tokens and device grants can only load and save, and only the game they were given for: they can't add or change an email, see or change the account, delete it or use lobbies.

## Lobbies

- `POST /lobbies` with `{"game"}` returns `{"code", "max_members"}`. The creator is the host. A banned account gets 403 `banned`, here and when joining.
- `GET /lobbies/<code>/socket?game=<game>&renews=1`, as a WebSocket with the `Authorization` header (a full session), joins it. `renews=1` says the game renews its TURN credentials (see `renew_ice`), and gets ones for 4 hours; without it, 12. Up to 8 players, each account at most twice; a lobby of another game is "not found". A socket sending more than 200 messages in 10 seconds is closed.

The lobby only relays WebRTC signalling for Godot's `WebRTCMultiplayerPeer`; gameplay goes peer to peer, or through TURN. Messages are JSON text:

| Message | Direction |
|---|---|
| `{"type": "welcome", "peer_id", "members": [{"peer_id", "display_name"}], "ranked", "ice_servers", "ice_expires_in"}` | to a player as they join. The host is peer 1. `ranked` is true for a lobby made by matchmaking. `ice_servers` is the `RTCIceServer` list for the player's WebRTC connections: STUN, plus TURN credentials when the service has TURN and the player signed in through Steam, Game Center or Play Games, or showed they own the game (or the game's `turn_needs_platform` is `false`). `ice_expires_in` is how many seconds the credentials last, or 0 when they don't end. A player's credentials are revoked when they leave. |
| `{"type": "renew_ice"}` | from a player whose credentials are ending (at most every 30 minutes): they get `{"type": "ice_servers", "ice_servers", "ice_expires_in"}` with new ones |
| `{"type": "joined", "peer_id", "display_name"}` and `{"type": "left", "peer_id"}` | to everyone else |
| `{"type": "signal", "to", "data"}` | from a player: an offer, answer or ICE candidate for another peer |
| `{"type": "signal", "from", "data"}` | relayed to that peer |
| `{"type": "kick", "peer_id"}` | from the host: removes that player, who gets `{"type": "kicked"}` and can't rejoin this lobby |
| `{"type": "report", "peer_id", "reason", "details"}` | from a player: a report for the operator (`reason` is `cheating`, `abuse`, `name` or `other`) |
| `{"type": "block", "peer_id"}` | from a player: never match them with that player again, or let that player into lobbies they host |
| `{"type": "result", "ranking"}` | from each player, in a ranked lobby: every player's peer ID from first to last. Recorded once enough players sent the same ranking (the game's `ranked_agreement`), then everyone gets `{"type": "result_recorded"}`. |
| `{"type": "check", "name", "value"}` | from each player: their value (a hash) for a check. Once everyone in the lobby has sent one, everyone gets `{"type": "check_result", "name", "agreed", "disagreeing": [peer IDs]}`, naming players who differ from the majority. They're reported as cheating unless the game's `report_failed_checks` is `false`, removed (closed with code 4001) if its `kick_cheaters` is `true`, and in a ranked lobby the result no longer counts. |
| `{"type": "flag", "peer_id", "reason"}` | from a player: their game judged another player's behaviour impossible. When more than half of the other players, and at least two, flag the same player for the same reason within 10 seconds, everyone gets `{"type": "flagged", "peer_id", "reason"}`, handled like a failed check |
| `{"type": "host_changed", "old_peer_id", "you"}` | to everyone when the host leaves: the player who had `old_peer_id`, the one in the lobby longest, is now peer 1 and the host |

The service doesn't read `data`. Purr's lobbies send `{"type": "offer" or "answer", "sdp"}` and `{"candidate": {"media", "index", "name"}}`, and every player connects only to the host.

The lobby clears itself when the last player leaves, or after 10 minutes if nobody joins. A platform invite (a Steam invite, for example) can carry the code.

## Matchmaking and ratings

- `GET /matchmaking/<game>/<mode>/socket?players=<n>`, as a WebSocket with a full session, waits for a match of `n` players (2 to 8) in a ranked mode (a name the game picks, made of lowercase letters, digits, `-` and `_`). It sends `{"type": "waiting", "players"}`, then `{"type": "matched", "code"}` with a new ranked lobby to join, and closes. Players are matched within a rating range and a distance (from Cloudflare's estimate of where each connection comes from) that both widen as they wait, nearest first, and never with someone either of them blocked. Whoever waited longest hosts.
- `GET /ratings/<game>/<mode>` returns the player's `{"rating", "matches"}` in that mode. Ratings start at 1000 and change by Elo with each recorded result.

## Crash reports

- `POST /crash-reports` with `{"game", "report"}` and any token (the game's version comes from `X-Game-Version`) returns `{"received": true}`. The report is text, 64 KB at most (413 `too_large`). A game whose `crash_reports` is `false` gets 403 `crash_reports_off`. Each account sends at most 5 a minute (429 `rate_limited`); who sent a report isn't kept.
