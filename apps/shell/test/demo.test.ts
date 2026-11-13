import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { DEMO_HOUSEHOLD, demoEvents, demoPerson, today } from "../src/demo.ts";

const ASSETS = { fetch: async () => new Response("asset") } as unknown as Fetcher;
const env: Env = { ASSETS, HOUSEHOLD: "", ACCESS_TEAM: "", ACCESS_AUD: "", DEMO_MODE: "on" };
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://demo.example.com${path}`, init), env);
const post = (path: string, body: unknown, headers: Record<string, string> = { "X-Dashboard": "1" }) =>
  call(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("demo: a made-up household with only example addresses", () => {
  assert.ok(DEMO_HOUSEHOLD.people.length >= 3);
  for (const p of DEMO_HOUSEHOLD.people) assert.match(p.email, /@example\.com$/);
  assert.match(DEMO_HOUSEHOLD.domain, /\.example\.com$/);
});

test("demo: no sign-in, first person by default, the cookie switches", async () => {
  const first = DEMO_HOUSEHOLD.people[0], second = DEMO_HOUSEHOLD.people[1];
  let me: any = await (await call("/api/me")).json();
  assert.equal(me.demo, true);
  assert.equal(me.person.id, first.id);
  assert.ok(me.modules.includes("calendar"));
  const r = await post("/api/demo/person", { id: second.id });
  assert.match(r.headers.get("set-cookie") ?? "", new RegExp(`demo-person=${second.id};`));
  me = await (await call("/api/me", { headers: { Cookie: `demo-person=${second.id}` } })).json();
  assert.equal(me.person.id, second.id);
  assert.equal(demoPerson(new Request("https://x.example", { headers: { Cookie: "demo-person=nobody" } })).id, first.id);
  assert.equal((await post("/api/demo/person", { id: "nobody" })).status, 400);
});

test("demo: the calendar always has events today, wherever the clock is", () => {
  for (const now of [new Date("2026-01-01T03:00:00Z"), new Date("2026-06-30T22:30:00Z")]) {
    const day = today(DEMO_HOUSEHOLD, now);
    const events = demoEvents(day, day, now);
    assert.ok(events.length >= 3, `events on ${day}`);
    for (const e of events) assert.ok(e.owner === null || DEMO_HOUSEHOLD.people.some((p) => p.id === e.owner));
  }
});

test("demo: the Today cards' data, per person", async () => {
  const cal: any = await (await call("/api/calendar?from=2026-03-01&to=2026-03-02")).json();
  assert.ok(Array.isArray(cal.events));
  assert.equal((await call("/api/calendar")).status, 400);
  const ha: any = await (await call("/api/ha")).json();
  assert.ok(ha.scenes.length > 0);
  const lists: any = await (await call("/api/lists")).json();
  assert.ok(lists.lists.some((l: any) => l.shared));
  const health = await call("/api/health/mine");
  assert.equal(health.status, 200);
});

test("demo: lists can be changed in memory, with our header only", async () => {
  const before: any = await (await call("/api/lists")).json();
  const list = before.lists[0];
  assert.equal((await post("/api/lists/add", { list: list.entity, text: "Oat milk" }, {})).status, 403);
  assert.equal((await post("/api/lists/add", { list: list.entity, text: "Oat milk" })).status, 200);
  assert.equal((await post("/api/lists/add", { list: list.entity, text: " " })).status, 400);
  assert.equal((await post("/api/lists/add", { list: "todo.nope", text: "x" })).status, 404);
  const after: any = await (await call("/api/lists")).json();
  const item = after.lists[0].items.find((i: any) => i.text === "Oat milk");
  assert.ok(item);
  assert.equal((await post("/api/lists/done", { list: list.entity, item: item.uid, done: true })).status, 200);
  assert.equal((await post("/api/ha/scene", { scene: "scene.nope" })).status, 400);
  assert.equal((await post("/api/ha/scene", { scene: (await (await call("/api/ha")).json() as any).scenes[0].entity })).status, 200);
});

test("demo: the Security page says it is a demo and shows no key as present", async () => {
  const sec: any = await (await call("/api/security")).json();
  assert.equal(sec.checks[0].state, "open");
  assert.match(sec.checks[0].text, /demo/i);
  assert.equal(sec.keyGroups.flatMap((g: any) => g.rows).some((r: any) => /set on/i.test(r.state)), false);
});
