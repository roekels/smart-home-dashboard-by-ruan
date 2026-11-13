// The app's own icons, per person: the browser tab shows the person's initial on their colour, so two people on one
// computer can tell their tabs apart. The Home Screen icon and the manifest icons are the neutral house mark
// (web/icons, drawn by scripts/icons.mjs).
import type { Household, Person } from "../../../packages/core/src/household.ts";
import { HttpError, SECURITY_HEADERS, esc } from "../../../packages/core/src/util.ts";

/** One hue per person, by their place in the config (the same order as --who-1 … --who-6 in web/styles/app.css). */
export const PERSON_HUES = ["#2f6bff", "#8b5cf6", "#16a34a", "#e08a00", "#f0506e", "#0e9aa7"];

export const personNumber = (h: Household, p: Person): number => h.people.findIndex((x) => x.id === p.id) + 1;

export function favicon(h: Household, p: Person): string {
  const hue = PERSON_HUES[(personNumber(h, p) - 1) % PERSON_HUES.length];
  const letter = esc([...p.name.trim()][0]?.toUpperCase() ?? "?");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="${hue}"/>` +
    `<text x="32" y="44" text-anchor="middle" font-family="ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif" font-size="36" font-weight="600" fill="#fff">${letter}</text></svg>`;
}

/** The manifest for "Add to Home Screen": opens on Today, full screen. */
export function manifest(h: Household): Record<string, unknown> {
  return {
    name: h.household,
    short_name: "Home",
    id: "/home",
    start_url: "/home",
    scope: "/",
    display: "standalone",
    background_color: "#0c0e13",
    theme_color: "#0c0e13",
    icons: [
      { src: "/icons/mark-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/mark-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/mark-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

/** One of APP_ICON's paths (pages.ts). Private and short-lived in caches: the same URL differs per person. */
export async function appIcon(req: Request, assets: Fetcher, path: string, h: Household, p: Person): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
  const headers = new Headers({ ...SECURITY_HEADERS, "cache-control": "private, max-age=3600", vary: "Cookie" });
  if (path === "/manifest.webmanifest") {
    headers.set("content-type", "application/manifest+json; charset=utf-8");
    return new Response(JSON.stringify(manifest(h)), { headers });
  }
  if (path === "/favicon.svg") {
    headers.set("content-type", "image/svg+xml; charset=utf-8");
    return new Response(favicon(h, p), { headers });
  }
  const res = await assets.fetch(new Request(new URL("/icons/mark-180.png", req.url)));
  if (!res.ok) throw new HttpError(404, "not found");
  headers.set("content-type", "image/png");
  return new Response(res.body, { headers });
}
