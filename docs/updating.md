# Updating

```sh
npm run update
```

This brings in Trill's newest stable release (`npm run update -- v1.2.3` picks one). It replaces the files that come from Trill (`src/`, `migrations/`, the tests and scripts) and keeps your own: `src/email-templates/custom/` and your secrets.

Your `wrangler.jsonc` stays yours, with what the release adds to it: new settings with their defaults, new rate limits and anything the service's code needs set up. Where the release changed a default you never touched, yours follows it. A setting you changed yourself is never changed: if the release's default for it moved, the update lists it so you can decide. It also lists settings the release no longer uses, and any new resource (a database or bucket) you'd need to create, which the release's upgrade notes explain.

Before applying new database migrations, it notes where the database stands and prints the command that brings it back there, in case anything goes wrong (D1 keeps 30 days of history). Then it offers to deploy. Commit the changes with git afterwards, so your folder's history shows what each update did.
