import { html, mount, $, $$, type Raw } from "./html.ts";
import { icon } from "./icons.ts";
import { mark } from "./mark.ts";
import { who, type NavItem } from "./api.ts";
import { SETTINGS } from "./routes.ts";
import { t } from "./i18n.ts";

// The frame around every page. One markup, three layouts (styles/app.css):
//   desktop  > 1100 px   full sidebar
//   tablet   701–1100    icon rail; the mark opens the full menu over the page
//   phone    <= 700      no sidebar: a dock with the menu button and the home pages
// No bar on top of the page: a page's own heading names it. The current page sits on a white pill that slides
// over from the last page's place (slideNav); the dock does the same.
// The menu comes from the Worker (GET /api/me): Home for everyone, Metrics for admins. Theme and the management
// pages sit behind the settings icon on the person's card (pages/settings.ts).

export type Theme = "light" | "dark" | "system";
export type Mode = "phone" | "tablet" | "desktop";

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* private mode: fine */ } },
};

/** Phone by width; tablet = a touch screen up to large-tablet size; everything else is a desktop. */
export function deviceMode(): Mode {
  if (window.innerWidth <= 700) return "phone";
  return matchMedia("(pointer: coarse)").matches && window.innerWidth <= 1400 ? "tablet" : "desktop";
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  store.set("theme", theme);
  $$<HTMLButtonElement>("[data-theme-set]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeSet === theme)));
}

export const savedTheme = (): Theme => (store.get("theme") as Theme) || "system";

function navLink(item: NavItem, active: string): Raw {
  const label = t(item.label), on = item.path === active;
  return html`<a href="${item.path}" class="nav${on ? " is-active" : ""}" title="${label}" ${on ? html`aria-current="page"` : ""}>
    ${icon(item.icon)}<span>${label}</span></a>`;
}

const isManage = (path: string): boolean => who.manage.some((m) => m.path === path);

function sidebar(active: string): Raw {
  const inSettings = active === SETTINGS || isManage(active);
  return html`
  <aside class="side" id="side" aria-label="${t("Menu")}">
    <div class="side__brand">
      <button class="side__logo" data-toggle-side aria-label="${t("Menu")}">${mark(34)}</button>
      <div class="side__name"><b>${who.household}</b><small>${t("Home")}</small></div>
      <button class="icon-btn side__close" data-close-side aria-label="${t("Close menu")}">${icon("x")}</button>
    </div>
    ${who.demo ? html`<span class="pill pill--amber side__demo">${t("Demo: made-up data")}</span>` : ""}
    ${who.nav.map((g) => html`
    <div class="side__label">${t(g.group)}</div>
    <nav class="side__nav" aria-label="${t(g.group)}">${g.items.map((n) => navLink(n, active))}</nav>`)}
    <div class="side__foot">
      <div class="me" title="${who.person.name}">
        <span class="me__av">${initial(who.person.name)}</span>
        <span class="me__txt"><b>${who.person.name}</b><small>${who.person.admin ? t("Admin") : t("Member")}</small></span>
        <a class="icon-btn me__set${inSettings ? " is-active" : ""}" href="${SETTINGS}" aria-label="${t("Settings")}" title="${t("Settings")}" ${inSettings ? html`aria-current="page"` : ""}>${icon("settings")}</a>
      </div>
    </div>
  </aside>`;
}

export const initial = (name: string): string => [...name.trim()][0]?.toUpperCase() ?? "?";

/** Settings' own pages get a way back above the page. */
function backLink(active: string): Raw | string {
  return isManage(active) ? html`<a class="back" href="${SETTINGS}">${icon("left")}<span>${t("Settings")}</span></a>` : "";
}

/** The phone dock: the menu button, then up to four home pages, one thumb away. */
const dockItems = (): NavItem[] => (who.nav.find((g) => g.group === "Home")?.items ?? []).slice(0, 4);
let lastDock = -1;

function dock(active: string): Raw {
  return html`<nav class="dock" id="dock" aria-label="${t("Home")}" data-at="${lastDock}"><i class="dock__ind" aria-hidden="true"></i>
    <button type="button" class="dock__menu" data-open-side aria-label="${t("Open menu")}">${icon("burger")}</button>${dockItems().map((d) =>
    html`<a href="${d.path}" class="${d.path === active ? "is-active" : ""}" ${d.path === active ? html`aria-current="page"` : ""}>${icon(d.icon)}<span>${t(d.label)}</span></a>`)}</nav>`;
}

/** The white pill is the current entry's own background (styles: .nav.is-active::before), so it always sits right.
 *  On a new page it starts where the last one was and slides over. */
let lastNav: { x: number; y: number } | null = null;
function slideNav(): void {
  const a = $<HTMLElement>("#side .nav.is-active");
  if (!a) { lastNav = null; return; }
  const r = a.getBoundingClientRect(), to = { x: r.left, y: r.top };
  if (lastNav && r.width && (lastNav.x !== to.x || lastNav.y !== to.y)) {
    a.classList.add("no-anim");
    a.style.setProperty("--dx", `${lastNav.x - to.x}px`);
    a.style.setProperty("--dy", `${lastNav.y - to.y}px`);
    void a.offsetWidth; // the start position is applied before the slide begins
    a.classList.remove("no-anim");
    a.style.setProperty("--dx", "0px");
    a.style.setProperty("--dy", "0px");
  }
  lastNav = r.width ? to : null;
}

export function renderShell(active: string, view: Raw): void {
  const app = $("#app")!;
  app.classList.remove("side-open");
  mount(app, html`${sidebar(active)}<div class="scrim" data-close-side></div>
    <main class="main">${backLink(active)}<div class="view" id="view">${view}</div></main>${dock(active)}`);
  slideNav();
  // the dock's size and the indicator's place are CSS variables, set here because the CSP allows no style attributes
  const items = dockItems(), at = items.findIndex((d) => d.path === active), dk = $("#dock")!;
  dk.style.setProperty("--n", String(Math.max(items.length, 1)));
  dk.style.setProperty("--at", String(Math.max(lastDock, 0)));
  void dk.offsetWidth;
  dk.dataset.at = String(at);
  if (at >= 0) dk.style.setProperty("--at", String(at));
  lastDock = at;
  applyTheme(savedTheme());
  const close = () => app.classList.remove("side-open");
  $$<HTMLButtonElement>("[data-theme-set]").forEach((b) =>
    b.addEventListener("click", () => applyTheme(b.dataset.themeSet as Theme)));
  $$("[data-open-side]").forEach((b) => b.addEventListener("click", () => app.classList.add("side-open")));
  $$("[data-toggle-side]").forEach((b) => b.addEventListener("click", () => app.classList.toggle("side-open")));
  $$("[data-close-side]").forEach((b) => b.addEventListener("click", close));
  $$(".side a").forEach((a) => a.addEventListener("click", close));
}

let keysBound = false;
export function bindKeys(): void {
  if (keysBound) return;
  keysBound = true;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#app")?.classList.remove("side-open"); });
}
