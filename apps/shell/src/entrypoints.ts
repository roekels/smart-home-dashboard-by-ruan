// What the gateway Worker may ask this Worker to do, over service bindings only (never from the internet):
//   Home     behind /home/mcp     (modules/home-assistant, modules/energy)
//   Devices  behind /devices/mcp  (modules/edge-agents)
// The gateway has already checked the caller's token and cut its scopes to that MCP. Every method checks the scope
// again here, so a mistake in the gateway cannot open more than the connection was given.
// A caller is never a person here. An OAuth connection carries the id of the person who approved it (`person`),
// which only decides whose lists it sees; an API key carries none and gets the shared lists.
import { WorkerEntrypoint } from "cloudflare:workers";
import { householdFromVar, type Household } from "../../../packages/core/src/household.ts";
import type { Env } from "./env.ts";
import * as home from "../../../modules/home-assistant/service.ts";
import { energyNow } from "../../../modules/energy/worker.ts";
import * as admin from "../../../modules/edge-agents/admin.ts";
import { allow, need, plain, viewerOf, type Caller } from "./rpc.ts";

export type { Caller };

export class Home extends WorkerEntrypoint<Env> {
  private h(): Household { const h = householdFromVar(this.env.HOUSEHOLD); need(h, "homeAssistant"); return h; }

  /** Lights, scenes, plugs, and the energy picture when the energy module is on. */
  status(c: Caller) {
    return plain(async () => {
      allow(c, "home.read");
      const h = this.h(), controls = await home.homeControls(this.env);
      if (!h.modules.energy) return controls;
      const e = await energyNow(this.env);
      return { ...controls, energy: e.configured ? { now: e.now, today: e.today } : null };
    });
  }
  light(c: Caller, args: { entity: unknown; on: unknown; brightness?: unknown; kelvin?: unknown }) {
    return plain(async () => { const actor = allow(c, "home.control"); this.h(); return home.light(this.env, actor, args); });
  }
  scene(c: Caller, scene: unknown) {
    return plain(async () => { const actor = allow(c, "home.control"); this.h(); return home.scene(this.env, actor, scene); });
  }
  plug(c: Caller, args: { entity: unknown; on: unknown }) {
    return plain(async () => { const actor = allow(c, "home.plugs"); this.h(); return home.plug(this.env, actor, args); });
  }
  lists(c: Caller) {
    return plain(async () => { allow(c, "home.lists"); return { lists: await home.lists(this.env, viewerOf(this.h(), c)) }; });
  }
  listAdd(c: Caller, list: unknown, text: unknown) {
    return plain(async () => { allow(c, "home.lists"); return home.listAdd(this.env, viewerOf(this.h(), c), list, text); });
  }
  listDone(c: Caller, list: unknown, item: unknown, done: unknown) {
    return plain(async () => { allow(c, "home.lists"); return home.listDone(this.env, viewerOf(this.h(), c), list, item, done); });
  }
}

export class Devices extends WorkerEntrypoint<Env> {
  private h(): Household { const h = householdFromVar(this.env.HOUSEHOLD); need(h, "edgeAgents"); return h; }

  /** The approved machines: name, kind, online, last seen, and the commands each accepts. No keys, no fingerprints. */
  agents(c: Caller) {
    return plain(async () => {
      allow(c, "devices.read"); this.h();
      const list = (await admin.listAgents(this.env)).filter((a) => a.approved && !a.revoked);
      return { agents: list.map((a) => ({ id: a.id, name: a.name, kind: a.kind, online: a.online, last_seen: a.last_seen, allow_ops: a.allow_ops })) };
    });
  }
  latest(c: Caller, source?: string) {
    return plain(async () => { allow(c, "devices.read"); this.h(); return { records: await admin.latest(this.env, source ? String(source) : undefined) }; });
  }
  ops(c: Caller) {
    return plain(async () => { allow(c, "devices.read"); this.h(); return { ops: admin.COMMAND_OPS }; });
  }
  /** Safe commands are queued; destructive ones wait for an admin in the dashboard. There is no confirm here, on purpose. */
  propose(c: Caller, input: { agent?: unknown; op?: unknown; args?: unknown }) {
    return plain(async () => { const actor = allow(c, "devices.control"); this.h(); return admin.proposeCommand(this.env, actor, String(input?.agent ?? ""), String(input?.op ?? ""), input?.args); });
  }
  command(c: Caller, id: unknown) {
    return plain(async () => {
      allow(c, "devices.read"); this.h();
      const found = await admin.command(this.env, String(id ?? ""));
      if (!found) throw new Error("no such command");
      return { id: found.id, agent: found.agent, op: found.op, tier: found.tier, status: found.status, expires: found.expires, result: found.result };
    });
  }
}
