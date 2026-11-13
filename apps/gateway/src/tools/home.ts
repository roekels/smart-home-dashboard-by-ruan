// /home/mcp (the house, through Home Assistant) and /devices/mcp (the computers that run an edge agent).
// The gateway holds no household data: both reach the dashboard Worker over a service binding (bindings HOME and
// DEVICES -> <prefix>-shell, entrypoints Home and Devices; apps/shell/src/entrypoints.ts), which checks every
// scope again and does the work.
//
// Hints an AI app can rely on: read tools are readOnlyHint; lights, scenes and list items are plain writes
// (destructiveHint false) and happen at once; a plug and a computer command are destructiveHint. A destructive
// computer command is only proposed: it waits for an admin in the dashboard, and nothing here can confirm it.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { personByEmail, type Household } from "../../../../packages/core/src/household.ts";
import type { Principal } from "../env.ts";
import { fail, text } from "../mcp.ts";

/** Who is calling, as the dashboard Worker wants it (apps/shell/src/rpc.ts Caller). */
export interface Caller { id: string; scopes: string[]; person?: string }

/** A key is "key:<name>"; an OAuth connection keeps its "oauth:<client>" name and the person who approved it. */
export function callerOf(p: Principal, h: Household): Caller {
  const id = (p.via === "key" ? `key:${p.actor}` : p.actor).replace(/[^A-Za-z0-9:._@ -]/g, "-").slice(0, 80);
  const person = p.via === "oauth" && p.user ? personByEmail(h, p.user)?.id : undefined;
  return { id, scopes: p.scopes, ...(person ? { person } : {}) };
}

export interface HomeApi {
  status(c: Caller): Promise<unknown>;
  light(c: Caller, args: { entity: string | string[]; on: boolean; brightness?: number; kelvin?: number }): Promise<unknown>;
  scene(c: Caller, scene: string): Promise<unknown>;
  plug(c: Caller, args: { entity: string; on: boolean }): Promise<unknown>;
  lists(c: Caller): Promise<unknown>;
  listAdd(c: Caller, list: string, text: string): Promise<unknown>;
  listDone(c: Caller, list: string, item: string, done: boolean): Promise<unknown>;
}

export interface DevicesApi {
  agents(c: Caller): Promise<unknown>;
  latest(c: Caller, source?: string): Promise<unknown>;
  ops(c: Caller): Promise<unknown>;
  propose(c: Caller, input: { agent: string; op: string; args?: Record<string, unknown> }): Promise<{ id: string; status: string; tier: string; expires: number }>;
  command(c: Caller, id: string): Promise<unknown>;
}

export interface Deps<Api> {
  /** The service binding, or undefined when it is not connected. */
  api: Api | undefined;
  h: Household;
  /** Writes one audit row (names and ids only); never throws. */
  log(tool: string, ok: boolean, target?: string, detail?: string): void;
}

/** Runs one tool: a missing binding and every refusal become a plain tool error, and each call leaves one audit row. */
function runner<Api>(d: Deps<Api>, what: string) {
  return (tool: string, run: (api: Api, a: any) => Promise<unknown>, target?: (a: any) => string | undefined) => async (args: any) => {
    const t = target?.(args ?? {});
    if (!d.api) {
      d.log(tool, false, t, "binding missing");
      return fail(`${what} is not connected to the gateway right now.`);
    }
    try {
      const out = await run(d.api, args ?? {});
      d.log(tool, true, t);
      return text(out);
    } catch (e) {
      const msg = e instanceof Error && e.message ? e.message : "failed";
      d.log(tool, false, t, msg);
      return fail(msg);
    }
  };
}

const LIGHT = z.string().regex(/^light\.[a-z0-9_]{1,100}$/);
const first = (v: unknown): string | undefined => (Array.isArray(v) ? (v.length === 1 ? String(v[0]) : `${v.length} lights`) : typeof v === "string" ? v : undefined);

const homeInstructions = (h: Household) => `Home: ${h.household}'s house through Home Assistant.

- home_status lists the lights (and which are on), the scenes, the smart plugs${h.modules.energy ? ", and the energy picture: what the house uses, solar, grid and battery in watts, and today's totals in kWh" : ""}. Use the entity ids it returns; never guess one.
- set_light and run_scene happen at once. set_plug cuts or gives power to whatever hangs on a plug, so only use it when the person clearly asked for that plug.
- read_lists shows the shopping and to-do lists this connection may see. add_list_item and set_list_item_done change them; nothing is ever deleted.
- There are no locks, alarms, garage doors or heating here, and no way to add them through this connection.`;

export function buildHomeServer(p: Principal, d: Deps<HomeApi>): McpServer {
  const server = new McpServer({ name: "home", version: "0.1.0" }, { instructions: homeInstructions(d.h) });
  const c = callerOf(p, d.h), tool = runner(d, "The house"), has = (s: string) => p.scopes.includes(s);

  if (has("home.read")) {
    server.registerTool("home_status", {
      description: "The house right now: lights (on or off, brightness), scenes, smart plugs, and the energy picture when the household has one.",
      inputSchema: {}, annotations: { readOnlyHint: true },
    }, tool("home_status", (api) => api.status(c)));
  }
  if (has("home.control")) {
    server.registerTool("set_light", {
      description: "Turn one light or several on or off. With on: true you may also set brightness (1 to 100) and colour temperature in kelvin (2000 warm to 6500 cool).",
      inputSchema: { entity: z.union([LIGHT, z.array(LIGHT).min(1).max(60)]).describe("A light.* id from home_status, or a list of them"), on: z.boolean(), brightness: z.number().int().min(1).max(100).optional(), kelvin: z.number().int().min(2000).max(6500).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, tool("set_light", (api, a) => api.light(c, a), (a) => first(a.entity)));
    server.registerTool("run_scene", {
      description: "Activate a scene from home_status.",
      inputSchema: { scene: z.string().regex(/^(scene|script)\.[a-z0-9_]{1,100}$/).describe("A scene id from home_status") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, tool("run_scene", (api, a) => api.scene(c, a.scene), (a) => first(a.scene)));
  }
  if (has("home.plugs")) {
    server.registerTool("set_plug", {
      description: "Switch a smart plug from home_status on or off. This cuts or gives power to what hangs on it.",
      inputSchema: { entity: z.string().regex(/^switch\.[a-z0-9_]{1,100}$/), on: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    }, tool("set_plug", (api, a) => api.plug(c, a), (a) => first(a.entity)));
  }
  if (has("home.lists")) {
    server.registerTool("read_lists", {
      description: "The shopping and to-do lists this connection may see, with their open items and the latest few done ones.",
      inputSchema: {}, annotations: { readOnlyHint: true },
    }, tool("read_lists", (api) => api.lists(c)));
    server.registerTool("add_list_item", {
      description: "Add one item to the end of a list from read_lists.",
      inputSchema: { list: z.string().regex(/^todo\.[a-z0-9_]{1,100}$/).describe("A todo.* id from read_lists"), text: z.string().min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    }, tool("add_list_item", (api, a) => api.listAdd(c, a.list, a.text), (a) => first(a.list)));
    server.registerTool("set_list_item_done", {
      description: "Tick an item off (done: true) or bring it back (done: false). item is the item's uid from read_lists, or its exact text.",
      inputSchema: { list: z.string().regex(/^todo\.[a-z0-9_]{1,100}$/), item: z.string().min(1).max(200), done: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, tool("set_list_item_done", (api, a) => api.listDone(c, a.list, a.item, a.done), (a) => first(a.list)));
  }
  return server;
}

const devicesInstructions = (h: Household) => `Devices: ${h.household}'s computers that run an edge agent. Read their numbers and propose commands.

- Commands are proposals. The dashboard decides how risky each one is: safe ones (a ping, waking a computer) are queued and run within about half a minute; destructive ones (a shutdown) wait until an admin confirms them in the dashboard at https://${h.domain}/dashboard/agents. You cannot confirm them. Tell the person what you proposed and that it needs their confirmation.
- Never say a command ran until command_status shows it done. Commands expire after 5 minutes.
- Only the commands device_ops lists exist, and a computer only accepts the ones an admin allowed for it.`;

const explain = (out: { id: string; status: string; tier: string; expires: number }, h: Household) =>
  out.status === "proposed"
    ? { ...out, next: `Waiting for an admin to confirm it at https://${h.domain}/dashboard/agents within 5 minutes. Tell the person, then check command_status.` }
    : { ...out, next: "Queued: the computer picks it up within about 30 seconds. Check command_status for the result." };

export function buildDevicesServer(p: Principal, d: Deps<DevicesApi>): McpServer {
  const server = new McpServer({ name: "devices", version: "0.1.0" }, { instructions: devicesInstructions(d.h) });
  const c = callerOf(p, d.h), tool = runner(d, "The dashboard"), has = (s: string) => p.scopes.includes(s);
  const AGENT = z.string().regex(/^ag_[a-z0-9-]{3,40}$/);

  if (has("devices.read")) {
    server.registerTool("list_devices", { description: "The computers, whether each is online, when it was last seen, and which commands each accepts.", inputSchema: {}, annotations: { readOnlyHint: true } },
      tool("list_devices", (api) => api.agents(c)));
    server.registerTool("device_stats", { description: "The newest numbers (processor, memory, disk, temperatures, uptime) for one computer, or for all.", inputSchema: { device: AGENT.optional().describe("An id from list_devices") }, annotations: { readOnlyHint: true } },
      tool("device_stats", (api, a) => api.latest(c, a.device), (a) => first(a.device)));
    server.registerTool("device_ops", { description: "The commands that exist, and whether each runs at once (safe) or waits for an admin (destructive).", inputSchema: {}, annotations: { readOnlyHint: true } },
      tool("device_ops", (api) => api.ops(c)));
    server.registerTool("command_status", { description: "Where a proposed command is: proposed (waiting for an admin), queued, delivered, done, failed or expired, with its result.", inputSchema: { id: z.string().regex(/^cmd_[A-Za-z0-9_-]+$/) }, annotations: { readOnlyHint: true } },
      tool("command_status", (api, a) => api.command(c, a.id), (a) => first(a.id)));
  }
  if (has("devices.control")) {
    server.registerTool("run_command", {
      description: "Propose a command from device_ops for one computer. Safe ones are queued; destructive ones wait for an admin to confirm in the dashboard. Returns the command id.",
      inputSchema: { device: AGENT.describe("An id from list_devices"), op: z.string().regex(/^[a-z][a-z0-9_.]{1,60}$/), args: z.record(z.string(), z.unknown()).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    }, tool("run_command", async (api, a) => explain(await api.propose(c, { agent: a.device, op: a.op, args: a.args }), d.h), (a) => first(a.device)));
  }
  return server;
}
