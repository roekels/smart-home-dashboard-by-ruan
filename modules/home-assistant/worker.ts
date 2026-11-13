// The Home Assistant module, as the shell sees it: its pages, its API and its part of the Security page.
//   GET  /api/ha                 lights, plugs, scenes                       everyone
//   POST /api/ha/light           { entity | [entities], on, brightness?, kelvin? }
//   POST /api/ha/scene           { scene }
//   POST /api/ha/switch          { entity, on }: only a switch chosen as a plug
//   GET  /api/ha/setup           the connection check and everything to choose from     admins
//   POST /api/ha/setup           { lists, plugs, scripts, hiddenLights }                admins
//   GET  /api/lists, POST /api/lists/add { list, text }, POST /api/lists/done { list, item, done }
import type { ApiCtx, ShellModule } from "../../apps/shell/src/modules.ts";
import { resourceName, type Household } from "../../packages/core/src/household.ts";
import { HttpError, json } from "../../packages/core/src/util.ts";
import { HaError, HaInput, haConfigured } from "./ha.ts";
import { knownLists, listErrorStatus, type Viewer } from "./lists.ts";
import { homeControls, light, listAdd, listDone, lists, plug, scene } from "./service.ts";
import { audit, cleanSettings, kvPut, reading, settings } from "./store.ts";
import { demoHome } from "./demo.ts";

/** Home Assistant's failures become a 502 with a plain reason, a wrong request a 400. Nothing else is caught. */
export async function haCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof HaInput) throw new HttpError(400, e.message);
    if (e instanceof HaError) throw new HttpError(502, e.message);
    const st = listErrorStatus(e);
    if (st) throw new HttpError(st, (e as Error).message);
    throw e;
  }
}

const body = async (c: ApiCtx): Promise<any> => {
  if (c.req.method !== "POST" || !c.write) throw new HttpError(c.req.method === "POST" ? 403 : 405, "cross-site or wrong method");
  return c.req.json().catch(() => ({}));
};

/** What a person is to the lists. The wall tablet is not a person: it only gets the shared lists. */
export const viewer = (c: ApiCtx): Viewer => (c.household.people.some((p) => p.id === c.person.id) ? c.person : "shared-only");

async function setup(c: ApiCtx): Promise<Response> {
  if (!c.person.admin) throw new HttpError(403, "the Home Assistant setup is for admins");
  if (c.req.method === "GET") {
    const [r, set] = await Promise.all([reading(c.env, 0), settings(c.env)]);
    const named = (prefix: string) => Object.keys(r.states).filter((e) => e.startsWith(prefix)).sort()
      .map((e) => ({ entity: e, name: r.states[e].n || e.slice(prefix.length).replace(/_/g, " ") }));
    return json({
      // which parts are in place, never their values
      configured: { address: !!c.env.HA_URL, token: !!c.env.HA_API_LONGLIVED_TOKEN, serviceToken: !!(c.env.HA_TUNNEL_SERVICE_TOKEN_ID && c.env.HA_TUNNEL_SERVICE_TOKEN_KEY), database: !!c.env.HOME_DB },
      ready: haConfigured(c.env), reachable: r.fresh && !r.error, error: r.error, ts: r.ts,
      counts: { lights: named("light.").length, scenes: named("scene.").length, lists: Object.keys(knownLists(r.states)).length },
      lists: Object.entries(knownLists(r.states)).map(([entity, v]) => ({ entity, name: v.name })),
      switches: named("switch."), scripts: named("script."), lights: named("light."),
      people: c.household.people.map((p) => ({ id: p.id, name: p.name })),
      settings: set,
    });
  }
  const set = cleanSettings(await body(c), c.household);
  await kvPut(c.env, "ha.settings", set);
  await audit(c.env, c.person.id, "ha.settings", undefined, { lists: Object.keys(set.lists).length, plugs: set.plugs.length, scripts: set.scripts.length, hiddenLights: set.hiddenLights.length });
  return json({ ok: true, settings: set });
}

async function ha(c: ApiCtx): Promise<Response> {
  const rest = c.url.pathname.slice("/api/ha".length);
  if (rest === "/setup") return setup(c);
  if (rest === "" && c.req.method === "GET") return json(await homeControls(c.env));
  const b = await body(c);
  if (rest === "/light") return json(await haCall(() => light(c.env, c.person.id, b)));
  if (rest === "/scene") return json(await haCall(() => scene(c.env, c.person.id, b.scene)));
  if (rest === "/switch") return json(await haCall(() => plug(c.env, c.person.id, b)));
  throw new HttpError(404, "not found");
}

async function listsApi(c: ApiCtx): Promise<Response> {
  const rest = c.url.pathname.slice("/api/lists".length), who = viewer(c);
  if (rest === "" && c.req.method === "GET") return json({ lists: await haCall(() => lists(c.env, who)) });
  const b = await body(c);
  if (rest === "/add") return json(await haCall(() => listAdd(c.env, who, b.list, b.text)));
  if (rest === "/done") return json(await haCall(() => listDone(c.env, who, b.list, b.item, b.done)));
  throw new HttpError(404, "not found");
}

export const homeAssistant: ShellModule = {
  id: "homeAssistant",
  pages: [
    { path: "/home/controls", label: "Lights", icon: "bulb", where: "home" },
    { path: "/dashboard/home-assistant", label: "Home Assistant", icon: "home", where: "manage", text: "Check the connection, say whose list is whose and which switches are plugs." },
  ],
  api: { ha, lists: listsApi },
  demo: demoHome,
  security: (h: Household) => ({
    nodes: [
      { id: "ha-tunnel", zone: "edge", name: "Access · Home Assistant tunnel", sub: "service token only", icon: "lock", status: "ok",
        text: "The one hostname that leads into the house. No person can sign in here and no browser can open it.",
        guard: ["An Access policy of type Service Auth: only the dashboard's own service token passes", "Home Assistant then checks its own token as well"],
        keys: ["HA_TUNNEL_SERVICE_TOKEN_ID", "HA_TUNNEL_SERVICE_TOKEN_KEY"] },
      { id: "home-db", zone: "cf", name: resourceName(h, "home"), sub: "D1 database", icon: "db", status: "ok",
        text: "The newest reading of lights, switches, scenes and lists, your choices from the setup page, and an audit line per change. No list item's text is stored." },
      { id: "ha", zone: "home", name: "Home Assistant", sub: "Cloudflared add-on", icon: "home", status: "ok",
        text: "Calls out to Cloudflare through its own tunnel. Nothing on your router is opened.",
        guard: ["A dedicated Home Assistant user that is not an administrator", "The dashboard can only switch lights, run scenes and the scripts you chose, switch the plugs you chose, and read and tick off lists"],
        keys: ["HA_API_LONGLIVED_TOKEN"] },
    ],
    links: [
      { from: "shell", to: "home-db", kind: "service", label: "binding HOME_DB" },
      { from: "shell", to: "ha-tunnel", kind: "service", label: "service token + Home Assistant token" },
      { from: "ha-tunnel", to: "ha", kind: "tunnel", label: "Cloudflared tunnel, outbound from home" },
    ],
    signIns: [
      { where: "Home Assistant, from the dashboard", who: `${resourceName(h, "shell")} only`, how: "Access service token, then a Home Assistant long-lived token", status: "ok", note: "Home Assistant's own sign-in page stays inside your home network." },
    ],
  }),
};
