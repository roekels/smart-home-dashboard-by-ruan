// Settings (the icon on the person's card in the menu). For everyone: how this device shows the dashboard and who
// is in the household. For an admin: the way into the management pages. The theme buttons are wired by the shell.
// In demo mode there is also a "Viewing as" switch, to look at the dashboard as each made-up person.
import { html, $, type Raw } from "../html.ts";
import { icon } from "../icons.ts";
import { call, who } from "../api.ts";
import { initial } from "../shell.ts";
import { t } from "../i18n.ts";

/** Module ids as people read them. A module not listed here shows its id. */
const MODULE_NAMES: Record<string, string> = {
  brain: "Brain", calendar: "Calendar", finance: "Finance", health: "Health", dataExport: "Data export",
  homeAssistant: "Home Assistant", energy: "Energy", kiosk: "Wall tablets", edgeAgents: "Edge agents", alfred: "Alfred",
};

export function settings(): Raw {
  return html`
  <section class="page-head">
    <div>
      <h1 class="h1">${t("Settings")}</h1>
      <p class="muted">${who.person.admin ? t("How this device shows the dashboard, and the pages that manage what runs behind it.") : t("How this device shows the dashboard.")}</p>
    </div>
  </section>
  <div class="set">
    <div class="set__col">
    <section class="card set__card" aria-label="${t("This device")}">
      <h2 class="h2">${icon("monitor")}${t("This device")}</h2>
      <div class="set__row">
        <span class="set__txt"><b>${t("Theme")}</b><small>${t("Light, dark, or whatever the device uses.")}</small></span>
        <div class="theme" role="group" aria-label="${t("Theme")}">
          <button data-theme-set="light">${icon("sun")}${t("Light")}</button>
          <button data-theme-set="dark">${icon("moon")}${t("Dark")}</button>
          <button data-theme-set="system">${icon("monitor")}${t("System")}</button>
        </div>
      </div>
    </section>
    ${who.manage.length ? html`
    <section class="card set__card" aria-label="${t("Management")}">
      <h2 class="h2">${icon("settings")}${t("Management")}</h2>
      ${who.manage.map((m) => html`
      <a class="set__row set__row--link" href="${m.path}">
        <span class="chip-ic">${icon(m.icon)}</span>
        <span class="set__txt"><b>${t(m.label)}</b><small>${t(m.text)}</small></span>
        ${icon("right", "i i--end")}
      </a>`)}
    </section>` : ""}
    </div>
    <section class="card set__card" aria-label="${t("Household")}">
      <h2 class="h2">${icon("users")}${who.household}</h2>
      <ul class="people" id="people">${who.people.map((p) => html`
        <li class="set__row">
          <span class="av" data-who="${p.n}">${initial(p.name)}</span>
          <span class="set__txt"><b>${p.name}</b>${p.id === who.person.id ? html`<small>${who.demo ? t("viewing as this person") : t("signed in on this device")}</small>` : ""}</span>
          ${who.demo && p.id !== who.person.id ? html`<button class="btn btn--line btn--sm" data-view-as="${p.id}">${t("View as")}</button>` : ""}
        </li>`)}</ul>
      <div class="set__row"><span class="set__txt"><b>${t("Modules")}</b><small>${who.modules.length ? t("What is switched on for this household.") : t("None switched on yet.")}</small></span></div>
      ${who.modules.length ? html`<div class="pills">${who.modules.map((m) => html`<span class="pill">${MODULE_NAMES[m] ?? m}</span>`)}</div>` : ""}
      <p class="muted small">${who.demo
        ? t("Demo mode: a made-up family. Changes are kept in memory only.")
        : t("People and modules are set in household.config.json in your repository. Ask your AI to change them.")}</p>
    </section>
  </div>`;
}

export function settingsInit(): void {
  $("#people")?.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-view-as]");
    if (!b) return;
    b.disabled = true;
    try {
      await call("POST", "/demo/person", { id: b.dataset.viewAs });
      location.href = "/home"; // everything is drawn for one person: start again as the other
    } catch {
      b.disabled = false;
    }
  });
}
