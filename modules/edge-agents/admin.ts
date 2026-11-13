// The people side of edge agents: what the Systems and Edge agents pages read, and the few things an admin does by
// hand (add a machine, approve it, revoke it, confirm a risky command). Also used by /devices/mcp, which can read
// and propose but never confirm.
import type { Env } from "../../apps/shell/src/env.ts";
import { HttpError, b64urlEncode, sha256hex } from "../../packages/core/src/util.ts";
import { adb, audit } from "./agents.ts";
import { COMMAND_OPS, commandOp } from "./ops.ts";
import { AGENT_ID, canonicalJson, normalizeAgentId } from "./sign.ts";

export const KINDS = ["mac", "windows", "linux", "other"];
export const ONLINE_MS = 3 * 60_000;
export const COMMAND_TTL_MS = 5 * 60_000;
const ENROL_MS = 10 * 60_000;
const MAX_ARGS_BYTES = 4 * 1024;
const PROPOSALS_PER_MIN = 20;

const newId = (prefix: string) => prefix + b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));

/** The one-time enrolment code: 8 characters without look-alikes, shown once and stored as a hash. */
export function enrolCode(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const c = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => A[b % A.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

const cleanOps = (raw: unknown): string[] => {
  const list = Array.isArray(raw) ? raw.map(String) : [];
  const bad = list.filter((o) => !commandOp(o));
  if (bad.length) throw new HttpError(400, `unknown commands: ${bad.join(", ").slice(0, 200)}`);
  return [...new Set(list)].sort();
};

export interface AgentRow {
  id: string; name: string; kind: string; fingerprint: string | null; allow_ops: string[]; created: number; enrolled: number | null;
  approved: number | null; approved_by: string | null; last_seen: number | null; revoked: number | null; has_key: boolean; online: boolean;
}

export async function listAgents(env: Env, now = Date.now()): Promise<AgentRow[]> {
  const r = await adb(env).prepare("SELECT id, name, kind, fingerprint, allow_ops, created, enrolled, approved, approved_by, last_seen, revoked, pubkey IS NOT NULL AS has_key FROM agents ORDER BY name").all<any>();
  return (r.results ?? []).map((a) => ({ ...a, allow_ops: JSON.parse(a.allow_ops), has_key: !!a.has_key, online: !a.revoked && !!a.approved && a.last_seen !== null && now - a.last_seen < ONLINE_MS }));
}

/** Creates an agent and hands out its one-time enrolment code. */
export async function createAgent(env: Env, by: string, body: any, now = Date.now()): Promise<{ id: string; code: string; expires: number }> {
  const id = normalizeAgentId(String(body?.id ?? "")), name = String(body?.name ?? "").trim().slice(0, 60), kind = String(body?.kind ?? "other");
  if (!AGENT_ID.test(id)) throw new HttpError(400, `"${id.slice(0, 60)}" is not a valid id: use 3 to 40 lower-case letters, digits or hyphens, like gaming-pc`);
  if (!name) throw new HttpError(400, "name is required");
  if (!KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${KINDS.join(", ")}`);
  const allow = cleanOps(body?.allow_ops), code = enrolCode();
  const res = await adb(env).prepare("INSERT OR IGNORE INTO agents (id, name, kind, allow_ops, enrol_hash, enrol_until, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, name, kind, JSON.stringify(allow), await sha256hex(code), now + ENROL_MS, now).run();
  if (!res.meta.changes) throw new HttpError(409, "a machine with this id exists");
  await audit(env, by, "agent.created", id, { kind, allow });
  return { id, code, expires: now + ENROL_MS };
}

/** A fresh code for a machine that has none in use (the first one ran out, or the machine was reinstalled). */
export async function newCode(env: Env, by: string, id: string, now = Date.now()): Promise<{ id: string; code: string; expires: number }> {
  const code = enrolCode();
  const res = await adb(env).prepare("UPDATE agents SET enrol_hash = ?, enrol_until = ?, pubkey = NULL, fingerprint = NULL, approved = NULL, approved_by = NULL WHERE id = ? AND revoked IS NULL")
    .bind(await sha256hex(code), now + ENROL_MS, id).run();
  if (!res.meta.changes) throw new HttpError(404, "no such machine");
  await audit(env, by, "agent.code", id);
  return { id, code, expires: now + ENROL_MS };
}

/** After enrolment: an admin compares the fingerprint the agent printed with the one shown here, then approves. */
export async function approveAgent(env: Env, by: string, id: string, fp: unknown): Promise<void> {
  const res = await adb(env).prepare("UPDATE agents SET approved = ?, approved_by = ? WHERE id = ? AND pubkey IS NOT NULL AND approved IS NULL AND revoked IS NULL AND fingerprint = ?")
    .bind(Date.now(), by, id, String(fp ?? "")).run();
  if (!res.meta.changes) throw new HttpError(409, "nothing to approve, or the fingerprint changed");
  await audit(env, by, "agent.approved", id);
}

export async function setOps(env: Env, by: string, id: string, raw: unknown): Promise<string[]> {
  const allow = cleanOps(raw);
  const res = await adb(env).prepare("UPDATE agents SET allow_ops = ? WHERE id = ? AND revoked IS NULL").bind(JSON.stringify(allow), id).run();
  if (!res.meta.changes) throw new HttpError(404, "no such machine");
  await audit(env, by, "agent.ops", id, { allow });
  return allow;
}

/** Stops all of an agent's requests at once: its key is forgotten and waiting commands are rejected. */
export async function revokeAgent(env: Env, by: string, id: string): Promise<void> {
  const d = adb(env);
  const res = await d.prepare("UPDATE agents SET revoked = ?, pubkey = NULL, enrol_hash = NULL WHERE id = ? AND revoked IS NULL").bind(Date.now(), id).run();
  if (!res.meta.changes) throw new HttpError(404, "no such machine, or already revoked");
  await d.prepare("UPDATE commands SET status = 'rejected' WHERE agent = ? AND status IN ('proposed', 'queued')").bind(id).run();
  await audit(env, by, "agent.revoked", id);
}

export interface LatestRecord { source: string; kind: string; ts: number; data: Record<string, unknown> }

/** The newest record per (machine, kind). */
export async function latest(env: Env, source?: string): Promise<LatestRecord[]> {
  const q = source ? adb(env).prepare("SELECT source, kind, ts, data FROM latest WHERE source = ?").bind(source) : adb(env).prepare("SELECT source, kind, ts, data FROM latest");
  return ((await q.all<{ source: string; kind: string; ts: number; data: string }>()).results ?? []).map((x) => ({ ...x, data: JSON.parse(x.data) }));
}

/** A series for a chart: one machine and kind, since a time, oldest first, only the named fields. */
export async function series(env: Env, source: string, kind: string, since: number, fields: string[]) {
  const r = await adb(env).prepare("SELECT ts, data FROM records WHERE source = ? AND kind = ? AND ts >= ? ORDER BY ts DESC LIMIT 1500")
    .bind(source, kind, since).all<{ ts: number; data: string }>();
  const pick = (d: Record<string, unknown>) => (fields.length ? Object.fromEntries(fields.filter((f) => f in d).map((f) => [f, d[f]])) : d);
  return (r.results ?? []).reverse().map((x) => ({ ts: x.ts, data: pick(JSON.parse(x.data)) }));
}

export interface Proposal { id: string; status: "queued" | "proposed"; tier: "safe" | "destructive"; expires: number }

/**
 * Queues a command. `actor` is who is accountable (a person id, or "mcp:<name>"). The tier always comes from
 * ops.ts: safe ops are queued, destructive ones wait as "proposed" for an admin's confirm on the Edge agents page.
 */
export async function proposeCommand(env: Env, actor: string, agent: string, op: string, rawArgs: unknown, now = Date.now()): Promise<Proposal> {
  const known = commandOp(op);
  if (!known) throw new HttpError(403, `${op.slice(0, 60)} is not a known command`);
  const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
  if (typeof args !== "object" || Array.isArray(args)) throw new HttpError(400, "args must be an object");
  if (new TextEncoder().encode(canonicalJson(args)).length > MAX_ARGS_BYTES) throw new HttpError(413, "args too large");
  const d = adb(env);
  const a = AGENT_ID.test(agent) ? await d.prepare("SELECT allow_ops, approved, revoked FROM agents WHERE id = ?").bind(agent).first<{ allow_ops: string; approved: number | null; revoked: number | null }>() : null;
  if (!a || a.revoked || !a.approved) throw new HttpError(404, "no such machine");
  if (!(JSON.parse(a.allow_ops) as string[]).includes(op)) throw new HttpError(403, `${op} is not allowed for ${agent}: allow it on the Edge agents page first`);
  const recent = await d.prepare("SELECT COUNT(*) AS n FROM commands WHERE proposed_by = ? AND created > ?").bind(actor, now - 60_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= PROPOSALS_PER_MIN) throw new HttpError(429, "too many commands, wait a minute");
  const id = newId("cmd_"), expires = now + COMMAND_TTL_MS, status = known.tier === "safe" ? "queued" : "proposed";
  await d.prepare("INSERT INTO commands (id, agent, op, args, tier, status, proposed_by, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, agent, op, JSON.stringify(args), known.tier, status, actor, now, expires).run();
  await audit(env, actor, `command.${status}`, id, { agent, op });
  return { id, status, tier: known.tier, expires };
}

/** An admin's yes to a destructive command. Never reachable from an AI app. */
export async function confirmCommand(env: Env, by: string, id: string, now = Date.now()): Promise<void> {
  const res = await adb(env).prepare("UPDATE commands SET status = 'queued', confirmed_by = ?, confirmed = ?, expires = ? WHERE id = ? AND status = 'proposed' AND expires > ?")
    .bind(by, now, now + COMMAND_TTL_MS, id, now).run();
  if (!res.meta.changes) throw new HttpError(409, "nothing to confirm (expired or already handled)");
  await audit(env, by, "command.confirmed", id);
}

export interface CommandRow { id: string; agent: string; op: string; tier: string; status: string; proposed_by: string; confirmed_by: string | null; created: number; expires: number; finished: number | null; result: unknown }

const COLS = "id, agent, op, tier, status, proposed_by, confirmed_by, created, expires, finished, result";
const row = (c: any): CommandRow => ({ ...c, result: c.result === null ? null : JSON.parse(c.result) });

export async function command(env: Env, id: string): Promise<CommandRow | null> {
  const c = await adb(env).prepare(`SELECT ${COLS} FROM commands WHERE id = ?`).bind(id).first<any>();
  return c ? row(c) : null;
}

export async function commands(env: Env, limit = 50): Promise<CommandRow[]> {
  return ((await adb(env).prepare(`SELECT ${COLS} FROM commands ORDER BY created DESC LIMIT ?`).bind(limit).all<any>()).results ?? []).map(row);
}

export { COMMAND_OPS };
