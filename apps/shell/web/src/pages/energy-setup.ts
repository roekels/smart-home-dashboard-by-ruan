// /dashboard/energy-setup (admins): which Home Assistant sensor is what. The page offers a guess from the sensors'
// names; nothing is saved until you press Save. Stored in D1, never in the code or the config.
import { html, mount, $, $$, type Raw } from "../html.ts";
import { call } from "../api.ts";
import { icon } from "../icons.ts";
import { t } from "../i18n.ts";
import { power } from "./energy.ts";

interface Sensor { entity: string; name: string; w?: number | null }
interface Config {
  solar: string[]; grid: string | null; gridInverted: boolean; battery: string | null; batteryInverted: boolean;
  batteryLevel: string | null; home: string | null; devices: { sensor: string; plug?: string }[];
}
interface Setup { error: string | null; sensors: Sensor[]; levels: Sensor[]; plugs: Sensor[]; config: Config; configured: boolean; suggestion: Config }

let data: Setup | null = null;

export function energySetupPage(): Raw {
  return html`
  <section class="page-head"><div><h1 class="h1">${t("Energy sensors")}</h1>
    <p class="muted">${t("Say which Home Assistant sensor measures what. The Energy page is worked out from these and nothing else.")}</p>
    <p class="banner" id="es-error" role="alert"></p></div></section>
  <div class="setup" id="es"><p class="muted small">${t("Loading …")}</p></div>`;
}

const options = (list: Sensor[], chosen: string | null | undefined, none: string): Raw =>
  html`<option value="">${none}</option>${list.map((s) => html`<option value="${s.entity}" ${s.entity === chosen ? html`selected` : ""}>${s.name}${s.w != null ? ` · ${power(s.w)}` : ""}</option>`)}`;

function view(s: Setup, c: Config): Raw {
  if (!s.sensors.length) return html`<section class="card pane"><p class="muted small">${s.error ?? t("Home Assistant has no power sensors (unit W or kW) yet.")}</p></section>`;
  const dev = new Map(c.devices.map((d) => [d.sensor, d.plug ?? ""]));
  return html`
  <section class="card pane" aria-label="${t("The house")}">
    <div class="pane__head"><h2 class="h2">${icon("home")}${t("The house")}</h2>
      ${s.configured ? "" : html`<span class="pill pill--amber">${t("a first guess, check it")}</span>`}</div>
    <div class="fields">
      <label class="field"><span>${t("Grid connection")}</span><select class="select" id="es-grid">${options(s.sensors, c.grid, t("None"))}</select></label>
      <label class="field"><span>${t("Battery power")}</span><select class="select" id="es-battery">${options(s.sensors, c.battery, t("None"))}</select></label>
      <label class="field"><span>${t("Battery charge (%)")}</span><select class="select" id="es-level">${options(s.levels, c.batteryLevel, t("None"))}</select></label>
      <label class="field"><span>${t("Whole house")}</span><select class="select" id="es-home">${options(s.sensors, c.home, t("Work it out"))}</select></label>
    </div>
    <div class="checks">
      <label class="check"><input type="checkbox" id="es-grid-inv" ${c.gridInverted ? html`checked` : ""}><span>${t("Grid sensor is negative when buying")}</span></label>
      <label class="check"><input type="checkbox" id="es-battery-inv" ${c.batteryInverted ? html`checked` : ""}><span>${t("Battery sensor is negative when charging")}</span></label>
    </div>
  </section>
  <section class="card pane" aria-label="${t("Solar panels")}">
    <div class="pane__head"><h2 class="h2">${icon("sunpanel")}${t("Solar panels")}</h2></div>
    <p class="muted small">${t("Tick every sensor that measures panels. They are added together.")}</p>
    <div class="checks">${s.sensors.map((x) => html`<label class="check" title="${x.entity}"><input type="checkbox" data-solar value="${x.entity}" ${c.solar.includes(x.entity) ? html`checked` : ""}><span>${x.name}</span><small>${power(x.w ?? null)}</small></label>`)}</div>
  </section>
  <section class="card pane" aria-label="${t("Devices")}">
    <div class="pane__head"><h2 class="h2">${icon("plug")}${t("Devices")}</h2></div>
    <p class="muted small">${t("Tick the sensors of single devices. If a device hangs on one of your plugs, say which, and the page shows when it is switched off.")}</p>
    <div>${s.sensors.map((x) => html`<div class="setup__row"><label class="check" title="${x.entity}"><input type="checkbox" data-device value="${x.entity}" ${dev.has(x.entity) ? html`checked` : ""}><span>${x.name}</span><small>${power(x.w ?? null)}</small></label>
      ${s.plugs.length ? html`<select class="select" data-plug-of="${x.entity}" aria-label="${t("Plug of {name}", { name: x.name })}">${options(s.plugs, dev.get(x.entity), t("No plug"))}</select>` : html`<span></span>`}</div>`)}</div>
  </section>
  <div class="setup__save"><button class="btn btn--ink" id="es-save">${icon("check")}${t("Save")}</button>
    <button class="btn btn--line" id="es-guess">${icon("spark")}${t("Start from the guess")}</button><span class="muted small" id="es-saved" role="status"></span></div>`;
}

function read(box: HTMLElement): Config {
  const val = (id: string) => $<HTMLSelectElement>(id, box)?.value || null;
  return {
    solar: $$<HTMLInputElement>("[data-solar]:checked", box).map((i) => i.value),
    grid: val("#es-grid"), gridInverted: !!$<HTMLInputElement>("#es-grid-inv", box)?.checked,
    battery: val("#es-battery"), batteryInverted: !!$<HTMLInputElement>("#es-battery-inv", box)?.checked,
    batteryLevel: val("#es-level"), home: val("#es-home"),
    devices: $$<HTMLInputElement>("[data-device]:checked", box).map((i) => {
      const plug = $<HTMLSelectElement>(`[data-plug-of="${i.value}"]`, box)?.value;
      return plug ? { sensor: i.value, plug } : { sensor: i.value };
    }),
  };
}

export function energySetupInit(): void {
  const box = $("#es")!, say = (m: string) => { const e = $("#es-error"); if (e) e.textContent = m; };
  data = null;
  call<Setup>("GET", "/energy/setup").then((s) => {
    if (!$("#es")) return;
    data = s;
    mount(box, view(s, s.configured ? s.config : s.suggestion));
    if (s.error) say(t("Home Assistant: {error}", { error: s.error }));
  }, (e: Error) => { mount(box, html``); say(e.message); });
  box.addEventListener("click", async (e) => {
    const el = e.target as HTMLElement;
    if (el.closest("#es-guess") && data) { mount(box, view(data, data.suggestion)); return; }
    const b = el.closest<HTMLButtonElement>("#es-save");
    if (!b) return;
    b.disabled = true;
    try {
      await call("POST", "/energy/setup", read(box));
      say(""); $("#es-saved")!.textContent = t("Saved. The Energy page follows within a minute.");
    } catch (err) { say((err as Error).message); } finally { b.disabled = false; }
  });
}
