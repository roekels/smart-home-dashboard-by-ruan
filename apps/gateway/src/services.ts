// The MCPs on the household's domain and their scopes. One OAuth server issues tokens for all of them, but each
// token is bound to one MCP (its resource), and each path only ever sees the scopes of its own service.
//
// This file is data only (no MCP SDK), so setup/wrangler-config.mjs can read it to write the Worker routes.
// To add a module's MCP: add its entry to MODULE_SERVICES here and its server to src/servers.ts.
import type { Household, ModuleId } from "../../../packages/core/src/household.ts";
import { publicUrl } from "../../../packages/core/src/household.ts";

export interface Service {
  /** Lower case, also the first path segment: "brain" lives at /brain/mcp. */
  id: string;
  /** Shown on the consent page after "Connect <app> to …". */
  title: string;
  /** Path of the MCP endpoint, e.g. /brain/mcp. */
  path: string;
  /** Every scope of this service starts with it. */
  prefix: string;
  /** Scopes a person can grant on the consent page: scope -> what it allows, in plain words. */
  scopes: Record<string, string>;
  /** Extra scopes only an API key can hold (never offered through OAuth). */
  keyOnly?: string[];
  /** Consent page sections: heading -> scopes, in order. Default: one list. */
  groups?: { heading: string; scopes: string[] }[];
}

export interface ServiceDef {
  /** The module that switches this MCP on. "core" is always on. */
  module: ModuleId | "core";
  /** Path prefix the Worker route must cover, e.g. "/brain/mcp". Fixed per service so routes need no household. */
  path: string;
  /** The service for this household: scopes may depend on its people (one calendar each, for example). */
  build(h: Household): Service;
}

const CORE: ServiceDef = {
  module: "core",
  path: "/household/mcp",
  build: () => ({
    id: "household", title: "the household", path: "/household/mcp", prefix: "household.",
    scopes: { "household.read": "See who lives here (first names), which modules are on and where their MCPs are" },
  }),
};

const HEALTH: ServiceDef = {
  module: "health",
  path: "/health/mcp",
  build: () => ({
    id: "health", title: "the health records", path: "/health/mcp", prefix: "health.",
    scopes: {
      "health.read": "Read doctor visits, test results, vaccinations and medication: your own, or everyone's if you are an admin",
      "health.write": "Add and change those records, and archive them (nothing is deleted)",
    },
  }),
};

const FINANCE: ServiceDef = {
  module: "finance",
  path: "/finance/mcp",
  build: () => ({
    id: "finance", title: "the finance records", path: "/finance/mcp", prefix: "finance.",
    scopes: {
      "finance.read": "Read accounts, balances, holdings, contracts, transactions and deadlines (admins only)",
      "finance.write": "Add and change those records",
      "finance.archive": "Archive a record and bring it back (nothing is deleted)",
    },
  }),
};

/** One entry per module MCP. */
export const MODULE_SERVICES: ServiceDef[] = [
  FINANCE, HEALTH,
  {
    module: "homeAssistant", path: "/home/mcp",
    build: () => ({
      id: "home", title: "the house (Home Assistant)", path: "/home/mcp", prefix: "home.",
      scopes: {
        "home.read": "See the lights, scenes and plugs, and the energy picture if there is one",
        "home.control": "Switch lights and run scenes",
        "home.lists": "Read the shopping and to-do lists you may see, add items and tick them off",
        "home.plugs": "Switch smart plugs on and off (this cuts power to what hangs on them)",
      },
    }),
  },
  {
    module: "edgeAgents", path: "/devices/mcp",
    build: () => ({
      id: "devices", title: "the computers", path: "/devices/mcp", prefix: "devices.",
      scopes: {
        "devices.read": "See the computers, their numbers and the results of commands",
        "devices.control": "Propose commands for a computer; risky ones wait for an admin to confirm in the dashboard",
      },
    }),
  },
];

export const SERVICE_DEFS: ServiceDef[] = [CORE, ...MODULE_SERVICES];

/** The MCPs this household has: the core one plus one per module that is on. */
export function servicesFor(h: Household, defs: ServiceDef[] = SERVICE_DEFS): Service[] {
  return defs.filter((d) => d.module === "core" || h.modules[d.module]).map((d) => d.build(h));
}

/** Problems in a set of services (a broken registry would hand out the wrong scopes). Empty = fine. */
export function serviceProblems(list: Service[]): string[] {
  const out: string[] = [];
  const ids = new Set<string>(), scopes = new Set<string>();
  for (const s of list) {
    if (!/^[a-z][a-z0-9-]*$/.test(s.id)) out.push(`${s.id}: id must be lower case`);
    if (ids.has(s.id)) out.push(`${s.id}: listed twice`);
    ids.add(s.id);
    if (!/^\/[a-z][a-z0-9-]*\/mcp$/.test(s.path)) out.push(`${s.id}: path must look like /<name>/mcp`);
    if (!/^[a-z][a-z0-9-]*\.$/.test(s.prefix)) out.push(`${s.id}: prefix must look like "name."`);
    for (const x of [...Object.keys(s.scopes), ...(s.keyOnly ?? [])]) {
      if (!x.startsWith(s.prefix)) out.push(`${s.id}: scope ${x} must start with ${s.prefix}`);
      if (scopes.has(x)) out.push(`${s.id}: scope ${x} is used twice`);
      scopes.add(x);
    }
    for (const g of s.groups ?? []) for (const x of g.scopes) if (!(x in s.scopes)) out.push(`${s.id}: group "${g.heading}" names unknown scope ${x}`);
  }
  for (const a of list) for (const b of list) if (a !== b && a.prefix.startsWith(b.prefix)) out.push(`${a.id}: prefix overlaps ${b.id}`);
  return out;
}

/** Everything the OAuth server can grant (RFC 8414 scopes_supported). Key-only scopes are not in it. */
export const oauthScopes = (list: Service[]): string[] => list.flatMap((s) => Object.keys(s.scopes));

/** The base address of every MCP: https://<domain>, no trailing slash. */
export const baseUrl = (h: Household, devUrl?: string): string => (devUrl || publicUrl(h)).replace(/\/$/, "");

export const resourceOf = (base: string, s: Service): string => `${base}${s.path}`;

/** The service whose MCP endpoint (or a path below it) this is. */
export function serviceForPath(list: Service[], pathname: string): Service | null {
  for (const s of list) if (pathname === s.path || pathname.startsWith(s.path + "/")) return s;
  return null;
}

/** The service a resource URL names (RFC 8707 `resource` on the authorize request). */
export function serviceForResource(list: Service[], base: string, resource: string | undefined): Service | null {
  if (!resource) return null;
  return list.find((s) => resourceOf(base, s) === resource) ?? null;
}

/** Keep only the scopes of one service. A key-only scope survives for keys on its own service; OAuth never carries it. */
export function cutScopes(scopes: readonly unknown[], s: Service, via: "key" | "oauth"): string[] {
  const allowed = new Set([...Object.keys(s.scopes), ...(via === "key" ? s.keyOnly ?? [] : [])]);
  return [...new Set(scopes.filter((x): x is string => typeof x === "string" && allowed.has(x)))];
}

/** Route patterns the gateway needs on the household's domain. They win over the shell's custom domain. */
export function routePatterns(domain: string, defs: ServiceDef[] = SERVICE_DEFS): string[] {
  return [...defs.map((d) => `${domain}${d.path}*`), `${domain}/oauth/*`, `${domain}/.well-known/oauth-*`];
}
