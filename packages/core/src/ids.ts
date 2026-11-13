// Ids and dates the data modules share. No Worker-only globals.
import { b64urlEncode } from "./util.ts";

/** Time-sortable id with a prefix, e.g. newId("hv_"). */
export function newId(prefix: string): string {
  const rnd = crypto.getRandomValues(new Uint8Array(9));
  return `${prefix}${Date.now().toString(36)}${b64urlEncode(rnd)}`;
}

/** Today's date in a time zone, as YYYY-MM-DD. */
export function localDate(timezone: string, now = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day written YYYY-MM-DD. */
export function isDate(s: unknown): s is string {
  if (typeof s !== "string" || !DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
