# Getting started

This guide is for you, the person who will own the dashboard. You do not need to write code. Your AI (Claude or
Codex) does the building; you make the accounts, click a few buttons only you can click, and keep your secrets in
your password manager.

Plan for about two hours spread over an evening: most of it is waiting for your AI and reading what it shows you.

## What it costs

| What | Cost |
|---|---|
| Cloudflare | free plan is enough for a household. Zero Trust is free for up to 50 people; Cloudflare may still ask for a card when you turn it on |
| A domain | about 10 to 15 a year, depending on the ending (`.com`, `.net`, …) |
| GitHub | free |
| Your AI | your existing Claude or ChatGPT plan |
| Alfred (optional) | your own Anthropic API key, billed per message. A normal day of family use costs cents |

Nothing in this repository sends your data to anyone else. The only outside calls are to the services you turn on
(Apple's calendar server, your Home Assistant, Anthropic for Alfred, the European Central Bank for exchange rates).

## Before you start: a password manager

Make one item in your password manager called, for example, **Home Dashboard**. Every secret you create or receive
during setup goes in there as one field, under the exact name your AI gives you (such as `CALENDAR_ICLOUD_APP_PASSWORD`).
[secrets.md](secrets.md) explains each one and how to put a value into Cloudflare without pasting it into a chat.

## Step 1: accounts

1. **GitHub.** Sign up at github.com. Turn on two-factor sign-in (Settings > Password and authentication).
2. **Cloudflare.** Sign up at dash.cloudflare.com. Turn on two-factor sign-in (My Profile > Authentication).

Whoever controls these two accounts controls the dashboard, so these two-factor settings matter more than anything
else in this guide.

## Step 2: a domain

The dashboard lives at an address like `home.example.com`. You need a domain on Cloudflare for that.

- **Buy one in Cloudflare:** Domain Registration > Register Domains. It is ready within minutes.
- **Or use one you own:** add it in Cloudflare (Add a domain) and change its name servers at your current provider
  as Cloudflare shows you. Wait until Cloudflare says the domain is **Active**.

Pick the address for the dashboard now, for example `home.example.com`. Wall tablets (the kiosk module) and Home
Assistant get their own addresses next to it (`kiosk.example.com`, `ha.example.com`); your AI shows them before
creating anything.

## Step 3: turn on Zero Trust

Cloudflare Zero Trust is the door in front of your dashboard: it lets in only the email addresses you list.

1. In Cloudflare, open **Zero Trust**.
2. Choose a team name (anything; it becomes `<team>.cloudflareaccess.com`) and the **Free** plan.

That is all for now. Your AI creates the doors and lists your family's email addresses.

## Step 4: your own private copy of this repository

1. On this repository's GitHub page, press **Use this template > Create a new repository**. If you do not see that
   button, use github.com/new/import with this repository's address instead.
2. Give it a name, and choose **Private**. This is important: your copy will hold your household's settings.
3. That is your repository from now on. It does not receive updates from here; it is yours to change.

## Step 5: give your AI access

Your AI needs to work in your private repository and to run commands. Two ways that work:

- **Claude Code on the web** (claude.ai/code): connect your GitHub account, select your private repository and
  create a cloud environment for it.
- **Codex** (chatgpt.com/codex): connect GitHub, select your private repository and create an environment for it.

The environment needs internet access to `api.cloudflare.com` and to the npm registry. Choose the setting that allows
common developer sites, or add those two hosts.

## Step 6: the 7-day Cloudflare token

Your AI needs a key to build things in your Cloudflare account. You make it, it lasts at most 7 days, and you delete
it when setup is done.

1. In Cloudflare: My Profile > **API Tokens** > Create Token > **Create Custom Token**.
2. Name it `dashboard setup`.
3. Add these permissions (one row each):

   | Type | Permission | Access |
   |---|---|---|
   | Account | Workers Scripts | Edit |
   | Account | D1 | Edit |
   | Account | Workers KV Storage | Edit |
   | Account | Workers R2 Storage | Edit |
   | Account | Access: Apps and Policies | Edit |
   | Account | Access: Service Tokens | Edit |
   | Account | Access: Organizations, Identity Providers, and Groups | Read |
   | Account | Account Settings | Read |
   | Zone | Zone | Read |
   | Zone | Workers Routes | Edit |
   | Zone | DNS | Edit |
   | User | API Tokens | Edit |
   | User | User Details | Read |
   | User | Memberships | Read |

   **API Tokens: Edit** is the one people forget. It lets your AI make a short-lived, much narrower token for the
   page where you create your encryption keys.
4. Account Resources: your account. Zone Resources: your domain.
5. **TTL: set the end date at most 7 days from today.** The setup refuses a token without an end date.
6. Create it and copy the value **straight into your AI's environment**, as an environment variable named
   `SETUP_CLOUDFLARE_FULL_TOKEN`:
   - Claude Code on the web: the environment's settings (the gear next to the environment) > environment variables.
   - Codex: the environment's settings > Environment variables. (Not "Secrets": Codex shows those only while the
     environment is being prepared, not while your AI works.)
7. Also keep it in your password manager item until setup is done.

Never paste the token into a chat message. Your AI reads it from the environment and never prints it.

## Step 7: choose your modules

Decide which parts you want. You can switch more on later.

| Module | Turn it on if… | You will need |
|---|---|---|
| [Core](modules/core.md) | always on | your family's first names and sign-in email addresses |
| [Brain](modules/brain.md) | you want shared notes your AI can read and write | nothing more |
| [Calendar](modules/calendar.md) | you use iCloud calendars | an iCloud app-specific password |
| [Finance](modules/finance.md) | you want accounts, contracts and deadlines in one place | nothing more |
| [Health](modules/health.md) | you want each person's health records | nothing more |
| [Home Assistant](modules/home-assistant.md) | you run Home Assistant at home | admin access to Home Assistant |
| [Energy](modules/energy.md) | Home Assistant knows your solar, grid or battery power | Home Assistant module |
| [Kiosk](modules/kiosk.md) | you want a tablet on the wall | Home Assistant module, a tablet |
| [Edge agents](modules/edge-agents.md) | you want your computers' stats on the dashboard | a computer you can install a program on |
| [Alfred](modules/alfred.md) | you want a chat assistant inside the dashboard | an Anthropic API key |

Up to six people. Decide who is an **admin**: admins see Metrics (finance, systems) and Settings for the whole
household. Everyone else sees Today, the home controls and their own health records.

## Step 8: start

Open a new session with your AI in your private repository and say:

> Read AGENTS.md and set up my dashboard.

What happens next, and where it will stop to ask you:

1. **Checks.** It confirms the token, the domain, Zero Trust and that your repository is private.
2. **Questions.** Household name, each person's first name and email, who is admin, which modules. It reads your
   answers back. Say yes when they are right.
3. **The plan.** A list of everything it will create in Cloudflare, with names. Read it, then say yes.
4. **Building.** It creates the databases and doors, and puts the dashboard online.
5. **Secrets.** It gives you one checklist of secrets only you can make (for example the iCloud password). For each:
   create it, save it in your password manager, put it into Cloudflare as [secrets.md](secrets.md) shows, then tell
   your AI "done".
6. **Encryption keys.** It sends you to `https://<your dashboard>/setup/keys`. There, your browser makes the keys
   for your notes, finances and health records. Save each one in your password manager before you press Store. The
   page then closes itself for good. Your AI never sees these keys. [Screenshot](screenshots/key-page.png)
7. **Clicks only you can do.** See below.
8. **Token handover.** You delete the 7-day token (Cloudflare > My Profile > API Tokens) and remove it from your AI's
   environment. Your AI checks that it no longer works.
9. **Connect your AI app** to your dashboard: see [using-your-dashboard.md](using-your-dashboard.md).
10. **A summary.** It writes `docs/your-setup.md` in your repository: what exists, by name.

### Clicks only you can do

Your AI tells you when. Each takes a minute or two.

- **Automatic updates of your dashboard (Workers Builds).** In Cloudflare, Workers & Pages > each of your Workers >
  Settings > Build > Connect to your private repository, branch `main`. From then on, when a change is merged on
  GitHub, Cloudflare puts it live by itself.
- **Passkey sign-in.** In Zero Trust > Settings > Authentication, add the sign-in method your AI suggests and require
  a passkey (Face ID, Touch ID, Windows Hello or a security key).
- **A read-only token for your AI** (optional, recommended): My Profile > API Tokens > Create Token > template
  **Read all resources**. Store it in your AI's environment as `DEBUG_CLOUDFLARE_READONLY_TOKEN`. With it your AI can
  read error logs later without being able to change anything.
- **Home Assistant** (only with that module): install the Cloudflared add-on. See
  [modules/home-assistant.md](modules/home-assistant.md).

## When something goes wrong

Your AI stops and explains. Every setup step can be run again safely. [troubleshooting.md](troubleshooting.md) lists
the usual causes. To remove everything again, tell your AI "remove my dashboard"; it shows the list and waits for a
yes that names your household.
