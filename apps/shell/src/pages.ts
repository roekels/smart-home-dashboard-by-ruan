// Which paths the shell serves, and who may open them. The UI's router gets the same list through /api/me.
import type { Household, Person } from "../../../packages/core/src/household.ts";
import { builtModules, MODULES, type PageDef, type ShellModule } from "./modules.ts";

/** The shell's own pages. Settings is reached from the person's card, so it is in no menu. */
export const CORE_PAGES: PageDef[] = [
  { path: "/home", label: "Today", icon: "sun", where: "home" },
  { path: "/dashboard/security", label: "Security", icon: "shield", where: "manage", text: "Who signs in where, what talks to what, and where each key lives." },
  { path: "/setup/keys", label: "Encryption keys", icon: "key", where: "manage", text: "Made once, in your browser, during setup. Nobody else sees them." },
];
export const SETTINGS = "/settings";

/** Built files the pages load. Behind the sign-in like the pages; /login has its own copies under /login/. */
const ASSET = /^\/(dist|styles|fonts|icons)\/[A-Za-z0-9._/-]+$/;
/** The app's icons and manifest, drawn per person (app-icon.ts). */
export const APP_ICON = /^\/(favicon\.svg|apple-touch-icon\.png|manifest\.webmanifest)$/;
/** Paths the gateway Worker owns through its routes. If one reaches the shell, the route is missing: 404, never a page. */
const GATEWAY = /^\/([a-z][a-z0-9-]*\/mcp|oauth|\.well-known)(\/|$)/;

export const isAsset = (path: string): boolean => (ASSET.test(path) && !path.includes("..")) || APP_ICON.test(path);

const needsAdmin = (p: PageDef): boolean => p.admin ?? p.where !== "home";

export function allPages(h: Household, modules: ShellModule[] = MODULES): PageDef[] {
  return [...CORE_PAGES, ...builtModules(h, modules).flatMap((m) => m.pages ?? [])];
}

export type PageAccess = "redirect" | "public" | "private" | "none";

export function pageAccess(path: string, h: Household, modules: ShellModule[] = MODULES): PageAccess {
  if (path === "/" || path === "/index.html") return "redirect";
  if (GATEWAY.test(path)) return "none";
  if (path === "/login" || /^\/login\/[A-Za-z0-9._-]+$/.test(path)) return "public";
  if (path.startsWith("/api/")) return "private";
  const p = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (p === SETTINGS || isAsset(path) || allPages(h, modules).some((x) => x.path === p)) return "private";
  return "none";
}

export interface Menu {
  nav: { group: string; items: { path: string; label: string; icon: string }[] }[];
  manage: { path: string; label: string; icon: string; text: string }[];
}

/** The menu for one person: Home for everyone, Metrics and Management for admins (unless a page says otherwise). */
export function menuFor(h: Household, person: Person, modules: ShellModule[] = MODULES): Menu {
  const mine = allPages(h, modules).filter((p) => person.admin || !needsAdmin(p));
  const pick = (where: PageDef["where"]) => mine.filter((p) => p.where === where).map(({ path, label, icon }) => ({ path, label, icon }));
  return {
    nav: [{ group: "Home", items: pick("home") }, { group: "Metrics", items: pick("metrics") }].filter((g) => g.items.length),
    manage: mine.filter((p) => p.where === "manage").map(({ path, label, icon, text }) => ({ path, label, icon, text: text ?? "" })),
  };
}

/** Whether this person may open this page path (the UI hides it; admin APIs check again on their own). */
export function mayOpen(h: Household, person: Person, path: string, modules: ShellModule[] = MODULES): boolean {
  if (path === SETTINGS) return true;
  const page = allPages(h, modules).find((p) => p.path === path);
  return !!page && (person.admin || !needsAdmin(page));
}
