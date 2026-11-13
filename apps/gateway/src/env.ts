import type { FinanceApi } from "../../../modules/finance/src/contract.ts";
import type { HealthApi } from "../../../modules/health/src/contract.ts";

export interface Env {
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
