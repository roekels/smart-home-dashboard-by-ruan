import type { BrainUiApi } from "../../brain/src/contract.ts";
import type { CalendarUiApi } from "../../calendar/src/contract.ts";

export interface Env {
  /** The built UI (web/ compiled into public/). */
  ASSETS: Fetcher;
  /** Var: household.config.json as JSON text, written into wrangler.jsonc by setup/wrangler-config.mjs. */
  HOUSEHOLD: string;
  /** Var: the Zero Trust team name, the first label of <team>.cloudflareaccess.com. */
  ACCESS_TEAM: string;
  /** Var: AUD tag of the Access application in front of this host. */
  ACCESS_AUD: string;
  /** Var "on": serve the made-up family from demo/ to anyone, with no sign-in. Nothing real is read or written.
   *  For previews and screenshots only; never set on a household's own dashboard. */
  DEMO_MODE?: string;
  /** Finance module: D1 <prefix>-finance, and the secret its rows are sealed with. Unset key = locked. */
  FINANCE_DB?: D1Database;
  FINANCE_DATA_ENCRYPTION_KEY?: string;
  /** Health module: D1 <prefix>-health, and the secret its records are sealed with. Unset key = locked. */
  HEALTH_DB?: D1Database;
  HEALTH_DATA_ENCRYPTION_KEY?: string;
  // ---- home modules (modules/home-assistant, energy, kiosk, edge-agents). Each is there only when its module is on.
  /** D1 <prefix>-home: the newest Home Assistant reading, the home settings, energy samples, paired wall tablets. */
  HOME_DB?: D1Database;
  /** D1 <prefix>-agents: edge agents, their records and commands. */
  AGENTS_DB?: D1Database;
  /** Var: the Home Assistant tunnel's address, https://<host>. Behind an Access app that only lets the service token in. */
  HA_URL?: string;
  /** Secret: Home Assistant long-lived access token of a dedicated, non-admin dashboard user. */
  HA_API_LONGLIVED_TOKEN?: string;
  /** Secrets: the Access service token that opens the tunnel for this Worker only. */
  HA_TUNNEL_SERVICE_TOKEN_ID?: string;
  HA_TUNNEL_SERVICE_TOKEN_KEY?: string;
  /** Var: the wall tablets' own hostname. No Access there: only a paired tablet's key opens it. */
  KIOSK_HOST?: string;
  /** Var: AUD tag of the service-auth Access app in front of /api/agents/*. */
  AGENTS_ACCESS_AUD?: string;
  /** Secret: 32 random bytes (base64), the seed of the Ed25519 key that signs every command sent to an edge agent. */
  SHELL_COMMAND_SIGNING_KEY?: string;
  /** Secret, during setup only: the key page's pass (setup-keys.ts). Set by setup/keys.mjs, deleted by the page. */
  SETUP_KEYPAGE_WRITE_TOKEN?: string;
  /** Service binding to <prefix>-brain, entrypoint BrainUi: the Brain page, for the signed-in person. */
  BRAIN?: BrainUiApi;
  /** Service binding to <prefix>-calendar, entrypoint CalendarUi: events for Today and the Calendar page, read only. */
  CALENDAR?: CalendarUiApi;
  /** Service binding to <prefix>-alfred, present only when the alfred module is on (apps/alfred/shell.ts). */
  ALFRED?: Fetcher;
  /** wrangler dev only (git-ignored .dev.vars): an email from the household config to act as, skipping Access. */
  DEV_EMAIL?: string;
}
