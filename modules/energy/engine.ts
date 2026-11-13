// The energy picture, worked out from Home Assistant sensors and nothing else: no vendor cloud, no extra polling.
// Pure functions over plain data. The household says on the setup page which sensor is what (EnergyConfig);
// suggest() makes a first guess from the sensors' names so most people only confirm it.
import type { HaMap } from "../home-assistant/ha.ts";

export interface EnergyConfig {
  /** Power sensors of the solar panels, added together. */
  solar: string[];
  /** Power sensor at the grid connection. Positive = taking from the grid, unless gridInverted. */
  grid: string | null;
  gridInverted: boolean;
  /** Power sensor of the battery. Positive = charging, unless batteryInverted. */
  battery: string | null;
  batteryInverted: boolean;
  /** The battery's charge in percent. */
  batteryLevel: string | null;
  /** Power sensor of the whole house. Leave empty to work it out: solar + grid - battery charging. */
  home: string | null;
  /** Power sensors of single devices, each with the plug that switches it (if any). */
  devices: { sensor: string; plug?: string }[];
}

export const emptyConfig = (): EnergyConfig => ({ solar: [], grid: null, gridInverted: false, battery: null, batteryInverted: false, batteryLevel: null, home: null, devices: [] });

export const isConfigured = (c: EnergyConfig): boolean => !!(c.solar.length || c.grid || c.battery || c.home || c.devices.length);

const FACTOR: Record<string, number> = { W: 1, kW: 1000, mW: 0.001 };

/** A power sensor's reading in watts, or null when it has none (unavailable, unknown, not a power unit). */
export function watts(ha: HaMap, entity: string | null | undefined): number | null {
  const s = entity ? ha[entity] : undefined;
  if (!s) return null;
  const v = Number(s.s), f = FACTOR[s.u ?? "W"];
  return s.s !== "" && Number.isFinite(v) && f ? Math.round(v * f) : null;
}

export const isPowerSensor = (ha: HaMap, e: string): boolean => e.startsWith("sensor.") && (ha[e]?.dc === "power" || (ha[e]?.u ?? "") in FACTOR);
export const isLevelSensor = (ha: HaMap, e: string): boolean => e.startsWith("sensor.") && ha[e]?.dc === "battery" && ha[e]?.u === "%";

export interface Device { entity: string; name: string; w: number | null; plug?: string; on?: boolean }
export interface Picture {
  /** Watts. null = no sensor, or the sensor has no reading. */
  solar: number | null;
  /** Positive = from the grid, negative = feeding in. */
  grid: number | null;
  /** Positive = charging, negative = discharging. */
  battery: number | null;
  /** Percent. */
  level: number | null;
  home: number | null;
  devices: Device[];
  /** The part of the house's draw that no device sensor explains. */
  other: number | null;
}

const nameOf = (ha: HaMap, e: string): string => (ha[e]?.n || e.slice(e.indexOf(".") + 1).replace(/_/g, " ")).replace(/\s+(power|leistung)$/i, "").slice(0, 48);

export function picture(ha: HaMap, c: EnergyConfig): Picture {
  const parts = c.solar.map((e) => watts(ha, e)).filter((v): v is number => v !== null);
  const solar = c.solar.length && parts.length ? Math.max(0, parts.reduce((a, b) => a + b, 0)) : null;
  const sign = (v: number | null, inverted: boolean) => (v === null ? null : inverted ? -v : v);
  const grid = sign(watts(ha, c.grid), c.gridInverted);
  const battery = sign(watts(ha, c.battery), c.batteryInverted);
  const lv = c.batteryLevel ? Number(ha[c.batteryLevel]?.s) : NaN;
  const level = Number.isFinite(lv) && lv >= 0 && lv <= 100 ? Math.round(lv) : null;
  let home = watts(ha, c.home);
  if (home === null && !c.home && (solar !== null || grid !== null)) home = Math.max(0, (solar ?? 0) + (grid ?? 0) - (battery ?? 0));
  const devices = c.devices.filter((d) => ha[d.sensor]).map((d): Device => {
    const out: Device = { entity: d.sensor, name: nameOf(ha, d.sensor), w: watts(ha, d.sensor) };
    if (d.plug && ha[d.plug]) { out.plug = d.plug; out.on = ha[d.plug].s === "on"; }
    return out;
  }).sort((a, b) => (b.w ?? -1) - (a.w ?? -1));
  const known = devices.reduce((a, d) => a + Math.max(0, d.w ?? 0), 0);
  return { solar, grid, battery, level, home, devices, other: home === null || !devices.length ? null : Math.max(0, home - known) };
}

/** One stored sample: the picture without the device list. */
export interface Sample { solar: number | null; home: number | null; grid: number | null; battery: number | null; level: number | null }
export const sampleOf = (p: Picture): Sample => ({ solar: p.solar, home: p.home, grid: p.grid, battery: p.battery, level: p.level });

/** Today's totals in watt-hours, built up one minute at a time. */
export interface Day { date: string; solar: number; home: number; imported: number; exported: number; minutes: number }
export const emptyDay = (date: string): Day => ({ date, solar: 0, home: 0, imported: 0, exported: 0, minutes: 0 });

/** Adds `minutes` at the sample's power to the day. A gap longer than 10 minutes counts as 1 (we do not know). */
export function addToDay(day: Day, s: Sample, minutes: number): Day {
  const m = minutes > 10 || minutes <= 0 ? 1 : minutes, h = m / 60;
  return {
    date: day.date, minutes: day.minutes + m,
    solar: day.solar + Math.max(0, s.solar ?? 0) * h,
    home: day.home + Math.max(0, s.home ?? 0) * h,
    imported: day.imported + Math.max(0, s.grid ?? 0) * h,
    exported: day.exported + Math.max(0, -(s.grid ?? 0)) * h,
  };
}

/** YYYY-MM-DD in a time zone. */
export function localDate(tz: string, now: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Averages minute samples into buckets of `step` ms, for the chart. Empty buckets are left out. */
export function buckets(rows: { ts: number; s: Sample }[], step: number): ({ t: number } & Sample)[] {
  const by = new Map<number, { ts: number; s: Sample }[]>();
  for (const r of rows) { const k = Math.floor(r.ts / step) * step; (by.get(k) ?? by.set(k, []).get(k)!).push(r); }
  const avg = (list: { s: Sample }[], k: keyof Sample): number | null => {
    const v = list.map((x) => x.s[k]).filter((x): x is number => x !== null);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, list]) => ({ t, solar: avg(list, "solar"), home: avg(list, "home"), grid: avg(list, "grid"), battery: avg(list, "battery"), level: avg(list, "level") }));
}

// ---------------------------------------------------------------- setup

const WORDS = {
  solar: /\b(solar|pv|photovolt|panel|inverter)/i,
  grid: /\b(grid|mains|meter|import|net(z)?)\b/i,
  battery: /\b(battery|batterie|akku|storage)/i,
  home: /\b(house|home|household|load|consumption|verbrauch)\b/i,
};

/** A first guess from the sensors' names. The household confirms or changes it; nothing is saved by guessing. */
export function suggest(ha: HaMap): EnergyConfig {
  const power = Object.keys(ha).filter((e) => isPowerSensor(ha, e)).sort();
  const label = (e: string) => `${e} ${ha[e].n ?? ""}`.replace(/_/g, " ");
  const first = (re: RegExp, not: RegExp[] = []) => power.find((e) => re.test(label(e)) && !not.some((n) => n.test(label(e)))) ?? null;
  const solar = power.filter((e) => WORDS.solar.test(label(e)) && !WORDS.battery.test(label(e)) && !WORDS.grid.test(label(e))).slice(0, 4);
  const battery = first(WORDS.battery), grid = first(WORDS.grid, [WORDS.battery, WORDS.solar]);
  const home = first(WORDS.home, [WORDS.battery, WORDS.solar, WORDS.grid]);
  const taken = new Set([...solar, battery, grid, home].filter(Boolean) as string[]);
  const level = Object.keys(ha).filter((e) => isLevelSensor(ha, e) && WORDS.battery.test(label(e)) || (isLevelSensor(ha, e) && /\b(soc|charge)\b/i.test(label(e)))).sort()[0] ?? null;
  return { ...emptyConfig(), solar, grid, battery, batteryLevel: level, home, devices: power.filter((e) => !taken.has(e)).slice(0, 40).map((sensor) => ({ sensor })) };
}

const SENSOR = /^sensor\.[a-z0-9_]{1,100}$/, SWITCH = /^switch\.[a-z0-9_]{1,100}$/;

/** Cleans what the setup page sends. Throws a plain Error naming the first thing that is wrong. */
export function cleanConfig(raw: any): EnergyConfig {
  const one = (v: unknown, what: string): string | null => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v !== "string" || !SENSOR.test(v)) throw new Error(`${what} must be a sensor.* id`);
    return v;
  };
  const solar = Array.isArray(raw?.solar) ? [...new Set(raw.solar.map((v: unknown) => one(v, "solar")).filter(Boolean))] as string[] : [];
  if (solar.length > 8) throw new Error("at most 8 solar sensors");
  const devices: EnergyConfig["devices"] = [];
  const seen = new Set<string>();
  for (const d of Array.isArray(raw?.devices) ? raw.devices : []) {
    const sensor = one(d?.sensor, "a device's sensor");
    if (!sensor || seen.has(sensor)) continue;
    seen.add(sensor);
    if (d.plug !== undefined && d.plug !== null && d.plug !== "" && (typeof d.plug !== "string" || !SWITCH.test(d.plug))) throw new Error("a device's plug must be a switch.* id");
    devices.push(d.plug ? { sensor, plug: d.plug } : { sensor });
  }
  if (devices.length > 60) throw new Error("at most 60 devices");
  return {
    solar, grid: one(raw?.grid, "grid"), gridInverted: raw?.gridInverted === true,
    battery: one(raw?.battery, "battery"), batteryInverted: raw?.batteryInverted === true,
    batteryLevel: one(raw?.batteryLevel, "batteryLevel"), home: one(raw?.home, "home"), devices,
  };
}
