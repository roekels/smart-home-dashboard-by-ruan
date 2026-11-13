// What a household needs in Cloudflare, worked out from its config and the module files in setup/modules/.
// Pure: no network. wrangler-config.mjs renders it, provision.mjs applies it, teardown.mjs removes it, verify.mjs
// runs its checks. The format of a module file is described in setup/README.md.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { enabledModules, parseHousehold, resourceName } from "../../packages/core/src/household.ts";

const MODULE_DIR = fileURLToPath(new URL("../modules/", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../../secrets.manifest.json", import.meta.url));
const SHORT = /^[a-z][a-z0-9-]*$/;
const BINDING = /^[A-Z][A-Z0-9_]*$/;
const LISTS = ["d1", "kv", "r2", "workers", "hosts", "secrets", "gatewayKeys", "serviceTokens", "publicPaths", "serviceAuthPaths", "checks"];
const ADDS = ["d1", "kv", "r2", "durableObjects", "services", "crons"];

/** Every module file, by module id. */
export function loadModuleFiles(dir = MODULE_DIR) {
  const out = {};
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const m = JSON.parse(readFileSync(join(dir, name), "utf8"));
    out[m.module] = m;
  }
  return out;
}

export const manifestNames = (path = MANIFEST) => new Set(JSON.parse(readFileSync(path, "utf8")).secrets.map((s) => s.name));

function bindingProblems(at, w, out) {
  for (const key of ADDS) if (w?.[key] !== undefined && !Array.isArray(w[key])) out.push(`${at}: "${key}" must be a list`);
  for (const kind of ["d1", "kv", "r2"]) for (const b of w?.[kind] ?? []) {
    if (!BINDING.test(b?.binding ?? "")) out.push(`${at}: a ${kind} binding needs an UPPER_CASE "binding"`);
    if (!SHORT.test(b?.store ?? "")) out.push(`${at}: a ${kind} binding needs the short "store" name it points at`);
  }
  for (const d of w?.durableObjects ?? []) if (!BINDING.test(d?.binding ?? "") || !/^[A-Z][A-Za-z0-9]*$/.test(d?.className ?? "")) out.push(`${at}: a Durable Object needs "binding" and "className"`);
  for (const s of w?.services ?? []) if (!BINDING.test(s?.binding ?? "") || !SHORT.test(s?.app ?? "")) out.push(`${at}: a service binding needs "binding" and the target "app"`);
  if (w?.vars !== undefined && (typeof w.vars !== "object" || Array.isArray(w.vars) || Object.values(w.vars).some((v) => typeof v !== "string"))) out.push(`${at}: "vars" must be an object of text values`);
  for (const name of Object.keys(w?.vars ?? {})) if (/(_KEY|_TOKEN|_PASSWORD|_PASSPHRASE)$/.test(name)) out.push(`${at}: var ${name} is named like a secret; secrets never go in vars`);
}

/** Problems in one module file, in plain words. Empty = fine. */
export function moduleFileProblems(m, secretNames) {
  const out = [];
  const at = `module file ${m?.module ?? "(no module)"}`;
  if (typeof m?.module !== "string" || !m.module) out.push(`${at}: "module" is missing`);
  for (const key of LISTS) if (m?.[key] !== undefined && !Array.isArray(m[key])) out.push(`${at}: "${key}" must be a list`);
  for (const s of [...(m?.d1 ?? []), ...(m?.kv ?? []), ...(m?.r2 ?? [])]) if (!SHORT.test(s?.name ?? "")) out.push(`${at}: a store needs a lower-case "name"`);
  for (const w of m?.workers ?? []) {
    if (!SHORT.test(w?.app ?? "")) out.push(`${at}: a worker needs "app", its folder under apps/`);
    bindingProblems(`${at}, worker ${w?.app}`, w, out);
  }
  for (const side of ["shell", "gateway"]) if (m?.[side] !== undefined) bindingProblems(`${at}, "${side}" block`, m[side], out);
  for (const h of m?.hosts ?? []) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(h?.key ?? "") || !SHORT.test(h?.label ?? "")) out.push(`${at}: a host needs "key" and "label"`);
    if (!["customDomain", "tunnel"].includes(h?.use)) out.push(`${at}: host ${h?.key}: "use" must be customDomain or tunnel`);
    if (h?.use === "customDomain" && !SHORT.test(h?.app ?? "")) out.push(`${at}: host ${h?.key}: a customDomain needs the "app" it belongs to`);
    if (h?.var && (!SHORT.test(h.var.app ?? "") || !BINDING.test(h.var.name ?? ""))) out.push(`${at}: host ${h?.key}: "var" needs "app" and "name"`);
  }
  const known = (name) => !secretNames || secretNames.has(name);
  for (const s of m?.secrets ?? []) {
    if (!SHORT.test(s?.app ?? "")) out.push(`${at}: secret ${s?.name} needs the "app" it is set on`);
    if (!known(s?.name)) out.push(`${at}: secret ${s?.name} is not in secrets.manifest.json`);
  }
  for (const k of m?.gatewayKeys ?? []) {
    if (!SHORT.test(k?.name ?? "") || !Array.isArray(k?.scopes) || !SHORT.test(k?.app ?? "")) out.push(`${at}: a gateway key needs "name", "scopes" and "app"`);
    if (!known(k?.secret)) out.push(`${at}: gateway key secret ${k?.secret} is not in secrets.manifest.json`);
  }
  for (const t of m?.serviceTokens ?? []) {
    if (!SHORT.test(t?.name ?? "") || !SHORT.test(t?.app ?? "") || typeof t?.for !== "string") out.push(`${at}: a service token needs "name", "for" and "app"`);
    for (const n of [t?.idSecret, t?.keySecret]) if (!known(n)) out.push(`${at}: service token secret ${n} is not in secrets.manifest.json`);
  }
  for (const p of [...(m?.publicPaths ?? []), ...(m?.serviceAuthPaths ?? [])]) if (typeof p !== "string" || !p.startsWith("/")) out.push(`${at}: a path must start with /`);
  for (const c of m?.checks ?? []) {
    if (!c?.name || typeof c.path !== "string" || !c.path.startsWith("/")) out.push(`${at}: a check needs a name and a path`);
    if (c?.expectStatus === undefined && !c?.expectAccessLogin) out.push(`${at}: check "${c?.name}" needs expectStatus or expectAccessLogin`);
  }
  return out;
}

/** "home.example.com" + label "kiosk" -> "kiosk.example.com". */
export const siblingHost = (domain, label) => `${label}.${domain.split(".").slice(1).join(".")}`;

/**
 * The full plan for a household config. Everything carries the household's prefix.
 *   workers: [{ module, app, name, flags, build, d1, kv, r2, durableObjects, services, vars, crons, customDomains }]
 */
export function buildPlan(config, moduleFiles = loadModuleFiles(), secretNames) {
  const h = parseHousehold(config);
  const wanted = ["core", ...enabledModules(h)];
  const problems = [];
  const plan = { household: h, modules: [], notBuilt: [], workers: [], d1: [], kv: [], r2: [], hosts: [], access: [], secrets: [], gatewayKeys: [], serviceTokens: [], checks: [] };
  const used = [];
  for (const id of wanted) {
    const m = moduleFiles[id];
    if (!m) { plan.notBuilt.push(id); continue; }
    problems.push(...moduleFileProblems(m, secretNames));
    plan.modules.push(id);
    used.push(m);
  }
  if (problems.length) throw new Error(problems.join("\n"));

  const worker = (app) => plan.workers.find((w) => w.app === app);
  const merge = (w, add, module) => {
    for (const kind of ["d1", "kv", "r2"]) for (const b of add[kind] ?? []) w[kind].push({ ...b, module });
    w.durableObjects.push(...(add.durableObjects ?? []));
    w.services.push(...(add.services ?? []));
    Object.assign(w.vars, add.vars ?? {});
    for (const c of add.crons ?? []) if (!w.crons.includes(c)) w.crons.push(c);
  };
  for (const m of used) {
    for (const kind of ["d1", "kv", "r2"]) for (const s of m[kind] ?? []) plan[kind].push({ module: m.module, short: s.name, name: resourceName(h, s.name) });
    for (const def of m.workers ?? []) {
      const w = { module: m.module, app: def.app, name: resourceName(h, def.app), main: def.main, flags: def.compatibilityFlags ?? [], build: def.build, d1: [], kv: [], r2: [], durableObjects: [], services: [], vars: {}, crons: [], customDomains: [] };
      plan.workers.push(w);
      merge(w, def, m.module);
    }
  }
  const publicPaths = [], servicePaths = [];
  for (const m of used) {
    for (const side of ["shell", "gateway"]) if (m[side]) merge(worker(side), m[side], m.module);
    for (const host of m.hosts ?? []) {
      const name = h.hosts[host.key] ?? siblingHost(h.domain, host.label);
      plan.hosts.push({ module: m.module, key: host.key, use: host.use, host: name });
      if (host.use === "customDomain") worker(host.app)?.customDomains.push(name);
      if (host.var) { const w = worker(host.var.app); if (w) w.vars[host.var.name] = host.var.asUrl ? `https://${name}` : name; }
    }
    for (const s of m.secrets ?? []) plan.secrets.push({ module: m.module, ...s });
    for (const k of m.gatewayKeys ?? []) plan.gatewayKeys.push({ module: m.module, ...k });
    for (const t of m.serviceTokens ?? []) plan.serviceTokens.push({ module: m.module, ...t, fullName: resourceName(h, t.name) });
    publicPaths.push(...(m.publicPaths ?? []));
    for (const p of m.serviceAuthPaths ?? []) servicePaths.push({ module: m.module, path: p });
    for (const c of m.checks ?? []) plan.checks.push({ module: m.module, ...c });
  }

  // Checks across modules.
  for (const kind of ["d1", "kv", "r2"]) {
    const names = plan[kind].map((x) => x.short);
    const twice = names.find((n, i) => names.indexOf(n) !== i);
    if (twice) problems.push(`two modules declare the ${kind} store "${twice}"`);
  }
  const apps = plan.workers.map((w) => w.app);
  const twiceApp = apps.find((a, i) => apps.indexOf(a) !== i);
  if (twiceApp) problems.push(`two modules declare the worker "${twiceApp}"`);
  for (const w of plan.workers) {
    for (const kind of ["d1", "kv", "r2"]) for (const b of w[kind]) if (!plan[kind].some((s) => s.short === b.store)) problems.push(`worker ${w.app}: binding ${b.binding} points at ${kind} store "${b.store}", which no installed module declares`);
    // A binding to a Worker that is not installed is dropped: the code must treat such a binding as optional.
    w.services = w.services.filter((s) => apps.includes(s.app));
    const bindings = [...w.d1, ...w.kv, ...w.r2, ...w.durableObjects, ...w.services].map((b) => b.binding);
    const twice = bindings.find((b, i) => bindings.indexOf(b) !== i);
    if (twice) problems.push(`worker ${w.app}: binding ${twice} is declared twice`);
  }
  for (const list of [plan.secrets, plan.gatewayKeys, plan.serviceTokens]) for (const s of list) if (!apps.includes(s.app)) problems.push(`${s.name}: app "${s.app}" is not an installed worker`);
  if (problems.length) throw new Error(problems.join("\n"));

  plan.access.push({
    key: "family", name: resourceName(h, "family"), saveAud: true,
    what: "Everyone in the household signs in here. Covers the whole dashboard.",
    domains: [h.domain],
    policy: { name: "Household members", decision: "allow", include: h.people.map((p) => ({ email: { email: p.email } })) },
  });
  plan.access.push({
    key: "machine", name: resourceName(h, "machine"),
    what: "Paths that programs call. No sign-in page; the Worker checks tokens and keys itself.",
    domains: [...new Set(publicPaths)].map((p) => h.domain + p),
    policy: { name: "Machine paths: the Worker checks every request itself", decision: "bypass", include: [{ everyone: {} }] },
  });
  const serviceOnly = { name: "Service token only", decision: "non_identity", include: [{ any_valid_service_token: {} }] };
  for (const s of servicePaths) plan.access.push({ key: `path:${s.path}`, name: resourceName(h, `${s.module.toLowerCase()}-machines`), what: "Only a machine holding a service token may call this path.", domains: [h.domain + s.path], policy: serviceOnly });
  for (const host of plan.hosts.filter((x) => x.use === "tunnel")) plan.access.push({ key: `host:${host.key}`, name: resourceName(h, `${host.key.toLowerCase()}-tunnel`), what: "Only the dashboard, holding a service token, may reach this tunnel.", domains: [host.host], policy: serviceOnly });
  return plan;
}

/** The plan as lines a person can read and say yes to. */
export function describePlan(plan) {
  const h = plan.household;
  const lines = [`Household: ${h.household}`, `Address:   https://${h.domain}`, `People:    ${h.people.map((p) => p.name + (p.admin ? " (admin)" : "")).join(", ")}`, `Modules:   ${plan.modules.join(", ")}`];
  if (plan.notBuilt.length) lines.push(`Switched on in the config but not part of this template yet (skipped): ${plan.notBuilt.join(", ")}`);
  const section = (title, items, show) => { if (items.length) { lines.push("", title); for (const i of items) lines.push(`  - ${show(i)}`); } };
  section("Workers (the programs)", plan.workers, (w) => `${w.name}  (apps/${w.app})`);
  section("D1 databases", plan.d1, (d) => d.name);
  section("KV stores", plan.kv, (k) => k.name);
  section("R2 buckets (files)", plan.r2, (b) => b.name);
  section("Extra hostnames", plan.hosts, (x) => `${x.host}  (${x.use === "tunnel" ? "a tunnel you set up at home" : "served by the dashboard"})`);
  section("Cloudflare Access applications (who gets in)", plan.access.filter((a) => a.domains.length), (a) => `${a.name}: ${a.what}\n      covers ${a.domains.join(", ")}`);
  section("Service tokens (for machines)", plan.serviceTokens, (t) => t.fullName);
  section("Secrets that will be needed (names only; see secrets.manifest.json)", plan.secrets, (s) => `${s.name}  on ${resourceName(h, s.app)}`);
  lines.push("", "Cost: this is designed for Cloudflare's free plan, but that has not been confirmed for every module. Your Cloudflare dashboard shows what you are billed.");
  return lines.join("\n");
}
