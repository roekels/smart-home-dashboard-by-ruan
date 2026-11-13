// /api/finance/*: the Finance page's API. Admins only (the shell checks before calling financeRoute); every write
// lands in the audit with the names of the fields that changed, never their values. Nothing here is logged.
//   GET  /api/finance/overview[?days=90]           net worth by group and owner, coming deadlines, assets
//   GET  /api/finance/history                      net worth at each month end
//   GET  /api/finance/schema                       the tables' fields, categories, owners, currencies (the page's forms)
//   GET  /api/finance/<table>[?asset=&from=&to=&q=&archived=1]   rows (dated tables newest first, at most 1000)
//   GET  /api/finance/<table>/<id>
//   POST /api/finance/<table>                      create; POST /api/finance/<table>/<id> update (only the fields sent)
//   POST /api/finance/<table>/<id>/archive         { archived: true | false }; nothing is ever deleted
//   POST /api/finance/valuations/batch             { as_of, items: [{ subject_kind, subject_id, amount_cents, currency }] }
//   POST /api/finance/deadlines/<id>/done          marks it done; a repeating one gets its next date
// Money is integer cents in the row's own currency; totals are in the household's base currency.
import type { Household, Person } from "../../../packages/core/src/household.ts";
import { addDays, isDate, localDate, newId } from "../../../packages/core/src/ids.ts";
import { SealError, sealer } from "../../../packages/core/src/seal.ts";
import { HttpError, json } from "../../../packages/core/src/util.ts";
import { syncRates, useCurrency } from "./fx.ts";
import { type Account, type Asset, type Contract, type Holding, type Valuation, netWorth, nextDue, upcoming } from "./money.ts";
import { CATEGORIES, CURRENCIES, DAY_FIELD, FieldError, TABLES, TABLE_NAMES, type TableName, clean, ownersOf } from "./schema.ts";
import { FINANCE_SEAL_LABEL, FINANCE_SECRET, type FinanceStore, type Stored, sealedStore } from "./store.ts";

export interface FinanceEnv { FINANCE_DB?: D1Database; FINANCE_DATA_ENCRYPTION_KEY?: string }

export interface FinanceCtx {
  store: FinanceStore;
  /** Who is acting, for the audit: a person id, "oauth:<app> (<person id>)" or a key name. */
  actor: string;
  /** Who can own things: the household's person ids plus "joint". */
  owners: string[];
  /** The household's currency: what totals are shown in. */
  base: string;
  /** Today in the household's time zone, YYYY-MM-DD. */
  today: string;
}

export const ID = /^[a-z]+_[A-Za-z0-9_-]{4,40}$/;
export const isTable = (s: string): s is TableName => (TABLE_NAMES as string[]).includes(s);
const tableOf = (id: string): TableName | null => TABLE_NAMES.find((t) => id.startsWith(TABLES[t].prefix)) ?? null;

/** A row as the page and the tools get it: every field of its table (null when empty) plus the row's own stamps. */
export function shape(r: Stored): Record<string, unknown> {
  const out: Record<string, unknown> = { id: r.id };
  for (const k of Object.keys(TABLES[r.tbl].fields)) out[k] = r.data[k] ?? null;
  if (r.tbl === "deadlines") { out.done = r.data.done ?? null; out.done_by = r.data.done_by ?? null; }
  return { ...out, created: r.created, updated: r.updated, archived: r.archived };
}

function ready(c: FinanceCtx): void {
  if (!c.store.ready) throw new SealError(`${FINANCE_SECRET} is not set: this data is locked`);
}

async function live(c: FinanceCtx, table: TableName, id: string): Promise<Stored | null> {
  const r = await c.store.row(id);
  return r && r.tbl === table ? r : null;
}

/** Every ref field (and a valuation's subject) must name a row that is there. */
async function checkRefs(c: FinanceCtx, table: TableName, row: Record<string, unknown>, current?: Record<string, unknown>): Promise<void> {
  for (const [k, f] of Object.entries(TABLES[table].fields)) {
    const v = row[k];
    if (f.t === "ref" && typeof v === "string" && !(await live(c, f.to, v))) throw new FieldError(`${k}: no such ${f.to} row`);
  }
  if (table === "valuations") {
    const kind = (row.subject_kind ?? current?.subject_kind) as string, id = (row.subject_id ?? current?.subject_id) as string;
    const to = ({ account: "accounts", holding: "holdings", asset: "assets" } as const)[kind as "account"];
    if (!to || !(await live(c, to, id))) throw new FieldError(`subject: no such ${kind}`);
  }
}

/** One return per person, year and kind. */
async function checkTaxYear(c: FinanceCtx, data: Record<string, unknown>, self?: string): Promise<void> {
  const same = (await c.store.rows("tax_years", { archived: true }))
    .some((r) => r.id !== self && r.data.year === data.year && r.data.person === data.person && r.data.kind === data.kind);
  if (same) throw new FieldError("there is already a tax year for this person, year and kind");
}

const day = (table: TableName, data: Record<string, unknown>): string | null => {
  const f = DAY_FIELD[table];
  return f && typeof data[f] === "string" ? (data[f] as string) : null;
};

async function noteCurrency(c: FinanceCtx, data: Record<string, unknown>): Promise<void> {
  if (typeof data.currency === "string" && c.store.currency) await c.store.currency(data.currency);
}

export interface ListQuery { asset?: string; from?: string; to?: string; q?: string; archived?: boolean; limit?: number }

export async function list(c: FinanceCtx, table: TableName, q: ListQuery = {}): Promise<Record<string, unknown>[]> {
  ready(c);
  for (const k of ["from", "to"] as const) if (q[k] !== undefined && !isDate(q[k])) throw new FieldError(`${k} must be YYYY-MM-DD`);
  const dated = !!DAY_FIELD[table];
  let rows = await c.store.rows(table, { archived: q.archived, ...(dated ? { from: q.from, to: q.to } : {}) });
  if (q.asset && "asset_id" in TABLES[table].fields) rows = rows.filter((r) => r.data.asset_id === q.asset);
  const text = q.q?.trim().toLowerCase();
  if (text) rows = rows.filter((r) => Object.values(r.data).some((v) => typeof v === "string" && v.toLowerCase().includes(text)));
  const name = (r: Stored) => String(r.data.name ?? r.data.title ?? "");
  if (dated) rows.sort((a, b) => (b.day ?? "").localeCompare(a.day ?? "") || b.created - a.created);
  else if (table === "accounts" || table === "assets" || table === "institutions") rows.sort((a, b) => name(a).localeCompare(name(b)));
  return rows.slice(0, Math.min(Math.max(q.limit ?? 1000, 1), 1000)).map(shape);
}

export async function get(c: FinanceCtx, table: TableName, id: string): Promise<Record<string, unknown> | null> {
  ready(c);
  const r = await live(c, table, id);
  return r ? shape(r) : null;
}

export async function create(c: FinanceCtx, table: TableName, body: unknown): Promise<{ id: string }> {
  ready(c);
  const data = clean(table, body, c.owners);
  await checkRefs(c, table, data);
  if (table === "tax_years") await checkTaxYear(c, data);
  const id = newId(TABLES[table].prefix), now = Date.now();
  await c.store.put([{ id, tbl: table, day: day(table, data), data, created: now, updated: now, updated_by: c.actor, archived: null }]);
  await noteCurrency(c, data);
  await c.store.audit(c.actor, `${table}.create`, id, { fields: Object.keys(data) });
  return { id };
}

export async function update(c: FinanceCtx, table: TableName, id: string, body: unknown): Promise<{ ok: true }> {
  ready(c);
  const before = await live(c, table, id);
  if (!before) throw new FieldError("no such row");
  const change = clean(table, body, c.owners, true);
  if (!Object.keys(change).length) throw new FieldError("nothing to change");
  await checkRefs(c, table, change, before.data);
  const data = { ...before.data, ...change };
  if (table === "tax_years") await checkTaxYear(c, data, id);
  await c.store.put([{ ...before, day: day(table, data), data, updated: Date.now(), updated_by: c.actor }]);
  await noteCurrency(c, change);
  await c.store.audit(c.actor, `${table}.update`, id, { fields: Object.keys(change) });
  return { ok: true };
}

export async function archive(c: FinanceCtx, table: TableName, id: string, on: boolean): Promise<{ ok: true }> {
  ready(c);
  const r = await live(c, table, id);
  if (!r) throw new FieldError("no such row");
  await c.store.put([{ ...r, archived: on ? Date.now() : null, updated: Date.now(), updated_by: c.actor }]);
  await c.store.audit(c.actor, `${table}.${on ? "archive" : "restore"}`, id);
  return { ok: true };
}

/** "Update balances": one dated valuation per line, all in one go. */
export async function valuationBatch(c: FinanceCtx, body: any): Promise<{ ids: string[] }> {
  ready(c);
  const asOf = body?.as_of ?? c.today;
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || !items.length || items.length > 200) throw new FieldError("items: 1 to 200 lines");
  const now = Date.now(), rows: Stored[] = [];
  for (const it of items) {
    const data = clean("valuations", { source: "manual", ...it, as_of: asOf }, c.owners);
    await checkRefs(c, "valuations", data);
    rows.push({ id: newId("va_"), tbl: "valuations", day: data.as_of as string, data, created: now, updated: now, updated_by: c.actor, archived: null });
  }
  await c.store.put(rows);
  for (const r of rows) await noteCurrency(c, r.data);
  await c.store.audit(c.actor, "valuations.batch", asOf, { count: rows.length });
  return { ids: rows.map((r) => r.id) };
}

export async function deadlineDone(c: FinanceCtx, id: string): Promise<{ ok: true; next: string | null }> {
  ready(c);
  const d = await live(c, "deadlines", id);
  if (!d || d.archived !== null) throw new FieldError("no such deadline");
  if (d.data.done) throw new HttpError(409, "already done");
  const now = Date.now();
  const put: Stored[] = [{ ...d, data: { ...d.data, done: c.today, done_by: c.actor }, updated: now, updated_by: c.actor }];
  const next = nextDue(String(d.data.due), String(d.data.repeat ?? "none"));
  let nextId: string | null = null;
  if (next) {
    nextId = newId("dl_");
    put.push({ id: nextId, tbl: "deadlines", day: next, data: { ...d.data, due: next }, created: now, updated: now, updated_by: c.actor, archived: null });
  }
  await c.store.put(put);
  await c.store.audit(c.actor, "deadlines.done", id, { next: nextId });
  return { ok: true, next: nextId };
}

async function load(c: FinanceCtx) {
  const [accounts, holdings, assets, valuations, rates] = await Promise.all([
    c.store.rows("accounts"), c.store.rows("holdings"), c.store.rows("assets"), c.store.rows("valuations"), c.store.rates(),
  ]);
  const flat = <T>(rows: Stored[]) => rows.map((r) => ({ id: r.id, ...r.data })) as T[];
  return { accounts: flat<Account>(accounts), holdings: flat<Holding>(holdings), assets: flat<Asset>(assets), valuations: flat<Valuation>(valuations), rates, assetRows: assets };
}

export async function overview(c: FinanceCtx, days = 90) {
  ready(c);
  const span = Math.min(Math.max(Math.trunc(days) || 90, 1), 730);
  const data = await load(c);
  const [deadlines, contracts] = await Promise.all([c.store.rows("deadlines"), c.store.rows("contracts")]);
  const open = deadlines.filter((d) => !d.data.done).map((d) => ({ id: d.id, ...d.data })) as any[];
  const latest = (cur: string) => data.rates.filter((r) => r.currency === cur).sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
  const foreign = [...new Set(data.rates.map((r) => r.currency))].filter((cur) => cur !== c.base).sort();
  return {
    today: c.today, base: c.base, ...netWorth(data, c.today, c.base),
    upcoming: upcoming(open, contracts.map((r) => ({ id: r.id, ...r.data })) as Contract[], c.today, addDays(c.today, span)),
    assets: data.assetRows.map(shape).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    /** The newest ECB rate of each currency in use: 1 EUR = per_eur units. */
    rates: [...foreign, ...(c.base === "EUR" ? [] : [c.base])].map(latest).filter(Boolean),
    owners: c.owners,
  };
}

/** Net worth at each month end since the first balance, from the values known on that day. */
export async function history(c: FinanceCtx) {
  ready(c);
  const data = await load(c);
  // from the first account or holding balance (a purchase price years earlier would start an empty chart)
  const money = data.valuations.filter((v) => v.subject_kind !== "asset");
  const first = (money.length ? money : data.valuations).reduce<string | null>((m, v) => (!m || v.as_of < m ? v.as_of : m), null);
  if (!first) return { base: c.base, points: [] };
  const points = [];
  let d = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 0));   // end of the first month
  for (let i = 0; i < 400; i++) {
    const at = d.toISOString().slice(0, 10) > c.today ? c.today : d.toISOString().slice(0, 10);
    const nw = netWorth({ ...data, valuations: data.valuations.filter((v) => v.as_of <= at), anchors: data.valuations }, at, c.base);
    points.push({ date: at, ...nw.totals, byOwner: nw.byOwner });
    if (at === c.today) break;
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0));
  }
  return { base: c.base, points };
}

export const schema = (c: FinanceCtx) => ({ tables: TABLES, categories: CATEGORIES, owners: c.owners, currencies: CURRENCIES, base: c.base, locked: !c.store.ready });

const q = (url: URL, k: string) => url.searchParams.get(k) ?? undefined;

export async function financeApi(req: Request, url: URL, c: FinanceCtx, write: boolean): Promise<Response> {
  const parts = url.pathname.slice("/api/finance/".length).split("/");
  try {
    if (req.method === "GET") {
      if (parts.length === 1 && parts[0] === "schema") return json(schema(c));
      if (parts.length === 1 && parts[0] === "overview") return json(await overview(c, Number(q(url, "days") ?? 90)));
      if (parts.length === 1 && parts[0] === "history") return json(await history(c));
      if (!isTable(parts[0])) throw new HttpError(404, "not found");
      if (parts.length === 1) return json({ [parts[0]]: await list(c, parts[0], { asset: q(url, "asset"), from: q(url, "from"), to: q(url, "to"), q: q(url, "q"), archived: q(url, "archived") === "1" }) });
      if (parts.length === 2 && ID.test(parts[1])) {
        const row = await get(c, parts[0], parts[1]);
        if (!row) throw new HttpError(404, "no such row");
        return json(row);
      }
      throw new HttpError(404, "not found");
    }
    if (req.method !== "POST") throw new HttpError(405, "method not allowed");
    if (!write) throw new HttpError(403, "cross-site write refused");
    const body: any = await req.json().catch(() => null);
    const [table, id, action] = parts;
    if (table === "valuations" && id === "batch" && !action) return json(await valuationBatch(c, body), 201);
    if (!isTable(table)) throw new HttpError(404, "not found");
    if (!id) return json(await create(c, table, body), 201);
    if (!ID.test(id) || tableOf(id) !== table) throw new HttpError(404, "no such row");
    if (!action) return json(await update(c, table, id, body));
    if (action === "archive" && parts.length === 3) return json(await archive(c, table, id, body?.archived !== false));
    if (action === "done" && table === "deadlines" && parts.length === 3) return json(await deadlineDone(c, id));
    throw new HttpError(404, "not found");
  } catch (e) {
    if (e instanceof FieldError) throw new HttpError(/^no such (row|deadline)$/.test(e.message) ? 404 : 400, e.message);
    if (e instanceof SealError) throw new HttpError(503, e.message);
    throw e;
  }
}

/** The store's context for one caller, or why there is none. */
export function financeCtx(env: FinanceEnv, h: Household, actor: string, fetcher?: typeof fetch): FinanceCtx {
  const db = env.FINANCE_DB;
  if (!db) throw new HttpError(503, "the finance database is not set up");
  const today = localDate(h.timezone);
  // a currency used for the first time: fetch its rates now, so the totals do not wait for tomorrow's cron
  const onCurrency = async (code: string) => {
    const fresh = await useCurrency(db, code), base = await useCurrency(db, h.currency);
    if (fresh || base) await syncRates(db, today, h.currency, fetcher, [code, h.currency]).catch(() => 0);
  };
  return { store: sealedStore(db, sealer(env.FINANCE_DATA_ENCRYPTION_KEY, FINANCE_SEAL_LABEL, FINANCE_SECRET), onCurrency), actor, owners: ownersOf(h.people), base: h.currency, today };
}

/** The shell's handler for /api/finance/*: admins only, checked on every request (the menu is not the check). */
export function financeRoute(req: Request, url: URL, env: FinanceEnv, h: Household, person: Person, write: boolean): Promise<Response> {
  if (!person.admin) throw new HttpError(403, "finance is open to admins only");
  return financeApi(req, url, financeCtx(env, h, person.id), write);
}
