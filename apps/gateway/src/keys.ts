import { sha256hex } from "../../../packages/core/src/util.ts";
import type { Env, Principal } from "./env.ts";
import { nowIso } from "./util.ts";

/** hmcp_<name>_<random>. Only the SHA-256 is stored (scripts/new-key.mjs makes one). */
export const KEY_SHAPE = /^hmcp_[a-z0-9-]+_[A-Za-z0-9_-]{30,}$/;

/** API keys for the household's own programs (Alfred, scripts). All of the key's scopes; the caller cuts them to one service. */
export async function principalFromKey(env: Pick<Env, "DB">, token: string): Promise<Principal | null> {
  if (!KEY_SHAPE.test(token)) return null;
  const row = await env.DB.prepare("SELECT name, scopes FROM api_keys WHERE sha256 = ? AND revoked_at IS NULL").bind(await sha256hex(token)).first<{ name: string; scopes: string }>();
  if (!row) return null;
  let scopes: unknown;
  try { scopes = JSON.parse(row.scopes); } catch { return null; }
  if (!Array.isArray(scopes)) return null;
  await env.DB.prepare("UPDATE api_keys SET last_used = ? WHERE name = ?").bind(nowIso(), row.name).run();
  return { actor: row.name, via: "key", scopes: scopes.filter((s): s is string => typeof s === "string") };
}
