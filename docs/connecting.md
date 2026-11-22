# Connecting a game

Every game an instance serves is listed under `GAMES` in its `wrangler.jsonc`, by an ID of your choosing: `npm run configure` adds and changes them. Games send that ID with every request, and saves, ratings and settings are kept per game. One instance can serve several games, and players keep one account across them.

## With Purr

Set two things in the game's Project Settings:

- `trill/url`: your instance's address, such as `https://trill.example.workers.dev`.
- `trill/game`: the game's ID in `GAMES`.

`Account`, `Saves`, `Lobbies` and the rest then use Trill whenever the player is signed in to it, and fall back to each platform on their own when they aren't. [Purr's docs](https://oss.nekolab.studio/purr/online/) cover the game's side.

## Platform sign-ins

Device accounts work without anything more. Each platform's sign-in needs the game's details on your instance, which `npm run configure` asks for:

| Platform | What the instance needs |
|---|---|
| Steam | The game's `steam_app_id`, and the `STEAM_WEB_API_KEY` secret: a publisher Web API key from Steamworks |
| Game Center | The game's `bundle_ids`, every bundle ID it ships under (iOS, macOS and Apple TV builds can differ) |
| Google Play Games | `play_games` `true` for the game, and its OAuth web client in the `PLAY_GAMES_CLIENTS` secret (see [Secrets](secrets.md)) |

A Steam account and a Game Center player (by their team ID) are the same player in every one of your games. Play Games player IDs are per game, so a player is a different Play Games player in each.

## Versions

Games send their version with every request. A game can set `min_version` and `max_version` in `GAMES`; a version outside them is turned away with `update_required`, and the game can ask the player to update (see [Settings](settings.md)).

Each response says which version of Trill's protocol the instance speaks (`X-Trill-Protocol`). A client built for a newer protocol stops online play for the session when the instance is older, and the instance needs `npm run update`.

## Other engines

The [protocol](protocol.md) is everything a client needs: signing in, saves, lobbies over WebSocket, matchmaking, moderation and crash reports. It's plain HTTP and JSON, so any engine with an HTTP client and WebSockets can use Trill.
