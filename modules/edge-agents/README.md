# Edge agents

A small program on each of your computers that sends that machine's numbers (processor, memory, disk, temperature,
the busiest programs) to the dashboard, and can run a short, fixed list of commands. The program's source is in
[`agent/`](../../agent/README.md); this folder is the dashboard's side.

## What you get

| Where | What |
|---|---|
| Metrics > Systems (`/dashboard/systems`) | one card per computer: what it last reported and its processor load over a day |
| Settings > Edge agents (`/dashboard/agents`) | add a computer, approve it, choose its commands, confirm a risky command, revoke it |
| AI apps (`/devices/mcp`) | `list_devices`, `device_stats`, `device_ops`, `command_status`, `run_command` |

## How it is locked

Computers call out; nothing on them listens. Each request passes two locks:

1. **At Cloudflare**: `/api/agents/*` is behind an Access application that only lets a service token through. Each
   computer gets its own token, so one can be cut off without touching the others.
2. **At the dashboard**: every request is signed with a key made on that computer (Ed25519). The private key never
   leaves it. Requests carry a time and a number used once, so a copied request is worthless.

A new computer is added with a one-time code that lasts 10 minutes, and then stays shut out until an admin has
compared the fingerprint it printed with the one on the Edge agents page.

## Commands

| Command | Tier | What |
|---|---|---|
| `agent.ping` | safe | version, system and time |
| `pc.wake` | safe | wake another computer by a name from that agent's own settings (the dashboard never sends a network address) |
| `pc.cancel_shutdown` | safe | cancel a pending shutdown (Windows) |
| `pc.shutdown` | destructive | shut a Windows PC down after 10 to 300 seconds |

- A command can only go to a computer you allowed it for.
- A **destructive** command waits until an admin confirms it on the Edge agents page, within 5 minutes. An AI app
  can ask for one; it can never confirm one.
- The dashboard signs every command (`SHELL_COMMAND_SIGNING_KEY`, made on the one-time key page). The agent checks
  that signature, the expiry, that it has not seen the command before, and its own compiled-in list. There is no
  shell and no script runner: a new command means a new build of the agent.

What a computer sent is kept for 30 days. A computer can only store records under its own name, and only of the
kinds `metrics.*`, `power.*` and `event`.

## Adding a computer

1. Your AI creates a Cloudflare Access service token for the machine and adds it to the policy of the
   "machines" Access application. Keep both halves in your password manager as
   `AGENT_<MACHINE>_SERVICE_TOKEN_ID` and `AGENT_<MACHINE>_SERVICE_TOKEN_KEY`.
2. Settings > Edge agents > Add a computer gives you a one-time code and the command to run.
3. On the computer, build and install the agent ([`agent/README.md`](../../agent/README.md)) and run that command.
4. Compare the fingerprint, approve.

## Files

`sign.ts` is request and command signing, `agents.ts` the machines' API, `admin.ts` what the pages and
`/devices/mcp` do, `ops.ts` the list of commands, `demo.ts` three made-up computers. The wire format is written down
in [`agent/PROTOCOL.md`](../../agent/PROTOCOL.md). Cloudflare needs: the `agents` database, a cron trigger and the
Access application for `/api/agents/*` (`setup/modules/edgeAgents.json`).
