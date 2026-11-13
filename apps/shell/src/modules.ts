// What a module adds to the shell Worker. The shell itself only knows sign-in, Today, Settings and Security;
// everything else (Brain, Calendar, Finance, Health, Home Assistant …) is a module that registers here.
//
// To add a module: write its descriptor next to its code (modules/<name>/worker.ts or apps/<name>/shell.ts),
// import it below and add it to MODULES. Its pages, API routes and Security entries then exist wherever the
// household config turns the module on. web/src/modules.ts is the same list for the UI.
import type { Household, ModuleId, Person } from "../../../packages/core/src/household.ts";
import type { Env } from "./env.ts";
import type { SecurityPart } from "./security.ts";
import { financeModule } from "../../../modules/finance/src/shell.ts";
import { healthModule } from "../../../modules/health/src/shell.ts";
import { alfredModule } from "../../alfred/shell.ts";

/** Where a page shows up: the Home menu, the Metrics menu, or the Management list on Settings. */
export type Where = "home" | "metrics" | "manage";

export interface PageDef {
  /** A real path such as /home/calendar or /dashboard/finance. Never ends in /mcp: those belong to the gateway. */
  path: string;
  label: string;
  /** An icon name from web/src/icons.ts. */
  icon: string;
  where: Where;
  /** One line for the Management list. */
  text?: string;
  /** Default: home pages are for everyone, metrics and manage pages for admins. Set to override. */
  admin?: boolean;
}

export interface ApiCtx {
  req: Request;
  env: Env;
  url: URL;
  household: Household;
  /** The verified person. Never trust a name or email from the request body. */
  person: Person;
  /** True when the request may change something: same origin and our header (see index.ts sameOriginWrite). */
  write: boolean;
}

export interface ShellModule {
  id: ModuleId;
  pages?: PageDef[];
  /** API routes by first path segment: { calendar: handler } serves /api/calendar and /api/calendar/*. */
  api?: Record<string, (c: ApiCtx) => Promise<Response>>;
  /** Runs on the Worker's daily cron while the module is on. A failure is logged by name and stops nothing else. */
  scheduled?: (env: Env, h: Household) => Promise<void>;
  /** What the Security page shows for this module (security.ts). */
  security?: (h: Household) => SecurityPart;
}

/** Modules built into this Worker. A module that is on in the config but missing here is simply not there yet. */
export const MODULES: ShellModule[] = [financeModule, healthModule, alfredModule];

export const builtModules = (h: Household, modules: ShellModule[] = MODULES): ShellModule[] =>
  modules.filter((m) => h.modules[m.id]);
