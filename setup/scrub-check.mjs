// Keeps personal data and secrets out of this repo. Run before every push and in CI. No dependencies.
//   node setup/scrub-check.mjs [dir]
// Two layers:
//   1. Generic patterns: real-looking emails and domains, Cloudflare ids, private network addresses, key material.
//   2. A private deny list (names, domains, ids to never publish), which itself must never be committed:
//      env SCRUB_DENYLIST_TERMS (newline-separated, e.g. a CI secret) or env SCRUB_DENYLIST_FILE (path to a file).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SAFE_DOMAINS = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;
// Public hosts the code and docs may name.
const KNOWN_HOSTS = /(^|\.)(cloudflare\.com|cloudflareaccess\.com|workers\.dev|github\.com|githubusercontent\.com|anthropic\.com|claude\.ai|claude\.com|apple\.com|icloud\.com|home-assistant\.io|json-schema\.org|npmjs\.com|nodejs\.org|w3\.org|openai\.com|chatgpt\.com|mozilla\.org|opensource\.org|sil\.org|modelcontextprotocol\.io)$/i;

const RULES = [
  { id: "email", re: /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, bad: (m) => !SAFE_DOMAINS.test(m[1]) && !/^(noreply|git)@/i.test(m[0]) },
  { id: "url-host", re: /https?:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, bad: (m) => !SAFE_DOMAINS.test(m[1]) && !KNOWN_HOSTS.test(m[1]) && !/^\d+(\.\d+){3}$/.test(m[1]) },
  // All zeros is the placeholder for an id the setup fills in (setup/resources.example.json).
  { id: "hex-id-32", re: /\b[0-9a-f]{32}\b/g, bad: (m) => !/^0+$/.test(m[0]) },
  { id: "hex-id-64", re: /\b[0-9a-f]{64}\b/g, bad: (m) => !/^0+$/.test(m[0]) },
  { id: "uuid", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, bad: (m) => !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(m[0]) },
  { id: "private-ip", re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g, bad: () => true },
  { id: "mac-address", re: /\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}\b/g, bad: (m) => !/^00(:00){5}$/.test(m[0]) },
  { id: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, bad: () => true },
  { id: "jwk-private", re: /"d"\s*:\s*"[A-Za-z0-9_-]{20,}"/g, bad: () => true },
  { id: "api-key", re: /\b(sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|cfat_[A-Za-z0-9_-]{10,}|hmcp_[a-z0-9-]+_[A-Za-z0-9_-]{20,})/g, bad: () => true },
  { id: "access-team", re: /\b([a-z0-9-]+)\.cloudflareaccess\.com\b/g, bad: (m) => m[1] !== "example" && m[1] !== "your-team" },
];

// apps/shell/public is the built UI (git-ignored); its sources under apps/shell/web are scanned.
const SKIP_DIRS = new Set([".git", "node_modules", ".wrangler", "dist", "public"]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|pdf|zip|gz|dmg|exe)$/i;
const LOCKFILE = /(^|\/)package-lock\.json$/;

export function denyTerms(env = process.env) {
  let raw = env.SCRUB_DENYLIST_TERMS ?? "";
  if (env.SCRUB_DENYLIST_FILE) raw += "\n" + readFileSync(env.SCRUB_DENYLIST_FILE, "utf8");
  return raw.split(/\r?\n/).map((t) => t.trim()).filter((t) => t && !t.startsWith("#"));
}

/** Findings in one file's text: [{ rule, line }]. A deny-list hit never echoes the term. */
export function scanText(text, terms = []) {
  const found = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.includes("scrub-check: allow")) return;
    for (const r of RULES) {
      for (const m of line.matchAll(r.re)) if (r.bad(m)) found.push({ rule: r.id, line: i + 1, match: m[0] });
    }
    const lower = line.toLowerCase();
    terms.forEach((t, n) => { if (lower.includes(t.toLowerCase())) found.push({ rule: `deny-list #${n + 1}`, line: i + 1 }); });
  });
  return found;
}

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (SKIP_DIRS.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));
  const terms = denyTerms();
  let count = 0;
  for (const file of walk(root)) {
    const rel = relative(root, file);
    if (BINARY.test(rel)) { continue; }
    if (LOCKFILE.test(rel)) continue;
    for (const f of scanText(readFileSync(file, "utf8"), terms)) {
      count++;
      console.error(`${rel}:${f.line}  ${f.rule}${f.match ? "  " + f.match : ""}`);
    }
  }
  if (!terms.length) console.warn("note: no private deny list given (SCRUB_DENYLIST_TERMS / SCRUB_DENYLIST_FILE); generic patterns only");
  if (count) { console.error(`\nscrub check failed: ${count} finding(s). Replace with example data, or add "scrub-check: allow" on a line that is a false positive.`); process.exit(1); }
  console.log("scrub check ok");
}
