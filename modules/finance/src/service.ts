// What /finance/mcp may do, as plain functions (entry.ts wraps them in the Worker entrypoint; tests call them here).
// The gateway verified the OAuth token or key and cut the scopes to finance.*; they are checked again here.
// An OAuth connection acts for the person who approved it, who must be an admin, the same rule as the page.
// A gateway key has no person: it belongs to the household's own programs and is held to its scopes.
import { type Household, householdFromVar, personByEmail } from "../../../packages/core/src/household.ts";
import { SealError } from "../../../packages/core/src/seal.ts";
import { HttpError } from "../../../packages/core/src/util.ts";
import { type FinanceCtx, type FinanceEnv, ID, archive, create, deadlineDone, financeCtx, get, history, isTable, list, overview, schema, update, valuationBatch } from "./api.ts";
import { FINANCE_CONTRACT, type FinanceApi, type FinancePrincipal } from "./contract.ts";
import { FieldError, TABLES, type TableName } from "./schema.ts";

export interface FinanceServiceEnv extends FinanceEnv { HOUSEHOLD: string }
type Scope = "finance.read" | "finance.write" | "finance.archive";

function gate(env: FinanceServiceEnv, h: Household, p: FinancePrincipal, scope: Scope, fetcher?: typeof fetch): FinanceCtx {
  if (!h.modules.finance) throw new Error("The finance module is switched off.");
  if (!p || typeof p.id !== "string" || !p.id.trim() || !Array.isArray(p.scopes)) throw new Error("Not allowed: no caller.");
  if (!p.scopes.includes(scope)) throw new Error(`This connection lacks ${scope}.`);
  const id = p.id.toLowerCase().replace(/[^a-z0-9:._-]/g, "-").slice(0, 80);
  let actor = id;
  if (p.user !== undefined) {
    const person = personByEmail(h, p.user);
    if (!person?.admin) throw new Error("Finance is open to admins only.");
    actor = `${id} (${person.id})`;
  }
  try {
    return financeCtx(env, h, actor, fetcher);
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

function table(name: string, id?: string): TableName {
  if (!isTable(name)) throw new FieldError(`no such table "${name}"`);
  if (id !== undefined && (!ID.test(id) || !id.startsWith(TABLES[name].prefix))) throw new FieldError("no such row");
  return name;
}

/** `fetcher` is for tests: the exchange-rate sync must not reach the network there. */
export function financeService(env: FinanceServiceEnv, fetcher?: typeof fetch): FinanceApi {
  const ctx = (p: FinancePrincipal, scope: Scope) => gate(env, householdFromVar(env.HOUSEHOLD), p, scope, fetcher);
  return {
    version: () => FINANCE_CONTRACT,
    schema: (p) => run(async () => schema(ctx(p, "finance.read"))),
    overview: (p, days) => run(async () => overview(ctx(p, "finance.read"), days)),
    history: (p) => run(async () => history(ctx(p, "finance.read"))),
    list: (p, t, q) => run(async () => list(ctx(p, "finance.read"), table(t), q ?? {})),
    get: (p, t, id) => run(async () => get(ctx(p, "finance.read"), table(t, id), id)),
    create: (p, t, fields) => run(async () => create(ctx(p, "finance.write"), table(t), fields)),
    update: (p, t, id, fields) => run(async () => update(ctx(p, "finance.write"), table(t, id), id, fields)),
    balances: (p, input) => run(async () => valuationBatch(ctx(p, "finance.write"), input)),
    deadlineDone: (p, id) => run(async () => deadlineDone(ctx(p, "finance.write"), id)),
    archive: (p, t, id, archived) => run(async () => archive(ctx(p, "finance.archive"), table(t, id), id, archived)),
  };
}
