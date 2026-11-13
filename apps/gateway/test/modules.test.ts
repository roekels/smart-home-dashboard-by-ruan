// The module MCPs end to end: an MCP client against the gateway's tools, wired to the modules' own services on a
// fake D1. Which tools a connection sees follows its scopes; every tool says whether it only reads.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseHousehold } from "../../../packages/core/src/household.ts";
import { fakeD1 } from "../../../packages/core/test/fakes/d1.ts";
import { financeService } from "../../../modules/finance/src/service.ts";
import { healthService } from "../../../modules/health/src/service.ts";
import { serviceProblems, servicesFor } from "../src/services.ts";
import { SERVERS } from "../src/servers.ts";
import { buildFinanceServer } from "../src/tools/finance.ts";
import { buildHealthServer } from "../src/tools/health.ts";
import type { Principal } from "../src/env.ts";

const example = JSON.parse(readFileSync(new URL("../../../household.config.example.json", import.meta.url), "utf8"));
const config = { ...example, modules: { ...example.modules, finance: true, health: true } };
const H = parseHousehold(config);
const [alex, sam] = H.people; // alex is admin, sam is not
const KEY = "test-passphrase-that-is-long-enough-0123456789";

type Log = [string, boolean, string | null][];
async function connect(build: (log: Log) => McpServer) {
  const log: Log = [];
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([build(log).connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const out: any = await client.callTool({ name, arguments: args });
    return { error: out.isError === true, text: out.content[0].text as string, json: () => JSON.parse(out.content[0].text) };
  };
  return { client, call, log };
}

test("every module that is on has a sound service and a server", () => {
  const list = servicesFor(H);
  assert.deepEqual(list.map((s) => s.id), ["household", "finance", "health"]);
  assert.deepEqual(serviceProblems(list), []);
  for (const s of list) assert.ok(SERVERS[s.id], `no server for ${s.id}`);
});

test("health MCP: tools follow the scopes, records stay with their person, the audit holds no values", async () => {
  const health = healthService({ HEALTH_DB: fakeD1(new URL("../../../modules/health/migrations/", import.meta.url)), HEALTH_DATA_ENCRYPTION_KEY: KEY, HOUSEHOLD: JSON.stringify(config) });
  const as = (p: Principal) => connect((log) => buildHealthServer(p, { h: H, health, log: (tool, ok, target) => void log.push([tool, ok, target]) }));

  const reader = await as({ actor: "oauth:Test", via: "oauth", scopes: ["health.read"], user: sam.email });
  const tools = (await reader.client.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name), ["health_schema", "health_overview", "health_list", "health_get", "health_trends"]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));

  const writer = await as({ actor: "oauth:Test", via: "oauth", scopes: ["health.read", "health.write"], user: sam.email });
  const all = (await writer.client.listTools()).tools;
  for (const t of all.filter((t) => /_(add|update|archive)$/.test(t.name))) assert.deepEqual([t.annotations?.readOnlyHint, t.annotations?.destructiveHint], [false, false], t.name);
  const added = await writer.call("health_add", { type: "vaccination", person: "sam", date: "2026-03-01", data: { for: "Tetanus", vaccine: "Made-up vaccine" } });
  assert.equal(added.error, false, added.text);
  const id = added.json().id as string;
  assert.equal((await writer.call("health_add", { type: "vaccination", person: "alex", date: "2026-03-01", data: { for: "Tetanus" } })).error, true, "not an admin: only their own");
  assert.equal((await writer.call("health_get", { id, person: "alex" })).error, true, "the named person must own the record");
  assert.equal((await writer.call("health_get", { id, person: "sam" })).json().data.for, "Tetanus");

  const admin = await as({ actor: "oauth:Test", via: "oauth", scopes: ["health.read"], user: alex.email });
  assert.equal((await admin.call("health_list", { person: "sam" })).json().length, 1, "an admin sees everyone's");
  const key = await as({ actor: "alfred", via: "key", scopes: ["health.read"] });
  assert.equal((await key.call("health_list", {})).json().length, 1);
  assert.doesNotMatch(JSON.stringify(writer.log), /Tetanus|Made-up/);

  const off = await connect((log) => buildHealthServer({ actor: "alfred", via: "key", scopes: ["health.read"] }, { h: H, health: undefined, log: (tool, ok, target) => void log.push([tool, ok, target]) }));
  assert.equal((await off.call("health_list", {})).error, true);
});

test("finance MCP: tools follow the scopes, admins and keys only, the audit holds no values", async () => {
  const finance = financeService({ FINANCE_DB: fakeD1(new URL("../../../modules/finance/migrations/", import.meta.url)), FINANCE_DATA_ENCRYPTION_KEY: KEY, HOUSEHOLD: JSON.stringify(config) }, (async () => new Response("", { status: 404 })) as typeof fetch);
  const as = (p: Principal) => connect((log) => buildFinanceServer(p, { h: H, finance, log: (tool, ok, target) => void log.push([tool, ok, target]) }));
  const ALL = ["finance.read", "finance.write", "finance.archive"];

  const reader = await as({ actor: "alfred", via: "key", scopes: ["finance.read"] });
  const tools = (await reader.client.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name), ["finance_overview", "finance_schema", "finance_history", "finance_list", "finance_get"]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));

  const admin = await as({ actor: "oauth:Test", via: "oauth", scopes: ALL, user: alex.email });
  const names = (await admin.client.listTools()).tools;
  assert.deepEqual(names.map((t) => t.name).slice(5), ["finance_create", "finance_update", "finance_balances", "finance_deadline_done", "finance_archive"]);
  for (const t of names.slice(5)) assert.deepEqual([t.annotations?.readOnlyHint, t.annotations?.destructiveHint], [false, false], t.name);

  const acc = await admin.call("finance_create", { table: "accounts", fields: { name: "Everyday", kind: "current", owner: "joint", currency: H.currency } });
  assert.equal(acc.error, false, acc.text);
  const id = acc.json().id as string;
  assert.equal((await admin.call("finance_balances", { as_of: "2026-06-01", items: [{ subject_kind: "account", subject_id: id, amount_cents: 1_500_00, currency: H.currency }] })).error, false);
  assert.equal((await reader.call("finance_overview", {})).json().totals.net, 1_500_00);
  assert.equal((await admin.call("finance_update", { table: "accounts", id, fields: { iban: "XX00" } })).error, true, "unknown fields are refused");
  assert.equal((await admin.call("finance_archive", { table: "accounts", id })).error, false);
  assert.equal((await reader.call("finance_list", { table: "accounts" })).json().length, 0);

  const member = await as({ actor: "oauth:Test", via: "oauth", scopes: ALL, user: sam.email });
  const refused = await member.call("finance_overview", {});
  assert.equal(refused.error, true);
  assert.match(refused.text, /admins only/);
  assert.doesNotMatch(JSON.stringify(admin.log), /Everyday|150000/);
  assert.deepEqual(admin.log[0], ["finance_create", true, "accounts"]);
});
