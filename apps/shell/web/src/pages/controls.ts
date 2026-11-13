// /home/controls: every light as a tile (tap to switch, drag to dim), the scenes, and the switches the household
// chose as plugs. Reads GET /api/ha every 20 seconds; a change shows at once and the next reading confirms it.
// A plug asks for a second tap before it switches off: something may depend on it.
import { html, mount, $, $$, type Raw } from "../html.ts";
import { api, ago, who, type HomeControls, type HomeLight } from "../api.ts";
import { icon } from "../icons.ts";
import { hasPage } from "../routes.ts";
import { t, n } from "../i18n.ts";
import { sceneIcon } from "./today.ts";

let timer = 0, busy = 0, last: HomeControls | null = null;

const say = (msg: string) => { const e = $("#hc-error"); if (e) e.textContent = msg; };

export function controlsPage(): Raw {
  return html`
  <div class="hc">
    <section class="page-head">
      <div><h1 class="h1">${t("Lights")}</h1><p class="banner" id="hc-error" role="alert"></p></div>
      <div class="chips" id="hc-chips"></div>
    </section>
    <section aria-labelledby="hc-scenes-h"><h2 class="h2" id="hc-scenes-h">${icon("spark")}${t("Scenes")}</h2>
      <div class="scenes" id="hc-scenes"><p class="muted small">${t("Loading …")}</p></div></section>
    <section class="card room" aria-labelledby="hc-lights-h">
      <header class="room__head"><h3 id="hc-lights-h">${t("Lights")}</h3>
        <button class="btn btn--line btn--sm" id="hc-all-off" hidden>${icon("power")}${t("All off")}</button></header>
      <div class="tiles" id="hc-lights"></div>
    </section>
    <section class="card room" id="hc-plugs-box" aria-labelledby="hc-plugs-h" hidden>
      <header class="room__head"><h3 id="hc-plugs-h">${t("Plugs")}</h3></header>
      <div class="list" id="hc-plugs"></div>
    </section>
    ${who.person.admin && hasPage("/dashboard/home-assistant") ? html`<p class="muted small">${t("Which switches are plugs, and which lights stay hidden, is set under")} <a href="/dashboard/home-assistant">${t("Settings > Home Assistant")}</a>.</p>` : ""}
  </div>`;
}

const lightSub = (l: HomeLight): string => (l.unavailable ? t("not reachable") : l.on ? (l.brightness ? `${l.brightness} %` : t("on")) : t("off"));

/** One light. `cls` lets the wall tablet draw the same tile larger. */
export function lightTile(l: HomeLight, cls = "tile"): Raw {
  const big = cls !== "tile";
  const inner = html`${icon("bulb")}<b>${l.name}</b><small>${lightSub(l)}</small>`;
  if (big) return html`<button class="${cls}${l.on ? " is-on" : ""}" data-light="${l.entity}" aria-pressed="${String(l.on)}" ${l.color ? html`data-tint="${l.color}"` : ""} ${l.unavailable ? html`disabled` : ""}>${inner}</button>`;
  return html`<div class="tile${l.on ? " is-on" : ""}" ${l.color ? html`data-tint="${l.color}"` : ""}>
    <button class="tile__btn" data-light="${l.entity}" aria-pressed="${String(l.on)}" ${l.unavailable ? html`disabled` : ""}>${inner}</button>
    ${l.on && l.brightness !== undefined ? html`<input class="dim" type="range" min="1" max="100" value="${l.brightness}" data-dim="${l.entity}" aria-label="${t("Brightness of {name}", { name: l.name })}">` : ""}
  </div>`;
}

/** The lit lamps wear their colour. Set from script: the page's security policy allows no style attributes. */
export function applyTints(root: ParentNode): void {
  $$<HTMLElement>("[data-tint]", root).forEach((el) => el.style.setProperty("--tint", el.dataset.tint!));
}

function draw(c: HomeControls): void {
  if (!$("#hc-lights")) return;
  last = c;
  const on = c.lights.filter((l) => l.on && !l.unavailable).length;
  mount($("#hc-chips")!, html`<span class="chip">${icon("bulb")}<b>${n(on, "light on", "lights on")}</b></span>
    <span class="chip">${icon("clock")}${c.ts ? ago(c.ts) : t("no reading yet")}</span>`);
  mount($("#hc-scenes")!, c.scenes.length
    ? html`${c.scenes.map((s) => html`<button class="scene" data-scene="${s.entity}">${icon(sceneIcon(s.name))}<span>${s.name}</span></button>`)}`
    : html`<p class="muted small">${t("No scenes in Home Assistant yet.")}</p>`);
  mount($("#hc-lights")!, c.lights.length ? html`${c.lights.map((l) => lightTile(l))}` : html`<p class="muted small">${t("No lights found in Home Assistant.")}</p>`);
  $("#hc-all-off")!.hidden = on === 0;
  $("#hc-plugs-box")!.hidden = !c.plugs.length;
  mount($("#hc-plugs")!, html`${c.plugs.map((p) => html`<div class="list__row"><span class="chip-ic">${icon("plug")}</span>
    <span class="list__txt"><b>${p.name}</b><small>${p.unavailable ? t("not reachable") : p.on ? t("on") : t("off")}</small></span>
    <button class="toggle" role="switch" aria-checked="${String(p.on)}" aria-label="${p.name}" data-plug="${p.entity}" ${p.unavailable ? html`disabled` : ""}><i></i></button></div>`)}`);
  applyTints($(".hc")!);
  say(c.error ? t("Home Assistant: {error}", { error: c.error }) : "");
}

async function load(): Promise<void> {
  if (busy || document.activeElement?.matches(".dim")) return;
  try { draw(await api.home()); } catch (e) { say(t("Could not reach Home Assistant: {error}", { error: (e as Error).message })); }
}

async function act(what: () => Promise<unknown>, change?: (c: HomeControls) => void): Promise<void> {
  busy++;
  if (last && change) { change(last); draw(last); }
  try { await what(); say(""); } catch (e) { say((e as Error).message); } finally { busy--; }
  window.setTimeout(load, change ? 1500 : 0);
}

/** A scene button shows that it ran for a moment. Shared with the wall tablet. */
export function flash(b: HTMLElement): void {
  b.classList.add("is-run");
  window.setTimeout(() => b.classList.remove("is-run"), 1400);
}

export function controlsLeave(): void {
  if (timer) window.clearInterval(timer);
  timer = 0;
}

export function controlsInit(): void {
  controlsLeave();
  busy = 0; last = null;
  const root = $(".hc")!;
  root.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const light = el.closest<HTMLButtonElement>("[data-light]"), scene = el.closest<HTMLButtonElement>("[data-scene]"), plug = el.closest<HTMLButtonElement>("[data-plug]");
    if (light) {
      const entity = light.dataset.light!, on = light.getAttribute("aria-pressed") !== "true";
      void act(() => api.setLight(entity, on), (c) => { const l = c.lights.find((x) => x.entity === entity); if (l) { l.on = on; if (!on) delete l.color; } });
    } else if (scene) {
      flash(scene);
      void act(() => api.runScene(scene.dataset.scene!));
    } else if (plug) {
      const entity = plug.dataset.plug!, on = plug.getAttribute("aria-checked") !== "true";
      if (!on && plug.dataset.armed !== "1") {
        plug.dataset.armed = "1";
        plug.insertAdjacentHTML("afterbegin", html`<span class="toggle__ask">${t("Tap again to switch off")}</span>`.s);
        window.setTimeout(() => { delete plug.dataset.armed; plug.querySelector(".toggle__ask")?.remove(); }, 4000);
        return;
      }
      void act(() => api.setPlug(entity, on), (c) => { const p = c.plugs.find((x) => x.entity === entity); if (p) p.on = on; });
    } else if (el.closest("#hc-all-off") && last) {
      const list = last.lights.filter((l) => l.on && !l.unavailable).map((l) => l.entity);
      if (list.length) void act(() => api.setLight(list, false), (c) => c.lights.forEach((l) => { if (list.includes(l.entity)) { l.on = false; delete l.color; } }));
    }
  });
  root.addEventListener("change", (e) => {
    const dim = (e.target as HTMLElement).closest<HTMLInputElement>("[data-dim]");
    if (!dim) return;
    const entity = dim.dataset.dim!, b = Number(dim.value);
    dim.blur();
    void act(() => api.setLight(entity, true, b), (c) => { const l = c.lights.find((x) => x.entity === entity); if (l) l.brightness = b; });
  });
  void load();
  timer = window.setInterval(load, 20_000);
}
