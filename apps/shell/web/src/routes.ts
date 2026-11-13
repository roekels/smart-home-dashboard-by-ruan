// Page addresses: real paths such as /dashboard/security, with the History API. Which pages exist for this person
// comes from the Worker (GET /api/me: the menus), so the router never knows a page the Worker would refuse.
import { who } from "./api.ts";

export const HOME = "/home";
export const SETTINGS = "/settings";

/** Every page this person may open. */
export function known(): Set<string> {
  return new Set([HOME, SETTINGS, ...who.nav.flatMap((g) => g.items.map((i) => i.path)), ...who.manage.map((m) => m.path)]);
}

export const hasPage = (path: string): boolean => known().has(path);

/** Go to a page from script. `replace` keeps it out of the back history. */
export function go(path: string, replace = false): void {
  if (replace) history.replaceState(null, "", path); else history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** The page the address names, or Today when it names none this person may open. */
export function current(): string {
  const p = location.pathname.replace(/\/+$/, "") || HOME;
  return known().has(p) ? p : HOME;
}

/** Same-site page links navigate without a reload; anything else is left to the browser. */
export function bindRouter(render: () => void): void {
  window.addEventListener("popstate", render);
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element).closest<HTMLAnchorElement>("a[href^='/']");
    if (!a || a.target || a.hasAttribute("download")) return;
    const path = a.pathname.replace(/\/+$/, "");
    if (!known().has(path) || a.origin !== location.origin) return;
    e.preventDefault();
    if (path !== location.pathname) history.pushState(null, "", path);
    render();
  });
}
