# Privacy and retention

The service never logs IP addresses, platform IDs or email addresses, and Worker logs are off (`observability` in `wrangler.jsonc`). Rate limiting uses Cloudflare's built-in limiter, which doesn't store addresses.

For each player, the service stores a random account ID, a display name, when the account was created and last used, a keyed hash of each platform identity (and of their email address, if they added one) and the labels and dates of devices that remember them. Once they've added an email, it stores their saves. While a code is waiting to be used, it keeps a keyed hash of the code. In games with ranked play, it keeps their rating in each mode. It also keeps the accounts a player has blocked, reports about a player (who reported them, the reason and the reporter's words) for 90 days, and when they were removed from lobbies for cheating, for `AUTO_BAN`'s window, with how many automatic bans they've had. With `MODERATION_EMAIL` set, a daily email to you lists reported players' names and account IDs, with how often and why they were reported; it doesn't include what reporters wrote. While a player waits for a match, the service holds Cloudflare's estimate of their city, to match them with nearby players; it isn't stored. For games that only play online for players who bought them, it keeps which games an account owns, on which store and when that was last checked, and a keyed hash of an App Store purchase's ID (or of a Steam ID whose ticket came with another account's sign-in) with the accounts it proved, for 30 days; never the player's Steam ID, Apple ID or Google account in the clear. It counts the TURN credentials each account gets in a day.

The service sees an email address only while handling the request that names it. The email provider that sends the code sees the address as well, and may keep it in its logs for a while: check how long your provider keeps them, and put that in your privacy policy. Legally, a keyed hash of an address still counts as personal data, because whoever holds the key can check whether a given address is in the database.

Crash reports, sent only by players who agreed to it, hold what the game ran on (the engine and game versions, the operating system, processor, memory and graphics card) and the end of its log. The engine replaces the player's home folder and removes anything shaped like an email or IP address before sending one, and the service removes them again. Nothing in a report says which player or account sent it.

A notice you can adapt for your game's privacy policy:

> **Online features.** When you play online, we keep a small account for you on our server so multiplayer works, and, if you add your email address, so your progress follows you to other platforms. We don't store your email address, password or your Steam, Game Center or Google Play Games ID. We store a random account number, the name you play under, when you last played, whether you bought the game and on which store (checked with that store when you play online), one-way codes made from your platform account and your email address (they can't be turned back into either), the names of devices that remember you as a guest, your rating in ranked modes, players you've blocked, reports other players made about you (for 90 days), and, if you've added your email address, your saved games.
>
> When you add or use your email address, we send it a sign-in code through [email provider], which keeps a record of the emails it sends for [period]. Until you add an email address, your saved games stay in your platform's own cloud, not with us.
>
> When you play online with others, your device connects directly to theirs, so the other players' devices can see your IP address (it isn't stored by us).
>
> If you choose to send crash reports, a report goes to our server when the game crashes: the versions of the game and its engine, your device's operating system, processor, memory and graphics card, and the game's last messages before it stopped. We remove email addresses, IP addresses and your user folder's name first, and nothing in it says who sent it. Reports are deleted after 90 days.
>
> Accounts are deleted after 2 years without play, and devices that remember you forget you after 90 days without play. You can delete your account and everything in it at any time from the game's settings. If your account is banned from multiplayer when you delete it, we keep the one-way codes made from your platform account and email address, with the ban's end, until the ban ends, so the ban still applies if you sign in again.

## Retention

| Data | Kept for |
|---|---|
| Accounts | Until the player deletes them, or 2 years unused |
| Device grants (remembered guests) | Lapse after 90 days unused |
| Guest tokens | The session, 12 hours at most |
| Saves set aside | 30 days, by the R2 lifecycle rule |
| Email codes | 10 minutes or 5 wrong tries; the row counting an address's codes for the day, a day |
| Lobbies | Until the last player leaves |
| Reports | 90 days |
| Crash reports | 90 days; a crash nobody has had for 90 days goes with them |
| Removals for cheating | `AUTO_BAN`'s window (30 days) |
| A deleted account's ban | Until the ban ends: its identities' keyed hashes and the ban's end, so signing in again doesn't start clean |
| Ratings and blocks | As long as the account |
| Ownership of a game | 30 days after it was last shown (checked again at sign-in) |
| Which accounts a purchase proved | 30 days |
| Play Integrity challenges used | Until they expire (10 minutes) |
| TURN credentials an account got today | A day |

A daily Cron Trigger deletes unused accounts (with their saves), lapsed grants, spent codes and old reports and crash reports, then sends the moderation email if `MODERATION_EMAIL` is set.
