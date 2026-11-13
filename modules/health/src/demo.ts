// Health in demo mode: the made-up records from demo/data/health.json, read-only. The same pure functions the
// real store uses work out the overview, the trends and Today's reminders, so the demo shows the real shapes.
import type { Household, Person } from "../../../packages/core/src/household.ts";
import { addDays } from "../../../packages/core/src/ids.ts";
import { HttpError, json } from "../../../packages/core/src/util.ts";
import { visibleTo } from "./api.ts";
import { FIELDS } from "./schema.ts";
import { type HealthRecord, mineOf, overviewOf, trendsOf } from "./store.ts";

export interface DemoHealth { records: { id: string; person: string; type: string; date: string; data: Record<string, unknown> }[] }

/** "@-40" -> the date 40 days before today, anywhere in a value. */
export function relativeDates<T>(v: T, today: string): T {
  if (typeof v === "string") return (/^@-?\d+$/.test(v) ? addDays(today, Number(v.slice(1))) : v) as T;
  if (Array.isArray(v)) return v.map((x) => relativeDates(x, today)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, relativeDates(x, today)])) as T;
  return v;
}

export function demoRecords(seed: DemoHealth, today: string): HealthRecord[] {
  return relativeDates(seed.records, today)
    .map((r): HealthRecord => ({ ...r, type: r.type as HealthRecord["type"], created: 0, created_by: "demo", updated: 0, updated_by: "demo", archived: null }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** GET /api/health/* in demo mode. Anything that would change a record is refused. */
export function demoHealthApi(req: Request, url: URL, h: Household, person: Person, seed: DemoHealth, today: string): Response {
  if (req.method !== "GET") throw new HttpError(403, "The demo is read-only: nothing is saved.");
  const visible = visibleTo(h, person);
  const all = demoRecords(seed, today).filter((r) => visible.includes(r.person));
  const of = (who: string) => all.filter((r) => r.person === who);
  const p = url.pathname.replace(/^\/api\/health/, ""), q = (k: string) => url.searchParams.get(k) ?? undefined;
  if (p === "/schema") return json({ people: visible, fields: FIELDS, locked: false });
  if (p === "/mine") return json(mineOf(person.id, of(person.id), today));
  if (p === "/overview") return json(Object.fromEntries(visible.filter((v) => !q("person") || v === q("person")).map((v) => [v, overviewOf(of(v), today)])));
  if (p === "/records") return json({ records: all.filter((r) => (!q("person") || r.person === q("person")) && (!q("type") || r.type === q("type"))) });
  if (p === "/trends") return json({ series: trendsOf(of(q("person") ?? ""), q("name")) });
  const one = all.find((r) => `/records/${r.id}` === p);
  if (one) return json(one);
  throw new HttpError(404, "not found");
}
