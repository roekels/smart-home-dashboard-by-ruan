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

test("calendar MCP: one scope per calendar and action, tools and calendar choices follow them", async () => {
  const { calendarService } = await import("../../calendar/src/service.ts");
  const { forgetDirectory } = await import("../../calendar/src/caldav.ts");
  const { fakeIcloud, ics } = await import("../../calendar/test/fakes/icloud.ts");
  const { buildCalendarServer } = await import("../src/tools/calendar.ts");
  const cfg = { ...example, modules: { ...example.modules, calendar: true } };
  const h = parseHousehold(cfg);
  const service = servicesFor(h).find((s) => s.id === "calendar")!;
  assert.deepEqual(serviceProblems(servicesFor(h)), []);
  assert.deepEqual(Object.keys(service.scopes), ["alex", "sam", "shared"].flatMap((c) => ["read", "add", "update", "remove"].map((o) => `cal.${c}.${o}`)));
  assert.deepEqual(service.groups!.map((g) => g.heading), ["Alex's calendar", "Sam's calendar", "Shared calendar"]);
  assert.ok(SERVERS.calendar);

  forgetDirectory();
  const cloud = fakeIcloud({ Alex: { A1: ics("A1", "(Dentist)", "20310610T090000Z", "20310610T093000Z") }, Sam: {}, Family: {} });
  const calendar = calendarService({ HOUSEHOLD: JSON.stringify(cfg), CALENDAR_ICLOUD_USER_ID: "someone@example.com", CALENDAR_ICLOUD_APP_PASSWORD: "app-pass" }, cloud.fetcher);
  const as = (scopes: string[]) => connect((log) => buildCalendarServer({ actor: "oauth:Test", via: "oauth", scopes, user: sam.email }, { h, calendar, log: (tool, ok, target) => void log.push([tool, ok, target]) }));

  const reader = await as(["cal.alex.read"]);
  const tools = (await reader.client.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name), ["calendars", "list_events", "find_events", "get_event"]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  assert.deepEqual((tools.find((t) => t.name === "get_event")!.inputSchema.properties as any).calendar.enum, ["alex"]);
  const listed = await reader.call("list_events", { from: "2031-06-01", to: "2031-06-30" });
  assert.deepEqual(listed.json().map((e: any) => [e.title, e.status]), [["Dentist", "idea"]]);
  assert.equal((await reader.call("list_events", { calendars: ["sam"] })).error, true, "not a calendar this connection may read");

  const full = await as(["cal.alex.read", "cal.alex.update", "cal.shared.add", "cal.shared.remove", "cal.shared.read"]);
  const all = (await full.client.listTools()).tools;
  assert.deepEqual(all.map((t) => t.name), ["calendars", "list_events", "find_events", "get_event", "add_event", "update_event", "confirm_event", "remove_event"]);
  const hints = Object.fromEntries(all.map((t) => [t.name, [t.annotations?.readOnlyHint, t.annotations?.destructiveHint]]));
  assert.deepEqual([hints.add_event, hints.update_event, hints.confirm_event, hints.remove_event], [[false, false], [false, false], [false, false], [false, true]]);
  assert.equal((await full.call("add_event", { calendar: "alex", title: "x", start: "2031-06-02" })).error, true, "add is only allowed on the shared calendar");
  assert.equal((await full.call("confirm_event", { calendar: "alex", uid: "A1" })).json().status, "confirmed");
  const added = await full.call("add_event", { calendar: "shared", title: "Picnic", start: "2031-06-07T12:00" });
  assert.equal(added.error, false, added.text);
  const uid = added.json().uid as string;
  assert.equal((await full.call("remove_event", { calendar: "shared", uid })).json().would_remove.title, "Picnic");
  assert.equal((await full.call("remove_event", { calendar: "shared", uid, confirm: true })).json().removed, uid);
  assert.deepEqual(full.log.at(-1), ["remove_event", true, `shared:${uid}`]);
  assert.equal(JSON.stringify(full.log).includes("Picnic"), false, "the audit holds no titles");

  const off = await connect((log) => buildCalendarServer({ actor: "k", via: "key", scopes: ["cal.alex.read"] }, { h, calendar: undefined, log: (tool, ok, target) => void log.push([tool, ok, target]) }));
  assert.match((await off.call("calendars")).text, /not connected/);
});
