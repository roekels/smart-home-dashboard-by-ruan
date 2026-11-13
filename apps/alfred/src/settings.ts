/**
 * What the assistant is called and what it may do: the Assistant settings page (/dashboard/alfred), stored in the
 * Registry Durable Object. Only admins change it.
 *
 * Permissions are check boxes, two per service the gateway offers: "<service>.read" and "<service>.write". A box
 * that is off takes those tools away completely. Boxes only narrow: the gateway key's scopes stay the hard limit,
 * and the policy (policy.ts) still asks before a write and keeps destructive tools off. A box nobody has touched
 * counts as on, so a module added later works without a visit to this page.
 */
export interface Settings {
  /** The name it answers to and signs with. */
  name: string;
  /** One or two sentences on how it should sound, in the admin's words. May be empty. */
  persona: string;
  /** "<service>.read" / "<service>.write" -> allowed. Missing = allowed. */
  permissions: Record<string, boolean>;
  /** Claude's fast mode: quicker answers at a higher token price. */
  fast: boolean;
}

export const DEFAULT_NAME = "Alfred";
export const MAX_NAME = 24;
export const MAX_PERSONA = 400;

export const DEFAULT_SETTINGS: Settings = { name: DEFAULT_NAME, persona: "", permissions: {}, fast: false };

const BOX = /^[a-z][a-z0-9-]{0,30}\.(read|write)$/;
/** Letters, digits, spaces and a few marks: the name goes into the prompt and onto the page. */
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} .'’-]*$/u;

export const allowed = (s: Settings, service: string, kind: "read" | "write"): boolean => s.permissions[`${service}.${kind}`] !== false;

/** One line of plain text: no line breaks, no angle brackets (it sits inside the system prompt). */
const plain = (v: string, max: number): string => v.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Stored or posted settings, with anything unknown dropped and anything missing left at `base`. */
export function mergeSettings(base: Settings, raw: unknown): Settings {
  const out: Settings = { name: base.name, persona: base.persona, permissions: { ...base.permissions }, fast: base.fast };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as { name?: unknown; persona?: unknown; permissions?: unknown; fast?: unknown };
  if (typeof r.name === "string") {
    const name = plain(r.name, MAX_NAME);
    if (NAME.test(name)) out.name = name;
  }
  if (typeof r.persona === "string") out.persona = plain(r.persona, MAX_PERSONA);
  if (r.permissions && typeof r.permissions === "object") {
    for (const [k, v] of Object.entries(r.permissions as Record<string, unknown>)) {
      if (BOX.test(k) && typeof v === "boolean") out.permissions[k] = v;
    }
  }
  if (typeof r.fast === "boolean") out.fast = r.fast;
  return out;
}
