// The Brain's rules on a stand-in for D1 (node:sqlite with the real migration): the tree and its roots, edits and
// history, links that follow a rename, the sealed sensitive tier and who may reach it, and the two callers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHousehold } from "../../../packages/core/src/household.ts";
import { fakeD1 } from "../../../packages/core/test/fakes/d1.ts";
import { brainRoots, brainService, brainUi, type BrainEnv } from "../src/service.ts";
import { assertNoSecrets, appendToSection, forcedSensitivity, retarget, splitPath, wikilinks } from "../src/markdown.ts";
import type { BrainPrincipal, BrainTool } from "../src/contract.ts";

const example = JSON.parse(readFileSync(new URL("../../../household.config.example.json", import.meta.url), "utf8"));
const H = parseHousehold(example); // Alex (admin) and Sam; brain is on
const KEY = "test-passphrase-that-is-long-enough-0123456789";
const ALL = ["brain.read", "brain.read.sensitive", "brain.create", "brain.update", "brain.write.sensitive", "brain.archive"];

function setup(over: Partial<BrainEnv> = {}) {
  const DB = fakeD1(new URL("../migrations/", import.meta.url));
  const env: BrainEnv = { DB, HOUSEHOLD: JSON.stringify(example), BRAIN_SENSITIVE_ENCRYPTION_KEY: KEY, ...over };
  const api = brainService(env);
  const as = (p: BrainPrincipal) => async (tool: BrainTool, args: Record<string, unknown> = {}) => {
    const r = await api.call(p, tool, args);
    if (!r.ok) throw new Error(r.error);
    return r.value as any;
  };
  return {
    DB, env, api,
    key: as({ id: "script", via: "key", scopes: ALL }),
    alex: as({ id: "oauth:Test", via: "oauth", scopes: ALL, user: "alex@example.com" }),
    sam: as({ id: "oauth:Test", via: "oauth", scopes: ALL, user: "sam@example.com" }),
    as,
  };
}

test("markdown helpers", () => {
  assert.deepEqual(wikilinks("See [[Jo Bloggs]], [[Trips/Lisbon|the trip]] and [[Car#Tyres]]. `[[not this]]`"), ["Jo Bloggs", "Trips/Lisbon", "Car"]);
  assert.deepEqual(splitPath("alex/Work/ Team ", ["Alex", "Family"]), ["Alex", "Work", "Team"]);
  assert.throws(() => splitPath("Work/Team", ["Alex", "Family"]), /Paths start at Alex, Family/);
  assert.throws(() => splitPath("Alex//Team", ["Alex"]), /Bad path/);
  assert.equal(forcedSensitivity(["Alex", "Health", "Dentist"]), "sensitive");
  assert.equal(forcedSensitivity(["Health"]), null, "a root is never forced");
  assert.equal(appendToSection("# A\n\none\n\n# B\ntwo\n", "more", "A"), "# A\n\none\nmore\n\n# B\ntwo\n");
  assert.equal(retarget("[[Old]] and [[old#h|x]]", new Map([["old", { to: "New" }]])), "[[New]] and [[New#h|x]]");
  assert.throws(() => assertNoSecrets("password: hunter2abc"), /password value/);
  assert.throws(() => assertNoSecrets("card 4111 1111 1111 1111"), /card number/);
  assert.doesNotThrow(() => assertNoSecrets("The router password is kept in the password manager."));
});

test("the tree: one root per person and a shared one, made on first use", async () => {
  assert.deepEqual(brainRoots(H), ["Alex", "Sam", "Family"]);
  assert.deepEqual(brainRoots(H, "Home"), ["Alex", "Sam", "Home"]);
  const t = setup();
  assert.deepEqual(await t.api.roots(), ["Alex", "Sam", "Family"]);
  assert.equal(await t.key("tree"), "- Alex (hub)\n- Sam (hub)\n- Family (hub)");
  await assert.rejects(t.key("create", { path: "Work/Notes", summary: "x" }), /Paths start at Alex, Sam, Family/);
  await assert.rejects(t.key("create", { path: "Alex", summary: "x" }), /top of a tree/);
  await assert.rejects(t.key("create", { path: "Alex/Work/Team", summary: "x" }), /Parent "Alex\/Work" doesn't exist/);
  await t.key("create", { path: "alex/Work", kind: "hub", summary: "work hub" });
  await t.key("create", { path: "Alex/Work/Team", body: "# Team\n\nWorks with [[Jo Bloggs]].", summary: "the team" });
  assert.equal(await t.key("tree", { depth: 3 }), "- Alex (hub)\n  - Work (hub)\n    - Team (note)\n- Sam (hub)\n- Family (hub)");
  await assert.rejects(t.key("create", { path: "Alex/Work/Team", summary: "again" }), /already exists/);
  const shared = setup({ BRAIN_SHARED_ROOT: "Home" });
  assert.match(await shared.key("tree"), /- Home \(hub\)$/);
});

test("write, read, search, edit and go back", async () => {
  const t = setup();
  await t.key("create", { path: "Family/Car", body: "# Car\n\nBlue estate, bought 2029.\n\n## Service\n\n- 2030-03-02 tyres\n", frontmatter: { tags: "car, garage" }, summary: "the car" });
  const note = await t.key("read", { ref: "Family/Car" });
  assert.deepEqual([note.version, note.sensitivity, note.locked, note.frontmatter.type, note.frontmatter.tags], [1, "normal", false, "note", ["car", "garage"]]);
  assert.equal((await t.key("read", { ref: "car" })).path, "Family/Car", "a unique title is enough");

  assert.deepEqual((await t.key("search", { query: "estat" })).map((h: any) => h.path), ["Family/Car"]);
  assert.match((await t.key("search", { query: "tyres" }))[0].snippet, /«tyres»/);
  assert.deepEqual(await t.key("search", { query: "tyres", root: "sam" }), []);
  await assert.rejects(t.key("search", { query: "  " }), /Empty query/);

  await assert.rejects(t.key("edit", { ref: "Family/Car", base_version: 7, append: "x", summary: "stale" }), /is at version 1, not 7/);
  await assert.rejects(t.key("edit", { ref: "Family/Car", base_version: 1, replace: [{ old: "e", new: "E" }], summary: "vague" }), /must occur exactly once/);
  const edited = await t.key("edit", { ref: "Family/Car", base_version: 1, append: "- 2031-04-10 brakes", under_heading: "Service", replace: [{ old: "Blue", new: "Green" }], set: { status: "sold", tags: null }, summary: "brakes done, resprayed" });
  assert.equal(edited.version, 2);
  const v2 = await t.key("read", { ref: "Family/Car" });
  assert.match(v2.body, /Green estate[\s\S]*tyres\n- 2031-04-10 brakes\n/);
  assert.deepEqual([v2.frontmatter.status, v2.frontmatter.tags], ["sold", []]);
  assert.deepEqual(await t.key("edit", { ref: "Family/Car", base_version: 2, summary: "nothing" }), { unchanged: "Family/Car", version: 2 });
  await assert.rejects(t.key("edit", { ref: "Family/Car", base_version: 2, append: "api key sk-ant-abcdefghijklmnopqrstuvwx", summary: "oops" }), /API key or token/); // scrub-check: allow (a made-up key shape the Brain must refuse)

  const hist = await t.key("history", { ref: "Family/Car" });
  assert.deepEqual([hist.current_version, hist.earlier.length, hist.earlier[0].summary], [2, 1, "brakes done, resprayed"]);
  assert.match((await t.key("history", { ref: "Family/Car", version: 1 })).body, /Blue estate/);
  await t.key("restore", { ref: "Family/Car", version: 1, summary: "the respray was a mistake" });
  const v3 = await t.key("read", { ref: "Family/Car" });
  assert.deepEqual([v3.version, v3.frontmatter.status, /Blue estate/.test(v3.body)], [3, "active", true]);

  const log = await t.key("recent", { since: "2000-01-01" });
  assert.deepEqual(log.map((l: any) => l.job), ["edit", "edit", "create"]);
  assert.deepEqual(log[0].paths, ["Family/Car"]);
  assert.equal((await t.key("log_read", { job: "create" })).length, 1);
});

test("links resolve by title, wait for a note that does not exist yet, and follow a rename", async () => {
  const t = setup();
  await t.key("create", { path: "Alex/People", kind: "hub", summary: "people" });
  await t.key("create", { path: "Family/Trips", kind: "hub", summary: "trips" });
  await t.key("create", { path: "Family/Trips/Lisbon", body: "# Lisbon\n\nWith [[Jo Bloggs]] in May.", frontmatter: { related: ["Family/Trips"] }, summary: "trip idea" });
  assert.deepEqual((await t.key("lint")).unresolved_links, [{ path: "Family/Trips/Lisbon", target: "Jo Bloggs" }]);
  await t.key("create", { path: "Alex/People/Jo Bloggs", body: "# Jo Bloggs\n\nOld friend.", summary: "Jo" });
  assert.deepEqual((await t.key("lint")).unresolved_links, []);
  assert.deepEqual((await t.key("read", { ref: "Jo Bloggs" })).backlinks, [{ path: "Family/Trips/Lisbon", kind: "link" }]);

  const moved = await t.key("move", { ref: "Alex/People/Jo Bloggs", new_title: "Jo Smith", summary: "Jo married" });
  assert.deepEqual([moved.to, moved.links_updated_in], ["Alex/People/Jo Smith", ["Family/Trips/Lisbon"]]);
  assert.match((await t.key("read", { ref: "Family/Trips/Lisbon" })).body, /With \[\[Jo Smith\]\] in May/);
  const jo = await t.key("read", { ref: "Jo Bloggs" });
  assert.deepEqual([jo.path, jo.frontmatter.aliases, jo.body.startsWith("# Jo Smith")], ["Alex/People/Jo Smith", ["Jo Bloggs"], true], "the old name still finds it");

  await t.key("move", { ref: "Family/Trips", new_parent: "Alex", summary: "Alex plans the trips" });
  const lisbon = await t.key("read", { ref: "Alex/Trips/Lisbon" });
  assert.deepEqual([lisbon.version, lisbon.frontmatter.related], [3, ["[[Alex/Trips]]"]], "moved with its parent; its related link follows");
  await assert.rejects(t.key("move", { ref: "Alex/Trips", new_parent: "Alex/Trips/Lisbon", summary: "x" }), /under itself/);
  await assert.rejects(t.key("move", { ref: "Alex", new_title: "Lex", summary: "x" }), /Roots can't be moved/);

  await t.key("link", { from: "Alex/Trips/Lisbon", to: "Jo Smith", kind: "about", summary: "the trip is about Jo" });
  assert.ok((await t.key("read", { ref: "Alex/Trips/Lisbon" })).links.some((l: any) => l.kind === "about" && l.path === "Alex/People/Jo Smith"));

  await t.key("record_add", { ref: "Alex/Trips/Lisbon", date: "2031-05-02", kind: "cost", fields: { item: "Flights", amount: 240, currency: "GBP" }, summary: "flights" });
  const booked = await t.key("booking_link", { ref: "Alex/Trips/Lisbon", calendar: "shared", event_uid: "E1", event_title: "(Lisbon)", start: "2031-05-02", summary: "pencilled in" });
  assert.deepEqual([booked.status, booked.booking], ["idea", "idea"]);
  const fixed = await t.key("booking_link", { ref: "Alex/Trips/Lisbon", calendar: "shared", event_uid: "E2", event_title: "Lisbon", summary: "booked" });
  assert.equal(fixed.booking, "confirmed");
  const trip = await t.key("read", { ref: "Alex/Trips/Lisbon" });
  assert.deepEqual([trip.records[0].fields.item, trip.calendar.length, trip.frontmatter.booking], ["Flights", 2, "confirmed"]);
});

test("locked notes cannot be changed until they are unlocked", async () => {
  const t = setup();
  await t.key("create", { path: "Family/Old flat", body: "Sold in 2028.", summary: "old flat" });
  assert.deepEqual(await t.key("lock_archive", { ref: "Family/Old flat", summary: "over" }), { locked_and_archived: "Family/Old flat" });
  await assert.rejects(t.key("edit", { ref: "Family/Old flat", base_version: 2, append: "x", summary: "x" }), /is locked/);
  await assert.rejects(t.key("create", { path: "Family/Old flat/Keys", summary: "x" }), /is locked/);
  assert.equal((await t.key("read", { ref: "Family/Old flat" })).locked, true);
  assert.deepEqual((await t.key("search", { query: "sold", include_archived: false })), []);
  await t.key("unlock", { ref: "Family/Old flat", summary: "one more thing" });
  assert.equal((await t.key("edit", { ref: "Family/Old flat", base_version: 3, append: "Deposit returned.", summary: "deposit" })).version, 4);
});

test("sensitive notes are sealed, and a person reaches only their own and the shared ones", async () => {
  const t = setup();
  await t.alex("create", { path: "Alex/Health", kind: "hub", summary: "health" });
  const made = await t.alex("create", { path: "Alex/Health/Knee", body: "# Knee\n\nPhysio every Tuesday, zebra exercises.", summary: "knee" });
  assert.equal(made.sensitivity, "sensitive", "a Health branch is always sensitive");
  await t.sam("create", { path: "Family/Money worries", body: "Talk about the mortgage.", frontmatter: { sensitivity: "sensitive" }, summary: "shared and sealed" });
  await t.alex("record_add", { ref: "Alex/Health/Knee", date: "2031-02-01", kind: "measurement", fields: { bend: "110 degrees" }, summary: "bend" });

  const row = await t.DB.prepare("SELECT body, encrypted FROM nodes WHERE path = ?").bind("Alex/Health/Knee").first<{ body: string; encrypted: number }>();
  assert.ok(row!.encrypted === 1 && row!.body.startsWith("enc:v1:") && !row!.body.includes("zebra"));
  const everything = JSON.stringify([
    (await t.DB.prepare("SELECT * FROM nodes_fts").all()).results, (await t.DB.prepare("SELECT * FROM records").all()).results,
    (await t.DB.prepare("SELECT * FROM revisions").all()).results, (await t.DB.prepare("SELECT * FROM audit").all()).results,
  ]);
  for (const word of ["zebra", "mortgage", "110 degrees"]) assert.equal(everything.includes(word), false, word);

  // Alex: own and shared. Search finds the text by unsealing.
  assert.match((await t.alex("read", { ref: "Alex/Health/Knee" })).body, /zebra/);
  assert.equal((await t.alex("read", { ref: "Alex/Health/Knee" })).records[0].fields.bend, "110 degrees");
  assert.deepEqual((await t.alex("search", { query: "zebra" })).map((h: any) => h.path), ["Alex/Health/Knee"]);
  assert.deepEqual((await t.alex("search", { query: "mortgage" })).map((h: any) => h.path), ["Family/Money worries"]);

  // Sam: the shared one, not Alex's. Not in search, the tree, the log or a link.
  await assert.rejects(t.sam("read", { ref: "Alex/Health/Knee" }), /No note "Alex\/Health\/Knee"/);
  assert.deepEqual(await t.sam("search", { query: "zebra" }), []);
  assert.deepEqual(await t.sam("search", { query: "knee" }), [], "not even by title");
  assert.match((await t.sam("read", { ref: "Family/Money worries" })).body, /mortgage/);
  assert.equal((await t.sam("tree", { depth: 3 })).includes("Knee"), false);
  assert.equal(JSON.stringify(await t.sam("recent", { since: "2000-01-01" })).includes("Knee"), false);
  assert.ok(JSON.stringify(await t.alex("recent", { since: "2000-01-01" })).includes("Knee"));
  await assert.rejects(t.sam("edit", { ref: "Alex/Health/Knee", base_version: 1, append: "x", summary: "x" }), /No note/);
  await assert.rejects(t.sam("create", { path: "Alex/Health/Back", summary: "x" }), /belong to someone else/);
  await assert.rejects(t.sam("create", { path: "Sam/Notes", frontmatter: { sensitivity: "secret" }, summary: "x" }), /sensitivity must be one of normal, sensitive/);

  // A key reaches every root; without the scope nobody does.
  assert.match((await t.key("read", { ref: "Alex/Health/Knee" })).body, /zebra/);
  const plain = t.as({ id: "oauth:Test", via: "oauth", scopes: ["brain.read", "brain.create", "brain.update"], user: "alex@example.com" });
  await assert.rejects(plain("read", { ref: "Alex/Health/Knee" }), /No note/);
  await assert.rejects(plain("create", { path: "Alex/Health/Back", summary: "x" }), /lacks brain\.write\.sensitive/);

  // Moving a note into a sensitive branch seals it.
  await t.alex("create", { path: "Alex/Sleep", body: "Badger hours.", summary: "sleep" });
  await t.alex("move", { ref: "Alex/Sleep", new_parent: "Alex/Health", summary: "belongs with health" });
  const moved = await t.DB.prepare("SELECT body, sensitivity FROM nodes WHERE path = ?").bind("Alex/Health/Sleep").first<{ body: string; sensitivity: string }>();
  assert.ok(moved!.sensitivity === "sensitive" && moved!.body.startsWith("enc:v1:"));
  assert.equal(JSON.stringify((await t.DB.prepare("SELECT * FROM nodes_fts").all()).results).includes("Badger"), false);

  // Without the key the sealed notes are locked; everything else still works.
  const locked = brainService({ ...t.env, BRAIN_SENSITIVE_ENCRYPTION_KEY: undefined });
  const p: BrainPrincipal = { id: "script", via: "key", scopes: ALL };
  const r = await locked.call(p, "read", { ref: "Alex/Health/Knee" });
  assert.deepEqual([r.ok, !r.ok && r.refused, !r.ok && /is not set: this data is locked/.test(r.error)], [false, true, true]);
  assert.equal((await locked.call(p, "search", { query: "family" })).ok, true);
  assert.equal((await locked.call(p, "create", { path: "Family/Bins", body: "Tuesdays.", summary: "bins" })).ok, true);
});

test("the gateway's caller: scopes per tool, known people only, an audit without text", async () => {
  const t = setup();
  const reader = t.as({ id: "oauth:Test", via: "oauth", scopes: ["brain.read", "finance.read"], user: "sam@example.com" });
  assert.match(await reader("tree"), /Family/);
  await assert.rejects(reader("create", { path: "Sam/Notes", body: "secret plan", summary: "x" }), /lacks brain\.create/);
  await assert.rejects(reader("explode" as BrainTool), /Unknown tool/);
  await assert.rejects(t.as({ id: "oauth:Test", via: "oauth", scopes: ALL, user: "stranger@example.com" })("tree"), /not open to this person/);
  await assert.rejects(t.as({ id: "oauth:Test", via: "oauth", scopes: ALL })("tree"), /not open to this person/);
  await assert.rejects(t.as({ id: "", via: "key", scopes: ALL })("tree"), /no caller/);
  await assert.rejects(t.as({ id: "x", via: "dashboard" as "key", scopes: ALL })("tree"), /unknown connection type/);
  const off = brainService({ ...t.env, HOUSEHOLD: JSON.stringify({ ...example, modules: { ...example.modules, brain: false } }) });
  assert.deepEqual(await off.call({ id: "k", via: "key", scopes: ALL }, "tree", {}), { ok: false, refused: true, error: "The brain module is switched off." });

  await t.sam("create", { path: "Sam/Garden", body: "Plant the quince tree.", summary: "garden plan" });
  await t.sam("search", { query: "quince" });
  const audit = (await t.DB.prepare("SELECT actor, via, tool, target, ok, detail FROM audit ORDER BY id").all<any>()).results;
  assert.deepEqual(audit.at(-2), { actor: "oauth:test (sam)", via: "oauth", tool: "create", target: "Sam/Garden", ok: 1, detail: null });
  assert.deepEqual([audit.at(-1).tool, audit.at(-1).target], ["search", null], "what was searched for is not kept");
  assert.ok(audit.some((a) => a.ok === 0 && a.tool === "create" && /lacks brain\.create/.test(a.detail)));
  assert.equal(JSON.stringify(audit).includes("quince"), false);
  assert.equal(JSON.stringify(audit).includes("secret plan"), false);
});

test("the Brain page: the map, a note, saving with a rename, locking, what changed, the export", async () => {
  const t = setup();
  await t.alex("create", { path: "Alex/Health", kind: "hub", summary: "health" });
  await t.alex("create", { path: "Alex/Health/Knee", body: "Physio.", summary: "knee" });
  await t.key("create", { path: "Family/Car", body: "# Car\n\nSee [[Garage]].", summary: "car" });
  await t.key("create", { path: "Family/Garage", body: "Mentions the [[Car]].", summary: "garage" });
  const ui = brainUi(t.env);
  const get = async (who: string, path: string, query = "") => { const r = await ui.api(who, { method: "GET", path, query }); return { status: r.status, body: JSON.parse(r.body) }; };
  const post = async (who: string, path: string, body: unknown) => { const r = await ui.api(who, { method: "POST", path, body: JSON.stringify(body) }); return { status: r.status, body: JSON.parse(r.body) }; };

  const forAlex = (await get("alex", "/graph")).body, forSam = (await get("sam", "/graph")).body;
  assert.deepEqual(forAlex.roots, ["Alex", "Sam", "Family"]);
  assert.equal(forAlex.nodes.length, 7);
  assert.deepEqual(forSam.nodes.map((n: any) => n.path).sort(), ["Alex", "Family", "Family/Car", "Family/Garage", "Sam"], "Alex's sensitive notes are not on Sam's map");
  assert.ok(forSam.links.every((l: any) => forSam.nodes.some((n: any) => n.id === l.source) && forSam.nodes.some((n: any) => n.id === l.target)));
  assert.equal(forSam.links.filter((l: any) => l.kind === "link").length, 1, "Car and Garage point at each other: one line");
  assert.equal("body" in forAlex.nodes[0], false);

  assert.equal((await get("sam", "/note", "path=Alex%2FHealth%2FKnee")).status, 400);
  const car = (await get("sam", "/note", "path=Family%2FCar")).body;
  assert.deepEqual([car.version, car.history.length, car.backlinks[0].path], [1, 0, "Family/Garage"]);
  assert.deepEqual((await get("sam", "/search", "q=garage")).body.map((h: any) => h.path), ["Family/Garage", "Family/Car"]);

  const saved = await post("sam", "/note/save", { path: "Family/Car", base_version: 1, body: "# Car\n\nNow electric. See [[Garage]].", title: "Electric car" });
  assert.deepEqual([saved.status, saved.body.path, saved.body.version, saved.body.links_updated_in], [200, "Family/Electric car", 3, ["Family/Garage"]]);
  assert.match((await get("alex", "/note", "path=Family%2FElectric%20car")).body.body, /^# Electric car\n\nNow electric/);
  assert.match((await get("alex", "/note", "path=Family%2FGarage")).body.body, /\[\[Electric car\]\]/);
  const stale = await post("alex", "/note/save", { path: "Family/Electric car", base_version: 1, body: "x" });
  assert.deepEqual([stale.status, /changed since you opened it/.test(stale.body.error)], [400, true]);
  assert.equal((await post("alex", "/note/save", { path: "Family/Electric car" })).status, 400);
  const made = await post("sam", "/note/new", { parent: "Family", title: "Holiday ideas" });
  assert.deepEqual([made.status, made.body.path], [200, "Family/Holiday ideas"]);
  assert.equal((await get("alex", "/note", "path=Family%2FHoliday%20ideas")).body.body, "# Holiday ideas\n");
  assert.equal((await post("sam", "/note/new", { parent: "Family", title: "a/b" })).status, 400);
  assert.equal((await post("sam", "/note/new", { parent: "Nowhere", title: "x" })).status, 400);

  assert.deepEqual((await post("alex", "/note/lock", { path: "Family/Garage" })).body, { locked_and_archived: "Family/Garage" });
  assert.equal((await post("sam", "/note/save", { path: "Family/Garage", base_version: 3, body: "x" })).status, 400);
  assert.deepEqual((await post("sam", "/note/unlock", { path: "Family/Garage" })).body, { unlocked: "Family/Garage" });

  const activity = (await get("sam", "/activity", "since=2000-01-01T00:00:00Z")).body;
  assert.deepEqual(activity.map((a: any) => a.job), ["create", "create", "move", "edit", "create", "lock_archive", "unlock"], "oldest first, and nothing about Alex's sensitive notes");
  assert.equal(activity.at(-1).actor, "dashboard (sam)");
  assert.equal((await get("alex", "/activity")).status, 200);
  assert.equal((await get("alex", "/nope")).status, 404);
  assert.equal((await ui.api("stranger", { method: "GET", path: "/graph" })).status, 403);
  assert.equal((await ui.api("alex", { method: "POST", path: "/note/save", body: "{" })).status, 400);

  const lines = (await ui.exportAll("alex")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.find((l) => l.path === "Alex/Health/Knee").body, "Physio.", "unsealed for its owner");
  assert.deepEqual([...new Set(lines.map((l) => l.t))], ["node", "edge", "log"]);
  assert.equal((await ui.exportAll("sam")).includes("Knee"), false);
  await assert.rejects(ui.exportAll("stranger"), /not open to this person/);

  const audit = (await t.DB.prepare("SELECT actor, via, tool, target, ok FROM audit WHERE via = 'dashboard' ORDER BY id").all<any>()).results;
  assert.deepEqual(audit[0], { actor: "dashboard (sam)", via: "dashboard", tool: "ui/note/save", target: "Family/Car", ok: 1 });
  assert.equal(audit.filter((a) => a.ok === 0).length, 6);
});
