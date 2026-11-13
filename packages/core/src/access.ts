// Cloudflare Access: verify the JWT ourselves (never trust the header alone), with WebCrypto only.
import { b64urlDecode } from "./util.ts";

export interface AccessConfig {
  /** The Zero Trust team name: the first label of <team>.cloudflareaccess.com. */
  team: string;
  /** The Access application's AUD tag. Several apps may cover one path: any of them passes. */
  aud: string | string[];
}

type Jwk = JsonWebKey & { kid?: string };
const cache = new Map<string, { at: number; keys: Jwk[] }>();

async function keys(issuer: string, fetcher: typeof fetch): Promise<Jwk[]> {
  const hit = cache.get(issuer);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.keys;
  const res = await fetcher(`${issuer}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  cache.set(issuer, { at: Date.now(), keys: body.keys });
  return body.keys;
}

const dec = new TextDecoder();

/**
 * Verified claims of an Access JWT, or null. Checks: RS256 signature against the team's keys, issuer,
 * audience, exp / nbf (60 s leeway). Service tokens carry `common_name` instead of `email`.
 */
export async function verifyAccessToken(
  token: string | null,
  cfg: AccessConfig,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<Record<string, unknown> | null> {
  const auds = (Array.isArray(cfg.aud) ? cfg.aud : [cfg.aud]).filter(Boolean);
  if (!token || !auds.length || !/^[a-z0-9-]+$/.test(cfg.team)) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(dec.decode(b64urlDecode(parts[0])));
    const payload = JSON.parse(dec.decode(b64urlDecode(parts[1])));
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    const issuer = `https://${cfg.team}.cloudflareaccess.com`;
    const jwk = (await keys(issuer, fetcher)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const t = now / 1000;
    if (payload.iss !== issuer) return null;
    const aud: unknown[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.some((a) => typeof a === "string" && auds.includes(a))) return null;
    if (typeof payload.exp !== "number" || payload.exp < t - 60) return null;
    if (typeof payload.nbf === "number" && payload.nbf > t + 60) return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The verified email of the person signed in through Access, lower case, or null. Who may enter is the caller's check. */
export async function accessEmail(
  token: string | null,
  cfg: AccessConfig,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<string | null> {
  const claims = await verifyAccessToken(token, cfg, fetcher, now);
  return String(claims?.email ?? "").toLowerCase() || null;
}

/** Test hook: forget cached keys. */
export function resetAccessCache(): void {
  cache.clear();
}
