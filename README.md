# Smart Home Dashboard by Ruan

A private dashboard for your household that runs on your own Cloudflare account, set up for you by your own AI
(Claude or Codex). Today's calendar, home controls, notes, finances and health records in one place, behind your own
sign-in, with your data in your own databases.

> **Status: under construction.** Built so far: the core (sign-in, Today, Settings, Security page, demo mode) and
> the gateway. The other modules and the setup scripts are being added. Do not install yet.

![Today, with the demo family](docs/screenshots/today.png)

Try it without an account: `npm run install:apps`, then `npm run demo`, and open the address it prints. Everything
you see there is a made-up family.

## How it works

You bring three things. Your AI does the rest.

1. **Accounts.** A GitHub account and a Cloudflare account.
2. **A domain** on Cloudflare (buy one there, or move one you own).
3. **Access for your AI.** Copy this repository into a new **private** repository of your own and give your AI
   access to it. Create a Cloudflare API token that expires in 7 days and store it as a secret in your AI's
   environment, never in a chat message.

Then tell your AI: *"Read AGENTS.md and set up my dashboard."* It checks that everything is in place, asks which
modules you want, shows what it will create, builds it, and hands you a list of what now exists.

This is a one-time copy. Your private repository is yours to change and extend; it does not receive updates from here.

## Modules

| Module | What you get | Needs |
|---|---|---|
| Core | sign-in with a passkey, a Today page per person, Settings, a Security page | a domain |
| Gateway | lets your own Claude or ChatGPT app use your dashboard's data (MCP, OAuth) | Core |
| Brain | a shared notes tree with a 3D map | Core |
| Calendar | your iCloud calendars on the Today page | an iCloud app-specific password |
| Finance | accounts, balances, contracts, deadlines; encrypted | Core |
| Health | per-person health records; encrypted | Core |
| Data export | an encrypted zip of everything | a data module |
| Home Assistant | lights, scenes, plugs and lists | Home Assistant with the Cloudflared add-on |
| Energy | an energy page from your Home Assistant sensors | Home Assistant |
| Kiosk | wall tablets, paired from Settings | Home Assistant |
| Edge agents | stats from your Mac, Windows or Linux computers | a computer, a Go build |
| Alfred | a chat assistant inside the dashboard | an Anthropic API key, billed per use |

## Your secrets

Every secret has one clear name, listed with its purpose in [secrets.manifest.json](secrets.manifest.json). Values
live only in Cloudflare and in your password manager: keep one item there (for example "Home Dashboard") with one
field per name. The encryption keys for your notes, finances and health records are generated in your own browser,
so your AI never sees them. **If you lose an encryption key, the data it protects is gone.**

## What is in this repository

| Path | What |
|---|---|
| `AGENTS.md` | the setup guide your AI follows |
| `household.config.example.json` | the one file with your household's settings: domain, people, modules |
| `secrets.manifest.json` | every secret by name: what it is for, where it lives, how to replace it |
| `setup/` | the checks, the generator for the Workers' config files and (soon) the setup scripts |
| `apps/shell` | the dashboard: sign-in, Today, Settings, Security |
| `apps/gateway` | the MCP addresses and the OAuth server for your AI apps |
| `packages/core` | code every Worker shares: the household config, the sign-in check |
| `apps/`, `modules/`, `agent/` | the other Workers, the optional modules and the edge agent |
| `docs/` | how it is built and how to fix things |
| `demo/` | a made-up family's data, for previews and screenshots |

## Security, plainly

You run this yourself, on your own accounts. It is provided as is, with no warranty and no support. Read
[docs/security.md](docs/security.md) before you store anything sensitive.

## Licence

MIT. See [LICENSE](LICENSE).
