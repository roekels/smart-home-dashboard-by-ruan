import test from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../../../apps/shell/src/env.ts";
import { b64urlDecode, b64urlEncode, sha256hex } from "../../../packages/core/src/util.ts";
import { agentsDb } from "../../home-assistant/test/fakes/d1.ts";
import { agentRoutes, housekeeping } from "../agents.ts";
import { approveAgent, command, confirmCommand, createAgent, latest, listAgents, proposeCommand, revokeAgent, series, setOps } from "../admin.ts";
import { COMMAND_OPS } from "../ops.ts";
import { canonicalJson, commandKey, commandString, fingerprint, normalizeAgentId, sign } from "../sign.ts";

const SEED = Buffer.from(new Uint8Array(32).map((_, i) => i * 7 + 1)).toString("base64"); // a test key, not a real one
const env = (): Env => ({ AGENTS_DB: agentsDb(), SHELL_COMMAND_SIGNING_KEY: SEED, ACCESS_TEAM: "", ACCESS_AUD: "" } as unknown as Env);
const HOST = "https://home.example.com";

/** A made-up machine: its own key pair, and requests signed the way the Go agent signs them. */
async function machine(id: string) {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pubkey = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const request = async (method: string, path: string, body?: unknown, o: { nonce?: string; ts?: number; as?: string } = {}) => {
    const raw = new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body));
    const ts = String(o.ts ?? Date.now()), nonce = o.nonce ?? b64urlEncode(crypto.getRandomValues(new Uint8Array(18)));
    const sig = await sign(kp.privateKey, { method, path, agent: id, ts, nonce, bodySha: await sha256hex(raw) });
    return new Request(HOST + path, { method, body: body === undefined ? undefined : raw,
      headers: { "X-Agent-Id": o.as ?? id, "X-Agent-Ts": ts, "X-Agent-Nonce": nonce, "X-Agent-Sig": sig } });
  };
  return { id, pubkey, request };
}
const send = (e: Env, r: Request) => agentRoutes(r, e, new URL(r.url));
const enrol = (e: Env, body: unknown) => send(e, new Request(`${HOST}/api/agents/enrol`, { method: "POST", body: JSON.stringify(body) }));

/** Added, enrolled and approved, as an admin would do it. */
async function ready(e: Env, id = "ag_gaming-pc", ops = ["agent.ping", "pc.shutdown"]) {
  const m = await machine(id);
  const { code } = await createAgent(e, "alex", { id, name: "Gaming PC", kind: "windows", allow_ops: ops });
  const r: any = await (await enrol(e, { agent: id, code, pubkey: m.pubkey }))!.json();
  await approveAgent(e, "alex", id, r.fingerprint);
  return { m, reply: r };
}

test("ids from the form become valid ids", () => {
  assert.equal(normalizeAgentId(" Gaming_PC "), "ag_gaming-pc");
  assert.equal(normalizeAgentId("ag_home server"), "ag_home-server");
});

test("the command key is 32 random bytes as base64, like every _KEY secret", async () => {
  const k = await commandKey(SEED);
  assert.equal(b64urlDecode(k.pub).length, 32);
  await assert.rejects(commandKey(undefined), /not set/);
  await assert.rejects(commandKey("too-short"), /not set, or is not 32 bytes/);
  await assert.rejects(commandKey(JSON.stringify({ kty: "OKP" })), /32 bytes/);
});

test("enrolment: the code works once, and the machine stays shut out until an admin approves it", async () => {
  const e = env(), m = await machine("ag_family-laptop");
  const { code } = await createAgent(e, "alex", { id: "Family Laptop", name: "Family laptop", kind: "mac", allow_ops: ["agent.ping"] });
  await assert.rejects(enrol(e, { agent: m.id, code: "AAAA-AAAA", pubkey: m.pubkey }), /not allowed/);
  const r: any = await (await enrol(e, { agent: m.id, code, pubkey: m.pubkey }))!.json();
  assert.equal(r.status, "pending");
  assert.equal(r.fingerprint, await fingerprint(m.pubkey));
  assert.equal(r.command_key.x, (await commandKey(SEED)).pub);
  await assert.rejects(enrol(e, { agent: m.id, code, pubkey: m.pubkey }), /not allowed/);
  await assert.rejects(m.request("POST", "/api/agents/ingest", { v: 1, records: [] }).then((q) => send(e, q)), /not allowed/);
  await assert.rejects(approveAgent(e, "alex", m.id, "a-different-fingerprint"), /fingerprint changed/);
  await approveAgent(e, "alex", m.id, r.fingerprint);
  const ok: any = await (await send(e, await m.request("POST", "/api/agents/ingest", { v: 1, records: [] })))!.json();
  assert.equal(ok.ok, true);
  const row = (await listAgents(e))[0];
  assert.ok(row.online && row.approved_by === "alex" && row.has_key);
  assert.ok(!JSON.stringify(row).includes(m.pubkey)); // the pages never get the key itself
});

test("signed requests: no replay, no stale clock, no writing as another machine, no changed body", async () => {
  const e = env(), { m } = await ready(e);
  const other = (await ready(e, "ag_home-server")).m;
  const body = { v: 1, records: [{ kind: "metrics.host", ts: Date.now(), data: { cpu: 12 } }] };
  const first = await m.request("POST", "/api/agents/ingest", body, { nonce: "n".repeat(24) });
  assert.equal((await send(e, first))!.status, 200);
  await assert.rejects(m.request("POST", "/api/agents/ingest", body, { nonce: "n".repeat(24) }).then((q) => send(e, q)), /not allowed/);
  await assert.rejects(m.request("POST", "/api/agents/ingest", body, { ts: Date.now() - 5 * 60_000 }).then((q) => send(e, q)), /not allowed/);
  await assert.rejects(other.request("POST", "/api/agents/ingest", body, { as: m.id }).then((q) => send(e, q)), /not allowed/);
  const signed = await m.request("POST", "/api/agents/ingest", body);
  const tampered = new Request(signed.url, { method: "POST", headers: signed.headers, body: JSON.stringify({ v: 1, records: [] }) });
  await assert.rejects(send(e, tampered), /not allowed/);
  const got = await latest(e);
  assert.deepEqual(got.map((x) => [x.source, x.kind, x.data]), [[m.id, "metrics.host", { cpu: 12 }]]);
});

test("ingest: a machine can only store its own kinds, under its own name", async () => {
  const e = env(), { m } = await ready(e);
  const now = Date.now();
  const r: any = await (await send(e, await m.request("POST", "/api/agents/ingest", { v: 1, records: [
    { kind: "metrics.host", ts: now - 60_000, data: { cpu: 10, source: "ag_someone-else" } },
    { kind: "metrics.host", ts: now, data: { cpu: 20 } },
    { kind: "finance.balance", ts: now, data: { amount: 1 } },
  ] })))!.json();
  assert.deepEqual([r.accepted, r.refused], [2, ["finance.balance"]]);
  assert.deepEqual((await series(e, m.id, "metrics.host", 0, ["cpu"])).map((p) => p.data), [{ cpu: 10 }, { cpu: 20 }]);
  assert.equal((await latest(e, m.id))[0].data.cpu, 20);
  await assert.rejects(m.request("POST", "/api/agents/ingest", { v: 2 }).then((q) => send(e, q)), /expected/);
});

test("commands: safe ones queue, destructive ones wait for an admin, and each is signed for one machine", async () => {
  const e = env(), { m, reply } = await ready(e);
  await assert.rejects(proposeCommand(e, "alex", m.id, "shell.run", {}), /not a known command/);
  await assert.rejects(proposeCommand(e, "alex", m.id, "pc.wake", { target: "x" }), /not allowed for/);
  await assert.rejects(proposeCommand(e, "alex", "ag_nobody", "agent.ping", {}), /no such machine/);

  const ping = await proposeCommand(e, "mcp:key:assistant", m.id, "agent.ping", {});
  const off = await proposeCommand(e, "mcp:key:assistant", m.id, "pc.shutdown", { delay_s: 30 });
  assert.deepEqual([ping.status, off.status, off.tier], ["queued", "proposed", "destructive"]);

  let out: any = await (await send(e, await m.request("GET", "/api/agents/commands")))!.json();
  assert.deepEqual(out.commands.map((c: any) => c.op), ["agent.ping"]); // the shutdown is not handed out unconfirmed
  const c = out.commands[0];
  const pub = await crypto.subtle.importKey("raw", b64urlDecode(reply.command_key.x), { name: "Ed25519" }, false, ["verify"]);
  const text = await commandString({ agent: m.id, id: c.id, op: c.op, args: c.args, expires: c.expires });
  assert.ok(await crypto.subtle.verify("Ed25519", pub, b64urlDecode(c.sig), new TextEncoder().encode(text)));
  const forOther = await commandString({ agent: "ag_home-server", id: c.id, op: c.op, args: c.args, expires: c.expires });
  assert.ok(!(await crypto.subtle.verify("Ed25519", pub, b64urlDecode(c.sig), new TextEncoder().encode(forOther))));

  await confirmCommand(e, "alex", off.id);
  await assert.rejects(confirmCommand(e, "alex", off.id), /nothing to confirm/);
  out = await (await send(e, await m.request("GET", "/api/agents/commands")))!.json();
  assert.deepEqual(out.commands.map((x: any) => [x.op, x.tier, x.args]), [["pc.shutdown", "destructive", { delay_s: 30 }]]);

  await send(e, await m.request("POST", `/api/agents/commands/${c.id}/result`, { ok: true, output: { version: "0.1.0" } }));
  await assert.rejects(m.request("POST", `/api/agents/commands/${c.id}/result`, { ok: true }).then((q) => send(e, q)), /no such delivered command/);
  const done = await command(e, c.id);
  assert.deepEqual([done!.status, done!.proposed_by, done!.result], ["done", "mcp:key:assistant", { version: "0.1.0" }]);
});

test("a confirmation runs out, and a revoked machine is shut out at once", async () => {
  const e = env(), { m } = await ready(e);
  const off = await proposeCommand(e, "alex", m.id, "pc.shutdown", {}, 1_000_000);
  await assert.rejects(confirmCommand(e, "alex", off.id, 1_000_000 + 6 * 60_000), /nothing to confirm/);
  assert.deepEqual(await setOps(e, "alex", m.id, ["agent.ping"]), ["agent.ping"]);
  await assert.rejects(setOps(e, "alex", m.id, ["rm.everything"]), /unknown commands/);
  await revokeAgent(e, "alex", m.id);
  await assert.rejects(m.request("GET", "/api/agents/commands").then((q) => send(e, q)), /not allowed/);
  await housekeeping(e);
  const audit = await e.AGENTS_DB!.prepare("SELECT action FROM audit ORDER BY ts, rowid").all<{ action: string }>();
  assert.ok(audit.results!.some((a) => a.action === "agent.revoked"));
});

test("the list of commands is short, and canonical JSON sorts keys", () => {
  assert.deepEqual(COMMAND_OPS.filter((o) => o.tier === "destructive").map((o) => o.op), ["pc.shutdown"]);
  assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: null }] }), '{"a":[{"c":null,"d":1}],"b":1}');
});
