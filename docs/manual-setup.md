# Setting up by hand

`npm run setup` does all of this for you (see [Getting started](getting-started.md)). By hand, from a copy of this repository:

```sh
npm install
npx wrangler login
npx wrangler d1 create trill               # put the database_id it prints into wrangler.jsonc
npx wrangler d1 migrations apply trill --remote
npx wrangler r2 bucket create trill-saves
npx wrangler r2 bucket lifecycle add trill-saves discarded-saves discarded/ --expire-days 30
```

Set the secrets (each command asks for the value):

```sh
npx wrangler secret put IDENTITY_SECRET     # a long random string; see Secrets
npx wrangler secret put SESSION_SECRET      # another long random string
```

Set the optional ones for the sign-ins, email and TURN you use (see [Secrets](secrets.md)).

List your games under `GAMES` in `wrangler.jsonc` (see [Connecting a game](connecting.md)), and set up [email](email.md). Then deploy:

```sh
npx wrangler deploy
```

`npm test` runs the service's tests.
