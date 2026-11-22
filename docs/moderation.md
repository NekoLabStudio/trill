# Moderation

Players can report and block each other from a lobby (in Purr, see [Lobbies](https://oss.nekolab.studio/purr/api/lobbies/#removing-reporting-and-blocking-players)). Reports wait in the service's database for you to review, and you can ban players from playing online. You review and act with `npm run moderate`, from your online services' folder. It works on the deployed database through Wrangler, signed in to your Cloudflare account.

## Reviewing reports

```sh
npm run moderate
```

This lists the players reported in the last 90 days, most reporters first: their name, account ID, how many reports from how many players, the reasons and the latest date. Pick one by number to read their reports, with each reporter's name and words, then choose what to do:

- `ban` keeps the player out of multiplayer for a number of days, or `forever`
- `unban` lifts a ban
- `rename` clears their name (see below)
- `dismiss` deletes the reports about them, which takes them off the list

After a ban or a rename, it offers to dismiss the reports too.

The same actions work as commands, for when you already know the account:

```sh
npm run moderate -- show <account ID>
npm run moderate -- find <name>
npm run moderate -- ban <account ID> 30
npm run moderate -- ban <account ID> forever
npm run moderate -- unban <account ID>
npm run moderate -- rename <account ID>
npm run moderate -- dismiss <account ID>
```

Players are identified by their account ID, a random identifier. `find` looks an account up by the name a player gave you. Reports are deleted after 90 days whether you review them or not. Add `--local` to any of these to work on the database of `npm run dev` instead.

A banned player can't create, join or matchmake into lobbies until the ban ends; a lobby they're already in carries on. They can still sign in, play alone and sync their saves. A ban applies to the account, so it reaches every platform the player signs in with. If the player joins their account to another by adding its email address, the ban, their reports and their record go with them. If they delete a banned account, the service keeps its identities' keyed hashes and the ban's end until the ban ends, so signing in again with the same platform account or email brings the ban back. A player using only a device account (no Steam, Game Center or email) can make a new one, so bans hold best against platform accounts.

A renamed player has no name until they get a new one: a platform's name (such as their Steam name) comes back the next time they sign in with it, and otherwise the game asks them to choose (`needs_display_name()`). Until then, other players see them as "Player".

## A daily email

Set `MODERATION_EMAIL` to an address (in Moderation in `npm run configure`, or in `wrangler.jsonc`), and each day the service emails it the players reported in the last day: name, account ID, how many reports from how many players and the reasons. It leaves out what reporters wrote; `npm run moderate` shows that. On a day with no reports, no email goes out. The email uses the same driver as players' codes, and its wording is in `email-templates/moderation.txt` and `moderation.html`, which you can override like the others (see [Email templates](email.md#templates)).

## Automatic bans

In games with `kick_cheaters` on, a lobby removes players who fail a [check or a confirmed flag](https://oss.nekolab.studio/purr/api/checks/). The `AUTO_BAN` setting turns repeated removals into bans. Change it in Moderation in `npm run configure`, or in `wrangler.jsonc`:

```jsonc
"AUTO_BAN": { "kicks": 3, "within_days": 30, "ban_days": [1, 7, 30, null] }
```

With these defaults, three removals within 30 days ban the player from multiplayer for a day. The next time it's a week, then 30 days, and from then on for good (`null`). Each ban starts the count again, and the account's count of automatic bans sets the next length. Removals by a host never count. Remove `AUTO_BAN` to turn automatic bans off.

## Acting on reports automatically

`REPORT_RULES` bans a player, or clears their name, once enough different players report them. It's off unless you set it, in Moderation in `npm run configure` or in `wrangler.jsonc`:

```jsonc
"REPORT_RULES": {
	"ban": { "reasons": ["cheating", "abuse"], "reporters": 5, "within_days": 7, "min_reporter_age_days": 7, "ban_days": [1, 7, 30, null] },
	"rename": { "reasons": ["name"], "reporters": 3, "within_days": 7, "min_reporter_age_days": 7 }
}
```

With this, reports for cheating or abuse from five different players within a week ban the player, for as long as `ban_days` gives (as with `AUTO_BAN`, and counting the same automatic bans, so a player banned by either gets a longer ban next time). Reports about their name from three different players clear it, as `rename` does. Either rule can be left out.

Each player counts once however many times they report, and only players whose accounts are at least `min_reporter_age_days` old count, so one person can't make a handful of new accounts to get someone banned. Reports a rule acted on don't count again, so the next action takes as many new reports. Reports the anti-cheat makes (`report_failed_checks`) never count here, as `AUTO_BAN` already counts those removals. The reports stay on the list for you to review, marked as acted on.

Players can still team up to report someone unfairly, so keep the thresholds high enough for your games, and check the reports behind automatic bans: `unban` lifts one.
