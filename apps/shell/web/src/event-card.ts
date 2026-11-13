import { html, type Raw } from "./html.ts";
import { icon } from "./icons.ts";
import { whoNumber, type CalendarEvent } from "./api.ts";
import { t } from "./i18n.ts";

// One calendar card for every view:
//   top     time (left) · calendar tag (right)
//   middle  the title, wrapped to at most 3 lines
//   bottom  the location, left out when there is none
// Tinted with its owner's colour, grey for a shared calendar. Past events are greyed out, the next one is bold.

export type EvState = "past" | "next" | "";

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** Past or next for each event (same order). Next = the first timed event that has not ended yet. */
export function evStates(events: CalendarEvent[], now = new Date()): EvState[] {
  const today = ymd(now), nowS = `${today}T${hm(now)}`;
  const past = (e: CalendarEvent) => (e.all_day ? e.start.slice(0, 10) < today && e.end.slice(0, 10) <= today : e.end.slice(0, 16) <= nowS);
  const states: EvState[] = events.map((e) => (past(e) ? "past" : ""));
  const next = events
    .map((e, i) => ({ e, i }))
    .filter(({ e, i }) => !e.all_day && states[i] !== "past")
    .sort((a, b) => a.e.start.localeCompare(b.e.start))[0];
  if (next) states[next.i] = "next";
  return states;
}

/** Start–end, or "all day". */
export const evTime = (e: CalendarEvent): string => (e.all_day ? t("all day") : `${e.start.slice(11, 16)}–${e.end.slice(11, 16)}`);

export function evCard(e: CalendarEvent, state: EvState = "", when = evTime(e)): Raw {
  const cls = `ev${e.status === "idea" ? " is-idea" : ""}${state ? ` is-${state}` : ""}`;
  return html`<li class="${cls}" data-who="${whoNumber(e.owner)}">
    <div class="ev__top"><span class="ev__time num">${when}</span><span class="ev__tag">${e.calendar}${e.status === "idea" ? ` · ${t("idea")}` : ""}</span></div>
    <b class="ev__title">${e.title}</b>
    ${e.location ? html`<span class="ev__loc">${icon("pin")}<span>${e.location}</span></span>` : ""}
  </li>`;
}

/** The same states, looked up by event: for views that split one list into days. */
export function evStateMap(events: CalendarEvent[], now = new Date()): Map<CalendarEvent, EvState> {
  const s = evStates(events, now);
  return new Map(events.map((e, i) => [e, s[i]]));
}
