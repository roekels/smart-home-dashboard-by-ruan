// The Finance entrypoint: the gateway's /finance/mcp reaches the finance records over a service binding
// (binding FINANCE -> <prefix>-shell, entrypoint Finance). All the rules are in service.ts; this file only exists
// because an entrypoint must extend WorkerEntrypoint, which plain Node (tests, the demo server) cannot import.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { FinanceApi, FinanceBalances, FinanceListQuery, FinancePrincipal } from "./contract.ts";
import { type FinanceServiceEnv, financeService } from "./service.ts";

export class Finance extends WorkerEntrypoint<FinanceServiceEnv> implements FinanceApi {
  private get s() { return financeService(this.env); }
  version() { return this.s.version(); }
  schema(p: FinancePrincipal) { return this.s.schema(p); }
  overview(p: FinancePrincipal, days?: number) { return this.s.overview(p, days); }
  history(p: FinancePrincipal) { return this.s.history(p); }
  list(p: FinancePrincipal, table: string, q: FinanceListQuery) { return this.s.list(p, table, q); }
  get(p: FinancePrincipal, table: string, id: string) { return this.s.get(p, table, id); }
  create(p: FinancePrincipal, table: string, fields: unknown) { return this.s.create(p, table, fields); }
  update(p: FinancePrincipal, table: string, id: string, fields: unknown) { return this.s.update(p, table, id, fields); }
  balances(p: FinancePrincipal, input: FinanceBalances) { return this.s.balances(p, input); }
  deadlineDone(p: FinancePrincipal, id: string) { return this.s.deadlineDone(p, id); }
  archive(p: FinancePrincipal, table: string, id: string, archived: boolean) { return this.s.archive(p, table, id, archived); }
}
