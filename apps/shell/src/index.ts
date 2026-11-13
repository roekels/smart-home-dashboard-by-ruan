// <prefix>-shell: the dashboard Worker.
//   /login, /login/*      public sign-in page (no script) and its own files
//   /                     -> /home
//   /api/me               who is signed in, their menu, which modules are on
//   /api/security         the Security page's content (admins)
//   /api/setup/keys       the one-time key page (admins; setup-keys.ts)
//   /api/<module>/*       a module's API (modules.ts); 404 when the module is off or not built in
//   everything else       the UI, behind the sign-in; page paths get index.html (the client router picks the page)
// Paths the gateway owns (/…/mcp, /oauth/*, /.well-known/*) are Worker routes of <prefix>-gateway and win over this
// Worker's custom domain. If one reaches the shell, it gets a 404.
// With var DEMO_MODE = "on" none of the sign-in applies: see demo.ts.
import { accessEmail } from "../../../packages/core/src/access.ts";
import { householdFromVar, personByEmail, type Household, type Person } from "../../../packages/core/src/household.ts";
import { HttpError, SECURITY_HEADERS, json } from "../../../packages/core/src/util.ts";
import manifest from "../../../secrets.manifest.json" with { type: "json" };
import type { Env } from "./env.ts";
import { appIcon, personNumber } from "./app-icon.ts";
import { DEMO_HOUSEHOLD, demoApi, demoPerson } from "./demo.ts";
import { loginPage } from "./login.ts";
import { builtModules, MODULES, type ShellModule } from "./modules.ts";
import { APP_ICON, menuFor, pageAccess } from "./pages.ts";
import { securityModel, type ManifestSecret } from "./security.ts";
import { keyPageApi } from "./setup-keys.ts";

const isDemo = (env: Env): boolean => env.DEMO_MODE === "on";

/** The person behind this request, or null. Access proves the email; the household config says who that is. */
async function signedIn(req: Request, env: Env, h: Household): Promise<Person | null> {
  if (isDemo(env)) return demoPerson(req);
  if (env.DEV_EMAIL) return personByEmail(h, env.DEV_EMAIL);
  const email = await accessEmail(req.headers.get("Cf-Access-Jwt-Assertion"), { team: env.ACCESS_TEAM, aud: env.ACCESS_AUD });
  return email ? personByEmail(h, email) : null;
}

/** Writes from the page: same origin, our header (a cross-site form or fetch cannot set it without a preflight). */
export function sameOriginWrite(req: Request, url: URL): boolean {
  const origin = req.headers.get("Origin");
  return req.headers.get("X-Dashboard") === "1" && (!origin || origin === url.origin);
}

/** GET /api/me: everything the UI needs to draw the frame for this person. */
export function me(h: Household, person: Person, demo: boolean, modules: ShellModule[] = MODULES) {
  return {
    person: { id: person.id, name: person.name, admin: person.admin, n: personNumber(h, person) },
    household: h.household,
    language: h.language,
    timezone: h.timezone,
    people: h.people.map((p, i) => ({ id: p.id, name: p.name, n: i + 1 })),
    // demo: every module the made-up family has, answered by demo.ts; live: only what is on and built in
    modules: demo ? Object.keys(h.modules).filter((m) => h.modules[m as keyof typeof h.modules]) : builtModules(h, modules).map((m) => m.id),
    ...menuFor(h, person, modules),
    demo,
  };
}

async function api(req: Request, env: Env, url: URL, h: Household, person: Person): Promise<Response> {
  const p = url.pathname, demo = isDemo(env);
  if (p === "/api/me" && req.method === "GET") return json(me(h, person, demo));
  if (p === "/api/security" && req.method === "GET") {
    if (!person.admin) throw new HttpError(403, "the Security page is for admins");
    const set = env as unknown as Record<string, unknown>;
    return json(securityModel({
      household: h, secrets: manifest.secrets as ManifestSecret[], demo,
      present: (name) => !demo && typeof set[name] === "string" && set[name] !== "",
    }));
  }
  const write = sameOriginWrite(req, url);
  if (p === "/api/setup/keys") {
    return keyPageApi({ req, person, write, manifest: manifest.secrets as ManifestSecret[], passText: demo ? undefined : env.SETUP_KEYPAGE_WRITE_TOKEN });
  }
  if (demo) {
    for (const m of builtModules(h)) {
      const r = await m.demo?.({ req, env, url, household: h, person, write });
      if (r) return r;
    }
    return demoApi(req, url, person, write);
  }
  if (req.method !== "GET" && req.method !== "HEAD" && !write) throw new HttpError(403, "cross-site write refused");
  const segment = p.split("/")[2] ?? "";
  for (const m of builtModules(h)) {
    const handler = m.api?.[segment];
    if (handler) return handler({ req, env, url, household: h, person, write });
  }
  throw new HttpError(404, "not found");
}

/** Static files with our headers. Page paths (/home/…) get index.html from the SPA fallback in wrangler.jsonc. */
async function assets(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
  const res = await env.ASSETS.fetch(req);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const h = isDemo(env) ? DEMO_HOUSEHOLD : householdFromVar(env.HOUSEHOLD);
  const path = url.pathname;

  // callers that are not people (a paired wall tablet, an edge agent) prove themselves to their own module
  for (const m of builtModules(h)) {
    const r = await m.machine?.({ req, env, url, household: h, demo: isDemo(env) });
    if (r) return r;
  }

  const access = pageAccess(path, h);
  if (access === "redirect") return Response.redirect(`${url.origin}/home`, 302);
  if (access === "public") return path === "/login" ? loginPage(h, isDemo(env)) : assets(req, env);

  const person = await signedIn(req, env, h);
  if (!person) {
    return path.startsWith("/api/")
      ? json({ error: "sign in first" }, 401)
      : Response.redirect(`${url.origin}/login`, 302);
  }
  if (path.startsWith("/api/")) return api(req, env, url, h, person);
  if (access === "none") throw new HttpError(404, "not found");
  if (APP_ICON.test(path)) return appIcon(req, env.ASSETS, path, h, person);
  return assets(req, env);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "internal error" }, 500);
    }
  },

  /** One cron tick: every module that is on and listens to this trigger gets a turn (modules.ts `scheduled`, `cron`).
   *  One failing never stops the others. Never in demo mode. */
  async scheduled(c: ScheduledController, env: Env): Promise<void> {
    if (isDemo(env)) return;
    const h = householdFromVar(env.HOUSEHOLD), now = new Date(c.scheduledTime);
    for (const m of builtModules(h)) {
      if (!m.scheduled || (m.cron && m.cron !== c.cron)) continue;
      // the module's name only: an error message could carry data
      await m.scheduled(env, h, now).catch(() => console.error(`scheduled: ${m.id} failed`));
    }
  },
} satisfies ExportedHandler<Env>;
