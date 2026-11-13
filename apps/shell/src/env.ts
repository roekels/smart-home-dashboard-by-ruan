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
  /** Secret, during setup only: the key page's pass (setup-keys.ts). Set by setup/keys.mjs, deleted by the page. */
  SETUP_KEYPAGE_WRITE_TOKEN?: string;
  /** Service binding to <prefix>-alfred, present only when the alfred module is on (apps/alfred/shell.ts). */
  ALFRED?: Fetcher;
  /** wrangler dev only (git-ignored .dev.vars): an email from the household config to act as, skipping Access. */
  DEV_EMAIL?: string;
}
