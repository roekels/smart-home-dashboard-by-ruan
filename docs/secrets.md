# Your secrets

Every password, token and key the dashboard uses has one fixed name, listed with its purpose in
[secrets.manifest.json](../secrets.manifest.json). The Security page of your dashboard shows the same list for your
own install: which secrets exist, where each lives, and what to do if one is lost.

## Three rules

1. **A secret never goes into a chat, an email or your repository.** Not even "just this once" to your own AI.
2. **Every value lives in two places only:** where it is used (Cloudflare, or your AI's environment) and your
   password manager.
3. **An encryption key you lose takes its data with it.** Nobody, including Cloudflare and your AI, can recover
   notes, finances or health records without their key.

## The password manager item

Make one item, for example **Home Dashboard**, and add one field per secret, named exactly as below. Add your
dashboard's address and Cloudflare account email to the same item, so everything is in one place.

## Who makes which secret

| Made by | What happens | Examples |
|---|---|---|
| **You** | you create it at the service, save it, and put it into Cloudflare yourself | iCloud app password, Home Assistant token, Anthropic API key |
| **Your AI** | it creates it through Cloudflare and stores it on the right Worker without showing it | the Home Assistant tunnel pass, Alfred's gateway key |
| **The key page** | your own browser makes it on `/setup/keys`; you save it; the page stores it and closes | the encryption keys for notes, finances and health |

The full list:

| Name | Module | Made by | Save it? |
|---|---|---|---|
| `SETUP_CLOUDFLARE_FULL_TOKEN` | setup | you | until setup is done, then delete it |
| `DEBUG_CLOUDFLARE_READONLY_TOKEN` | core | you | yes |
| `DEPLOY_CLOUDFLARE_BUILD_TOKEN` | core | Cloudflare, when you connect Workers Builds | no, Cloudflare keeps it |
| `BRAIN_SENSITIVE_ENCRYPTION_KEY` | Brain | key page | **yes, losing it loses sensitive notes** |
| `FINANCE_DATA_ENCRYPTION_KEY` | Finance | key page | **yes, losing it loses finance records** |
| `HEALTH_DATA_ENCRYPTION_KEY` | Health | key page | **yes, losing it loses health records** |
| `SHELL_COMMAND_SIGNING_KEY` | Edge agents | key page | yes |
| `EXPORT_ZIP_PASSPHRASE` | Data export | key page | yes (the module is not built yet) |
| `CALENDAR_ICLOUD_USER_ID` | Calendar | you | yes |
| `CALENDAR_ICLOUD_APP_PASSWORD` | Calendar | you | yes |
| `HA_API_LONGLIVED_TOKEN` | Home Assistant | you | yes |
| `HA_TUNNEL_SERVICE_TOKEN_ID`, `HA_TUNNEL_SERVICE_TOKEN_KEY` | Home Assistant | your AI | no |
| `AGENT_<MACHINE>_SERVICE_TOKEN_ID`, `…_KEY` | Edge agents | you, one pair per computer | yes |
| `ALFRED_ANTHROPIC_API_KEY` | Alfred | you | yes |
| `ALFRED_GATEWAY_KEY` | Alfred | your AI | no |

`SETUP_KEYPAGE_WRITE_TOKEN` exists only while the key page is open; your AI makes and removes it.

## Putting a secret into Cloudflare yourself

Your AI tells you the secret's name and which Worker it goes on (for example `home-calendar`). Then:

1. Cloudflare > **Workers & Pages** > open that Worker.
2. **Settings** > **Variables and Secrets** > **Add**.
3. Type: **Secret**. Variable name: the exact name. Value: paste from your password manager.
4. **Deploy**.
5. Tell your AI "done". It checks that the name is there; it cannot see the value.

## Replacing a secret

The Security page says, for each secret, how to replace it. In short: make the new one at the service, put it into
Cloudflare under the same name (it replaces the old value), update your password manager, then revoke the old one at
the service. Encryption keys cannot be replaced yet: keep them safe.

## At the end of setup

- Delete `SETUP_CLOUDFLARE_FULL_TOKEN` in Cloudflare (My Profile > API Tokens) and from your AI's environment.
- Keep `DEBUG_CLOUDFLARE_READONLY_TOKEN` in your AI's environment if you want it to be able to read logs later.
