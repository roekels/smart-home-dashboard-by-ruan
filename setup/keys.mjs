#!/usr/bin/env node
// Opens and closes the one-time key page (/setup/keys on the dashboard). The page makes the encryption keys in the
// admin's browser; this script never sees one.
//
//   node setup/keys.mjs open [--dry-run]    make a token that can only edit Worker secrets (valid 24 hours), put it
//                                           on the dashboard Worker as SETUP_KEYPAGE_WRITE_TOKEN, print the address
//   node setup/keys.mjs close [--dry-run]   check every key is stored, remove what `open` left behind
//
// The token's value goes from Cloudflare's answer straight into the Worker secret. It is never printed or saved.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resourceName } from "../packages/core/src/household.ts";
import { client, CloudflareError } from "./lib/cloudflare.mjs";
import { flag, loadConfig, loadResources, run } from "./lib/io.mjs";
import { buildPlan } from "./lib/plan.mjs";

export const KEYPAGE_SECRET = "SETUP_KEYPAGE_WRITE_TOKEN";
const PERMISSION = "Workers Scripts Write";
const HOURS = 24;
const MANIFEST = fileURLToPath(new URL("../secrets.manifest.json", import.meta.url));
const readManifest = () => JSON.parse(readFileSync(MANIFEST, "utf8"));

/** The keys the page makes for this household: [{ name, worker }], and which of them are already stored. */
async function keyState({ cf, plan, resources, manifest }) {
  if (!resources.accountId) throw new Error("setup/resources.json has no accountId. Run setup/provision.mjs first.");
  const h = plan.household, acct = `/accounts/${resources.accountId}`;
  const byPage = new Set(manifest.secrets.filter((s) => s.createdBy === "key-page").map((s) => s.name));
  const keys = plan.secrets.filter((s) => byPage.has(s.name)).map((s) => ({ name: s.name, worker: resourceName(h, s.app) }));
  const have = new Map();
  for (const w of new Set([...keys.map((k) => k.worker), resourceName(h, "shell")])) {
    have.set(w, new Set((await cf.list(`${acct}/workers/scripts/${w}/secrets`)).map((s) => s.name)));
  }
  return { acct, shell: resourceName(h, "shell"), tokenName: resourceName(h, "setup-keypage"), keys, have, missing: keys.filter((k) => !have.get(k.worker).has(k.name)) };
}

export async function openKeyPage({ cf, plan, resources, manifest = readManifest(), now = Date.now() }) {
  const s = await keyState({ cf, plan, resources, manifest });
  const address = `https://${plan.household.domain}/setup/keys`;
  if (!s.keys.length) return { state: "nothing", actions: [], address, missing: [] };
  if (!s.missing.length) return { state: "done", actions: [], address, missing: [] };

  const group = (await cf.list("/user/tokens/permission_groups")).find((g) => g.name === PERMISSION);
  if (!group) throw new Error(`Cloudflare lists no permission called "${PERMISSION}", so the key page's token cannot be made.`);
  // One open at a time: an older token of the same name is removed first.
  const actions = [];
  for (const old of (await cf.list("/user/tokens")).filter((t) => t.name === s.tokenName)) {
    await cf.del(`/user/tokens/${old.id}`);
    actions.push(`remove the earlier token ${s.tokenName}`);
  }
  let made;
  try {
    made = (await cf.post("/user/tokens", {
      name: s.tokenName,
      policies: [{ effect: "allow", resources: { [`com.cloudflare.api.account.${resources.accountId}`]: "*" }, permission_groups: [{ id: group.id }] }],
      expires_on: new Date(now + HOURS * 3600_000).toISOString().replace(/\.\d+Z$/, "Z"),
    })).result;
  } catch (e) {
    if (e instanceof CloudflareError && (e.status === 403 || e.status === 401)) {
      throw new Error("The setup token may not create other tokens. Ask the person to add the permission \"API Tokens: Edit\" to it (or make a new 7-day token from the \"Create Additional Tokens\" template plus the setup permissions), then run this again.");
    }
    throw e;
  }
  actions.push(`create token ${s.tokenName}: can only edit Worker secrets in this account, expires in ${HOURS} hours`);
  const pass = { token: made.value ?? "dry-run", accountId: resources.accountId, shell: s.shell, keys: s.missing };
  await cf.put(`${s.acct}/workers/scripts/${s.shell}/secrets`, { name: KEYPAGE_SECRET, text: JSON.stringify(pass), type: "secret_text" });
  actions.push(`set ${KEYPAGE_SECRET} on ${s.shell} (the page deletes it when the keys are stored)`);
  return { state: "open", actions, address, missing: s.missing };
}

export async function closeKeyPage({ cf, plan, resources, manifest = readManifest() }) {
  const s = await keyState({ cf, plan, resources, manifest });
  const actions = [];
  if (s.have.get(s.shell).has(KEYPAGE_SECRET)) {
    await cf.del(`${s.acct}/workers/scripts/${s.shell}/secrets/${KEYPAGE_SECRET}`);
    actions.push(`remove ${KEYPAGE_SECRET} from ${s.shell}`);
  }
  for (const t of (await cf.list("/user/tokens")).filter((x) => x.name === s.tokenName)) {
    await cf.del(`/user/tokens/${t.id}`);
    actions.push(`delete token ${s.tokenName}`);
  }
  return { actions, missing: s.missing, ok: s.missing.length === 0 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(async () => {
    const dryRun = flag("--dry-run"), what = process.argv[2];
    if (what !== "open" && what !== "close") throw new Error("Say what to do: node setup/keys.mjs open, or node setup/keys.mjs close.");
    const input = { cf: client({ dryRun }), plan: buildPlan(loadConfig()), resources: loadResources() };
    const list = (items) => { for (const a of items) console.log(`  ${a}`); };
    if (what === "open") {
      const r = await openKeyPage(input);
      if (r.state === "nothing") return console.log("The installed modules need no encryption keys. Nothing to do.");
      if (r.state === "done") return console.log("Every encryption key is already stored. Nothing to do.");
      console.log(dryRun ? "Would do:" : "Done:");
      list(r.actions);
      console.log("\nKeys the page will make:");
      list(r.missing.map((k) => `${k.name} for ${k.worker}`));
      console.log(dryRun ? "\nDry run: nothing was changed." : `\nNow ask the admin to open ${r.address}, save each key in their password manager and press the button. Then run: node setup/keys.mjs close`);
      return;
    }
    const r = await closeKeyPage(input);
    console.log(dryRun ? "Would do:" : "Done:");
    list(r.actions.length ? r.actions : ["nothing left to remove"]);
    if (!r.ok) {
      console.log("\nNot stored yet:");
      list(r.missing.map((k) => `${k.name} for ${k.worker}`));
      throw new Error("The key page was closed before every key was stored. Run `node setup/keys.mjs open` and send the admin to the page again.");
    }
    console.log("\nEvery encryption key is stored and the key page is closed.");
  });
}
