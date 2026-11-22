# Ownership

A game can let only players who bought it play online: saves synced to the service, lobbies, matchmaking and TURN. Turn it on with the game's `check_ownership`. New games set up with `npm run setup` or `npm run configure` start with it on; games you already have keep it off until you turn it on.

The service checks it at every sign-in, from the copy of the game the player signs in from, whichever way they sign in (email included):

- **Steam**: Steam's ticket, checked with `CheckAppOwnership` using `STEAM_WEB_API_KEY`. Family Sharing and free weekends count, as Steam lets those players play. A Playtest's app ID can be listed in `extra_steam_app_ids`; remove it when the playtest ends, since owning the Playtest counts as owning the game.
- **App Store**: StoreKit's AppTransaction, which Apple signs. It needs nothing more than the game's `bundle_ids`. Copies signed for testing ("Sandbox": TestFlight, and builds for testing on a device) count unless `test_builds` is `false`. Once the game is out and nobody needs to test online, set it to `false`.
- **Google Play**: a Play Integrity token, which Google decodes for you, for one sign-in only. Set the game's `play_package` (its Android package name), link a Google Cloud project to the game in the Play Console, turn on the Play Integrity API there, create a service account in that project, and give its JSON key to the service as `PLAY_INTEGRITY_SERVICE_ACCOUNT`. There's one such key for the whole service, so the games it checks on Google Play need to share a Google Cloud project.

One App Store purchase, or one Steam account's tickets brought to other accounts' sign-ins, proves at most five accounts, so a shared proof can't open the game to everyone.

A store that says the player doesn't own the game turns them away (`not_owned`, which a Purr game hears as `Account.not_owned`). What happens to a player whose copy can't say depends on where the game is sold, which `other_stores` tells the service:

- **Also sold elsewhere** (itch.io, GOG, a DRM-free build; `other_stores` `true`, the default): they're let in, since their copy can't be told apart from one bought there.
- **Only on Steam, the App Store and Google Play** (`other_stores` `false`): every account must show it owns the game, whichever way it signs in, and accounts that can't are turned away before one is even made for them.

The service keeps only that an account owns the game, where that was shown and when: no Steam IDs, Apple IDs or Google accounts, and an App Store purchase's ID (or a Steam ID whose ticket came with another account's sign-in) only as a keyed hash. Ownership is checked again at the first sign-in a day or more later, so refunds count from then. If a store can't be reached, or a copy can't show it, a proof from the last 7 days still counts, so an outage locks nobody out.
