// Finds the Cloudflare account and zone a household's domain lives in, and what already exists there.
import { CloudflareError } from "./cloudflare.mjs";

/** "home.example.com" -> ["home.example.com", "example.com"]: the zone is one of these. */
export const zoneCandidates = (domain) => {
  const parts = domain.split(".");
  return parts.slice(0, -1).map((_, i) => parts.slice(i).join("."));
};

/** { zone, accountId } for the domain, or null when no zone on this token matches. */
export async function findZone(cf, domain) {
  for (const name of zoneCandidates(domain)) {
    const zones = await cf.list(`/zones?name=${encodeURIComponent(name)}`);
    if (zones.length) return { zone: zones[0], accountId: zones[0].account?.id };
  }
  return null;
}

/** The Zero Trust team name ("your-team" of your-team.cloudflareaccess.com), or null when Zero Trust is not set up. */
export async function accessTeam(cf, accountId) {
  try {
    const org = (await cf.get(`/accounts/${accountId}/access/organizations`)).result;
    const domain = org?.auth_domain ?? "";
    return domain.endsWith(".cloudflareaccess.com") ? domain.slice(0, -".cloudflareaccess.com".length) : null;
  } catch (e) {
    if (e instanceof CloudflareError && (e.status === 404 || e.status === 403 || e.status === 400)) return null;
    throw e;
  }
}

/** What exists now, by name. */
export async function existing(cf, accountId) {
  const [d1, kv, r2, apps] = await Promise.all([
    cf.list(`/accounts/${accountId}/d1/database`),
    cf.list(`/accounts/${accountId}/storage/kv/namespaces`),
    cf.list(`/accounts/${accountId}/r2/buckets`).catch((e) => (e instanceof CloudflareError ? [] : Promise.reject(e))),
    cf.list(`/accounts/${accountId}/access/apps`),
  ]);
  return {
    d1: new Map(d1.map((d) => [d.name, d.uuid])),
    kv: new Map(kv.map((k) => [k.title, k.id])),
    r2: new Set(r2.map((b) => b.name)),
    apps: new Map(apps.map((a) => [a.name, a])),
  };
}
