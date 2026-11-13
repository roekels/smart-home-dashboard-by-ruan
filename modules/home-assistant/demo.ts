// Demo mode's Home Assistant: the made-up lights, plugs and scenes from demo/data/home.json, kept in memory so a
// tap on a light stays on until the Worker restarts. Nothing real is reached. The lists are answered by the
// shell's own demo (apps/shell/src/demo.ts).
import type { ApiCtx } from "../../apps/shell/src/modules.ts";
import { HttpError, json } from "../../packages/core/src/util.ts";
import home from "../../demo/data/home.json" with { type: "json" };
import type { Controls, Light, Plug } from "./ha.ts";

const state: Controls = { lights: structuredClone(home.lights) as Light[], plugs: structuredClone(home.plugs) as Plug[], scenes: home.scenes };

export const demoControls = (): Controls & { ts: number; fresh: true; error: null } => ({ ts: Date.now(), fresh: true, error: null, ...state });

export async function demoHome(c: ApiCtx): Promise<Response | null> {
  const p = c.url.pathname;
  if (p !== "/api/ha" && !p.startsWith("/api/ha/")) return null;
  if (c.req.method === "GET" && p === "/api/ha") return json(demoControls());
  if (c.req.method === "GET" && p === "/api/ha/setup") {
    if (!c.person.admin) throw new HttpError(403, "the Home Assistant setup is for admins");
    const named = (l: { entity: string; name: string }[]) => l.map((x) => ({ entity: x.entity, name: x.name }));
    return json({
      configured: { address: true, token: true, serviceToken: true, database: true }, ready: true, reachable: true, error: null, ts: Date.now(),
      counts: { lights: state.lights.length, scenes: state.scenes.length, lists: home.setup.lists.length },
      lists: home.setup.lists.map((l) => ({ entity: l.entity, name: l.name })),
      switches: [...named(state.plugs), ...home.setup.otherSwitches], scripts: home.setup.scripts, lights: named(state.lights),
      people: c.household.people.map((x) => ({ id: x.id, name: x.name })),
      settings: { lists: Object.fromEntries(home.setup.lists.map((l) => [l.entity, l.owner])), plugs: state.plugs.map((x) => x.entity), scripts: [], hiddenLights: [] },
    });
  }
  if (c.req.method !== "POST" || !c.write) throw new HttpError(c.req.method === "GET" ? 404 : 403, c.req.method === "GET" ? "not in the demo" : "cross-site or wrong method");
  const b: any = await c.req.json().catch(() => ({}));
  if (p === "/api/ha/light") {
    const ids: unknown[] = Array.isArray(b.entity) ? b.entity : [b.entity];
    for (const id of ids) {
      const l = state.lights.find((x) => x.entity === id);
      if (!l || l.unavailable) throw new HttpError(400, "no such light");
      l.on = b.on === true;
      if (l.on && Number.isInteger(b.brightness)) l.brightness = Math.min(100, Math.max(1, b.brightness));
      if (l.on && l.brightness === undefined) l.brightness = 80;
    }
    return json({ ok: true });
  }
  if (p === "/api/ha/switch") {
    const s = state.plugs.find((x) => x.entity === b.entity);
    if (!s) throw new HttpError(400, "no such plug");
    s.on = b.on === true;
    return json({ ok: true });
  }
  if (p === "/api/ha/scene") {
    if (!state.scenes.some((s) => s.entity === b.scene)) throw new HttpError(400, "no such scene");
    return json({ ok: true });
  }
  if (p === "/api/ha/setup") return json({ ok: true, demo: true }); // the demo keeps its own choices
  throw new HttpError(404, "not in the demo");
}
