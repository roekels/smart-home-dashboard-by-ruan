// Demo mode's energy: a made-up house with solar panels and a battery. The numbers follow the clock, so the page
// looks alive at any time of day, and they are the same for everyone who looks at the same minute.
import type { ApiCtx } from "../../apps/shell/src/modules.ts";
import { HttpError, json } from "../../packages/core/src/util.ts";
import data from "../../demo/data/energy.json" with { type: "json" };
import { demoControls } from "../home-assistant/demo.ts";
import { emptyConfig, localDate, type Device, type Sample } from "./engine.ts";

const MIN = 60_000, STEP = 10 * MIN;

/** Hours since local midnight, for a time zone. */
function hourOf(tz: string, t: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Number(p.hour) + Number(p.minute) / 60;
}

/** A plausible minute: sun between 07:00 and 19:00, a morning and an evening peak, a battery that fills by day. */
export function demoSample(tz: string, t: number): Sample {
  const h = hourOf(tz, t), wobble = Math.sin(t / (7 * MIN)) * 0.06 + Math.sin(t / (23 * MIN)) * 0.04;
  const sun = h > 7 && h < 19 ? Math.sin(((h - 7) / 12) * Math.PI) : 0;
  const solar = Math.round(data.peakSolarW * sun * (1 + wobble));
  const peak = Math.exp(-((h - 7.5) ** 2) / 2) + 1.6 * Math.exp(-((h - 19) ** 2) / 3);
  const home = Math.round(data.baseLoadW + data.peakLoadW * peak * (1 + wobble));
  const level = Math.round(Math.min(100, Math.max(12, 20 + 80 * Math.sin((Math.min(Math.max(h, 7), 21) - 7) / 14 * Math.PI) ** 0.7)));
  const spare = solar - home;
  const battery = spare > 0 ? (level < 98 ? Math.min(spare, data.batteryMaxW) : 0) : level > 15 ? Math.max(spare, -data.batteryMaxW) : 0;
  return { solar, home, battery, level, grid: home + battery - solar };
}

function devices(home: number): Device[] {
  const plugs = demoControls().plugs;
  return data.devices.map((d): Device => {
    const plug = plugs.find((p) => p.entity === d.plug);
    const out: Device = { entity: d.sensor, name: d.name, w: plug && !plug.on ? 0 : Math.round(home * d.share) };
    if (plug) { out.plug = plug.entity; out.on = plug.on; }
    return out;
  }).sort((a, b) => (b.w ?? 0) - (a.w ?? 0));
}

export function demoEnergyNow(tz: string, now = Date.now()) {
  const s = demoSample(tz, now), start = Math.floor((now - 24 * 3600_000) / STEP) * STEP;
  const series = Array.from({ length: 144 }, (_, i) => ({ t: start + i * STEP, ...demoSample(tz, start + i * STEP) }));
  const date = localDate(tz, new Date(now));
  const sum = (from: number, to: number) => {
    const d = { solar: 0, home: 0, imported: 0, exported: 0 };
    for (let t = from; t < to; t += STEP) {
      const x = demoSample(tz, t), h = STEP / 3600_000 / 1000;
      d.solar += (x.solar ?? 0) * h; d.home += (x.home ?? 0) * h; d.imported += Math.max(0, x.grid ?? 0) * h; d.exported += Math.max(0, -(x.grid ?? 0)) * h;
    }
    const r = (v: number) => Math.round(v * 100) / 100;
    return { solar: r(d.solar), home: r(d.home), imported: r(d.imported), exported: r(d.exported) };
  };
  const midnight = now - Math.round(hourOf(tz, now) * 3600_000);
  const list = devices(s.home ?? 0), known = list.reduce((a, d) => a + (d.w ?? 0), 0);
  return {
    configured: true, ts: now, fresh: true, error: null,
    now: { ...s, devices: list, other: Math.max(0, (s.home ?? 0) - known) },
    today: { date, ...sum(midnight, now) },
    yesterday: { date: localDate(tz, new Date(midnight - 12 * 3600_000)), ...sum(midnight - 24 * 3600_000, midnight) },
    series,
  };
}

export async function demoEnergy(c: ApiCtx): Promise<Response | null> {
  const p = c.url.pathname;
  if (p !== "/api/energy" && p !== "/api/energy/setup") return null;
  if (p === "/api/energy" && c.req.method === "GET") return json(demoEnergyNow(c.household.timezone));
  if (!c.person.admin) throw new HttpError(403, "the energy setup is for admins");
  if (c.req.method === "POST") {
    if (!c.write) throw new HttpError(403, "cross-site write refused");
    return json({ ok: true, demo: true });
  }
  const s = demoSample(c.household.timezone, Date.now());
  const cfg = { ...emptyConfig(), ...data.config, devices: data.devices.map((d) => (d.plug ? { sensor: d.sensor, plug: d.plug } : { sensor: d.sensor })) };
  const w: Record<string, number | null> = { [cfg.solar[0]]: s.solar, [cfg.grid!]: s.grid, [cfg.battery!]: s.battery };
  return json({
    error: null,
    sensors: [
      ...data.sensors.map((x) => ({ ...x, w: w[x.entity] ?? null })),
      ...devices(s.home ?? 0).map((d) => ({ entity: d.entity, name: `${d.name} Power`, w: d.w })),
    ],
    levels: data.levels, plugs: demoControls().plugs.map((x) => ({ entity: x.entity, name: x.name })),
    config: cfg, configured: true, suggestion: cfg,
  });
}
