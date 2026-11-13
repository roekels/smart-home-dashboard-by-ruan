// The Finance entrypoint of the shell Worker: what the gateway's /finance/mcp may call over its service binding
// (binding FINANCE -> <prefix>-shell, entrypoint Finance). Types only, plus the version string.
export const FINANCE_CONTRACT = "finance@1";

/** Who the gateway says is calling. `user` is the sign-in email of the person who approved an OAuth connection
 *  (they must be an admin); a gateway key (the household's own programs) has none. */
export interface FinancePrincipal { id: string; scopes: string[]; user?: string }
export interface FinanceListQuery { asset?: string; from?: string; to?: string; q?: string; archived?: boolean; limit?: number }
export interface FinanceBalances { as_of?: string; items: { subject_kind: string; subject_id: string; amount_cents: number; currency: string; note?: string }[] }
export type FinanceRow = Record<string, unknown>;

export interface FinanceApi {
  version(): string | Promise<string>;
  /** Every table's fields and allowed values, the owners, the currencies and the base currency. */
  schema(p: FinancePrincipal): Promise<Record<string, unknown>>;
  overview(p: FinancePrincipal, days?: number): Promise<Record<string, unknown>>;
  history(p: FinancePrincipal): Promise<Record<string, unknown>>;
  list(p: FinancePrincipal, table: string, q: FinanceListQuery): Promise<FinanceRow[]>;
  get(p: FinancePrincipal, table: string, id: string): Promise<FinanceRow | null>;
  create(p: FinancePrincipal, table: string, fields: unknown): Promise<{ id: string }>;
  update(p: FinancePrincipal, table: string, id: string, fields: unknown): Promise<{ ok: true }>;
  balances(p: FinancePrincipal, input: FinanceBalances): Promise<{ ids: string[] }>;
  deadlineDone(p: FinancePrincipal, id: string): Promise<{ ok: true; next: string | null }>;
  archive(p: FinancePrincipal, table: string, id: string, archived: boolean): Promise<{ ok: true }>;
}
