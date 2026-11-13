// Finance in demo mode: the made-up records from demo/data/finance.json in a memory store, read-only, behind the
// real API code. Each line's `value` (today's balance) and `monthly` (change per month) become two years of
// month-end balances, so the net worth line has something to draw.
import type { Household, Person } from "../../../packages/core/src/household.ts";
import { addDays } from "../../../packages/core/src/ids.ts";
import { HttpError } from "../../../packages/core/src/util.ts";
import { financeApi } from "./api.ts";
import type { Rate } from "./money.ts";
import { DAY_FIELD, TABLE_NAMES, type TableName, ownersOf } from "./schema.ts";
import { type Stored, memoryStore } from "./store.ts";

export type DemoFinance = { rates: Record<string, number> } & Partial<Record<TableName, Record<string, unknown>[]>>;

const MONTHS = 24;
const relative = (v: unknown, today: string): unknown => (typeof v === "string" && /^@-?\d+$/.test(v) ? addDays(today, Number(v.slice(1))) : v);

export function demoSeed(seed: DemoFinance, today: string): { rows: Stored[]; rates: Rate[] } {
  const rows: Stored[] = [];
  const put = (tbl: TableName, id: string, data: Record<string, unknown>) => {
    const f = DAY_FIELD[tbl];
    rows.push({ id, tbl, day: f && typeof data[f] === "string" ? (data[f] as string) : null, data, created: rows.length, updated: 0, updated_by: "demo", archived: null });
  };
  const monthEnd = (back: number) => {
    const [y, m] = today.split("-").map(Number);
    return back === 0 ? today : new Date(Date.UTC(y, m - 1 - back + 1, 0)).toISOString().slice(0, 10);
  };
  for (const tbl of TABLE_NAMES) {
    for (const raw of seed[tbl] ?? []) {
      const { id, value, monthly, ...rest } = raw as { id: string; value?: number; monthly?: number } & Record<string, unknown>;
      put(tbl, id, Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, relative(v, today)])));
      if (typeof value !== "number") continue;
      const kind = ({ accounts: "account", holdings: "holding", assets: "asset" } as Record<string, string>)[tbl];
      for (let back = MONTHS; back >= 0; back--) {
        // a gentle, repeatable wobble so the line is not a ruler
        const wobble = Math.round(Math.sin(back * 1.7 + id.length) * Math.abs(monthly ?? 0) * 0.6);
        put("valuations", `va_demo_${id}_${back}`, {
          subject_kind: kind, subject_id: id, as_of: monthEnd(back), amount_cents: Math.max(0, value - (monthly ?? 0) * back + (back ? wobble : 0)),
          currency: rest.currency ?? "EUR", source: tbl === "assets" ? "estimate" : "manual",
        });
      }
    }
  }
  const rates: Rate[] = Object.entries(seed.rates).flatMap(([currency, per_eur]) => [{ date: addDays(today, -800), currency, per_eur }, { date: addDays(today, -1), currency, per_eur }]);
  return { rows, rates };
}

/** GET /api/finance/* in demo mode, for the made-up family's admins. Anything that would change a row is refused. */
export function demoFinanceApi(req: Request, url: URL, h: Household, person: Person, seed: DemoFinance, today: string): Promise<Response> {
  if (!person.admin) throw new HttpError(403, "finance is open to admins only");
  if (req.method !== "GET") throw new HttpError(403, "The demo is read-only: nothing is saved.");
  return financeApi(req, url, { store: memoryStore(demoSeed(seed, today)), actor: person.id, owners: ownersOf(h.people), base: h.currency, today }, false);
}
