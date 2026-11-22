# TURN

When two players can't connect directly (behind strict firewalls, or when a game connects only through a relay, as Purr's `lobbies/relay_only` does), their connection goes through a TURN relay. With `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` set, players get credentials for Cloudflare's TURN service (create a TURN key under Realtime in the Cloudflare dashboard) as they join a lobby; with `TURN_SERVERS`, your own servers. With neither, players get only Cloudflare's STUN server, which helps them find a direct route but can't relay.

TURN is the one part of the service that costs you by the gigabyte, so it's guarded:

- Only players in a lobby get credentials, and by default only those a platform has verified (signed in through Steam, Game Center or Play Games) or who showed they own the game (see [Ownership](ownership.md)). Nobody can make accounts in bulk to relay their own traffic on your bill. Other players get STUN and connect directly where they can. A game with many such players (one on Apple TV without Game Center, say) can give TURN to everyone with `turn_needs_platform` set to `false`.
- Credentials last 4 hours. Before they end, the game asks its lobby for new ones and moves its relayed connections onto them without a break, so long sessions carry on. Clients that don't renew them (they don't send `renews=1` when joining; see the [protocol](protocol.md#lobbies)) get credentials for 12 hours.
- Cloudflare's credentials are revoked as soon as their player leaves the lobby, so credentials taken out of the game stop working when the player stops playing.
- Each account gets at most `TURN_DAILY_CREDENTIALS` sets a day (48 unless set); past that, STUN only.

Your own servers' credentials in `TURN_SERVERS` are fixed and never end, so anyone who has been in a lobby once can keep using them. With coturn, set `TURN_SECRET` to its shared secret (`use-auth-secret` and `static-auth-secret` in coturn's settings), and each player gets credentials of their own that end after 4 hours instead. coturn has no way to revoke them sooner.
