import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHousehold, type Household } from "../../../packages/core/src/household.ts";
import worker, { me, sameOriginWrite } from "../src/index.ts";
import type { Env } from "../src/env.ts";
import type { ShellModule } from "../src/modules.ts";
import { allPages, isAsset, mayOpen, menuFor, pageAccess } from "../src/pages.ts";
import { PERSON_HUES, favicon, manifest, personNumber } from "../src/app-icon.ts";
import { loginPage } from "../src/login.ts";

const example = JSON.parse(readFileSync(new URL("../../../household.config.example.json", import.meta.url), "utf8"));
const H: Household = parseHousehold({ ...example, modules: { ...example.modules, calendar: true } });
const [alex, sam] = H.people;

/** A made-up module, as a later phase would register one. */
const calendar: ShellModule = {
  id: "calendar",
  pages: [
    { path: "/home/calendar", label: "Calendar", icon: "calendar", where: "home" },
    { path: "/dashboard/calendar-sync", label: "Calendar sync", icon: "calendar", where: "manage", text: "Which calendars are read." },
  ],
  api: { calendar: async (c) => Response.json({ for: c.person.id, write: c.write }) },
};
const finance: ShellModule = { id: "finance", pages: [{ path: "/dashboard/finance", label: "Finance", icon: "wallet", where: "metrics" }] };

test("pages: what is public, what is behind the sign-in, what does not exist", () => {
  assert.equal(pageAccess("/", H), "redirect");
  assert.equal(pageAccess("/login", H), "public");
  assert.equal(pageAccess("/login/login.css", H), "public");
  assert.equal(pageAccess("/login/../dist/main.js", H), "none");
  for (const p of ["/home", "/home/", "/settings", "/dashboard/security", "/api/me", "/dist/main.js", "/styles/app.css", "/favicon.svg"]) assert.equal(pageAccess(p, H), "private", p);
  for (const p of ["/nope", "/home/calendar", "/dashboard", "/dist/../secret", "/.env"]) assert.equal(pageAccess(p, H), "none", p);
  assert.equal(isAsset("/dist/../x"), false);
});

test("pages: the gateway's paths are never a page", () => {
  for (const p of ["/brain/mcp", "/household/mcp/x", "/oauth/authorize", "/.well-known/oauth-authorization-server"]) assert.equal(pageAccess(p, H), "none", p);
});

test("modules: pages exist only when the module is on and built in", () => {
  assert.equal(pageAccess("/home/calendar", H, [calendar]), "private");
  assert.equal(pageAccess("/dashboard/finance", H, [calendar, finance]), "none", "finance is off in this config");
  assert.deepEqual(allPages(H, [calendar, finance]).map((p) => p.path), ["/home", "/dashboard/security", "/home/calendar", "/dashboard/calendar-sync"]);
});

test("menu: Home for everyone, management for admins only", () => {
  const admin = menuFor(H, alex, [calendar]);
  assert.deepEqual(admin.nav.map((g) => [g.group, g.items.map((i) => i.path)]), [["Home", ["/home", "/home/calendar"]]]);
  assert.deepEqual(admin.manage.map((m) => m.path), ["/dashboard/security", "/dashboard/calendar-sync"]);
  const member = menuFor(H, sam, [calendar]);
  assert.deepEqual(member.nav[0].items.map((i) => i.path), ["/home", "/home/calendar"]);
  assert.deepEqual(member.manage, []);
  assert.equal(mayOpen(H, sam, "/dashboard/security"), false);
  assert.equal(mayOpen(H, alex, "/dashboard/security"), true);
  assert.equal(mayOpen(H, sam, "/settings"), true);
});

test("/api/me: the person, the household, no email addresses", () => {
  const out = me(H, sam, false, [calendar]);
  assert.deepEqual(out.person, { id: "sam", name: "Sam", admin: false, n: 2 });
  assert.deepEqual(out.people, [{ id: "alex", name: "Alex", n: 1 }, { id: "sam", name: "Sam", n: 2 }]);
  assert.deepEqual(out.modules, ["calendar"], "only modules that are on and built in");
  assert.equal(JSON.stringify(out).includes("@"), false);
});

test("writes need our header and the same origin", () => {
  const url = new URL("https://home.example.com/api/lists/add");
  const req = (headers: Record<string, string>) => new Request(url, { method: "POST", headers });
  assert.equal(sameOriginWrite(req({ "X-Dashboard": "1", Origin: "https://home.example.com" }), url), true);
  assert.equal(sameOriginWrite(req({ "X-Dashboard": "1" }), url), true);
  assert.equal(sameOriginWrite(req({ Origin: "https://home.example.com" }), url), false);
  assert.equal(sameOriginWrite(req({ "X-Dashboard": "1", Origin: "https://elsewhere.example" }), url), false);
});

test("icons: one colour and initial per person, a neutral manifest", () => {
  assert.equal(personNumber(H, sam), 2);
  assert.match(favicon(H, sam), new RegExp(`fill="${PERSON_HUES[1]}".*>S</text>`));
  assert.match(favicon(H, { ...sam, name: "<b>" }), />&lt;<\/text>/);
  assert.equal(manifest(H).name, "Example family");
  assert.equal(PERSON_HUES.length, 6);
});

test("sign-in page: the household's name, no script, strict headers", async () => {
  const res = loginPage(H);
  const html = await res.text();
  assert.match(html, /Example family/);
  assert.equal(/<script/i.test(html), false);
  assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(await loginPage(H, true).text(), /made-up/i);
});

// ---------- the Worker as a whole, with stand-ins for the assets ----------

const ASSETS = { fetch: async (req: Request) => new Response(`asset ${new URL(req.url).pathname}`, { headers: { "content-type": "text/plain" } }) } as unknown as Fetcher;
const env = (over: Partial<Env> = {}): Env => ({ ASSETS, HOUSEHOLD: JSON.stringify(H), ACCESS_TEAM: "example", ACCESS_AUD: "aud", ...over });
const get = (path: string, e: Env, init?: RequestInit) => worker.fetch(new Request(`https://home.example.com${path}`, init), e);

test("worker: nobody signed in", async () => {
  let r = await get("/", env());
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "https://home.example.com/home");
  r = await get("/home", env());
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "https://home.example.com/login");
  r = await get("/dist/main.js", env());
  assert.equal(r.status, 302, "the UI's files are behind the sign-in too");
  r = await get("/api/me", env());
  assert.equal(r.status, 401);
  r = await get("/login", env());
  assert.equal(r.status, 200);
  r = await get("/api/me", env(), { headers: { "Cf-Access-Jwt-Assertion": "not.a.token" } });
  assert.equal(r.status, 401, "a header alone is not a sign-in");
});

test("worker: signed in (wrangler dev stand-in), members and admins", async () => {
  const asSam = env({ DEV_EMAIL: "sam@example.com" }), asAlex = env({ DEV_EMAIL: "alex@example.com" });
  let r = await get("/api/me", asSam);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).person.id, "sam");
  r = await get("/home", asSam);
  assert.equal(await r.text(), "asset /home");
  assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal((await get("/api/security", asSam)).status, 403);
  r = await get("/api/security", asAlex);
  assert.equal(r.status, 200);
  assert.equal((await get("/nope", asAlex)).status, 404);
  assert.equal((await get("/brain/mcp", asAlex)).status, 404);
  assert.equal((await get("/api/calendar", asAlex)).status, 404, "no module answers: not found");
  assert.equal((await get("/api/anything", asAlex, { method: "POST" })).status, 403, "a write without our header");
  assert.equal((await get("/home", asAlex, { method: "POST" })).status, 405);
  assert.equal((await get("/api/me", env({ DEV_EMAIL: "stranger@example.com" }))).status, 401, "signed in at Access but not in the household");
  r = await get("/favicon.svg", asSam);
  assert.match(await r.text(), />S<\/text>/);
});

test("worker: a broken household config is an error, not an open door", async () => {
  const r = await get("/home", env({ HOUSEHOLD: "{}" }));
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: "internal error" });
});
