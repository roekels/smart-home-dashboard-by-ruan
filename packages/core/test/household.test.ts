import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HouseholdError, MAX_PEOPLE, MODULE_IDS, enabledModules, householdFromVar, householdProblems, parseHousehold, personByEmail, personById, publicUrl, resourceName,
} from "../src/household.ts";

const root = new URL("../../../", import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const example = () => read("household.config.example.json");

test("the example config and the demo config are valid", () => {
  assert.deepEqual(householdProblems(example()), []);
  assert.deepEqual(householdProblems(read("demo/household.config.json")), []);
});

test("defaults are filled in and emails are lower-cased", () => {
  const h = parseHousehold({ household: " The Example house ", domain: "home.example.com", people: [{ id: "alex", name: "Alex", email: "Alex@Example.com", admin: true }], modules: { brain: true } });
  assert.equal(h.household, "The Example house");
  assert.equal(h.resourcePrefix, "home");
  assert.equal(h.language, "en");
  assert.equal(h.timezone, "UTC");
  assert.equal(h.people[0].email, "alex@example.com");
  assert.deepEqual(enabledModules(h), ["brain"]);
  assert.equal(h.modules.alfred, false);
  assert.equal(resourceName(h, "gateway"), "home-gateway");
  assert.equal(publicUrl(h), "https://home.example.com");
});

test("one to six people, each with their own id and email, at least one admin", () => {
  const c = example();
  const person = (i: number) => ({ id: `p${i}`, name: `Person ${i}`, email: `p${i}@example.com`, admin: i === 0 });
  c.people = Array.from({ length: MAX_PEOPLE }, (_, i) => person(i));
  assert.deepEqual(householdProblems(c), []);
  c.people.push(person(6));
  assert.match(householdProblems(c).join("\n"), /1 to 6 people/);
  c.people = [];
  assert.match(householdProblems(c).join("\n"), /1 to 6 people/);
  c.people = [person(1)];
  assert.match(householdProblems(c).join("\n"), /at least one person must be admin/);
  c.people = [person(0), { ...person(1), id: "p0" }];
  assert.match(householdProblems(c).join("\n"), /"p0" is used twice/);
  c.people = [person(0), { ...person(1), email: "P0@example.com" }];
  assert.match(householdProblems(c).join("\n"), /email: used twice/);
});

test("every problem is reported at once, in plain words", () => {
  const problems = householdProblems({ household: "", domain: "https://home.example.com", resourcePrefix: "Home!", language: "english please", timezone: "Mars/Olympus", people: [{ id: "Alex", name: "", email: "nope" }], modules: { brain: "yes", pool: true }, extra: 1 });
  for (const want of [/unknown setting "extra"/, /household: a name/, /domain: a hostname/, /resourcePrefix/, /language/, /timezone/, /people\[0\]\.id/, /people\[0\]\.name/, /people\[0\]\.email/, /at least one person must be admin/, /modules\.brain: true or false/, /unknown module "pool"/]) {
    assert.ok(problems.some((p) => want.test(p)), `missing: ${want}`);
  }
  assert.throws(() => parseHousehold([]), HouseholdError);
});

test("a module that needs another one says so", () => {
  const c = example();
  c.modules.energy = true;
  assert.match(householdProblems(c).join("\n"), /modules\.energy needs modules\.homeAssistant/);
  c.modules.homeAssistant = true;
  assert.deepEqual(householdProblems(c), []);
});

test("people are found by email (any case) and by id", () => {
  const h = parseHousehold(example());
  assert.equal(personByEmail(h, " ALEX@example.com ")?.id, "alex");
  assert.equal(personByEmail(h, "stranger@example.com"), null);
  assert.equal(personById(h, "sam")?.name, "Sam");
  assert.equal(personById(h, "nobody"), null);
});

test("the Worker var: parsed once, clear errors when missing or broken", () => {
  const raw = JSON.stringify(example());
  assert.equal(householdFromVar(raw), householdFromVar(raw));
  assert.throws(() => householdFromVar(undefined), /HOUSEHOLD var is not set/);
  assert.throws(() => householdFromVar("{"), /not valid JSON/);
});

test("the JSON schema lists the same modules and the same limit of people", () => {
  const schema = read("setup/household.schema.json");
  assert.deepEqual(Object.keys(schema.properties.modules.properties).sort(), [...MODULE_IDS].sort());
  assert.equal(schema.properties.people.maxItems, MAX_PEOPLE);
  assert.deepEqual(Object.keys(example().modules).sort(), [...MODULE_IDS].sort());
});
