// /dashboard/home-assistant (admins): is the way to Home Assistant working, and what do its things mean here?
// Nothing about a household's entities is written in the code or the config: whose list is whose, which switches
// are plugs, which scripts sit with the scenes and which lights stay hidden is chosen here and stored in D1.
import { html, mount, $, $$, type Raw } from "../html.ts";
import { call, ago } from "../api.ts";
import { icon } from "../icons.ts";
import { t } from "../i18n.ts";

interface Named { entity: string; name: string }
interface Setup {
  configured: { address: boolean; token: boolean; serviceToken: boolean; database: boolean };
  ready: boolean; reachable: boolean; error: string | null; ts: number | null;
  counts: { lights: number; scenes: number; lists: number };
  lists: Named[]; switches: Named[]; scripts: Named[]; lights: Named[];
  people: { id: string; name: string }[];
  settings: { lists: Record<string, string>; plugs: string[]; scripts: string[]; hiddenLights: string[] };
}

export function haSetupPage(): Raw {
  return html`
  <section class="page-head"><div><h1 class="h1">${t("Home Assistant")}</h1>
    <p class="muted">${t("The connection into your home, and what the things in Home Assistant mean on this dashboard.")}</p>
    <p class="banner" id="hs-error" role="alert"></p></div></section>
  <div class="setup" id="hs"><p class="muted small">${t("Loading …")}</p></div>`;
}

const fact = (ok: boolean, text: string): Raw => html`<li>${icon(ok ? "check" : "x", `i ${ok ? "ok" : "bad"}`)}<span>${text}</span></li>`;

const checks = (group: string, all: Named[], chosen: string[], empty: string): Raw => all.length
  ? html`<div class="checks">${all.map((x) => html`<label class="check" title="${x.entity}"><input type="checkbox" data-group="${group}" value="${x.entity}" ${chosen.includes(x.entity) ? html`checked` : ""}><span>${x.name}</span></label>`)}</div>`
  : html`<p class="muted small">${empty}</p>`;

function view(s: Setup): Raw {
  return html`
  <section class="card pane" aria-label="${t("Connection")}">
    <div class="pane__head"><h2 class="h2">${icon("link")}${t("Connection")}</h2>
      <span class="pill ${s.reachable ? "pill--green" : "pill--rose"}">${s.reachable ? t("connected") : t("not connected")}</span></div>
    <ul class="facts">
      ${fact(s.configured.address, t("Tunnel address is set (HA_URL)"))}
      ${fact(s.configured.serviceToken, t("Access service token is set (HA_TUNNEL_SERVICE_TOKEN_ID and _KEY)"))}
      ${fact(s.configured.token, t("Home Assistant token is set (HA_API_LONGLIVED_TOKEN)"))}
      ${fact(s.configured.database, t("Database is bound (HOME_DB)"))}
      ${fact(s.reachable, s.reachable ? t("Home Assistant answered {when}: {lights} lights, {scenes} scenes, {lists} lists", { when: ago(s.ts), ...s.counts }) : (s.error ?? t("Home Assistant did not answer")))}
    </ul>
    ${s.ready ? "" : html`<p class="muted small">${t("Ask your AI to finish the Home Assistant setup: it creates the tunnel hostname and the service token and tells you where to paste the Home Assistant token.")}</p>`}
  </section>
  <section class="card pane" aria-label="${t("Lists")}">
    <div class="pane__head"><h2 class="h2">${icon("list")}${t("Lists")}</h2></div>
    <p class="muted small">${t("Who sees each to-do list on Today. A list you do not assign is shown to admins only.")}</p>
    <div>${s.lists.length ? s.lists.map((l) => html`<label class="setup__row"><span>${l.name}<small>${l.entity}</small></span>
      <select class="select" data-list="${l.entity}">
        ${[["", t("Admins only")], ["shared", t("Everyone (shared)")], ...s.people.map((p) => [p.id, p.name]), ["hidden", t("Hidden")]].map(([v, label]) =>
          html`<option value="${v}" ${(s.settings.lists[l.entity] ?? "") === v ? html`selected` : ""}>${label}</option>`)}
      </select></label>`) : html`<p class="muted small">${t("No to-do lists in Home Assistant yet.")}</p>`}</div>
  </section>
  <section class="card pane" aria-label="${t("Plugs")}">
    <div class="pane__head"><h2 class="h2">${icon("plug")}${t("Plugs")}</h2></div>
    <p class="muted small">${t("Only the switches you tick can be switched from the dashboard. Leave child locks and other setting switches unticked.")}</p>
    ${checks("plugs", s.switches, s.settings.plugs, t("No switches in Home Assistant."))}
  </section>
  <section class="card pane" aria-label="${t("Scripts shown with the scenes")}">
    <div class="pane__head"><h2 class="h2">${icon("play")}${t("Scripts shown with the scenes")}</h2></div>
    <p class="muted small">${t("Every scene is shown. A script only when you tick it here; no other script can be started from the dashboard.")}</p>
    ${checks("scripts", s.scripts, s.settings.scripts, t("No scripts in Home Assistant."))}
  </section>
  <section class="card pane" aria-label="${t("Hidden lights")}">
    <div class="pane__head"><h2 class="h2">${icon("eye")}${t("Hidden lights")}</h2></div>
    <p class="muted small">${t("Tick what should stay off the pages, such as status lights of devices.")}</p>
    ${checks("hiddenLights", s.lights, s.settings.hiddenLights, t("No lights in Home Assistant."))}
  </section>
  <div class="setup__save"><button class="btn btn--ink" id="hs-save">${icon("check")}${t("Save")}</button><span class="muted small" id="hs-saved" role="status"></span></div>`;
}

export function haSetupInit(): void {
  const box = $("#hs")!, say = (m: string) => { const e = $("#hs-error"); if (e) e.textContent = m; };
  call<Setup>("GET", "/ha/setup").then((s) => { if ($("#hs")) mount(box, view(s)); }, (e: Error) => { mount(box, html``); say(e.message); });
  box.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("#hs-save");
    if (!b) return;
    const picked = (g: string) => $$<HTMLInputElement>(`[data-group="${g}"]:checked`, box).map((i) => i.value);
    const lists = Object.fromEntries($$<HTMLSelectElement>("[data-list]", box).filter((x) => x.value).map((x) => [x.dataset.list!, x.value]));
    b.disabled = true;
    try {
      await call("POST", "/ha/setup", { lists, plugs: picked("plugs"), scripts: picked("scripts"), hiddenLights: picked("hiddenLights") });
      say(""); $("#hs-saved")!.textContent = t("Saved.");
    } catch (err) { say((err as Error).message); } finally { b.disabled = false; }
  });
}
