// Reading and writing the setup's own files.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const CONFIG = "household.config.json";
export const RESOURCES = "setup/resources.json";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

/** The household's own config. The example does not count: setup must not run on made-up people. */
export function loadConfig(root = ROOT) {
  const p = join(root, CONFIG);
  if (!existsSync(p)) throw new Error(`${CONFIG} does not exist yet. Copy household.config.example.json to ${CONFIG} and fill in the household's own answers.`);
  return read(p);
}

export function loadResources(root = ROOT) {
  const p = join(root, RESOURCES);
  return existsSync(p) ? read(p) : {};
}

export function saveResources(resources, root = ROOT) {
  const out = { $comment: "Ids of the Cloudflare resources the setup created. None of them is a secret. Written by setup/provision.mjs.", ...resources };
  writeFileSync(join(root, RESOURCES), JSON.stringify(out, null, 2) + "\n");
}

export const flag = (name) => process.argv.includes(name);
export const option = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };

/** Run a script's main(), print a plain error and exit 1 on failure. Never prints a stack with env in it. */
export function run(main) {
  main().catch((e) => { console.error(`\nStopped: ${e.message}`); process.exit(1); });
}
