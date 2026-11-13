// The assistant module as the dashboard sees it: the proxy to its Worker, and demo mode.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHousehold, type Household } from "../../../packages/core/src/household.ts";
import { HttpError } from "../../../packages/core/src/util.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { MODULES, type ApiCtx } from "../src/modules.ts";
import { allPages, menuFor } from "../src/pages.ts";
import { DEMO_HOUSEHOLD } from "../src/demo.ts";
import { alfredModule } from "../../alfred/shell.ts";

const example = JSON.parse(readFileSync(new URL("../../../household.config.example.json", import.meta.url), "utf8"));
const H: Household = parseHousehold({ ...example, modules: { ...example.modules, alfred: true } });
const OFF: Household = parseHousehold(example);
const [alex, sam] = H.people;
const ASSETS = { fetch: async () => new Response("asset") } as unknown as Fetcher;

/** A stand-in for the assistant's Worker that remembers what it was sent. */
function binding(answer: () => Response = () => Response.json({ ok: true })) {
  const seen: Request[] = [];
  return { seen, ALFRED: { fetch: async (r: Request) => { seen.push(r); return answer(); } } as unknown as Fetcher };
}

function ctx(path: string, person = sam, init: RequestInit = {}, env: Partial<Env> = {}, write = true): ApiCtx {
  const url = new URL(`https://home.example.com${path}`);
  return { req: new Request(url, init), env: { ASSETS, HOUSEHOLD: "", ACCESS_TEAM: "", ACCESS_AUD: "", ...env }, url, household: H, person, write };
}
const forward = alfredModule.api!.alfred;
const refused = async (c: ApiCtx, status: number) => assert.rejects(forward(c), (e) => e instanceof HttpError && e.status === status);

test("assistant: registered, with a chat page for everyone and a settings page for admins", () => {
  assert.ok(MODULES.includes(alfredModule));
  assert.deepEqual(allPages(OFF).map((p) => p.path).filter((p) => /assistant|alfred/.test(p)), [], "off in the config: no pages");
  assert.ok(menuFor(H, sam).nav.some((g) => g.items.some((i) => i.path === "/home/assistant")));
  assert.deepEqual(menuFor(H, sam).manage, []);
  assert.ok(menuFor(H, alex).manage.some((m) => m.path === "/dashboard/alfred"));
});

test("assistant: the proxy sends the verified person's id and nothing the browser chose", async () => {
  const b = binding();
  const body = JSON.stringify({ message: "hello" });
  const res = await forward(ctx("/api/alfred/chat?x=1", sam, {
    method: "POST", body,
    headers: { "content-type": "application/json", "X-Alfred-Person": alex.id, Cookie: "session=abc", Authorization: "Bearer nope", "Cf-Access-Jwt-Assertion": "jwt" },
  }, b));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const sent = b.seen[0];
  assert.equal(new URL(sent.url).pathname, "/v1/chat");
  assert.equal(sent.headers.get("X-Alfred-Person"), sam.id, "the browser's own header is ignored");
  for (const h of ["cookie", "authorization", "cf-access-jwt-assertion"]) assert.equal(sent.headers.get(h), null, h);
  assert.equal(await sent.text(), body);
  assert.doesNotMatch(JSON.stringify([...sent.headers]), /@/, "no email address travels on");
});

test("assistant: an event stream comes back as a stream", async () => {
  const b = binding(() => new Response("event: text\ndata: {\"delta\":\"hi\"}\n\n", { headers: { "content-type": "text/event-stream; charset=utf-8" } }));
  const res = await forward(ctx("/api/alfred/chat", sam, { method: "POST", body: "{}" }, b));
  assert.match(res.headers.get("content-type") ?? "", /event-stream/);
  assert.match(await res.text(), /"delta":"hi"/);
});

test("assistant: only its own routes, methods and sizes get through", async () => {
  const b = binding();
  await refused(ctx("/api/alfred/internal/reset", alex, {}, b), 404);
  await refused(ctx("/api/alfred/conversations/not-an-id", alex, {}, b), 404);
  await refused(ctx("/api/alfred/settings", alex, { method: "DELETE" }, b), 405);
  await refused(ctx("/api/alfred/chat", sam, { method: "POST", body: "{}" }, b, false), 403);
  await refused(ctx("/api/alfred/chat", sam, { method: "POST", body: "x".repeat(70_000) }, b), 413);
  await refused(ctx("/api/alfred/health", sam, {}, b), 403);
  assert.equal(b.seen.length, 0);
  assert.equal((await forward(ctx("/api/alfred/health", alex, {}, b))).status, 200);
  assert.equal((await forward(ctx("/api/alfred/conversations/0b6f4c2e-1111-4222-8333-444455556666", sam, {}, b))).status, 200); // scrub-check: allow (test fixture)
});

test("assistant: without the Worker connected the page gets a plain answer, not a crash", async () => {
  const res = await forward(ctx("/api/alfred/conversations"));
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as any).code, "not_connected");
});

test("assistant: its Security entries name the secrets, never a value", () => {
  const part = alfredModule.security!(H);
  const text = JSON.stringify(part);
  assert.match(text, /ALFRED_ANTHROPIC_API_KEY/);
  assert.match(text, /ALFRED_GATEWAY_KEY/);
  assert.doesNotMatch(text, /sk-ant|hmcp_/);
  assert.equal(part.nodes[0].name, "home-alfred");
});

// ---- demo mode: the same routes answered from demo/data/alfred.json

const demo: Env = { ASSETS, HOUSEHOLD: "", ACCESS_TEAM: "", ACCESS_AUD: "", DEMO_MODE: "on" };
const as = (id: string) => ({ Cookie: `demo-person=${id}` });
const get = (path: string, who = DEMO_HOUSEHOLD.people[0].id) => worker.fetch(new Request(`https://demo.example.com${path}`, { headers: as(who) }), demo);
const post = (path: string, body: unknown, who = DEMO_HOUSEHOLD.people[0].id, ours = true) =>
  worker.fetch(new Request(`https://demo.example.com${path}`, { method: "POST", headers: { "content-type": "application/json", ...(ours ? { "X-Dashboard": "1" } : {}), ...as(who) }, body: JSON.stringify(body) }), demo);
const events = async (res: Response) => (await res.text()).split("\n\n").filter(Boolean).map((c) => {
  const [e, d] = c.split("\n");
  return { type: e.slice(7), ...JSON.parse(d.slice(6)) };
});

test("demo: a note waits on a card, and the yes finishes it", async () => {
  const admin = DEMO_HOUSEHOLD.people.find((p) => p.admin)!, other = DEMO_HOUSEHOLD.people.find((p) => p.id !== admin.id)!;
  assert.equal((await post("/api/alfred/chat", { message: "Note that the boiler was serviced" }, admin.id, false)).status, 403);
  const first = await events(await post("/api/alfred/chat", { message: "Note that the boiler was serviced" }, admin.id));
  const id = first.find((e) => e.type === "start").conversation_id;
  const card = first.find((e) => e.type === "confirm");
  assert.ok(card, "a write shows a card");
  assert.equal(first.at(-1).status, "awaiting_approval");

  const list: any = await (await get("/api/alfred/conversations", admin.id)).json();
  assert.ok(list.conversations.some((c: any) => c.id === id));
  assert.equal((await get(`/api/alfred/conversations/${id}`, other.id)).status, 404, "someone else's conversation");
  const held: any = await (await get(`/api/alfred/conversations/${id}`, admin.id)).json();
  assert.equal(held.waiting.length, 1);

  const second = await events(await post("/api/alfred/chat", { conversation_id: id, decisions: [{ id: card.id, ok: true }] }, admin.id));
  assert.equal(second.at(-1).status, "complete");
  assert.ok(second.some((e) => e.type === "tool" && e.status === "done"));
});

test("demo: a health chat gets a title that says nothing", async () => {
  const p = DEMO_HOUSEHOLD.people[0];
  const out = await events(await post("/api/alfred/chat", { message: "My tetanus vaccination was today" }, p.id));
  const id = out[0].conversation_id;
  const list: any = await (await get("/api/alfred/conversations", p.id)).json();
  assert.equal(list.conversations.find((c: any) => c.id === id).title, "Health");
});

test("demo: settings are for admins; everyone may learn the name", async () => {
  const admin = DEMO_HOUSEHOLD.people.find((p) => p.admin)!, member = DEMO_HOUSEHOLD.people.find((p) => !p.admin)!;
  assert.deepEqual(Object.keys(await (await get("/api/alfred/settings", member.id)).json() as object), ["name"]);
  assert.equal((await post("/api/alfred/settings", { name: "Mole" }, member.id)).status, 403);
  assert.equal((await get("/api/alfred/traces", member.id)).status, 403);
  const saved: any = await (await post("/api/alfred/settings", { name: "Juniper", permissions: { "brain.write": false } }, admin.id)).json();
  assert.equal(saved.name, "Juniper");
  assert.equal(saved.permissions["brain.write"], false);
  assert.equal(saved.adminCalendars, false, "off until an admin switches it on");
  assert.equal(((await (await post("/api/alfred/settings", { adminCalendars: true }, admin.id)).json()) as any).adminCalendars, true);
  await post("/api/alfred/settings", { adminCalendars: false }, admin.id);
  assert.ok(saved.services.length > 0);
  assert.equal(((await (await get("/api/alfred/settings", member.id)).json()) as any).name, "Juniper");
  const traces: any = await (await get("/api/alfred/traces", admin.id)).json();
  assert.ok(traces.traces.length > 0);
  for (const t of traces.traces) assert.ok(!/health|vaccin|blood/i.test(t.ask) || t.ask === "[health, not traced]");
  await post("/api/alfred/settings", { name: "Alfred" }, admin.id);
});
