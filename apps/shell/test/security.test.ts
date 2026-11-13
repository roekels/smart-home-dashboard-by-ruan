import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHousehold } from "../../../packages/core/src/household.ts";
import { securityModel, type ManifestSecret } from "../src/security.ts";
import type { ShellModule } from "../src/modules.ts";

const root = new URL("../../../", import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const secrets = read("secrets.manifest.json").secrets as ManifestSecret[];
const config = read("household.config.example.json");
const H = parseHousehold(config);
const now = new Date("2026-01-01T00:00:00Z");

test("security: the map is built from the household config", () => {
  const m = securityModel({ household: H, secrets, present: () => false, now });
  assert.equal(m.checked, now.toISOString());
  for (const p of H.people) assert.ok(m.nodes.some((n) => n.name === p.name), p.name);
  assert.ok(m.nodes.some((n) => n.name === "home-shell") && m.nodes.some((n) => n.name === "home-gateway"));
  const ids = new Set(m.nodes.map((n) => n.id));
  for (const l of m.links) assert.ok(ids.has(l.from) && ids.has(l.to), `${l.from} -> ${l.to}`);
  for (const z of m.zones) assert.ok(m.nodes.some((n) => n.zone === z.id), `zone ${z.id} has a node`);
  assert.equal(JSON.stringify(m).includes("@"), false, "no email addresses on the page");
});

test("security: keys come from the manifest, only for modules that are on", () => {
  const m = securityModel({ household: H, secrets, present: () => false, now });
  const names = m.keyGroups.flatMap((g) => g.rows.map((r) => r.name));
  assert.ok(names.includes("BRAIN_SENSITIVE_ENCRYPTION_KEY"), "brain is on in the example");
  assert.equal(names.includes("HEALTH_DATA_ENCRYPTION_KEY"), false, "health is off");
  assert.equal(names.includes("ALFRED_ANTHROPIC_API_KEY"), false, "alfred is off");
  assert.ok(names.includes("SETUP_CLOUDFLARE_FULL_TOKEN"));
  const all = securityModel({ household: parseHousehold({ ...config, modules: Object.fromEntries(Object.keys(config.modules).map((k) => [k, true])) }), secrets, present: () => false, now });
  assert.equal(all.keyGroups.flatMap((g) => g.rows).length, secrets.length, "every manifest entry shows when every module is on");
});

test("security: checks reflect one admin, several admins and demo mode", () => {
  const one = securityModel({ household: H, secrets, present: () => false, now });
  assert.equal(one.checks.find((c) => c.title === "More than one way back in")?.state, "self");
  assert.equal(one.checks.find((c) => c.title === "Demo mode is off")?.state, "done");
  const two = securityModel({ household: parseHousehold({ ...config, people: config.people.map((p: any) => ({ ...p, admin: true })) }), secrets, present: () => false, now });
  assert.equal(two.checks.find((c) => c.title === "More than one way back in")?.state, "done");
  const demo = securityModel({ household: H, secrets, present: () => false, demo: true, now });
  assert.equal(demo.checks.find((c) => c.title === "Demo mode is off")?.state, "open");
});

test("security: a module adds its own boxes, and links to missing boxes are dropped", () => {
  const brain: ShellModule = {
    id: "brain",
    security: () => ({
      nodes: [{ id: "brain", zone: "cloud", name: "home-brain", sub: "notes", icon: "brain", status: "ok", text: "The notes." }],
      links: [{ from: "gateway", to: "brain", kind: "service", label: "binding" }, { from: "brain", to: "nowhere", kind: "service", label: "dangling" }],
    }),
  };
  const m = securityModel({ household: H, secrets, present: () => true, modules: [brain], now });
  assert.ok(m.nodes.some((n) => n.id === "brain"));
  assert.ok(m.links.some((l) => l.to === "brain"));
  assert.equal(m.links.some((l) => l.to === "nowhere"), false);
});
