// Step 1: can this household be set up at all? Reads only; changes nothing.
//   node setup/feasibility.mjs
// Prints one line per check: ok, FAIL (setup cannot go on) or note (worth knowing, not a blocker).
import { fileURLToPath } from "node:url";
import { client, TOKEN_ENV } from "./lib/cloudflare.mjs";
import { accessTeam, existing, findZone } from "./lib/account.mjs";
import { buildPlan } from "./lib/plan.mjs";
import { loadConfig, run } from "./lib/io.mjs";

const DAY = 86_400_000;
export const MAX_TOKEN_DAYS = 7;

/** [{ level: "ok" | "fail" | "note", text }] */
export async function feasibility({ cf, config, now = Date.now(), nodeVersion = process.versions.node }) {
  const out = [];
  const ok = (text) => out.push({ level: "ok", text });
  const fail = (text) => out.push({ level: "fail", text });
  const note = (text) => out.push({ level: "note", text });

  const [major, minor] = nodeVersion.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 18)) ok(`Node ${nodeVersion}`); else fail(`Node ${nodeVersion} is too old; this needs 22.18 or newer`);

  let plan;
  try { plan = buildPlan(config); ok(`household config is valid: ${plan.household.household}, ${plan.household.people.length} people, modules ${plan.modules.join(", ")}`); }
  catch (e) { fail(`household config: ${e.message}`); return out; }
  if (plan.notBuilt.length) note(`switched on but not part of this template yet, so skipped: ${plan.notBuilt.join(", ")}`);
  const domain = plan.household.domain;
  if (/(^|\.)example\.(com|org|net)$/.test(domain)) { fail(`the domain is still the example (${domain}); put the household's own domain in household.config.json`); return out; }

  let token;
  try { token = (await cf.get("/user/tokens/verify")).result; } catch (e) { fail(`the Cloudflare token was refused: ${e.message}`); return out; }
  if (token?.status !== "active") { fail(`the Cloudflare token is ${token?.status ?? "not active"}`); return out; }
  ok("the Cloudflare token works");
  if (!token.expires_on) fail(`the token never expires. Create one that expires within ${MAX_TOKEN_DAYS} days and store it as ${TOKEN_ENV}`);
  else {
    const days = (Date.parse(token.expires_on) - now) / DAY;
    if (days > MAX_TOKEN_DAYS) fail(`the token expires in ${Math.ceil(days)} days; it must expire within ${MAX_TOKEN_DAYS}`);
    else ok(`the token expires in ${Math.max(0, Math.ceil(days))} day(s)`);
  }

  const found = await findZone(cf, domain);
  if (!found) { fail(`no zone for ${domain} on this Cloudflare account. Add the domain to Cloudflare first (buy it there or move it)`); return out; }
  if (found.zone.status === "active") ok(`zone ${found.zone.name} is active`); else fail(`zone ${found.zone.name} is "${found.zone.status}", not active yet. Finish the domain's setup in Cloudflare`);
  if (!found.accountId) { fail("could not read the account of that zone"); return out; }

  const team = await accessTeam(cf, found.accountId);
  if (team) ok(`Zero Trust is set up (team ${team})`);
  else fail("Zero Trust is not set up on this account. In the Cloudflare dashboard open Zero Trust once and pick a team name (the free plan is enough)");

  if (plan.r2.length) {
    try { await cf.get(`/accounts/${found.accountId}/r2/buckets`); ok("R2 (file storage) is switched on"); }
    catch { fail(`R2 (file storage) is not switched on, and ${[...new Set(plan.r2.map((b) => b.module))].join(", ")} needs it. In the Cloudflare dashboard open R2 once and accept its terms (it asks for a payment card; the free allowance is generous)`); }
  }
  for (const x of plan.hosts) {
    if (!x.host.endsWith("." + found.zone.name) && x.host !== found.zone.name) fail(`${x.host} (for ${x.module}) is not inside the zone ${found.zone.name}; set hosts.${x.key} in the config to a name in that zone`);
  }

  try {
    const have = await existing(cf, found.accountId);
    const clash = [
      ...plan.d1.filter((d) => have.d1.has(d.name)).map((d) => `database ${d.name}`),
      ...plan.kv.filter((k) => have.kv.has(k.name)).map((k) => `KV store ${k.name}`),
      ...plan.r2.filter((b) => have.r2.has(b.name)).map((b) => `bucket ${b.name}`),
      ...plan.access.filter((a) => have.apps.has(a.name)).map((a) => `Access application ${a.name}`),
    ];
    if (clash.length) note(`already exists and will be reused, not recreated: ${clash.join(", ")}. If these are not from an earlier run of this setup, change resourcePrefix in the config`);
    else ok("no name clashes with what is already on the account");
  } catch (e) { fail(`could not list what is on the account (the token may lack permissions): ${e.message}`); }

  note("check by hand: the household's GitHub repository is private");
  note("check by hand: two-factor sign-in is on for the Cloudflare and GitHub accounts");
  return out;
}

export const passed = (results) => !results.some((r) => r.level === "fail");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(async () => {
    const results = await feasibility({ cf: client(), config: loadConfig() });
    for (const r of results) console.log(`${r.level === "fail" ? "FAIL" : r.level.padEnd(4)}  ${r.text}`);
    if (!passed(results)) { console.log("\nNot ready. Fix every FAIL line, then run this again."); process.exit(1); }
    console.log("\nReady. Next: node setup/provision.mjs --dry-run");
  });
}
