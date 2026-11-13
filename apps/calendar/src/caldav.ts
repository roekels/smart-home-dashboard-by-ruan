// iCloud CalDAV over plain fetch, iCalendar parsing and recurrence expansion with ical.js.
// Which calendars: one per person, named like the person's first name in the household config, plus one shared
// calendar (CALENDAR_SHARED_NAME, default "Family"). They are found by name at run time, so no account id or
// calendar address ever lives in the repository or in a config file. A calendar that is not there is left out.
// Nothing an event says is ever logged.
import ICAL from "ical.js";
import type { CalendarEvent, EventDetail } from "./contract.ts";

export class Refused extends Error {}

/** What the functions here need: the two secrets, the household's calendars and time zone, and fetch (tests swap it). */
export interface Dav {
  user: string | undefined;
  password: string | undefined;
  /** Calendars to look for: id (a person id, or "shared"), the name it has in iCloud, and whose it is. */
  wanted: { id: string; name: string; owner: string | null }[];
  timezone: string;
  fetcher: typeof fetch;
}

const SERVER = "https://caldav.icloud.com/"; // scrub-check: allow (Apple's public CalDAV address)

// ---------- HTTP ----------

function auth(env: Dav) {
  if (!env.user || !env.password) throw new Refused("The calendar is not connected yet: CALENDAR_ICLOUD_USER_ID and CALENDAR_ICLOUD_APP_PASSWORD are not set.");
  return "Basic " + btoa(`${env.user}:${env.password}`);
}

/** The password only ever goes to Apple: iCloud names other hosts of its own (pNN-caldav.icloud.com) in its
 *  answers, and an answer is data, so every address is checked before the request. */
export function isIcloud(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "icloud.com" || u.hostname.endsWith(".icloud.com")) && !u.username && !u.password && (u.port === "" || u.port === "443");
  } catch { return false; }
}

async function davAt(env: Dav, url: string, method: string, body?: string, headers: Record<string, string> = {}): Promise<{ r: Response; url: string }> {
  const authorization = auth(env);
  // redirects are followed by hand, so the password never follows one to a host that is not Apple's
  for (let hop = 0; hop < 4; hop++) {
    if (!isIcloud(url)) throw new Error("iCloud: unexpected address");
    const r = await env.fetcher(url, { method, body, redirect: "manual", headers: { authorization, "content-type": "application/xml; charset=utf-8", ...headers } });
    if (r.status === 401) throw new Refused("iCloud refused the app-specific password. Make a new one at account.apple.com and set CALENDAR_ICLOUD_APP_PASSWORD again.");
    const to = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (!to) return { r, url };
    url = new URL(to, url).toString();
  }
  throw new Error("iCloud: too many redirects");
}
const dav = async (env: Dav, url: string, method: string, body?: string, headers: Record<string, string> = {}) => (await davAt(env, url, method, body, headers)).r;

const unxml = (s: string) => {
  const t = s.trim();
  const cdata = t.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) return cdata[1].trim();
  return t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;/g, "\r").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&").trim();
};

interface DavObject { href: string; etag: string; data: string }
/** If-Match needs the strong form; a W/ prefix added on the way never matches. */
export const strongEtag = (etag: string) => etag.trim().replace(/^W\//, "");
function parseMultistatus(xml: string, base: string): DavObject[] {
  const out: DavObject[] = [];
  for (const resp of xml.split(/<(?:\w+:)?response[\s>]/i).slice(1)) {
    const href = resp.match(/<(?:\w+:)?href[^>]*>([^<]+)</i)?.[1];
    const data = resp.match(/<(?:\w+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:\w+:)?calendar-data>/i)?.[1];
    const etag = resp.match(/<(?:\w+:)?getetag[^>]*>([^<]*)</i)?.[1] ?? "";
    if (href && data) out.push({ href: new URL(href, base).toString(), etag: strongEtag(unxml(etag)), data: unxml(data) });
  }
  return out;
}

// ---------- Discovery (found at run time and kept in memory, so no account ids live in the repo) ----------

export interface Found { id: string; name: string; owner: string | null; url: string }
let cachedDir: { key: string; found: Found[]; until: number } | undefined;

/** Tests only: forget what was found. */
export const forgetDirectory = () => { cachedDir = undefined; };

/** The wanted calendars that exist in the account, with their addresses. Cached for six hours per isolate. */
export async function directory(env: Dav, fresh = false): Promise<Found[]> {
  const key = `${env.user}|${env.wanted.map((w) => w.name).join("|")}`;
  if (!fresh && cachedDir && cachedDir.key === key && cachedDir.until > Date.now()) return cachedDir.found;
  const p1 = await davAt(env, SERVER, "PROPFIND", `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`, { depth: "0" });
  const principal = (await p1.r.text()).match(/current-user-principal[^>]*>\s*<(?:\w+:)?href[^>]*>([^<]+)</i)?.[1];
  if (!principal) throw new Error("iCloud: no principal");
  const p2 = await davAt(env, new URL(principal, p1.url).toString(), "PROPFIND", `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`, { depth: "0" });
  const homeHref = (await p2.r.text()).match(/calendar-home-set[^>]*>\s*<(?:\w+:)?href[^>]*>([^<]+)</i)?.[1];
  if (!homeHref) throw new Error("iCloud: no calendar home");
  const home = new URL(homeHref, p2.url).toString();
  const p3 = await dav(env, home, "PROPFIND", `<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>`, { depth: "1" });
  const byName = new Map<string, string>();
  for (const resp of (await p3.text()).split(/<(?:\w+:)?response[\s>]/i).slice(1)) {
    const name = unxml(resp.match(/<(?:\w+:)?displayname[^>]*>([^<]*)</i)?.[1] ?? "");
    const href = resp.match(/<(?:\w+:)?href[^>]*>([^<]+)</i)?.[1];
    const isCal = /<(\w+:)?calendar[\s/>]/i.test(resp.match(/resourcetype[^>]*>([\s\S]*?)<\/(?:\w+:)?resourcetype/i)?.[1] ?? "");
    if (isCal && href && name) byName.set(name.toLowerCase(), new URL(href, home).toString());
  }
  const found = env.wanted.flatMap((w) => { const url = byName.get(w.name.toLowerCase()); return url ? [{ ...w, url }] : []; });
  cachedDir = { key, found, until: Date.now() + 6 * 3600_000 };
  return found;
}

async function calendarOf(env: Dav, id: string): Promise<Found> {
  const c = (await directory(env)).find((x) => x.id === id);
  if (c) return c;
  const w = env.wanted.find((x) => x.id === id);
  throw new Refused(w ? `There is no calendar named "${w.name}" in the iCloud account. Create it in the Calendar app, then try again.` : `No such calendar "${id}"`);
}

// ---------- Times (local to the household's time zone) ----------

const parts = new Map<string, Intl.DateTimeFormat>();
/** A JS Date as local time with offset in a time zone, e.g. 2026-11-08T19:00:00+01:00. */
export function localIso(d: Date, tz: string): string {
  if (!parts.has(tz)) parts.set(tz, new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }));
  const p = Object.fromEntries(parts.get(tz)!.formatToParts(d).map((x) => [x.type, x.value]));
  const off = (p.timeZoneName ?? "GMT").replace("GMT", "") || "+00:00";
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}

/** The moment a wall-clock time ("2026-11-08T19:00:00") happens in a time zone. */
export function zonedToUtc(local: string, tz: string): Date {
  let d = new Date(`${local}Z`);
  // two rounds settle the offset, also across a daylight-saving change
  for (let i = 0; i < 2; i++) d = new Date(`${local}${localIso(d, tz).slice(19)}`);
  return d;
}

/** Midnight at the start of a date in a time zone. */
export const localMidnight = (day: string, tz: string): Date => zonedToUtc(`${day}T00:00:00`, tz);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);

const icalDate = (t: InstanceType<typeof ICAL.Time>, tz: string) => (t.isDate ? t.toString() : localIso(t.toJSDate(), tz));

/** Input "2026-11-08" (all day), "2026-11-08T19:00" (local time) or with offset/Z. Timed events are written in UTC,
 *  which every calendar app shows in the reader's own time zone. */
function toIcalTime(input: string, tz: string): { time: InstanceType<typeof ICAL.Time>; allDay: boolean } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return { time: ICAL.Time.fromDateString(input), allDay: true };
  let at: Date;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(input)) at = new Date(input);
  else {
    const m = input.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) throw new Refused(`Use YYYY-MM-DD or YYYY-MM-DDTHH:MM (local time); got "${input}"`);
    at = zonedToUtc(`${m[1]}T${m[2]}:${m[3]}:${m[4] ?? "00"}`, tz);
  }
  if (Number.isNaN(at.getTime())) throw new Refused(`Bad date "${input}"`);
  return { time: ICAL.Time.fromJSDate(at, true), allDay: false };
}

// ---------- Events ----------

export const isIdea = (title: string) => /^\s*\(.*\)\s*$/.test(title);
export const stripBrackets = (title: string) => title.replace(/^\s*\((.*)\)\s*$/, "$1").trim();

function loadComponent(data: string) {
  const comp = new ICAL.Component(ICAL.parse(data));
  for (const tz of comp.getAllSubcomponents("vtimezone")) {
    const id = tz.getFirstPropertyValue("tzid");
    if (id && !ICAL.TimezoneService.has(String(id))) ICAL.TimezoneService.register(tz);
  }
  return comp;
}

function eventsIn(c: Found, tz: string, data: string, from: Date, to: Date, cap = 500): CalendarEvent[] {
  const comp = loadComponent(data);
  const vevents = comp.getAllSubcomponents("vevent");
  const master = vevents.find((v) => !v.hasProperty("recurrence-id")) ?? vevents[0];
  if (!master) return [];
  const ev = new ICAL.Event(master);
  for (const ex of vevents.filter((v) => v.hasProperty("recurrence-id"))) ev.relateException(ex);
  const base = (e: InstanceType<typeof ICAL.Event>) => {
    const title = e.summary ?? "(no title)";
    const notes = e.description ? String(e.description).slice(0, 600) : undefined;
    return { calendar: c.name, calendar_id: c.id, owner: c.owner, uid: ev.uid, title: stripBrackets(title) || title, status: (isIdea(title) ? "idea" : "confirmed") as "idea" | "confirmed", location: e.location || undefined, notes };
  };
  const start = ICAL.Time.fromJSDate(from, true), end = ICAL.Time.fromJSDate(to, true);
  const out: CalendarEvent[] = [];
  if (!ev.isRecurring()) {
    if (ev.startDate.compare(end) < 0 && (ev.endDate ?? ev.startDate).compare(start) >= 0) {
      out.push({ ...base(ev), start: icalDate(ev.startDate, tz), end: icalDate(ev.endDate ?? ev.startDate, tz), all_day: ev.startDate.isDate, recurring: false });
    }
    return out;
  }
  const it = ev.iterator();
  let t: InstanceType<typeof ICAL.Time> | null;
  let guard = 0;
  while ((t = it.next()) && guard++ < 5000 && out.length < cap) {
    if (t.compare(end) >= 0) break;
    const d = ev.getOccurrenceDetails(t);
    if (d.endDate.compare(start) <= 0) continue;
    out.push({ ...base(d.item), start: icalDate(d.startDate, tz), end: icalDate(d.endDate, tz), all_day: d.startDate.isDate, recurring: true, occurrence: icalDate(d.recurrenceId, tz) });
  }
  return out;
}

const davTime = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** Events of the given calendars (ids). A wanted calendar that does not exist in the account is skipped. */
export async function listEvents(env: Dav, calendars: string[], from: Date, to: Date): Promise<CalendarEvent[]> {
  const dir = (await directory(env)).filter((c) => calendars.includes(c.id));
  const body = `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${davTime(from)}" end="${davTime(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const lists = await Promise.all(dir.map(async (c) => {
    const r = await dav(env, c.url, "REPORT", body, { depth: "1" });
    if (r.status >= 400) throw new Error(`iCloud: HTTP ${r.status}`);
    return parseMultistatus(await r.text(), c.url).flatMap((o) => {
      try { return eventsIn(c, env.timezone, o.data, from, to); } catch { return []; }
    });
  }));
  return lists.flat().sort((a, b) => a.start.localeCompare(b.start));
}

const hasUid = (data: string, uid: string) => new RegExp(`^UID:${uid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?$`, "m").test(data);

/** Find an event's object: by file name first (iCloud names files after the UID), then by a UID query, then by a full scan. */
async function findObject(env: Dav, calendar: string, uid: string): Promise<DavObject> {
  const base = (await calendarOf(env, calendar)).url;
  if (/^[A-Za-z0-9@._-]+$/.test(uid)) {
    // A multiget returns the data and its ETag together. The ETag header of a plain GET can come back
    // weakened (W/"…") after compression, and iCloud then answers every If-Match with 412.
    const url = new URL(`${encodeURIComponent(uid)}.ics`, base).toString();
    const body = `<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>${new URL(url).pathname}</d:href></c:calendar-multiget>`;
    const r = await dav(env, base, "REPORT", body, { depth: "1" });
    if (r.ok) {
      const hit = parseMultistatus(await r.text(), base).find((o) => hasUid(o.data, uid));
      if (hit) return hit;
    }
  }
  const query = (filter: string) => `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${filter}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const safeUid = uid.replace(/[<&>]/g, "");
  for (const filter of [`<c:prop-filter name="UID"><c:text-match collation="i;octet">${safeUid}</c:text-match></c:prop-filter>`, ""]) {
    const r = await dav(env, base, "REPORT", query(filter), { depth: "1" });
    const hit = parseMultistatus(await r.text(), base).find((o) => hasUid(o.data, uid));
    if (hit) return hit;
  }
  throw new Refused(`No event ${uid} in calendar ${calendar}`);
}

export async function getEvent(env: Dav, calendar: string, uid: string): Promise<EventDetail> {
  const c = await calendarOf(env, calendar), tz = env.timezone;
  const o = await findObject(env, calendar, uid);
  const comp = loadComponent(o.data);
  const master = comp.getAllSubcomponents("vevent").find((v) => !v.hasProperty("recurrence-id"))!;
  const ev = new ICAL.Event(master);
  const title = ev.summary ?? "";
  return {
    calendar: c.name, calendar_id: c.id, owner: c.owner, uid, title: stripBrackets(title) || title, status: isIdea(title) ? "idea" : "confirmed",
    start: icalDate(ev.startDate, tz), end: icalDate(ev.endDate ?? ev.startDate, tz), all_day: ev.startDate.isDate,
    recurring: ev.isRecurring(), repeats: master.getFirstPropertyValue("rrule")?.toString(),
    location: ev.location || undefined, notes: ev.description ? String(ev.description).slice(0, 4000) : undefined,
    organizer: master.getFirstPropertyValue("organizer")?.toString(), attendees: master.getAllProperties("attendee").length,
  };
}

function setTime(v: InstanceType<typeof ICAL.Component>, name: "dtstart" | "dtend", t: InstanceType<typeof ICAL.Time>) {
  v.removeAllProperties(name);
  const p = new ICAL.Property(name, v);
  p.setValue(t);
  v.addProperty(p);
}

function stamp(v: InstanceType<typeof ICAL.Component>) {
  const now = ICAL.Time.fromJSDate(new Date(), true);
  v.updatePropertyWithValue("dtstamp", now);
  v.updatePropertyWithValue("last-modified", now);
  v.updatePropertyWithValue("sequence", Number(v.getFirstPropertyValue("sequence") ?? 0) + 1);
}

export async function addEvent(env: Dav, a: { calendar: string; title: string; start: string; end?: string; location?: string; notes?: string; tentative?: boolean }): Promise<EventDetail> {
  const cal0 = await calendarOf(env, a.calendar);
  const s = toIcalTime(a.start, env.timezone);
  let e = a.end ? toIcalTime(a.end, env.timezone) : null;
  if (!e) {
    const t = s.time.clone();
    if (s.allDay) t.day += 1; else t.addDuration(ICAL.Duration.fromSeconds(3600));
    e = { time: t, allDay: s.allDay };
  }
  if (e.allDay !== s.allDay) throw new Refused("start and end must both be dates or both be date-times");
  if (e.time.compare(s.time) < 0) throw new Refused("end is before start");
  const title = a.tentative ? `(${stripBrackets(a.title)})` : a.title;
  const uid = crypto.randomUUID().toUpperCase();
  const cal = new ICAL.Component(["vcalendar", [], []]);
  cal.updatePropertyWithValue("prodid", "-//smart-home-dashboard//calendar//EN");
  cal.updatePropertyWithValue("version", "2.0");
  const v = new ICAL.Component("vevent");
  v.updatePropertyWithValue("uid", uid);
  v.updatePropertyWithValue("summary", title);
  setTime(v, "dtstart", s.time);
  setTime(v, "dtend", e.time);
  if (a.location) v.updatePropertyWithValue("location", a.location);
  if (a.notes) v.updatePropertyWithValue("description", a.notes);
  v.updatePropertyWithValue("created", ICAL.Time.fromJSDate(new Date(), true));
  stamp(v);
  cal.addSubcomponent(v);
  const url = new URL(`${uid}.ics`, cal0.url).toString();
  const r = await dav(env, url, "PUT", cal.toString(), { "content-type": "text/calendar; charset=utf-8", "if-none-match": "*" });
  if (r.status >= 300) throw new Error(`iCloud refused the new event: HTTP ${r.status}`);
  return getEvent(env, a.calendar, uid);
}

export async function updateEvent(env: Dav, a: { calendar: string; uid: string; title?: string; start?: string; end?: string; location?: string | null; notes?: string | null; confirm_only?: boolean }): Promise<EventDetail | { already_confirmed: string }> {
  const o = await findObject(env, a.calendar, a.uid);
  const comp = loadComponent(o.data);
  const v = comp.getAllSubcomponents("vevent").find((x) => !x.hasProperty("recurrence-id"));
  if (!v) throw new Refused("Event has no main entry");
  if (a.confirm_only) {
    const t = String(v.getFirstPropertyValue("summary") ?? "");
    if (!isIdea(t)) return { already_confirmed: t };
    v.updatePropertyWithValue("summary", stripBrackets(t));
  } else {
    if (a.title != null) v.updatePropertyWithValue("summary", a.title);
    if (a.start) {
      const s = toIcalTime(a.start, env.timezone);
      const old = new ICAL.Event(v);
      const dur = old.endDate ? old.endDate.subtractDate(old.startDate) : null;
      setTime(v, "dtstart", s.time);
      if (!a.end && dur) { const e = s.time.clone(); e.addDuration(dur); setTime(v, "dtend", e); }
    }
    if (a.end) setTime(v, "dtend", toIcalTime(a.end, env.timezone).time);
    if (a.location !== undefined) { v.removeAllProperties("location"); if (a.location) v.updatePropertyWithValue("location", a.location); }
    if (a.notes !== undefined) { v.removeAllProperties("description"); if (a.notes) v.updatePropertyWithValue("description", a.notes); }
  }
  stamp(v);
  const r = await dav(env, o.href, "PUT", comp.toString(), { "content-type": "text/calendar; charset=utf-8", ...(o.etag ? { "if-match": o.etag } : {}) });
  if (r.status === 412) throw new Refused("The event changed in the meantime; read it again.");
  if (r.status >= 300) throw new Error(`iCloud refused the change: HTTP ${r.status}`);
  return getEvent(env, a.calendar, a.uid);
}

export async function removeEvent(env: Dav, calendar: string, uid: string) {
  const o = await findObject(env, calendar, uid);
  const r = await dav(env, o.href, "DELETE", undefined, o.etag ? { "if-match": o.etag } : {});
  if (r.status === 412) throw new Refused("The event changed in the meantime; read it again.");
  if (r.status >= 300) throw new Error(`iCloud refused the removal: HTTP ${r.status}`);
  return { removed: uid, calendar };
}
