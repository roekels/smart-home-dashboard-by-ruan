// Helpers for the service-binding entrypoints (entrypoints.ts). Kept apart from the classes so plain Node can
// import and test them: the classes need the Workers runtime ("cloudflare:workers").
import { personById, type Household } from "../../../packages/core/src/household.ts";
import { HttpError } from "../../../packages/core/src/util.ts";
import { HaError, HaInput } from "../../../modules/home-assistant/ha.ts";
import { ListError, type Viewer } from "../../../modules/home-assistant/lists.ts";

export interface Caller {
  /** For the audit: "key:<name>" or "oauth:<client name>". */
  id: string;
  scopes: string[];
  /** The person who approved an OAuth connection (their id in the household config). Absent for an API key. */
  person?: string;
}

const CALLER = /^[a-z0-9:._@ -]{1,80}$/i;

/** Validates the caller and checks one scope. Refusals are plain Errors: RPC carries the message, nothing else. */
export function allow(c: Caller | undefined, scope: string): string {
  if (!c || typeof c.id !== "string" || !CALLER.test(c.id) || !Array.isArray(c.scopes)) throw new Error("invalid caller");
  if (!c.scopes.includes(scope)) throw new Error(`this connection may not do that (scope ${scope})`);
  return `mcp:${c.id}`.slice(0, 80);
}

/** Known failures become a plain message; anything unexpected becomes "failed" (no internals over RPC). */
export async function plain<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof HttpError || e instanceof HaError || e instanceof HaInput || e instanceof ListError) throw new Error(e.message);
    if (e instanceof Error && e.constructor === Error) throw e;
    console.error("entrypoint failed");
    throw new Error("failed");
  }
}

export function need(h: Household, module: "homeAssistant" | "energy" | "edgeAgents"): void {
  if (!h.modules[module]) throw new Error("that module is switched off for this household");
}

export function viewerOf(h: Household, c: Caller): Viewer {
  const p = c.person ? personById(h, c.person) : null;
  return p ?? "shared-only";
}
