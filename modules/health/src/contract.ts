// The Health entrypoint of the shell Worker: what the gateway's /health/mcp may call over its service binding
// (binding HEALTH -> <prefix>-shell, entrypoint Health). Types only, plus the version string.
export const HEALTH_CONTRACT = "health@1";

/** Who the gateway says is calling. `user` is the sign-in email of the person who approved an OAuth connection;
 *  a gateway key (the household's own programs) has none and may see every person's records within its scopes. */
export interface HealthPrincipal { id: string; scopes: string[]; user?: string }
export type HealthType = "visit" | "test" | "vaccination" | "medication";
export interface HealthRecordOut {
  id: string; person: string; type: HealthType; date: string; data: Record<string, unknown>;
  created: number; created_by: string; updated: number; updated_by: string; archived: number | null;
}
export interface HealthListQuery { person?: string; type?: string; from?: string; to?: string; archived?: boolean }
export interface HealthAddInput { type: string; person: string; date: string; data: unknown }
export interface HealthUpdateInput { date?: string; person?: string; data?: unknown }
export interface HealthSeries {
  name: string; group?: string; unit?: string; low?: number; high?: number; ref?: string;
  points: { date: string; test: string; value: string; num: number | null; flag: "low" | "high" | null }[];
}

export interface HealthApi {
  version(): string | Promise<string>;
  /** The people this connection may see (id and first name) and every type's fields. */
  schema(p: HealthPrincipal): Promise<{ people: { id: string; name: string }[]; types: Record<string, Record<string, string>> }>;
  overview(p: HealthPrincipal, person?: string): Promise<Record<string, unknown>>;
  list(p: HealthPrincipal, q: HealthListQuery): Promise<HealthRecordOut[]>;
  /** `person`, when given, must be the record's person: a record of someone else is refused. */
  get(p: HealthPrincipal, id: string, person?: string): Promise<HealthRecordOut | null>;
  trends(p: HealthPrincipal, person: string, name?: string): Promise<HealthSeries[]>;
  add(p: HealthPrincipal, input: HealthAddInput): Promise<{ id: string }>;
  update(p: HealthPrincipal, id: string, input: HealthUpdateInput, person?: string): Promise<HealthRecordOut>;
  archive(p: HealthPrincipal, id: string, archived: boolean, person?: string): Promise<{ id: string; archived: boolean }>;
}
