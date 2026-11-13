# Finance

Accounts with dated balances, holdings, property and vehicles, contracts, transactions, deadlines, documents, a
logbook per asset and tax years. Encrypted at rest. Admins only.

| | |
|---|---|
| Page | `/dashboard/finance` (Metrics), admins only |
| API | `/api/finance/*` on the dashboard Worker ([src/api.ts](src/api.ts) lists every route) |
| MCP | `/finance/mcp` on the gateway, scopes `finance.read`, `finance.write`, `finance.archive` ([tools](../../apps/gateway/src/tools/finance.ts)) |
| Data | D1 `<prefix>-finance`, bound to the dashboard Worker as `FINANCE_DB` ([migrations](migrations)) |
| Secret | `FINANCE_DATA_ENCRYPTION_KEY` on the dashboard Worker, made on the key page |
| Cron | once a day: exchange rates from the European Central Bank for the currencies in use |
| Setup | [setup/modules/finance.json](../../setup/modules/finance.json) |

## How the data is kept

- Every row of every table is one line in `rows`, its fields sealed as one value with AES-256-GCM
  ([packages/core/src/seal.ts](../../packages/core/src/seal.ts)). Readable in the database: which table a row is in,
  its date (so a date range needs no decrypting), when it changed and whether it is archived. No names, amounts or
  notes.
- Without the secret the data is locked: the page says so and the tools answer with a clear error. **If the secret
  is lost, the records cannot be read again.** Keep it in your password manager.
- Nothing is deleted: a row is archived and can be brought back. Balances are dated and only ever added.
- The audit names the row and the fields that changed, never a value.
- Because rows are sealed, filtering beyond table and date happens in the Worker after decrypting. That is fine for
  a household (a few thousand rows). On Cloudflare's free plan a very long transaction history could reach the CPU
  limit of a request; the paid Workers plan lifts it.
- A new field is one line in [src/schema.ts](src/schema.ts) and needs no migration.

## Money

- Amounts are whole cents in the row's own currency. Debts are entered as the positive amount owed.
- Totals are shown in the household's currency: `currency` in `household.config.json` (default `EUR`).
- Other currencies convert with the European Central Bank's daily reference rates ([src/fx.ts](src/fx.ts)). The
  request to the bank names a currency and a start date, nothing else. A currency without a rate yet shows as
  "not converted" until the first sync (right after it is first used, then daily).
- Never store full account or card numbers (last four digits at most), PINs or passwords.

## Not in the template

Bank statement import and document upload are left out: statement formats differ per bank. Add rows on the page,
or let an AI app you connected file them through `/finance/mcp`.

## Code

`src/schema.ts` tables and field checks · `src/money.ts` currency, loans, net worth, coming dates · `src/store.ts`
the sealed store and the in-memory one · `src/api.ts` routes and rules · `src/service.ts` what the MCP may do ·
`src/entry.ts` the Worker entrypoint the gateway binds to · `src/shell.ts` what the module adds to the dashboard ·
`src/demo.ts` demo mode. Tests: `node --test` at the root.
