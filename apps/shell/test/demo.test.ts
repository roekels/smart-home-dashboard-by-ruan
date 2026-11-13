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
  const mine: any = await health.json();
  assert.equal(mine.vaccinations_due[0].overdue, true, "the first person's tetanus shot is overdue in the demo");
});

test("demo: the Health and Finance pages read made-up records and refuse every change", async () => {
  const records: any = await (await call("/api/health/records?person=alex")).json();
  assert.ok(records.records.length > 3);
  assert.ok(records.records.every((r: any) => /^\d{4}-\d{2}-\d{2}$/.test(r.date)), "relative dates are worked out");
  const trends: any = await (await call("/api/health/trends?person=alex")).json();
  assert.ok(trends.series.some((s: any) => s.points.length === 2));
  assert.equal((await post("/api/health/records", { type: "visit", person: "alex", date: "2026-01-01", data: { what: "GP" } })).status, 403);

  const over: any = await (await call("/api/finance/overview")).json();
  assert.equal(over.base, "GBP");
  assert.ok(over.totals.net > 0 && over.unconverted === 0);
  assert.ok(over.upcoming.length > 0);
  const history: any = await (await call("/api/finance/history")).json();
  assert.ok(history.points.length > 12);
  assert.equal((await post("/api/finance/accounts", { name: "x", kind: "current", owner: "joint" })).status, 403);
});

test("demo: the Brain answers from made-up notes, read-only, sensitive notes per person", async () => {
  const graph: any = await (await call("/api/brain/graph")).json();
  assert.deepEqual(graph.roots, ["Alex", "Sam", "Robin", "Kit", "Family"]);
  assert.ok(graph.nodes.length > 30 && graph.links.some((l: any) => l.kind === "link"));
  const ids = new Set(graph.nodes.map((n: any) => n.id));
  assert.ok(graph.links.every((l: any) => ids.has(l.source) && ids.has(l.target)));
  // the demo opens as Alex: their own sealed branch shows, Sam's does not
  assert.ok(graph.nodes.some((n: any) => n.path === "Alex/Health/Knee"));
  assert.ok(!graph.nodes.some((n: any) => n.path.startsWith("Sam/Health")));
  const note: any = await (await call("/api/brain/note?path=Family%2FHome%2FBoiler")).json();
  assert.match(note.body, /^# Boiler/);
  assert.ok(note.links.some((l: any) => l.path === "Family/Home/Trades we use") && note.backlinks.some((b: any) => b.path === "Family/Home"));
  assert.equal((await call("/api/brain/note?path=Sam%2FHealth%2FHay%20fever")).status, 400);
  const hits: any = await (await call("/api/brain/search?q=pancakes")).json();
  assert.ok(hits.some((x: any) => x.path === "Family/Traditions" && x.snippet.includes("«")));
  const acts: any = await (await call("/api/brain/activity?since=" + encodeURIComponent(new Date(Date.now() - 864e5).toISOString()))).json();
  assert.ok(acts.length > 5 && acts[0].ts < acts.at(-1).ts);
  assert.equal((await post("/api/brain/note/save", { path: "Family/Car", base_version: 1, body: "x" })).status, 403);
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
