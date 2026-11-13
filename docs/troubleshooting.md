# When something is wrong

Tell your AI what you see, in your own words. If you gave it the read-only token (`DEBUG_CLOUDFLARE_READONLY_TOKEN`),
it can read the build results and the error logs itself. Below are the usual causes.

## During setup

| You see | Usually |
|---|---|
| "the token never expires" or "expires in more than 7 days" | make a new token with an end date at most 7 days away ([getting started](getting-started.md#step-6-the-7-day-cloudflare-token)) |
| "could not list … (the token may lack permissions)" | a permission row is missing on the token; compare it with the table in step 6 |
| "the setup token may not create other tokens" | add **User > API Tokens > Edit** to the token |
| "the zone is not active" | the domain's name servers are not switched to Cloudflare yet, or the change has not spread; wait an hour |
| "Zero Trust is not set up" | open Zero Trust in Cloudflare once and choose a team name and the Free plan |
| "the repository is public" | change it to private on GitHub: Settings > General > Danger Zone > Change visibility |
| a name is "already taken" | something in your account already uses that name; your AI suggests another prefix |

Every setup step can be run again; it reuses what already exists.

## After setup

| You see | Usually |
|---|---|
| Cloudflare's sign-in asks for a code, not a passkey | the passkey requirement in Zero Trust is not set yet |
| Cloudflare lets you in, but you land on the sign-in page again | the email you signed in with is not in `household.config.json`, or differs in spelling |
| A page says a module is **locked** | its encryption key is not stored yet: an admin opens Settings > Encryption keys |
| Calendar says "not connected yet" | `CALENDAR_ICLOUD_USER_ID` or `CALENDAR_ICLOUD_APP_PASSWORD` is missing on the calendar Worker |
| A calendar is missing | its name in iCloud does not match the person's first name (or "Family"); it appears within six hours of a fix |
| Settings > Home Assistant shows a red tick | the Cloudflared add-on is stopped, or `HA_API_LONGLIVED_TOKEN` is missing or was deleted in Home Assistant |
| The assistant says it is not set up | `ALFRED_ANTHROPIC_API_KEY` is missing on the alfred Worker, or the Anthropic account has no credit |
| A merged change does not show up | Workers Builds is not connected for that Worker, or the build failed: Workers & Pages > the Worker > Deployments |
| A wall tablet shows the pairing page again | it was revoked or its 180 days ran out: pair it again |

## Undoing a change

Every change goes through a pull request. Ask your AI to revert the one that broke something; when the revert is
merged, the earlier version is live again within minutes. Your data is not touched by a revert.

## A lost encryption key

If an encryption key is lost from both Cloudflare and your password manager, the data it protects cannot be read
again, by anyone. The rest of the dashboard keeps working. This is why the key page asks you to save each key before
it stores it.
