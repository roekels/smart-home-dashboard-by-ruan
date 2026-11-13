// What the home modules keep in D1 <prefix>-home (binding HOME_DB): the newest Home Assistant reading, the
// household's choices from the setup page, and an audit line for every change.
import type { Env } from "../../apps/shell/src/env.ts";
import type { Household } from "../../packages/core/src/household.ts";
import { HttpError } from "../../packages/core/src/util.ts";
import { HaError, emptySettings, haConfigured, readStates, type Fetch, type HaMap, type HaSettings } from "./ha.ts";

export function db(env: Env): D1Database {
  if (!env.HOME_DB) throw new HttpError(503, "the home database is not connected (binding HOME_DB)");
  return env.HOME_DB;
}

export async function kvGet<T>(env: Env, key: string): Promise<{ data: T; at: number } | null> {
  const r = await db(env).prepare("SELECT data, at FROM home_kv WHERE key = ?").bind(key).first<{ data: string; at: number }>();
  return r ? { data: JSON.parse(r.data) as T, at: r.at } : null;
}

export async function kvPut(env: Env, key: string, data: unknown, at = Date.now()): Promise<void> {
  await db(env).prepare("INSERT INTO home_kv (key, data, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, at = excluded.at")
    .bind(key, JSON.stringify(data), at).run();
}

/** One audit line. Ids and names of things only: never a list item's text, never a value. */
export async function audit(env: Env, actor: string, action: string, target?: string, detail?: unknown): Promise<void> {
  await db(env).prepare("INSERT INTO home_audit (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(Date.now(), actor, action, target ?? null, detail === undefined ? null : JSON.stringify(detail)).run();
}

// ---------------------------------------------------------------- the reading

/** How old a reading may be before a page request reads Home Assistant again. */
export const FRESH_MS = 20_000;
/** After this long without an answer the pages say "not answering". */
export const STALE_MS = 3 * 60_000;

export interface Reading { ts: number | null; fresh: boolean; error: string | null; states: HaMap }
interface Stored { ts: number; states: HaMap }

/**
 * The newest reading. Read from Home Assistant when the stored one is older than `maxAge`, otherwise from D1, so
 * ten open pages cost one read every 20 seconds, not ten. When Home Assistant does not answer, the last reading
 * comes back with the reason.
 */
export async function reading(env: Env, maxAge = FRESH_MS, fetcher?: Fetch, now = Date.now()): Promise<Reading> {
  const stored = await kvGet<Stored>(env, "ha.states");
  if (stored && now - stored.at < maxAge) return { ts: stored.data.ts, fresh: true, error: null, states: stored.data.states };
  const last = stored?.data ?? null;
  if (!haConfigured(env)) return { ts: last?.ts ?? null, fresh: false, error: "Home Assistant is not set up yet", states: last?.states ?? {} };
  try {
    const { states } = await readStates(env, fetcher);
    await kvPut(env, "ha.states", { ts: now, states } satisfies Stored, now);
    return { ts: now, fresh: true, error: null, states };
  } catch (e) {
    const error = e instanceof HaError ? e.message : "Home Assistant did not answer";
    if (!(e instanceof HaError)) console.error("home assistant read failed");
    return { ts: last?.ts ?? null, fresh: !!last && now - last.ts < STALE_MS, error, states: last?.states ?? {} };
  }
}

/** After a switch: write what we just did into the stored reading and let it expire in 3 seconds, so the page
 *  shows the change at once and the next read confirms it from Home Assistant. */
export async function remember(env: Env, change: (states: HaMap) => void, now = Date.now()): Promise<void> {
  const stored = await kvGet<Stored>(env, "ha.states");
  if (!stored) return;
  change(stored.data.states);
  await kvPut(env, "ha.states", stored.data, now - FRESH_MS + 3000);
}

// ---------------------------------------------------------------- the household's choices

const ID = /^[a-z_]+\.[a-z0-9_]{1,100}$/;
const idList = (v: unknown, domain: string, max: number): string[] => {
  if (!Array.isArray(v)) return [];
  const out = [...new Set(v.map(String).filter((e) => ID.test(e) && e.startsWith(domain + ".")))].sort();
  if (out.length > max) throw new HttpError(400, `at most ${max} ${domain} entities`);
  return out;
};

/** Cleans what the setup page sends. A list's owner must be "shared", "hidden" or a person of this household. */
export function cleanSettings(raw: any, h: Household): HaSettings {
  const lists: Record<string, string> = {};
  if (raw?.lists && typeof raw.lists === "object" && !Array.isArray(raw.lists)) {
    for (const [e, owner] of Object.entries(raw.lists)) {
      if (!ID.test(e) || !e.startsWith("todo.")) throw new HttpError(400, `${String(e).slice(0, 60)} is not a todo.* list`);
      if (owner !== "shared" && owner !== "hidden" && !h.people.some((p) => p.id === owner)) throw new HttpError(400, `the owner of ${e} must be "shared", "hidden" or a person of this household`);
      lists[e] = String(owner);
    }
    if (Object.keys(lists).length > 60) throw new HttpError(400, "at most 60 lists");
  }
  return { lists, plugs: idList(raw?.plugs, "switch", 60), scripts: idList(raw?.scripts, "script", 20), hiddenLights: idList(raw?.hiddenLights, "light", 200) };
}

export async function settings(env: Env): Promise<HaSettings> {
  return { ...emptySettings(), ...((await kvGet<Partial<HaSettings>>(env, "ha.settings"))?.data ?? {}) };
}
