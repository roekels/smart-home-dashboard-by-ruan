// /household/mcp: the one MCP every install has. It tells a connected AI where it is: who lives here (first names
// only), which modules are on and where their MCPs are. No email addresses, no data.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { enabledModules, type Household } from "../../../../packages/core/src/household.ts";
import type { Principal } from "../env.ts";
import { resourceOf, type Service } from "../services.ts";
import { fail, text } from "../mcp.ts";

export interface HouseholdInfo {
  household: string;
  language: string;
  timezone: string;
  people: { id: string; name: string; admin: boolean }[];
  modules: string[];
  mcps: { id: string; url: string; scopes: string[] }[];
}

export function householdInfo(h: Household, services: Service[], base: string): HouseholdInfo {
  return {
    household: h.household,
    language: h.language,
    timezone: h.timezone,
    people: h.people.map((p) => ({ id: p.id, name: p.name, admin: p.admin })),
    modules: enabledModules(h),
    mcps: services.map((s) => ({ id: s.id, url: resourceOf(base, s), scopes: Object.keys(s.scopes) })),
  };
}

const instructions = (h: Household) =>
  `Household: ${h.household}'s home dashboard. household_info lists the people (first names), the modules that are switched on and the address of each module's MCP. Each MCP is connected on its own, with its own permissions.`;

export interface HouseholdDeps {
  h: Household;
  services: Service[];
  base: string;
  /** Writes one audit row; never throws. */
  log(tool: string, ok: boolean, detail?: string): void;
}

export function buildHouseholdServer(p: Principal, d: HouseholdDeps): McpServer {
  const server = new McpServer({ name: "household", version: "0.1.0" }, { instructions: instructions(d.h) });
  server.registerTool(
    "household_info",
    { description: "Who lives here (first names), the time zone, which modules are on, and the address of each MCP.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      if (!p.scopes.includes("household.read")) {
        d.log("household_info", false, "missing scope household.read");
        return fail("This connection may not read the household (scope household.read).");
      }
      d.log("household_info", true);
      return text(householdInfo(d.h, d.services, d.base));
    },
  );
  return server;
}
