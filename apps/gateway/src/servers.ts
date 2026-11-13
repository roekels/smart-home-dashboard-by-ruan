// One MCP server builder per service id. services.ts says which services exist; this says what each one does.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Household } from "../../../packages/core/src/household.ts";
import type { Env, Principal } from "./env.ts";
import type { Service } from "./services.ts";
import { audit } from "./util.ts";
import { buildHouseholdServer } from "./tools/household.ts";
import { buildDevicesServer, buildHomeServer } from "./tools/home.ts";
import { buildCalendarServer } from "./tools/calendar.ts";
import { buildFinanceServer } from "./tools/finance.ts";
import { buildHealthServer } from "./tools/health.ts";

export interface ServerCtx {
  env: Env;
  ctx: Pick<ExecutionContext, "waitUntil">;
  /** The caller, with scopes already cut to this service. */
  principal: Principal;
  h: Household;
  service: Service;
  /** Every MCP of this household, and the base address they share. */
  services: Service[];
  base: string;
}

export type ServerBuilder = (c: ServerCtx) => McpServer;

/** One audit row per tool call: names and ids only. */
const logger = (c: ServerCtx) => (tool: string, ok: boolean, target?: string | null, detail?: string) =>
  void audit(c.env, c.ctx, { service: c.service.id, actor: c.principal.actor, via: c.principal.via, tool, target, ok, detail });

/** One line per module MCP, keyed by the service id from services.ts. */
export const SERVERS: Record<string, ServerBuilder> = {
  calendar: (c) => buildCalendarServer(c.principal, { h: c.h, calendar: c.env.CALENDAR, log: logger(c) }),
  finance: (c) => buildFinanceServer(c.principal, { h: c.h, finance: c.env.FINANCE, log: logger(c) }),
  health: (c) => buildHealthServer(c.principal, { h: c.h, health: c.env.HEALTH, log: logger(c) }),
  household: (c) =>
    buildHouseholdServer(c.principal, {
      h: c.h, services: c.services, base: c.base,
      log: (tool, ok, detail) => void audit(c.env, c.ctx, { service: c.service.id, actor: c.principal.actor, via: c.principal.via, tool, ok, detail }),
    }),
  home: (c) => buildHomeServer(c.principal, { api: c.env.HOME, h: c.h, log: logger(c) }),
  devices: (c) => buildDevicesServer(c.principal, { api: c.env.DEVICES, h: c.h, log: logger(c) }),
};
