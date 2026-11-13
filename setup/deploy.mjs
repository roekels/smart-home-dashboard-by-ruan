// First deploy of the Workers, from this machine, with the setup token. After Workers Builds is connected to the
// repository, a merge to main deploys and this script is no longer needed.
//   node setup/deploy.mjs --dry-run   print the commands
//   node setup/deploy.mjs             run them
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { TOKEN_ENV } from "./lib/cloudflare.mjs";
import { buildPlan } from "./lib/plan.mjs";
import { flag, loadConfig, loadResources, ROOT, run } from "./lib/io.mjs";

/** Workers ordered so that one comes after the Workers it binds to, where that is possible (two that bind to each other keep their listed order). */
export function deployOrder(workers) {
  const left = [...workers], out = [];
  while (left.length) {
    const i = left.findIndex((w) => w.services.every((s) => s.app === w.app || out.some((o) => o.app === s.app) || !left.some((l) => l.app === s.app)));
    out.push(...left.splice(i === -1 ? 0 : i, 1));
  }
  return out;
}

/** [{ cwd, cmd, args, why }] in the order they must run: a database is brought up to date before the Worker that reads it. */
export function deploySteps(plan) {
  const steps = [];
  for (const w of deployOrder(plan.workers)) {
    const cwd = `apps/${w.app}`;
    steps.push({ cwd, cmd: "npm", args: ["ci"], why: `install ${w.app}'s tools` });
    for (const b of w.d1.filter((b) => b.migrations)) {
      const name = plan.d1.find((d) => d.short === b.store).name;
      steps.push({ cwd, cmd: "npx", args: ["wrangler", "d1", "migrations", "apply", name, "--remote"], why: `bring database ${name} up to date` });
    }
    steps.push({ cwd, cmd: "npm", args: ["run", "deploy"], why: `deploy ${w.name}` });
  }
  return steps;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(async () => {
    const plan = buildPlan(loadConfig());
    const resources = loadResources();
    if (!resources.accountId) throw new Error("setup/resources.json has no accountId. Run setup/provision.mjs first.");
    const steps = deploySteps(plan);
    if (flag("--dry-run")) { for (const s of steps) console.log(`(${s.cwd}) ${s.cmd} ${s.args.join(" ")}   # ${s.why}`); return; }
    if (!process.env[TOKEN_ENV]) throw new Error(`${TOKEN_ENV} is not set.`);
    const env = { ...process.env, CLOUDFLARE_API_TOKEN: process.env[TOKEN_ENV], CLOUDFLARE_ACCOUNT_ID: resources.accountId, CI: "1" };
    for (const s of steps) {
      console.log(`\n== ${s.why}`);
      const r = spawnSync(s.cmd, s.args, { cwd: join(ROOT, s.cwd), env, stdio: "inherit" });
      if (r.status !== 0) throw new Error(`"${s.cmd} ${s.args.join(" ")}" failed in ${s.cwd}. Fix it and run this again; finished steps are safe to repeat.`);
    }
    console.log("\nDeployed. Next: node setup/verify.mjs");
  });
}
