// The Health store: field checks, sealing at rest, versions, trends, the due list and who may see whose records.
// Made-up values only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeD1 } from "../../../packages/core/test/fakes/d1.ts";
import { parseHousehold } from "../../../packages/core/src/household.ts";
import { sealer } from "../../../packages/core/src/seal.ts";
import { HttpError } from "../../../packages/core/src/util.ts";
import { FieldError, clean, describe, flag, numeric } from "../src/schema.ts";
import { type HealthCtx, add, archive, get, list, mine, overview, trends, update } from "../src/store.ts";
import { healthRoute, visibleTo } from "../src/api.ts";
import { healthService } from "../src/service.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const KEY = "test-passphrase-that-is-long-enough-0123456789";
const seal = (key: string | undefined = KEY) => sealer(key, "health", "HEALTH_DATA_ENCRYPTION_KEY");
const ctx = (over: Partial<HealthCtx> = {}): HealthCtx => ({ db: fakeD1(MIGRATIONS), seal: seal(), actor: "alex", people: ["alex", "sam"], visible: ["alex", "sam"], today: "2026-06-15", ...over });

const example = JSON.parse(readFileSync(new URL("../../../household.config.example.json", import.meta.url), "utf8"));
const H = parseHousehold({ ...example, modules: { ...example.modules, health: true } });
const [alex, sam] = H.people; // alex is admin, sam is not

test("fields: required, unknown, dates, meds and results are checked", () => {
  assert.deepEqual(clean("vaccination", { for: "Tetanus", vaccine: "X", due: "2030-01-01" }), { for: "Tetanus", vaccine: "X", due: "2030-01-01" });
  assert.throws(() => clean("vaccination", { vaccine: "X" }), /for is required/);
  assert.throws(() => clean("vaccination", { for: "T", shoe: 1 }), FieldError);
  assert.throws(() => clean("vaccination", { for: "T", due: "2030-02-30" }), /date/);
  assert.deepEqual(clean("visit", { what: "GP", meds: ["Rest", { name: "Pill", dose: "1x daily" }] }).meds, [{ name: "Rest" }, { name: "Pill", dose: "1x daily" }]);
  assert.throws(() => clean("test", { kind: "blood", results: [{ name: "A" }] }), /name and a value/);
  assert.throws(() => clean("test", { kind: "dna" }), /kind/);
  const t = clean("test", { kind: "blood", results: [{ name: "A", value: "5,1", low: "4", high: 6 }] }) as any;
  assert.equal(t.results[0].low, 4);
  assert.deepEqual(clean("visit", { outcome: null }, true), { outcome: null }, "an update may clear an optional field");
  assert.match(describe().visit.what, /required/);
});

test("numbers and flags: qualifiers, words, ranges", () => {
  assert.equal(numeric("5.3"), 5.3);
  assert.equal(numeric("<0.5"), 0.5);
  assert.equal(numeric("negative"), null);
  assert.equal(flag({ name: "a", value: "9", low: 1, high: 5 }), "high");
  assert.equal(flag({ name: "a", value: "0.5", low: 1 }), "low");
  assert.equal(flag({ name: "a", value: "<0.5", high: 5 }), null);
  assert.equal(flag({ name: "a", value: "<0.5", low: 1 }), "low");
  assert.equal(flag({ name: "a", value: "negative", ref: "negative" }), null);
});

test("records are sealed at rest; only person, type and date are in the clear", async () => {
  const c = ctx();
  const { id } = await add(c, { type: "visit", person: "alex", date: "2026-05-01", data: { what: "GP", why: "secret-symptom" } });
  const raw = await c.db.prepare("SELECT * FROM records WHERE id = ?").bind(id).first<any>();
  assert.match(raw.data, /^enc:v1:/);
  assert.ok(!JSON.stringify(raw).includes("secret-symptom"));
  assert.equal((await get(c, id))!.data.why, "secret-symptom");
  const a = await c.db.prepare("SELECT * FROM audit").all<any>();
  assert.ok(!JSON.stringify(a.results).includes("secret-symptom"), "the audit never holds values");
  await assert.rejects(get({ ...c, seal: seal(KEY + "x") }, id), "a different key cannot read it");
});

test("no key: locked, nothing is written", async () => {
  const c = ctx({ seal: seal("") });
  await assert.rejects(add(c, { type: "vaccination", person: "alex", date: "2026-01-01", data: { for: "T" } }), /HEALTH_DATA_ENCRYPTION_KEY is not set/);
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM records").first<any>()).n, 0);
});

test("people and types are checked", async () => {
  const c = ctx();
  await assert.rejects(add(c, { type: "visit", person: "bob", date: "2026-01-01", data: { what: "GP" } }), /person/);
  await assert.rejects(add(c, { type: "xray", person: "alex", date: "2026-01-01", data: {} }), /type/);
});

test("a caller only ever touches the records of the people visible to them", async () => {
  const db = fakeD1(MIGRATIONS);
  const all = ctx({ db }), onlySam = ctx({ db, actor: "sam", visible: ["sam"] });
  const { id } = await add(all, { type: "visit", person: "alex", date: "2026-05-01", data: { what: "GP" } });
  await add(all, { type: "visit", person: "sam", date: "2026-05-02", data: { what: "Dentist" } });
  assert.deepEqual((await list(onlySam)).map((r) => r.person), ["sam"]);
  assert.equal(await get(onlySam, id), null, "someone else's record does not exist for this caller");
  await assert.rejects(update(onlySam, id, { data: { why: "x" } }), /no such record/);
  await assert.rejects(archive(onlySam, id, true), /no such record/);
  await assert.rejects(list(onlySam, { person: "alex" }), /not open to you/);
  await assert.rejects(add(onlySam, { type: "visit", person: "alex", date: "2026-05-03", data: { what: "GP" } }), /not open to you/);
  await assert.rejects(add(onlySam, { type: "medication", person: "sam", date: "2026-05-03", data: { name: "X", visit: id } }), /does not exist/);
  assert.deepEqual(Object.keys(await overview(onlySam)), ["sam"]);
});

test("update changes only what is sent, keeps the old version; archive hides", async () => {
  const c = ctx();
  const { id } = await add(c, { type: "visit", person: "alex", date: "2026-05-01", data: { what: "GP", why: "cough", outcome: "cold" } });
  const r = await update(c, id, { data: { outcome: null, healthy_on: "2026-05-08" } });
  assert.deepEqual(r.data, { what: "GP", why: "cough", healthy_on: "2026-05-08" });
  assert.equal((await c.db.prepare("SELECT COUNT(*) AS n FROM versions WHERE record_id = ?").bind(id).first<any>()).n, 1);
  await archive(c, id, true);
  assert.equal((await list(c, { person: "alex" })).length, 0);
  assert.equal((await list(c, { person: "alex", archived: true })).length, 1);
});

test("trends join analytes across tests, oldest first, newest range wins", async () => {
  const c = ctx();
  await add(c, { type: "test", person: "alex", date: "2024-01-10", data: { kind: "blood", results: [{ name: "Ferritin", value: "300", unit: "ng/ml", high: 400 }] } });
  await add(c, { type: "test", person: "alex", date: "2025-01-10", data: { kind: "blood", results: [{ name: "ferritin", value: "450", unit: "ng/ml", low: 30, high: 400 }, { name: "CRP", value: "<0.5" }] } });
  await add(c, { type: "test", person: "sam", date: "2025-02-10", data: { kind: "blood", results: [{ name: "Ferritin", value: "1" }] } });
  const s = await trends(c, "alex");
  const fe = s.find((x) => x.name.toLowerCase() === "ferritin")!;
  assert.deepEqual(fe.points.map((p) => [p.date, p.num, p.flag]), [["2024-01-10", 300, null], ["2025-01-10", 450, "high"]]);
  assert.equal(fe.low, 30);
  assert.equal((await trends(c, "alex", "crp")).length, 1);
});

test("overview: the newest shot per disease decides what is due", async () => {
  const c = ctx();
  await add(c, { type: "vaccination", person: "alex", date: "2015-01-01", data: { for: "Tetanus", due: "2025-01-01" } });
  await add(c, { type: "vaccination", person: "alex", date: "2025-02-01", data: { for: "tetanus", due: "2035-02-01" } });
  await add(c, { type: "vaccination", person: "alex", date: "2023-03-01", data: { for: "Hepatitis A", due: "2026-08-01" } });
  await add(c, { type: "vaccination", person: "alex", date: "2020-03-01", data: { for: "Flu", due: "2026-01-01" } });
  const o: any = await overview(c, "alex");
  assert.deepEqual(o.alex.vaccinations_due.map((d: any) => [d.for, d.overdue]), [["Flu", true], ["Hepatitis A", false]]);
});

test("medication: linked to a visit of the same person, current ones on the overview", async () => {
  const c = ctx();
  const { id: visit } = await add(c, { type: "visit", person: "alex", date: "2026-03-01", data: { what: "Allergist" } });
  const { id: other } = await add(c, { type: "visit", person: "sam", date: "2026-03-01", data: { what: "GP" } });
  const { id } = await add(c, { type: "medication", person: "alex", date: "2026-03-02", data: { name: "Tablet A", for: "grass allergy", schedule: "daily", visit } });
  assert.match(id, /^hm_/);
  await add(c, { type: "medication", person: "alex", date: "2025-01-01", data: { name: "Old pill", until: "2025-02-01" } });
  await add(c, { type: "medication", person: "alex", date: "2026-06-01", data: { name: "Course B", until: "2026-06-20" } });
  await assert.rejects(add(c, { type: "medication", person: "alex", date: "2026-03-02", data: { name: "X", visit: other } }), /belongs to sam/);
  await assert.rejects(add(c, { type: "medication", person: "alex", date: "2026-03-02", data: { name: "X", visit: "hv_nothere" } }), /does not exist/);
  await assert.rejects(add(c, { type: "medication", person: "alex", date: "2026-03-02", data: { name: "X", visit: id } }), /visit record id/);
  await assert.rejects(add(c, { type: "medication", person: "alex", date: "2026-03-02", data: { for: "no name" } }), /name is required/);
  const o: any = await overview(c, "alex");
  assert.equal(o.alex.counts.medication, 3);
  assert.deepEqual(o.alex.current_meds.map((m: any) => m.name), ["Course B", "Tablet A"]);
  const r = await update(c, id, { data: { effects: "itchy mouth the first week", until: "2026-06-01" } });
  assert.equal(r.data.visit, visit);
  assert.deepEqual((await overview(c, "alex") as any).alex.current_meds.map((m: any) => m.name), ["Course B"]);
});

test("mine: Today gets only the caller's own reminders, even for an admin", async () => {
  const c = ctx();
  await add(c, { type: "vaccination", person: "alex", date: "2020-01-01", data: { for: "Alex shot", due: "2026-01-01" } });
  await add(c, { type: "vaccination", person: "sam", date: "2020-01-01", data: { for: "Sam shot", due: "2026-07-01" } });
  await add(c, { type: "medication", person: "alex", date: "2026-01-01", data: { name: "Alex pill" } });
  await add(c, { type: "medication", person: "sam", date: "2026-01-01", data: { name: "Sam pill", schedule: "daily" } });
  await add(c, { type: "visit", person: "sam", date: "2026-05-01", data: { what: "GP", follow_up: "Check again in June" } });
  await add(c, { type: "visit", person: "sam", date: "2025-01-01", data: { what: "GP", follow_up: "Long ago" } });
  const m: any = await mine(c, "sam");
  assert.equal(m.person, "sam");
  assert.deepEqual(m.vaccinations_due.map((v: any) => v.for), ["Sam shot"]);
  assert.deepEqual(m.current_meds.map((x: any) => x.name), ["Sam pill"]);
  assert.deepEqual(m.follow_ups.map((f: any) => f.follow_up), ["Check again in June"]);
  assert.equal(JSON.stringify(m).includes("Alex"), false, "nothing of the other person");
  assert.equal((await mine(c, "kim")).person, null);
});

test("the page's API: who sees whom, writes only from the page, locked without the key", async () => {
  const env = { HEALTH_DB: fakeD1(MIGRATIONS), HEALTH_DATA_ENCRYPTION_KEY: KEY };
  const call = async (person: typeof alex, method = "GET", path = "/api/health/overview", write = true, body?: unknown, e: any = env) => {
    const req = new Request(`https://home.example.com${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    try { const r = await healthRoute(req, new URL(req.url), e, H, person, write); return { status: r.status, body: await r.json() as any }; }
    catch (x) { if (x instanceof HttpError) return { status: x.status, body: { error: x.message } as any }; throw x; }
  };
  assert.deepEqual(visibleTo(H, alex), ["alex", "sam"]);
  assert.deepEqual(visibleTo(H, sam), ["sam"]);
  const rec = { type: "vaccination", person: "alex", date: "2026-01-01", data: { for: "T" } };
  assert.equal((await call(alex, "POST", "/api/health/records", false, rec)).status, 403);
  const made = await call(alex, "POST", "/api/health/records", true, rec);
  assert.equal(made.status, 201);
  assert.equal((await call(alex, "POST", "/api/health/records", true, { ...rec, data: { nope: 1 } })).status, 400);
  assert.deepEqual(Object.keys((await call(alex)).body), ["alex", "sam"]);
  assert.deepEqual(Object.keys((await call(sam)).body), ["sam"]);
  assert.equal((await call(sam, "GET", `/api/health/records/${made.body.id}`)).status, 404);
  assert.equal((await call(sam, "GET", "/api/health/records?person=alex")).status, 400);
  assert.deepEqual((await call(sam, "GET", "/api/health/schema")).body.people, ["sam"]);
  const locked = { ...env, HEALTH_DATA_ENCRYPTION_KEY: undefined };
  assert.equal((await call(alex, "GET", "/api/health/schema", true, undefined, locked)).body.locked, true);
  assert.equal((await call(alex, "GET", "/api/health/overview", true, undefined, locked)).status, 503);
  assert.equal((await call(alex, "GET", "/api/health/mine", true, undefined, locked)).status, 200, "Today stays quiet while locked");
  assert.equal((await call(alex, "GET", "/api/health/overview", true, undefined, {})).status, 503);
});

test("the gateway's entrypoint: scopes, the approving person, a key, the person guard", async () => {
  const env = { HOUSEHOLD: JSON.stringify(H), HEALTH_DB: fakeD1(MIGRATIONS), HEALTH_DATA_ENCRYPTION_KEY: KEY };
  const s = healthService(env);
  const both = ["health.read", "health.write"];
  const asAlex = { id: "oauth:claude", scopes: both, user: "alex@example.com" }, asSam = { id: "oauth:claude", scopes: both, user: "sam@example.com" };
  const key = { id: "alfred", scopes: both };
  await assert.rejects(s.list({ id: "oauth:x", scopes: ["health.write"], user: "alex@example.com" }, {}), /lacks health\.read/);
  await assert.rejects(s.add({ id: "oauth:x", scopes: ["health.read"], user: "alex@example.com" }, { type: "visit", person: "alex", date: "2026-01-01", data: { what: "GP" } }), /lacks health\.write/);
  await assert.rejects(s.list({ id: "oauth:x", scopes: both, user: "stranger@example.com" }, {}), /not open to this person/);
  const { id } = await s.add(asAlex, { type: "visit", person: "alex", date: "2026-01-01", data: { what: "GP" } });
  assert.equal(await s.get(asSam, id), null);
  assert.deepEqual((await s.schema(asSam)).people, [{ id: "sam", name: "Sam" }]);
  assert.equal((await s.schema(key)).people.length, 2, "a gateway key reaches everyone's records");
  assert.equal((await s.get(key, id, "alex"))!.person, "alex");
  await assert.rejects(s.get(key, id, "sam"), /not a record of sam/);
  await assert.rejects(s.update(key, id, { data: { why: "x" } }, "sam"), /not a record of sam/);
  await assert.rejects(s.archive(key, id, true, "sam"), /not a record of sam/);
  const audit = await env.HEALTH_DB.prepare("SELECT actor FROM audit").all<any>();
  assert.deepEqual(audit.results.map((r: any) => r.actor), ["oauth:claude (alex)"]);
  const off = healthService({ ...env, HOUSEHOLD: JSON.stringify(parseHousehold(example)) });
  await assert.rejects(off.list(key, {}), /switched off/);
});
