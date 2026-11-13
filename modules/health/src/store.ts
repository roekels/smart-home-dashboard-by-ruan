// The health store on D1 <prefix>-health. One `records` table for all four types; everything but whose, which type
// and which date is sealed. Used by the Health page (api.ts) and by the gateway's /health/mcp (entry.ts).
// Nothing is deleted: archive hides a record, and every change keeps the old sealed data in `versions`. The audit
// says who touched which record, never what is in it.
//
// Who sees what: a context carries `visible`, the person ids the caller may read and write. A record of anyone
// else does not exist for that caller.
import { addDays, newId } from "../../../packages/core/src/ids.ts";
import type { Sealer } from "../../../packages/core/src/seal.ts";
import { type RecordType, type Result, FieldError, TYPES, analyteKey, clean, flag, isDate, numeric } from "./schema.ts";

export const HEALTH_SECRET = "HEALTH_DATA_ENCRYPTION_KEY";
/** Part of the key derivation. Never change it: sealed records could no longer be opened. */
export const HEALTH_SEAL_LABEL = "health";

export interface HealthCtx {
  db: D1Database;
  /** Seals with HEALTH_DATA_ENCRYPTION_KEY. Secret unset: reads and writes fail with a clear message (fails closed). */
  seal: Sealer;
  /** Who is acting, for the audit: a person id, or "oauth:<app> (<person id>)", or a key name. */
  actor: string;
  /** Whose records can exist: the person ids of the household config. */
  people: string[];
  /** The person ids this caller may read and write. */
  visible: string[];
  /** Today in the household's time zone, YYYY-MM-DD. */
  today: string;
}

export interface HealthRecord {
  id: string;
  person: string;
  type: RecordType;
  date: string;
  data: Record<string, unknown>;
  created: number;
  created_by: string;
  updated: number;
  updated_by: string;
  archived: number | null;
}

interface Row extends Omit<HealthRecord, "data"> { data: string }

const PREFIX: Record<RecordType, string> = { visit: "hv_", test: "ht_", vaccination: "hx_", medication: "hm_" };
export const ID = /^h[vtxm]_[A-Za-z0-9_-]{4,40}$/;

async function audit(c: HealthCtx, action: string, target: string | null): Promise<void> {
  await c.db.prepare("INSERT INTO audit (ts, actor, action, target) VALUES (?, ?, ?, ?)").bind(Date.now(), c.actor, action, target).run();
}

function checkPerson(c: HealthCtx, person: unknown): string {
  const p = String(person ?? "").toLowerCase();
  if (!c.people.includes(p)) throw new FieldError(`person must be one of ${c.people.join(", ")}`);
  if (!c.visible.includes(p)) throw new FieldError(`the records of ${p} are not open to you`);
  return p;
}

function checkType(type: unknown): RecordType {
  if (!TYPES.includes(type as RecordType)) throw new FieldError(`type must be one of ${TYPES.join(", ")}`);
  return type as RecordType;
}

/** A medication's `visit` must be a visit of the same person. */
async function checkVisit(c: HealthCtx, person: string, data: Record<string, unknown>): Promise<void> {
  if (typeof data.visit !== "string") return;
  const v = await c.db.prepare("SELECT person, type FROM records WHERE id = ?").bind(data.visit).first<{ person: string; type: string }>();
  if (!v || v.type !== "visit" || !c.visible.includes(v.person)) throw new FieldError(`visit ${data.visit} does not exist`);
  if (v.person !== person) throw new FieldError(`visit ${data.visit} belongs to ${v.person}, not ${person}`);
}

async function open(c: HealthCtx, r: Row): Promise<HealthRecord> {
  return { ...r, data: await c.seal.unseal<Record<string, unknown>>(r.data) };
}

export interface ListQuery { person?: string; type?: string; from?: string; to?: string; archived?: boolean }

export async function list(c: HealthCtx, q: ListQuery = {}): Promise<HealthRecord[]> {
  const who = q.person ? [checkPerson(c, q.person)] : c.visible.filter((p) => c.people.includes(p));
  if (!who.length) return [];
  const where: string[] = [`person IN (${who.map(() => "?").join(", ")})`], args: unknown[] = [...who];
  if (q.type) { where.push("type = ?"); args.push(checkType(q.type)); }
  for (const [k, op] of [["from", ">="], ["to", "<="]] as const) {
    const d = q[k];
    if (d === undefined) continue;
    if (!isDate(d)) throw new FieldError(`${k} must be YYYY-MM-DD`);
    where.push(`date ${op} ?`); args.push(d);
  }
  if (!q.archived) where.push("archived IS NULL");
  const sql = `SELECT * FROM records WHERE ${where.join(" AND ")} ORDER BY date DESC, created DESC LIMIT 2000`;
  const rows = (await c.db.prepare(sql).bind(...args).all<Row>()).results ?? [];
  return Promise.all(rows.map((r) => open(c, r)));
}

/** One record, or null when there is none or it belongs to someone this caller may not see. */
export async function get(c: HealthCtx, id: string): Promise<HealthRecord | null> {
  if (!ID.test(id)) throw new FieldError("not a health record id");
  const r = await c.db.prepare("SELECT * FROM records WHERE id = ?").bind(id).first<Row>();
  return r && c.visible.includes(r.person) ? open(c, r) : null;
}

export interface AddInput { type: string; person: string; date: string; data: unknown }

export async function add(c: HealthCtx, input: AddInput): Promise<{ id: string }> {
  const type = checkType(input.type), person = checkPerson(c, input.person);
  if (!isDate(input.date)) throw new FieldError("date must be YYYY-MM-DD");
  const data = clean(type, input.data);
  await checkVisit(c, person, data);
  const sealed = await c.seal.seal(data);
  const id = newId(PREFIX[type]), now = Date.now();
  await c.db.prepare("INSERT INTO records (id, person, type, date, data, created, created_by, updated, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, person, type, input.date, sealed, now, c.actor, now, c.actor).run();
  await audit(c, `${type}.add`, id);
  return { id };
}

export interface UpdateInput { date?: string; person?: string; data?: unknown }

/** Changes only what is sent; a field set to null is cleared. The previous version is kept. */
export async function update(c: HealthCtx, id: string, input: UpdateInput): Promise<HealthRecord> {
  const cur = await get(c, id);
  if (!cur) throw new FieldError("no such record");
  if (input.date !== undefined && !isDate(input.date)) throw new FieldError("date must be YYYY-MM-DD");
  const person = input.person !== undefined ? checkPerson(c, input.person) : cur.person;
  const patch = input.data === undefined ? {} : clean(cur.type, input.data, true);
  const data: Record<string, unknown> = { ...cur.data };
  for (const [k, v] of Object.entries(patch)) if (v === null) delete data[k]; else data[k] = v;
  await checkVisit(c, person, data);
  const now = Date.now();
  const old = await c.db.prepare("SELECT data FROM records WHERE id = ?").bind(id).first<{ data: string }>();
  await c.db.batch([
    c.db.prepare("INSERT INTO versions (record_id, ts, actor, data) VALUES (?, ?, ?, ?)").bind(id, now, c.actor, old!.data),
    c.db.prepare("UPDATE records SET person = ?, date = ?, data = ?, updated = ?, updated_by = ? WHERE id = ?")
      .bind(person, input.date ?? cur.date, await c.seal.seal(data), now, c.actor, id),
  ]);
  await audit(c, `${cur.type}.update`, id);
  return (await get(c, id))!;
}

export async function archive(c: HealthCtx, id: string, archived: boolean): Promise<{ id: string; archived: boolean }> {
  const cur = await get(c, id);
  if (!cur) throw new FieldError("no such record");
  await c.db.prepare("UPDATE records SET archived = ?, updated = ?, updated_by = ? WHERE id = ?").bind(archived ? Date.now() : null, Date.now(), c.actor, id).run();
  await audit(c, `${cur.type}.${archived ? "archive" : "unarchive"}`, id);
  return { id, archived };
}

// ---------------------------------------------------------------- what the page shows, worked out from records
// Pure functions over opened records (newest first), so the demo can use them on made-up data.

export interface Point { date: string; test: string; value: string; num: number | null; flag: "low" | "high" | null }
export interface Series { name: string; group?: string; unit?: string; low?: number; high?: number; ref?: string; points: Point[] }

/** Every analyte across one person's tests, oldest first: the trend table and charts. `name` narrows to one. */
export function trendsOf(tests: HealthRecord[], name?: string): Series[] {
  const by = new Map<string, Series>();
  for (const t of [...tests].filter((r) => r.type === "test").reverse()) {
    for (const r of (t.data.results as Result[] | undefined) ?? []) {
      const key = analyteKey(r.name);
      if (name && !key.includes(analyteKey(name))) continue;
      let s = by.get(key);
      if (!s) by.set(key, (s = { name: r.name, group: r.group, unit: r.unit, points: [] }));
      // the newest report's range and unit win
      for (const k of ["unit", "low", "high", "ref", "group"] as const) if (r[k] !== undefined) (s as any)[k] = r[k];
      s.points.push({ date: t.date, test: t.id, value: r.value, num: numeric(r.value), flag: flag(r) });
    }
  }
  return [...by.values()];
}

export interface PersonOverview {
  counts: Record<RecordType, number>;
  current_meds: { id: string; name: unknown; for: unknown; dose: unknown; schedule: unknown; since: string; until: unknown }[];
  vaccinations_due: { id: string; for: unknown; due: unknown; overdue: boolean }[];
  last_test: { id: string; date: string; title: unknown; flagged: { name: string; value: string; unit?: string; flag: "low" | "high" | null }[] } | null;
  recent_visits: { id: string; date: string; what: unknown; who: unknown; follow_up: unknown; healthy_on: unknown }[];
}

/** One person's front page: what is coming up and what was last. `mine` = that person's records, newest first. */
export function overviewOf(mine: HealthRecord[], today: string): PersonOverview {
  const soon = addDays(today, 90);
  const vacc = mine.filter((r) => r.type === "vaccination");
  // the newest shot per disease decides when it is due
  const latest = new Map<string, HealthRecord>();
  for (const v of vacc) {
    const k = String(v.data.for).toLowerCase();
    if (!latest.has(k)) latest.set(k, v);
  }
  const due = [...latest.values()].filter((v) => typeof v.data.due === "string" && v.data.due <= soon)
    .map((v) => ({ id: v.id, for: v.data.for, due: v.data.due, overdue: (v.data.due as string) < today }))
    .sort((a, b) => String(a.due).localeCompare(String(b.due)));
  const visits = mine.filter((r) => r.type === "visit");
  const tests = mine.filter((r) => r.type === "test");
  const lastTest = tests[0];
  // taking now: no stop date, or one still ahead
  const meds = mine.filter((r) => r.type === "medication");
  const current = meds.filter((m) => typeof m.data.until !== "string" || m.data.until >= today)
    .map((m) => ({ id: m.id, name: m.data.name, for: m.data.for ?? null, dose: m.data.dose ?? null, schedule: m.data.schedule ?? null, since: m.date, until: m.data.until ?? null }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const flagged = lastTest ? ((lastTest.data.results as Result[] | undefined) ?? []).filter((r) => flag(r)).map((r) => ({ name: r.name, value: r.value, unit: r.unit, flag: flag(r) })) : [];
  return {
    counts: { visit: visits.length, test: tests.length, vaccination: vacc.length, medication: meds.length },
    current_meds: current,
    vaccinations_due: due,
    last_test: lastTest ? { id: lastTest.id, date: lastTest.date, title: lastTest.data.title ?? lastTest.data.kind, flagged } : null,
    recent_visits: visits.slice(0, 5).map((v) => ({ id: v.id, date: v.date, what: v.data.what, who: v.data.who ?? null, follow_up: v.data.follow_up ?? null, healthy_on: v.data.healthy_on ?? null })),
  };
}

export interface Mine {
  person: string | null;
  vaccinations_due: PersonOverview["vaccinations_due"];
  current_meds: { id: string; name: unknown; dose: unknown; schedule: unknown }[];
  follow_ups: { id: string; date: string; what: unknown; follow_up: unknown }[];
}

/** Today's reminders for one person, and only what needs doing: shots overdue or due within 90 days, medication
 *  taken now, follow-ups from visits of the last 120 days. */
export function mineOf(person: string, mine: HealthRecord[], today: string): Mine {
  const o = overviewOf(mine, today);
  const since = addDays(today, -120);
  return {
    person,
    vaccinations_due: o.vaccinations_due,
    current_meds: o.current_meds.map((m) => ({ id: m.id, name: m.name, dose: m.dose, schedule: m.schedule })),
    follow_ups: o.recent_visits.filter((v) => v.follow_up && !v.healthy_on && v.date >= since).map((v) => ({ id: v.id, date: v.date, what: v.what, follow_up: v.follow_up })),
  };
}

export async function trends(c: HealthCtx, person: string, name?: string): Promise<Series[]> {
  return trendsOf(await list(c, { person, type: "test" }), name);
}

/** Per person the caller may see (or just `person`): the overview. */
export async function overview(c: HealthCtx, person?: string): Promise<Record<string, PersonOverview>> {
  const all = await list(c, person ? { person } : {});
  const who = person ? [checkPerson(c, person)] : c.visible.filter((p) => c.people.includes(p));
  return Object.fromEntries(who.map((p) => [p, overviewOf(all.filter((r) => r.person === p), c.today)]));
}

/** The caller's own reminders. `self` is the signed-in person's id; never anyone else's. */
export async function mine(c: HealthCtx, self: string): Promise<Mine> {
  if (!c.people.includes(self)) return { person: null, vaccinations_due: [], current_meds: [], follow_ups: [] };
  const own: HealthCtx = { ...c, visible: [self] };
  return mineOf(self, await list(own, { person: self }), c.today);
}
