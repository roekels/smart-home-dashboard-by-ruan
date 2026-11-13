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
import { homeAssistant } from "../../../modules/home-assistant/worker.ts";
import { energy } from "../../../modules/energy/worker.ts";
import { kiosk } from "../../../modules/kiosk/worker.ts";
import { edgeAgents } from "../../../modules/edge-agents/worker.ts";
import { brainModule } from "../../brain/shell.ts";
import { calendarModule } from "../../calendar/shell.ts";
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

/** A request before any sign-in: for callers that are not people (a paired wall tablet, an edge agent). */
export interface MachineCtx { req: Request; env: Env; url: URL; household: Household; demo: boolean }

export interface ShellModule {
  id: ModuleId;
  pages?: PageDef[];
  /** API routes by first path segment: { calendar: handler } serves /api/calendar and /api/calendar/*. */
  api?: Record<string, (c: ApiCtx) => Promise<Response>>;
  /** What the Security page shows for this module (security.ts). */
  security?: (h: Household) => SecurityPart;
  /** Runs before the sign-in, for every request. Return a Response to answer it yourself (after proving the caller
   *  with your own key or signature), or null to let the request go on to the normal sign-in. Never trust a person here. */
  machine?: (c: MachineCtx) => Promise<Response | null>;
  /** Demo mode's answer for one of this module's /api routes, or null to fall through to demo.ts. Memory only. */
  demo?: (c: ApiCtx) => Promise<Response | null>;
  /** Runs on the shell Worker's cron triggers while the module is on. `now` is the tick's time. A failure is logged
   *  by the module's name and stops nothing else. */
  scheduled?: (env: Env, household: Household, now: Date) => Promise<void>;
  /** The trigger `scheduled` listens to, exactly as written in the module's setup file ("20 4 * * *"). The Worker
   *  has one trigger per distinct expression across all modules; without `cron` a module runs on every one of them. */
  cron?: string;
}

/** Modules built into this Worker. A module that is on in the config but missing here is simply not there yet. */
export const MODULES: ShellModule[] = [calendarModule, brainModule, financeModule, healthModule, homeAssistant, energy, kiosk, edgeAgents, alfredModule];

export const builtModules = (h: Household, modules: ShellModule[] = MODULES): ShellModule[] =>
  modules.filter((m) => h.modules[m.id]);
