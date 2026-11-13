// The setup scripts against a stand-in for Cloudflare's API. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { client } from "./lib/cloudflare.mjs";
import { buildPlan, describePlan, moduleFileProblems, siblingHost } from "./lib/plan.mjs";
import { zoneCandidates } from "./lib/account.mjs";
import { feasibility, passed } from "./feasibility.mjs";
import { provision } from "./provision.mjs";
import { teardown } from "./teardown.mjs";
import { verify } from "./verify.mjs";
import { deployOrder, deploySteps } from "./deploy.mjs";
import { machineSecretsFor, sha256 } from "./secrets.mjs";
import { render } from "./wrangler-config.mjs";
import { KEYPAGE_SECRET, closeKeyPage, openKeyPage } from "./keys.mjs";
import { handover } from "./handover.mjs";

const read = (p) => JSON.parse(readFileSync(new URL("../" + p, import.meta.url), "utf8"));
const example = read("household.config.example.json");
const config = { ...example, household: "Maple family", domain: "home.maple.example", resourcePrefix: "maple" };
const core = read("setup/modules/core.json");
const ACCOUNT = "a".repeat(32);
const DAY = 86_400_000;
const NOW = Date.parse("2026-01-10T00:00:00Z");

/** A stand-in account. `state` is what exists; every request is recorded in `calls`. */
function fakeCloudflare(over = {}) {
  const state = {
    token: { status: "active", expires_on: new Date(NOW + 3 * DAY).toISOString() },
    zones: [{ id: "z1", name: "maple.example", status: "active", account: { id: ACCOUNT } }],
    team: "maple-team", d1: [], kv: [], r2: [], r2On: true, apps: [], policies: {}, tokens: [], secrets: {}, sql: [], workers: [], apiTokens: [], mayMakeTokens: true,
    ...over,
  };
  const calls = [];
  let n = 0;
  const id = (len) => (++n).toString(16).padStart(len, "0");
  const ok = (result, extra = {}) => new Response(JSON.stringify({ success: true, result, ...extra }), { status: 200 });
  const err = (status, message) => new Response(JSON.stringify({ success: false, errors: [{ message }] }), { status });
  const fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : undefined;
    const path = u.pathname.replace("/client/v4", "");
    calls.push({ method, path, body });
    assert.equal(init.headers.authorization, "Bearer test-token");
    const a = `/accounts/${ACCOUNT}`;
    let m;
    if (path === "/user/tokens/verify") return state.token ? ok(state.token) : err(401, "Invalid API Token");
    if (path === "/zones") return ok(state.zones.filter((z) => z.name === u.searchParams.get("name")));
    if (path === `${a}/access/organizations`) return state.team ? ok({ auth_domain: `${state.team}.cloudflareaccess.com` }) : err(404, "access.api.error.not_found");
    if (path === `${a}/d1/database`) { if (method === "GET") return ok(state.d1); const d = { name: body.name, uuid: `${id(8)}-0000-4000-8000-${id(12)}` }; state.d1.push(d); return ok(d); }
    if ((m = path.match(`^${a}/d1/database/([^/]+)/query$`))) { state.sql.push(body); return ok([{ results: [] }]); }
    if ((m = path.match(`^${a}/d1/database/([^/]+)$`)) && method === "DELETE") { state.d1 = state.d1.filter((d) => d.uuid !== m[1]); return ok(null); }
    if (path === `${a}/storage/kv/namespaces`) { if (method === "GET") return ok(state.kv); const k = { title: body.title, id: id(32) }; state.kv.push(k); return ok(k); }
    if ((m = path.match(`^${a}/storage/kv/namespaces/([^/]+)$`)) && method === "DELETE") { state.kv = state.kv.filter((k) => k.id !== m[1]); return ok(null); }
    if (path === `${a}/r2/buckets`) { if (!state.r2On) return err(403, "Please enable R2 through the Cloudflare Dashboard."); if (method === "GET") return ok({ buckets: state.r2 }); state.r2.push({ name: body.name }); return ok({ name: body.name }); }
    if ((m = path.match(`^${a}/r2/buckets/([^/]+)$`)) && method === "DELETE") { state.r2 = state.r2.filter((b) => b.name !== m[1]); return ok(null); }
    if (path === `${a}/access/apps`) { if (method === "GET") return ok(state.apps); const app = { ...body, id: id(8), aud: id(64) }; state.apps.push(app); state.policies[app.id] = []; return ok(app); }
    if ((m = path.match(`^${a}/access/apps/([^/]+)/policies$`))) { if (method === "GET") return ok(state.policies[m[1]] ?? []); const p = { ...body, id: id(8) }; state.policies[m[1]].push(p); return ok(p); }
    if ((m = path.match(`^${a}/access/apps/([^/]+)/policies/([^/]+)$`)) && method === "PUT") { Object.assign(state.policies[m[1]].find((p) => p.id === m[2]), body); return ok(body); }
    if ((m = path.match(`^${a}/access/apps/([^/]+)$`))) { if (method === "PUT") { Object.assign(state.apps.find((x) => x.id === m[1]), body); return ok(body); } state.apps = state.apps.filter((x) => x.id !== m[1]); return ok(null); }
    if (path === `${a}/access/service_tokens`) { if (method === "GET") return ok(state.tokens); const t = { id: id(8), name: body.name, client_id: `${id(32)}.access`, client_secret: "made-" + id(8) }; state.tokens.push(t); return ok(t); }
    if ((m = path.match(`^${a}/access/service_tokens/([^/]+)/rotate$`))) { const t = state.tokens.find((x) => x.id === m[1]); t.client_secret = "rotated-" + id(8); return ok(t); }
    if ((m = path.match(`^${a}/access/service_tokens/([^/]+)$`)) && method === "DELETE") { state.tokens = state.tokens.filter((x) => x.id !== m[1]); return ok(null); }
    if ((m = path.match(`^${a}/workers/scripts/([^/]+)/secrets$`))) { const list = (state.secrets[m[1]] ??= {}); if (method === "GET") return ok(Object.keys(list).map((name) => ({ name, type: "secret_text" }))); list[body.name] = body.text; return ok({ name: body.name }); }
    if ((m = path.match(`^${a}/workers/scripts/([^/]+)/secrets/([^/]+)$`)) && method === "DELETE") { delete state.secrets[m[1]]?.[m[2]]; return ok(null); }
    if (path === "/user/tokens/permission_groups") return ok([{ id: "p".repeat(32), name: "Workers Scripts Read" }, { id: "w".repeat(32), name: "Workers Scripts Write" }]);
    if (path === "/user/tokens") { if (method === "GET") return ok(state.apiTokens.map(({ value, ...t }) => t)); if (!state.mayMakeTokens) return err(403, "Unauthorized to access requested resource"); const t = { ...body, id: id(32), value: "narrow-" + id(8) }; state.apiTokens.push(t); return ok(t); }
    if ((m = path.match("^/user/tokens/([^/]+)$")) && method === "DELETE") { state.apiTokens = state.apiTokens.filter((t) => t.id !== m[1]); return ok(null); }
    if ((m = path.match(`^${a}/workers/scripts/([^/]+)$`)) && method === "DELETE") { state.workers.push(m[1]); return ok(null); }
    return err(404, `the stand-in has no ${method} ${path}`);
  };
  return { state, calls, fetch, cf: (dryRun = false) => client({ token: "test-token", dryRun, fetch }) };
}

test("the client needs a token and never sends writes in a dry run", async () => {
  assert.throws(() => client({ token: "" }), /SETUP_CLOUDFLARE_FULL_TOKEN is not set/);
  const f = fakeCloudflare();
  const cf = f.cf(true);
  await cf.post(`/accounts/${ACCOUNT}/d1/database`, { name: "x" });
  assert.equal(f.calls.length, 0);
  assert.equal(cf.writes.length, 1);
});

test("the zone of a domain is the domain or one of its parents", () => {
  assert.deepEqual(zoneCandidates("home.maple.example"), ["home.maple.example", "maple.example"]);
  assert.equal(siblingHost("home.maple.example", "kiosk"), "kiosk.maple.example");
});

test("plan: core only, with the household's prefix and people", () => {
  const plan = buildPlan(config);
  assert.deepEqual(plan.modules, ["core"]);
  assert.deepEqual(plan.notBuilt.sort(), ["brain", "dataExport"].filter((m) => !plan.modules.includes(m)).sort());
  assert.deepEqual(plan.workers.map((w) => w.name), ["maple-gateway", "maple-shell"]);
  assert.deepEqual(plan.d1.map((d) => d.name), ["maple-gateway"]);
  const family = plan.access.find((a) => a.key === "family");
  assert.deepEqual(family.domains, ["home.maple.example"]);
  assert.deepEqual(family.policy.include, [{ email: { email: "alex@example.com" } }, { email: { email: "sam@example.com" } }]);
  const machine = plan.access.find((a) => a.key === "machine");
  assert.ok(machine.domains.includes("home.maple.example/household/mcp*"));
  assert.ok(!machine.domains.some((d) => d.endsWith("/oauth/authorize")), "the consent page stays behind the sign-in");
  assert.match(describePlan(plan), /Maple family[\s\S]*maple-gateway[\s\S]*Household members|maple-family/);
});

// A made-up module that uses every part of the format.
const lamp = {
  module: "homeAssistant",
  d1: [{ name: "home" }], r2: [{ name: "home-files" }],
  workers: [{ app: "lamp", compatibilityFlags: ["nodejs_compat"], durableObjects: [{ binding: "ROOMS", className: "Room" }], services: [{ binding: "GATEWAY", app: "gateway" }, { binding: "GONE", app: "nothere" }], vars: { LAMP_MODE: "soft" }, crons: ["0 3 * * *"] }],
  shell: { d1: [{ binding: "HOME_DB", store: "home", migrations: "home-migrations" }], r2: [{ binding: "HOME_FILES", store: "home-files" }], services: [{ binding: "LAMP", app: "lamp", entrypoint: "LampUi" }], crons: ["* * * * *"] },
  gateway: { services: [{ binding: "LAMP", app: "lamp", entrypoint: "LampMcp" }] },
  hosts: [{ key: "kiosk", label: "kiosk", use: "customDomain", app: "shell", var: { app: "shell", name: "KIOSK_HOST" } }, { key: "homeAssistant", label: "ha", use: "tunnel", var: { app: "shell", name: "HA_URL", asUrl: true } }],
  secrets: [{ name: "HA_API_LONGLIVED_TOKEN", app: "shell" }, { name: "HA_TUNNEL_SERVICE_TOKEN_ID", app: "shell" }, { name: "HA_TUNNEL_SERVICE_TOKEN_KEY", app: "shell" }, { name: "ALFRED_GATEWAY_KEY", app: "lamp" }],
  gatewayKeys: [{ name: "lamp", scopes: ["household.read"], secret: "ALFRED_GATEWAY_KEY", app: "lamp" }],
  serviceTokens: [{ name: "ha-tunnel", for: "host:homeAssistant", app: "shell", idSecret: "HA_TUNNEL_SERVICE_TOKEN_ID", keySecret: "HA_TUNNEL_SERVICE_TOKEN_KEY" }],
  publicPaths: ["/home/mcp*"], serviceAuthPaths: ["/api/agents/*"],
  checks: [{ name: "home MCP refuses a caller with no token", path: "/home/mcp", method: "POST", expectStatus: 401 }],
};
const withLamp = { ...config, modules: { ...config.modules, homeAssistant: true } };
const files = { core, homeAssistant: lamp };

test("plan: a module adds stores, a Worker, bindings, hosts and Access applications", () => {
  const plan = buildPlan(withLamp, files);
  const shell = plan.workers.find((w) => w.app === "shell"), lampW = plan.workers.find((w) => w.app === "lamp");
  assert.deepEqual(shell.d1.map((b) => b.binding), ["HOME_DB"]);
  assert.deepEqual(shell.customDomains, ["kiosk.maple.example"]);
  assert.equal(shell.vars.KIOSK_HOST, "kiosk.maple.example");
  assert.equal(shell.vars.HA_URL, "https://ha.maple.example");
  assert.deepEqual(lampW.services.map((s) => s.binding), ["GATEWAY"], "a binding to a Worker that is not installed is dropped");
  assert.deepEqual(plan.access.map((a) => a.name), ["maple-family", "maple-machine", "maple-homeassistant-machines", "maple-homeassistant-tunnel"]);
  assert.deepEqual(plan.access.at(-1).domains, ["ha.maple.example"]);
  const moved = buildPlan({ ...withLamp, hosts: { kiosk: "wall.maple.example" } }, files);
  assert.equal(moved.workers.find((w) => w.app === "shell").vars.KIOSK_HOST, "wall.maple.example");
});

test("plan: a module that is off adds nothing", () => {
  const plan = buildPlan(config, files);
  assert.deepEqual(plan.workers.map((w) => w.app), ["gateway", "shell"]);
  assert.equal(plan.workers.find((w) => w.app === "shell").d1.length, 0);
});

test("module files are checked", () => {
  const names = new Set(read("secrets.manifest.json").secrets.map((s) => s.name));
  assert.deepEqual(moduleFileProblems(core, names), []);
  assert.deepEqual(moduleFileProblems(lamp, names), []);
  assert.match(moduleFileProblems({ ...lamp, secrets: [{ name: "LAMP_MADE_UP_KEY", app: "lamp" }] }, names).join(), /not in secrets.manifest.json/);
  assert.match(moduleFileProblems({ module: "x", workers: [{ app: "x", vars: { X_API_KEY: "oops" } }] }, names).join(), /named like a secret/);
  assert.throws(() => buildPlan(withLamp, { core, homeAssistant: { ...lamp, d1: [] } }), /points at d1 store "home", which no installed module declares/);
  assert.throws(() => buildPlan(withLamp, { core, homeAssistant: { ...lamp, d1: [{ name: "gateway" }, { name: "home" }] } }), /two modules declare the d1 store "gateway"/);
});

test("wrangler configs: a module's Worker and its additions to the shell and gateway", () => {
  const resources = { accessTeam: "maple-team", accessAud: "b".repeat(64), d1: { gateway: "11111111-0000-4000-8000-000000000001", home: "11111111-0000-4000-8000-000000000002" }, kv: { "gateway-oauth": "c".repeat(32) } }; // scrub-check: allow (test fixture)
  const out = render({ config: withLamp, resources }, files);
  const parse = (text) => JSON.parse(text.split("\n").filter((l) => !l.startsWith("//")).join("\n"));
  const shell = parse(out["apps/shell/wrangler.jsonc"]), lampC = parse(out["apps/lamp/wrangler.jsonc"]), gateway = parse(out["apps/gateway/wrangler.jsonc"]);
  assert.deepEqual(shell.routes.map((r) => r.pattern), ["home.maple.example", "kiosk.maple.example"]);
  assert.deepEqual(shell.d1_databases, [{ binding: "HOME_DB", database_name: "maple-home", database_id: resources.d1.home, migrations_dir: "home-migrations" }]);
  assert.deepEqual(shell.r2_buckets, [{ binding: "HOME_FILES", bucket_name: "maple-home-files" }]);
  assert.deepEqual(shell.services, [{ binding: "LAMP", service: "maple-lamp", entrypoint: "LampUi" }]);
  assert.deepEqual(shell.triggers.crons, ["* * * * *"]);
  assert.equal(lampC.name, "maple-lamp");
  assert.equal(lampC.routes, undefined, "a module's Worker has no address of its own");
  assert.equal(lampC.workers_dev, false);
  assert.deepEqual(lampC.durable_objects.bindings, [{ name: "ROOMS", class_name: "Room" }]);
  assert.deepEqual(lampC.migrations, [{ tag: "v1", new_sqlite_classes: ["Room"] }]);
  assert.equal(JSON.parse(lampC.vars.HOUSEHOLD).household, "Maple family");
  assert.equal(lampC.vars.LAMP_MODE, "soft");
  assert.deepEqual(gateway.services, [{ binding: "LAMP", service: "maple-lamp", entrypoint: "LampMcp" }]);
  assert.throws(() => render({ config: withLamp, resources: { ...resources, d1: {} } }, files), /d1.gateway.*d1.home/s);
});

test("feasibility: a good account passes; each blocker is named", async () => {
  const good = await feasibility({ cf: fakeCloudflare().cf(), config, now: NOW });
  assert.ok(passed(good), JSON.stringify(good.filter((r) => r.level === "fail")));
  const fails = async (over, cfg = config) => (await feasibility({ cf: fakeCloudflare(over).cf(), config: cfg, now: NOW })).filter((r) => r.level === "fail").map((r) => r.text).join("\n");
  assert.match(await fails({ token: { status: "active" } }), /never expires/);
  assert.match(await fails({ token: { status: "active", expires_on: new Date(NOW + 30 * DAY).toISOString() } }), /expires in 30 days; it must expire within 7/);
  assert.match(await fails({ token: null }), /token was refused/);
  assert.match(await fails({ zones: [] }), /no zone for home.maple.example/);
  assert.match(await fails({ zones: [{ id: "z", name: "maple.example", status: "pending", account: { id: ACCOUNT } }] }), /not active yet/);
  assert.match(await fails({ team: null }), /Zero Trust is not set up/);
  assert.match(await fails({}, example), /still the example/);
  assert.match(await fails({}, { ...config, people: [] }), /1 to 6 people/);
  assert.match((await feasibility({ cf: fakeCloudflare().cf(), config, now: NOW, nodeVersion: "20.11.0" }))[0].text, /too old/);
});

test("provision: a dry run changes nothing and says what it would do", async () => {
  const f = fakeCloudflare();
  const { actions } = await provision({ cf: f.cf(true), config });
  assert.ok(f.calls.every((c) => c.method === "GET"));
  assert.deepEqual(f.state.d1, []);
  assert.deepEqual(actions.filter((a) => a.startsWith("create")), ["create database maple-gateway", "create KV store maple-gateway-oauth", "create Access application maple-family", "create Access application maple-machine"]);
});

test("provision: creates everything once, then reuses it", async () => {
  const f = fakeCloudflare();
  const first = await provision({ cf: f.cf(), config });
  assert.equal(first.resources.accountId, ACCOUNT);
  assert.equal(first.resources.accessTeam, "maple-team");
  assert.equal(first.resources.accessAud, f.state.apps.find((a) => a.name === "maple-family").aud);
  assert.equal(first.resources.d1.gateway, f.state.d1[0].uuid);
  assert.equal(first.resources.kv["gateway-oauth"], f.state.kv[0].id);
  assert.equal("placeholders" in first.resources, false);
  const family = f.state.apps.find((a) => a.name === "maple-family");
  assert.deepEqual(f.state.policies[family.id].map((p) => [p.decision, p.include.length]), [["allow", 2]]);
  const machine = f.state.apps.find((a) => a.name === "maple-machine");
  assert.equal(f.state.policies[machine.id][0].decision, "bypass");
  assert.ok(render({ config, resources: first.resources })["apps/gateway/wrangler.jsonc"].includes(f.state.d1[0].uuid));

  const writesBefore = f.calls.filter((c) => c.method !== "GET").length;
  const second = await provision({ cf: f.cf(), config, resources: first.resources });
  assert.equal(f.calls.filter((c) => c.method !== "GET").length, writesBefore, "a second run writes nothing");
  assert.ok(second.actions.every((a) => a.startsWith("reuse")));
  assert.deepEqual(second.resources, first.resources);
});

test("provision: a new person in the config updates the sign-in policy, nothing else", async () => {
  const f = fakeCloudflare();
  const first = await provision({ cf: f.cf(), config });
  const more = { ...config, people: [...config.people, { id: "kit", name: "Kit", email: "kit@example.com" }] };
  const { actions } = await provision({ cf: f.cf(), config: more, resources: first.resources });
  assert.deepEqual(actions.filter((a) => !a.startsWith("reuse")), ['  update policy "Household members"']);
  const family = f.state.apps.find((a) => a.name === "maple-family");
  assert.equal(f.state.policies[family.id][0].include.length, 3);
});

test("provision: a policy someone else made is left alone and mentioned", async () => {
  const f = fakeCloudflare();
  await provision({ cf: f.cf(), config });
  const family = f.state.apps.find((a) => a.name === "maple-family");
  f.state.policies[family.id].push({ id: "x", name: "Grandma", decision: "allow", include: [] });
  const { actions } = await provision({ cf: f.cf(), config });
  assert.ok(actions.some((a) => /"Grandma" was not made by this setup/.test(a)));
  assert.equal(f.state.policies[family.id].length, 2);
});

test("deploy: a database is migrated before its Worker; a Worker follows the ones it binds to", () => {
  const steps = deploySteps(buildPlan(config)).map((s) => `${s.cwd}: ${s.cmd} ${s.args.join(" ")}`);
  assert.deepEqual(steps, [
    "apps/gateway: npm ci", "apps/gateway: npx wrangler d1 migrations apply maple-gateway --remote", "apps/gateway: npm run deploy",
    "apps/shell: npm ci", "apps/shell: npm run deploy",
  ]);
  assert.deepEqual(deployOrder(buildPlan(withLamp, files).workers).map((w) => w.app), ["gateway", "lamp", "shell"]);
});

test("machine secrets: made, set on the right Worker, never reported; a second run keeps them", async () => {
  const f = fakeCloudflare();
  const resources = { accountId: ACCOUNT, d1: { gateway: "11111111-0000-4000-8000-000000000001" } }; // scrub-check: allow (test fixture)
  const manifest = read("secrets.manifest.json");
  const run = () => machineSecretsFor({ cf: f.cf(), plan: buildPlan(withLamp, files), resources, manifest, makeKey: (n) => `hmcp_${n}_fixed`, now: () => "2026-01-10T00:00:00.000Z" });
  const first = await run();
  assert.equal(f.state.tokens[0].name, "maple-ha-tunnel");
  assert.equal(f.state.secrets["maple-shell"].HA_TUNNEL_SERVICE_TOKEN_KEY, f.state.tokens[0].client_secret);
  assert.equal(f.state.secrets["maple-lamp"].ALFRED_GATEWAY_KEY, "hmcp_lamp_fixed");
  assert.deepEqual(f.state.sql[0].params, ["lamp", sha256("hmcp_lamp_fixed"), '["household.read"]', "2026-01-10T00:00:00.000Z"]);
  assert.equal(JSON.stringify(first).includes("hmcp_lamp_fixed"), false, "the key's value is not in what the script reports");
  assert.equal(JSON.stringify(first).includes(f.state.tokens[0].client_secret), false);
  assert.deepEqual(first.todo.user.map((s) => s.name), ["HA_API_LONGLIVED_TOKEN"]);
  const writes = f.calls.filter((c) => c.method !== "GET").length;
  const second = await run();
  assert.equal(f.calls.filter((c) => c.method !== "GET").length, writes);
  assert.ok(second.actions.every((a) => a.startsWith("keep")));
});

test("verify: status checks and the sign-in redirect", async () => {
  const plan = buildPlan(config);
  const answers = { "/login": [200], "/home": [302, "https://maple-team.cloudflareaccess.com/cdn-cgi/access/login/home.maple.example"], "/oauth/health": [200], "/household/mcp": [401] }; // scrub-check: allow (test fixture)
  const f = (open) => async (url) => { const [status, location] = (open ? { ...answers, "/home": [200] } : answers)[new URL(url).pathname]; return new Response(null, { status, headers: location ? { location } : {} }); };
  assert.ok((await verify({ plan, fetch: f(false) })).every((r) => r.ok));
  const bad = await verify({ plan, fetch: f(true) });
  assert.match(bad.find((r) => !r.ok).detail, /may be open to everyone/);
});

test("teardown: removes only this household's things; a dry run removes nothing", async () => {
  const f = fakeCloudflare();
  await provision({ cf: f.cf(), config });
  f.state.d1.push({ name: "someone-elses", uuid: "keep" });
  const dry = await teardown({ cf: f.cf(true), config });
  assert.equal(f.state.d1.length, 2);
  assert.ok(dry.actions.includes("remove database maple-gateway and all its data"));
  await teardown({ cf: f.cf(), config });
  assert.deepEqual(f.state.d1, [{ name: "someone-elses", uuid: "keep" }]);
  assert.deepEqual(f.state.kv, []);
  assert.deepEqual(f.state.apps, []);
  assert.deepEqual(f.state.workers.sort(), ["maple-gateway", "maple-shell"]);
});

// A made-up module with keys the key page makes.
const vault = { module: "health", workers: [{ app: "vault" }], secrets: [{ name: "HEALTH_DATA_ENCRYPTION_KEY", app: "vault" }, { name: "EXPORT_ZIP_PASSPHRASE", app: "shell" }] };
const withVault = { ...config, modules: { ...config.modules, health: true } };

test("key page: open makes a narrow one-day token and hands it only to the Worker; close removes both", async () => {
  const f = fakeCloudflare();
  const input = () => ({ cf: f.cf(), plan: buildPlan(withVault, { core, health: vault }), resources: { accountId: ACCOUNT }, manifest: read("secrets.manifest.json"), now: NOW });
  const opened = await openKeyPage(input());
  assert.equal(opened.state, "open");
  assert.equal(opened.address, "https://home.maple.example/setup/keys");
  const token = f.state.apiTokens[0];
  assert.equal(token.name, "maple-setup-keypage");
  assert.deepEqual(token.policies, [{ effect: "allow", resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: "*" }, permission_groups: [{ id: "w".repeat(32) }] }]);
  assert.equal(token.expires_on, "2026-01-11T00:00:00Z");
  const pass = JSON.parse(f.state.secrets["maple-shell"][KEYPAGE_SECRET]);
  assert.equal(pass.token, token.value);
  assert.deepEqual(pass.keys, [{ name: "HEALTH_DATA_ENCRYPTION_KEY", worker: "maple-vault" }, { name: "EXPORT_ZIP_PASSPHRASE", worker: "maple-shell" }]);
  assert.equal(JSON.stringify(opened).includes(token.value), false, "the token's value is not in what the script reports");

  // opening again replaces the token instead of leaving two
  await openKeyPage(input());
  assert.equal(f.state.apiTokens.length, 1);

  const early = await closeKeyPage(input());
  assert.equal(early.ok, false);
  assert.deepEqual(early.missing.map((k) => k.name), ["HEALTH_DATA_ENCRYPTION_KEY", "EXPORT_ZIP_PASSPHRASE"]);
  assert.equal(f.state.apiTokens.length, 0);
  assert.equal(KEYPAGE_SECRET in f.state.secrets["maple-shell"], false);

  f.state.secrets["maple-vault"] = { HEALTH_DATA_ENCRYPTION_KEY: "x" };
  f.state.secrets["maple-shell"].EXPORT_ZIP_PASSPHRASE = "y";
  assert.equal((await closeKeyPage(input())).ok, true);
  assert.equal((await openKeyPage(input())).state, "done", "keys that are stored are never made again");
});

test("key page: nothing to do without key-page secrets; a dry run changes nothing; a token that cannot make tokens is explained", async () => {
  const f = fakeCloudflare();
  assert.equal((await openKeyPage({ cf: f.cf(), plan: buildPlan(config), resources: { accountId: ACCOUNT }, now: NOW })).state, "nothing");
  const dry = await openKeyPage({ cf: f.cf(true), plan: buildPlan(withVault, { core, health: vault }), resources: { accountId: ACCOUNT }, now: NOW });
  assert.equal(dry.state, "open");
  assert.equal(f.calls.filter((c) => c.method !== "GET").length, 0);
  const g = fakeCloudflare({ mayMakeTokens: false });
  await assert.rejects(openKeyPage({ cf: g.cf(), plan: buildPlan(withVault, { core, health: vault }), resources: { accountId: ACCOUNT }, now: NOW }), /may not create other tokens/);
});

test("handover: passes only when the full token is gone", async () => {
  assert.equal((await handover({ token: "" })).gone, true);
  const f = fakeCloudflare();
  assert.equal((await handover({ token: "test-token", fetch: f.fetch })).gone, false);
  f.state.token = null;
  assert.equal((await handover({ token: "test-token", fetch: f.fetch })).gone, true);
});

test("plan: {person} in a gateway key's scope becomes one scope per person", () => {
  const perPerson = { ...lamp, gatewayKeys: [{ ...lamp.gatewayKeys[0], scopes: ["household.read", "cal.{person}.read", "cal.shared.read"] }] };
  const plan = buildPlan(withLamp, { core, homeAssistant: perPerson });
  const ids = plan.household.people.map((p) => p.id);
  assert.ok(ids.length >= 2);
  assert.deepEqual(plan.gatewayKeys[0].scopes, ["household.read", ...ids.map((id) => `cal.${id}.read`), "cal.shared.read"]);
});
