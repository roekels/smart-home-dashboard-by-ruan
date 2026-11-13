// Step 7: is the dashboard up and locked the way it should be? Reads only, from the outside, with no credentials.
//   node setup/verify.mjs
import { fileURLToPath } from "node:url";
import { buildPlan } from "./lib/plan.mjs";
import { loadConfig, run } from "./lib/io.mjs";

/** [{ module, name, ok, detail }] */
export async function verify({ plan, fetch: f = fetch }) {
  const out = [];
  for (const c of plan.checks) {
    const url = `https://${plan.household.domain}${c.path}`;
    let ok = false, detail = "";
    try {
      const res = await f(url, { method: c.method ?? "GET", redirect: "manual", headers: c.method === "POST" ? { "content-type": "application/json" } : {}, body: c.method === "POST" ? "{}" : undefined });
      if (c.expectAccessLogin) {
        const to = res.headers.get("location") ?? "";
        ok = res.status >= 300 && res.status < 400 && /\.cloudflareaccess\.com\//.test(to);
        detail = ok ? "sent to the Cloudflare Access sign-in" : `expected a redirect to the sign-in, got ${res.status}. The page may be open to everyone: check the Access application now`;
      } else {
        ok = res.status === c.expectStatus;
        detail = ok ? `${res.status}` : `expected ${c.expectStatus}, got ${res.status}${res.status >= 300 && res.status < 400 && c.expectStatus < 300 ? " (a redirect: this path may be missing from the machine Access application)" : ""}`;
      }
    } catch (e) { detail = `could not reach ${url}: ${e.message}`; }
    out.push({ module: c.module, name: c.name, ok, detail });
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(async () => {
    const results = await verify({ plan: buildPlan(loadConfig()) });
    for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"}  [${r.module}] ${r.name}: ${r.detail}`);
    if (results.some((r) => !r.ok)) { console.log("\nNot everything is right. Fix or explain every FAIL line."); process.exit(1); }
    console.log("\nAll checks passed.");
  });
}
