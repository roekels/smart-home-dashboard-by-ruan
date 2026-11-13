// Notes are markdown with [[wikilinks]] and a small set of frontmatter fields. Nothing here touches the database.
import { Refused } from "./core.ts";

export const SENSITIVITIES = ["normal", "sensitive"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

/** [[Target]], [[Target|alias]], [[Target#Heading]] -> "Target". Skips code blocks. */
export function wikilinks(text: string): string[] {
  const clean = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const out = new Set<string>();
  for (const m of clean.matchAll(/\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g)) {
    const t = m[1].trim();
    if (t) out.add(t);
  }
  return [...out];
}

/** Titles listed in frontmatter `related`. */
export function relatedTargets(fm: Record<string, unknown>): string[] {
  const r = fm.related;
  const list = Array.isArray(r) ? r : typeof r === "string" ? [r] : [];
  return list.flatMap((x) => (typeof x === "string" ? wikilinks(x.includes("[[") ? x : `[[${x}]]`) : []));
}

// ---------- No secrets in the Brain ----------

const SECRET_PATTERNS: [string, RegExp][] = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["API key or token", /\b(sk-(ant-|proj-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abpr]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|hmcp_[a-z0-9-]+_[A-Za-z0-9_-]{20,}|cfut_[A-Za-z0-9_-]{20,})\b/],
  ["password value", /\b(password|passwort|passcode|pin)\s*[:=]\s*["']?[^\s"'`,;]{4,}/i],
  // xxxx-xxxx-xxxx-xxxx near a hint word, so "long-term-care-plan" does not trip it.
  ["app-specific password", /(apple|icloud|app.specific|asp|password)[^\n]{0,60}\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\b/i],
  ["IBAN", /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/],
];

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = +digits[digits.length - 1 - i];
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** Throws if the text looks like it carries a secret. Saying where one is kept ("in the password manager") is fine. */
export function assertNoSecrets(text: string) {
  for (const [what, re] of SECRET_PATTERNS) {
    if (re.test(text)) throw new Refused(`Refused: this looks like it contains a ${what}. The Brain keeps where a secret lives, never the value.`);
  }
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length >= 13 && d.length <= 19 && luhn(d) && !/^(\d)\1+$/.test(d)) {
      throw new Refused("Refused: this looks like it contains a card number.");
    }
  }
}

// ---------- Frontmatter ----------

export interface NormalFrontmatter {
  fm: Record<string, unknown>;
  type: string;
  status: string;
  sensitivity: Sensitivity;
  tags: string[];
}

/** Fill defaults, check types, keep unknown keys. `created` is kept, `updated` is set by the caller. */
export function normalizeFrontmatter(input: Record<string, unknown>, defaults: { type?: string; sensitivity?: Sensitivity }, today: string): NormalFrontmatter {
  const fm: Record<string, unknown> = { ...input };
  fm.type = typeof fm.type === "string" && fm.type ? fm.type : (defaults.type ?? "note");
  fm.status = typeof fm.status === "string" && fm.status ? fm.status : "active";
  fm.created = typeof fm.created === "string" && fm.created ? fm.created : today;
  let tags = fm.tags;
  if (typeof tags === "string") tags = tags.split(/[,\s]+/).filter(Boolean);
  if (!Array.isArray(tags)) tags = [];
  fm.tags = (tags as unknown[]).map(String);
  if (fm.related == null) fm.related = [];
  if (!Array.isArray(fm.related)) fm.related = [fm.related];
  const s = String(fm.sensitivity ?? defaults.sensitivity ?? "normal");
  if (!(SENSITIVITIES as readonly string[]).includes(s)) throw new Refused(`sensitivity must be one of ${SENSITIVITIES.join(", ")}`);
  fm.sensitivity = s;
  return { fm, type: fm.type as string, status: fm.status as string, sensitivity: s as Sensitivity, tags: fm.tags as string[] };
}

/** A path starts at a root and has no empty segments. Returns its parts, the root spelled as the household spells it. */
export function splitPath(path: string, roots: string[]): string[] {
  const parts = String(path ?? "").split("/").map((s) => s.trim());
  if (!parts.length || parts.some((s) => !s)) throw new Refused(`Bad path "${path}"`);
  const root = roots.find((r) => r.toLowerCase() === parts[0].toLowerCase());
  if (!root) throw new Refused(`Paths start at ${roots.join(", ")}; got "${parts[0]}"`);
  parts[0] = root;
  return parts;
}

/** Anything under a branch called "Health" or "Private" is always sensitive. */
export function forcedSensitivity(parts: string[]): Sensitivity | null {
  return parts.slice(1).some((s) => ["health", "private"].includes(s.toLowerCase())) ? "sensitive" : null;
}

/** Insert text at the end of the section under `heading` (any level), or at the end of the body. */
export function appendToSection(body: string, text: string, heading?: string): string {
  const add = text.endsWith("\n") ? text : text + "\n";
  if (!heading) return body.endsWith("\n") || !body ? body + add : body + "\n" + add;
  const lines = body.split("\n");
  const want = heading.replace(/^#+\s*/, "").trim().toLowerCase();
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim().toLowerCase() === want);
  if (start < 0) throw new Refused(`No heading "${heading}" in this note`);
  const level = lines[start].match(/^#+/)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#+)\s/);
    if (h && h[1].length <= level) { end = i; break; }
  }
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  lines.splice(end, 0, ...add.replace(/\n$/, "").split("\n"));
  return lines.join("\n");
}

/**
 * Point wikilinks somewhere new: every [[X]], [[X#h]] or [[X|alias]] whose X (case-insensitive) is a key of `map`
 * becomes [[to#h|alias]]. A link without an alias gets `alias` from the map, so it keeps showing the same words.
 */
export function retarget(text: string, map: Map<string, { to: string; alias?: string }>): string {
  return text.replace(/\[\[([^\]\n|#]+)((?:#[^\]\n|]*)?)((?:\|[^\]\n]*)?)\]\]/g, (all, t: string, heading: string, alias: string) => {
    const r = map.get(t.trim().toLowerCase());
    if (!r) return all;
    return `[[${r.to}${heading}${alias || (r.alias ? `|${r.alias}` : "")}]]`;
  });
}

/** Retarget the `related` list in frontmatter (entries are "[[X]]" or bare "X"). */
export function retargetRelated(fm: Record<string, unknown>, map: Map<string, { to: string; alias?: string }>): boolean {
  const r = fm.related;
  const fix = (x: unknown) => {
    if (typeof x !== "string") return x;
    if (x.includes("[[")) return retarget(x, map);
    const m = map.get(x.trim().toLowerCase());
    return m ? `[[${m.to}${m.alias ? `|${m.alias}` : ""}]]` : x;
  };
  if (Array.isArray(r)) {
    const next = r.map(fix);
    if (JSON.stringify(next) === JSON.stringify(r)) return false;
    fm.related = next;
    return true;
  }
  if (typeof r === "string") {
    const next = fix(r);
    if (next === r) return false;
    fm.related = next;
    return true;
  }
  return false;
}

/** If the first heading of the body is the old title, rename it too. */
export function retitleHeading(body: string, oldTitle: string, newTitle: string): string {
  return body.replace(/^([ \t]*#[ \t]+)(.+?)[ \t]*$/m, (all, h: string, t: string) => (t.trim().toLowerCase() === oldTitle.trim().toLowerCase() ? `${h}${newTitle}` : all));
}
