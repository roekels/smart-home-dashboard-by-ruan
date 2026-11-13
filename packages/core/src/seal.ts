// Encryption at rest for the modules that hold private data (Health, Finance, the Brain's sensitive tier).
// AES-256-GCM. The key is derived with HKDF-SHA-256 from a Worker secret (a long random passphrase generated in the
// admin's browser on the one-time key page) and a per-module label, so two modules never share an AES key even if
// someone gives them the same secret. A sealed value looks like  enc:v1:<iv>:<ciphertext>  (both base64).
// WebCrypto only: runs in Workers and in node --test.
const enc = new TextEncoder(), dec = new TextDecoder();
const cache = new Map<string, { secret: string; key: CryptoKey }>();

export const MIN_SECRET_LENGTH = 32;

export class SealError extends Error {}

export interface Sealer {
  /** False when the secret is not set: nothing can be read or written. */
  ready: boolean;
  seal(value: unknown): Promise<string>;
  unseal<T = unknown>(sealed: string): Promise<T>;
}

async function aesKey(secret: string | undefined, label: string, name: string): Promise<CryptoKey> {
  if (!secret) throw new SealError(`${name} is not set: this data is locked`);
  if (secret.length < MIN_SECRET_LENGTH) throw new SealError(`${name} is too short`);
  const hit = cache.get(label);
  if (hit?.secret === secret) return hit.key;
  const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(label), info: enc.encode("at-rest v1") },
    ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
  cache.set(label, { secret, key });
  return key;
}

function b64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const isSealed = (v: unknown): v is string => typeof v === "string" && v.startsWith("enc:v1:");

/**
 * A sealer for one module. `secret` is the Worker secret's value, `label` the module's fixed label (never change it:
 * it is part of the key), `name` the secret's name for error messages. Values are JSON-encoded before sealing.
 */
export function sealer(secret: string | undefined, label: string, name: string): Sealer {
  return {
    ready: !!secret && secret.length >= MIN_SECRET_LENGTH,
    async seal(value) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret, label, name), enc.encode(JSON.stringify(value))));
      return `enc:v1:${b64(iv)}:${b64(ct)}`;
    },
    async unseal<T>(sealed: string) {
      const [tag, v, iv, ct] = String(sealed).split(":");
      if (tag !== "enc" || v !== "v1" || !iv || !ct) throw new SealError("not a sealed value");
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(secret, label, name), unb64(ct));
      return JSON.parse(dec.decode(pt)) as T;
    },
  };
}
