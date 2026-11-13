import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseHousehold } from "../../../packages/core/src/household.ts";
import { serviceProblems, servicesFor } from "../src/services.ts";
import { buildDevicesServer, buildHomeServer, callerOf, type Caller, type DevicesApi, type HomeApi } from "../src/tools/home.ts";
import type { Principal } from "../src/env.ts";

const example = JSON.parse(readFileSync(new URL("../../../household.config.example.json", import.meta.url), "utf8"));
const H = parseHousehold({ ...example, modules: { ...example.modules, homeAssistant: true, energy: true, edgeAgents: true } });

async function connect(server: McpServer) {
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const key = (scopes: string[]): Principal => ({ actor: "alfred", via: "key", scopes });
const oauth = (scopes: string[], user = "sam@example.com"): Principal => ({ actor: "oauth:Claude", via: "oauth", scopes, user });

function fakeHome() {
  const calls: { method: string; caller: Caller; args: unknown[] }[] = [];
  const rec = (method: string, out: unknown) => async (caller: Caller, ...args: unknown[]) => { calls.push({ method, caller, args }); return out; };
  const api: HomeApi = {
    status: rec("status", { lights: [] }), light: rec("light", { ok: true }), scene: rec("scene", { ok: true }), plug: rec("plug", { ok: true }),
    lists: rec("lists", { lists: [] }), listAdd: rec("listAdd", { ok: true }), listDone: rec("listDone", { ok: true }),
  };
  return { api, calls };
}

test("services: home and devices exist only when their module is on, with their own scope prefixes", () => {
  const ids = servicesFor(H).map((s) => s.id);
  assert.ok(ids.includes("home") && ids.includes("devices"));
  assert.deepEqual(serviceProblems(servicesFor(H)), []);
  const off = parseHousehold(example);
  assert.deepEqual(servicesFor(off).map((s) => s.id).filter((i) => i === "home" || i === "devices"), []);
});

test("caller: a key carries no person; an OAuth connection carries the approver's id, never an email", () => {
  assert.deepEqual(callerOf(key(["home.read"]), H), { id: "key:alfred", scopes: ["home.read"] });
  assert.deepEqual(callerOf(oauth(["home.lists"]), H), { id: "oauth:Claude", scopes: ["home.lists"], person: "sam" });
  assert.equal(callerOf(oauth(["home.lists"], "stranger@example.com"), H).person, undefined);
});

test("home: tools follow the scopes, and the hints say what is safe", async () => {
  const { api } = fakeHome(), log = () => {};
  const names = async (scopes: string[]) => (await (await connect(buildHomeServer(key(scopes), { api, h: H, log }))).listTools()).tools;
  assert.deepEqual((await names(["home.read"])).map((t) => t.name), ["home_status"]);
  assert.deepEqual((await names(["home.read", "home.control", "home.lists"])).map((t) => t.name), ["home_status", "set_light", "run_scene", "read_lists", "add_list_item", "set_list_item_done"]);
  const all = await names(["home.read", "home.control", "home.lists", "home.plugs"]);
  const hint = (n: string) => all.find((t) => t.name === n)!.annotations!;
  assert.equal(hint("home_status").readOnlyHint, true);
  assert.equal(hint("read_lists").readOnlyHint, true);
  for (const n of ["set_light", "run_scene", "add_list_item", "set_list_item_done"]) assert.equal(hint(n).destructiveHint, false, n);
  assert.equal(hint("set_plug").destructiveHint, true);
});

test("home: a call reaches the dashboard with the caller, is audited by entity, and bad input never leaves the gateway", async () => {
  const { api, calls } = fakeHome(), logged: unknown[][] = [];
  const client = await connect(buildHomeServer(oauth(["home.read", "home.control", "home.lists"]), { api, h: H, log: (...a) => logged.push(a) }));
  const ok: any = await client.callTool({ name: "set_light", arguments: { entity: "light.kitchen_ceiling", on: true, brightness: 40 } });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(calls[0], { method: "light", caller: { id: "oauth:Claude", scopes: ["home.read", "home.control", "home.lists"], person: "sam" }, args: [{ entity: "light.kitchen_ceiling", on: true, brightness: 40 }] });
  assert.deepEqual(logged[0], ["set_light", true, "light.kitchen_ceiling"]);
  await client.callTool({ name: "add_list_item", arguments: { list: "todo.shopping_list", text: "Milk" } });
  assert.deepEqual(logged[1], ["add_list_item", true, "todo.shopping_list"], "the item's text is never written to the audit");
  const bad: any = await client.callTool({ name: "set_light", arguments: { entity: "lock.front_door", on: true } });
  assert.equal(bad.isError, true);
  assert.equal(calls.length, 2);
});

test("home: a refusal from the dashboard and a missing binding are plain tool errors", async () => {
  const { api } = fakeHome(), logged: unknown[][] = [];
  api.scene = async () => { throw new Error("scene.nope is not in Home Assistant"); };
  const client = await connect(buildHomeServer(key(["home.control"]), { api, h: H, log: (...a) => logged.push(a) }));
  const out: any = await client.callTool({ name: "run_scene", arguments: { scene: "scene.nope" } });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /not in Home Assistant/);
  assert.deepEqual(logged[0], ["run_scene", false, "scene.nope", "scene.nope is not in Home Assistant"]);
  const none = await connect(buildHomeServer(key(["home.read"]), { api: undefined, h: H, log: () => {} }));
  const gone: any = await none.callTool({ name: "home_status", arguments: {} });
  assert.match(gone.content[0].text, /not connected/);
});

test("devices: read tools and run_command follow the scopes; a destructive command is only proposed", async () => {
  const proposed: unknown[] = [];
  const api: DevicesApi = {
    agents: async () => ({ agents: [] }), latest: async () => ({ records: [] }), ops: async () => ({ ops: [] }), command: async () => ({ status: "proposed" }),
    propose: async (_c, input) => { proposed.push(input); return { id: "cmd_test", status: "proposed", tier: "destructive", expires: 1 }; },
  };
  const read = await connect(buildDevicesServer(key(["devices.read"]), { api, h: H, log: () => {} }));
  assert.deepEqual((await read.listTools()).tools.map((t) => t.name), ["list_devices", "device_stats", "device_ops", "command_status"]);
  const both = await connect(buildDevicesServer(key(["devices.read", "devices.control"]), { api, h: H, log: () => {} }));
  const tools = (await both.listTools()).tools;
  assert.equal(tools.find((t) => t.name === "run_command")!.annotations!.destructiveHint, true);
  assert.equal(tools.some((t) => /confirm/.test(t.name)), false, "nothing here can confirm");
  const out: any = await both.callTool({ name: "run_command", arguments: { device: "ag_gaming-pc", op: "pc.shutdown", args: { delay_s: 30 } } });
  assert.deepEqual(proposed, [{ agent: "ag_gaming-pc", op: "pc.shutdown", args: { delay_s: 30 } }]);
  assert.match(out.content[0].text, /Waiting for an admin to confirm/);
});
