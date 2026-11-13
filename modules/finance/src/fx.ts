// Reference rates of the European Central Bank for the currencies in use besides the euro. Public data, no key,
// nothing about the household in the request. Stored as 1 EUR = per_eur units, the way the ECB publishes them.
// Runs once a day from the shell Worker's cron, and once when a currency is used for the first time.
import { addDays } from "../../../packages/core/src/ids.ts";
import { CURRENCIES } from "./schema.ts";

const ECB = "https://data-api.ecb.europa.eu/service/data/EXR"; // scrub-check: allow (public ECB data API)
/** How far back the first sync of a currency goes. Older amounts use the earliest rate known. */
const BACK_DAYS = 5 * 366;

/** Rows of an ECB csvdata answer: TIME_PERIOD and OBS_VALUE, wherever the columns sit. */
export function parseEcbCsv(csv: string, currency: string): { date: string; currency: string; per_eur: number }[] {
  const [head, ...rows] = csv.trim().split(/\r?\n/);
  const cols = head.split(",");
  const d = cols.indexOf("TIME_PERIOD"), v = cols.indexOf("OBS_VALUE");
  if (d < 0 || v < 0) throw new Error("ECB answer has no TIME_PERIOD/OBS_VALUE");
  return rows.map((r) => r.split(",")).map((c) => ({ date: c[d], currency, per_eur: Number(c[v]) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.per_eur > 0);
}

/** Remember that a currency is in use. True when it is new (the caller may then fetch its rates right away). */
export async function useCurrency(db: D1Database, currency: string): Promise<boolean> {
  if (currency === "EUR" || !(CURRENCIES as readonly string[]).includes(currency)) return false;
  const r = await db.prepare("INSERT OR IGNORE INTO currencies (currency) VALUES (?)").bind(currency).run();
  return !!r.meta.changes;
}

/** Fetch what is missing since the newest stored rate. Returns how many rates were added. */
export async function syncRates(db: D1Database, today: string, base: string, fetcher: typeof fetch = fetch, only?: string[]): Promise<number> {
  const used = (await db.prepare("SELECT currency FROM currencies").all<{ currency: string }>()).results ?? [];
  const want = new Set(only ?? [base, ...used.map((u) => u.currency)]);
  let added = 0;
  for (const cur of want) {
    if (cur === "EUR" || !(CURRENCIES as readonly string[]).includes(cur)) continue;
    const last = await db.prepare("SELECT max(date) AS d FROM fx_rates WHERE currency = ?").bind(cur).first<{ d: string | null }>();
    if (last?.d && last.d >= today) continue;
    const start = last?.d ?? addDays(today, -BACK_DAYS);
    const res = await fetcher(`${ECB}/D.${cur}.EUR.SP00.A?startPeriod=${start}&format=csvdata`, { headers: { accept: "text/csv" } });
    if (res.status === 404) continue;                      // nothing new (weekend, holiday)
    if (!res.ok) throw new Error(`ECB ${res.status}`);
    const rates = parseEcbCsv(await res.text(), cur);
    for (let i = 0; i < rates.length; i += 50) {
      await db.batch(rates.slice(i, i + 50).map((r) =>
        db.prepare("INSERT OR IGNORE INTO fx_rates (date, currency, per_eur) VALUES (?, ?, ?)").bind(r.date, r.currency, r.per_eur)));
    }
    added += rates.length;
  }
  return added;
}
