// What the Home Assistant module does, as plain functions over Env. Three callers share them: the pages
// (worker.ts), a paired wall tablet (modules/kiosk) and the gateway's /home/mcp (apps/shell/src/entrypoints.ts).
// Each caller has already proved who is asking; `actor` is only what goes into the audit line.
import type { Env } from "../../apps/shell/src/env.ts";
import { controls, runScene, setLight, setPlug, type Controls, type Fetch, type LightArgs } from "./ha.ts";
import { addItem, readLists, setDone, type TodoList, type Viewer } from "./lists.ts";
import { audit, reading, remember, settings } from "./store.ts";

export interface HomeControls extends Controls { ts: number | null; fresh: boolean; error: string | null }

/** GET /api/ha: lights, plugs and scenes, with how fresh the reading is. */
export async function homeControls(env: Env, fetcher?: Fetch): Promise<HomeControls> {
  const [r, set] = await Promise.all([reading(env, undefined, fetcher), settings(env)]);
  return { ts: r.ts, fresh: r.fresh, error: r.error, ...controls(r.states, set) };
}

export async function light(env: Env, actor: string, args: LightArgs, fetcher?: Fetch) {
  const [r, set] = await Promise.all([reading(env, undefined, fetcher), settings(env)]);
  const out = await setLight(env, r.states, set, args, fetcher);
  await remember(env, (ha) => {
    for (const e of out.entity) {
      if (!ha[e]) continue;
      ha[e].s = out.on ? "on" : "off";
      if (out.brightness) ha[e].b = out.brightness;
      if (!out.on) { delete ha[e].b; delete ha[e].c; }
    }
  });
  await audit(env, actor, out.on ? "light.on" : "light.off", out.entity.length === 1 ? out.entity[0] : `${out.entity.length} lights`);
  return out;
}

export async function scene(env: Env, actor: string, which: unknown, fetcher?: Fetch) {
  const [r, set] = await Promise.all([reading(env, undefined, fetcher), settings(env)]);
  const out = await runScene(env, r.states, set, which, fetcher);
  await remember(env, () => {}); // a scene changes many lights: read again soon
  await audit(env, actor, "scene.run", out.scene);
  return out;
}

export async function plug(env: Env, actor: string, args: { entity: unknown; on: unknown }, fetcher?: Fetch) {
  const [r, set] = await Promise.all([reading(env, undefined, fetcher), settings(env)]);
  const out = await setPlug(env, r.states, set, args, fetcher);
  await remember(env, (ha) => { if (ha[out.entity]) ha[out.entity].s = out.on ? "on" : "off"; });
  await audit(env, actor, out.on ? "plug.on" : "plug.off", out.entity);
  return out;
}

export async function lists(env: Env, who: Viewer, fetcher?: Fetch): Promise<TodoList[]> {
  const [r, set] = await Promise.all([reading(env, undefined, fetcher), settings(env)]);
  return readLists(env, r.states, set, who, fetcher);
}

export async function listAdd(env: Env, who: Viewer, list: unknown, text: unknown, fetcher?: Fetch) {
  const [r, set] = await Promise.all([reading(env, undefined, fetcher), settings(env)]);
  const out = await addItem(env, r.states, set, who, list, text, fetcher);
  await remember(env, () => {});
  return out;
}

export async function listDone(env: Env, who: Viewer, list: unknown, item: unknown, done: unknown, fetcher?: Fetch) {
  const [r, set] = await Promise.all([reading(env, undefined, fetcher), settings(env)]);
  const out = await setDone(env, r.states, set, who, list, item, done, fetcher);
  await remember(env, () => {});
  return out;
}
