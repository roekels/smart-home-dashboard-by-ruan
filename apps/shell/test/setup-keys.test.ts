import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHousehold } from "../../../packages/core/src/household.ts";
import { HttpError } from "../../../packages/core/src/util.ts";
import { KEYPAGE_SECRET, keyPageApi, readPass, valueProblem } from "../src/setup-keys.ts";
import type { ManifestSecret } from "../src/security.ts";

const example = JSON.parse(readFileSync(new URL("../../../household.config.example.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../../../secrets.manifest.json", import.meta.url), "utf8")).secrets as ManifestSecret[];
const H = parseHousehold(example);
const admin = H.people.find((p) => p.admin)!, other = H.people.find((p) => !p.admin)!;

const ACCOUNT = "a".repeat(32);
const KEY = Buffer.alloc(32, 7).toString("base64");
const PHRASE = "abcde-fghij-kmnop-qrstu-vwxyz";
const pass = JSON.stringify({
  token: "narrow-token-value", accountId: ACCOUNT, shell: "maple-shell",
  keys: [{ name: "HEALTH_DATA_ENCRYPTION_KEY", worker: "maple-vault" }, { name: "EXPORT_ZIP_PASSPHRASE", worker: "maple-shell" }],
});

/** A stand-in for the Cloudflare secrets API: which secrets each Worker has. */
function cloudflare(secrets: Record<string, Record<string, string>> = { "maple-shell": { [KEYPAGE_SECRET]: pass } }) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname.replace(`/client/v4/accounts/${ACCOUNT}`, ""), method = init.method ?? "GET";
    calls.push(`${method} ${path}`);
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer narrow-token-value");
    const m = path.match(/^\/workers\/scripts\/([^/]+)\/secrets(?:\/([^/]+))?$/)!;
    const list = (secrets[m[1]!] ??= {});
    if (method === "GET") return Response.json({ success: true, result: Object.keys(list).map((name) => ({ name })) });
    if (method === "DELETE") { delete list[m[2]!]; return Response.json({ success: true, result: null }); }
    const body = JSON.parse(String(init.body));
    list[body.name] = body.text;
    return Response.json({ success: true, result: { name: body.name } });
  }) as typeof fetch;
  return { secrets, calls, fetch: f };
}

const get = () => new Request("https://home.example.com/api/setup/keys");
const post = (keys: unknown) => new Request("https://home.example.com/api/setup/keys", { method: "POST", body: JSON.stringify({ keys }) });
const status = async (p: Promise<Response>) => p.then((r) => r.status, (e: HttpError) => e.status);

test("key page: closed without a pass, and for admins only", async () => {
  const closed = await keyPageApi({ req: get(), person: admin, passText: undefined, manifest, write: false });
  assert.deepEqual(await closed.json(), { state: "closed", keys: [] });
  assert.equal(await status(keyPageApi({ req: get(), person: other, passText: pass, manifest, write: false })), 403);
  assert.equal(await status(keyPageApi({ req: post({}), person: admin, passText: undefined, manifest, write: true })), 409);
  assert.equal(readPass("not json"), null);
  assert.equal(readPass(JSON.stringify({ token: "narrow-token-value", accountId: ACCOUNT, shell: "maple-shell", keys: [{ name: "lowercase_key", worker: "x" }] })), null);
});

test("key page: open shows names and purposes, never a value", async () => {
  const cf = cloudflare();
  const res = await keyPageApi({ req: get(), person: admin, passText: pass, manifest, write: false, fetch: cf.fetch });
  const body = (await res.json()) as { state: string; keys: { name: string; kind: string; set: boolean; purpose: string }[] };
  assert.equal(body.state, "open");
  assert.deepEqual(body.keys.map((k) => [k.name, k.kind, k.set]), [["HEALTH_DATA_ENCRYPTION_KEY", "key", false], ["EXPORT_ZIP_PASSPHRASE", "passphrase", false]]);
  assert.ok(body.keys.every((k) => k.purpose.length > 10));
  assert.equal(JSON.stringify(body).includes("narrow-token-value"), false);
});

test("key page: stores every key on its Worker, then locks itself", async () => {
  const cf = cloudflare();
  const res = await keyPageApi({ req: post({ HEALTH_DATA_ENCRYPTION_KEY: KEY, EXPORT_ZIP_PASSPHRASE: PHRASE }), person: admin, passText: pass, manifest, write: true, fetch: cf.fetch });
  const body = (await res.json()) as { state: string; saved: string[] };
  assert.equal(body.state, "locked");
  assert.deepEqual(body.saved, ["HEALTH_DATA_ENCRYPTION_KEY", "EXPORT_ZIP_PASSPHRASE"]);
  assert.equal(cf.secrets["maple-vault"]!.HEALTH_DATA_ENCRYPTION_KEY, KEY);
  assert.equal(cf.secrets["maple-shell"]!.EXPORT_ZIP_PASSPHRASE, PHRASE);
  assert.equal(KEYPAGE_SECRET in cf.secrets["maple-shell"]!, false, "the pass is gone, so the page cannot write again");
  assert.equal(JSON.stringify(body).includes(KEY), false, "the answer does not echo a value");
});

test("key page: refuses bad input before storing anything", async () => {
  const send = async (keys: unknown, write = true) => {
    const cf = cloudflare();
    const s = await status(keyPageApi({ req: post(keys), person: admin, passText: pass, manifest, write, fetch: cf.fetch }));
    assert.equal(cf.calls.some((c) => c.startsWith("PUT")), false);
    return s;
  };
  assert.equal(await send({ HEALTH_DATA_ENCRYPTION_KEY: KEY, EXPORT_ZIP_PASSPHRASE: PHRASE }, false), 403, "cross-site");
  assert.equal(await send({ HEALTH_DATA_ENCRYPTION_KEY: KEY }), 400, "one missing");
  assert.equal(await send({ HEALTH_DATA_ENCRYPTION_KEY: "short", EXPORT_ZIP_PASSPHRASE: PHRASE }), 400, "not a key");
  assert.equal(await send({ HEALTH_DATA_ENCRYPTION_KEY: KEY, EXPORT_ZIP_PASSPHRASE: PHRASE, OTHER_THING_KEY: KEY }), 400, "not on the list");
  assert.equal(valueProblem("X_DATA_ENCRYPTION_KEY", KEY), null);
  assert.equal(valueProblem("X_ZIP_PASSPHRASE", "has spaces in it, which is not allowed"), "a passphrase is 20 to 128 letters, digits and dashes");
});

test("key page: a key that is already set is never replaced", async () => {
  const cf = cloudflare({ "maple-shell": { [KEYPAGE_SECRET]: pass }, "maple-vault": { HEALTH_DATA_ENCRYPTION_KEY: "the-old-one" } });
  assert.equal(await status(keyPageApi({ req: post({ HEALTH_DATA_ENCRYPTION_KEY: KEY, EXPORT_ZIP_PASSPHRASE: PHRASE }), person: admin, passText: pass, manifest, write: true, fetch: cf.fetch })), 400);
  await keyPageApi({ req: post({ EXPORT_ZIP_PASSPHRASE: PHRASE }), person: admin, passText: pass, manifest, write: true, fetch: cf.fetch });
  assert.equal(cf.secrets["maple-vault"]!.HEALTH_DATA_ENCRYPTION_KEY, "the-old-one");
  assert.equal(KEYPAGE_SECRET in cf.secrets["maple-shell"]!, false);
});

test("key page: looking at it when everything is stored locks it", async () => {
  const cf = cloudflare({ "maple-shell": { [KEYPAGE_SECRET]: pass, EXPORT_ZIP_PASSPHRASE: PHRASE }, "maple-vault": { HEALTH_DATA_ENCRYPTION_KEY: KEY } });
  const res = await keyPageApi({ req: get(), person: admin, passText: pass, manifest, write: false, fetch: cf.fetch });
  assert.equal(((await res.json()) as { state: string }).state, "locked");
  assert.equal(KEYPAGE_SECRET in cf.secrets["maple-shell"]!, false);
});
