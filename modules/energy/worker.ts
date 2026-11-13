// The Energy module: a page of what the house makes, uses, stores and buys, from Home Assistant sensors only.
//   GET  /api/energy          now, today's totals and the last 24 hours            everyone (and the wall tablet)
//   GET  /api/energy/setup    the sensors to choose from, the saved choice, a guess   admins
//   POST /api/energy/setup    { solar, grid, gridInverted, battery, batteryInverted, batteryLevel, home, devices }
// Once a minute (the shell's cron, added by setup/modules/energy.json) it stores one sample and adds it to today's
// totals. Samples older than 48 hours are deleted. Needs the Home Assistant module.
import type { Env } from "../../apps/shell/src/env.ts";
import type { ApiCtx, ShellModule } from "../../apps/shell/src/modules.ts";
import type { Household } from "../../packages/core/src/household.ts";
import { HttpError, json } from "../../packages/core/src/util.ts";
import type { Fetch } from "../home-assistant/ha.ts";
import { audit, db, kvGet, kvPut, reading, settings } from "../home-assistant/store.ts";
import {
  addToDay, buckets, cleanConfig, emptyConfig, emptyDay, isConfigured, isLevelSensor, isPowerSensor, localDate, picture, sampleOf, suggest, watts,
  type Day, type EnergyConfig, type Sample,
} from "./engine.ts";
import { demoEnergy } from "./demo.ts";

const MIN = 60_000, KEEP_MS = 48 * 3600_000, CHART_MS = 24 * 3600_000, STEP_MS = 10 * MIN;

export const config = async (env: Env): Promise<EnergyConfig> => ({ ...emptyConfig(), ...((await kvGet<Partial<EnergyConfig>>(env, "energy.config"))?.data ?? {}) });

interface Days { today: Day; yesterday: Day | null; last: number }

/** One minute's work: read, store a sample, add it to today. Returns what it did, for the log. */
export async function tick(env: Env, h: Household, now: Date, fetcher?: Fetch): Promise<string> {
  const cfg = await config(env);
  if (!isConfigured(cfg)) return "no sensors chosen yet";
  const r = await reading(env, 50_000, fetcher, now.getTime());
  if (!r.fresh || r.ts === null) return `no fresh reading: ${r.error ?? "unknown"}`;
  const s = sampleOf(picture(r.states, cfg));
  const ts = Math.floor(now.getTime() / MIN) * MIN, date = localDate(h.timezone, now);
  const stored = (await kvGet<Days>(env, "energy.day"))?.data ?? null;
  let days: Days = stored ?? { today: emptyDay(date), yesterday: null, last: 0 };
  if (days.today.date !== date) days = { today: emptyDay(date), yesterday: days.today, last: days.last };
  days = { ...days, today: addToDay(days.today, s, days.last ? (ts - days.last) / MIN : 1), last: ts };
  const stmts = [
    db(env).prepare("INSERT OR REPLACE INTO energy_samples (ts, data) VALUES (?, ?)").bind(ts, JSON.stringify(s)),
    db(env).prepare("INSERT INTO home_kv (key, data, at) VALUES ('energy.day', ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, at = excluded.at").bind(JSON.stringify(days), ts),
  ];
  if (now.getUTCMinutes() % 15 === 0) stmts.push(db(env).prepare("DELETE FROM energy_samples WHERE ts < ?").bind(ts - KEEP_MS));
  await db(env).batch(stmts);
  return "sampled";
}

const kwh = (d: Day | null) => (d ? { date: d.date, solar: round(d.solar), home: round(d.home), imported: round(d.imported), exported: round(d.exported) } : null);
const round = (wh: number) => Math.round(wh / 10) / 100; // kWh, two decimals

/** What the page and the wall tablet read. Also what /home/mcp's home_status reports as `energy`. */
export async function energyNow(env: Env, now = Date.now()) {
  const [cfg, r, days, rows] = await Promise.all([
    config(env), reading(env), kvGet<Days>(env, "energy.day"),
    db(env).prepare("SELECT ts, data FROM energy_samples WHERE ts >= ? ORDER BY ts").bind(now - CHART_MS).all<{ ts: number; data: string }>(),
  ]);
  return {
    configured: isConfigured(cfg), ts: r.ts, fresh: r.fresh, error: r.error,
    now: picture(r.states, cfg),
    today: kwh(days?.data.today ?? null), yesterday: kwh(days?.data.yesterday ?? null),
    series: buckets((rows.results ?? []).map((x) => ({ ts: x.ts, s: JSON.parse(x.data) as Sample })), STEP_MS),
  };
}

async function setup(c: ApiCtx): Promise<Response> {
  if (!c.person.admin) throw new HttpError(403, "the energy setup is for admins");
  if (c.req.method === "GET") {
    const [r, cfg, set] = await Promise.all([reading(c.env, 0), config(c.env), settings(c.env)]);
    const ha = r.states, name = (e: string) => ha[e].n || e.slice(e.indexOf(".") + 1).replace(/_/g, " ");
    return json({
      error: r.error,
      sensors: Object.keys(ha).filter((e) => isPowerSensor(ha, e)).sort().map((e) => ({ entity: e, name: name(e), w: watts(ha, e) })),
      levels: Object.keys(ha).filter((e) => isLevelSensor(ha, e)).sort().map((e) => ({ entity: e, name: name(e) })),
      // only switches the household already chose as plugs can be paired with a device
      plugs: set.plugs.filter((e) => ha[e]).map((e) => ({ entity: e, name: name(e) })),
      config: cfg, configured: isConfigured(cfg), suggestion: suggest(ha),
    });
  }
  if (c.req.method !== "POST" || !c.write) throw new HttpError(403, "cross-site or wrong method");
  let cfg: EnergyConfig;
  try { cfg = cleanConfig(await c.req.json().catch(() => ({}))); } catch (e) { throw new HttpError(400, (e as Error).message); }
  const plugs = new Set((await settings(c.env)).plugs);
  for (const d of cfg.devices) if (d.plug && !plugs.has(d.plug)) throw new HttpError(400, `${d.plug} is not one of the plugs chosen on the Home Assistant setup page`);
  await kvPut(c.env, "energy.config", cfg);
  await audit(c.env, c.person.id, "energy.config", undefined, { solar: cfg.solar.length, devices: cfg.devices.length });
  return json({ ok: true, config: cfg });
}

async function api(c: ApiCtx): Promise<Response> {
  const rest = c.url.pathname.slice("/api/energy".length);
  if (rest === "/setup") return setup(c);
  if (rest === "" && c.req.method === "GET") return json(await energyNow(c.env));
  throw new HttpError(404, "not found");
}

export const energy: ShellModule = {
  id: "energy",
  pages: [
    { path: "/home/energy", label: "Energy", icon: "bolt", where: "home" },
    { path: "/dashboard/energy-setup", label: "Energy sensors", icon: "sunpanel", where: "manage", text: "Say which Home Assistant sensor is solar, grid, battery, and which are devices." },
  ],
  api: { energy: api },
  demo: demoEnergy,
  cron: "* * * * *",
  scheduled: async (env, h, now) => { const did = await tick(env, h, now); if (did !== "sampled") console.log(`energy: ${did}`); },
};
