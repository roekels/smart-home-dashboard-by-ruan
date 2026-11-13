import { html, mount, $, type Raw } from "../../html.ts";
import { icon } from "../../icons.ts";
import { api, who, type CalendarEvent } from "../../api.ts";
import { loc, t } from "../../i18n.ts";
import { evCard, evStateMap } from "../../event-card.ts";
import type { UiModule } from "../../modules.ts";
import { useStyles } from "../fmt.ts";

// /home/calendar: seven days from every calendar of the household (one per person and the shared one). Read only:
// events are added in the Calendar app or through an AI app (/calendar/mcp on the gateway).
// A title in round brackets is an idea, not fixed: it is shown dashed.
// Data: GET /api/calendar (apps/calendar over a service binding; demo mode answers from demo/data/calendar.json).

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayName = (d: Date) => d.toLocaleDateString(loc(), { weekday: "long", day: "numeric", month: "short" });
// noon, so a daylight-saving change never moves a day
const plus = (d: Date, days: number) => { const x = new Date(d); x.setHours(12); x.setDate(x.getDate() + days); x.setHours(0, 0, 0, 0); return x; };

/** Weeks away from the one that starts today. */
let offset = 0;

export function weekStart(now = new Date(), weeks = offset): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return plus(d, weeks * 7);
}

/** An event shows on every day it covers (an all-day event's end is the day after its last). */
export function onDay(e: CalendarEvent, key: string): boolean {
  const first = e.start.slice(0, 10), end = e.end.slice(0, 10);
  if (first === key) return true;
  if (first > key) return false;
  return e.all_day || e.end.length <= 10 ? end > key : end > key || (end === key && e.end.slice(11, 16) > "00:00");
}

function week(start: Date, events: CalendarEvent[]): Raw {
  const days = Array.from({ length: 7 }, (_, i) => plus(start, i));
  const state = evStateMap(events);
  const today = ymd(new Date());
  return html`${days.map((d) => {
    const key = ymd(d);
    const list = events.filter((e) => onDay(e, key)).sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.start.localeCompare(b.start));
    return html`
    <section class="card cal-day${key === today ? " is-today" : ""}">
      <h3>${dayName(d)}</h3>
      ${list.length ? html`<ul class="cal-list">${list.map((e) => evCard(e, state.get(e)))}</ul>` : html`<p class="muted small">${t("Nothing planned.")}</p>`}
    </section>`;
  })}`;
}

const title = () => (offset === 0 ? t("This week") : weekStart().toLocaleDateString(loc(), { day: "numeric", month: "long" }));

function view(): Raw {
  useStyles("data");
  offset = 0;
  return html`
  <div class="bar">
    <div><p class="eyebrow">${icon("calendar")}${who.people.map((p) => p.name).join(" · ")}</p><h1 class="h1" id="cal-title">${title()}</h1></div>
    <div class="cal-nav">
      <button class="btn btn--line btn--sm" type="button" id="cal-prev" aria-label="${t("Earlier")}">${icon("left")}</button>
      <button class="btn btn--line btn--sm" type="button" id="cal-now">${t("Today")}</button>
      <button class="btn btn--line btn--sm" type="button" id="cal-next" aria-label="${t("Later")}">${icon("right")}</button>
    </div>
  </div>
  <p class="muted small">${t("Dashed = an idea, not fixed yet.")}</p>
  <div class="cal-week" id="cal-week"></div>
  <p class="banner" id="cal-error" role="alert"></p>`;
}

function load(): void {
  const box = $("#cal-week");
  if (!box) return;
  const start = weekStart(), mine = offset;
  $("#cal-title")!.textContent = title();
  $("#cal-error")!.textContent = "";
  mount(box, week(start, []));
  api.calendar(ymd(start), ymd(plus(start, 6)))
    .then((r) => { if (mine === offset && box.isConnected) mount(box, week(start, r.events)); })
    .catch((e: Error) => { if (mine === offset && box.isConnected) $("#cal-error")!.textContent = t("Could not load the calendars: {error}", { error: e.message }); });
}

function init(): void {
  $("#cal-prev")?.addEventListener("click", () => { offset--; load(); });
  $("#cal-next")?.addEventListener("click", () => { offset++; load(); });
  $("#cal-now")?.addEventListener("click", () => { offset = 0; load(); });
  load();
}

export const calendarUi: UiModule = { id: "calendar", pages: { "/home/calendar": { title: "Calendar", view, init } } };
