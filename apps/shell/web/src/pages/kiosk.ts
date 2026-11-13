// /kiosk: the page a tablet on the wall shows. Full screen, big touch targets, swipe between views:
// a clock, the lights and scenes, the shared lists, the energy picture. A paired tablet (who.kiosk) has no way out
// of this page; a signed-in person looking at it from the dashboard gets a close button.
import { html, mount, $, $$, type Raw } from "../html.ts";
import { api, hasModule, who, type CalendarEvent, type EnergyNow, type HomeControls } from "../api.ts";
import { icon } from "../icons.ts";
import { evCard, evStateMap } from "../event-card.ts";
import { t, loc } from "../i18n.ts";
import { listsSection, loadLists, wireLists } from "../lists.ts";
import { sceneIcon } from "./today.ts";
import { applyTints, flash, lightTile } from "./controls.ts";
import { power } from "./energy.ts";

let timers: number[] = [], home: HomeControls | null = null, busy = 0;

interface View { id: string; label: string; view: () => Raw }

function views(): View[] {
  const out: View[] = [{ id: "clock", label: t("Now"), view: () => html`
    <p class="kiosk__date" id="k-date"></p><p class="kiosk__clock" id="k-clock"></p>
    <div class="kiosk__chips" id="k-chips"></div>
    <ul class="agenda" id="k-cal"></ul>` }];
  if (hasModule("homeAssistant")) {
    out.push({ id: "lights", label: t("Lights"), view: () => html`
      <div class="kiosk__scenes" id="k-scenes"></div><div class="kiosk__tiles" id="k-lights"></div>` });
    out.push({ id: "lists", label: t("Lists"), view: () => listsSection() });
  }
  if (hasModule("energy")) out.push({ id: "energy", label: t("Energy"), view: () => html`<h2 class="kiosk__h">${t("Energy")}</h2><div class="kiosk__tiles kiosk__tiles--stats" id="k-energy"></div>` });
  return out;
}

export function kioskPage(): Raw {
  const v = views();
  return html`
  <div class="kiosk">
    <header class="kiosk__top-bar">
      <nav class="kiosk__dots" aria-label="${t("Views")}">${v.map((x, i) => html`<button data-view="${i}" aria-current="${String(i === 0)}"><span>${x.label}</span></button>`)}</nav>
      <div class="kiosk__acts">${who.kiosk ? "" : html`<a class="kiosk__exit" href="/home" aria-label="${t("Close")}">${icon("x")}</a>`}</div>
    </header>
    <div class="kiosk__track" id="k-track" tabindex="-1">${v.map((x) => html`<section class="kiosk__page${x.id === "clock" || x.id === "energy" ? " kiosk__page--center" : ""}" data-id="${x.id}">${x.view()}<p class="kiosk__note" data-note role="status"></p></section>`)}</div>
  </div>`;
}

const note = (msg: string) => $$("[data-note]").forEach((e) => { e.textContent = msg; });

function tick(): void {
  const now = new Date(), c = $("#k-clock"), d = $("#k-date");
  if (c) c.textContent = now.toLocaleTimeString(loc(), { hour: "2-digit", minute: "2-digit", timeZone: who.timezone });
  if (d) d.textContent = now.toLocaleDateString(loc(), { weekday: "long", day: "numeric", month: "long", timeZone: who.timezone });
}

let energy: EnergyNow | null = null;
function chips(): void {
  const box = $("#k-chips");
  if (!box) return;
  const out: Raw[] = [];
  if (home) out.push(html`<div class="kiosk__chip">${icon("bulb")}<b>${home.lights.filter((l) => l.on && !l.unavailable).length}</b><small>${t("lights on")}</small></div>`);
  if (energy?.configured && energy.now.solar !== null) out.push(html`<div class="kiosk__chip">${icon("sunpanel")}<b>${power(energy.now.solar)}</b><small>${t("solar")}</small></div>`);
  if (energy?.configured && energy.now.home !== null) out.push(html`<div class="kiosk__chip">${icon("home")}<b>${power(energy.now.home)}</b><small>${t("in use")}</small></div>`);
  mount(box, html`${out}`);
}

async function loadHome(): Promise<void> {
  if (busy) return;
  try {
    home = await api.home();
    const sc = $("#k-scenes"), li = $("#k-lights");
    if (sc) mount(sc, html`${home.scenes.map((s) => html`<button class="kiosk__scene" data-scene="${s.entity}">${icon(sceneIcon(s.name))}<span>${s.name}</span></button>`)}`);
    if (li) { mount(li, html`${home.lights.map((l) => lightTile(l, "kiosk__tile"))}`); applyTints(li); }
    chips();
    note(home.error ? t("Home Assistant: {error}", { error: home.error }) : "");
  } catch (e) { note((e as Error).message); }
}

async function loadEnergy(): Promise<void> {
  try {
    energy = await api.energy();
    const box = $("#k-energy"), e = energy.now;
    if (box) {
      const stat = (ic: string, v: string, label: string): Raw => html`<div class="kiosk__stat">${icon(ic)}<b>${v}</b><small>${label}</small></div>`;
      mount(box, energy.configured ? html`
        ${e.solar !== null ? stat("sunpanel", power(e.solar), t("solar")) : ""}
        ${e.home !== null ? stat("home", power(e.home), t("in use")) : ""}
        ${e.grid !== null ? stat("bolt", power(e.grid), e.grid < 0 ? t("feeding in") : t("from the grid")) : ""}
        ${e.level !== null ? stat("battery", `${e.level} %`, t("battery")) : ""}` : html`<p class="kiosk__note">${t("No energy sensors chosen yet.")}</p>`);
    }
    chips();
  } catch { /* the next round tries again */ }
}

async function loadCalendar(): Promise<void> {
  const box = $("#k-cal");
  if (!box) return;
  const now = new Date(), ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  try {
    const { events } = await api.calendar(ymd(now), ymd(new Date(now.getTime() + 86_400_000)));
    const nowS = `${ymd(now)}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    // the wall tablet is a shared screen: only the shared calendar goes on it
    const next: CalendarEvent[] = events.filter((e) => e.owner === null).filter((e) => e.all_day ? e.start.slice(0, 10) === ymd(now) : e.end > nowS).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 3);
    const st = evStateMap(next);
    mount(box, html`${next.map((e) => evCard(e, st.get(e)))}`);
  } catch { /* no calendar on this tablet: the clock stands alone */ }
}

export function kioskLeave(): void {
  timers.forEach((x) => window.clearInterval(x));
  timers = []; home = null; energy = null;
}

export function kioskInit(): void {
  kioskLeave();
  busy = 0;
  const root = $(".kiosk")!, track = $("#k-track")!, dots = $$<HTMLButtonElement>("[data-view]", root);
  dots.forEach((b) => b.addEventListener("click", () => track.scrollTo({ left: Number(b.dataset.view) * track.clientWidth, behavior: "smooth" })));
  track.addEventListener("scroll", () => {
    const at = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    dots.forEach((b, i) => b.setAttribute("aria-current", String(i === at)));
  }, { passive: true });
  root.addEventListener("click", (e) => {
    const el = e.target as HTMLElement, light = el.closest<HTMLButtonElement>("[data-light]"), scene = el.closest<HTMLButtonElement>("[data-scene]");
    if (!light && !scene) return;
    busy++;
    let job: Promise<unknown>;
    if (light) {
      const on = light.getAttribute("aria-pressed") !== "true";
      light.setAttribute("aria-pressed", String(on));
      light.classList.toggle("is-on", on);
      job = api.setLight(light.dataset.light!, on);
    } else { flash(scene!); job = api.runScene(scene!.dataset.scene!); }
    job.then(() => note(""), (err: Error) => note(err.message)).finally(() => { busy--; window.setTimeout(loadHome, 1500); });
  });
  tick();
  timers.push(window.setInterval(tick, 5000));
  if (hasModule("homeAssistant")) {
    wireLists(root, note);
    void loadHome(); void loadLists();
    timers.push(window.setInterval(loadHome, 20_000), window.setInterval(loadLists, 60_000));
  }
  if (hasModule("energy")) { void loadEnergy(); timers.push(window.setInterval(loadEnergy, 30_000)); }
  if (hasModule("calendar")) { void loadCalendar(); timers.push(window.setInterval(loadCalendar, 5 * 60_000)); }
  // a wall tablet runs for months: once a night it loads the page again, so it picks up a new version
  if (who.kiosk) timers.push(window.setInterval(() => { const h = new Date().getHours(), m = new Date().getMinutes(); if (h === 3 && m < 10) location.reload(); }, 10 * 60_000));
}
