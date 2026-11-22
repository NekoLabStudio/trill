# Email

Trill emails players a 6-digit code when they add their email address or sign in with it, and a guest a code when they bring their profile to someone else's device. It keeps no email addresses: see [Privacy](privacy.md).

## Drivers

Codes go out through the driver `EMAIL_DRIVER` names, from the address in `EMAIL_FROM` (`"Name <address>"`):

- **`cloudflare`** (the default): Cloudflare's Email Sending, through the `send_email` binding in `wrangler.jsonc`. It needs the Workers Paid plan and your domain onboarded under Email Service > Email Sending (Cloudflare adds the SPF, DKIM and DMARC records).
- `smtp2go`: SMTP2GO's HTTP API, with the `SMTP2GO_API_KEY` secret and a sender verified in your SMTP2GO account. `SMTP2GO_API_URL` can pin a region, such as `https://eu-api.smtp2go.com/v3`. Remove the `send_email` binding if you're on the Free plan.
- `log`: writes the email to the console instead of sending it, for `wrangler dev` (put `EMAIL_DRIVER=log` in `.dev.vars`). It only works on your own computer.

Another provider is one file in `src/email/` with one function, listed in `src/email/index.ts`.

## Templates

The emails' wording and look are files in your instance's `src/email-templates/`: for each kind of email, a `.txt` file (a `Subject:` line, a blank line, then the plain-text body) and an `.html` file (the HTML body), with `layout.html` around every HTML body. `sign_in` is for signing in, adding or changing an address, and `guest` is for a guest bringing their profile to someone else's device. They can use `{{code}}`, `{{game}}` (the game's `name` in `GAMES`) and `{{minutes}}`. `moderation` is [the daily email to you](moderation.md#a-daily-email) about reported players, with `{{count}}` and `{{players}}`; it isn't for one game, so only `custom/` overrides it. The layout has `{{subject}}`, `{{content}}` and `{{game}}`.

To make them your own, put files with the same names in `src/email-templates/custom/`, or in `custom/<game>/` for one game, and deploy. Each file you add replaces the default of the same name, and the defaults never change your files, so updating the service keeps your versions.
