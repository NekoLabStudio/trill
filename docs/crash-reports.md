# Crash reports

Games send crash reports from players who agreed to it (in Purr, see [Crash reports](https://oss.nekolab.studio/purr/modules/crash-reports/#sending-them)), and the service keeps them for you to work through with `npm run crashes`, from your instance's folder. It works on the deployed database through Wrangler, signed in to your Cloudflare account.

## Reading them

```sh
npm run crashes
```

This lists the crashes of the last 90 days, the most reported first: what crashed, how many reports, the game, the versions it was seen in, when it was last and first seen, and its ID. Pick one by number to read its newest report in full, step back through older ones with `older`, or `delete` it once it's fixed.

Reports of the same crash are one entry. A crash in a script is grouped by the top of its GDScript backtrace (the function and line), so it's the same crash in every build. A crash in the engine is grouped by its place in the build's binary, so each version's is its own. Runs with no backtrace at all, closed by force or stopped without saying why, are one entry together.

The same actions work as commands:

```sh
npm run crashes -- version 1.2.3     # only crashes seen in that version
npm run crashes -- show <crash>      # its newest report
npm run crashes -- delete <crash>    # forget it, once it's fixed
```

A deleted crash that happens again is listed again. Add `--local` to any of these to work on the database of `npm run dev` instead.

## What's kept

The service keeps the newest 10 reports of each crash in full and counts the rest. Each game keeps at most 2 MB of reports a day (`MAX_CRASH_REPORT_BYTES_PER_DAY`), which comes to 180 MB at most over 90 days, so a flood of reports can't fill the database; past that, crashes already known still count, but new ones wait for the next day. A player's game sends at most 5 a minute. A report is 64 KB at most.

Reports, and crashes nobody has had for 90 days, are deleted after 90 days. Nothing in a report says which player or account sent it. Email and IP addresses are removed before it's stored (the engine removes them, and the player's home folder, before sending too). See [Privacy](privacy.md).

To turn a game's crash reports away, set its `crash_reports` to `false` in `GAMES`.
