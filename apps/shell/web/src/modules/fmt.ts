// What the data pages (Finance, Health) share: money and dates in the household's language, and loading a
// module's own stylesheet when its page first opens.
import { loc, t } from "../i18n.ts";

/** Add a stylesheet from /styles once. A module page calls this from its view so index.html never changes. */
export function useStyles(name: string): void {
  const href = `/styles/${name}.css`;
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.append(link);
}

const fmt = new Map<string, Intl.NumberFormat>();
/** 123456 cents -> "€1,235" (whole) or "€1,234.56", in the given currency. */
export function money(cents: number | null | undefined, currency: string, whole = false): string {
  if (typeof cents !== "number") return "–";
  const k = `${loc()}${currency}${whole}`;
  if (!fmt.has(k)) fmt.set(k, new Intl.NumberFormat(loc(), { style: "currency", currency, maximumFractionDigits: whole ? 0 : 2, minimumFractionDigits: whole ? 0 : 2 }));
  return fmt.get(k)!.format(cents / 100);
}

/** "1.234,56", "1,234.56", "1234.5", "-20" -> cents. Null when it is not a number. */
export function parseMoney(s: string): number | null {
  let x = s.replace(/[^\d.,-]/g, "");
  if (!x) return null;
  const lastDot = x.lastIndexOf("."), lastComma = x.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? "." : ",";
    x = x.split(dec === "." ? "," : ".").join("").replace(dec, ".");
  } else if (lastComma >= 0) {
    x = /,\d{1,2}$/.test(x) && x.split(",").length === 2 ? x.replace(",", ".") : x.split(",").join("");
  } else if (lastDot >= 0 && x.split(".").length > 2) x = x.split(".").join("");
  if (!/^-?\d+(\.\d+)?$/.test(x)) return null;
  return Math.round(Number(x) * 100);
}

/** "2026-03-01" -> "1 Mar 2026" in the household's language. */
export const day = (iso: string | null | undefined): string => {
  if (!iso) return "–";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(loc(), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
export const todayIso = (): string => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
export const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** A field or value name as words: "amount_cents" -> "Amount", "housing.rent" -> "Housing rent". */
export const words = (s: string): string => cap(s.replace(/_id$/, "").replace(/_cents$/, "").replace(/[_.]/g, " "));
export const loading = (): string => t("Loading …");
