// What /health/mcp may do, as plain functions (entry.ts wraps them in the Worker entrypoint; tests call them here).
// The gateway verified the OAuth token or key and cut the scopes to health.*; they are checked again here.
// An OAuth connection acts for the person who approved it: their own records, an admin everyone's. A gateway key
// has no person and reaches every record within its scopes (it belongs to the household's own programs).
import { type Household, householdFromVar, personByEmail } from "../../../packages/core/src/household.ts";
import { HttpError } from "../../../packages/core/src/util.ts";
import { SealError } from "../../../packages/core/src/seal.ts";
import { type HealthEnv, healthCtx, visibleTo } from "./api.ts";
import { HEALTH_CONTRACT, type HealthAddInput, type HealthApi, type HealthListQuery, type HealthPrincipal, type HealthUpdateInput } from "./contract.ts";
import { FieldError, describe } from "./schema.ts";
import { type HealthCtx, add, archive, get, list, overview, trends, update } from "./store.ts";

export interface HealthServiceEnv extends HealthEnv { HOUSEHOLD: string }

function gate(env: HealthServiceEnv, h: Household, p: HealthPrincipal, scope: "health.read" | "health.write"): HealthCtx {
  if (!h.modules.health) throw new Error("The health module is switched off.");
  if (!p || typeof p.id !== "string" || !p.id.trim() || !Array.isArray(p.scopes)) throw new Error("Not allowed: no caller.");
  if (!p.scopes.includes(scope)) throw new Error(`This connection lacks ${scope}.`);
  const id = p.id.toLowerCase().replace(/[^a-z0-9:._-]/g, "-").slice(0, 80);
  let visible = h.people.map((x) => x.id), actor = id;
  if (p.user !== undefined) {
    const person = personByEmail(h, p.user);
    if (!person) throw new Error("Health records are not open to this person.");
    visible = visibleTo(h, person);
    actor = `${id} (${person.id})`;
  }
  try {
    return healthCtx(env, h, actor, visible);
  } catch (e) {
    throw new Error((e as Error).message);
  }
}

/** Errors cross the binding as plain messages; they name fields, never values. */
async function run<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof FieldError || e instanceof HttpError || e instanceof SealError) throw new Error(e.message);
    throw e;
  }
}

/** A tool that names a person and an id: the record must be that person's. */
async function mustBe(c: HealthCtx, id: string, person: string | undefined): Promise<void> {
  if (person === undefined) return;
  const r = await get(c, id);
  if (r && r.person !== String(person).toLowerCase()) throw new FieldError(`record ${id} is not a record of ${person}`);
}

export function healthService(env: HealthServiceEnv): HealthApi {
  const h = () => householdFromVar(env.HOUSEHOLD);
  const ctx = (p: HealthPrincipal, scope: "health.read" | "health.write") => gate(env, h(), p, scope);
  return {
    version: () => HEALTH_CONTRACT,
    schema: (p) => run(async () => {
      const c = ctx(p, "health.read");
      return { people: h().people.filter((x) => c.visible.includes(x.id)).map((x) => ({ id: x.id, name: x.name })), types: describe() };
    }),
    overview: (p, person) => run(async () => overview(ctx(p, "health.read"), person)),
    list: (p, q: HealthListQuery) => run(async () => list(ctx(p, "health.read"), q ?? {})),
    get: (p, id, person) => run(async () => { const c = ctx(p, "health.read"); await mustBe(c, id, person); return get(c, id); }),
    trends: (p, person, name) => run(async () => trends(ctx(p, "health.read"), person, name)),
    add: (p, input: HealthAddInput) => run(async () => add(ctx(p, "health.write"), input)),
    update: (p, id, input: HealthUpdateInput, person) => run(async () => { const c = ctx(p, "health.write"); await mustBe(c, id, person); return update(c, id, input ?? {}); }),
    archive: (p, id, archived, person) => run(async () => { const c = ctx(p, "health.write"); await mustBe(c, id, person); return archive(c, id, archived); }),
  };
}
