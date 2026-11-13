// Remove what the setup created in Cloudflare. Deletes data: databases and buckets are gone for good.
//   node setup/teardown.mjs --dry-run                     list what would be removed; changes nothing
//   node setup/teardown.mjs --confirm "<household name>"  remove it; the name must match the config exactly
// Only things whose names match this household's plan are touched. Buckets that still hold files are refused by
// Cloudflare and reported, not forced.
import { fileURLToPath } from "node:url";
import { client, CloudflareError } from "./lib/cloudflare.mjs";
import { existing, findZone } from "./lib/account.mjs";
import { buildPlan } from "./lib/plan.mjs";
import { flag, loadConfig, option, run } from "./lib/io.mjs";

export async function teardown({ cf, config }) {
  const plan = buildPlan(config);
  const found = await findZone(cf, plan.household.domain);
  if (!found?.accountId) throw new Error(`no zone for ${plan.household.domain} on this account.`);
  const acct = `/accounts/${found.accountId}`;
  const have = await existing(cf, found.accountId);
  const actions = [];
  const attempt = async (what, f) => {
    try { await f(); actions.push(`remove ${what}`); }
    catch (e) { if (!(e instanceof CloudflareError)) throw e; actions.push(`could NOT remove ${what}: ${e.message}`); }
  };
  for (const w of plan.workers) await attempt(`Worker ${w.name}`, () => cf.del(`${acct}/workers/scripts/${w.name}`));
  const tokens = plan.serviceTokens.length ? await cf.list(`${acct}/access/service_tokens`) : [];
  for (const t of plan.serviceTokens) { const tok = tokens.find((x) => x.name === t.fullName); if (tok) await attempt(`service token ${t.fullName}`, () => cf.del(`${acct}/access/service_tokens/${tok.id}`)); }
  for (const a of plan.access) { const app = have.apps.get(a.name); if (app) await attempt(`Access application ${a.name}`, () => cf.del(`${acct}/access/apps/${app.id}`)); }
  for (const d of plan.d1) { const id = have.d1.get(d.name); if (id) await attempt(`database ${d.name} and all its data`, () => cf.del(`${acct}/d1/database/${id}`)); }
  for (const k of plan.kv) { const id = have.kv.get(k.name); if (id) await attempt(`KV store ${k.name}`, () => cf.del(`${acct}/storage/kv/namespaces/${id}`)); }
  for (const b of plan.r2) if (have.r2.has(b.name)) await attempt(`bucket ${b.name}`, () => cf.del(`${acct}/r2/buckets/${b.name}`));
  return { plan, actions };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(async () => {
    const config = loadConfig();
    const dryRun = flag("--dry-run");
    const named = option("--confirm");
    if (!dryRun && named !== config.household) {
      throw new Error(`this deletes the household's data for good. Run with --dry-run first, show the list, and only after a clear yes run with --confirm "${config.household}".`);
    }
    const { actions } = await teardown({ cf: client({ dryRun }), config });
    console.log(dryRun ? "Would do:" : "Done:");
    for (const a of actions) console.log(`  ${a}`);
    if (dryRun) console.log("\nDry run: nothing was changed.");
  });
}
