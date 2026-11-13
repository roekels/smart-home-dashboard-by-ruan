// Shopping and to-do lists: Home Assistant's todo.* entities (its own lists, or ones an integration syncs in, for
// example a phone's reminders through the Home Assistant app). Read, add, tick off and untick. Nothing is ever
// deleted from here.
//
// Who sees which list is set on the setup page: "shared" (everyone, and the wall tablet), one person, or "hidden".
// A list nobody has named yet is shown to admins only, never to everyone.
import type { Env } from "../../apps/shell/src/env.ts";
import type { Person } from "../../packages/core/src/household.ts";
import { haFetch, HaError, type Fetch, type HaMap, type HaSettings } from "./ha.ts";

export interface ListItem { uid: string; text: string; done: boolean; due?: string }
export interface TodoList { entity: string; name: string; shared: boolean; open: number; items: ListItem[] }

export class ListError extends Error {}

const ENTITY = /^todo\.[a-z0-9_]{1,100}$/;
const MAX_OPEN = 150, MAX_DONE = 15, MAX_TEXT = 200;

/** The caller, as far as lists care: a person, or something that only ever gets the shared lists. */
export type Viewer = Pick<Person, "id" | "admin"> | "shared-only";

export function mayUse(set: HaSettings, who: Viewer, entity: string): boolean {
  const owner = set.lists[entity];
  if (owner === "shared") return true;
  if (who === "shared-only" || owner === "hidden") return false;
  if (owner) return owner === who.id;
  return who.admin; // unnamed: admins only, until someone says whose it is
}

/** The todo.* entities in a reading, as { entity: { name, open } }. */
export function knownLists(ha: HaMap): Record<string, { name: string; open: number }> {
  const out: Record<string, { name: string; open: number }> = {};
  for (const [e, v] of Object.entries(ha)) {
    if (!ENTITY.test(e) || v.s === "unavailable") continue;
    out[e] = { name: String(v.n || e.slice(5).replace(/_/g, " ")).slice(0, 60), open: Number(v.s) || 0 };
  }
  return out;
}

/** Every list this caller may see, with its items: shared lists first, open items first, then the latest few done ones. */
export async function readLists(env: Env, ha: HaMap, set: HaSettings, who: Viewer, fetcher?: Fetch): Promise<TodoList[]> {
  const all = knownLists(ha);
  const shared = (e: string) => set.lists[e] === "shared";
  const mine = Object.keys(all).filter((e) => mayUse(set, who, e)).sort((a, b) => Number(shared(b)) - Number(shared(a)) || all[a].name.localeCompare(all[b].name));
  if (!mine.length) return [];
  const r = await haFetch(env, "POST", "/api/services/todo/get_items?return_response", { entity_id: mine }, fetcher);
  const resp = r?.service_response ?? {};
  return mine.map((e) => {
    const raw: any[] = Array.isArray(resp[e]?.items) ? resp[e].items : [];
    const items = raw.map((i): ListItem => {
      const it: ListItem = { uid: String(i.uid ?? ""), text: String(i.summary ?? "").slice(0, MAX_TEXT), done: i.status === "completed" };
      if (i.due) it.due = String(i.due).slice(0, 25);
      return it;
    }).filter((i) => i.uid && i.text);
    const open = items.filter((i) => !i.done);
    return { entity: e, name: all[e].name, shared: shared(e), open: open.length, items: [...open.slice(0, MAX_OPEN), ...items.filter((i) => i.done).slice(0, MAX_DONE)] };
  });
}

function check(ha: HaMap, set: HaSettings, who: Viewer, entity: unknown): string {
  const e = String(entity ?? "");
  if (!ENTITY.test(e)) throw new ListError("list must be a todo.* id");
  if (!mayUse(set, who, e) || !(e in knownLists(ha))) throw new ListError(`${e} is not one of your lists`);
  return e;
}

/** Adds one item to the end of a list. */
export async function addItem(env: Env, ha: HaMap, set: HaSettings, who: Viewer, entity: unknown, text: unknown, fetcher?: Fetch): Promise<{ ok: true; list: string }> {
  const e = check(ha, set, who, entity);
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > MAX_TEXT) throw new ListError(`text must be 1..${MAX_TEXT} characters`);
  await haFetch(env, "POST", "/api/services/todo/add_item", { entity_id: e, item: t }, fetcher);
  return { ok: true, list: e };
}

/** Ticks an item off (done: true) or back on (done: false). `item` is its uid, or its exact text. */
export async function setDone(env: Env, ha: HaMap, set: HaSettings, who: Viewer, entity: unknown, item: unknown, done: unknown, fetcher?: Fetch): Promise<{ ok: true; list: string; done: boolean }> {
  const e = check(ha, set, who, entity);
  const i = String(item ?? "").trim();
  if (!i || i.length > MAX_TEXT) throw new ListError("item must be the item's uid or its text");
  if (typeof done !== "boolean") throw new ListError("done must be true or false");
  await haFetch(env, "POST", "/api/services/todo/update_item", { entity_id: e, item: i, status: done ? "completed" : "needs_action" }, fetcher);
  return { ok: true, list: e, done };
}

export const listErrorStatus = (e: unknown): number | null => (e instanceof ListError ? 400 : e instanceof HaError ? 502 : null);
