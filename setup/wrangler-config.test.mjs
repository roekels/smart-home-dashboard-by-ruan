import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadInputs, outOfDate, render, resourceProblems } from "./wrangler-config.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const config = read("household.config.example.json");
const resources = read("setup/resources.example.json");
// The rendered files carry two comment lines on top, then plain JSON.
const parse = (text) => JSON.parse(text.split("\n").filter((l) => !l.startsWith("//")).join("\n"));

test("the committed wrangler configs match their inputs", () => {
  assert.deepEqual(outOfDate(), [], "run: node setup/wrangler-config.mjs");
});

test("names, domain and routes come from the household config", () => {
  const files = render({ config: { ...config, domain: "house.example.org", resourcePrefix: "maple" }, resources });
  const shell = parse(files["apps/shell/wrangler.jsonc"]), gateway = parse(files["apps/gateway/wrangler.jsonc"]);
  assert.equal(shell.name, "maple-shell");
  assert.deepEqual(shell.routes, [{ pattern: "house.example.org", custom_domain: true }]);
  assert.equal(shell.workers_dev, false);
  assert.equal(shell.preview_urls, false);
  assert.equal(shell.assets.run_worker_first, true, "the Worker checks the sign-in before any file is served");
  assert.equal(gateway.name, "maple-gateway");
  assert.equal(gateway.d1_databases[0].database_name, "maple-gateway");
  assert.ok(gateway.routes.includes("house.example.org/household/mcp*") && gateway.routes.includes("house.example.org/oauth/*"));
  assert.equal(gateway.workers_dev, false);
  for (const w of [shell, gateway]) {
    assert.equal(JSON.parse(w.vars.HOUSEHOLD).domain, "house.example.org");
    assert.equal(w.vars.ACCESS_TEAM, "your-team");
    assert.equal("DEMO_MODE" in w.vars, false);
    assert.equal("DEV_EMAIL" in w.vars, false);
  }
});

test("no secret can end up in a rendered config", () => {
  const manifest = read("secrets.manifest.json");
  const text = Object.values(render({ config, resources })).join("\n");
  for (const s of manifest.secrets) assert.equal(text.includes(s.name), false, s.name);
});

test("bad inputs are refused with every problem named", () => {
  assert.throws(() => render({ config: { ...config, people: [] }, resources }), /1 to 6 people/);
  assert.throws(() => render({ config, resources: { accessTeam: "Not A Team", accessAud: "x", gateway: {} } }), /accessTeam.*accessAud.*d1DatabaseId.*kvNamespaceId/s);
  assert.deepEqual(resourceProblems(resources), []);
  assert.ok(loadInputs().config.people.length >= 1);
});
