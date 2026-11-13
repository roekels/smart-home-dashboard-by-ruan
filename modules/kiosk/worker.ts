// The Kiosk module, as the shell sees it.
// On the dashboard's own host (people, signed in):
//   /kiosk                                   the wall page, for a look at it from any device
//   /dashboard/wall-tablets                  pair and revoke tablets                                  admins
//   GET /api/kiosk/devices, POST /api/kiosk/approve { code, name }, POST /api/kiosk/devices/<id>/revoke   admins
// On the kiosk host (var KIOSK_HOST; tablets, no sign-in) the `machine` hook answers everything itself:
//   /pair, /pair/*                           the pairing page (public: it only shows a code)
//   POST /api/kiosk/pair/start | poll        get a code; wait for the key
//   /kiosk and the built UI                  paired tablets only
//   the API calls in kiosk.ts kioskApi       paired tablets only, answered by the other modules' own handlers
import { builtModules, type ApiCtx, type MachineCtx, type ShellModule } from "../../apps/shell/src/modules.ts";
import { isAsset } from "../../apps/shell/src/pages.ts";
import { enabledModules, type Household, type Person } from "../../packages/core/src/household.ts";
import { HttpError, SECURITY_HEADERS, esc, json, securityHeaders } from "../../packages/core/src/util.ts";
import { KIOSK_DAYS, KIOSK_ID, approve, devices, isKioskHost, kioskApi, kioskSession, pairPoll, pairStart, revoke } from "./kiosk.ts";

const KIOSK_PAGE = "/kiosk";
/** What a tablet is to the other modules' handlers: nobody of the household, never an admin. */
const TABLET: Person = { id: KIOSK_ID, name: "Home", email: "", admin: false };
/** Modules whose pages a tablet shows a part of. */
const SHOWN = ["homeAssistant", "energy", "calendar"];

const sameOriginWrite = (req: Request, url: URL): boolean => {
  const origin = req.headers.get("Origin");
  return req.headers.get("X-Dashboard") === "1" && (!origin || origin === url.origin);
};

async function assets(c: MachineCtx): Promise<Response> {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") throw new HttpError(405, "method not allowed");
  const res = await c.env.ASSETS.fetch(c.req);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

/** /pair: shows a code and waits. Its script and style sit under /pair/ and /login/ (both public on this host). */
export function pairPage(h: Household, dashboard: string): Response {
  const name = esc(h.household);
  const body = `<!doctype html>
<html lang="${esc(h.language)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex">
  <title>Pair this tablet · ${name}</title>
  <link rel="icon" href="/login/mark.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/login/login.css">
  <link rel="stylesheet" href="/pair/pair.css">
  <script src="/pair/pair.js" defer></script>
</head>
<body>
  <main class="login">
    <img class="login__logo" src="/login/mark.svg" alt="" width="72" height="72">
    <h1>${name}</h1>
    <p class="login__sub">Wall tablet</p>
    <p class="pair__code" id="code" aria-live="polite">····-····</p>
    <p class="login__fine" id="msg" data-dashboard="${esc(dashboard)}">Getting a code …</p>
  </main>
</body>
</html>`;
  return new Response(body, { headers: { ...securityHeaders(), "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** GET /api/me for a tablet: one page, no menus, no person. */
export function tabletMe(h: Household) {
  const on = new Set<string>(builtModules(h).map((m) => m.id));
  return {
    person: { id: KIOSK_ID, name: TABLET.name, admin: false, n: 0 },
    household: h.household, language: h.language, timezone: h.timezone,
    people: h.people.map((p, i) => ({ id: p.id, name: p.name, n: i + 1 })),
    modules: enabledModules(h).filter((m) => SHOWN.includes(m) && on.has(m)),
    nav: [{ group: "Home", items: [{ path: KIOSK_PAGE, label: "Wall tablet", icon: "tablet" }] }], manage: [],
    demo: false, kiosk: true,
  };
}

/** Everything on the kiosk host. Never falls through to the person sign-in: this host has no Access in front. */
export async function kioskRoute(c: MachineCtx): Promise<Response> {
  const { req, env, url, household: h } = c, p = url.pathname;
  if (p === "/" || p === "/index.html" || p === "/home") return Response.redirect(`${url.origin}${KIOSK_PAGE}`, 302);
  if (p === "/pair") return pairPage(h, h.domain);
  if (/^\/(pair|login)\/[A-Za-z0-9._-]+$/.test(p)) return assets(c);
  if (p === "/api/kiosk/pair/start" || p === "/api/kiosk/pair/poll") {
    if (req.method !== "POST" || !sameOriginWrite(req, url)) throw new HttpError(403, "cross-site or wrong method");
    if (p.endsWith("/start")) return pairStart(env);
    const b: any = await req.json().catch(() => ({}));
    return pairPoll(env, b.secret);
  }

  const tablet = await kioskSession(req, env);
  if (!tablet) return p.startsWith("/api/") ? json({ error: "this tablet is not paired" }, 401) : Response.redirect(`${url.origin}/pair`, 302);

  if (p.startsWith("/api/")) {
    if (!kioskApi(req.method, p)) throw new HttpError(403, "not on the wall tablet");
    const write = sameOriginWrite(req, url);
    if (req.method !== "GET" && !write) throw new HttpError(403, "cross-site write refused");
    if (p === "/api/me") return json(tabletMe(h));
    const segment = p.split("/")[2] ?? "";
    for (const m of builtModules(h)) {
      const handler = m.api?.[segment];
      if (handler) return handler({ req, env, url, household: h, person: TABLET, write });
    }
    throw new HttpError(404, "not found");
  }

  if (p === "/manifest.webmanifest") {
    return json({ name: h.household, short_name: "Home", start_url: KIOSK_PAGE, scope: "/", display: "fullscreen", background_color: "#0c0e13", theme_color: "#0c0e13",
      icons: [{ src: "/icons/mark-192.png", sizes: "192x192", type: "image/png" }, { src: "/icons/mark-512.png", sizes: "512x512", type: "image/png" }] });
  }
  if (p === "/favicon.svg" || p === "/apple-touch-icon.png") {
    return assets({ ...c, req: new Request(new URL(p === "/favicon.svg" ? "/login/mark.svg" : "/icons/mark-180.png", url), { method: req.method }) });
  }
  const page = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  if (page === KIOSK_PAGE || isAsset(p)) return assets(c);
  throw new HttpError(404, "not found");
}

async function manage(c: ApiCtx): Promise<Response> {
  if (!c.person.admin) throw new HttpError(403, "wall tablets are managed by admins");
  const p = c.url.pathname;
  if (c.req.method === "GET" && p === "/api/kiosk/devices") return devices(c.env);
  if (c.req.method !== "POST" || !c.write) throw new HttpError(403, "cross-site or wrong method");
  if (p === "/api/kiosk/approve") return approve(c.env, c.person.id, await c.req.json().catch(() => ({})));
  const m = /^\/api\/kiosk\/devices\/(ks_[A-Za-z0-9_-]{1,40})\/revoke$/.exec(p);
  if (m) return revoke(c.env, c.person.id, m[1]);
  throw new HttpError(404, "not found");
}

const DAY = 86_400_000;

/** Demo mode: two made-up tablets, so the management page has something to show. Nothing can be paired. */
async function demo(c: ApiCtx): Promise<Response | null> {
  const p = c.url.pathname;
  if (!p.startsWith("/api/kiosk/")) return null;
  if (!c.person.admin) throw new HttpError(403, "wall tablets are managed by admins");
  const now = Date.now(), by = c.household.people[0].id;
  if (c.req.method === "GET" && p === "/api/kiosk/devices") {
    return json({ days: KIOSK_DAYS, host: "kiosk.example.com", devices: [
      { id: "ks_demo-hallway", name: "Hallway", created: now - 41 * DAY, approved_by: by, expires: now + 139 * DAY, last_seen: now - 4 * 60_000, revoked: null, revoked_by: null },
      { id: "ks_demo-kitchen", name: "Kitchen", created: now - 12 * DAY, approved_by: by, expires: now + 168 * DAY, last_seen: now - 26 * 60_000, revoked: null, revoked_by: null },
    ] });
  }
  throw new HttpError(400, "the demo has no real tablets to pair or revoke");
}

export const kiosk: ShellModule = {
  id: "kiosk",
  pages: [
    { path: KIOSK_PAGE, label: "Wall tablet", icon: "tablet", where: "home" },
    { path: "/dashboard/wall-tablets", label: "Wall tablets", icon: "tablet", where: "manage", text: "Pair a tablet for the wall with a code, see when each was last on, revoke one." },
  ],
  api: { kiosk: manage },
  demo,
  machine: async (c) => (!c.demo && isKioskHost(c.env, c.url) ? kioskRoute(c) : null),
  security: (h) => ({
    nodes: [
      { id: "tablets", zone: "who", name: "Wall tablets", sub: "paired, no person", icon: "tablet", status: "ok",
        text: "A tablet on the wall. It shows the wall page, switches lights and scenes, and reads and ticks the shared lists. It never sees anyone's own lists, records or the settings.",
        guard: [`A key of its own for ${KIOSK_DAYS} days, in a cookie scripts cannot read; only its hash is stored`, "Paired by an admin with a code that lasts 10 minutes", "Revoked with one click in Settings > Wall tablets"] },
      { id: "kiosk-host", zone: "edge", name: "Kiosk host", sub: "no sign-in page", icon: "key", status: "ok",
        text: "The tablets' own hostname. Cloudflare Access is not in front of it, because its sessions end after a month. The dashboard checks the tablet's key on every request instead, and nothing but the wall page works there.",
        guard: ["A person's sign-in does nothing on this host", "An unpaired device only gets the pairing page"] },
    ],
    links: [
      { from: "tablets", to: "kiosk-host", kind: "agent", label: "tablet key" },
      { from: "kiosk-host", to: "shell", kind: "agent", label: "checked by the dashboard" },
    ],
    signIns: [
      { where: "Wall tablets", who: "Tablets an admin paired", how: `A ${KIOSK_DAYS}-day key per tablet, given once at pairing`, status: "ok", note: `Managed under Settings > Wall tablets on ${h.domain}.` },
    ],
  }),
};
