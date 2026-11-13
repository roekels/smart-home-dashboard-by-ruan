// What a health record holds. Four types, kept deliberately small so a record is quick to enter (by hand on the
// Health page, or by an AI app through /health/mcp). Unknown fields are refused; text is trimmed and capped.
//   vaccination  what it protects against, which vaccine, when, and when it is due again
//   visit        what, who, why, outcome, medication prescribed, follow-up, when healthy again
//   test         one lab report (blood, urine, allergy …) with its results, each with unit and reference range
//   medication   one medicine a person takes or took: what for, dose, how often, how it works for them, since (the
//                record date) and until; `visit` ties it to the doctor visit that prescribed it
// No Worker-only globals here, so node:test and the demo can import it.
import { isDate } from "../../../packages/core/src/ids.ts";

export { isDate };
export type RecordType = "visit" | "test" | "vaccination" | "medication";
export const TYPES: RecordType[] = ["visit", "test", "vaccination", "medication"];
/** A visit record's id, for a medication's `visit`. */
export const VISIT_ID = /^hv_[A-Za-z0-9_-]{4,40}$/;
export const TEST_KINDS = ["blood", "urine", "allergy", "stool", "imaging", "other"] as const;

export class FieldError extends Error {}

export type Field =
  | { t: "text"; max: number; required?: boolean; what: string }
  | { t: "date"; required?: boolean; what: string }
  | { t: "enum"; of: readonly string[]; required?: boolean; what: string }
  | { t: "meds"; required?: boolean; what: string }
  | { t: "results"; required?: boolean; what: string }
  | { t: "visit"; required?: boolean; what: string };

export const FIELDS: Record<RecordType, Record<string, Field>> = {
  vaccination: {
    for: { t: "text", max: 120, required: true, what: "What it protects against, e.g. Tetanus, Hepatitis A+B, Flu" },
    vaccine: { t: "text", max: 120, what: "Product or vaccine given" },
    dose: { t: "text", max: 40, what: "Which dose, e.g. 1/3, booster" },
    due: { t: "date", what: "When it needs a refresh (YYYY-MM-DD)" },
    given_by: { t: "text", max: 120, what: "Doctor, clinic or country" },
    notes: { t: "text", max: 2000, what: "Anything else" },
    source: { t: "text", max: 300, what: "Where the proof is kept, e.g. a folder or file name" },
  },
  visit: {
    what: { t: "text", max: 120, required: true, what: "Kind of visit or specialty, e.g. GP, dentist, hospital" },
    who: { t: "text", max: 160, what: "Doctor or clinic" },
    why: { t: "text", max: 1000, what: "Reason, symptoms" },
    outcome: { t: "text", max: 2000, what: "Diagnosis or result" },
    meds: { t: "meds", what: "Medication prescribed: [{ name, dose?, until? }]" },
    follow_up: { t: "text", max: 500, what: "Follow-up planned (a date YYYY-MM-DD or words)" },
    healthy_on: { t: "date", what: "When it was over / healthy again (YYYY-MM-DD)" },
    cost: { t: "text", max: 120, what: "Cost and refund, in words" },
    notes: { t: "text", max: 2000, what: "Anything else" },
    source: { t: "text", max: 300, what: "Where the report is kept, e.g. a folder or file name" },
  },
  test: {
    kind: { t: "enum", of: TEST_KINDS, required: true, what: `Kind of test: ${TEST_KINDS.join(", ")}` },
    title: { t: "text", max: 160, what: "e.g. Blood count, Allergy panel" },
    lab: { t: "text", max: 160, what: "Lab or doctor" },
    results: { t: "results", what: "[{ name, value, unit?, low?, high?, ref?, group?, note? }]" },
    notes: { t: "text", max: 4000, what: "Summary or doctor's comment" },
    source: { t: "text", max: 300, what: "Where the report is kept, e.g. a folder or file name" },
  },
  medication: {
    name: { t: "text", max: 120, required: true, what: "Medicine, e.g. Ibuprofen 400" },
    for: { t: "text", max: 200, what: "What it is for" },
    dose: { t: "text", max: 120, what: "Dose, e.g. 1 tablet" },
    schedule: { t: "text", max: 120, what: "How often, e.g. daily, as needed, 3x a day for 7 days" },
    until: { t: "date", what: "Stopped on (YYYY-MM-DD); empty while still taking it. The record date is when it started" },
    effects: { t: "text", max: 2000, what: "How it works for them: effects, side effects, what helped" },
    prescribed_by: { t: "text", max: 160, what: "Doctor or clinic, or 'self' for over the counter" },
    visit: { t: "visit", what: "The doctor visit it was prescribed at (a visit record id, hv_…)" },
    notes: { t: "text", max: 2000, what: "Anything else" },
    source: { t: "text", max: 300, what: "Where the prescription or leaflet is kept" },
  },
};

export interface Med { name: string; dose?: string; until?: string }
export interface Result {
  name: string;
  /** As written on the report: "5.3", "<0.5", "negative". */
  value: string;
  unit?: string;
  low?: number;
  high?: number;
  /** A range that isn't two numbers, e.g. "negative" or "<200". */
  ref?: string;
  group?: string;
  note?: string;
}

function text(v: unknown, max: number, name: string): string {
  if (typeof v !== "string" && typeof v !== "number") throw new FieldError(`${name} must be text`);
  const s = String(v).trim();
  if (s.length > max) throw new FieldError(`${name} is longer than ${max}`);
  return s;
}

function num(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  if (!Number.isFinite(n)) throw new FieldError(`${name} must be a number`);
  return n;
}

function meds(v: unknown): Med[] {
  if (!Array.isArray(v) || v.length > 30) throw new FieldError("meds must be a list (at most 30)");
  return v.map((m, i) => {
    if (typeof m === "string") return { name: text(m, 160, `meds[${i}]`) };
    if (!m || typeof m !== "object") throw new FieldError(`meds[${i}] must be { name, dose?, until? }`);
    const o = m as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!["name", "dose", "until"].includes(k)) throw new FieldError(`meds[${i}].${k} is not a field`);
    const out: Med = { name: text(o.name ?? "", 160, `meds[${i}].name`) };
    if (!out.name) throw new FieldError(`meds[${i}].name is required`);
    if (o.dose != null && o.dose !== "") out.dose = text(o.dose, 160, `meds[${i}].dose`);
    if (o.until != null && o.until !== "") out.until = text(o.until, 40, `meds[${i}].until`);
    return out;
  });
}

const RESULT_KEYS = ["name", "value", "unit", "low", "high", "ref", "group", "note"];
function results(v: unknown): Result[] {
  if (!Array.isArray(v) || v.length > 300) throw new FieldError("results must be a list (at most 300)");
  return v.map((r, i) => {
    if (!r || typeof r !== "object") throw new FieldError(`results[${i}] must be { name, value, … }`);
    const o = r as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!RESULT_KEYS.includes(k)) throw new FieldError(`results[${i}].${k} is not a field`);
    const out: Result = { name: text(o.name ?? "", 120, `results[${i}].name`), value: text(o.value ?? "", 60, `results[${i}].value`) };
    if (!out.name || !out.value) throw new FieldError(`results[${i}] needs a name and a value`);
    for (const k of ["unit", "ref", "group"] as const) if (o[k] != null && o[k] !== "") out[k] = text(o[k], 80, `results[${i}].${k}`);
    if (o.note != null && o.note !== "") out.note = text(o.note, 500, `results[${i}].note`);
    for (const k of ["low", "high"] as const) {
      const n = num(o[k], `results[${i}].${k}`);
      if (n !== undefined) out[k] = n;
    }
    return out;
  });
}

/** The fields of one record, checked. `partial`: an update, where only the fields sent change and null clears one. */
export function clean(type: RecordType, body: unknown, partial = false): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FieldError("data must be an object");
  const fields = FIELDS[type];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    const f = fields[k];
    if (!f) throw new FieldError(`${k} is not a field of a ${type} (fields: ${Object.keys(fields).join(", ")})`);
    if (v === null || v === "") {
      if (f.required) throw new FieldError(`${k} is required`);
      if (partial) out[k] = null;
      continue;
    }
    if (f.t === "text") out[k] = text(v, f.max, k);
    else if (f.t === "date") {
      if (!isDate(v)) throw new FieldError(`${k} must be a date YYYY-MM-DD`);
      out[k] = v;
    } else if (f.t === "enum") {
      if (!f.of.includes(String(v))) throw new FieldError(`${k} must be one of ${f.of.join(", ")}`);
      out[k] = String(v);
    } else if (f.t === "visit") {
      if (typeof v !== "string" || !VISIT_ID.test(v.trim())) throw new FieldError(`${k} must be a visit record id (hv_…)`);
      out[k] = v.trim();
    } else if (f.t === "meds") out[k] = meds(v);
    else out[k] = results(v);
  }
  if (!partial) for (const [k, f] of Object.entries(fields)) if (f.required && out[k] == null) throw new FieldError(`${k} is required`);
  return out;
}

/** A result's number, if it has one: "5.3" -> 5.3, "<0.5" -> 0.5 (its sign stays in the value), "negative" -> null. */
export function numeric(value: string): number | null {
  const m = /^\s*[<>≤≥]?=?\s*(-?\d+(?:[.,]\d+)?)\s*$/.exec(value);
  return m ? Number(m[1].replace(",", ".")) : null;
}

/** "low" / "high" against the numeric range; null when inside it or there is nothing to compare. */
export function flag(r: Result): "low" | "high" | null {
  const n = numeric(r.value);
  if (n === null) return null;
  const qual = r.value.trim()[0];
  if (r.low !== undefined && n < r.low && qual !== ">") return "low";
  if (r.high !== undefined && n > r.high && qual !== "<") return "high";
  return null;
}

/** The same analyte across reports, whatever the spelling: "Ferritin" and "ferritin " match. */
export const analyteKey = (name: string): string => name.toLowerCase().replace(/\s+/g, " ").trim();

/** For the MCP and the page's forms: every type's fields with a line on each. */
export function describe(): Record<string, Record<string, string>> {
  return Object.fromEntries(TYPES.map((t) => [t,
    Object.fromEntries(Object.entries(FIELDS[t]).map(([k, f]) => [k, `${f.what}${f.required ? " (required)" : ""}`]))]));
}
