import { html, mount, $ } from "./html.ts";
import { renderShell, bindKeys, applyTheme, savedTheme, deviceMode } from "./shell.ts";
import { today, todayInit, stopToday } from "./pages/today.ts";
import { settings, settingsInit } from "./pages/settings.ts";
import { security, securityInit, securityLeave } from "./pages/security.ts";
import { UI_MODULES, type Page } from "./modules.ts";
import { bindRouter, current } from "./routes.ts";
import { ApiError, loadWho, who } from "./api.ts";
import { t } from "./i18n.ts";

// One page per path. The shell's own three, then whatever the modules bring (modules.ts).
// leave() runs before the next page renders.
const pages: Record<string, Page> = {
  "/home": { title: "Today", view: today, init: todayInit, leave: stopToday },
  "/settings": { title: "Settings", view: settings, init: settingsInit },
  "/dashboard/security": { title: "Security", view: security, init: securityInit, leave: securityLeave },
};
for (const m of UI_MODULES) Object.assign(pages, m.pages);

let shown: Page | null = null;

function render(): void {
  const path = current();
  const page = pages[path] ?? pages["/home"];
  shown?.leave?.();
  shown = page;
  document.body.className = `page-${path.slice(1).replace(/\//g, "-")}`;
  document.title = `${t(page.title)} · ${who.household}`;
  renderShell(path, page.view());
  page.init?.();
  document.getElementById("view")?.scrollTo(0, 0);
  window.scrollTo(0, 0);
}

/** Phone, tablet or desktop, for the few styles a media query cannot decide (touch sizes). Kept current on resize. */
function markMode(): void {
  document.documentElement.dataset.mode = deviceMode();
}

applyTheme(savedTheme());
markMode();
window.addEventListener("resize", markMode, { passive: true });
bindKeys();
// learn who is signed in before the first paint (one small request), then draw
loadWho().then(() => {
  document.documentElement.dataset.who = String(who.person.n);
  bindRouter(render);
  render();
}, (e: unknown) => {
  // the sign-in ran out: the sign-in page starts it again
  if (e instanceof ApiError && e.status === 401) { location.href = "/login"; return; }
  mount($("#app")!, html`<div class="card fatal"><h1 class="h1">${t("The dashboard did not answer")}</h1>
    <p class="muted">${(e as Error).message}</p><p><a class="btn btn--ink" href="/home">${t("Try again")}</a></p></div>`);
});
