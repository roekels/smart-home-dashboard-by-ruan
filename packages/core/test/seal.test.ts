import test from "node:test";
import assert from "node:assert/strict";
import { SealError, isSealed, sealer } from "../src/seal.ts";

const SECRET = "test-passphrase-that-is-long-enough-0123456789";

test("seal: a round trip, a fresh iv each time, nothing readable in between", async () => {
  const s = sealer(SECRET, "health", "HEALTH_DATA_ENCRYPTION_KEY");
  const a = await s.seal({ note: "private-words" }), b = await s.seal({ note: "private-words" });
  assert.ok(isSealed(a));
  assert.notEqual(a, b);
  assert.ok(!a.includes("private-words"));
  assert.deepEqual(await s.unseal(a), { note: "private-words" });
});

test("seal: another secret or another module's label cannot open it", async () => {
  const sealed = await sealer(SECRET, "health", "X_KEY").seal("x");
  await assert.rejects(sealer(SECRET + "x", "health", "X_KEY").unseal(sealed));
  await assert.rejects(sealer(SECRET, "finance", "X_KEY").unseal(sealed));
});

test("seal: no secret or a short one fails closed and names the secret", async () => {
  const none = sealer(undefined, "health", "HEALTH_DATA_ENCRYPTION_KEY");
  assert.equal(none.ready, false);
  await assert.rejects(none.seal("x"), /HEALTH_DATA_ENCRYPTION_KEY is not set/);
  await assert.rejects(sealer("short", "health", "X_KEY").seal("x"), SealError);
  await assert.rejects(sealer(SECRET, "health", "X_KEY").unseal("plain text"), /not a sealed value/);
});
