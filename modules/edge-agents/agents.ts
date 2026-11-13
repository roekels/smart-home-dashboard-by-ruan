// The machine side of the API (agent/PROTOCOL.md): enrolment, signed ingest, command polling and results.
// Callers here are programs, not people. Two locks: a Cloudflare Access service token at the edge (checked again
// here when AGENTS_ACCESS_AUD is set) and the agent's own signature on every request.
import type { Env } from "../../apps/shell/src/env.ts";
import { verifyAccessToken } from "../../packages/core/src/access.ts";
import { HttpError, json, sha256hex } from "../../packages/core/src/util.ts";
import { AGENT_ID, MAX_BODY, checkSignature, commandKey, fingerprint, importPublicKey, signCommand } from "./sign.ts";

const KIND = /^[a-z0-9.]{1,40}$/;
/** What an agent may store: its own collectors' kinds. Anything else is dropped and named in the reply. */
export const ALLOWED_KIND = /^(metrics\.[a-z0-9.]+|power\.[a-z0-9.]+|event)$/;
const MAX_RECORDS = 500;
const MAX_RECORD_BYTES = 8 * 1024;
const RATE_PER_MIN = 60;

export function adb(env: Env): D1Database {
  if (!env.AGENTS_DB) throw new HttpError(503, "the agents database is not connected (binding AGENTS_DB)");
  return env.AGENTS_DB;
}

export async function audit(env: Env, actor: string, action: string, target?: string, detail?: unknown): Promise<void> {
  await adb(env).prepare("INSERT INTO audit (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(Date.now(), actor, action, target ?? null, detail === undefined ? null : JSON.stringify(detail)).run();
}

const deny = () => new HttpError(401, "not allowed");

/** The edge layer: the request came through the service-auth Access application with a valid service token. */
async function accessOk(req: Request, env: Env): Promise<boolean> {
  if (!env.AGENTS_ACCESS_AUD) return true; // no Access application in front (local development)
  const claims = await verifyAccessToken(req.headers.get("Cf-Access-Jwt-Assertion"), { team: env.ACCESS_TEAM, aud: env.AGENTS_ACCESS_AUD });
  return !!claims && typeof claims.common_name === "string" && claims.common_name.length > 0;
}

/**
 * POST /api/agents/enrol  { agent, code, pubkey }: the one-time code from the dashboard is the credential.
 * The agent is then pending until an admin compares the fingerprint and approves it.
 * The reply carries the dashboard's command-signing public key, which the agent pins.
 */
export async function enrol(req: Request, env: Env): Promise<Response> {
  if (!(await accessOk(req, env))) throw deny();
  const body = (await req.json().catch(() => null)) as { agent?: string; code?: string; pubkey?: string } | null;
  if (!body?.agent || !AGENT_ID.test(body.agent) || typeof body.code !== "string" || typeof body.pubkey !== "string") throw new HttpError(400, "agent, code and pubkey are required");
  try { await importPublicKey(body.pubkey); } catch { throw new HttpError(400, "pubkey must be a raw Ed25519 public key, base64url"); }
  const cmd = await commandKey(env.SHELL_COMMAND_SIGNING_KEY).catch(() => { throw new HttpError(503, "the command signing key is not set yet"); });
  const row = await adb(env).prepare("SELECT enrol_hash, enrol_until, revoked FROM agents WHERE id = ?").bind(body.agent)
    .first<{ enrol_hash: string | null; enrol_until: number | null; revoked: number | null }>();
  const hash = await sha256hex(body.code.trim().toUpperCase()), now = Date.now();
  if (!row || row.revoked || !row.enrol_hash || !row.enrol_until || row.enrol_until < now || row.enrol_hash !== hash) {
    await audit(env, body.agent, "agent.enrol.refused", body.agent);
    throw deny();
  }
  // single use: the code is cleared in the same statement that stores the key
  const fp = await fingerprint(body.pubkey);
  const res = await adb(env).prepare(
    "UPDATE agents SET pubkey = ?, fingerprint = ?, approved = NULL, approved_by = NULL, enrol_hash = NULL, enrol_until = NULL, enrolled = ? WHERE id = ? AND enrol_hash = ?",
  ).bind(body.pubkey, fp, now, body.agent, hash).run();
  if (!res.meta.changes) throw deny();
  await audit(env, body.agent, "agent.enrolled", body.agent, { fingerprint: fp });
  return json({ ok: true, agent: body.agent, status: "pending", fingerprint: fp, command_key: { alg: "ed25519", x: cmd.pub } });
}

/** Verifies the service token, the signature, the nonce and the rate. Returns the agent id and the raw body. */
export async function authAgent(req: Request, env: Env, url: URL, now = Date.now()): Promise<{ agent: string; body: Uint8Array<ArrayBuffer> }> {
  const h = (n: string) => req.headers.get(n) ?? "";
  const agent = h("X-Agent-Id");
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) throw new HttpError(413, "too large");
  const body = new Uint8Array(await req.arrayBuffer());
  if (!(await accessOk(req, env))) throw deny();
  const row = AGENT_ID.test(agent)
    ? await adb(env).prepare("SELECT pubkey, approved, revoked FROM agents WHERE id = ?").bind(agent).first<{ pubkey: string | null; approved: number | null; revoked: number | null }>()
    : null;
  // a pending (not yet approved) agent is refused exactly like an unknown one
  if (!row?.pubkey || !row.approved || row.revoked) throw deny();
  const parts = { method: req.method, path: url.pathname, agent, ts: h("X-Agent-Ts"), nonce: h("X-Agent-Nonce"), bodySha: await sha256hex(body) };
  const check = await checkSignature(await importPublicKey(row.pubkey), parts, h("X-Agent-Sig"), body, now);
  if (!check.ok) throw deny();
  // replay: a nonce is accepted once per 10 minutes (the clock window is 2)
  const fresh = await adb(env).prepare("INSERT OR IGNORE INTO nonces (agent, nonce, ts) VALUES (?, ?, ?)").bind(agent, parts.nonce, now).run();
  if (!fresh.meta.changes) throw deny();
  const recent = await adb(env).prepare("SELECT COUNT(*) AS n FROM nonces WHERE agent = ? AND ts > ?").bind(agent, now - 60_000).first<{ n: number }>();
  if ((recent?.n ?? 0) > RATE_PER_MIN) throw new HttpError(429, "slow down");
  await adb(env).prepare("UPDATE agents SET last_seen = ? WHERE id = ?").bind(now, agent).run();
  return { agent, body };
}

interface IngestBody { v: 1; records: { kind: string; ts: number; data: Record<string, unknown> }[] }

export function validateIngest(raw: unknown): IngestBody {
  const b = raw as IngestBody;
  if (!b || b.v !== 1 || !Array.isArray(b.records)) throw new HttpError(400, "expected { v: 1, records: [] }");
  if (b.records.length > MAX_RECORDS) throw new HttpError(400, `at most ${MAX_RECORDS} records`);
  for (const r of b.records) {
    if (!r || typeof r.kind !== "string" || !KIND.test(r.kind)) throw new HttpError(400, "bad kind");
    if (!Number.isInteger(r.ts) || r.ts < 1.6e12 || r.ts > 4e12) throw new HttpError(400, "bad ts");
    if (!r.data || typeof r.data !== "object" || Array.isArray(r.data)) throw new HttpError(400, "data must be an object");
    if (JSON.stringify(r.data).length > MAX_RECORD_BYTES) throw new HttpError(400, "record too large");
  }
  return b;
}

const parse = (body: Uint8Array): unknown => { try { return JSON.parse(new TextDecoder().decode(body)); } catch { throw new HttpError(400, "not JSON"); } };

const waiting = async (env: Env, agent: string, now: number): Promise<number> =>
  (await adb(env).prepare("SELECT COUNT(*) AS n FROM commands WHERE agent = ? AND status = 'queued' AND expires > ?").bind(agent, now).first<{ n: number }>())?.n ?? 0;

/** POST /api/agents/ingest (signed). The source is always the agent that signed: it can never write as another. */
export async function ingest(env: Env, agent: string, body: Uint8Array): Promise<Response> {
  const b = validateIngest(parse(body)), rx = Date.now();
  const refused = new Set<string>();
  // records of kinds an agent may not store are dropped (not an error, or the agent's spool would retry them forever)
  const keep = b.records.filter((r) => ALLOWED_KIND.test(r.kind) || (refused.add(r.kind), false));
  const stmts: D1PreparedStatement[] = [];
  for (const r of keep) {
    const data = JSON.stringify(r.data);
    stmts.push(adb(env).prepare("INSERT INTO records (source, kind, ts, rx, data) VALUES (?, ?, ?, ?, ?)").bind(agent, r.kind, r.ts, rx, data));
    stmts.push(adb(env).prepare(
      "INSERT INTO latest (source, kind, ts, data) VALUES (?, ?, ?, ?) ON CONFLICT(source, kind) DO UPDATE SET ts = excluded.ts, data = excluded.data WHERE excluded.ts >= latest.ts",
    ).bind(agent, r.kind, r.ts, data));
  }
  if (stmts.length) await adb(env).batch(stmts);
  return json({ ok: true, accepted: keep.length, commands: await waiting(env, agent, rx), ...(refused.size ? { refused: [...refused] } : {}) });
}

/** GET /api/agents/commands (signed): hands out this agent's queued commands once, each signed by the dashboard. */
export async function pollCommands(env: Env, agent: string): Promise<Response> {
  const now = Date.now(), d = adb(env);
  await d.prepare("UPDATE commands SET status = 'expired' WHERE agent = ? AND status IN ('queued', 'proposed') AND expires <= ?").bind(agent, now).run();
  const rows = await d.prepare("SELECT id, op, args, tier, expires FROM commands WHERE agent = ? AND status = 'queued' ORDER BY created LIMIT 20")
    .bind(agent).all<{ id: string; op: string; args: string; tier: string; expires: number }>();
  const list = rows.results ?? [];
  if (!list.length) return json({ commands: [] });
  const { priv } = await commandKey(env.SHELL_COMMAND_SIGNING_KEY);
  await d.batch(list.map((c) => d.prepare("UPDATE commands SET status = 'delivered', delivered = ? WHERE id = ? AND status = 'queued'").bind(now, c.id)));
  const out = [];
  for (const c of list) {
    const args = JSON.parse(c.args);
    await audit(env, agent, "command.delivered", c.id);
    out.push({ id: c.id, op: c.op, args, tier: c.tier, expires: c.expires, sig: await signCommand(priv, { agent, id: c.id, op: c.op, args, expires: c.expires }) });
  }
  return json({ commands: out });
}

/** POST /api/agents/commands/<id>/result (signed): once per command. */
export async function commandResult(env: Env, agent: string, id: string, body: Uint8Array): Promise<Response> {
  const r = parse(body) as { ok?: boolean; output?: unknown };
  const out = JSON.stringify(r?.output ?? null);
  if (out.length > 16 * 1024) throw new HttpError(400, "output too large");
  const res = await adb(env).prepare("UPDATE commands SET status = ?, finished = ?, result = ? WHERE id = ? AND agent = ? AND status = 'delivered'")
    .bind(r?.ok ? "done" : "failed", Date.now(), out, id, agent).run();
  if (!res.meta.changes) throw new HttpError(409, "no such delivered command");
  await audit(env, agent, r?.ok ? "command.done" : "command.failed", id);
  return json({ ok: true });
}

/** Every /api/agents/* route. Returns null for a path that is not one of them. */
export async function agentRoutes(req: Request, env: Env, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/agents/")) return null;
  let r: Response | null = null;
  if (p === "/api/agents/enrol" && req.method === "POST") r = await enrol(req, env);
  else if (p === "/api/agents/ingest" && req.method === "POST") { const a = await authAgent(req, env, url); r = await ingest(env, a.agent, a.body); }
  else if (p === "/api/agents/commands" && req.method === "GET") { const a = await authAgent(req, env, url); r = await pollCommands(env, a.agent); }
  else {
    const m = /^\/api\/agents\/commands\/(cmd_[A-Za-z0-9_-]+)\/result$/.exec(p);
    if (m && req.method === "POST") { const a = await authAgent(req, env, url); r = await commandResult(env, a.agent, m[1], a.body); }
  }
  if (!r) throw new HttpError(404, "not found");
  r.headers.set("X-Server-Ts", String(Date.now())); // lets an agent measure its clock's drift
  return r;
}

/** Hourly: old nonces, records past 30 days (the latest of each kind stays), commands nobody picked up. */
export async function housekeeping(env: Env, now = Date.now()): Promise<void> {
  const d = adb(env);
  await d.batch([
    d.prepare("DELETE FROM nonces WHERE ts < ?").bind(now - 10 * 60_000),
    d.prepare("DELETE FROM records WHERE rx < ?").bind(now - 30 * 24 * 3600_000),
    d.prepare("UPDATE commands SET status = 'expired' WHERE status IN ('proposed', 'queued') AND expires <= ?").bind(now),
    d.prepare("DELETE FROM audit WHERE ts < ?").bind(now - 365 * 24 * 3600_000),
  ]);
}
