// Demo mode (var DEMO_MODE = "on"): the made-up family from demo/, no sign-in, every answer from the files in
// demo/data. Changes (ticking a list item, adding one) live in memory only and are gone when the Worker restarts.
// Nothing real is read: in demo mode the Worker never looks at the HOUSEHOLD var or at a module's handler.
//
// These answers are also the contract for Today's cards (web/src/today/): a module's real handler returns the
// same shapes.
import { parseHousehold, personById, type Household, type Person } from "../../../packages/core/src/household.ts";
import { HttpError, json } from "../../../packages/core/src/util.ts";
import config from "../../../demo/household.config.json" with { type: "json" };
import calendar from "../../../demo/data/calendar.json" with { type: "json" };
import home from "../../../demo/data/home.json" with { type: "json" };
import lists from "../../../demo/data/lists.json" with { type: "json" };
import health from "../../../demo/data/health.json" with { type: "json" };
import finance from "../../../demo/data/finance.json" with { type: "json" };
import brain from "../../../demo/data/brain.json" with { type: "json" };
import { type DemoFinance, demoFinanceApi } from "../../../modules/finance/src/demo.ts";
import { type DemoHealth, demoHealthApi } from "../../../modules/health/src/demo.ts";
import { type DemoBrain, demoBrainApi } from "../../brain/demo.ts";
import { demoAlfred } from "../../alfred/demo.ts";

export const DEMO_HOUSEHOLD: Household = parseHousehold(config);
const COOKIE = "demo-person";

/** Who the demo is viewed as: the "Viewing as" switch in Settings sets a cookie; default is the first person. */
export function demoPerson(req: Request): Person {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-z0-9-]{1,24})`).exec(req.headers.get("Cookie") ?? "");
  return (m && personById(DEMO_HOUSEHOLD, m[1])) || DEMO_HOUSEHOLD.people[0];
}

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** Today's date in the household's time zone, as YYYY-MM-DD. */
export function today(h: Household, now = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: h.timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

const addDays = (ymd: string, n: number): string => {
  const d = new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

export interface CalendarEvent {
  /** The calendar's name as shown: a person's first name, or the shared calendar's name. */
  calendar: string;
  /** The person id the calendar belongs to, or null for a shared calendar. */
  owner: string | null;
  uid: string; title: string; status: "idea" | "confirmed"; start: string; end: string; all_day: boolean; recurring: boolean; location?: string;
}

export function demoEvents(from: string, to: string, now = new Date()): CalendarEvent[] {
  const t0 = today(DEMO_HOUSEHOLD, now);
  return calendar.events.map((e, i): CalendarEvent => {
    const day = addDays(t0, e.day);
    const idea = /^\(.*\)$/.test(e.title);
    return {
      calendar: e.owner ? personById(DEMO_HOUSEHOLD, e.owner)?.name ?? e.owner : calendar.shared, owner: e.owner ?? null,
      uid: `demo${i}`, title: idea ? e.title.slice(1, -1) : e.title, status: idea ? "idea" : "confirmed",
      start: e.start ? `${day}T${e.start}` : day, end: e.end ? `${day}T${e.end}` : day, all_day: !e.start, recurring: false,
      ...(e.location ? { location: e.location } : {}),
    };
  }).filter((e) => e.start.slice(0, 10) >= from && e.start.slice(0, 10) <= to);
}

interface Item { uid: string; text: string; done: boolean }
const state = {
  lists: lists.lists.map((l) => ({ entity: l.entity, name: l.name, owner: l.owner as string | null, items: l.items.map((text, i): Item => ({ uid: `${l.entity}-${i}`, text, done: false })) })),
  added: 0,
};

function demoLists(p: Person) {
  return state.lists.filter((l) => l.owner === null || l.owner === p.id).map((l) => ({
    entity: l.entity, name: l.name, shared: l.owner === null, open: l.items.filter((i) => !i.done).length, items: l.items,
  }));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Every /api route of demo mode except /api/me and /api/security, which index.ts answers for both modes. */
export async function demoApi(req: Request, url: URL, person: Person, write: boolean): Promise<Response> {
  const p = url.pathname, get = req.method === "GET";
  const alfred = await demoAlfred(req, url, person, write);
  if (alfred) return alfred;
  if (get && p === "/api/calendar") {
    const from = url.searchParams.get("from") ?? "", to = url.searchParams.get("to") ?? "";
    if (!DATE.test(from) || !DATE.test(to)) throw new HttpError(400, "from and to are required, YYYY-MM-DD");
    return json({ events: demoEvents(from, to) });
  }
  if (get && p === "/api/ha") return json({ ts: Date.now(), fresh: true, error: null, ...home, $comment: undefined });
  if (get && p === "/api/lists") return json({ lists: demoLists(person) });
  // the data modules answer from their own made-up records, read-only (modules/<name>/src/demo.ts, apps/brain/demo.ts)
  if (p.startsWith("/api/health/")) return demoHealthApi(req, url, DEMO_HOUSEHOLD, person, health as DemoHealth, today(DEMO_HOUSEHOLD));
  if (p.startsWith("/api/finance/")) return demoFinanceApi(req, url, DEMO_HOUSEHOLD, person, finance as unknown as DemoFinance, today(DEMO_HOUSEHOLD));
  if (p.startsWith("/api/brain/")) return demoBrainApi(req, url, DEMO_HOUSEHOLD, person, brain as DemoBrain, today(DEMO_HOUSEHOLD));
  if (req.method !== "POST" || !write) throw new HttpError(get ? 404 : 403, get ? "not in the demo" : "cross-site or wrong method");

  const body: any = await req.json().catch(() => ({}));
  if (p === "/api/demo/person") {
    const who = personById(DEMO_HOUSEHOLD, String(body.id ?? ""));
    if (!who) throw new HttpError(400, "no such person in the demo");
    return json({ ok: true, person: who.id }, 200, { "set-cookie": `${COOKIE}=${who.id}; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly; Secure` });
  }
  if (p === "/api/ha/scene") {
    if (!home.scenes.some((s) => s.entity === body.scene)) throw new HttpError(400, "no such scene");
    return json({ ok: true });
  }
  if (p === "/api/lists/add" || p === "/api/lists/done") {
    const list = state.lists.find((l) => l.entity === body.list && (l.owner === null || l.owner === person.id));
    if (!list) throw new HttpError(404, "no such list");
    if (p.endsWith("/add")) {
      const text = String(body.text ?? "").trim().slice(0, 200);
      if (!text) throw new HttpError(400, "text is required");
      if (list.items.length >= 50) throw new HttpError(400, "the demo list is full");
      list.items.push({ uid: `${list.entity}-n${++state.added}`, text, done: false });
    } else {
      const item = list.items.find((i) => i.uid === body.item);
      if (!item) throw new HttpError(404, "no such item");
      item.done = body.done === true;
    }
    return json({ ok: true });
  }
  throw new HttpError(404, "not in the demo");
}
