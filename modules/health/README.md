# Health

Doctor visits, test results, vaccinations and medication, one set of records per person. Encrypted at rest, never
logged.

| | |
|---|---|
| Page | `/dashboard/health` (Metrics): each person sees their own records, an admin everyone's |
| API | `/api/health/*` on the dashboard Worker ([src/api.ts](src/api.ts) lists every route) |
| MCP | `/health/mcp` on the gateway, scopes `health.read` and `health.write` ([tools](../../apps/gateway/src/tools/health.ts)) |
| Data | D1 `<prefix>-health`, bound to the dashboard Worker as `HEALTH_DB` ([migrations](migrations)) |
| Secret | `HEALTH_DATA_ENCRYPTION_KEY` on the dashboard Worker, made on the key page |
| Setup | [setup/modules/health.json](../../setup/modules/health.json) |

## How the data is kept

- One table, `records`. Readable in the database: whose record it is, its type and its date. Everything else is one
  value sealed with AES-256-GCM ([packages/core/src/seal.ts](../../packages/core/src/seal.ts)).
- Without the secret the records are locked: the page says so, the tools answer with a clear error, nothing crashes.
  **If the secret is lost, the records cannot be read again.** Keep it in your password manager.
- Nothing is deleted. Archiving hides a record; every change keeps the earlier sealed version in `versions`.
- The audit says who touched which record id and when. No field of a record is ever written to a log, an audit row
  or an error message.

## Who sees what

| Caller | Sees |
|---|---|
| A person on the page | their own records; an admin everyone's |
| An AI app connected through OAuth | what the person who approved it sees |
| A gateway key (the household's own programs, e.g. the assistant) | every person's records, within the key's scopes |

Tools that touch one record take an optional `person`; when given, the record must belong to that person.

## Code

`src/schema.ts` field checks · `src/store.ts` D1 and the overview, trends and reminders · `src/api.ts` the page's
routes · `src/service.ts` what the MCP may do · `src/entry.ts` the Worker entrypoint the gateway binds to ·
`src/shell.ts` what the module adds to the dashboard · `src/demo.ts` demo mode. Tests: `node --test` at the root.
