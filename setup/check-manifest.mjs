// Checks secrets.manifest.json and the example household config. No dependencies.
//   node setup/check-manifest.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { householdProblems } from "../packages/core/src/household.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KINDS = ["KEY", "TOKEN", "PASSWORD", "PASSPHRASE", "ID"];
const MODULES = ["setup", "core", "brain", "calendar", "finance", "health", "dataExport", "homeAssistant", "energy", "kiosk", "edgeAgents", "alfred"];
const FIELDS = ["name", "module", "purpose", "livesIn", "createdBy", "rotate", "ifLost"];

export function checkManifest(manifest) {
  const errors = [];
  const seen = new Set();
  for (const s of manifest.secrets ?? []) {
    const at = `secret ${s.name ?? "(no name)"}`;
    for (const f of FIELDS) if (typeof s[f] !== "string" || !s[f].trim()) errors.push(`${at}: missing ${f}`);
    if (typeof s.name !== "string") continue;
    const plain = s.name.replace("<MACHINE>", "MACHINE");
    if (!/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(plain)) errors.push(`${at}: name must be UPPER_SNAKE_CASE`);
    if (!KINDS.includes(plain.split("_").at(-1))) errors.push(`${at}: name must end in one of ${KINDS.join(", ")}`);
    if (seen.has(s.name)) errors.push(`${at}: listed twice`);
    seen.add(s.name);
    if (!MODULES.includes(s.module)) errors.push(`${at}: unknown module ${s.module}`);
    if (!["user", "agent", "key-page"].includes(s.createdBy)) errors.push(`${at}: createdBy must be user, agent or key-page`);
    if ("value" in s) errors.push(`${at}: a manifest entry must never carry a value`);
  }
  if (!seen.size) errors.push("no secrets listed");
  return errors;
}

/** Secret names the code reads (env.NAME in apps/ and modules/) that the manifest does not list. */
export function undeclared(manifest, files) {
  const known = new Set((manifest.secrets ?? []).map((s) => s.name));
  const patterns = [...known].filter((n) => n.includes("<MACHINE>")).map((n) => new RegExp("^" + n.replace("<MACHINE>", "[A-Z0-9]+") + "$"));
  const missing = new Set();
  for (const { path, text } of files) {
    for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*_(?:KEY|TOKEN|PASSWORD|PASSPHRASE))\b/g)) {
      if (!known.has(m[1]) && !patterns.some((p) => p.test(m[1]))) missing.add(`${m[1]} (${path})`);
    }
  }
  return [...missing];
}

function sources(dir, out = []) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|mjs|js)$/.test(n)) out.push({ path: p.slice(ROOT.length), text: readFileSync(p, "utf8") });
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(join(ROOT, "secrets.manifest.json"), "utf8"));
  const errors = checkManifest(manifest);
  for (const u of undeclared(manifest, [...sources(join(ROOT, "apps")), ...sources(join(ROOT, "modules"))])) errors.push(`code reads a secret the manifest does not list: ${u}`);
  for (const file of ["household.config.example.json", "demo/household.config.json", "household.config.json"]) {
    let config;
    try { config = JSON.parse(readFileSync(join(ROOT, file), "utf8")); } catch (e) { if (e.code === "ENOENT" && file === "household.config.json") continue; errors.push(`${file}: ${e.message}`); continue; }
    for (const p of householdProblems(config)) errors.push(`${file}: ${p}`);
  }
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log(`manifest ok: ${manifest.secrets.length} secrets`);
}
