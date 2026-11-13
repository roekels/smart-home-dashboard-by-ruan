// The finance page's arithmetic, kept pure so the tests cover it: currency conversion, the loan balance from its
// terms, net worth by group and owner, and the deadlines a contract implies. No Worker-only globals here.

export interface Rate { date: string; currency: string; per_eur: number }
export interface Valuation { subject_kind: string; subject_id: string; as_of: string; amount_cents: number; currency: string; source: string }
export interface Account { id: string; name: string; kind: string; owner: string; currency: string | null; details: any; closed: string | null; asset_id?: string | null }
export interface Holding { id: string; account_id: string; name: string; owner: string; currency: string }
export interface Asset { id: string; name: string; kind: string; role: string; owner: string }
export interface Contract {
  id: string; name: string; kind: string; asset_id: string | null; starts: string | null; ends: string | null;
  notice_days: number | null; renews: string; every: string | null; amount_cents: number | null; currency: string;
}

export type Group = "cash" | "investments" | "property" | "car" | "debts";
export const DEBT_KINDS = new Set(["loan", "credit_card"]);
const ACCOUNT_GROUP: Record<string, Group> = {
  current: "cash", savings: "cash", high_yield: "cash", deposit: "cash", cash: "cash", other: "cash",
  brokerage: "investments", crypto: "investments", pension: "investments", commodity: "investments", loan: "debts", credit_card: "debts",
};

const DAY = 86_400_000;
export const addDays = (d: string, n: number): string => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
export function addMonths(d: string, n: number): string {
  const [y, m, day] = d.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t.toISOString().slice(0, 10);
}
const STEP: Record<string, number> = { month: 1, quarter: 3, year: 12, "2year": 24 };
export const nextDue = (due: string, repeat: string): string | null => (STEP[repeat] ? addMonths(due, STEP[repeat]) : null);

/** The ECB rate of that day or the closest earlier one (else the earliest known): 1 EUR = this many units. */
export function rateOn(currency: string, date: string, rates: readonly Rate[]): number | null {
  if (currency === "EUR") return 1;
  let best: Rate | null = null, first: Rate | null = null;
  for (const r of rates) {
    if (r.currency !== currency) continue;
    if (!first || r.date < first.date) first = r;
    if (r.date <= date && (!best || r.date > best.date)) best = r;
  }
  return (best ?? first)?.per_eur ?? null;
}

/** Amount in cents of the household's base currency. The ECB quotes everything against the euro, so two
 * currencies that are both not the euro convert through it. Null: no rate known for one of them. */
export function toBase(cents: number, currency: string, date: string, rates: readonly Rate[], base = "EUR"): number | null {
  if (currency === base) return cents;
  const from = rateOn(currency, date, rates), to = rateOn(base, date, rates);
  return from === null || to === null ? null : Math.round((cents / from) * to);
}

/**
 * What is still owed on an annuity loan after the payments made by `on`: details { principal_cents, rate_pct,
 * payment_cents, first_payment (YYYY-MM-DD), payments }. Null when the terms are incomplete.
 */
export function loanBalance(details: any, on: string): number | null {
  const P = details?.principal_cents, A = details?.payment_cents, first = details?.first_payment, rate = details?.rate_pct;
  if (![P, A, rate].every((x) => typeof x === "number" && x >= 0) || typeof first !== "string") return null;
  if (first > on) return P;
  const r = rate / 100 / 12;
  let n = 0;
  while (n < (details.payments ?? 600) && addMonths(first, n) <= on) n++;
  const grow = (1 + r) ** n;
  const left = r === 0 ? P - A * n : P * grow - A * (grow - 1) / r;
  return Math.max(0, Math.round(left));
}

/**
 * What a loan owed on `on`, from the balances entered for it (anchors, any order) and its terms. Between two
 * balances it is a straight line; after the last one it keeps the pace of the last two (at least 90 days apart),
 * else follows the terms' schedule from there; before the first it follows the schedule back. Null: nothing known.
 */
export function loanAt(details: any, anchors: { as_of: string; amount_cents: number }[], on: string): number | null {
  const a = [...anchors].sort((x, y) => x.as_of.localeCompare(y.as_of));
  if (!a.length) return loanBalance(details, on);
  const t = (d: string) => loanBalance(details, d);
  const bySchedule = (from: { as_of: string; amount_cents: number }) => {
    const t0 = t(from.as_of), t1 = t(on);
    return t0 === null || t1 === null ? from.amount_cents : Math.max(0, from.amount_cents + t1 - t0);
  };
  const days = (x: string, y: string) => (Date.parse(y) - Date.parse(x)) / DAY;
  const next = a.findIndex((x) => x.as_of > on);
  if (next === 0) return bySchedule(a[0]);
  if (next > 0) {
    const p = a[next - 1], n = a[next];
    return Math.round(p.amount_cents + ((n.amount_cents - p.amount_cents) * days(p.as_of, on)) / days(p.as_of, n.as_of));
  }
  const last = a[a.length - 1], prev = a[a.length - 2];
  if (prev && days(prev.as_of, last.as_of) >= 90) {
    const perDay = Math.min(0, (last.amount_cents - prev.amount_cents) / days(prev.as_of, last.as_of));
    return Math.max(0, Math.round(last.amount_cents + perDay * days(last.as_of, on)));
  }
  return bySchedule(last);
}

/** One line of the balances. A loan secured on an owned asset carries that asset (`secured`); the asset line is
 * then `merged`: it still counts in the totals, the page shows the two as one line. */
export interface Line {
  subject_kind: string; id: string; name: string; group: Group; owner: string; base: number | null; amount_cents: number; currency: string;
  as_of: string | null; source: string | null; kind?: string;
  /** A holding: the account (platform) it is held in. */
  parent?: { id: string; name: string };
  secured?: { id: string; name: string; base: number | null; as_of: string | null }; merged?: boolean;
}

/** The newest value per subject, then one line per account, holding and owned asset, debts negative. */
export function netWorth(
  o: { accounts: Account[]; holdings: Holding[]; assets: Asset[]; valuations: Valuation[]; rates: Rate[]; anchors?: Valuation[] },
  today: string, base = "EUR",
): { lines: Line[]; totals: Record<Group | "net", number>; byOwner: Record<string, number>; unconverted: number } {
  const latest = new Map<string, Valuation>();
  for (const v of o.valuations) {
    const k = `${v.subject_kind}:${v.subject_id}`;
    const cur = latest.get(k);
    if (!cur || v.as_of > cur.as_of) latest.set(k, v);
  }
  const lines: Line[] = [];
  const valued = new Set(o.holdings.filter((h) => latest.has(`holding:${h.id}`)).map((h) => h.account_id));
  const push = (kind: string, id: string, name: string, group: Group, owner: string, v: { amount_cents: number; currency: string; as_of: string; source: string } | null) => {
    const b = v ? toBase(v.amount_cents, v.currency, v.as_of, o.rates, base) : 0;
    lines.push({ subject_kind: kind, id, name, group, owner, base: b === null ? null : group === "debts" ? -b : b,
      amount_cents: v?.amount_cents ?? 0, currency: v?.currency ?? base, as_of: v?.as_of ?? null, source: v?.source ?? null });
  };
  for (const a of o.accounts) {
    if (a.closed && a.closed <= today) continue;
    if (valued.has(a.id)) continue;                  // its holdings carry the value, so the account would count twice
    let v: { amount_cents: number; currency: string; as_of: string; source: string } | null = latest.get(`account:${a.id}`) ?? null;
    if (a.kind === "loan") {
      const anchors = (o.anchors ?? o.valuations).filter((x) => x.subject_kind === "account" && x.subject_id === a.id);
      const fresh = v && Date.parse(today) - Date.parse(v.as_of) < 35 * DAY;
      const est = fresh ? null : loanAt(a.details?.loan ?? a.details, anchors, today);
      if (est !== null) v = { amount_cents: est, currency: a.currency ?? base, as_of: today, source: "estimate" };
    }
    push("account", a.id, a.name, ACCOUNT_GROUP[a.kind] ?? "cash", a.owner, v);
    lines[lines.length - 1].kind = a.kind;
  }
  // once one holding of an account has a value the holdings stand for it; the ones without a value show as 0
  const byId = new Map(o.accounts.map((a) => [a.id, a]));
  for (const h of o.holdings) {
    const v = latest.get(`holding:${h.id}`) ?? null;
    const a = byId.get(h.account_id);
    if (!valued.has(h.account_id) || (a?.closed && a.closed <= today)) continue;
    push("holding", h.id, h.name, "investments", h.owner, v);
    if (a) lines[lines.length - 1].parent = { id: a.id, name: a.name };
  }
  for (const a of o.assets) {
    if (a.role === "rented_home" || a.role === "leased") continue;   // not ours to count
    push("asset", a.id, a.name, a.kind === "vehicle" ? "car" : "property", a.owner, latest.get(`asset:${a.id}`) ?? null);
  }
  // a loan on an owned asset and the asset: one line on the page, both in the totals
  for (const a of o.accounts) {
    if (a.kind !== "loan" || !a.asset_id) continue;
    const loan = lines.find((l) => l.subject_kind === "account" && l.id === a.id);
    const asset = lines.find((l) => l.subject_kind === "asset" && l.id === a.asset_id);
    if (!loan || !asset) continue;
    loan.secured = { id: asset.id, name: asset.name, base: asset.base, as_of: asset.as_of };
    asset.merged = true;
  }
  const totals = { cash: 0, investments: 0, property: 0, car: 0, debts: 0, net: 0 };
  const byOwner: Record<string, number> = {};
  let unconverted = 0;
  for (const l of lines) {
    if (l.base === null) { unconverted++; continue; }
    totals[l.group] += l.base;
    totals.net += l.base;
    byOwner[l.owner] = (byOwner[l.owner] ?? 0) + l.base;
  }
  return { lines, totals, byOwner, unconverted };
}

export interface Due { title: string; due: string; kind: string; source: "deadline" | "contract"; id: string; asset_id: string | null; amount_cents: number | null; currency: string | null }

/** Dates a contract implies within [from, to]: its end, the last day to give notice, and auto-renewals. */
export function contractDates(c: Contract, from: string, to: string): Due[] {
  const out: Due[] = [];
  const add = (title: string, due: string, kind: string) => {
    if (due >= from && due <= to) out.push({ title, due, kind, source: "contract", id: c.id, asset_id: c.asset_id, amount_cents: c.amount_cents, currency: c.currency });
  };
  let end = c.ends;
  if (c.renews === "auto" && c.starts) {
    // the next anniversary on or after `from` (yearly unless it says otherwise)
    const step = STEP[c.every === "month" || c.every === "quarter" ? "year" : c.every ?? "year"] ?? 12;
    let d = c.starts;
    for (let i = 0; i < 1200 && d < from; i++) d = addMonths(c.starts, step * (i + 1));
    if (!c.ends || d <= c.ends) end = d;
    if (end) add(`${c.name} renews`, end, "renewal");
  } else if (end) add(`${c.name} ends`, end, "renewal");
  if (end && c.notice_days) add(`${c.name}: last day to give notice`, addDays(end, -c.notice_days), "notice");
  return out;
}

/** Open deadlines up to `to` (overdue ones too) plus contract dates from today, soonest first. */
export function upcoming(
  deadlines: { id: string; title: string; due: string; kind: string; asset_id: string | null; amount_cents: number | null; currency: string | null; done: string | null }[],
  contracts: Contract[], today: string, to: string,
): Due[] {
  const out: Due[] = deadlines.filter((d) => !d.done && d.due <= to)
    .map((d) => ({ title: d.title, due: d.due, kind: d.kind, source: "deadline" as const, id: d.id, asset_id: d.asset_id, amount_cents: d.amount_cents, currency: d.currency }));
  for (const c of contracts) out.push(...contractDates(c, today, to));
  return out.sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title));
}
