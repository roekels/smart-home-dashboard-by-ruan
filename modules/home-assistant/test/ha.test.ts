import test from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../../../apps/shell/src/env.ts";
import { parseHousehold } from "../../../packages/core/src/household.ts";
import { HaError, HaInput, compact, controls, emptySettings, haFetch, runScene, setLight, setPlug, type HaSettings } from "../ha.ts";
import { ListError, addItem, mayUse, readLists, setDone } from "../lists.ts";
import { light, homeControls } from "../service.ts";
import { cleanSettings, kvPut, reading } from "../store.ts";
import { HA_ENV, STATES, fakeHa, homeDb } from "./fakes/d1.ts";
import demo from "../../../demo/household.config.json" with { type: "json" };

const h = parseHousehold(demo);
const env = (extra: Partial<Env> = {}): Env => ({ ...HA_ENV, HOME_DB: homeDb(), ...extra } as unknown as Env);
const ha = compact(STATES).states;
const set: HaSettings = { lists: { "todo.shopping": "shared", "todo.alex_tasks": "alex" }, plugs: ["switch.office_desk"], scripts: ["script.good_night"], hiddenLights: ["light.router_status"] };

test("compact keeps what the pages need and drops the rest of the house", () => {
  assert.ok(!("person.alex" in ha) && !("sensor.outdoor_temperature" in ha));
  assert.deepEqual(ha["light.kitchen_ceiling"].b, 100);
  assert.match(ha["light.kitchen_ceiling"].c!, /^[0-9a-f]{6}$/);
  assert.equal(ha["sensor.solar_power"].u, "kW");
});

test("controls: hidden lights stay out, only chosen switches and scripts get in", () => {
  const c = controls(ha, set);
  assert.deepEqual(c.lights.map((l) => l.entity), ["light.hallway", "light.kitchen_ceiling"]);
  assert.deepEqual(c.plugs.map((p) => p.entity), ["switch.office_desk"]);
  assert.deepEqual(c.scenes.map((s) => s.entity), ["scene.movie_time", "script.good_night"]);
  assert.deepEqual(controls(ha, emptySettings()).plugs, []);
});

test("every call carries the service token and Home Assistant's own token", async () => {
  const f = fakeHa({ "/api/services/light/turn_on": [] });
  const out = await setLight(env(), ha, set, { entity: ["light.hallway", "light.kitchen_ceiling"], on: true, brightness: 40 }, f.fetcher);
  assert.deepEqual(out, { ok: true, entity: ["light.hallway", "light.kitchen_ceiling"], on: true, brightness: 40 });
  assert.equal(f.calls[0].headers.get("authorization"), "Bearer test-ha-token");
  assert.equal(f.calls[0].headers.get("CF-Access-Client-Id"), "test-id.access");
  assert.deepEqual(f.calls[0].body, { entity_id: ["light.hallway", "light.kitchen_ceiling"], brightness_pct: 40 });
});

test("a wrong request is refused before anything is sent", async () => {
  const f = fakeHa({});
  const e = env();
  await assert.rejects(setLight(e, ha, set, { entity: "light.nowhere", on: true }, f.fetcher), HaInput);
  await assert.rejects(setLight(e, ha, set, { entity: "switch.office_desk", on: true }, f.fetcher), HaInput);
  await assert.rejects(setLight(e, ha, set, { entity: "light.router_status", on: false }, f.fetcher), /hidden/);
  await assert.rejects(setLight(e, ha, set, { entity: "light.hallway", on: true, brightness: 0 }, f.fetcher), HaInput);
  await assert.rejects(setPlug(e, ha, set, { entity: "switch.oven_child_lock", on: true }, f.fetcher), /not one of the plugs/);
  await assert.rejects(runScene(e, ha, set, "script.open_garage", f.fetcher), HaInput);
  assert.equal(f.calls.length, 0);
});

test("a chosen script runs as a script, a scene as a scene", async () => {
  const f = fakeHa({ "/api/services/script/turn_on": [], "/api/services/scene/turn_on": [] });
  await runScene(env(), ha, set, "script.good_night", f.fetcher);
  await runScene(env(), ha, set, "scene.movie_time", f.fetcher);
  assert.deepEqual(f.calls.map((c) => c.path), ["/api/services/script/turn_on", "/api/services/scene/turn_on"]);
});

test("failures on the way in are told apart", async () => {
  const login = fakeHa({ "/api/states": new Response("", { status: 302, headers: { location: "https://example.cloudflareaccess.com/" } }) });
  await assert.rejects(haFetch(env(), "GET", "/api/states", undefined, login.fetcher), /Cloudflare Access did not let/);
  const bad = fakeHa({ "/api/states": new Response("", { status: 401 }) });
  await assert.rejects(haFetch(env(), "GET", "/api/states", undefined, bad.fetcher), /refused the token/);
  await assert.rejects(haFetch({ ...env(), HA_URL: undefined } as Env, "GET", "/api/states"), HaError);
});

test("lists: shared for everyone, own for the owner, unnamed for admins, hidden for nobody", () => {
  const alex = { id: "alex", admin: true }, robin = { id: "robin", admin: false };
  assert.ok(mayUse(set, "shared-only", "todo.shopping") && mayUse(set, robin, "todo.shopping"));
  assert.ok(mayUse(set, alex, "todo.alex_tasks") && !mayUse(set, robin, "todo.alex_tasks") && !mayUse(set, "shared-only", "todo.alex_tasks"));
  assert.ok(mayUse(set, alex, "todo.unnamed") && !mayUse(set, robin, "todo.unnamed"));
  assert.ok(!mayUse({ ...set, lists: { "todo.shopping": "hidden" } }, alex, "todo.shopping"));
});

test("lists: only the caller's lists are asked for, and writes to another's list are refused", async () => {
  const f = fakeHa({
    "/api/services/todo/get_items": { service_response: { "todo.shopping": { items: [{ uid: "1", summary: "Oat milk", status: "needs_action" }, { uid: "2", summary: "Bread", status: "completed" }] } } },
    "/api/services/todo/add_item": [], "/api/services/todo/update_item": [],
  });
  const e = env();
  const lists = await readLists(e, ha, set, "shared-only", f.fetcher);
  assert.deepEqual(f.calls[0].body, { entity_id: ["todo.shopping"] });
  assert.deepEqual(lists.map((l) => [l.entity, l.shared, l.open]), [["todo.shopping", true, 1]]);
  await addItem(e, ha, set, "shared-only", "todo.shopping", "  Eggs \n", f.fetcher);
  assert.deepEqual(f.calls[1].body, { entity_id: "todo.shopping", item: "Eggs" });
  await setDone(e, ha, set, { id: "robin", admin: false }, "todo.shopping", "1", true, f.fetcher);
  await assert.rejects(addItem(e, ha, set, "shared-only", "todo.alex_tasks", "x", f.fetcher), ListError);
  await assert.rejects(setDone(e, ha, set, { id: "robin", admin: false }, "todo.alex_tasks", "1", true, f.fetcher), ListError);
  assert.equal(f.calls.length, 3);
});

test("settings are cleaned: an owner must be a person of this household", () => {
  const ok = cleanSettings({ lists: { "todo.shopping": "shared", "todo.alex_tasks": "alex" }, plugs: ["switch.b", "switch.a", "light.x", "switch.a"], scripts: "no", hiddenLights: ["light.x"] }, h);
  assert.deepEqual(ok, { lists: { "todo.shopping": "shared", "todo.alex_tasks": "alex" }, plugs: ["switch.a", "switch.b"], scripts: [], hiddenLights: ["light.x"] });
  assert.throws(() => cleanSettings({ lists: { "todo.shopping": "stranger" } }, h), /person of this household/);
  assert.throws(() => cleanSettings({ lists: { "light.x": "shared" } }, h), /not a todo/);
});

test("the reading is cached for 20 seconds and survives Home Assistant going away", async () => {
  const e = env(), f = fakeHa({ "/api/states": STATES });
  const a = await reading(e, undefined, f.fetcher, 1_000_000);
  const b = await reading(e, undefined, f.fetcher, 1_010_000);
  assert.equal(f.calls.length, 1);
  assert.ok(a.fresh && b.fresh && b.ts === 1_000_000);
  const down = fakeHa({ "/api/states": new Response("", { status: 502 }) });
  const c = await reading(e, undefined, down.fetcher, 1_060_000);
  assert.ok(c.fresh && /tunnel/.test(c.error!) && "light.hallway" in c.states);
  const d = await reading(e, undefined, down.fetcher, 1_000_000 + 10 * 60_000);
  assert.equal(d.fresh, false);
});

test("a switch shows at once, is audited, and names no secret", async () => {
  const e = env(), f = fakeHa({ "/api/states": STATES, "/api/services/light/turn_off": [] });
  await kvPut(e, "ha.settings", set);
  await light(e, "alex", { entity: "light.kitchen_ceiling", on: false }, f.fetcher);
  const c = await homeControls(e, f.fetcher);
  assert.equal(c.lights.find((l) => l.entity === "light.kitchen_ceiling")!.on, false);
  const row = await e.HOME_DB!.prepare("SELECT actor, action, target FROM home_audit").first<any>();
  assert.deepEqual({ ...row }, { actor: "alex", action: "light.off", target: "light.kitchen_ceiling" });
});
