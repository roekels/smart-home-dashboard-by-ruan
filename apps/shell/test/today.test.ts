import test from "node:test";
import assert from "node:assert/strict";
import { evStates } from "../web/src/event-card.ts";
import { hello, sceneIcon, todayItems } from "../web/src/pages/today.ts";
import type { CalendarEvent } from "../web/src/api.ts";

const ev = (title: string, start: string, end: string, owner: string | null = "alex", all_day = false): CalendarEvent =>
  ({ id: title, title, start, end, all_day, owner, calendar: owner ?? "Family", location: "", idea: false }) as unknown as CalendarEvent;

const now = new Date(2026, 2, 10, 13, 0); // 10 March, 13:00 local
const D = "2026-03-10", T = "2026-03-11";

test("today: own and shared events only; of what has ended, only the last one stays", () => {
  const events = [
    ev("early", `${D}T08:00`, `${D}T09:00`),
    ev("lunch", `${D}T12:00`, `${D}T12:45`),
    ev("later", `${D}T15:00`, `${D}T16:00`),
    ev("sam only", `${D}T14:00`, `${D}T15:00`, "sam"),
    ev("bins", D, T, null, true),
    ev("tomorrow", `${T}T09:00`, `${T}T10:00`),
  ];
  const out = todayItems(events, now, "alex");
  assert.deepEqual(out.today.map((e) => e.title), ["bins", "lunch", "later"]);
  assert.deepEqual(out.tomorrow, []);
  assert.equal(out.ahead, true);
});

test("today: when the day is over, the first two of tomorrow show", () => {
  const events = [ev("done", `${D}T08:00`, `${D}T09:00`), ev("t1", `${T}T09:00`, `${T}T10:00`), ev("t2", `${T}T11:00`, `${T}T12:00`), ev("t3", `${T}T13:00`, `${T}T14:00`)];
  const out = todayItems(events, now, "alex");
  assert.deepEqual(out.today.map((e) => e.title), ["done"]);
  assert.deepEqual(out.tomorrow.map((e) => e.title), ["t1", "t2"]);
  assert.equal(out.ahead, false);
});

test("event cards: past is greyed, the next timed event is marked", () => {
  const events = [ev("bins", D, T, null, true), ev("done", `${D}T08:00`, `${D}T09:00`), ev("now", `${D}T12:30`, `${D}T13:30`), ev("later", `${D}T15:00`, `${D}T16:00`)];
  assert.deepEqual(evStates(events, now), ["", "past", "next", ""]);
});

test("greeting and scene icons", () => {
  assert.match(hello("Alex", new Date(2026, 0, 1, 8)), /morning, Alex/);
  assert.match(hello("Alex", new Date(2026, 0, 1, 20)), /evening, Alex/);
  assert.equal(sceneIcon("Good Night"), "moon");
  assert.equal(sceneIcon("Movie Time"), "spark");
});
