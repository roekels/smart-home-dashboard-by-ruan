// /home/energy: what the house makes, uses, stores and buys right now, today's totals, the last 24 hours and the
// devices that draw the most. Everything comes from Home Assistant sensors through GET /api/energy.
import { html, mount, $, type Raw } from "../html.ts";
import { api, ago, who, type EnergyNow, type EnergyDay } from "../api.ts";
import { icon } from "../icons.ts";
import { hasPage } from "../routes.ts";
import { t, loc } from "../i18n.ts";

let timer = 0, shown: EnergyNow | null = null;

/** 840 -> "840 W", 2350 -> "2.35 kW". */
export function power(w: number | null): string {
  if (w === null) return "–";
  const a = Math.abs(w);
  return a >= 1000 ? `${(a / 1000).toLocaleString(loc(), { maximumFractionDigits: 2 })} kW` : `${Math.round(a)} W`;
}
const kwh = (v: number) => `${v.toLocaleString(loc(), { maximumFractionDigits: 1 })} kWh`;
const clock = (ms: number) => new Date(ms).toLocaleTimeString(loc(), { hour: "2-digit", minute: "2-digit", timeZone: who.timezone });

export function energyPage(): Raw {
  return html`
  <div class="en">
    <section class="page-head"><div><h1 class="h1">${t("Energy")}</h1><p class="banner" id="en-error" role="alert"></p></div>
      <span class="chip" id="en-when"></span></section>
    <div id="en-body"><p class="muted small">${t("Loading …")}</p></div>
  </div>`;
}

const kpi = (ic: string, value: string, label: string): Raw =>
  html`<div class="card kpi"><span class="chip-ic">${icon(ic)}</span><div><b>${value}</b><small>${label}</small></div></div>`;

function kpis(e: EnergyNow): Raw {
  const n = e.now, out: Raw[] = [];
  if (n.solar !== null) out.push(kpi("sunpanel", power(n.solar), t("Solar")));
  if (n.home !== null) out.push(kpi("home", power(n.home), t("Home is using")));
  if (n.grid !== null) out.push(kpi("bolt", power(n.grid), n.grid < 0 ? t("Feeding into the grid") : t("From the grid")));
  if (n.battery !== null || n.level !== null) {
    const what = n.battery === null || Math.abs(n.battery) < 5 ? t("Battery") : n.battery > 0 ? t("Battery, charging") : t("Battery, in use");
    out.push(kpi("battery", n.level !== null ? `${n.level} %` : power(n.battery), n.level !== null && n.battery !== null && Math.abs(n.battery) >= 5 ? `${what} · ${power(n.battery)}` : what));
  }
  return html`<div class="kpis">${out}</div>`;
}

const day = (d: EnergyDay, label: string): Raw => html`
  <section class="card pane" aria-label="${label}"><div class="pane__head"><h2 class="h2">${icon("calendar")}${label}</h2></div>
  <div class="en__days">
    <div class="en__day"><b>${kwh(d.solar)}</b><small>${t("solar made")}</small></div>
    <div class="en__day"><b>${kwh(d.home)}</b><small>${t("used at home")}</small></div>
    <div class="en__day"><b>${kwh(d.imported)}</b><small>${t("from the grid")}</small></div>
    <div class="en__day"><b>${kwh(d.exported)}</b><small>${t("fed into the grid")}</small></div>
  </div></section>`;

// ---- the chart: solar and home in watts on one axis, the last 24 hours. Hover or touch for the values.
const W = 720, H = 220, L = 46, R = 10, T = 10, B = 24;

function niceMax(v: number): number {
  const step = [200, 500, 1000, 2000, 5000, 10000, 20000, 50000].find((s) => v <= s * 4) ?? 100000;
  return Math.max(step, Math.ceil(v / step) * step);
}

interface Scale { t0: number; t1: number; max: number; x: (t: number) => number; y: (w: number) => number }

function scale(e: EnergyNow): Scale {
  const pts = e.series, t1 = pts[pts.length - 1].t, t0 = Math.min(pts[0].t, t1 - 3600_000);
  const max = niceMax(Math.max(100, ...pts.map((p) => Math.max(p.solar ?? 0, p.home ?? 0))));
  return { t0, t1, max, x: (tt) => L + ((tt - t0) / (t1 - t0)) * (W - L - R), y: (w) => T + (1 - Math.max(0, w) / max) * (H - T - B) };
}

function path(e: EnergyNow, s: Scale, k: "solar" | "home"): string {
  let d = "", pen = false, prev = 0;
  for (const p of e.series) {
    const v = p[k];
    if (v === null) { pen = false; continue; }
    // a gap of more than half an hour is drawn as a gap, not as a line across it
    if (pen && p.t - prev > 30 * 60_000) pen = false;
    d += `${pen ? "L" : "M"}${s.x(p.t).toFixed(1)} ${s.y(v).toFixed(1)}`;
    pen = true; prev = p.t;
  }
  return d;
}

function chart(e: EnergyNow): Raw {
  if (e.series.length < 2) return html`<p class="muted small">${t("The chart fills in as readings come in, one every minute.")}</p>`;
  const s = scale(e), has = (k: "solar" | "home") => e.series.some((p) => p[k] !== null);
  const ticks = [0, 0.5, 1].map((f) => f * s.max);
  const hours: number[] = [];
  for (let h = Math.ceil(s.t0 / (6 * 3600_000)) * 6 * 3600_000; h <= s.t1; h += 6 * 3600_000) hours.push(h);
  return html`
  <div class="chart" id="en-chart">
    <div class="legend">${has("solar") ? html`<span><i class="key key--solar"></i>${t("Solar")}</span>` : ""}${has("home") ? html`<span><i class="key key--home"></i>${t("Home")}</span>` : ""}</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${t("Solar and home power over the last 24 hours, in watts")}">
      ${ticks.map((v) => html`<line class="chart__grid" x1="${L}" x2="${W - R}" y1="${s.y(v)}" y2="${s.y(v)}"/><text class="chart__axis" x="${L - 8}" y="${s.y(v) + 4}" text-anchor="end">${power(v)}</text>`)}
      ${hours.map((h) => html`<text class="chart__axis" x="${s.x(h)}" y="${H - 6}" text-anchor="middle">${clock(h)}</text>`)}
      ${has("solar") ? html`<path class="chart__line chart__line--solar" d="${path(e, s, "solar")}"/>` : ""}
      ${has("home") ? html`<path class="chart__line chart__line--home" d="${path(e, s, "home")}"/>` : ""}
      <g id="en-hover" hidden><line class="chart__cross" y1="${T}" y2="${H - B}"/><circle class="chart__dot chart__dot--solar" r="5"/><circle class="chart__dot chart__dot--home" r="5"/></g>
      <rect id="en-hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
    </svg>
    <div class="chart__tip" id="en-tip" hidden></div>
    <details class="small"><summary class="muted">${t("Show as a table")}</summary><div class="table-wrap"><table class="table">
      <thead><tr><th>${t("Time")}</th><th>${t("Solar")}</th><th>${t("Home")}</th><th>${t("Grid")}</th></tr></thead>
      <tbody>${e.series.filter((p) => new Date(p.t).getUTCMinutes() === 0).map((p) => html`<tr><td>${clock(p.t)}</td><td>${power(p.solar)}</td><td>${power(p.home)}</td><td>${p.grid === null ? "–" : `${p.grid < 0 ? "−" : ""}${power(p.grid)}`}</td></tr>`)}</tbody>
    </table></div></details>
  </div>`;
}

function hover(ev: PointerEvent): void {
  const e = shown, svg = $<SVGSVGElement>("#en-chart svg"), g = $<SVGGElement>("#en-hover"), tip = $("#en-tip");
  if (!e || !svg || !g || !tip || e.series.length < 2) return;
  const s = scale(e), box = svg.getBoundingClientRect();
  const tt = s.t0 + ((((ev.clientX - box.left) / box.width) * W - L) / (W - L - R)) * (s.t1 - s.t0);
  const p = e.series.reduce((a, b) => (Math.abs(b.t - tt) < Math.abs(a.t - tt) ? b : a));
  const x = s.x(p.t), line = g.querySelector("line")!, dots = g.querySelectorAll("circle");
  line.setAttribute("x1", String(x)); line.setAttribute("x2", String(x));
  ([["solar", dots[0]], ["home", dots[1]]] as const).forEach(([k, dot]) => {
    const v = p[k];
    dot.toggleAttribute("hidden", v === null);
    if (v !== null) { dot.setAttribute("cx", String(x)); dot.setAttribute("cy", String(s.y(v))); }
  });
  g.removeAttribute("hidden");
  mount(tip, html`<b>${clock(p.t)}</b>${p.solar !== null ? html`<span><i class="key key--solar"></i>${t("Solar")} ${power(p.solar)}</span>` : ""}${p.home !== null ? html`<span><i class="key key--home"></i>${t("Home")} ${power(p.home)}</span>` : ""}`);
  tip.hidden = false;
  const px = (x / W) * box.width, left = px > box.width / 2 ? px - tip.offsetWidth - 12 : px + 12;
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(svg.getBoundingClientRect().top - $("#en-chart")!.getBoundingClientRect().top + 8)}px)`;
}

function unhover(): void {
  $("#en-hover")?.setAttribute("hidden", "");
  const tip = $("#en-tip");
  if (tip) tip.hidden = true;
}

function devices(e: EnergyNow): Raw | string {
  const list = e.now.devices;
  if (!list.length) return "";
  const top = Math.max(1, ...list.map((d) => d.w ?? 0), e.now.other ?? 0);
  const row = (name: string, w: number | null, state?: string): Raw => html`<li class="dev"><b>${name}</b>${state ? html`<span class="pill">${state}</span>` : html`<span></span>`}<span class="dev__w">${power(w)}</span>
    <span class="dev__bar"><i data-p="${Math.round((Math.max(0, w ?? 0) / top) * 100)}"></i></span></li>`;
  return html`<section class="card pane" aria-label="${t("Devices")}"><div class="pane__head"><h2 class="h2">${icon("plug")}${t("Devices")}</h2></div>
    <ul class="devs">${list.map((d) => row(d.name, d.w, d.on === false ? t("off") : undefined))}${e.now.other !== null ? row(t("Everything else"), e.now.other) : ""}</ul></section>`;
}

function draw(e: EnergyNow): void {
  const body = $("#en-body");
  if (!body) return;
  shown = e;
  $("#en-when")!.textContent = e.ts ? ago(e.ts) : "";
  $("#en-error")!.textContent = e.error && e.configured ? t("Home Assistant: {error}", { error: e.error }) : "";
  if (!e.configured) {
    mount(body, html`<section class="card pane"><h2 class="h2 h2--plain">${icon("sunpanel")}${t("No sensors chosen yet")}</h2>
      <p class="muted small">${who.person.admin && hasPage("/dashboard/energy-setup")
        ? html`${t("Say which Home Assistant sensor is solar, grid and battery under")} <a href="/dashboard/energy-setup">${t("Settings > Energy sensors")}</a>.`
        : t("An admin of your household chooses the sensors in Settings.")}</p></section>`);
    return;
  }
  mount(body, html`<div class="en">${kpis(e)}
    <section class="card pane" aria-label="${t("Last 24 hours")}"><div class="pane__head"><h2 class="h2">${icon("activity")}${t("Last 24 hours")}</h2></div>${chart(e)}</section>
    ${e.today ? day(e.today, t("Today")) : ""}${e.yesterday ? day(e.yesterday, t("Yesterday")) : ""}${devices(e)}</div>`);
  body.querySelectorAll<HTMLElement>("[data-p]").forEach((el) => el.style.setProperty("--p", el.dataset.p!));
  const hit = $("#en-hit");
  hit?.addEventListener("pointermove", hover as EventListener);
  hit?.addEventListener("pointerdown", hover as EventListener);
  hit?.addEventListener("pointerleave", unhover);
}

async function load(): Promise<void> {
  if ($("#en-tip") && !$("#en-tip")!.hidden) return; // never redraw under a reading finger
  try { draw(await api.energy()); } catch (e) { const el = $("#en-error"); if (el) el.textContent = (e as Error).message; }
}

export function energyLeave(): void {
  if (timer) window.clearInterval(timer);
  timer = 0; shown = null;
}

export function energyInit(): void {
  energyLeave();
  void load();
  timer = window.setInterval(load, 30_000);
}
