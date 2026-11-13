// Demo mode's machines: three made-up computers from demo/data/agents.json with numbers that move a little with
// the clock. Nothing can be added, approved or sent in the demo.
import type { ApiCtx } from "../../apps/shell/src/modules.ts";
import { HttpError, json } from "../../packages/core/src/util.ts";
import data from "../../demo/data/agents.json" with { type: "json" };
import { COMMAND_OPS } from "./ops.ts";

const MIN = 60_000;
const wave = (t: number, period: number, phase = 0) => Math.sin(t / (period * MIN) + phase);
const r1 = (v: number) => Math.round(v * 10) / 10;

function host(m: (typeof data.machines)[number], i: number, t: number): Record<string, unknown> {
  if (!m.online) return m.host;
  return { ...m.host, cpu: r1(Math.max(1, m.host.cpu + wave(t, 3, i) * m.host.cpu * 0.5)), mem: r1(m.host.mem + wave(t, 11, i) * 4), cpuTemp: r1(m.host.cpuTemp + wave(t, 5, i) * 3) };
}

export async function demoDevices(c: ApiCtx): Promise<Response | null> {
  const p = c.url.pathname;
  if (p !== "/api/devices" && !p.startsWith("/api/devices/")) return null;
  if (!c.person.admin) throw new HttpError(403, "machines are for admins");
  const now = Date.now(), by = c.household.people[0].id;
  if (c.req.method === "GET" && p === "/api/devices") {
    return json({
      agents: data.machines.map((m) => ({
        id: m.id, name: m.name, kind: m.kind, fingerprint: m.fingerprint, allow_ops: m.allow_ops, created: now - m.days * 86_400_000, enrolled: now - m.days * 86_400_000,
        approved: m.pending ? null : now - m.days * 86_400_000, approved_by: m.pending ? null : by, last_seen: m.online ? now - 20_000 : now - m.agoMin * MIN, revoked: null, has_key: true, online: m.online,
      })),
      records: data.machines.filter((m) => !m.pending).map((m, i) => ({ source: m.id, kind: "metrics.host", ts: m.online ? now - 20_000 : now - m.agoMin * MIN, data: host(m, i, now) })),
      ops: COMMAND_OPS, commands: [], signing: true,
    });
  }
  if (c.req.method === "GET" && p === "/api/devices/series") {
    const i = data.machines.findIndex((m) => m.id === c.url.searchParams.get("source")), m = data.machines[i];
    if (!m) throw new HttpError(404, "no such machine");
    const start = now - 24 * 60 * MIN;
    return json({ source: m.id, kind: "metrics.host", points: Array.from({ length: 96 }, (_, k) => {
      const t = start + k * 15 * MIN, h = host({ ...m, online: true }, i, t);
      return { ts: t, data: { cpu: h.cpu, mem: h.mem, cpuTemp: h.cpuTemp } };
    }) });
  }
  throw new HttpError(400, "the demo's machines are made up: nothing can be added, approved or sent");
}
