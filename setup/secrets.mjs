// Step 5, the machine half: secrets that programs hold and no person needs to type.
//   node setup/secrets.mjs --dry-run   list what it would create and set; changes nothing
//   node setup/secrets.mjs             create them and set them on their Workers
// Run it after the first deploy (a secret is set on a Worker that exists). Safe to run again: a secret that is
// already set is left alone. Values are made here, sent straight to Cloudflare and never printed or written to disk.
//   - Cloudflare Access service tokens a module declares (e.g. the dashboard's pass through a tunnel)
//   - gateway API keys a module declares (e.g. Alfred's): only the SHA-256 goes into the gateway's database
// Secrets a person creates (app passwords, API keys) and the encryption keys from the key page are not set here;
// this script lists them so the agent can hand the person one checklist.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { client } from "./lib/cloudflare.mjs";
import { buildPlan } from "./lib/plan.mjs";
import { syncPolicy } from "./lib/access.mjs";
import { flag, loadConfig, loadResources, run } from "./lib/io.mjs";
import { resourceName } from "../packages/core/src/household.ts";

const MANIFEST = fileURLToPath(new URL("../secrets.manifest.json", import.meta.url));

export const newGatewayKey = (name) => `hmcp_${name}_${randomBytes(32).toString("base64url")}`;
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export const machineSecrets = ({ config, ...rest }) => machineSecretsFor({ plan: buildPlan(config), ...rest });

export async function machineSecretsFor({ cf, plan, resources, manifest = JSON.parse(readFileSync(MANIFEST, "utf8")), makeKey = newGatewayKey, now = () => new Date().toISOString() }) {
  const h = plan.household;
  const acct = `/accounts/${resources.accountId}`;
  if (!resources.accountId) throw new Error("setup/resources.json has no accountId. Run setup/provision.mjs first.");
  const actions = [];
  const setOn = new Map();   // Worker name -> Set of secret names already set
  const names = async (app) => {
    const worker = resourceName(h, app);
    if (!setOn.has(worker)) setOn.set(worker, new Set((await cf.list(`${acct}/workers/scripts/${worker}/secrets`)).map((s) => s.name)));
    return { worker, have: setOn.get(worker) };
  };
  const put = async (app, name, text) => {
    const { worker, have } = await names(app);
    await cf.put(`${acct}/workers/scripts/${worker}/secrets`, { name, text, type: "secret_text" });
    have.add(name);
  };

  const tokens = plan.serviceTokens.length ? await cf.list(`${acct}/access/service_tokens`) : [];
  for (const t of plan.serviceTokens) {
    const { have } = await names(t.app);
    if (have.has(t.idSecret) && have.has(t.keySecret)) { actions.push(`keep service token ${t.fullName} (both halves are already set)`); continue; }
    const old = tokens.find((x) => x.name === t.fullName);
    // The secret half is shown by Cloudflare only once, so an existing token gets a new secret half.
    const made = old
      ? (await cf.post(`${acct}/access/service_tokens/${old.id}/rotate`)).result
      : (await cf.post(`${acct}/access/service_tokens`, { name: t.fullName, duration: "8760h" })).result;
    await put(t.app, t.idSecret, made.client_id ?? "dry-run");
    await put(t.app, t.keySecret, made.client_secret ?? "dry-run");
    actions.push(`${old ? "renew" : "create"} service token ${t.fullName} and set ${t.idSecret}, ${t.keySecret} on ${resourceName(h, t.app)} (valid one year)`);
  }

  // A new token must be named in its application's policy before it opens anything.
  if (plan.serviceTokens.length) {
    const now = cf.dryRun ? tokens : await cf.list(`${acct}/access/service_tokens`);
    const apps = await cf.list(`${acct}/access/apps`);
    for (const a of plan.access.filter((x) => x.tokens)) {
      const app = apps.find((x) => x.name === a.name);
      if (!app) { actions.push(`  ${a.name} does not exist yet. Run setup/provision.mjs, then this again.`); continue; }
      await syncPolicy({ cf, acct, app, a, tokens: now, actions });
    }
  }

  for (const k of plan.gatewayKeys) {
    const { have } = await names(k.app);
    if (have.has(k.secret)) { actions.push(`keep gateway key ${k.name} (${k.secret} is already set)`); continue; }
    const db = resources.d1?.gateway;
    if (!db) throw new Error("setup/resources.json has no d1.gateway id. Run setup/provision.mjs first.");
    const key = makeKey(k.name);
    await cf.post(`${acct}/d1/database/${db}/query`, {
      sql: "INSERT INTO api_keys (name, sha256, scopes, created) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET sha256 = excluded.sha256, scopes = excluded.scopes, created = excluded.created, revoked_at = NULL",
      params: [k.name, sha256(key), JSON.stringify(k.scopes), now()],
    });
    await put(k.app, k.secret, key);
    actions.push(`create gateway key ${k.name} (${k.scopes.join(", ")}) and set ${k.secret} on ${resourceName(h, k.app)}`);
  }

  // What is left for the person, by who creates it.
  const machine = new Set([...plan.serviceTokens.flatMap((t) => [t.idSecret, t.keySecret]), ...plan.gatewayKeys.map((k) => k.secret)]);
  const byName = new Map(manifest.secrets.map((s) => [s.name, s]));
  const todo = { user: [], keyPage: [] };
  for (const s of plan.secrets) {
    if (machine.has(s.name)) continue;
    const { have } = await names(s.app);
    if (have.has(s.name)) continue;
    const entry = byName.get(s.name);
    (entry?.createdBy === "key-page" ? todo.keyPage : todo.user).push({ name: s.name, worker: resourceName(h, s.app), purpose: entry?.purpose ?? "" });
  }
  return { actions, todo };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(async () => {
    const dryRun = flag("--dry-run");
    const { actions, todo } = await machineSecrets({ cf: client({ dryRun }), config: loadConfig(), resources: loadResources() });
    console.log(dryRun ? "Would do:" : "Done:");
    for (const a of actions) console.log(`  ${a}`);
    if (!actions.length) console.log("  nothing: the installed modules need no machine secrets");
    if (todo.user.length) {
      console.log("\nFor the person to create and store (one checklist; never ask them to paste a value into chat):");
      for (const s of todo.user) console.log(`  - ${s.name} on ${s.worker}: ${s.purpose}`);
    }
    if (todo.keyPage.length) {
      console.log("\nMade on the one-time key page by the admin, not by you:");
      for (const s of todo.keyPage) console.log(`  - ${s.name}`);
    }
    if (dryRun) console.log("\nDry run: nothing was changed.");
  });
}
