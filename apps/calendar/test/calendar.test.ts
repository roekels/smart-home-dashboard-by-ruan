// The calendar Worker's rules, against a stand-in for iCloud: which calendars a household has, what each caller may
// do with them, the bracket rule, and where the password is (and is not) sent.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHousehold } from "../../../packages/core/src/household.ts";
import { forgetDirectory, isIcloud, localIso, zonedToUtc } from "../src/caldav.ts";
import { calendarService, calendarUi, wantedCalendars, type CalendarEnv } from "../src/service.ts";
import { calendarModule, calendarRoute } from "../shell.ts";
import { fakeIcloud, ics } from "./fakes/icloud.ts";

const example = JSON.parse(readFileSync(new URL("../../../household.config.example.json", import.meta.url), "utf8"));
const config = { ...example, modules: { ...example.modules, calendar: true } };
const H = parseHousehold(config);
const ENV: CalendarEnv = { HOUSEHOLD: JSON.stringify(config), CALENDAR_ICLOUD_USER_ID: "someone@example.com", CALENDAR_ICLOUD_APP_PASSWORD: "app-pass" };
const ALL = ["alex", "sam", "shared"].flatMap((c) => ["read", "add", "update", "remove"].map((o) => `cal.${c}.${o}`));
const june = { from: "2031-06-01", to: "2031-06-30" };

/** Alex and the shared calendar exist; Sam has not made theirs yet. "Work" is someone's other calendar: never touched. */
const cloud = (opts?: Parameters<typeof fakeIcloud>[1]) => fakeIcloud({
  Alex: {
    A1: ics("A1", "Dentist", "20310610T090000Z", "20310610T093000Z", "LOCATION:High Street Dental\r\nDESCRIPTION:Bring the form"),
    A2: ics("A2", "(Weekend away)", "20310614", "20310616"),
    A3: ics("A3", "Swimming", "20310602T170000Z", "20310602T180000Z", "RRULE:FREQ=WEEKLY;COUNT=3"),
  },
  Family: { F1: ics("F1", "Summer fair", "20310621T130000Z", "20310621T160000Z") },
  Work: { W1: ics("W1", "Quarterly review", "20310611T100000Z", "20310611T110000Z") },
}, opts);

beforeEach(() => forgetDirectory());

test("a household has one calendar per person and a shared one, found by name", async () => {
  assert.deepEqual(wantedCalendars(H).map((c) => [c.id, c.name, c.owner]), [["alex", "Alex", "alex"], ["sam", "Sam", "sam"], ["shared", "Family", null]]);
  assert.equal(wantedCalendars(H, "Home").at(-1)!.name, "Home");
  const api = calendarService(ENV, cloud().fetcher);
  const list = await api.calendars({ id: "t", scopes: ALL });
  assert.deepEqual(list.map((c) => [c.id, c.found]), [["alex", true], ["sam", false], ["shared", true]]);
  assert.deepEqual((await api.calendars({ id: "t", scopes: ["cal.sam.read"] })).map((c) => [c.id, c.can]), [["sam", ["read"]]]);
});

test("list: local times, ideas, repeats expanded, other calendars of the account left alone", async () => {
  const api = calendarService(ENV, cloud().fetcher);
  const events = await api.list({ id: "t", scopes: ALL }, june);
  assert.deepEqual(events.map((e) => e.title), ["Swimming", "Swimming", "Dentist", "Weekend away", "Swimming", "Summer fair"]);
  const dentist = events.find((e) => e.uid === "A1")!;
  assert.deepEqual([dentist.start, dentist.end, dentist.all_day, dentist.status, dentist.calendar_id, dentist.owner], ["2031-06-10T10:00:00+01:00", "2031-06-10T10:30:00+01:00", false, "confirmed", "alex", "alex"]);
  const away = events.find((e) => e.uid === "A2")!;
  assert.deepEqual([away.title, away.status, away.start, away.end, away.all_day], ["Weekend away", "idea", "2031-06-14", "2031-06-16", true]);
  assert.deepEqual([events.at(-1)!.calendar, events.at(-1)!.owner], ["Family", null]);
  assert.equal(events.some((e) => e.title === "Quarterly review"), false);
  assert.deepEqual((await api.find({ id: "t", scopes: ALL }, { text: "(weekend)", ...june })).map((e) => e.uid), ["A2"]);
  assert.deepEqual((await api.find({ id: "t", scopes: ALL }, { text: "form", ...june })).map((e) => e.uid), ["A1"], "notes are searched");
});

test("every call is held to the caller's scopes, per calendar", async () => {
  const api = calendarService(ENV, cloud().fetcher);
  const mine = { id: "t", scopes: ["cal.shared.read"] };
  assert.deepEqual((await api.list(mine, june)).map((e) => e.uid), ["F1"]);
  await assert.rejects(api.list(mine, { ...june, calendars: ["alex"] }), /lacks cal\.alex\.read/);
  await assert.rejects(api.get(mine, "alex", "A1"), /lacks cal\.alex\.read/);
  await assert.rejects(api.add(mine, { calendar: "shared", title: "x", start: "2031-06-03" }), /lacks cal\.shared\.add/);
  await assert.rejects(api.remove(mine, "shared", "F1", true), /lacks cal\.shared\.remove/);
  await assert.rejects(api.list({ id: "t", scopes: ["finance.read"] }, june), /may not read any calendar/);
  await assert.rejects(api.get({ id: "t", scopes: ALL }, "work", "W1"), /No such calendar/);
  await assert.rejects(api.list({ id: "", scopes: ALL }, june), /no caller/);
  await assert.rejects(api.add({ id: "t", scopes: ALL }, { calendar: "sam", title: "x", start: "2031-06-03" }), /no calendar named "Sam"/);
  const off = calendarService({ ...ENV, HOUSEHOLD: JSON.stringify(example) }, cloud().fetcher);
  await assert.rejects(off.list({ id: "t", scopes: ALL }, june), /switched off/);
});

test("add, confirm, update, remove: the bracket rule and the confirm step", async () => {
  const c = cloud(), api = calendarService(ENV, c.fetcher), p = { id: "t", scopes: ALL };
  const added = await api.add(p, { calendar: "shared", title: "Dinner with friends", start: "2031-06-05T19:00", tentative: true, location: "Number 12" });
  assert.deepEqual([added.title, added.status, added.start, added.end, added.location], ["Dinner with friends", "idea", "2031-06-05T19:00:00+01:00", "2031-06-05T20:00:00+01:00", "Number 12"]);
  assert.match(c.raw("Family", added.uid)!, /SUMMARY:\(Dinner with friends\)/);
  assert.match(c.raw("Family", added.uid)!, /DTSTART:20310605T180000Z/, "written in UTC");

  const fixed = await api.confirm(p, "shared", added.uid);
  assert.equal((fixed as { status: string }).status, "confirmed");
  assert.deepEqual(await api.confirm(p, "shared", added.uid), { already_confirmed: "Dinner with friends" });

  const moved = await api.update(p, { calendar: "shared", uid: added.uid, start: "2031-06-06T18:30", location: null });
  assert.deepEqual([moved.start, moved.end, moved.location], ["2031-06-06T18:30:00+01:00", "2031-06-06T19:30:00+01:00", undefined], "the length is kept");

  const day = await api.add(p, { calendar: "alex", title: "Day off", start: "2031-06-20" });
  assert.deepEqual([day.all_day, day.start, day.end], [true, "2031-06-20", "2031-06-21"]);
  await assert.rejects(api.add(p, { calendar: "alex", title: "x", start: "2031-06-20", end: "2031-06-20T10:00" }), /both be dates/);
  await assert.rejects(api.add(p, { calendar: "alex", title: "x", start: "next tuesday" }), /YYYY-MM-DD/);

  const ask = await api.remove(p, "shared", added.uid);
  assert.equal((ask.would_remove as { uid: string }).uid, added.uid);
  assert.ok(c.raw("Family", added.uid), "nothing removed without confirm");
  assert.deepEqual(await api.remove(p, "shared", added.uid, true), { removed: added.uid, calendar: "shared" });
  assert.equal(c.raw("Family", added.uid), undefined);
  await assert.rejects(api.get(p, "shared", added.uid), /No event/);
});

test("the password only goes to Apple, and a failure never quotes what iCloud said", async () => {
  for (const ok of ["https://caldav.icloud.com/", "https://p01-caldav.icloud.com/1/"]) assert.equal(isIcloud(ok), true, ok); // scrub-check: allow (Apple's CalDAV hosts)
  for (const bad of ["http://caldav.icloud.com/", "https://icloud.com.example.com/", "https://evil.example/caldav.icloud.com", "https://x@caldav.icloud.com/", "https://caldav.icloud.com:8443/", "nope"]) assert.equal(isIcloud(bad), false, bad); // scrub-check: allow (made-up addresses that must be refused)

  const lured = cloud({ redirectTo: "https://collector.example/steal" });
  await assert.rejects(calendarService(ENV, lured.fetcher).list({ id: "t", scopes: ALL }, june), /^Error: The calendar could not be reached/);
  assert.deepEqual(lured.seen.map((s) => new URL(s.url).hostname), ["caldav.icloud.com"], "the redirect was not followed");

  const c = cloud();
  await calendarService(ENV, c.fetcher).list({ id: "t", scopes: ALL }, june);
  assert.ok(c.seen.length >= 5 && c.seen.every((s) => new URL(s.url).hostname.endsWith(".icloud.com")));

  await assert.rejects(calendarService({ ...ENV, CALENDAR_ICLOUD_APP_PASSWORD: "old" }, c.fetcher).list({ id: "t", scopes: ALL }, june), /refused the app-specific password/);
  const none = cloud();
  await assert.rejects(calendarService({ HOUSEHOLD: ENV.HOUSEHOLD }, none.fetcher).list({ id: "t", scopes: ALL }, june), /not connected yet/);
  assert.equal(none.seen.length, 0);
});

test("the dashboard gets every calendar, read only and without notes", async () => {
  const ui = calendarUi(ENV, cloud().fetcher);
  const { events } = await ui.events({ from: "2031-06-10", to: "2031-06-14" });
  assert.deepEqual(events.map((e) => e.uid), ["A1", "A2"]);
  assert.equal(events.some((e) => "notes" in e), false);
  await assert.rejects(ui.events({ from: "2031-06-10", to: "soon" }), /YYYY-MM-DD/);

  const res = await calendarRoute(new Request("https://home.example.com/api/calendar"), new URL("https://home.example.com/api/calendar?from=2031-06-10&to=2031-06-10"), ui);
  assert.deepEqual(((await res.json()) as { events: { title: string }[] }).events.map((e) => e.title), ["Dentist"]);
  const wall = await calendarRoute(new Request("https://home.example.com/api/calendar"), new URL("https://home.example.com/api/calendar?from=2031-06-01&to=2031-06-30"), ui, true);
  assert.deepEqual(((await wall.json()) as { events: { title: string }[] }).events.map((e) => e.title), ["Summer fair"], "a caller that is not a person only sees the shared calendar");
  await assert.rejects(calendarRoute(new Request("https://home.example.com/api/calendar", { method: "POST" }), new URL("https://home.example.com/api/calendar"), ui), /method not allowed/);
  await assert.rejects(calendarRoute(new Request("https://home.example.com/api/calendar"), new URL("https://home.example.com/api/calendar?from=2031-06-10&to=2031-06-10"), undefined), /not connected/);
  assert.equal(calendarModule.pages![0].path, "/home/calendar");
  const sec = calendarModule.security!(H);
  assert.ok(sec.nodes!.some((n) => n.name === "home-calendar"));
});

test("times: a wall-clock time in a zone, across a daylight-saving change", () => {
  assert.equal(zonedToUtc("2031-01-15T09:00:00", "Europe/London").toISOString(), "2031-01-15T09:00:00.000Z");
  assert.equal(zonedToUtc("2031-07-15T09:00:00", "Europe/London").toISOString(), "2031-07-15T08:00:00.000Z");
  assert.equal(zonedToUtc("2031-07-15T09:00:00", "America/New_York").toISOString(), "2031-07-15T13:00:00.000Z");
  assert.equal(localIso(new Date("2031-12-31T23:30:00Z"), "Pacific/Auckland"), "2032-01-01T12:30:00+13:00");
});
