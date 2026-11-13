import { html, mount, $, type Raw } from "../html.ts";
import { api, hasModule, who, type CalendarEvent, type HealthMine } from "../api.ts";
import { icon } from "../icons.ts";
import { hasPage } from "../routes.ts";
import { evCard, evStateMap } from "../event-card.ts";
import { t, n, loc } from "../i18n.ts";
import { listsSection, loadLists, wireLists } from "../lists.ts";

// /home: the start page, made for the person who is signed in and for a phone first.
// From the top: a greeting, then one card per module that is switched on:
//   health          their own health reminders (GET /api/health/mine: only the caller's records)
//   homeAssistant   the scenes (GET /api/ha, POST /api/ha/scene) and the lists (GET /api/lists …)
//   calendar        what is left of today in their own and the shared calendars (GET /api/calendar)
// and a few tiles to the other home pages. With no module on, it says how to switch one on.
// The shapes these calls return are in api.ts; demo mode answers them from demo/data.

let timer = 0;

const say = (msg: string) => { const e = $("#td-error"); if (e) e.textContent = msg; };
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const day = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString(loc(), { day: "numeric", month: "short", year: "numeric" });

export function hello(name: string, now = new Date()): string {
  const h = now.getHours();
  const part = h < 5 ? t("Good night") : h < 12 ? t("Good morning") : h < 18 ? t("Good afternoon") : t("Good evening");
  return name ? `${part}, ${name}` : part;
}

/** A link to a module's page, only when that page exists for this person. */
const more = (path: string, label: Raw | string) =>
  hasPage(path) ? html`<a class="btn btn--line btn--sm" href="${path}">${label}${icon("right")}</a>` : "";

const cards = () => ({ health: hasModule("health"), home: hasModule("homeAssistant"), calendar: hasModule("calendar") });

export function today(): Raw {
  const now = new Date(), on = cards();
  const tiles = who.nav.flatMap((g) => g.items).filter((i) => i.path !== "/home").slice(0, 3);
  return html`
  <div class="td">
    <header class="td__head">
      <p class="kicker">${now.toLocaleDateString(loc(), { weekday: "long", day: "numeric", month: "long" })}</p>
      <h1 class="h1" id="td-hello">${hello(who.person.name, now)}</h1>
      <p class="banner" id="td-error" role="alert"></p>
    </header>
    ${on.health ? html`
    <section class="td__health" aria-labelledby="td-health-h">
      <div class="h2-row"><h2 class="h2" id="td-health-h">${icon("pill")}${t("For you")}</h2>${more("/dashboard/health", t("Health"))}</div>
      <div class="card list" id="td-health"><p class="muted small list__empty">${t("Loading …")}</p></div>
    </section>` : ""}
    ${on.home ? html`
    <section class="td__scenes" aria-labelledby="td-scenes-h">
      <div class="h2-row"><h2 class="h2" id="td-scenes-h">${icon("spark")}${t("Scenes")}</h2><span class="muted small" id="td-lights"></span>${more("/home/controls", t("Lights"))}</div>
      <div class="scenes" id="td-scenes"><p class="muted small">${t("Loading …")}</p></div>
    </section>` : ""}
    ${on.calendar ? html`
    <section class="td__cal" aria-labelledby="td-cal-h">
      <div class="h2-row"><h2 class="h2" id="td-cal-h">${icon("calendar")}${t("Today")}</h2>${more("/home/calendar", t("Week"))}</div>
      <ul class="agenda" id="td-cal"><li class="muted small">${t("Loading …")}</li></ul>
    </section>` : ""}
    ${on.home ? listsSection() : ""}
    ${on.health || on.home || on.calendar ? "" : html`
    <section class="card td__empty">
      <h2 class="h2 h2--plain">${icon("grid")}${t("Nothing is switched on yet")}</h2>
      <p class="muted small">${who.person.admin
        ? t("This page fills up as modules are switched on: the calendar, Home Assistant, health reminders. Ask your AI to switch one on; it changes household.config.json and sets up what the module needs.")
        : t("This page fills up as modules are switched on. Ask an admin of your household.")}</p>
    </section>`}
    ${tiles.length ? html`<nav class="td-tiles" aria-label="${t("More")}">${tiles.map((i) =>
      html`<a class="td-tile card" href="${i.path}"><span class="chip-ic">${icon(i.icon)}</span><b>${t(i.label)}</b></a>`)}</nav>` : ""}
  </div>`;
}

// ---------------------------------------------------------------- health: only the signed-in person's own

// Dismissing hides an item from Today on this device only. It is not an acknowledgement and changes no record: the
// Health page still shows everything. The key holds what makes the item what it is (a new due date or follow-up
// text brings it back).
const HIDDEN = "today-hidden";
const hidden = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(HIDDEN) ?? "[]")); } catch { return new Set(); } };
function setHidden(s: Set<string>): void { try { localStorage.setItem(HIDDEN, JSON.stringify([...s])); } catch { /* private mode: fine */ } }
let lastMine: HealthMine | null = null;

function row(key: string, ic: Raw, title: string, sub: Raw | string): Raw {
  const body = html`${ic}<span class="list__txt"><b>${title}</b><small>${sub}</small></span>`;
  return html`<div class="list__row td-item">${hasPage("/dashboard/health") ? html`<a class="td-item__link" href="/dashboard/health">${body}</a>` : html`<span class="td-item__link">${body}</span>`}
    <button class="icon-btn td-item__x" data-hide="${key}" aria-label="${t("Hide from Today")}" title="${t("Hide from Today")}">${icon("x")}</button></div>`;
}

function health(m: HealthMine): Raw {
  const off = hidden();
  const items: { key: string; view: () => Raw }[] = [
    ...m.vaccinations_due.map((v) => ({ key: `v:${v.id}:${v.due}`, view: () => row(`v:${v.id}:${v.due}`,
      html`<span class="chip-ic ${v.overdue ? "tone-rose" : "tone-amber"}">${icon("alert")}</span>`, v.for,
      html`<span class="${v.overdue ? "tone-rose" : ""}">${v.overdue ? t("vaccination overdue since {date}", { date: day(v.due) }) : t("vaccination due {date}", { date: day(v.due) })}</span>`) })),
    ...m.follow_ups.map((f) => ({ key: `f:${f.id}:${f.follow_up}`, view: () => row(`f:${f.id}:${f.follow_up}`,
      html`<span class="chip-ic">${icon("clock")}</span>`, f.follow_up, t("follow-up · {what} on {date}", { what: f.what || t("visit"), date: day(f.date) })) })),
    ...m.current_meds.map((x) => ({ key: `m:${x.id}`, view: () => row(`m:${x.id}`,
      html`<span class="chip-ic">${icon("pill")}</span>`, x.name, [x.schedule, x.dose].filter(Boolean).join(" · ") || t("taking now")) })),
  ];
  const shown = items.filter((i) => !off.has(i.key));
  const gone = items.length - shown.length;
  const again = gone ? html`<button class="btn btn--line btn--sm td-unhide" data-unhide>${t("{n} hidden · show again", { n: gone })}</button>` : "";
  if (!shown.length) return html`<p class="muted small list__empty">${gone ? t("Nothing else here. The Health page has everything.") : t("Nothing due. Shots are up to date and no follow-ups are open.")}</p>${again}`;
  return html`${shown.map((i) => i.view())}${again}`;
}

/** Forget hidden keys whose item is gone (a shot given, a follow-up closed), so the list does not grow forever. */
function prune(m: HealthMine): void {
  const live = new Set([...m.vaccinations_due.map((v) => `v:${v.id}:${v.due}`), ...m.follow_ups.map((f) => `f:${f.id}:${f.follow_up}`), ...m.current_meds.map((x) => `m:${x.id}`)]);
  const s = hidden(), kept = new Set([...s].filter((k) => live.has(k)));
  if (kept.size !== s.size) setHidden(kept);
}

async function loadHealth(): Promise<void> {
  const box = $("#td-health");
  if (!box) return;
  try {
    const m = await api.healthMine();
    lastMine = m;
    prune(m);
    if ($("#td-health")) mount(box, health(m));
  } catch (e) {
    if ($("#td-health")) mount(box, html`<p class="muted small list__empty">${t("Health did not answer ({error}).", { error: (e as Error).message })}</p>`);
  }
}

// ---------------------------------------------------------------- scenes

/** Night scenes get the moon, the rest the spark. */
export const sceneIcon = (name: string): string => (/dream|night|sleep/i.test(name) ? "moon" : "spark");

async function loadScenes(): Promise<void> {
  try {
    const c = await api.home();
    const box = $("#td-scenes");
    if (!box) return;
    mount(box, c.scenes.length
      ? html`${c.scenes.map((s) => html`<button class="scene" data-scene="${s.entity}">${icon(sceneIcon(s.name))}<span>${s.name}</span></button>`)}`
      : html`<p class="muted small">${t("No scenes in Home Assistant yet.")}</p>`);
    const on = c.lights.filter((l) => l.on && !l.unavailable).length;
    $("#td-lights")!.textContent = c.lights.length ? n(on, "light on", "lights on") : "";
  } catch (e) {
    say(t("Could not reach Home Assistant: {error}", { error: (e as Error).message }));
  }
}

// ---------------------------------------------------------------- calendar: own + shared

/** All of today (only the last event that has ended stays, greyed out); when nothing is left today, the first two of tomorrow as well.
 *  `me` = the person id whose day this is: their own calendar and the shared ones; other people's stay on the Calendar page. */
export function todayItems(events: CalendarEvent[], now: Date, me: string): { today: CalendarEvent[]; tomorrow: CalendarEvent[]; ahead: boolean } {
  const t0 = ymd(now), nowS = `${t0}T${hm(now)}`;
  const all = events.filter((e) => e.owner === null || e.owner === me).sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.start.localeCompare(b.start));
  // of what has already ended today, only the most recent stays (greyed out), so the day starts with what is left
  const ended = all.filter((e) => e.start.slice(0, 10) <= t0 && !e.all_day && e.end <= nowS);
  const today = all.filter((e) => e.start.slice(0, 10) <= t0 && (!ended.includes(e) || e === ended[ended.length - 1]));
  const ahead = today.some((e) => e.all_day || e.end > nowS);
  return { today, tomorrow: ahead ? [] : all.filter((e) => e.start.slice(0, 10) > t0).slice(0, 2), ahead };
}

function agenda({ today, tomorrow, ahead }: ReturnType<typeof todayItems>): Raw {
  const st = evStateMap([...today, ...tomorrow]);
  const list = (l: CalendarEvent[]) => html`${l.map((e) => evCard(e, st.get(e)))}`;
  return html`${list(today)}
    ${tomorrow.length ? html`<li class="muted small">${t("Nothing more today. Tomorrow:")}</li>${list(tomorrow)}`
      : ahead ? "" : html`<li class="muted small">${t("Nothing more today or tomorrow.")}</li>`}`;
}

async function loadCalendar(): Promise<void> {
  const box = $("#td-cal");
  if (!box) return;
  const now = new Date(), start = new Date(now);
  start.setHours(0, 0, 0, 0);
  try {
    const { events } = await api.calendar(ymd(start), ymd(new Date(start.getTime() + 86_400_000)));
    if ($("#td-cal")) mount(box, agenda(todayItems(events, now, who.person.id)));
  } catch {
    if ($("#td-cal")) mount(box, html`<li class="muted small">${t("The calendar did not answer.")}</li>`);
  }
}

// ---------------------------------------------------------------- wiring

export function stopToday(): void {
  if (timer) window.clearInterval(timer);
  timer = 0;
}

export function todayInit(): void {
  stopToday();
  const root = $(".td")!, on = cards();
  if (on.home) wireLists(root, say);
  root.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const hide = el.closest<HTMLButtonElement>("[data-hide]"), unhide = el.closest("[data-unhide]");
    if ((hide || unhide) && lastMine) {
      const s = hidden();
      if (hide) s.add(hide.dataset.hide!); else s.clear();
      setHidden(s);
      mount($("#td-health")!, health(lastMine));
      return;
    }
    const scene = el.closest<HTMLButtonElement>("[data-scene]");
    if (!scene || scene.disabled) return;
    scene.disabled = true;
    scene.classList.add("is-run");
    api.runScene(scene.dataset.scene!).then(() => say(""), (err: Error) => say(`${scene.textContent!.trim()}: ${err.message}`))
      .finally(() => { scene.disabled = false; window.setTimeout(() => scene.classList.remove("is-run"), 1200); });
  });
  if (on.health) void loadHealth();
  if (on.home) { void loadScenes(); void loadLists(); }
  if (on.calendar) void loadCalendar();
  // the lights count, the lists and the agenda stay current while the page is open; health changes rarely
  let round = 0;
  timer = window.setInterval(() => {
    if (!$(".td")) return stopToday();
    if (document.hidden) return;
    const h = $("#td-hello");
    if (h) h.textContent = hello(who.person.name);
    if (on.home) { void loadScenes(); void loadLists(); }
    if (on.calendar && ++round % 10 === 0) void loadCalendar();
  }, 60_000);
}
