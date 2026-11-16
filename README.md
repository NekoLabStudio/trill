# Purr online services

The online services for games made with Purr: accounts without stored email addresses, passwords or platform IDs, cloud saves, progress across platforms by email, local players and crossplay lobbies. It's a Cloudflare Worker.

To set up your own instance, run this in an empty folder (it asks a few questions and deploys to your Cloudflare account):

```sh
curl -fsSL https://oss.nekolab.studio/purr/online/setup.sh | sh
```

`npm run update` later brings in Purr's newest release. The settings, protocol and privacy notice are in [the documentation](https://oss.nekolab.studio/purr/online/) (`docs/online/` in this repository).

```sh
npm install
npm test              # the tests (the service in the Workers runtime, and the scripts)
npx wrangler dev      # a local copy, at http://localhost:8787
```

For a local copy, put `IDENTITY_SECRET`, `SESSION_SECRET` and `EMAIL_DRIVER=log` in `.dev.vars` (which git ignores) and apply the database migrations first with `npx wrangler d1 migrations apply purr-online --local`. Codes then appear in `wrangler dev`'s output instead of being emailed.
