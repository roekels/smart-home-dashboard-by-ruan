// Agent request signing and command signing (agent/PROTOCOL.md). Pure functions: the Worker verifies requests and
// signs commands; the tests sign requests the way the Go agent does.
import { b64urlDecode, b64urlEncode, sha256hex } from "../../packages/core/src/util.ts";

export const MAX_SKEW_MS = 120_000;
export const MAX_BODY = 256 * 1024;
export const AGENT_ID = /^ag_[a-z0-9-]{3,40}$/;

/** What people type in the "Add a machine" form, made into a valid id: lower case, spaces and underscores to hyphens. */
export function normalizeAgentId(raw: string): string {
  const s = raw.trim().toLowerCase();
  const rest = s.startsWith("ag_") ? s.slice(3) : s;
  return "ag_" + rest.replace(/[\s_]+/g, "-");
}

export interface SignedParts { method: string; path: string; agent: string; ts: string; nonce: string; bodySha: string }

export function canonical(p: SignedParts): string {
  return ["agent-v1", p.method.toUpperCase(), p.path, p.agent, p.ts, p.nonce, p.bodySha].join("\n");
}

/** Signs with an agent's private key (tests only: a real agent's key never leaves its machine). */
export async function sign(privateKey: CryptoKey, p: SignedParts): Promise<string> {
  return b64urlEncode(await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(canonical(p))));
}

/** A raw 32-byte Ed25519 public key, base64url. */
export async function importPublicKey(raw: string): Promise<CryptoKey> {
  const bytes = b64urlDecode(raw);
  if (bytes.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return crypto.subtle.importKey("raw", bytes, { name: "Ed25519" }, false, ["verify"]);
}

/** What a person compares by eye: the first 16 bytes of sha256(raw public key), base64url. */
export async function fingerprint(raw: string): Promise<string> {
  const hex = await sha256hex(b64urlDecode(raw));
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b64urlEncode(bytes);
}

export type Check = { ok: true } | { ok: false; why: string };

/** Everything but the nonce replay check (that needs storage). `now` is injectable for tests. */
export async function checkSignature(publicKey: CryptoKey, p: SignedParts, sig: string, body: Uint8Array<ArrayBuffer>, now = Date.now()): Promise<Check> {
  if (!AGENT_ID.test(p.agent)) return { ok: false, why: "agent id" };
  if (!/^\d{13}$/.test(p.ts)) return { ok: false, why: "timestamp" };
  if (Math.abs(now - Number(p.ts)) > MAX_SKEW_MS) return { ok: false, why: "clock skew" };
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(p.nonce)) return { ok: false, why: "nonce" };
  if (body.length > MAX_BODY) return { ok: false, why: "body size" };
  if ((await sha256hex(body)) !== p.bodySha) return { ok: false, why: "body hash" };
  let sigBytes: Uint8Array<ArrayBuffer>;
  try { sigBytes = b64urlDecode(sig); } catch { return { ok: false, why: "signature encoding" }; }
  const ok = await crypto.subtle.verify("Ed25519", publicKey, sigBytes, new TextEncoder().encode(canonical(p)));
  return ok ? { ok: true } : { ok: false, why: "signature" };
}

// ---------- commands signed by the Worker (agents pin the public key from the enrol reply) ----------

/** Canonical JSON: object keys sorted at every level, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export interface SignedCommand { agent: string; id: string; op: string; args: unknown; expires: number }

export async function commandString(c: SignedCommand): Promise<string> {
  return ["cmd-v1", c.agent, c.id, c.op, await sha256hex(canonicalJson(c.args)), String(c.expires)].join("\n");
}

const PKCS8_ED25519 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

/** SHELL_COMMAND_SIGNING_KEY is 32 random bytes as standard base64 (44 characters), made on the one-time key page
 *  like every other _KEY secret. They are the seed of the Ed25519 key that signs commands; `pub` is its public
 *  half (raw, base64url), which agents pin at enrolment. */
export async function commandKey(secret: string | undefined): Promise<{ priv: CryptoKey; pub: string }> {
  const text = (secret ?? "").trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) throw new Error("SHELL_COMMAND_SIGNING_KEY is not set, or is not 32 bytes as base64");
  const seed = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  if (seed.length !== 32) throw new Error("SHELL_COMMAND_SIGNING_KEY must be 32 bytes");
  const pkcs8 = new Uint8Array([...PKCS8_ED25519, ...seed]);
  // imported once as exportable only to read the public half; the key that signs is not exportable
  const open = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const pub = ((await crypto.subtle.exportKey("jwk", open)) as JsonWebKey).x!;
  const priv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return { priv, pub };
}

export async function signCommand(priv: CryptoKey, c: SignedCommand): Promise<string> {
  return b64urlEncode(await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(await commandString(c))));
}
