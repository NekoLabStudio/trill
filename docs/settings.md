# Settings

Change an instance's settings from its folder:

```sh
npm run configure
```

This shows a menu of what you can change: your games and their sign-ins (Steam, Game Center, Play Games), email, TURN, moderation, how long data is kept, save and rate limits, and rotating the identity secret. Each question shows the current value, which Enter keeps. Secrets are never shown, only whether they're set. Nothing changes until you confirm the summary at the end; then it writes `wrangler.jsonc`, stores the secrets and offers to deploy. `npm run configure -- --dry-run` shows what it would change without changing it.

You can also edit `wrangler.jsonc` yourself and deploy with `npx wrangler deploy`. Every setting is listed below.

## The instance's settings

All in `vars` in `wrangler.jsonc`:

| Setting | Default | Meaning |
|---|---|---|
| `EMAIL_DRIVER` | `cloudflare` | How codes are emailed (see [Email](email.md)) |
| `EMAIL_FROM` | | The sender of those emails, `"Name <address>"` |
| `INACTIVE_ACCOUNT_DAYS` | 730 | Accounts unused this long are deleted, with their saves |
| `AUTO_BAN` | 3 removals in 30 days; 1, 7, 30 days, then for good | Automatic bans for players removed for cheating (see [Moderation](moderation.md#automatic-bans)) |
| `REPORT_RULES` | Off | Automatic bans and renames once enough players report someone (see [Moderation](moderation.md#acting-on-reports-automatically)) |
| `MODERATION_EMAIL` | Off | Where the daily list of reported players goes (see [Moderation](moderation.md#a-daily-email)) |
| `DEVICE_GRANT_DAYS` | 90 | A device that remembers a guest forgets them after this long unused |
| `GUEST_TOKEN_HOURS` | 12 | How long a brought profile lasts on the host's device |
| `SESSION_DAYS` | 30 | How long a sign-in lasts before the game signs in again |
| `MAX_SAVE_BYTES` | 1048576 | The largest save (1 MB); a game can set its own `max_save_bytes` in `GAMES` |
| `MAX_SAVE_SLOTS` | 8 | Saves per player in each game; a game can set its own `max_save_slots` |
| `MAX_CRASH_REPORT_BYTES_PER_DAY` | 2000000 | Crash reports kept in full for each game a day, in bytes (2 MB; see [Crash reports](crash-reports.md)) |
| `TURN_DAILY_CREDENTIALS` | 48 | TURN credentials one account can get a day (see [TURN](turn.md)) |

## Each game's settings

Each game in `GAMES` can also have a `name`, used in the emails; `min_version` and `max_version`, the game versions that may play online (compared with the version each game sends; without them, every version can); `ranked_agreement`, how many players must report the same result before ratings change (`"majority"`, `"all"` or `"host"`); `report_failed_checks`, `false` to stop reporting players who fail a [check or a flag](https://oss.nekolab.studio/purr/api/checks/); `kick_cheaters`, `true` to remove them from the lobby too; `turn_needs_platform`, `false` to give TURN to every signed-in player rather than only those a platform signed in (see [TURN](turn.md)); `crash_reports`, `false` to turn [crash reports](crash-reports.md) away; and for [Ownership](ownership.md), `check_ownership`, `other_stores`, `test_builds`, `extra_steam_app_ids` and `play_package`. `device_accounts` (`false` to turn away players without a platform sign-in) still works but is going: `check_ownership` with `other_stores` `false` keeps out accounts that didn't buy the game, however they sign in.
