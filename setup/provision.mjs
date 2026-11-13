// Steps 3 and 4: create what the household's modules need in Cloudflare. Safe to run again: it reuses what exists.
//   node setup/provision.mjs --dry-run   show the plan and every change it would make; changes nothing
//   node setup/provision.mjs             make the changes, write setup/resources.json and the wrangler configs
// It creates stores and Access applications. It does not deploy code (setup/deploy.mjs) and never sets a secret
// (setup/secrets.mjs sets the machine ones after the first deploy; the person's own go through the key page).
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { client } from "./lib/cloudflare.mjs";
import { accessTeam, existing, findZone } from "./lib/account.mjs";
import { syncPolicy } from "./lib/access.mjs";
import { buildPlan, describePlan } from "./lib/plan.mjs";
import { flag, loadConfig, loadResources, ROOT, run, saveResources } from "./lib/io.mjs";
import { render } from "./wrangler-config.mjs";

const SESSION = "24h";

/** Applies the plan. Returns { resources, actions }: the ids for setup/resources.json and what was done, in words. */
export async function provision({ cf, config, resources = {}, moduleFiles }) {
  const plan = buildPlan(config, moduleFiles);
  const actions = [];
  const domain = plan.household.domain;
  const found = await findZone(cf, domain);
  if (!found?.accountId) throw new Error(`no zone for ${domain} on this account. Run setup/feasibility.mjs first.`);
  const acct = `/accounts/${found.accountId}`;
  const team = await accessTeam(cf, found.accountId);
  if (!team) throw new Error("Zero Trust is not set up on this account. Run setup/feasibility.mjs first.");
  const have = await existing(cf, found.accountId);
  const out = structuredClone(resources);
  delete out.$comment;
  delete out.placeholders;
  out.accountId = found.accountId;
  out.accessTeam = team;
  out.d1 ??= {};
  out.kv ??= {};

  for (const d of plan.d1) {
    let id = have.d1.get(d.name);
    if (id) actions.push(`reuse database ${d.name}`);
    else { id = (await cf.post(`${acct}/d1/database`, { name: d.name })).result.uuid; actions.push(`create database ${d.name}`); }
    out.d1[d.short] = id;
  }
  for (const k of plan.kv) {
    let id = have.kv.get(k.name);
    if (id) actions.push(`reuse KV store ${k.name}`);
    else { id = (await cf.post(`${acct}/storage/kv/namespaces`, { title: k.name })).result.id; actions.push(`create KV store ${k.name}`); }
    out.kv[k.short] = id;
  }
  for (const b of plan.r2) {
    if (have.r2.has(b.name)) actions.push(`reuse bucket ${b.name}`);
    else { await cf.post(`${acct}/r2/buckets`, { name: b.name }); actions.push(`create bucket ${b.name}`); }
  }

  const tokens = plan.access.some((a) => a.tokens) ? await cf.list(`${acct}/access/service_tokens`) : [];
  for (const a of plan.access) {
    if (!a.domains.length) continue;
    const body = { name: a.name, type: "self_hosted", domain: a.domains[0], self_hosted_domains: a.domains, session_duration: SESSION, app_launcher_visible: a.key === "family" };
    let app = have.apps.get(a.name);
    if (!app) {
      app = (await cf.post(`${acct}/access/apps`, body)).result;
      actions.push(`create Access application ${a.name}`);
    } else if (JSON.stringify([...(app.self_hosted_domains ?? [])].sort()) !== JSON.stringify([...a.domains].sort())) {
      await cf.put(`${acct}/access/apps/${app.id}`, body);
      actions.push(`update the paths of Access application ${a.name}`);
    } else actions.push(`reuse Access application ${a.name}`);
    if (a.saveAud) out.accessAud = app.aud;
    if (a.audVar) (out.aud ??= {})[a.key] = app.aud;
    await syncPolicy({ cf, acct, app, a, tokens, actions });
  }
  return { plan, resources: out, actions };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(async () => {
    const dryRun = flag("--dry-run");
    const config = loadConfig();
    const cf = client({ dryRun });
    const { plan, resources, actions } = await provision({ cf, config, resources: loadResources() });
    console.log(describePlan(plan));
    console.log(`\n${dryRun ? "Would do" : "Done"}:`);
    for (const a of actions) console.log(`  ${a}`);
    if (dryRun) {
      console.log(`\nDry run: nothing was changed (${cf.writes.length} change(s) held back). Show this to the person and wait for a yes.`);
      return;
    }
    saveResources(resources);
    for (const [p, text] of Object.entries(render({ config, resources }))) writeFileSync(join(ROOT, p), text);
    console.log("\nWrote setup/resources.json and the wrangler configs. Commit them.\nNext: node setup/deploy.mjs --dry-run");
  });
}
