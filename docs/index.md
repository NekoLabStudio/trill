# Trill

Trill is online services for games: player accounts, cloud saves, progress across platforms by email, lobbies, matchmaking and ratings, moderation and crash reports. It stores no email addresses, passwords or raw platform IDs.

Players sign in through their platform (Steam, Game Center, Google Play Games, or a device account) without seeing an account at all. To bring their progress to another platform, they add their email address: Trill emails them a 6-digit code, and every platform signed in with that address shares one account. Until then, their saves stay in the platform's own cloud and Trill keeps none.

You run your own instance, on your own Cloudflare account. It's a Cloudflare Worker, with D1 for its database, R2 for saves and Durable Objects for lobbies, so there are no servers to look after. Small games fit the Workers Free plan with the `smtp2go` email driver; Cloudflare's own email sending needs Workers Paid. The relays players use when they can't connect directly ([TURN](turn.md)) are the one part billed by the gigabyte.

[Purr](https://oss.nekolab.studio/purr/) uses Trill out of the box. Other engines can talk to it through its [protocol](protocol.md), which is plain HTTP, JSON and WebSocket.

To set up an instance and connect a game to it, start with [Getting started](getting-started.md).
