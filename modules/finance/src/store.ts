// Where finance rows live. Two stores with one face:
//   sealedStore   D1 <prefix>-finance. Every row's fields are sealed as one value; the database can read only
//                 the table, the row's date, when it changed and whether it is archived.
//   memoryStore   plain objects, for demo mode and tests. Nothing is kept.
// Filtering beyond table, date range and archived happens after decrypting, in api.ts. A household's finance
// records are a few thousand rows at most, so reading a whole table is fine.
import type { Sealer } from "../../../packages/core/src/seal.ts";
import type { Rate } from "./money.ts";
import type { TableName } from "./schema.ts";

export const FINANCE_SECRET = "FINANCE_DATA_ENCRYPTION_KEY";
/** Part of the key derivation. Never change it: sealed rows could no longer be opened. */
export const FINANCE_SEAL_LABEL = "finance";

export interface Stored {
  id: string;
  tbl: TableName;
  /** The table's date field (schema.ts DAY_FIELD), copied out of the data. */
  day: string | null;
  data: Record<string, unknown>;
  created: number;
  updated: number;
  updated_by: string;
  archived: number | null;
}

export interface Range { from?: string; to?: string; archived?: boolean }

export interface FinanceStore {
  /** False while the encryption key is not set: reads and writes then fail with a clear message. */
  ready: boolean;
  rows(tbl: TableName, range?: Range): Promise<Stored[]>;
  row(id: string): Promise<Stored | null>;
  /** Insert or replace, all or nothing. */
  put(rows: Stored[]): Promise<void>;
  rates(): Promise<Rate[]>;
  /** `detail` may hold field names and counts, never a value. */
  audit(actor: string, action: string, target: string, detail?: unknown): Promise<void>;
  /** A row started using this currency (clear text: it is not private and the rate sync needs it). */
  currency?(code: string): Promise<void>;
}

interface Row extends Omit<Stored, "data"> { data: string }

export function sealedStore(db: D1Database, seal: Sealer, onCurrency?: (code: string) => Promise<void>): FinanceStore {
  const open = async (r: Row): Promise<Stored> => ({ ...r, data: await seal.unseal<Record<string, unknown>>(r.data) });
  return {
    ready: seal.ready,
    async rows(tbl, range = {}) {
      const where = ["tbl = ?"], args: unknown[] = [tbl];
      if (!range.archived) where.push("archived IS NULL");
      if (range.from) { where.push("day >= ?"); args.push(range.from); }
      if (range.to) { where.push("day <= ?"); args.push(range.to); }
      const r = await db.prepare(`SELECT * FROM rows WHERE ${where.join(" AND ")} ORDER BY created`).bind(...args).all<Row>();
      return Promise.all((r.results ?? []).map(open));
    },
    async row(id) {
      const r = await db.prepare("SELECT * FROM rows WHERE id = ?").bind(id).first<Row>();
      return r ? open(r) : null;
    },
    async put(rows) {
      const stmts = await Promise.all(rows.map(async (r) => db.prepare(
        "INSERT INTO rows (id, tbl, day, data, created, updated, updated_by, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        + "ON CONFLICT (id) DO UPDATE SET day = excluded.day, data = excluded.data, updated = excluded.updated, updated_by = excluded.updated_by, archived = excluded.archived",
      ).bind(r.id, r.tbl, r.day, await seal.seal(r.data), r.created, r.updated, r.updated_by, r.archived)));
      for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    },
    async rates() {
      return (await db.prepare("SELECT date, currency, per_eur FROM fx_rates").all<Rate>()).results ?? [];
    },
    async audit(actor, action, target, detail) {
      await db.prepare("INSERT INTO audit (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
        .bind(Date.now(), actor, action, target, detail === undefined ? null : JSON.stringify(detail)).run();
    },
    currency: onCurrency,
  };
}

export function memoryStore(seed: { rows?: Stored[]; rates?: Rate[] } = {}): FinanceStore & { audits: { actor: string; action: string; target: string; detail?: unknown }[] } {
  const rows = new Map((seed.rows ?? []).map((r) => [r.id, structuredClone(r)]));
  const audits: { actor: string; action: string; target: string; detail?: unknown }[] = [];
  return {
    ready: true, audits,
    async rows(tbl, range = {}) {
      return [...rows.values()].filter((r) => r.tbl === tbl && (range.archived || r.archived === null)
        && (!range.from || (r.day !== null && r.day >= range.from)) && (!range.to || (r.day !== null && r.day <= range.to)))
        .sort((a, b) => a.created - b.created).map((r) => structuredClone(r));
    },
    async row(id) { const r = rows.get(id); return r ? structuredClone(r) : null; },
    async put(list) { for (const r of list) rows.set(r.id, structuredClone(r)); },
    async rates() { return seed.rates ?? []; },
    async audit(actor, action, target, detail) { audits.push({ actor, action, target, detail }); },
  };
}
