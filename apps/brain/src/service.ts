// What the Brain Worker does for its two callers, as plain functions (index.ts wraps them in the entrypoints;
// tests call them here on a stand-in for D1).
//   brainService  the gateway's /brain/mcp: 16 tools, each held to the caller's scopes
//   brainUi       the dashboard's Brain page, for the signed-in person
// Whose sensitive notes: a person (the dashboard, or an AI app they connected) reaches the sealed notes under their
// own root and the shared root. A gateway key belongs to the household's own programs and reaches every root.
import { type Household, householdFromVar, personByEmail, personById, type Person } from "../../../packages/core/src/household.ts";
import { localDate } from "../../../packages/core/src/ids.ts";
import { SealError, sealer } from "../../../packages/core/src/seal.ts";
import { ALL_SCOPES, type BrainCtx, type Principal, type Scope, Refused, audit, can } from "./core.ts";
import { BRAIN_CONTRACT, BRAIN_TOOLS, BRAIN_UI_CONTRACT, type BrainApi, type BrainPrincipal, type BrainResult, type BrainTool, type BrainUiApi } from "./contract.ts";
import { Brain } from "./store.ts";
import { TOOLS, targetOf } from "./tools.ts";
import { handleUi } from "./ui.ts";

export interface BrainEnv {
  DB: D1Database;
  HOUSEHOLD: string;
  /** Secret: seals the sensitive notes. Unset = those notes are locked; everything else works. */
  BRAIN_SENSITIVE_ENCRYPTION_KEY?: string;
  /** Var: the name of the root everyone shares. Default "Family". */
  BRAIN_SHARED_ROOT?: string;
}

export const BRAIN_SECRET = "BRAIN_SENSITIVE_ENCRYPTION_KEY";
/** Part of the key: never change it. */
export const BRAIN_SEAL_LABEL = "brain";

const clean = (name: string) => name.replace(/\//g, "-").trim();
export const sharedRoot = (env: Pick<BrainEnv, "BRAIN_SHARED_ROOT">) => clean(env.BRAIN_SHARED_ROOT || "") || "Family";
export const rootOf = (p: Person) => clean(p.name);

/** The top of the tree: one root per person (their first name), then the shared one. */
export function brainRoots(h: Household, shared = "Family"): string[] {
  const out: string[] = [];
  for (const r of [...h.people.map(rootOf), shared]) if (!out.some((x) => x.toLowerCase() === r.toLowerCase())) out.push(r);
  return out;
}

function ctxFor(env: BrainEnv, h: Household, p: Principal): BrainCtx {
  return { db: env.DB, seal: sealer(env.BRAIN_SENSITIVE_ENCRYPTION_KEY, BRAIN_SEAL_LABEL, BRAIN_SECRET), p, roots: brainRoots(h, sharedRoot(env)), today: () => localDate(h.timezone) };
}

const actorId = (id: string) => id.toLowerCase().replace(/[^a-z0-9:._-]/g, "-").slice(0, 80);

/** Take the gateway's principal only in the agreed shape; anything else is refused before any work. */
function gatewayPrincipal(env: BrainEnv, h: Household, p: BrainPrincipal): Principal {
  if (!p || typeof p.id !== "string" || !p.id.trim()) throw new Refused("Not allowed: no caller.");
  if (p.via !== "key" && p.via !== "oauth") throw new Refused("Not allowed: unknown connection type.");
  if (!Array.isArray(p.scopes)) throw new Refused("Not allowed: no scopes.");
  const scopes = p.scopes.filter((s): s is Scope => (ALL_SCOPES as string[]).includes(s));
  if (p.via === "key") return { actor: actorId(p.id), via: "key", scopes, sensitiveRoots: null };
  const person = typeof p.user === "string" ? personByEmail(h, p.user) : null;
  if (!person) throw new Refused("The Brain is not open to this person.");
  return { actor: `${actorId(p.id)} (${person.id})`, via: "oauth", scopes, sensitiveRoots: [rootOf(person), sharedRoot(env)] };
}

/** Our own refusals and a locked sealer keep their words; anything else is not quoted. */
const shown = (e: unknown) => e instanceof Refused || e instanceof SealError;
function fail(e: unknown): BrainResult<never> {
  if (shown(e)) return { ok: false, refused: true, error: (e as Error).message };
  console.error("brain", (e as Error)?.name);
  return { ok: false, refused: false, error: "The Brain could not do that. Try again in a moment." };
}

export function brainService(env: BrainEnv, waitUntil?: (p: Promise<unknown>) => void): BrainApi {
  const household = () => {
    const h = householdFromVar(env.HOUSEHOLD);
    if (!h.modules.brain) throw new Refused("The brain module is switched off.");
    return h;
  };
  return {
    version: () => BRAIN_CONTRACT,
    roots: async () => brainRoots(household(), sharedRoot(env)),
    async call(raw, tool, args) {
      let p: Principal;
      let h: Household;
      try { h = household(); p = gatewayPrincipal(env, h, raw); } catch (e) { return fail(e); }
      const target = targetOf(args);
      const log = (ok: boolean, detail?: string) => {
        const row = audit(env.DB, p, String(tool).slice(0, 40), target, ok, detail);
        if (waitUntil) waitUntil(row);
        return waitUntil ? undefined : row;
      };
      try {
        if (!(BRAIN_TOOLS as readonly string[]).includes(tool)) throw new Refused(`Unknown tool "${String(tool).slice(0, 40)}".`);
        const t = TOOLS[tool as BrainTool];
        // the same rule the gateway used when it listed the tools: no tool without all of its scopes
        const missing = t.scope.filter((s) => !can(p, s));
        if (missing.length) throw new Refused(`Not allowed: this connection lacks ${missing.join(", ")}.`);
        const value = await t.run(new Brain(ctxFor(env, h, p)), args ?? {});
        await log(true);
        return { ok: true, value };
      } catch (e) {
        const r = fail(e);
        await log(false, r.ok ? undefined : r.error);
        return r;
      }
    },
  };
}

export function brainUi(env: BrainEnv, waitUntil?: (p: Promise<unknown>) => void): BrainUiApi {
  const who = (personId: string) => {
    const h = householdFromVar(env.HOUSEHOLD);
    if (!h.modules.brain) throw new Refused("The brain module is switched off.");
    const person = personById(h, String(personId ?? ""));
    if (!person) throw new Refused("The Brain is not open to this person.");
    const p: Principal = { actor: `dashboard (${person.id})`, via: "dashboard", scopes: ALL_SCOPES, sensitiveRoots: [rootOf(person), sharedRoot(env)] };
    return { p, brain: new Brain(ctxFor(env, h, p)) };
  };
  return {
    version: () => BRAIN_UI_CONTRACT,
    async api(personId, req) {
      let w: ReturnType<typeof who>;
      try { w = who(personId); } catch (e) { return { status: 403, body: JSON.stringify({ error: (e as Error).message }) }; }
      return handleUi({ db: env.DB, brain: w.brain, p: w.p, safe: shown, waitUntil }, req);
    },
    async exportAll(personId) {
      try {
        return await who(personId).brain.exportAll();
      } catch (e) {
        throw new Error(shown(e) ? (e as Error).message : "The Brain could not be exported.");
      }
    },
  };
}
