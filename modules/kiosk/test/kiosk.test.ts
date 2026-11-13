import test from "node:test";
import assert from "node:assert/strict";
import "../../../apps/shell/src/modules.ts"; // first: the module list loads the modules, not the other way round
import type { Env } from "../../../apps/shell/src/env.ts";
import { parseHousehold } from "../../../packages/core/src/household.ts";
import { homeDb } from "../../home-assistant/test/fakes/d1.ts";
import { COOKIE, approve, devices, isKioskHost, kioskApi, kioskSession, pairPoll, pairStart, revoke } from "../kiosk.ts";
import { kioskRoute, tabletMe } from "../worker.ts";
import demo from "../../../demo/household.config.json" with { type: "json" };

const h = parseHousehold(demo);
const HOST = "kiosk.example.com";
const env = (): Env => ({ HOME_DB: homeDb(), KIOSK_HOST: HOST, ASSETS: { fetch: async () => new Response("asset") } } as unknown as Env);
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0];
const req = (path: string, init: RequestInit = {}) => new Request(`https://${HOST}${path}`, init);
const route = (e: Env, r: Request) => kioskRoute({ req: r, env: e, url: new URL(r.url), household: h, demo: false });

test("a tablet may read the house and switch lights; nothing else", () => {
  for (const [m, p] of [["GET", "/api/ha"], ["GET", "/api/lists"], ["GET", "/api/energy"], ["POST", "/api/ha/light"], ["POST", "/api/ha/scene"], ["POST", "/api/lists/done"]]) assert.ok(kioskApi(m, p), `${m} ${p}`);
  for (const [m, p] of [["POST", "/api/ha/switch"], ["GET", "/api/ha/setup"], ["POST", "/api/ha/setup"], ["GET", "/api/health/mine"], ["GET", "/api/finance"], ["GET", "/api/devices"], ["GET", "/api/kiosk/devices"], ["POST", "/api/energy/setup"], ["DELETE", "/api/ha"]]) assert.ok(!kioskApi(m, p), `${m} ${p}`);
});

test("only the kiosk host is the kiosk host", () => {
  const e = env();
  assert.ok(isKioskHost(e, new URL(`https://${HOST}/kiosk`)));
  assert.ok(!isKioskHost(e, new URL("https://home.example.com/kiosk")));
  assert.ok(!isKioskHost({ ...e, KIOSK_HOST: undefined } as Env, new URL(`https://${HOST}/kiosk`)));
});

test("pairing: a code, an admin's approval, then a key as a cookie scripts cannot read", async () => {
  const e = env();
  const start: any = await (await pairStart(e)).json();
  assert.match(start.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(((await (await pairPoll(e, start.secret)).json()) as any).status, "pending");
  await assert.rejects(approve(e, "alex", { code: "ZZZZ-9999", name: "x" }), /no open pairing/);
  await approve(e, "alex", { code: start.code.replace("-", "").toLowerCase(), name: "Hallway" });
  const paired = await pairPoll(e, start.secret);
  const set = paired.headers.get("set-cookie")!;
  assert.match(set, new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Max-Age=15552000; HttpOnly; Secure; SameSite=Strict$`));
  await assert.rejects(pairPoll(e, start.secret), /pairing ended/); // the key is handed out once

  const id = await kioskSession(req("/kiosk", { headers: { Cookie: cookieOf(paired) } }), e);
  assert.match(id!, /^ks_/);
  const stored = await e.HOME_DB!.prepare("SELECT token_hash, name FROM kiosk_devices").first<any>();
  assert.ok(!set.includes(stored.token_hash) && stored.name === "Hallway"); // only a hash is kept
  assert.equal(await kioskSession(req("/kiosk", { headers: { Cookie: `${COOKIE}=${"A".repeat(43)}` } }), e), null);

  await revoke(e, "alex", id!);
  assert.equal(await kioskSession(req("/kiosk", { headers: { Cookie: cookieOf(paired) } }), e), null);
  const list: any = await (await devices(e)).json();
  assert.equal(list.devices[0].revoked_by, "alex");
});

test("a pairing code runs out after 10 minutes", async () => {
  const e = env(), t0 = 1_800_000_000_000;
  const start: any = await (await pairStart(e, t0)).json();
  await assert.rejects(approve(e, "alex", { code: start.code }, t0 + 11 * 60_000), /no open pairing/);
  await assert.rejects(pairPoll(e, start.secret, t0 + 11 * 60_000), /expired/);
});

test("the kiosk host: an unpaired device only gets the pairing page", async () => {
  const e = env();
  assert.equal((await route(e, req("/kiosk"))).headers.get("location"), `https://${HOST}/pair`);
  assert.equal((await route(e, req("/api/ha"))).status, 401);
  assert.equal((await route(e, req("/api/me"))).status, 401);
  const page = await route(e, req("/pair"));
  assert.match(await page.text(), /Pair this tablet/);
  await assert.rejects(route(e, req("/api/kiosk/pair/start", { method: "POST" })), /cross-site/); // our header is required
});

test("the kiosk host: a paired tablet gets the wall page and is refused everything else", async () => {
  const e = env();
  const start: any = await (await pairStart(e)).json();
  await approve(e, "alex", { code: start.code });
  const headers = { Cookie: cookieOf(await pairPoll(e, start.secret)) };
  assert.equal(await (await route(e, req("/kiosk", { headers }))).text(), "asset");
  const me: any = await (await route(e, req("/api/me", { headers }))).json();
  assert.deepEqual([me.kiosk, me.person.admin, me.manage, me.nav[0].items.map((i: any) => i.path)], [true, false, [], ["/kiosk"]]);
  for (const p of ["/api/ha/setup", "/api/devices", "/api/security", "/api/kiosk/devices"]) await assert.rejects(route(e, req(p, { headers })), /not on the wall tablet/, p);
  await assert.rejects(route(e, req("/api/ha/light", { method: "POST", headers, body: "{}" })), /cross-site/);
  await assert.rejects(route(e, req("/dashboard/security", { headers })), /not found/);
});

test("a tablet's /api/me names no email and only modules it shows", () => {
  const me = tabletMe(h);
  assert.ok(!JSON.stringify(me).includes("@"));
  for (const m of me.modules) assert.ok(["homeAssistant", "energy", "calendar"].includes(m));
});
