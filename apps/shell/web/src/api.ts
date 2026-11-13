// The dashboard Worker's API, and who is signed in. Every call goes to /api on the page's own origin.
import { setLanguage, t } from "./i18n.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Changes carry the dashboard's own header: the Worker refuses a write without it (cross-site protection). */
export async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "X-Dashboard": "1" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`/api${path}`, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, (data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data as T;
}

export interface NavItem { path: string; label: string; icon: string }
export interface ManageItem extends NavItem { text: string }
export interface Me {
  person: { id: string; name: string; admin: boolean; n: number };
  household: string;
  language: string;
  timezone: string;
  people: { id: string; name: string; n: number }[];
  modules: string[];
  nav: { group: string; items: NavItem[] }[];
  manage: ManageItem[];
  demo: boolean;
  /** True on a paired wall tablet (the kiosk host): one page, no menus, no person. */
  kiosk?: boolean;
}

/** Who is signed in and what they may open (GET /api/me), filled once before the first paint.
 *  `admin` and the menus only decide what is shown; the Worker checks every request on its own. */
export const who: Me = {
  person: { id: "", name: "", admin: false, n: 1 }, household: "", language: "en", timezone: "UTC",
  people: [], modules: [], nav: [], manage: [], demo: false,
};

export async function loadWho(): Promise<void> {
  Object.assign(who, await call<Me>("GET", "/me"));
  setLanguage(who.language);
}

export const hasModule = (id: string): boolean => who.modules.includes(id);

/** The person's number (1–6) for a person id, for their colour; 0 for a shared thing. */
export const whoNumber = (personId: string | null | undefined): number => who.people.find((p) => p.id === personId)?.n ?? 0;

// ---- the shapes Today's cards read. A module's handler returns these; demo mode serves them from demo/data.

/** status "idea" = planned but not fixed. owner = a person id, or null for a shared calendar. */
export interface CalendarEvent { calendar: string; owner: string | null; uid: string; title: string; status: "idea" | "confirmed"; start: string; end: string; all_day: boolean; recurring: boolean; location?: string }
export interface HomeLight { entity: string; name: string; on: boolean; brightness?: number; color?: string; unavailable?: boolean }
export interface HomeScene { entity: string; name: string }
export interface HomeControls { ts: number | null; fresh: boolean; error: string | null; lights: HomeLight[]; plugs: { entity: string; name: string; on: boolean; unavailable?: boolean }[]; scenes: HomeScene[] }
export interface TodoItem { uid: string; text: string; done: boolean; due?: string }
export interface TodoList { entity: string; name: string; shared: boolean; open: number; items: TodoItem[] }
export interface HealthMine {
  person: string | null;
  vaccinations_due: { id: string; for: string; due: string; overdue: boolean }[];
  current_meds: { id: string; name: string; dose: string | null; schedule: string | null }[];
  follow_ups: { id: string; date: string; what: string; follow_up: string }[];
}

export interface EnergyDevice { entity: string; name: string; w: number | null; plug?: string; on?: boolean }
export interface EnergySample { solar: number | null; home: number | null; grid: number | null; battery: number | null; level: number | null }
export interface EnergyDay { date: string; solar: number; home: number; imported: number; exported: number }
/** Watts now (grid: + buying, - feeding in; battery: + charging), kWh for the days, 10-minute averages for the chart. */
export interface EnergyNow {
  configured: boolean; ts: number | null; fresh: boolean; error: string | null;
  now: EnergySample & { devices: EnergyDevice[]; other: number | null };
  today: EnergyDay | null; yesterday: EnergyDay | null;
  series: ({ t: number } & EnergySample)[];
}

export const api = {
  calendar: (from: string, to: string) => call<{ events: CalendarEvent[] }>("GET", `/calendar?from=${from}&to=${to}`),
  home: () => call<HomeControls>("GET", "/ha"),
  runScene: (scene: string) => call<{ ok: boolean }>("POST", "/ha/scene", { scene }),
  setLight: (entity: string | string[], on: boolean, brightness?: number) => call<{ ok: boolean }>("POST", "/ha/light", brightness === undefined ? { entity, on } : { entity, on, brightness }),
  setPlug: (entity: string, on: boolean) => call<{ ok: boolean }>("POST", "/ha/switch", { entity, on }),
  energy: () => call<EnergyNow>("GET", "/energy"),
  lists: () => call<{ lists: TodoList[] }>("GET", "/lists"),
  addListItem: (list: string, text: string) => call<{ ok: boolean }>("POST", "/lists/add", { list, text }),
  setListItem: (list: string, item: string, done: boolean) => call<{ ok: boolean }>("POST", "/lists/done", { list, item, done }),
  healthMine: () => call<HealthMine>("GET", "/health/mine"),
};

export function ago(ms: number | null): string {
  if (!ms) return t("never");
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return t("{n}s ago", { n: s });
  if (s < 3600) return t("{n}m ago", { n: Math.round(s / 60) });
  if (s < 86400) return t("{n}h ago", { n: Math.round(s / 3600) });
  return t("{n}d ago", { n: Math.round(s / 86400) });
}
