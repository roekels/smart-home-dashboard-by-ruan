import test from "node:test";
import assert from "node:assert/strict";
import { accessEmail, resetAccessCache, verifyAccessToken } from "../src/access.ts";
import { b64urlDecode, b64urlEncode, esc, safeEqual, securityHeaders, sha256hex } from "../src/util.ts";

const TEAM = "example", AUD = "aud-of-the-app", ISS = `https://${TEAM}.cloudflareaccess.com`;
const enc = new TextEncoder();

async function keyPair(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
  return { pair, jwk };
}

async function sign(key: CryptoKey, payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }) {
  const head = `${b64urlEncode(enc.encode(JSON.stringify(header)))}.${b64urlEncode(enc.encode(JSON.stringify(payload)))}`;
  return `${head}.${b64urlEncode(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(head)))}`;
}

const now = Date.UTC(2026, 0, 1);
const claims = (over: Record<string, unknown> = {}) => ({ iss: ISS, aud: [AUD], email: "Alex@Example.com", exp: now / 1000 + 600, nbf: now / 1000 - 10, ...over });

test("Access token: signature, issuer, audience and time are all checked", async () => {
  resetAccessCache();
  const { pair, jwk } = await keyPair("k1");
  const other = await keyPair("k1");
  let calls = 0;
  const fetcher = (async (url: string) => {
    calls++;
    assert.equal(url, `${ISS}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  }) as unknown as typeof fetch;
  const cfg = { team: TEAM, aud: AUD };
  const check = (t: string | null, c = cfg) => accessEmail(t, c, fetcher, now);

  assert.equal(await check(await sign(pair.privateKey, claims())), "alex@example.com");
  assert.equal(await check(await sign(pair.privateKey, claims()), { team: TEAM, aud: ["another", AUD] }), "alex@example.com", "any of several app AUDs passes");
  assert.equal(calls, 1, "the team's keys are fetched once and cached");

  assert.equal(await check(null), null, "no token");
  assert.equal(await check("a.b"), null, "not a JWT");
  assert.equal(await check(await sign(other.pair.privateKey, claims())), null, "signed by someone else");
  assert.equal(await check(await sign(pair.privateKey, claims({ aud: ["someone-else"] }))), null, "another app's token");
  assert.equal(await check(await sign(pair.privateKey, claims({ iss: "https://elsewhere.cloudflareaccess.com" }))), null, "another team"); // scrub-check: allow (test fixture)
  assert.equal(await check(await sign(pair.privateKey, claims({ exp: now / 1000 - 3600 }))), null, "expired");
  assert.equal(await check(await sign(pair.privateKey, claims({ nbf: now / 1000 + 3600 }))), null, "not valid yet");
  assert.equal(await check(await sign(pair.privateKey, claims(), { alg: "none", kid: "k1" })), null, "alg none");
  assert.equal(await check(await sign(pair.privateKey, claims(), { alg: "RS256", kid: "unknown" })), null, "unknown key id");
  assert.equal(await check(await sign(pair.privateKey, claims()), { team: TEAM, aud: "" }), null, "no AUD configured fails closed");
  assert.equal(await check(await sign(pair.privateKey, claims()), { team: "bad team/../x", aud: AUD }), null, "a team name that is not a name");

  const tampered = (await sign(pair.privateKey, claims())).split(".");
  tampered[1] = b64urlEncode(enc.encode(JSON.stringify(claims({ email: "mallory@example.com" }))));
  assert.equal(await check(tampered.join(".")), null, "payload changed after signing");

  const service = await verifyAccessToken(await sign(pair.privateKey, claims({ email: undefined, common_name: "token-id.access" })), cfg, fetcher, now);
  assert.equal(service?.common_name, "token-id.access", "service tokens verify too");
  assert.equal(await check(await sign(pair.privateKey, claims({ email: undefined, common_name: "token-id.access" }))), null, "but they are nobody's email");
});

test("Access token: a certs endpoint that fails means nobody gets in", async () => {
  resetAccessCache();
  const { pair } = await keyPair("k1");
  const down = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
  assert.equal(await accessEmail(await sign(pair.privateKey, claims()), { team: TEAM, aud: AUD }, down, now), null);
});

test("helpers", async () => {
  const bytes = new Uint8Array([0, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual([...b64urlDecode(b64urlEncode(bytes))], [...bytes]);
  assert.throws(() => b64urlDecode("a+b/"));
  assert.equal(await sha256hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"); // scrub-check: allow (the published SHA-256 test vector)
  assert.equal(safeEqual("same", "same"), true);
  assert.equal(safeEqual("same", "sama"), false);
  assert.equal(safeEqual("same", "longer"), false);
  assert.equal(esc(`<a href="x">'&</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;");
  assert.match(securityHeaders("'none'")["content-security-policy"], /script-src 'none'/);
  assert.match(securityHeaders()["content-security-policy"], /frame-ancestors 'none'/);
});
