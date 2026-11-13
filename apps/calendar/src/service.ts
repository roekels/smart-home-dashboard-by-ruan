// What the calendar Worker does for its two callers, as plain functions (index.ts wraps them in the entrypoints;
// tests call them here with a stand-in for iCloud).
//   calendarService  the gateway's /calendar/mcp. Every call is held to the caller's scopes, per calendar.
//   calendarUi       the dashboard's pages. Read only, no notes: the shell has already checked who is signed in.
// Event text comes from other people (invitations): it is data, and it is never logged.
import { type Household, householdFromVar } from "../../../packages/core/src/household.ts";
import { type Dav, Refused, addDays, addEvent, directory, getEvent, listEvents, localIso, localMidnight, removeEvent, stripBrackets, updateEvent } from "./caldav.ts";
import { CALENDAR_CONTRACT, CALENDAR_UI_CONTRACT, type CalOp, type CalendarApi, type CalendarInfo, type CalendarPrincipal, type CalendarUiApi } from "./contract.ts";

export interface CalendarEnv {
  HOUSEHOLD: string;
  /** Secret: the Apple ID whose calendars are shown. */
  CALENDAR_ICLOUD_USER_ID?: string;
  /** Secret: an app-specific password for that Apple ID. Never the Apple ID's main password. */
  CALENDAR_ICLOUD_APP_PASSWORD?: string;
  /** Var: the name of the calendar everyone shares. Default "Family". */
  CALENDAR_SHARED_NAME?: string;
}

export const SHARED = "shared";
export const OPS: Record<CalOp, string> = { read: "see events", add: "add new events", update: "change and confirm events", remove: "remove events" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE = 400 * 864e5;

/** The calendars a household has: one per person (id = the person id, named like their first name) and a shared one. */
export const wantedCalendars = (h: Household, sharedName = "Family") => [
  ...h.people.map((p) => ({ id: p.id, name: p.name, owner: p.id as string | null })),
  { id: SHARED, name: sharedName || "Family", owner: null },
];

export function davOf(env: CalendarEnv, h: Household, fetcher: typeof fetch = fetch): Dav {
  return { user: env.CALENDAR_ICLOUD_USER_ID, password: env.CALENDAR_ICLOUD_APP_PASSWORD, wanted: wantedCalendars(h, env.CALENDAR_SHARED_NAME), timezone: h.timezone, fetcher };
}

const scope = (calendar: string, op: CalOp) => `cal.${calendar}.${op}`;

/** Errors cross the binding as plain messages. Only our own refusals keep their text; anything else is generic. */
async function run<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof Refused) throw new Error(e.message);
    throw new Error("The calendar could not be reached. Try again in a moment.");
  }
}

function range(dav: Dav, from: string | undefined, to: string | undefined, back: number, ahead: number): [Date, Date] {
  for (const d of [from, to]) if (d !== undefined && !DATE.test(d)) throw new Refused("from and to must be YYYY-MM-DD");
  const today = localMidnight(localIso(new Date(), dav.timezone).slice(0, 10), dav.timezone);
  const a = from ? localMidnight(from, dav.timezone) : addDays(today, -back);
  const b = to ? addDays(localMidnight(to, dav.timezone), 1) : addDays(from ? a : today, ahead);
  if (b <= a) throw new Refused("to is before from");
  if (b.getTime() - a.getTime() > MAX_RANGE) throw new Refused("Range too long (at most about 13 months)");
  return [a, b];
}

export function calendarService(env: CalendarEnv, fetcher: typeof fetch = fetch): CalendarApi {
  const setup = (p: CalendarPrincipal) => {
    const h = householdFromVar(env.HOUSEHOLD);
    if (!h.modules.calendar) throw new Refused("The calendar module is switched off.");
    if (!p || typeof p.id !== "string" || !p.id.trim() || !Array.isArray(p.scopes)) throw new Refused("Not allowed: no caller.");
    const dav = davOf(env, h, fetcher);
    const can = (calendar: string, op: CalOp) => p.scopes.includes(scope(calendar, op));
    const need = (calendar: string, op: CalOp) => {
      if (!dav.wanted.some((w) => w.id === calendar)) throw new Refused(`No such calendar "${calendar}"`);
      if (!can(calendar, op)) throw new Refused(`Not allowed: this connection lacks ${scope(calendar, op)}.`);
    };
    /** The calendars to read: the ones asked for (each needs the scope), or every one this connection may read. */
    const readable = (asked?: string[]) => {
      if (asked?.length) { for (const c of asked) need(c, "read"); return asked; }
      const all = dav.wanted.filter((w) => can(w.id, "read")).map((w) => w.id);
      if (!all.length) throw new Refused("Not allowed: this connection may not read any calendar.");
      return all;
    };
    return { dav, can, need, readable };
  };
  return {
    version: () => CALENDAR_CONTRACT,
    calendars: (p) => run(async () => {
      const { dav, can } = setup(p);
      const found = new Set((await directory(dav)).map((c) => c.id));
      return dav.wanted.map((w): CalendarInfo => ({ id: w.id, name: w.name, owner: w.owner, found: found.has(w.id), can: (Object.keys(OPS) as CalOp[]).filter((o) => can(w.id, o)) }))
        .filter((c) => c.can!.length);
    }),
    list: (p, q) => run(async () => {
      const { dav, readable } = setup(p);
      const [from, to] = range(dav, q?.from, q?.to, 0, 15);
      return listEvents(dav, readable(q?.calendars), from, to);
    }),
    find: (p, q) => run(async () => {
      const { dav, readable } = setup(p);
      const words = stripBrackets(String(q?.text ?? "")).toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) throw new Refused("text is required");
      const [from, to] = range(dav, q.from, q.to, 180, q.from ? 366 : 366);
      const all = await listEvents(dav, readable(q.calendars), from, to);
      return all.filter((e) => { const hay = `${e.title} ${e.location ?? ""} ${e.notes ?? ""}`.toLowerCase(); return words.every((w) => hay.includes(w)); }).slice(0, 100);
    }),
    get: (p, calendar, uid) => run(async () => { const s = setup(p); s.need(calendar, "read"); return getEvent(s.dav, calendar, String(uid)); }),
    add: (p, a) => run(async () => {
      const s = setup(p);
      s.need(a?.calendar, "add");
      if (typeof a.title !== "string" || !a.title.trim() || typeof a.start !== "string") throw new Refused("title and start are required");
      return addEvent(s.dav, { calendar: a.calendar, title: a.title.slice(0, 300), start: a.start, end: a.end, location: a.location?.slice(0, 300), notes: a.notes?.slice(0, 4000), tentative: a.tentative === true });
    }),
    update: (p, a) => run(async () => {
      const s = setup(p);
      s.need(a?.calendar, "update");
      return updateEvent(s.dav, { calendar: a.calendar, uid: String(a.uid), title: a.title?.slice(0, 300), start: a.start, end: a.end, location: a.location, notes: a.notes }) as Promise<never>;
    }),
    confirm: (p, calendar, uid) => run(async () => { const s = setup(p); s.need(calendar, "update"); return updateEvent(s.dav, { calendar, uid: String(uid), confirm_only: true }); }),
    remove: (p, calendar, uid, confirm) => run(async () => {
      const s = setup(p);
      s.need(calendar, "remove");
      if (confirm !== true) return { would_remove: await getEvent(s.dav, calendar, String(uid)), next: "call again with confirm: true once the person agrees" };
      return removeEvent(s.dav, calendar, String(uid));
    }),
  };
}

export function calendarUi(env: CalendarEnv, fetcher: typeof fetch = fetch): CalendarUiApi {
  return {
    version: () => CALENDAR_UI_CONTRACT,
    events: (q) => run(async () => {
      const h = householdFromVar(env.HOUSEHOLD);
      if (!h.modules.calendar) throw new Refused("The calendar module is switched off.");
      const dav = davOf(env, h, fetcher);
      if (!DATE.test(q?.from ?? "") || !DATE.test(q?.to ?? "")) throw new Refused("from and to must be YYYY-MM-DD");
      const [from, to] = range(dav, q.from, q.to, 0, 0);
      const events = await listEvents(dav, dav.wanted.map((w) => w.id), from, to);
      // the pages show when, what and where; notes stay behind
      return { events: events.map(({ notes: _notes, ...e }) => e) };
    }),
  };
}
