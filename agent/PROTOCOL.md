# Agent protocol v1

Between an edge agent (`agent/`) and the dashboard Worker (`modules/edge-agents`). The two implementations are kept
equal by test vectors: `agent/testdata/worker-vectors.json` is made by the Worker's own code and checked by the Go
tests.

All calls are HTTPS requests from the agent to `https://<dashboard>/api/agents/*`. The path sits behind a Cloudflare
Access application that only admits a service token, sent as `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
Keys, signatures and nonces are base64url without padding.

## Enrolment

`POST /api/agents/enrol` with `{ "agent": "ag_<id>", "code": "<one-time code>", "pubkey": "<raw Ed25519 public key, 32 bytes>" }`.
Not signed: the code is the credential. It lasts 10 minutes and works once.

Reply: `{ "ok": true, "agent", "status": "pending", "fingerprint", "command_key": { "alg": "ed25519", "x": "<raw public key>" } }`.

- `fingerprint` is base64url of the first 16 bytes of SHA-256 of the raw public key. The agent prints it; an admin
  compares it with the dashboard's and approves. Until then every signed request gets 401.
- `command_key` is the key the dashboard signs commands with. The agent pins it.

## Signed requests

Every other request carries:

| Header | Value |
|---|---|
| `X-Agent-Id` | `ag_<id>` |
| `X-Agent-Ts` | Unix time in milliseconds (13 digits) |
| `X-Agent-Nonce` | 22 to 64 base64url characters, never reused |
| `X-Agent-Sig` | Ed25519 signature of the string below |

The signed string is seven lines joined by `\n`:

```
agent-v1
<METHOD, upper case>
<path, no host, no query>
<agent id>
<ts>
<nonce>
<sha256 of the body, lower-case hex; of nothing for an empty body>
```

The Worker refuses (401, no reason given) an unknown, pending or revoked agent, a time more than 2 minutes off, a
nonce seen in the last 10 minutes, a body over 256 KB or a signature that does not verify. More than 60 requests a
minute get 429. Every reply carries `X-Server-Ts`, so an agent with a wrong clock can correct for it.

## Sending records

`POST /api/agents/ingest` with `{ "v": 1, "records": [{ "kind", "ts", "data" }] }`: at most 500 records, each
`data` a JSON object of at most 8 KB. `kind` must match `metrics.*`, `power.*` or `event`; other kinds are dropped
and named in the reply. The source of a record is always the agent that signed.

Reply: `{ "ok": true, "accepted": <n>, "commands": <waiting>, "refused": ["kind", …] }`.

## Commands

`GET /api/agents/commands` hands each queued command out once:

```
{ "commands": [{ "id": "cmd_…", "op": "agent.ping", "args": {}, "tier": "safe", "expires": <ms>, "sig": "…" }] }
```

`sig` is the dashboard's Ed25519 signature of six lines joined by `\n`:

```
cmd-v1
<agent id>
<command id>
<op>
<sha256 hex of the canonical JSON of args>
<expires>
```

Canonical JSON: object keys sorted by UTF-16 code unit at every level, no whitespace, numbers and strings as
JavaScript's `JSON.stringify` writes them.

Before running a command the agent checks: the signature with the pinned key; that it has not expired; that its id
is new; that the op is in the agent's own compiled-in list and available on this machine; the exact shape of the
arguments; and that the tier sent is not lower than the agent's own tier for that op. A command that fails a check is
not run and is reported as failed.

`POST /api/agents/commands/<id>/result` with `{ "ok": true|false, "output": <any JSON, at most 16 KB> }`, once.

| Op | Tier | Arguments |
|---|---|---|
| `agent.ping` | safe | none |
| `pc.wake` | safe | `{ "target": "<a name from the agent's own wol_targets>" }` |
| `pc.cancel_shutdown` | safe | none |
| `pc.shutdown` | destructive | `{ "delay_s": 10..300 }`, default 10 |

A destructive command is only queued after an admin confirmed it in the dashboard.
