import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseHousehold, type Household } from "../../../packages/core/src/household.ts";
import { sha256hex } from "../../../packages/core/src/util.ts";
import {
  SERVICE_DEFS, baseUrl, cutScopes, oauthScopes, resourceOf, routePatterns, serviceForPath, serviceForResource, serviceProblems, servicesFor, type Service, type ServiceDef,
} from "../src/services.ts";
import { allowedRedirect } from "../src/clients.ts";
import { KEY_SHAPE, principalFromKey } from "../src/keys.ts";
import { audit } from "../src/util.ts";
import { consentBody, page, tickedScopes } from "../src/consent.ts";
import { buildHouseholdServer, householdInfo } from "../src/tools/household.ts";
import { SERVERS } from "../src/servers.ts";
import type { Env, Principal } from "../src/env.ts";
import { fakeD1 } from "./fakes/d1.ts";

const example = JSON.parse(readFileSync(new URL("../../../household.config.example.json", import.meta.url), "utf8"));
const H: Household = parseHousehold(example);
const BASE = "https://home.example.com";

/** Made-up module MCPs, shaped like the ones later phases add. */
const brain: ServiceDef = {
  module: "brain", path: "/brain/mcp",
  build: () => ({ id: "brain", title: "the notes", path: "/brain/mcp", prefix: "brain.", scopes: { "brain.read": "Read notes", "brain.update": "Edit notes" }, keyOnly: ["brain.admin"] }),
};
const calendar: ServiceDef = {
  module: "calendar", path: "/calendar/mcp",
  build: (h) => ({
    id: "calendar", title: "the calendars", path: "/calendar/mcp", prefix: "cal.",
    scopes: Object.fromEntries(h.people.map((p) => [`cal.${p.id}.read`, `${p.name}'s calendar: see events`])),
    groups: h.people.map((p) => ({ heading: p.name, scopes: [`cal.${p.id}.read`] })),
  }),
};
/** The core MCP plus the made-up ones: these tests are about the registry's rules, not about the real modules. */
const CORE = SERVICE_DEFS.filter((d) => d.module === "core");
const DEFS = [...CORE, brain, calendar];
const withCalendar = parseHousehold({ ...example, modules: { ...example.modules, calendar: true } });

test("services: the core MCP always, a module's MCP only when the module is on", () => {
  assert.deepEqual(servicesFor(H).map((s) => s.id), ["household"]);
  assert.deepEqual(servicesFor(H, DEFS).map((s) => s.id), ["household", "brain"], "calendar is off in the example");
  assert.deepEqual(servicesFor(withCalendar, DEFS).map((s) => s.id), ["household", "brain", "calendar"]);
});

test("services: scopes can follow the household's people", () => {
  const cal = servicesFor(withCalendar, DEFS).find((s) => s.id === "calendar")!;
  assert.deepEqual(Object.keys(cal.scopes), ["cal.alex.read", "cal.sam.read"]);
  assert.deepEqual(serviceProblems(servicesFor(withCalendar, DEFS)), []);
});

test("services: every built service has a server, and the registry is sound", () => {
  const list = servicesFor(H);
  assert.deepEqual(serviceProblems(list), []);
  for (const s of list) assert.ok(SERVERS[s.id], `no server for ${s.id}`);
  for (const d of SERVICE_DEFS) assert.equal(d.build(H).path, d.path, "the route path and the service path agree");
});

test("services: a broken registry is caught", () => {
  const bad: Service[] = [
    { id: "a", title: "a", path: "/a/mcp", prefix: "a.", scopes: { "a.read": "x", "b.read": "wrong prefix" } },
    { id: "a", title: "again", path: "/a", prefix: "a.sub.", scopes: {}, groups: [{ heading: "g", scopes: ["a.nope"] }] },
  ];
  const problems = serviceProblems(bad).join("\n");
  for (const want of [/scope b\.read must start with a\./, /listed twice/, /path must look like/, /unknown scope a\.nope/, /prefix overlaps/]) assert.match(problems, want);
});

test("services: paths and resources", () => {
  const list = servicesFor(H, DEFS);
  assert.equal(serviceForPath(list, "/brain/mcp")?.id, "brain");
  assert.equal(serviceForPath(list, "/brain/mcp/x")?.id, "brain");
  assert.equal(serviceForPath(list, "/brain/mcpx"), null);
  assert.equal(serviceForPath(list, "/calendar/mcp"), null, "off = not there");
  assert.equal(serviceForResource(list, BASE, `${BASE}/household/mcp`)?.id, "household");
  assert.equal(serviceForResource(list, BASE, "https://elsewhere.example/household/mcp"), null);
  assert.equal(serviceForResource(list, BASE, undefined), null);
  assert.equal(baseUrl(H), BASE);
  assert.equal(baseUrl(H, "http://localhost:8788/"), "http://localhost:8788");
  assert.equal(resourceOf(BASE, list[0]), `${BASE}/household/mcp`);
});

test("scopes: each MCP sees only its own; key-only scopes never travel over OAuth", () => {
  const [household, notes] = servicesFor(H, DEFS);
  const held = ["household.read", "brain.read", "brain.admin", "brain.read", 7, "finance.write"];
  assert.deepEqual(cutScopes(held, household, "key"), ["household.read"]);
  assert.deepEqual(cutScopes(held, notes, "key"), ["brain.read", "brain.admin"]);
  assert.deepEqual(cutScopes(held, notes, "oauth"), ["brain.read"]);
  assert.equal(oauthScopes([household, notes]).includes("brain.admin"), false);
});

test("routes: one per MCP plus the OAuth paths, on the household's domain", () => {
  assert.deepEqual(routePatterns("home.example.com", CORE), ["home.example.com/household/mcp*", "home.example.com/oauth/*", "home.example.com/.well-known/oauth-*"]);
  assert.ok(routePatterns("home.example.com", DEFS).includes("home.example.com/brain/mcp*"));
  for (const d of SERVICE_DEFS) assert.ok(routePatterns("home.example.com").includes(`home.example.com${d.path}*`), d.path);
});

test("clients: only the listed AI apps and loopback may receive access", () => {
  for (const ok of ["https://claude.ai/api/mcp/auth_callback", "https://app.claude.com/cb", "https://chatgpt.com/connector_platform_oauth_redirect", "http://localhost:53124/callback", "http://127.0.0.1:9000/cb"]) assert.equal(allowedRedirect(ok), true, ok);
  for (const no of ["https://claude.ai.elsewhere.example/cb", "https://notclaude.ai/cb", "http://claude.ai/cb", "https://localhost/cb", "https://user:pw@claude.ai/cb", "javascript:alert(1)", "not a url", "http://192.0.2.1/cb"]) assert.equal(allowedRedirect(no), false, no); // scrub-check: allow (test fixtures)
});

test("keys: only a known, unrevoked key of the right shape; only its hash is stored", async () => {
  const DB = fakeD1();
  const key = "hmcp_alfred_" + "A1b2C3d4E5".repeat(4);
  const add = (name: string, k: string, scopes: string, revoked: string | null = null) =>
    sha256hex(k).then((h) => DB.prepare("INSERT INTO api_keys (name, sha256, scopes, created, revoked_at) VALUES (?, ?, ?, ?, ?)").bind(name, h, scopes, "2026-01-01", revoked).run());
  await add("alfred", key, '["household.read", 5, "brain.read"]');
  await add("old", key.replace("alfred", "old"), '["household.read"]', "2026-02-01");
  await add("broken", key.replace("alfred", "broken"), "not json");

  assert.equal(KEY_SHAPE.test(key), true);
  assert.deepEqual(await principalFromKey({ DB }, key), { actor: "alfred", via: "key", scopes: ["household.read", "brain.read"] });
  assert.ok((await DB.prepare("SELECT last_used FROM api_keys WHERE name = ?").bind("alfred").first<{ last_used: string }>())?.last_used, "last use is recorded");
  assert.equal(await principalFromKey({ DB }, key.replace("alfred", "old")), null, "revoked");
  assert.equal(await principalFromKey({ DB }, key.replace("alfred", "broken")), null, "unreadable scopes fail closed");
  assert.equal(await principalFromKey({ DB }, key.replace("alfred", "nobody")), null, "unknown");
  assert.equal(await principalFromKey({ DB }, "hmcp_short_abc"), null, "wrong shape");
  assert.equal(await principalFromKey({ DB }, "some-oauth-token"), null);
  const stored = await DB.prepare("SELECT * FROM api_keys").all();
  assert.equal(JSON.stringify(stored.results).includes(key), false);
});

test("audit: one row per call, long values cut, a failing database never breaks the call", async () => {
  const DB = fakeD1();
  const env = { DB } as Env;
  const waits: Promise<unknown>[] = [];
  await audit(env, { waitUntil: (p) => void waits.push(p) }, { service: "household", actor: "alfred", via: "key", tool: "household_info", target: "x".repeat(400), ok: false, detail: "d".repeat(900) });
  const row = await DB.prepare("SELECT * FROM audit").first<Record<string, any>>();
  assert.equal(waits.length, 1);
  assert.equal(row?.ok, 0);
  assert.equal(row?.target.length, 300);
  assert.equal(row?.detail.length, 500);
  const broken = { DB: { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("down"); } }) }) } } as unknown as Env;
  const quiet = console.error;
  console.error = () => {};
  try { await audit(broken, undefined, { service: "s", actor: "a", via: "key", tool: "t", ok: true }); } finally { console.error = quiet; }
});

test("consent page: this MCP's scopes only, asked ones ticked, everything escaped", async () => {
  const cal = servicesFor(withCalendar, DEFS).find((s) => s.id === "calendar")!;
  assert.deepEqual([...tickedScopes(cal, ["cal.sam.read", "brain.read"])], ["cal.sam.read"]);
  assert.deepEqual([...tickedScopes(cal, ["brain.read"])], ["cal.alex.read", "cal.sam.read"], "asked for nothing here: everything ticked, to untick");
  const html = consentBody({ service: cal, signedInAs: "Alex", clientName: `<script>alert(1)</script>`, redirectHost: "claude.ai", redirectIsLoopback: false, asked: ["cal.sam.read"], handle: `h"1` });
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /value="h&quot;1"/);
  assert.match(html, /<h2>Alex<\/h2>.*<h2>Sam<\/h2>/s);
  assert.match(html, /value="cal\.sam\.read" checked/);
  assert.equal(/value="cal\.alex\.read" checked/.test(html), false);
  assert.equal(html.includes("brain."), false);
  assert.match(html, /name is not verified/);
  assert.match(consentBody({ service: cal, signedInAs: "Alex", clientName: "CLI", clientDomain: "app.example.com", redirectHost: "localhost:5000", redirectIsLoopback: true, asked: [], handle: "h" }), /app on this computer.*localhost:5000/s);
  const res = page("T", "<h1>x</h1>", 403);
  assert.equal(res.status, 403);
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(/<script/i.test(await res.text()), false);
});

test("household MCP: first names and addresses, never emails; refused without the scope", async () => {
  const services = servicesFor(H);
  const info = householdInfo(H, services, BASE);
  assert.deepEqual(info.people, [{ id: "alex", name: "Alex", admin: true }, { id: "sam", name: "Sam", admin: false }]);
  assert.deepEqual(info.mcps, [{ id: "household", url: `${BASE}/household/mcp`, scopes: ["household.read"] }]);
  assert.equal(JSON.stringify(info).includes("@"), false);

  async function connect(p: Principal) {
    const log: [string, boolean][] = [];
    const server = buildHouseholdServer(p, { h: H, services, base: BASE, log: (tool, ok) => void log.push([tool, ok]) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, log };
  }
  const ok = await connect({ actor: "oauth:Test", via: "oauth", scopes: ["household.read"] });
  assert.deepEqual((await ok.client.listTools()).tools.map((t) => t.name), ["household_info"]);
  const out: any = await ok.client.callTool({ name: "household_info", arguments: {} });
  assert.equal(JSON.parse(out.content[0].text).household, "Example family");
  assert.deepEqual(ok.log, [["household_info", true]]);

  const no = await connect({ actor: "alfred", via: "key", scopes: [] });
  const refused: any = await no.client.callTool({ name: "household_info", arguments: {} });
  assert.equal(refused.isError, true);
  assert.deepEqual(no.log, [["household_info", false]]);
});
