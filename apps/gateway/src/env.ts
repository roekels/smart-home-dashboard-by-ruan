import type { BrainApi } from "../../brain/src/contract.ts";
import type { CalendarApi } from "../../calendar/src/contract.ts";
import type { FinanceApi } from "../../../modules/finance/src/contract.ts";
import type { HealthApi } from "../../../modules/health/src/contract.ts";
import type { DevicesApi, HomeApi } from "./tools/home.ts";

export interface Env {
  /** <prefix>-brain, entrypoint Brain: the notes behind /brain/mcp. Unset while the module is off. */
  BRAIN?: BrainApi;
  /** <prefix>-calendar, entrypoint Calendar: the iCloud calendars behind /calendar/mcp. Unset while the module is off. */
  CALENDAR?: CalendarApi;
  /** <prefix>-shell, entrypoint Finance: the sealed finance records behind /finance/mcp. Unset while the module is off. */
  FINANCE?: FinanceApi;
  /** <prefix>-shell, entrypoint Health: the sealed health records behind /health/mcp. Unset while the module is off. */
  HEALTH?: HealthApi;
  /** D1 <prefix>-gateway: API key hashes and the connection audit. */
  DB: D1Database;
  /** OAuth grants, tokens and clients for every MCP on the host. */
  OAUTH_KV: KVNamespace;
  /** household.config.json as JSON text (setup/wrangler-config.mjs writes it). Who may approve a connection, and which MCPs exist. */
  HOUSEHOLD: string;
  /** The Zero Trust team name: the first label of <team>.cloudflareaccess.com. */
  ACCESS_TEAM: string;
  /** AUD of the Access app in front of /oauth/authorize. Comma-separated if more than one app covers it. */
  ACCESS_AUD: string;
  /** Service binding to <prefix>-shell, entrypoint Home: the house behind /home/mcp. Present when Home Assistant is on. */
  HOME?: HomeApi;
  /** Service binding to <prefix>-shell, entrypoint Devices: the computers behind /devices/mcp. Present when edge agents are on. */
  DEVICES?: DevicesApi;
  /** wrangler dev only (git-ignored .dev.vars): the base address, e.g. http://localhost:8788. In the cloud it is https://<domain>. */
  DEV_PUBLIC_URL?: string;
  /** wrangler dev only (git-ignored .dev.vars): act as this email on the consent page. Never set in the cloud. */
  DEV_EMAIL?: string;
}

/** Who is calling an MCP. scopes are cut to the service of the path before any tool sees them. */
export interface Principal {
  /** Key name (e.g. "alfred") or "oauth:<client name>". */
  actor: string;
  via: "key" | "oauth";
  scopes: string[];
  /** For OAuth: the email of the person who approved the connection. */
  user?: string;
}
