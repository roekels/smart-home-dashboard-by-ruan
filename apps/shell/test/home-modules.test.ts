import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { MODULES } from "../src/modules.ts";
import { allow, viewerOf } from "../src/rpc.ts";
import { DEMO_HOUSEHOLD } from "../src/demo.ts";

const ASSETS = { fetch: async () => new Response("asset") } as unknown as Fetcher;
const env: Env = { ASSETS, HOUSEHOLD: "", ACCESS_TEAM: "", ACCESS_AUD: "", DEMO_MODE: "on" };
const admin = DEMO_HOUSEHOLD.people.find((p) => p.admin)!, member = DEMO_HOUSEHOLD.people.find((p) => !p.admin)!;
const call = (path: string, who = admin.id, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://demo.example.com${path}`, { ...init, headers: { Cookie: `demo-person=${who}`, ...(init.headers ?? {}) } }), env);
const post = (path: string, body: unknown, who = admin.id) =>
  call(path, who, { method: "POST", headers: { "content-type": "application/json", "X-Dashboard": "1" }, body: JSON.stringify(body) });

test("the four home modules are built in, each with pages", () => {
  for (const id of ["homeAssistant", "energy", "kiosk", "edgeAgents"]) assert.ok(MODULES.find((m) => m.id === id)?.pages?.length, id);
});

test("menus: lights and energy for everyone, machines and setup pages for admins only", async () => {
  const paths = (me: any) => [...me.nav.flatMap((g: any) => g.items), ...me.manage].map((i: any) => i.path);
  const a = paths(await (await call("/api/me")).json()), m = paths(await (await call("/api/me", member.id)).json());
  for (const p of ["/home/controls", "/home/energy", "/kiosk"]) assert.ok(a.includes(p) && m.includes(p), p);
  for (const p of ["/dashboard/systems", "/dashboard/agents", "/dashboard/home-assistant", "/dashboard/energy-setup", "/dashboard/wall-tablets"]) assert.ok(a.includes(p) && !m.includes(p), p);
});

test("demo: lights switch in memory, plugs only the chosen ones", async () => {
  const before: any = await (await call("/api/ha")).json();
  const lamp = before.lights.find((l: any) => !l.on && !l.unavailable);
  assert.equal((await post("/api/ha/light", { entity: lamp.entity, on: true })).status, 200);
  const after: any = await (await call("/api/ha")).json();
  assert.equal(after.lights.find((l: any) => l.entity === lamp.entity).on, true);
  assert.equal((await post("/api/ha/switch", { entity: before.plugs[0].entity, on: false })).status, 200);
  assert.notEqual((await post("/api/ha/switch", { entity: "switch.not_a_plug", on: true })).status, 200);
  // a write without the dashboard's own header is a cross-site write
  const bare = await call("/api/ha/light", admin.id, { method: "POST", body: JSON.stringify({ entity: lamp.entity, on: false }) });
  assert.equal(bare.status, 403);
});

test("demo: energy has a picture, a day and a chart, all made up", async () => {
  const e: any = await (await call("/api/energy", member.id)).json();
  assert.equal(e.configured, true);
  assert.ok(e.series.length > 100 && e.today && e.yesterday && e.now.devices.length);
  assert.equal((await call("/api/energy/setup", member.id)).status, 403);
  const s: any = await (await call("/api/energy/setup")).json();
  assert.ok(s.sensors.length && s.config.solar.length);
});

test("demo: machines and tablets are for admins, and nothing can really be sent", async () => {
  assert.equal((await call("/api/devices", member.id)).status, 403);
  assert.equal((await call("/api/kiosk/devices", member.id)).status, 403);
  const d: any = await (await call("/api/devices")).json();
  assert.ok(d.agents.length >= 2 && d.records.length && d.ops.length);
  for (const a of d.agents) assert.match(a.fingerprint, /^demo-/);
  assert.equal((await post("/api/devices/command", { agent: d.agents[0].id, op: "agent.ping" })).status, 400);
  assert.equal((await post("/api/kiosk/approve", { code: "ABCD-EF23" })).status, 400);
  const points: any = await (await call(`/api/devices/series?source=${d.agents[0].id}&kind=metrics.host&fields=cpu`)).json();
  assert.equal(points.points.length, 96);
});

test("demo: the machines' API and the kiosk host do not exist", async () => {
  const r = await worker.fetch(new Request("https://demo.example.com/api/agents/ingest", { method: "POST", body: "{}" }), { ...env, KIOSK_HOST: "kiosk.example.com" });
  assert.notEqual(r.status, 200);
});

test("the security page shows every home module's part", async () => {
  const s: any = await (await call("/api/security")).json();
  const ids = s.nodes.map((n: any) => n.id);
  for (const id of ["ha-tunnel", "home-db", "ha", "tablets", "kiosk-host", "machines", "agents-edge", "agents-db"]) assert.ok(ids.includes(id), id);
});

test("MCP callers: a scope is needed, and an API key only ever sees shared lists", () => {
  assert.equal(allow({ id: "key:assistant", scopes: ["home.read"] }, "home.read"), "mcp:key:assistant");
  assert.throws(() => allow({ id: "key:assistant", scopes: ["home.read"] }, "home.plugs"), /may not do that/);
  assert.throws(() => allow(undefined, "home.read"), /invalid caller/);
  assert.throws(() => allow({ id: "bad\nid", scopes: ["home.read"] }, "home.read"), /invalid caller/);
  assert.equal(viewerOf(DEMO_HOUSEHOLD, { id: "key:assistant", scopes: [] }), "shared-only");
  assert.equal(viewerOf(DEMO_HOUSEHOLD, { id: "oauth:app", scopes: [], person: "nobody" }), "shared-only");
  assert.equal((viewerOf(DEMO_HOUSEHOLD, { id: "oauth:app", scopes: [], person: member.id }) as any).id, member.id);
});
