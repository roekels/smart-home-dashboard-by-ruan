// The Edge agents module, as the shell sees it.
// Machines (the `machine` hook; a service token at the edge, then the agent's own signature):
//   POST /api/agents/enrol, POST /api/agents/ingest, GET /api/agents/commands, POST /api/agents/commands/<id>/result
// People, admins only:
//   GET  /api/devices                         machines, their newest records, the known commands, recent commands
//   GET  /api/devices/series?source=&kind=&fields=&hours=     a series for a chart
//   POST /api/devices                         { id, name, kind, allow_ops }   -> the one-time code
//   POST /api/devices/<id>/code | approve { fingerprint } | ops { allow_ops } | revoke
//   POST /api/devices/command { agent, op, args }             queue (safe) or propose (destructive)
//   POST /api/devices/command/<id>/confirm                    an admin's yes to a destructive command
//   GET  /api/devices/command/<id>
import type { ApiCtx, ShellModule } from "../../apps/shell/src/modules.ts";
import { resourceName } from "../../packages/core/src/household.ts";
import { HttpError, json } from "../../packages/core/src/util.ts";
import { agentRoutes, housekeeping } from "./agents.ts";
import { COMMAND_OPS, approveAgent, command, commands, confirmCommand, createAgent, latest, listAgents, newCode, proposeCommand, revokeAgent, series, setOps } from "./admin.ts";
import { demoDevices } from "./demo.ts";

const AGENT = "(ag_[a-z0-9-]{3,40})";

async function devices(c: ApiCtx): Promise<Response> {
  if (!c.person.admin) throw new HttpError(403, "machines are for admins");
  const { env, url, req } = c, p = url.pathname, by = c.person.id;
  if (req.method === "GET") {
    if (p === "/api/devices") {
      const [agents, records, recent] = await Promise.all([listAgents(env), latest(env), commands(env, 30)]);
      return json({ agents, records, ops: COMMAND_OPS, commands: recent, signing: !!env.SHELL_COMMAND_SIGNING_KEY });
    }
    if (p === "/api/devices/series") {
      const source = url.searchParams.get("source") ?? "", kind = url.searchParams.get("kind") ?? "";
      const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours") ?? 24) || 24));
      if (!/^ag_[a-z0-9-]{3,40}$/.test(source) || !/^[a-z0-9.]{1,40}$/.test(kind)) throw new HttpError(400, "source and kind are required");
      const fields = (url.searchParams.get("fields") ?? "").split(",").map((f) => f.trim()).filter((f) => /^[A-Za-z0-9_]{1,40}$/.test(f)).slice(0, 20);
      return json({ source, kind, points: await series(env, source, kind, Date.now() - hours * 3600_000, fields) });
    }
    const one = /^\/api\/devices\/command\/(cmd_[A-Za-z0-9_-]+)$/.exec(p);
    if (one) {
      const found = await command(env, one[1]);
      if (!found) throw new HttpError(404, "no such command");
      return json(found);
    }
    throw new HttpError(404, "not found");
  }
  if (req.method !== "POST" || !c.write) throw new HttpError(403, "cross-site or wrong method");
  const body: any = await req.json().catch(() => ({}));
  if (p === "/api/devices") return json(await createAgent(env, by, body), 201);
  if (p === "/api/devices/command") return json(await proposeCommand(env, by, String(body?.agent ?? ""), String(body?.op ?? ""), body?.args), 201);
  const confirm = /^\/api\/devices\/command\/(cmd_[A-Za-z0-9_-]+)\/confirm$/.exec(p);
  if (confirm) { await confirmCommand(env, by, confirm[1]); return json({ ok: true }); }
  const m = new RegExp(`^/api/devices/${AGENT}/(code|approve|ops|revoke)$`).exec(p);
  if (!m) throw new HttpError(404, "not found");
  if (m[2] === "code") return json(await newCode(env, by, m[1]), 201);
  if (m[2] === "approve") { await approveAgent(env, by, m[1], body?.fingerprint); return json({ ok: true }); }
  if (m[2] === "ops") return json({ ok: true, allow_ops: await setOps(env, by, m[1], body?.allow_ops) });
  await revokeAgent(env, by, m[1]);
  return json({ ok: true });
}

export const edgeAgents: ShellModule = {
  id: "edgeAgents",
  pages: [
    { path: "/dashboard/systems", label: "Systems", icon: "cpu", where: "metrics" },
    { path: "/dashboard/agents", label: "Edge agents", icon: "agents", where: "manage", text: "Add a computer, approve it, choose what it may be asked to do, revoke it." },
  ],
  api: { devices },
  demo: demoDevices,
  machine: async (c) => (c.demo ? null : agentRoutes(c.req, c.env, c.url)),
  cron: "* * * * *",
  scheduled: async (env, _h, now) => { if (now.getUTCMinutes() === 17) await housekeeping(env, now.getTime()); },
  security: (h) => ({
    nodes: [
      { id: "machines", zone: "home", name: "Your computers", sub: "edge agents", icon: "monitor", status: "ok",
        text: "A small program on each computer sends that machine's numbers out to the dashboard. Nothing on the computer listens, and it runs only the short list of commands built into it.",
        guard: ["A key pair made on the machine; the private key never leaves it", "Every request is signed, with a time and a number used once", "Commands must carry the dashboard's signature, and risky ones an admin's confirmation"],
        keys: ["AGENT_<MACHINE>_SERVICE_TOKEN_ID", "AGENT_<MACHINE>_SERVICE_TOKEN_KEY"] },
      { id: "agents-edge", zone: "edge", name: "Access · machines", sub: "service token only", icon: "lock", status: "ok",
        text: "/api/agents/* on the dashboard's domain. No person can sign in here: only a machine's service token passes, and then the dashboard checks the machine's own signature.",
        guard: ["An Access policy of type Service Auth", "A new machine stays pending until an admin has compared its fingerprint"] },
      { id: "agents-db", zone: "cf", name: resourceName(h, "agents"), sub: "D1 database", icon: "db", status: "ok",
        text: "The machines' public keys, what they sent in the last 30 days, the commands and an audit of every step." },
    ],
    links: [
      { from: "machines", to: "agents-edge", kind: "agent", label: "service token + signed requests, outbound only" },
      { from: "agents-edge", to: "shell", kind: "agent", label: "signature checked by the dashboard" },
      { from: "shell", to: "agents-db", kind: "service", label: "binding AGENTS_DB" },
    ],
    signIns: [
      { where: "/api/agents", who: "Computers an admin added and approved", how: "Access service token, then the machine's own signature on every request", status: "ok", note: "Add, approve and revoke under Settings > Edge agents." },
    ],
  }),
};
