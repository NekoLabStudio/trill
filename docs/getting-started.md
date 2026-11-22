# Getting started

## What you need

- A Cloudflare account. The Workers Free plan is enough to start.
- Node.js 20 or later, and git.
- A way to send email, for players who add their address: Cloudflare's Email Sending (Workers Paid) or an [SMTP2GO](https://www.smtp2go.com) account (see [Email](email.md)).

## Setting up an instance

You need a Cloudflare account, Node.js 20 or later and git. In an empty folder, run:

```sh
curl -fsSL https://oss.nekolab.studio/trill/setup.sh | sh
```

It downloads Trill's newest release, signs you in to Cloudflare and asks about your games and how to send email. Then it creates the database and the saves bucket, fills in `wrangler.jsonc`, deploys, and generates and stores the secrets. Last, it makes the folder a git repository and offers to push it to a new private GitHub repository. It prints your instance's address, which your games connect to. Keep the identity secret it shows somewhere safe: without it, no player can be matched to their account again (see [Secrets](secrets.md#identity-secret)).

The folder is yours from then on. Add [your own email templates](email.md#templates) there, and change its settings with `npm run configure` (see [Settings](settings.md)). Running `npm run setup` again is safe, and `npm run setup -- --dry-run` prints what it would do.

If you'd rather not use the script, [Setting up by hand](manual-setup.md) has the same steps one by one.

## Connecting a game

With Purr, put your instance's address in Project Settings as `online/url`, and the game's ID (the one you gave the setup script) as `online/game`. Then sign in with `Account.sign_in()` and the game is online: see [Connecting a game](connecting.md) for the platform sign-ins, and [Purr's docs](https://oss.nekolab.studio/purr/online/) for the rest.

Players can always sign in with a device account. Steam, Game Center and Google Play Games sign-ins each need a little more on your instance, which [Connecting a game](connecting.md#platform-sign-ins) lists.

## Keeping it up to date

New releases of Trill bring fixes and features. `npm run update` in your instance's folder brings in the newest one, keeping your settings: see [Updating](updating.md).
