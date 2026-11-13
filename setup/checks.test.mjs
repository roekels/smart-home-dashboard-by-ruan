import test from "node:test";
import assert from "node:assert/strict";
import { scanText, denyTerms } from "./scrub-check.mjs";
import { checkManifest, undeclared } from "./check-manifest.mjs";

const rules = (text, terms) => scanText(text, terms).map((f) => f.rule);

test("scrub: example data passes", () => {
  assert.deepEqual(rules("alex@example.com at https://home.example.com and https://api.cloudflare.com/client/v4"), []);
});

test("scrub: real-looking data fails", () => {
  assert.deepEqual(rules("mail someone@gmail.com"), ["email"]); // scrub-check: allow (test fixture)
  assert.deepEqual(rules("see https://home.some-family.net/x"), ["url-host"]); // scrub-check: allow (test fixture)
  assert.deepEqual(rules('"database_id": "0123abcd-0123-4abc-8abc-0123456789ab"'), ["uuid"]); // scrub-check: allow (test fixture)
  assert.deepEqual(rules("account 0123456789abcdef0123456789abcdef"), ["hex-id-32"]); // scrub-check: allow (test fixture)
  assert.deepEqual(rules("broadcast 192.168.1.255"), ["private-ip"]); // scrub-check: allow (test fixture)
  assert.deepEqual(rules("wol AA:BB:CC:01:02:03"), ["mac-address"]); // scrub-check: allow (test fixture)
  assert.deepEqual(rules("team myteam.cloudflareaccess.com"), ["access-team"]); // scrub-check: allow (test fixture)
});

test("scrub: all-zero placeholders pass, gateway keys fail", () => {
  assert.deepEqual(rules(`"id": "${"0".repeat(32)}", "aud": "${"0".repeat(64)}", "db": "00000000-0000-0000-0000-000000000000"`), []);
  assert.deepEqual(rules("Bearer hmcp_alfred_" + "Ab3".repeat(10)), ["api-key"]);
});

test("scrub: deny list hits never echo the term", () => {
  const found = scanText("the Smiths live here", ["smith"]);
  assert.equal(found.length, 1);
  assert.equal(found[0].rule, "deny-list #1");
  assert.equal(found[0].match, undefined);
});

test("scrub: deny list from env, comments and blanks dropped", () => {
  assert.deepEqual(denyTerms({ SCRUB_DENYLIST_TERMS: "# names\nsmith\n\n jones " }), ["smith", "jones"]);
});

test("scrub: an allow marker skips the line", () => {
  assert.deepEqual(rules("id 0123456789abcdef0123456789abcdef // scrub-check: allow"), []);
});

const good = { name: "HEALTH_DATA_ENCRYPTION_KEY", module: "health", purpose: "p", livesIn: "l", createdBy: "key-page", rotate: "r", ifLost: "i" };

test("manifest: a complete entry passes, bad ones fail", () => {
  assert.deepEqual(checkManifest({ secrets: [good] }), []);
  assert.match(checkManifest({ secrets: [{ ...good, name: "healthKey" }] }).join(), /UPPER_SNAKE_CASE/);
  assert.match(checkManifest({ secrets: [{ ...good, name: "HEALTH_THING" }] }).join(), /must end in/);
  assert.match(checkManifest({ secrets: [{ ...good, value: "x" }] }).join(), /never carry a value/);
  assert.match(checkManifest({ secrets: [good, good] }).join(), /listed twice/);
  assert.match(checkManifest({ secrets: [{ ...good, rotate: "" }] }).join(), /missing rotate/);
});

test("manifest: code may only read listed secrets", () => {
  const m = { secrets: [good, { ...good, name: "AGENT_<MACHINE>_SERVICE_TOKEN_KEY" }] };
  const files = [{ path: "apps/x.ts", text: "env.HEALTH_DATA_ENCRYPTION_KEY; env.AGENT_LAPTOP_SERVICE_TOKEN_KEY; env.OTHER_API_KEY; env.DB" }];
  assert.deepEqual(undeclared(m, files), ["OTHER_API_KEY (apps/x.ts)"]);
});
