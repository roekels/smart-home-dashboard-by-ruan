// /setup/keys: the one-time key page. Encryption keys are made in the admin's browser, shown to them once, and
// stored by this Worker as secrets of the Workers that use them. The AI never sees a value: it only opens the page
// (setup/keys.mjs open) and closes it afterwards (setup/keys.mjs close).
//
//   GET  /api/setup/keys   { state: "closed" | "open" | "locked", keys: [{ name, purpose, kind, set }] }
//   POST /api/setup/keys   { keys: { NAME: value } }  stores each as a Worker secret, then locks
//
// "open" lasts only while the secret SETUP_KEYPAGE_WRITE_TOKEN is set on this Worker. Its value is JSON written by
// setup/keys.mjs: a Cloudflare token that can only edit Worker secrets (expires within a day), the account id, this
// Worker's name, and which Worker each key belongs on. Once every key is stored the Worker deletes that secret, so
// the page cannot write again. A key that is already set is never replaced: replacing an encryption key would make
// everything encrypted with the old one unreadable.
import type { Person } from "../../../packages/core/src/household.ts";
import { HttpError, json } from "../../../packages/core/src/util.ts";
import type { ManifestSecret } from "./security.ts";

export const KEYPAGE_SECRET = "SETUP_KEYPAGE_WRITE_TOKEN";
const API = "https://api.cloudflare.com/client/v4";

export interface KeyTarget { name: string; worker: string }
export interface KeyPagePass { token: string; accountId: string; shell: string; keys: KeyTarget[] }
export type KeyKind = "key" | "passphrase";
export interface KeyRow { name: string; purpose: string; kind: KeyKind; set: boolean }

const NAME = /^[A-Z][A-Z0-9_]*_(KEY|PASSPHRASE)$/;
const WORKER = /^[a-z][a-z0-9-]{0,62}$/;

export const kindOf = (name: string): KeyKind => (name.endsWith("_PASSPHRASE") ? "passphrase" : "key");

/** The pass setup/keys.mjs left on this Worker, or null when the page is closed. A broken pass counts as closed. */
export function readPass(text: string | undefined): KeyPagePass | null {
  if (!text) return null;
  try {
    const p = JSON.parse(text) as KeyPagePass;
    const ok = typeof p.token === "string" && p.token.length > 10 && /^[0-9a-f]{32}$/.test(p.accountId) && WORKER.test(p.shell) &&
      Array.isArray(p.keys) && p.keys.length > 0 && p.keys.every((k) => NAME.test(k.name) && WORKER.test(k.worker));
    return ok ? p : null;
  } catch {
    return null;
  }
}

/** A key: 32 random bytes as base64. A passphrase: at least 20 characters with no spaces. Returns a problem or null. */
export function valueProblem(name: string, value: unknown): string | null {
  if (typeof value !== "string") return "no value";
  if (kindOf(name) === "passphrase") return /^[A-Za-z0-9-]{20,128}$/.test(value) ? null : "a passphrase is 20 to 128 letters, digits and dashes";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return "a key is 32 random bytes as base64 (44 characters)";
  return null;
}

type Fetch = typeof fetch;

async function cf(f: Fetch, pass: KeyPagePass, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await f(`${API}/accounts/${pass.accountId}${path}`, {
    method,
    headers: { authorization: `Bearer ${pass.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { success?: boolean; result?: unknown } | null;
  // Cloudflare's error text is not passed on: it can echo parts of the request.
  if (!res.ok || data?.success === false) throw new HttpError(502, `Cloudflare refused the request (${res.status}). The key page's token may have expired: ask your AI to open the page again.`);
  return data?.result;
}

async function secretNames(f: Fetch, pass: KeyPagePass, worker: string): Promise<Set<string>> {
  const list = (await cf(f, pass, "GET", `/workers/scripts/${worker}/secrets`)) as { name: string }[] | null;
  return new Set((list ?? []).map((s) => s.name));
}

async function rows(f: Fetch, pass: KeyPagePass, manifest: ManifestSecret[]): Promise<KeyRow[]> {
  const have = new Map<string, Set<string>>();
  for (const w of new Set(pass.keys.map((k) => k.worker))) have.set(w, await secretNames(f, pass, w));
  return pass.keys.map((k) => ({
    name: k.name,
    purpose: manifest.find((s) => s.name === k.name)?.purpose ?? "",
    kind: kindOf(k.name),
    set: have.get(k.worker)!.has(k.name),
  }));
}

/** Removes the pass from this Worker. After this the page can no longer write anything. */
const lock = (f: Fetch, pass: KeyPagePass): Promise<unknown> => cf(f, pass, "DELETE", `/workers/scripts/${pass.shell}/secrets/${KEYPAGE_SECRET}`);

export interface KeyPageInput { req: Request; person: Person; passText: string | undefined; manifest: ManifestSecret[]; write: boolean; fetch?: Fetch }

export async function keyPageApi({ req, person, passText, manifest, write, fetch: f = fetch }: KeyPageInput): Promise<Response> {
  if (!person.admin) throw new HttpError(403, "the key page is for admins");
  const pass = readPass(passText);
  if (req.method === "GET") {
    if (!pass) return json({ state: "closed", keys: [] });
    const keys = await rows(f, pass, manifest);
    if (keys.every((k) => k.set)) { await lock(f, pass); return json({ state: "locked", keys }); }
    return json({ state: "open", keys });
  }
  if (req.method !== "POST") throw new HttpError(405, "method not allowed");
  if (!write) throw new HttpError(403, "cross-site write refused");
  if (!pass) throw new HttpError(409, "the key page is closed");

  const sent = ((await req.json().catch(() => null)) as { keys?: Record<string, unknown> } | null)?.keys;
  if (!sent || typeof sent !== "object") throw new HttpError(400, "send { keys: { NAME: value } }");
  const before = await rows(f, pass, manifest);
  const problems: string[] = [];
  for (const [name, value] of Object.entries(sent)) {
    const row = before.find((k) => k.name === name);
    if (!row) problems.push(`${name}: not a key this page makes`);
    else if (row.set) problems.push(`${name}: already set, and a set key is never replaced`);
    else { const p = valueProblem(name, value); if (p) problems.push(`${name}: ${p}`); }
  }
  for (const k of before) if (!k.set && !(k.name in sent)) problems.push(`${k.name}: missing`);
  // Nothing is stored unless everything can be: a half-stored set would leave keys the person has not seen saved.
  if (problems.length) throw new HttpError(400, problems.join("; "));

  const saved: string[] = [];
  for (const k of pass.keys) {
    if (!(k.name in sent)) continue;
    await cf(f, pass, "PUT", `/workers/scripts/${k.worker}/secrets`, { name: k.name, text: sent[k.name], type: "secret_text" });
    saved.push(k.name);
  }
  await lock(f, pass);
  return json({ state: "locked", saved, keys: before.map((k) => ({ ...k, set: true })) });
}
