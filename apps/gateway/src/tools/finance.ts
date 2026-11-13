// /finance/mcp: the household's money records through the shell Worker's Finance entrypoint (modules/finance).
// The shell seals every row, checks the scopes again and lets in only an admin's connection or a gateway key.
// The gateway audit gets the tool, the table and the row id, never a value.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Household } from "../../../../packages/core/src/household.ts";
import type { FinanceApi, FinancePrincipal } from "../../../../modules/finance/src/contract.ts";
import type { Principal } from "../env.ts";
import { fail, text } from "../mcp.ts";

const TABLES = ["institutions", "assets", "accounts", "holdings", "valuations", "documents", "contracts", "transactions", "deadlines", "asset_events", "tax_years"] as const;

const instructions = (h: Household) => `Finance: the money records of ${h.household}. Accounts with dated balances, holdings, property and vehicles (assets), contracts, transactions, deadlines, documents, a logbook per asset (asset_events) and tax years.

- Start with finance_overview (every open account, holding and asset with its last value and id, totals, what is due) and finance_schema (each table's fields and allowed values) before the first write.
- Money is in integer cents of the row's own currency: amount_cents -4999 is 49.99 spent, 250000 is 2,500.00 received. Debts (loans, credit cards) are entered as the positive amount owed. Totals are in ${h.currency}. Dates are YYYY-MM-DD.
- owner is a person id (${h.people.map((p) => `${p.id} = ${p.name}`).join(", ")}) or joint.
- Balances are dated and append-only: finance_balances adds a value for a date, earlier ones stay. Nothing is ever deleted; finance_archive hides a row and can bring it back.
- Before adding, look for the same thing with finance_list (q is a text filter) so nothing is entered twice. Say what you are about to write and get a yes for anything bigger than a single obvious row.
- Never store full account or card numbers (last4 at most), PINs, passwords or keys, ID or passport numbers, the names of tenants, landlords or other private people, or health details. Say "Landlord" or "Private person" instead.`;

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");
const ID = z.string().regex(/^[a-z]+_[A-Za-z0-9_-]{4,40}$/).describe("Row id, e.g. ac_…, tx_…");
const TABLE = z.enum(TABLES);
const FIELDS = z.record(z.string(), z.unknown()).describe("The table's fields, see finance_schema. Unknown fields are refused");

export function financePrincipal(p: Principal): FinancePrincipal {
  return { id: p.actor.toLowerCase().replace(/[^a-z0-9:._-]/g, "-").slice(0, 80), scopes: p.scopes, ...(p.via === "oauth" && p.user ? { user: p.user } : {}) };
}

export interface FinanceDeps {
  h: Household;
  /** The FINANCE binding; undefined when the shell is not connected. */
  finance: FinanceApi | undefined;
  /** Writes one audit row; never throws. target is a table or a row id, never a value. */
  log(tool: string, ok: boolean, target: string | null, detail?: string): void;
}

export function buildFinanceServer(p: Principal, d: FinanceDeps): McpServer {
  const server = new McpServer({ name: "finance", version: "0.1.0" }, { instructions: instructions(d.h) });
  const fp = financePrincipal(p);
  const can = (s: string) => p.scopes.includes(s);
  const tool = (name: string, run: (api: FinanceApi, a: any) => Promise<unknown>) => async (args: any) => {
    const target = args?.id ?? args?.table ?? null;
    if (!d.finance) {
      d.log(name, false, target, "finance binding missing");
      return fail("The finance records are not connected to the gateway right now.");
    }
    try {
      const out = await run(d.finance, args ?? {});
      d.log(name, true, target);
      return text(out);
    } catch (e) {
      // the shell's messages name fields, never values
      const msg = (e as Error)?.message ?? String(e);
      d.log(name, false, target, msg.slice(0, 200));
      return fail(msg);
    }
  };
  const RO = { readOnlyHint: true }, RW = { readOnlyHint: false, destructiveHint: false };

  if (can("finance.read")) {
    server.registerTool("finance_overview", {
      description: "Net worth by group and owner, every open account, holding and asset with its last value and id, and what is due in the next days (default 90).",
      inputSchema: { days: z.number().int().min(1).max(730).optional() }, annotations: RO,
    }, tool("finance_overview", (api, a) => api.overview(fp, a.days)));
    server.registerTool("finance_schema", { description: "Every table's fields and allowed values, the spending categories, the owners, the currencies and the household's base currency.", inputSchema: {}, annotations: RO },
      tool("finance_schema", (api) => api.schema(fp)));
    server.registerTool("finance_history", { description: "Net worth at each month end since the first balance, by group and owner.", inputSchema: {}, annotations: RO },
      tool("finance_history", (api) => api.history(fp)));
    server.registerTool("finance_list", {
      description: "Rows of one table. Dated tables (transactions, valuations, documents, asset_events, deadlines) come newest first and take a date range. q keeps rows with that text in any field; asset keeps rows of one asset.",
      inputSchema: { table: TABLE, from: DATE.optional(), to: DATE.optional(), asset: ID.optional(), q: z.string().max(80).optional(), archived: z.boolean().optional().describe("Include archived rows"), limit: z.number().int().min(1).max(1000).optional() },
      annotations: RO,
    }, tool("finance_list", (api, a) => api.list(fp, a.table, { from: a.from, to: a.to, asset: a.asset, q: a.q, archived: a.archived, limit: a.limit })));
    server.registerTool("finance_get", { description: "One row by table and id.", inputSchema: { table: TABLE, id: ID }, annotations: RO },
      tool("finance_get", (api, a) => api.get(fp, a.table, a.id)));
  }
  if (can("finance.write")) {
    server.registerTool("finance_create", { description: "Add one row to a table. Returns its id.", inputSchema: { table: TABLE, fields: FIELDS }, annotations: RW },
      tool("finance_create", (api, a) => api.create(fp, a.table, a.fields)));
    server.registerTool("finance_update", { description: "Change a row: only the fields sent change, null clears an optional field.", inputSchema: { table: TABLE, id: ID, fields: FIELDS }, annotations: RW },
      tool("finance_update", (api, a) => api.update(fp, a.table, a.id, a.fields)));
    server.registerTool("finance_balances", {
      description: "Add dated balances in one go: one value per account, holding or asset for as_of (default today). Earlier values stay.",
      inputSchema: {
        as_of: DATE.optional(),
        items: z.array(z.object({ subject_kind: z.enum(["account", "holding", "asset"]), subject_id: ID, amount_cents: z.number().int(), currency: z.string().regex(/^[A-Z]{3}$/), note: z.string().max(2000).optional() })).min(1).max(200),
      },
      annotations: RW,
    }, tool("finance_balances", (api, a) => api.balances(fp, { as_of: a.as_of, items: a.items })));
    server.registerTool("finance_deadline_done", { description: "Mark a deadline done. A repeating one gets its next date; the answer names the new row.", inputSchema: { id: ID }, annotations: RW },
      tool("finance_deadline_done", (api, a) => api.deadlineDone(fp, a.id)));
  }
  if (can("finance.archive")) {
    server.registerTool("finance_archive", {
      description: "Hide a row (archived true) or bring it back (false). Nothing is ever deleted.",
      inputSchema: { table: TABLE, id: ID, archived: z.boolean().default(true) }, annotations: RW,
    }, tool("finance_archive", (api, a) => api.archive(fp, a.table, a.id, a.archived)));
  }
  return server;
}
