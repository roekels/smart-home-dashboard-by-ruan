// The finance tables the page may write, and how each field is checked. One list drives create, update, list and
// the page's forms. Rows are stored sealed as one JSON value each (store.ts), so a new field is one line here and
// needs no migration. No Worker-only globals here, so node:test can import it.

import { isDate } from "../../../packages/core/src/ids.ts";

export type TableName =
  | "institutions" | "assets" | "accounts" | "holdings" | "valuations" | "documents"
  | "contracts" | "transactions" | "deadlines" | "asset_events" | "tax_years";
export interface Table { prefix: string; dated: boolean; fields: Record<string, Field> }

/** Show a field in the page's form only while another field has one of these values (the API still accepts it). */
export interface When { field: string; is: readonly string[] }
export type Field = FieldBase & { when?: When };
type FieldBase =
  | { t: "text"; max?: number; req?: true }
  | { t: "date"; req?: true }
  | { t: "int"; req?: true; min?: number; max?: number }
  | { t: "real"; req?: true; min?: number; max?: number }
  | { t: "enum"; of: readonly string[]; req?: true }
  | { t: "owner"; req?: true }
  | { t: "currency"; req?: true }
  | { t: "ref"; to: TableName; req?: true }
  | { t: "bool" }
  | { t: "json" };

/** The currencies the European Central Bank publishes a daily reference rate for (fx.ts), plus the euro. */
export const CURRENCIES = [
  "EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "ISK",
  "TRY", "ILS", "ZAR", "INR", "CNY", "HKD", "SGD", "KRW", "THB", "MYR", "PHP", "IDR", "MXN", "BRL",
] as const;

/** Spending categories: a fixed list so the overview adds up the same way every month. */
export const CATEGORIES = [
  "income.salary", "income.rent", "income.interest", "income.refund", "income.other",
  "housing.rent", "housing.operating", "housing.energy", "housing.loan", "housing.reserve", "housing.repair", "housing.furnishing",
  "car.lease", "car.insurance", "car.charging", "car.service", "car.tyres", "car.toll", "car.other",
  "insurance", "tax", "subscriptions", "food", "household", "health", "education", "gifts", "donations",
  "travel", "travel.work", "leisure", "transport", "fees", "savings", "investment", "transfer", "other",
] as const;
const T = (max = 200, req = false): Field => (req ? { t: "text", max, req: true } : { t: "text", max });
const NOTE = T(2000);
const TYRES: When = { field: "kind", is: ["tyres"] };

export const TABLES: Record<TableName, Table> = {
  institutions: {
    prefix: "in_", dated: false,
    fields: {
      name: T(120, true),
      kind: { t: "enum", req: true, of: ["bank", "broker", "insurer", "lessor", "landlord", "property_manager", "utility", "employer", "authority", "garage", "shop", "other"] },
      country: T(2), note: NOTE,
    },
  },
  assets: {
    prefix: "as_", dated: false,
    fields: {
      name: T(120, true),
      kind: { t: "enum", req: true, of: ["property", "vehicle", "item"] },
      role: { t: "enum", req: true, of: ["owned_let", "owned_home", "rented_home", "owned", "leased"] },
      owner: { t: "owner", req: true },
      institution_id: { t: "ref", to: "institutions" },
      acquired: { t: "date" }, price_cents: { t: "int" }, currency: { t: "currency" },
      details: { t: "json" }, note: NOTE,
    },
  },
  accounts: {
    prefix: "ac_", dated: false,
    fields: {
      name: T(120, true),
      kind: { t: "enum", req: true, of: ["current", "savings", "high_yield", "deposit", "credit_card", "loan", "brokerage", "crypto", "pension", "commodity", "cash", "other"] },
      institution_id: { t: "ref", to: "institutions" },
      owner: { t: "owner", req: true }, currency: { t: "currency" },
      last4: T(4), asset_id: { t: "ref", to: "assets" },
      opened: { t: "date" }, closed: { t: "date" }, details: { t: "json" }, note: NOTE,
    },
  },
  holdings: {
    prefix: "ho_", dated: false,
    fields: {
      account_id: { t: "ref", to: "accounts", req: true }, name: T(120, true),
      kind: { t: "enum", req: true, of: ["stock", "etf", "fund", "bond", "crypto", "metal", "other"] },
      symbol: T(20), owner: { t: "owner", req: true }, quantity: { t: "real" }, invested_cents: { t: "int" },
      currency: { t: "currency" }, note: NOTE,
    },
  },
  valuations: {
    prefix: "va_", dated: true,
    fields: {
      subject_kind: { t: "enum", req: true, of: ["account", "holding", "asset"] },
      subject_id: T(40, true),
      as_of: { t: "date", req: true }, amount_cents: { t: "int", req: true }, currency: { t: "currency", req: true },
      source: { t: "enum", req: true, of: ["manual", "statement", "import", "estimate"] }, note: NOTE,
    },
  },
  documents: {
    prefix: "do_", dated: true,
    fields: {
      title: T(200, true),
      kind: { t: "enum", req: true, of: ["receipt", "invoice", "contract", "statement", "tax", "policy", "ticket", "plan", "photo", "other"] },
      date: { t: "date" }, amount_cents: { t: "int" }, currency: { t: "currency" }, merchant: T(120),
      asset_id: { t: "ref", to: "assets" }, trip: T(120), stored_at: T(500), note: NOTE,
    },
  },
  contracts: {
    prefix: "co_", dated: false,
    fields: {
      name: T(120, true),
      kind: { t: "enum", req: true, of: ["insurance", "lease", "rental", "loan", "utility", "subscription", "service", "employment", "membership", "other"] },
      institution_id: { t: "ref", to: "institutions" }, asset_id: { t: "ref", to: "assets" }, account_id: { t: "ref", to: "accounts" },
      owner: { t: "owner", req: true }, reference: T(60),
      starts: { t: "date" }, ends: { t: "date" }, notice_days: { t: "int", min: 0, max: 3660 },
      renews: { t: "enum", of: ["auto", "manual", "none"] },
      amount_cents: { t: "int" }, currency: { t: "currency" }, every: { t: "enum", of: ["month", "quarter", "year", "once"] },
      details: { t: "json" }, document_id: { t: "ref", to: "documents" }, note: NOTE,
    },
  },
  transactions: {
    prefix: "tx_", dated: true,
    fields: {
      date: { t: "date", req: true }, amount_cents: { t: "int", req: true }, currency: { t: "currency", req: true },
      category: { t: "enum", req: true, of: CATEGORIES },
      account_id: { t: "ref", to: "accounts" }, asset_id: { t: "ref", to: "assets" }, contract_id: { t: "ref", to: "contracts" },
      owner: { t: "owner", req: true }, counterparty: T(120), description: T(300),
      reimbursable: { t: "bool" }, reimbursed: { t: "date" }, document_id: { t: "ref", to: "documents" },
      source: { t: "enum", of: ["manual", "statement", "import"] }, import_ref: T(120),
    },
  },
  deadlines: {
    prefix: "dl_", dated: false,
    fields: {
      title: T(160, true), due: { t: "date", req: true },
      kind: { t: "enum", req: true, of: ["tax", "inspection", "service", "renewal", "notice", "payment", "indexation", "legal", "other"] },
      asset_id: { t: "ref", to: "assets" }, contract_id: { t: "ref", to: "contracts" },
      amount_cents: { t: "int" }, currency: { t: "currency" },
      repeat: { t: "enum", of: ["none", "month", "quarter", "year", "2year"] }, note: NOTE,
    },
  },
  asset_events: {
    prefix: "ev_", dated: true,
    fields: {
      asset_id: { t: "ref", to: "assets", req: true }, date: { t: "date", req: true },
      kind: { t: "enum", req: true, of: ["service", "repair", "damage", "inspection", "tenant", "meter", "purchase", "renovation", "claim", "tyres", "note"] },
      title: T(160, true), odometer_km: { t: "int", min: 0, max: 2_000_000 },
      // tyre log (kind tyres): the set now fitted and tread depth in mm
      tyre_set: { t: "enum", of: ["summer", "winter", "all_season"], when: TYRES },
      tread_mm: { t: "real", min: 0, max: 30, when: TYRES },
      tread_fl: { t: "real", min: 0, max: 30, when: TYRES }, tread_fr: { t: "real", min: 0, max: 30, when: TYRES },
      tread_rl: { t: "real", min: 0, max: 30, when: TYRES }, tread_rr: { t: "real", min: 0, max: 30, when: TYRES },
      transaction_id: { t: "ref", to: "transactions" }, document_id: { t: "ref", to: "documents" }, note: NOTE,
    },
  },
  tax_years: {
    prefix: "tax_", dated: false,
    fields: {
      year: { t: "int", req: true, min: 2000, max: 2100 }, person: { t: "owner", req: true },
      kind: { t: "enum", req: true, of: ["income_tax", "property_tax", "capital_gains", "vat", "other"] },
      status: { t: "enum", of: ["open", "prepared", "filed", "assessed"] },
      due: { t: "date" }, filed: { t: "date" }, result_cents: { t: "int" }, document_id: { t: "ref", to: "documents" }, note: NOTE,
    },
  },
};
export const TABLE_NAMES = Object.keys(TABLES) as TableName[];


/** The field of a table that is its date: the store keeps it readable so a date range needs no decrypting. */
export const DAY_FIELD: Partial<Record<TableName, string>> = { transactions: "date", valuations: "as_of", documents: "date", asset_events: "date", deadlines: "due" };

export class FieldError extends Error {}

/**
 * Checks one write against the table's fields. `partial` (an update) allows required fields to be left out;
 * an unknown key is refused so a typo never silently drops data. null clears an optional field.
 */
export function clean(table: TableName, body: unknown, owners: readonly string[], partial = false): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FieldError("body must be an object");
  const fields = TABLES[table].fields as Record<string, Field>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(body)) if (!(k in fields)) throw new FieldError(`unknown field "${k}" for ${table}`);
  for (const [k, f] of Object.entries(fields)) {
    const v = (body as Record<string, unknown>)[k];
    const req = "req" in f && f.req;
    if (v === undefined || v === null || v === "") {
      if (req && (!partial || v !== undefined)) throw new FieldError(`${k} is required`);
      if (v !== undefined) out[k] = null;
      continue;
    }
    out[k] = value(k, f, v, owners);
  }
  return out;
}

function value(k: string, f: Field, v: unknown, owners: readonly string[]): unknown {
  switch (f.t) {
    case "text": {
      const s = String(v).trim();
      if (s.length > (f.max ?? 200)) throw new FieldError(`${k} is longer than ${f.max ?? 200} characters`);
      return s;
    }
    case "date":
      if (!isDate(v)) throw new FieldError(`${k} must be a date, YYYY-MM-DD`);
      return v;
    case "int": {
      if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new FieldError(`${k} must be a whole number (cents for money)`);
      if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) throw new FieldError(`${k} is out of range`);
      return v;
    }
    case "real":
      if (typeof v !== "number" || !Number.isFinite(v)) throw new FieldError(`${k} must be a number`);
      if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) throw new FieldError(`${k} is out of range`);
      return v;
    case "enum":
      if (!f.of.includes(String(v))) throw new FieldError(`${k} must be one of ${f.of.join(", ")}`);
      return String(v);
    case "owner":
      if (!owners.includes(String(v))) throw new FieldError(`${k} must be one of ${owners.join(", ")}`);
      return String(v);
    case "currency":
      if (!(CURRENCIES as readonly string[]).includes(String(v))) throw new FieldError(`${k} must be one of ${CURRENCIES.join(", ")}`);
      return String(v);
    case "ref": {
      const s = String(v);
      if (!s.startsWith(TABLES[f.to].prefix) || !/^[a-z]+_[A-Za-z0-9_-]{4,40}$/.test(s)) throw new FieldError(`${k} must be an id from ${f.to}`);
      return s;
    }
    case "bool":
      if (typeof v !== "boolean") throw new FieldError(`${k} must be true or false`);
      return v;
    case "json": {
      if (typeof v !== "object" || Array.isArray(v)) throw new FieldError(`${k} must be an object`);
      if (JSON.stringify(v).length > 64_000) throw new FieldError(`${k} is too large`);
      return v;
    }
  }
}

/** Who can own things: every person in the household (by id) plus "joint". */
export const ownersOf = (people: readonly { id: string }[]): string[] => [...people.map((p) => p.id), "joint"];
