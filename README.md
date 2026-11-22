<p align="center"><img src="branding/trill-logo.svg" alt="Trill" width="96" height="96"></p>

# Trill

Online services for games: player accounts without stored email addresses, passwords or platform IDs, cloud saves, progress across platforms by email, lobbies, matchmaking and ratings, moderation and crash reports. You run it on your own Cloudflare account, as a Cloudflare Worker.

[Purr](https://oss.nekolab.studio/purr/) uses Trill out of the box. Any other engine can talk to it through its [protocol](https://oss.nekolab.studio/trill/protocol/): plain HTTP, JSON and WebSocket.

To set up your own instance, run this in an empty folder (it asks a few questions and deploys to your Cloudflare account):

```sh
curl -fsSL https://oss.nekolab.studio/trill/setup.sh | sh
```

`npm run configure` changes its settings later, and `npm run update` brings in Trill's newest release. The settings, protocol and privacy notice are in [the documentation](https://oss.nekolab.studio/trill/) (`docs/` in this repository).

## Working on Trill

```sh
npm install
npm test              # the tests (the service in the Workers runtime, and the scripts)
npx tsc --noEmit      # the type check
npx wrangler dev      # a local copy, at http://localhost:8787
python3 docs-site/build.py --output dist/docs-site   # the docs site
```

For a local copy, put `IDENTITY_SECRET`, `SESSION_SECRET` and `EMAIL_DRIVER=log` in `.dev.vars` (which git ignores) and apply the database migrations first with `npx wrangler d1 migrations apply trill --local`. Codes then appear in `wrangler dev`'s output instead of being emailed.

Trill is made by [NekoLab](https://nekolab.studio). Its code is under the MIT license (see `LICENSE.txt`); the Trill name and logo aren't.
