// Finance: field checks, the money maths, the API on a sealed fake D1, the base currency and who gets in.
// Made-up numbers only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeD1 } from "../../../packages/core/test/fakes/d1.ts";
import { parseHousehold } from "../../../packages/core/src/household.ts";
import { sealer } from "../../../packages/core/src/seal.ts";
import { HttpError } from "../../../packages/core/src/util.ts";
import { type FinanceCtx, financeApi, financeRoute } from "../src/api.ts";
import { parseEcbCsv, syncRates, useCurrency } from "../src/fx.ts";
import { addMonths, contractDates, loanAt, loanBalance, netWorth, toBase, upcoming } from "../src/money.ts";
import { FieldError, clean, ownersOf } from "../src/schema.ts";
import { financeService } from "../src/service.ts";
import { memoryStore, sealedStore } from "../src/store.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const KEY = "test-passphrase-that-is-long-enough-0123456789";
const OWNERS = ["alex", "sam", "joint"];
const seal = (key: string | undefined = KEY) => sealer(key, "finance", "FINANCE_DATA_ENCRYPTION_KEY");
const ctx = (over: Partial<FinanceCtx> = {}): FinanceCtx => ({ store: memoryStore(), actor: "alex", owners: OWNERS, base: "EUR", today: "2026-06-15", ...over });
const call = async (c: FinanceCtx, method: string, path: string, body?: unknown, write = true) => {
  const req = new Request(`https://home.example.com${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await financeApi(req, new URL(req.url), c, write);
  return { status: res.status, body: await res.json() as any };
};
const status = async (p: Promise<unknown>) => { try { await p; return 0; } catch (e) { return (e as HttpError).status; } };

const example = JSON.parse(readFileSync(new URL("../../../household.config.example.json", import.meta.url), "utf8"));
const H = parseHousehold({ ...example, modules: { ...example.modules, finance: true } });
const [alex, sam] = H.people; // alex is admin, sam is not

test("fields: unknown keys, required fields, cents, dates, owners and currencies are checked", () => {
  const ok = clean("accounts", { name: "Everyday", kind: "current", owner: "joint", currency: "USD", last4: "1234" }, OWNERS);
  assert.deepEqual(ok, { name: "Everyday", kind: "current", owner: "joint", currency: "USD", last4: "1234" });
  assert.throws(() => clean("accounts", { name: "x", kind: "current", owner: "joint", iban: "XX00" }, OWNERS), FieldError);
  assert.throws(() => clean("accounts", { kind: "current", owner: "joint" }, OWNERS), /name is required/);
  assert.throws(() => clean("accounts", { name: "x", kind: "current", owner: "someone" }, OWNERS), /owner/);
  assert.throws(() => clean("accounts", { name: "x", kind: "current", owner: "joint", last4: "12345" }, OWNERS), /longer/);
  assert.throws(() => clean("accounts", { name: "x", kind: "current", owner: "joint", currency: "XXX" }, OWNERS), /currency/);
  assert.throws(() => clean("valuations", { subject_kind: "account", subject_id: "ac_abcd", as_of: "2026-02-30", amount_cents: 1, currency: "EUR", source: "manual" }, OWNERS), /date/);
  assert.throws(() => clean("valuations", { subject_kind: "account", subject_id: "ac_abcd", as_of: "2026-02-01", amount_cents: 1.5, currency: "EUR", source: "manual" }, OWNERS), /whole number/);
  assert.deepEqual(clean("accounts", { note: null }, OWNERS, true), { note: null }, "an update may clear an optional field");
  assert.throws(() => clean("accounts", { name: null }, OWNERS, true), /required/, "but never a required one");
  assert.deepEqual(ownersOf(H.people), [...H.people.map((p) => p.id), "joint"]);
  assert.throws(() => clean("asset_events", { asset_id: "as_demo", date: "2026-04-12", kind: "tyres", title: "x", tread_mm: 45 }, OWNERS), /out of range/);
});

test("money: currencies through the euro, loan balance, month steps", () => {
  const rates = [
    { date: "2026-01-02", currency: "USD", per_eur: 1.25 }, { date: "2026-03-02", currency: "USD", per_eur: 1.1 },
    { date: "2026-01-02", currency: "GBP", per_eur: 0.8 },
  ];
  assert.equal(toBase(125_00, "USD", "2026-02-01", rates), 100_00);
  assert.equal(toBase(110_00, "USD", "2026-04-01", rates), 100_00);
  assert.equal(toBase(125_00, "USD", "2025-01-01", rates), 100_00, "before the first rate: the earliest one");
  assert.equal(toBase(100, "USD", "2026-01-01", []), null);
  assert.equal(toBase(100, "EUR", "2026-01-01", []), 100);
  assert.equal(toBase(100_00, "EUR", "2026-02-01", rates, "USD"), 125_00, "a household that counts in dollars");
  assert.equal(toBase(80_00, "GBP", "2026-02-01", rates, "USD"), 125_00, "pounds to dollars go through the euro");
  assert.equal(toBase(80_00, "GBP", "2026-02-01", rates, "GBP"), 80_00);
  assert.equal(toBase(100, "EUR", "2026-02-01", [], "USD"), null);

  // 100,000.00 over 120 months at 3 %: the annuity payment, then the balance falls to 0
  const r = 0.03 / 12, P = 100_000_00, A = Math.round(P * r / (1 - (1 + r) ** -120));
  const terms = { principal_cents: P, rate_pct: 3, payment_cents: A, first_payment: "2020-01-05", payments: 120 };
  assert.equal(loanBalance(terms, "2019-12-31"), P);
  const mid = loanBalance(terms, "2025-01-04")!;      // 60 payments made
  assert.ok(mid > 50_000_00 && mid < 55_000_00, String(mid));
  assert.ok(loanBalance(terms, "2030-01-05")! < 100, "paid off");
  assert.equal(loanBalance({ principal_cents: P }, "2026-01-01"), null);
  assert.equal(loanAt(null, [{ as_of: "2026-01-01", amount_cents: 100_00 }, { as_of: "2026-01-11", amount_cents: 80_00 }], "2026-01-06"), 90_00, "between two balances: a straight line");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-11-15", 3), "2027-02-15");
});

test("net worth: debts count against, leased things do not count, holdings replace their account", () => {
  const nw = netWorth({
    accounts: [
      { id: "ac_cash", name: "Everyday", kind: "current", owner: "joint", currency: "EUR", details: null, closed: null },
      { id: "ac_usd", name: "Dollar", kind: "savings", owner: "alex", currency: "USD", details: null, closed: null },
      { id: "ac_loan", name: "Flat loan", kind: "loan", owner: "alex", currency: "EUR", details: null, closed: null, asset_id: "as_flat" },
      { id: "ac_brok", name: "Broker", kind: "brokerage", owner: "sam", currency: "EUR", details: null, closed: null },
      { id: "ac_old", name: "Closed", kind: "current", owner: "sam", currency: "EUR", details: null, closed: "2025-01-01" },
    ],
    holdings: [{ id: "ho_etf", account_id: "ac_brok", name: "World ETF", owner: "sam", currency: "EUR" }],
    assets: [
      { id: "as_flat", name: "Flat", kind: "property", role: "owned_home", owner: "alex" },
      { id: "as_car", name: "Car", kind: "vehicle", role: "leased", owner: "joint" },
    ],
    valuations: [
      { subject_kind: "account", subject_id: "ac_cash", as_of: "2026-05-01", amount_cents: 1_000_00, currency: "EUR", source: "manual" },
      { subject_kind: "account", subject_id: "ac_cash", as_of: "2026-06-01", amount_cents: 2_000_00, currency: "EUR", source: "manual" },
      { subject_kind: "account", subject_id: "ac_usd", as_of: "2026-06-01", amount_cents: 1_100_00, currency: "USD", source: "manual" },
      { subject_kind: "account", subject_id: "ac_loan", as_of: "2026-06-10", amount_cents: 50_000_00, currency: "EUR", source: "statement" },
      { subject_kind: "account", subject_id: "ac_brok", as_of: "2026-06-01", amount_cents: 999_00, currency: "EUR", source: "manual" },
      { subject_kind: "holding", subject_id: "ho_etf", as_of: "2026-06-01", amount_cents: 5_000_00, currency: "EUR", source: "manual" },
      { subject_kind: "asset", subject_id: "as_flat", as_of: "2026-01-01", amount_cents: 200_000_00, currency: "EUR", source: "estimate" },
      { subject_kind: "account", subject_id: "ac_old", as_of: "2024-01-01", amount_cents: 77_00, currency: "EUR", source: "manual" },
    ],
    rates: [{ date: "2026-01-02", currency: "USD", per_eur: 1.1 }],
  }, "2026-06-15");
  assert.deepEqual(nw.totals, { cash: 3_000_00, investments: 5_000_00, property: 200_000_00, car: 0, debts: -50_000_00, net: 158_000_00 });
  assert.equal(nw.byOwner.alex, 1_000_00 - 50_000_00 + 200_000_00);
  assert.equal(nw.lines.find((l) => l.id === "ac_loan")!.secured!.id, "as_flat");
  assert.equal(nw.lines.find((l) => l.id === "as_flat")!.merged, true);
  assert.equal(nw.lines.some((l) => l.id === "as_car" || l.id === "ac_old" || l.id === "ac_brok"), false);
});

test("dates a contract implies, and what is coming up", () => {
  const c = { id: "co_a", name: "Insurance", kind: "insurance", asset_id: null, starts: "2024-03-01", ends: null, notice_days: 30, renews: "auto", every: "year", amount_cents: 300_00, currency: "EUR" };
  assert.deepEqual(contractDates(c, "2026-01-01", "2026-12-31").map((d) => [d.due, d.kind]), [["2026-03-01", "renewal"], ["2026-01-30", "notice"]]);
  const up = upcoming([{ id: "dl_a", title: "Tax", due: "2026-06-30", kind: "tax", asset_id: null, amount_cents: null, currency: null, done: null }], [c], "2026-06-15", "2027-06-15");
  assert.deepEqual(up.map((d) => d.due), ["2026-06-30", "2027-01-30", "2027-03-01"]);
});

test("the API: create, refs, update, archive, balances, deadlines, overview and history", async () => {
  const c = ctx();
  assert.equal(await status(call(c, "POST", "/api/finance/accounts", { name: "x", kind: "current", owner: "joint" }, false)), 403, "a cross-site write");
  const acc = await call(c, "POST", "/api/finance/accounts", { name: "Everyday", kind: "current", owner: "joint", currency: "EUR" });
  assert.equal(acc.status, 201);
  const id = acc.body.id as string;
  assert.equal(await status(call(c, "POST", "/api/finance/holdings", { account_id: "ac_missing1", name: "x", kind: "etf", owner: "sam" })), 400, "a ref must exist");
  assert.equal(await status(call(c, "POST", "/api/finance/valuations", { subject_kind: "asset", subject_id: id, as_of: "2026-06-01", amount_cents: 1, currency: "EUR", source: "manual" })), 400);
  assert.equal(await status(call(c, "POST", `/api/finance/assets/${id}`, { name: "y" })), 404, "an id of another table");

  const batch = await call(c, "POST", "/api/finance/valuations/batch", { as_of: "2026-05-31", items: [{ subject_kind: "account", subject_id: id, amount_cents: 1_234_00, currency: "EUR" }] });
  assert.equal(batch.status, 201);
  await call(c, "POST", "/api/finance/valuations", { subject_kind: "account", subject_id: id, as_of: "2026-04-30", amount_cents: 1_000_00, currency: "EUR", source: "manual" });
  const vals = await call(c, "GET", "/api/finance/valuations?from=2026-05-01");
  assert.deepEqual(vals.body.valuations.map((v: any) => v.amount_cents), [1_234_00]);
  assert.equal(await status(call(c, "GET", "/api/finance/valuations?from=May")), 400);

  await call(c, "POST", `/api/finance/accounts/${id}`, { note: "main account", details: { bank_day: 1 } });
  const got = await call(c, "GET", `/api/finance/accounts/${id}`);
  assert.equal(got.body.note, "main account");
  assert.deepEqual(got.body.details, { bank_day: 1 });
  assert.equal(got.body.last4, null, "an empty field comes back as null");
  assert.equal((await call(c, "GET", "/api/finance/accounts?q=MAIN")).body.accounts.length, 1);
  assert.equal((await call(c, "GET", "/api/finance/accounts?q=nothing")).body.accounts.length, 0);

  const dl = await call(c, "POST", "/api/finance/deadlines", { title: "Car inspection", due: "2026-07-01", kind: "inspection", repeat: "year" });
  const done = await call(c, "POST", `/api/finance/deadlines/${dl.body.id}/done`, {});
  assert.ok(done.body.next);
  assert.equal(await status(call(c, "POST", `/api/finance/deadlines/${dl.body.id}/done`, {})), 409);
  const next = await call(c, "GET", `/api/finance/deadlines/${done.body.next}`);
  assert.equal(next.body.due, "2027-07-01");
  assert.equal(next.body.done, null);

  await call(c, "POST", "/api/finance/tax_years", { year: 2025, person: "alex", kind: "income_tax" });
  assert.equal(await status(call(c, "POST", "/api/finance/tax_years", { year: 2025, person: "alex", kind: "income_tax" })), 400, "one per person, year and kind");

  const over = await call(c, "GET", "/api/finance/overview?days=400");
  assert.equal(over.body.totals.net, 1_234_00);
  assert.equal(over.body.base, "EUR");
  assert.deepEqual(over.body.upcoming.map((u: any) => u.due), ["2027-07-01"]);
  const hist = await call(c, "GET", "/api/finance/history");
  assert.deepEqual(hist.body.points.map((p: any) => [p.date, p.net]), [["2026-04-30", 1_000_00], ["2026-05-31", 1_234_00], ["2026-06-15", 1_234_00]]);

  await call(c, "POST", `/api/finance/accounts/${id}/archive`, { archived: true });
  assert.equal((await call(c, "GET", "/api/finance/accounts")).body.accounts.length, 0);
  assert.equal((await call(c, "GET", "/api/finance/accounts?archived=1")).body.accounts.length, 1);
  await call(c, "POST", `/api/finance/accounts/${id}/archive`, { archived: false });
  assert.equal((await call(c, "GET", "/api/finance/accounts")).body.accounts.length, 1);

  const audits = (c.store as ReturnType<typeof memoryStore>).audits;
  assert.ok(audits.length >= 8);
  assert.doesNotMatch(JSON.stringify(audits), /Everyday|main account|123400/, "the audit names fields, never values");
  assert.deepEqual(audits.find((a) => a.action === "accounts.update")!.detail, { fields: ["details", "note"] });
});

test("at rest: every row is sealed, and without the key the data is locked", async () => {
  const db = fakeD1(MIGRATIONS);
  const c = ctx({ store: sealedStore(db, seal()) });
  const acc = await call(c, "POST", "/api/finance/accounts", { name: "Rainy day fund", kind: "savings", owner: "sam", currency: "EUR", last4: "9876" });
  await call(c, "POST", "/api/finance/transactions", { date: "2026-06-01", amount_cents: -49_99, currency: "EUR", category: "food", owner: "sam", counterparty: "Corner bakery", account_id: acc.body.id });
  const raw = (await db.prepare("SELECT * FROM rows").all<any>()).results!;
  assert.equal(raw.length, 2);
  for (const r of raw) assert.match(r.data, /^enc:v1:/);
  const dump = JSON.stringify([raw, (await db.prepare("SELECT * FROM audit").all<any>()).results]);
  assert.doesNotMatch(dump, /Rainy|9876|bakery|4999|savings|sam"/);
  assert.equal(raw.find((r) => r.tbl === "transactions").day, "2026-06-01", "only the date is readable");
  assert.equal((await call(c, "GET", "/api/finance/transactions?from=2026-06-01&to=2026-06-30")).body.transactions[0].counterparty, "Corner bakery");

  const locked = ctx({ store: sealedStore(db, sealer(undefined, "finance", "FINANCE_DATA_ENCRYPTION_KEY")) });
  assert.equal(await status(call(locked, "GET", "/api/finance/overview")), 503);
  assert.equal(await status(call(locked, "POST", "/api/finance/accounts", { name: "x", kind: "current", owner: "joint" })), 503);
  assert.equal((await call(locked, "GET", "/api/finance/schema")).body.locked, true);
  const wrong = ctx({ store: sealedStore(db, sealer("another-passphrase-that-is-long-enough-000", "finance", "FINANCE_DATA_ENCRYPTION_KEY")) });
  await assert.rejects(call(wrong, "GET", "/api/finance/accounts"));
});

test("exchange rates: parsed, synced for the currencies in use, never twice a day", async () => {
  const csv = "KEY,FREQ,CURRENCY,TIME_PERIOD,OBS_VALUE\nx,D,USD,2026-06-11,1.1\nx,D,USD,2026-06-12,1.2\nx,D,USD,bad,1\n";
  assert.deepEqual(parseEcbCsv(csv, "USD").map((r) => r.per_eur), [1.1, 1.2]);
  const db = fakeD1(MIGRATIONS);
  const asked: string[] = [];
  const fetcher = (async (u: string) => { asked.push(String(u)); return new Response(csv); }) as typeof fetch;
  assert.equal(await syncRates(db, "2026-06-12", "EUR", fetcher), 0, "nothing in use, base is the euro: nothing fetched");
  assert.equal(await useCurrency(db, "USD"), true);
  assert.equal(await useCurrency(db, "USD"), false);
  assert.equal(await useCurrency(db, "EUR"), false);
  assert.equal(await syncRates(db, "2026-06-12", "EUR", fetcher), 2);
  assert.equal(await syncRates(db, "2026-06-12", "EUR", fetcher), 0);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /D\.USD\.EUR\.SP00\.A\?startPeriod=\d{4}-\d{2}-\d{2}&format=csvdata$/, "a currency and a date, nothing else");
  const c = ctx({ store: sealedStore(db, seal()), base: "USD" });
  const acc = await call(c, "POST", "/api/finance/accounts", { name: "Euro account", kind: "current", owner: "joint", currency: "EUR" });
  await call(c, "POST", "/api/finance/valuations/batch", { as_of: "2026-06-12", items: [{ subject_kind: "account", subject_id: acc.body.id, amount_cents: 100_00, currency: "EUR" }] });
  assert.equal((await call(c, "GET", "/api/finance/overview")).body.totals.net, 120_00, "totals in the household's currency");
});

test("who gets in: admins on the page; over MCP an admin's connection or a key, held to its scopes", async () => {
  const env = { FINANCE_DB: fakeD1(MIGRATIONS), FINANCE_DATA_ENCRYPTION_KEY: KEY, HOUSEHOLD: JSON.stringify({ ...example, modules: { ...example.modules, finance: true } }) };
  const get = (path: string) => new Request(`https://home.example.com${path}`);
  const page = (person: typeof alex) => financeRoute(get("/api/finance/overview"), new URL("https://home.example.com/api/finance/overview"), env, H, person, false);
  assert.equal((await page(alex)).status, 200);
  assert.throws(() => page(sam), (e: HttpError) => e.status === 403);
  assert.throws(() => financeRoute(get("/api/finance/overview"), new URL("https://home.example.com/api/finance/overview"), {}, H, alex, false), (e: HttpError) => e.status === 503);

  const s = financeService(env, (async () => new Response("", { status: 404 })) as typeof fetch);
  const all = ["finance.read", "finance.write", "finance.archive"];
  const made = await s.create({ id: "oauth:App", scopes: all, user: alex.email }, "accounts", { name: "Everyday", kind: "current", owner: "joint" });
  assert.match(made.id, /^ac_/);
  await assert.rejects(s.list({ id: "oauth:App", scopes: all, user: sam.email }, "accounts", {}), /admins only/);
  await assert.rejects(s.list({ id: "oauth:App", scopes: all, user: "stranger@example.com" }, "accounts", {}), /admins only/);
  await assert.rejects(s.create({ id: "key:reader", scopes: ["finance.read"] }, "accounts", { name: "x", kind: "current", owner: "joint" }), /lacks finance\.write/);
  await assert.rejects(s.archive({ id: "key:writer", scopes: ["finance.read", "finance.write"] }, "accounts", made.id, true), /lacks finance\.archive/);
  assert.equal((await s.list({ id: "key:reader", scopes: ["finance.read"] }, "accounts", {})).length, 1, "a key has no person");
  await assert.rejects(s.list({ id: "key:reader", scopes: ["finance.read"] }, "secrets", {}), /no such table/);
  await assert.rejects(s.get({ id: "key:reader", scopes: ["finance.read"] }, "assets", made.id), /no such row/);
  await assert.rejects(s.list({ id: "", scopes: all }, "accounts", {}), /no caller/);
  const off = financeService({ ...env, HOUSEHOLD: JSON.stringify({ ...example, modules: { ...example.modules, finance: false } }) });
  await assert.rejects(off.overview({ id: "key:reader", scopes: all }), /switched off/);
});
