// Home Assistant, straight from the Worker. Home Assistant's Cloudflared add-on tunnels one hostname (var HA_URL)
// out to Cloudflare; an Access application with a Service Auth policy lets nothing through but this Worker's
// service token. Inside, Home Assistant checks its own long-lived token of a dedicated, non-admin user.
//   var     HA_URL
//   secrets HA_API_LONGLIVED_TOKEN, HA_TUNNEL_SERVICE_TOKEN_ID, HA_TUNNEL_SERVICE_TOKEN_KEY
// Nothing in the house listens to the internet, and no entity id is written into this code: what a household has
// is read from Home Assistant, and what it means (whose list, which switch is a plug) is set on the setup page.
import type { Env } from "../../apps/shell/src/env.ts";

export type Fetch = typeof fetch;

/** One entity, compact: state, unit, friendly name, device class, brightness %, a lit lamp's colour (rrggbb). */
export interface HaState { s: string; u?: string; n?: string; dc?: string; b?: number; c?: string }
export type HaMap = Record<string, HaState>;

/** Home Assistant (or the way to it) failed. */
export class HaError extends Error {}
/** The request itself was wrong: an entity that is not there, a value out of range. Nothing was sent. */
export class HaInput extends Error {}

export const haConfigured = (env: Env): boolean =>
  !!(env.HA_URL && env.HA_API_LONGLIVED_TOKEN && env.HA_TUNNEL_SERVICE_TOKEN_ID && env.HA_TUNNEL_SERVICE_TOKEN_KEY);

export async function haFetch(env: Env, method: "GET" | "POST", path: string, body?: unknown, fetcher: Fetch = fetch): Promise<any> {
  if (!haConfigured(env)) throw new HaError("Home Assistant is not set up yet: the tunnel address or one of its three secrets is missing");
  const r = await fetcher(new Request(env.HA_URL!.replace(/\/+$/, "") + path, {
    method, redirect: "manual",
    headers: {
      authorization: `Bearer ${env.HA_API_LONGLIVED_TOKEN}`, "content-type": "application/json", accept: "application/json",
      "CF-Access-Client-Id": env.HA_TUNNEL_SERVICE_TOKEN_ID!, "CF-Access-Client-Secret": env.HA_TUNNEL_SERVICE_TOKEN_KEY!,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  if ((r.status >= 300 && r.status < 400) || (r.headers.get("content-type") ?? "").includes("text/html")) {
    throw new HaError("Cloudflare Access did not let the dashboard through to Home Assistant (the service token is missing, wrong, or not in the tunnel's policy)");
  }
  if (r.status === 401) throw new HaError("Home Assistant refused the token (HA_API_LONGLIVED_TOKEN)");
  if (r.status === 502 || r.status === 530) throw new HaError("the tunnel to Home Assistant is down (is the Cloudflared add-on running?)");
  if (r.status >= 400) throw new HaError(`Home Assistant ${method} ${path}: HTTP ${r.status}`);
  return r.json();
}

/** A lit lamp's light as rrggbb: its colour, or its colour temperature as a colour. Null for a plain dimmer. */
export function lightColor(a: any): string | null {
  let rgb: number[] | null = null;
  const ok = (v: unknown): v is number[] => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => typeof x === "number" && x >= 0 && x <= 255);
  const k = typeof a?.color_temp_kelvin === "number" ? a.color_temp_kelvin : null;
  if (a?.color_mode === "color_temp" && k) rgb = kelvinRgb(k);
  else if (ok(a?.rgb_color)) rgb = a.rgb_color.slice(0, 3);
  else if (k) rgb = kelvinRgb(k);
  return rgb ? rgb.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("") : null;
}

/** Colour temperature to a screen colour (Tanner Helland's fit), 1000 K to 12000 K. */
function kelvinRgb(kelvin: number): number[] {
  const t = Math.min(12000, Math.max(1000, kelvin)) / 100;
  const clamp = (x: number) => Math.min(255, Math.max(0, x));
  const r = t <= 66 ? 255 : clamp(329.698727446 * Math.pow(t - 60, -0.1332047592));
  const g = t <= 66 ? clamp(99.4708025861 * Math.log(t) - 161.1195681661) : clamp(288.1221695283 * Math.pow(t - 60, -0.0755148492));
  const b = t >= 66 ? 255 : t <= 19 ? 0 : clamp(138.5177312231 * Math.log(t - 10) - 305.0447927307);
  return [r, g, b];
}

const KEEP = /^(light|switch|scene|script|todo)\./;
const SENSOR_CLASSES = ["power", "battery", "energy"];
const SENSOR_UNITS = ["W", "kW", "mW"];

/** What the pages and the energy module need, and nothing else: lights, switches, scenes, scripts, to-do lists
 *  (state = open items) and the power, battery and energy sensors. Everything else in Home Assistant is dropped. */
export function compact(states: any[]): { total: number; states: HaMap } {
  const out: HaMap = {};
  for (const st of [...states].sort((a, b) => String(a?.entity_id).localeCompare(String(b?.entity_id)))) {
    const eid = String(st?.entity_id ?? ""), a = st?.attributes ?? {};
    if (eid.startsWith("sensor.")) { if (!SENSOR_CLASSES.includes(a.device_class) && !SENSOR_UNITS.includes(a.unit_of_measurement)) continue; }
    else if (!KEEP.test(eid)) continue;
    const r: HaState = { s: String(st.state).slice(0, 40) };
    if (a.unit_of_measurement) r.u = String(a.unit_of_measurement).slice(0, 8);
    if (a.friendly_name) r.n = String(a.friendly_name).slice(0, 60);
    if (a.device_class) r.dc = String(a.device_class).slice(0, 20);
    if (typeof a.brightness === "number") r.b = Math.round(a.brightness / 2.55);
    if (eid.startsWith("light.") && st.state === "on") { const c = lightColor(a); if (c) r.c = c; }
    out[eid] = r;
  }
  return { total: states.length, states: out };
}

export async function readStates(env: Env, fetcher?: Fetch): Promise<{ total: number; states: HaMap }> {
  const list = await haFetch(env, "GET", "/api/states", undefined, fetcher);
  if (!Array.isArray(list)) throw new HaError("Home Assistant /api/states did not return a list");
  return compact(list);
}

// ---------------------------------------------------------------- what the pages show

/** What the household chose on the setup page (D1 home_kv "ha.settings"). Empty = the safe defaults. */
export interface HaSettings {
  /** todo.* entity -> "shared", a person id, or "hidden". A list that is not named is for admins only. */
  lists: Record<string, string>;
  /** switch.* entities shown (and switchable) as plugs. Every other switch stays out of reach. */
  plugs: string[];
  /** script.* entities that sit with the scenes. Every other script stays out of reach. */
  scripts: string[];
  /** light.* entities kept off the pages (status LEDs and the like). */
  hiddenLights: string[];
}
export const emptySettings = (): HaSettings => ({ lists: {}, plugs: [], scripts: [], hiddenLights: [] });

export interface Light { entity: string; name: string; on: boolean; brightness?: number; color?: string; unavailable?: boolean }
export interface Plug { entity: string; name: string; on: boolean; unavailable?: boolean }
export interface Scene { entity: string; name: string }
export interface Controls { lights: Light[]; plugs: Plug[]; scenes: Scene[] }

const nameOf = (ha: HaMap, e: string): string => (ha[e]?.n || e.slice(e.indexOf(".") + 1).replace(/_/g, " ")).slice(0, 48);

/** Every light that is not hidden, the switches chosen as plugs, the scenes and the chosen scripts. */
export function controls(ha: HaMap, set: HaSettings): Controls {
  const lights = Object.keys(ha).filter((e) => e.startsWith("light.") && !set.hiddenLights.includes(e)).sort().map((e): Light => {
    const s = ha[e], r: Light = { entity: e, name: nameOf(ha, e), on: s.s === "on" };
    if (s.s === "unavailable") r.unavailable = true;
    if (typeof s.b === "number") r.brightness = s.b;
    if (r.on && typeof s.c === "string" && /^[0-9a-f]{6}$/.test(s.c)) r.color = `#${s.c}`;
    return r;
  });
  const plugs = set.plugs.filter((e) => ha[e]).map((e): Plug => {
    const s = ha[e], r: Plug = { entity: e, name: nameOf(ha, e), on: s.s === "on" };
    if (s.s !== "on" && s.s !== "off") r.unavailable = true;
    return r;
  });
  const scenes = [...Object.keys(ha).filter((e) => e.startsWith("scene.")).sort(), ...set.scripts.filter((e) => ha[e])]
    .map((e): Scene => ({ entity: e, name: nameOf(ha, e) }));
  return { lights, plugs, scenes };
}

// ---------------------------------------------------------------- the three things the dashboard may do

const ENTITY = /^[a-z_]+\.[a-z0-9_]{1,100}$/;

function entity(v: unknown, domain: string, ha: HaMap): string {
  const e = String(v ?? "");
  if (!ENTITY.test(e) || !e.startsWith(domain + ".")) throw new HaInput(`entity must be a ${domain}.* id`);
  if (!ha[e]) throw new HaInput(`${e} is not in Home Assistant`);
  return e;
}

export interface LightArgs { entity: unknown; on: unknown; brightness?: unknown; kelvin?: unknown }

/** One light, or a list of them ("all the kitchen lights"): Home Assistant switches a list in one call. */
export async function setLight(env: Env, ha: HaMap, set: HaSettings, args: LightArgs, fetcher?: Fetch): Promise<{ ok: true; entity: string[]; on: boolean; brightness?: number }> {
  const raw = Array.isArray(args?.entity) ? args.entity : [args?.entity];
  if (raw.length < 1 || raw.length > 60) throw new HaInput("entity list must have 1..60 lights");
  const list = [...new Set(raw.map((x) => entity(x, "light", ha)))];
  for (const e of list) if (set.hiddenLights.includes(e)) throw new HaInput(`${e} is hidden on this dashboard`);
  if (typeof args?.on !== "boolean") throw new HaInput("on must be true or false");
  const data: Record<string, unknown> = { entity_id: list };
  let brightness: number | undefined;
  if (args.on && args.brightness != null) {
    const b = args.brightness;
    if (typeof b !== "number" || !Number.isInteger(b) || b < 1 || b > 100) throw new HaInput("brightness must be a whole number 1..100");
    data.brightness_pct = brightness = b;
  }
  if (args.on && args.kelvin != null) {
    const k = args.kelvin;
    if (typeof k !== "number" || !Number.isInteger(k) || k < 2000 || k > 6500) throw new HaInput("kelvin must be a whole number 2000..6500");
    data.color_temp_kelvin = k;
  }
  await haFetch(env, "POST", `/api/services/light/${args.on ? "turn_on" : "turn_off"}`, data, fetcher);
  return { ok: true, entity: list, on: args.on, ...(brightness ? { brightness } : {}) };
}

/** A scene, or one of the scripts the household put with the scenes. No other script can be started from here. */
export async function runScene(env: Env, ha: HaMap, set: HaSettings, scene: unknown, fetcher?: Fetch): Promise<{ ok: true; scene: string }> {
  const isScript = set.scripts.includes(String(scene ?? ""));
  const e = entity(scene, isScript ? "script" : "scene", ha);
  await haFetch(env, "POST", `/api/services/${isScript ? "script" : "scene"}/turn_on`, { entity_id: e }, fetcher);
  return { ok: true, scene: e };
}

/** A plug: only a switch the household chose as a plug, so child locks and other config switches stay out of reach. */
export async function setPlug(env: Env, ha: HaMap, set: HaSettings, args: { entity: unknown; on: unknown }, fetcher?: Fetch): Promise<{ ok: true; entity: string; on: boolean }> {
  const e = entity(args?.entity, "switch", ha);
  if (!set.plugs.includes(e)) throw new HaInput(`${e} is not one of the plugs chosen on the Home Assistant setup page`);
  if (typeof args?.on !== "boolean") throw new HaInput("on must be true or false");
  await haFetch(env, "POST", `/api/services/switch/${args.on ? "turn_on" : "turn_off"}`, { entity_id: e }, fetcher);
  return { ok: true, entity: e, on: args.on };
}
