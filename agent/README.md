# Edge agent

A small Go program for Mac, Windows and Linux that sends a computer's numbers to your home dashboard and runs the
few commands compiled into it. It only ever calls out over HTTPS; nothing on the computer listens. You build it
yourself from this folder; no binaries are published.

The dashboard's side is [`modules/edge-agents`](../modules/edge-agents/README.md). The wire format is
[`PROTOCOL.md`](PROTOCOL.md).

## What it sends

Once a minute, one record: processor load and temperature, memory, disk, uptime, the system's version and model,
and the five busiest programs by name. On Windows also the graphics card, when its tool is installed.

It never collects command lines, window titles, file names, browsing, keystrokes, screenshots, the clipboard, user
names or location. Set `"hide_processes": true` in `agent.json` and it sends no program names either. To see exactly
what would leave the machine, run `edge-agent collect`: it prints one record and sends nothing.

If the computer is offline, records wait on disk for up to 48 hours.

## Build

You need Go 1.24 or newer.

```
cd agent
./build.sh              # this computer: dist/edge-agent
./build.sh all 0.1.0    # Mac, Windows and Linux
go test ./...
```

## Install

Add the computer in the dashboard first (Settings > Edge agents): you get an id and a one-time code. Have the
machine's Access service token at hand; `enrol` asks for it, or reads it from the environment variables
`EDGE_AGENT_ACCESS_ID` and `EDGE_AGENT_ACCESS_SECRET`.

**Mac and Linux** (as yourself, no root):

```
./install/install.sh dist/edge-agent
"<path it prints>" enrol --server https://<your dashboard> --id ag_<name> --code <code>
./install/install.sh dist/edge-agent      # again: starts it
```

**Windows** (PowerShell as administrator):

```
.\install\install.ps1 -Binary .\dist\edge-agent-0.1.0-windows-amd64.exe
& 'C:\Program Files\edge-agent\edge-agent.exe' enrol --server https://<your dashboard> --id ag_<name> --code <code>
.\install\install.ps1 -Binary .\dist\edge-agent-0.1.0-windows-amd64.exe
```

On Windows it runs as a service under its own account, which is neither an administrator nor you. Its only extra
right is shutting the PC down.

`enrol` prints a **fingerprint**. In the dashboard, approve the computer only if the fingerprint shown there is
exactly the same. Until then the dashboard refuses it.

## Where things are

| | Folder |
|---|---|
| Mac | `~/Library/Application Support/edge-agent` |
| Windows | `C:\ProgramData\edge-agent` |
| Linux | `~/.local/state/edge-agent` |

In it: `identity.key` (the private key; never copy it), `access.secret` (the service token), `agent.json`
(settings), `spool/` (records waiting to be sent). `edge-agent status` shows what the agent is and what it may be
asked to do.

Settings in `agent.json` (restart the agent after a change):

| Setting | Default | What |
|---|---|---|
| `interval_s` | 60 | seconds between records (15 at least) |
| `poll_s` | 30 | seconds between looking for commands |
| `hide_processes` | false | true: send no program names |
| `wol_targets` | none | computers this one may wake: `{ "gaming-pc": "<its network card's address>" }` |
| `wol_broadcast` | none | your home network's broadcast address, when the plain broadcast does not reach |

## Commands

`agent.ping`, `pc.wake` (only with `wol_targets`), `pc.cancel_shutdown` and `pc.shutdown` (Windows only). Before one
runs, the agent checks the dashboard's signature against the key it pinned at enrolment, the expiry, that it has not
seen the command before, the exact shape of the arguments, and that a risky command arrived marked as confirmed.
Anything else is refused and reported. There is no shell.

## Removing it

`./install/install.sh --remove` or `.\install\install.ps1 -Remove`, then revoke the computer under Settings > Edge
agents and delete its service token in Cloudflare. To start over on a machine, delete the agent's folder as well.
