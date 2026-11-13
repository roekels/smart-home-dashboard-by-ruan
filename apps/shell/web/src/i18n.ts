// Language of the UI. The template ships English only: t() returns the text it is given. It stays in place as
// the one seam for a translation: call addTranslations({ "Good morning": "Guten Morgen", … }) before the first
// render and every t("…") follows. Keep the argument a plain string literal so the texts can be collected.
let language = "en";
const dict: Record<string, string> = {};

/** Called once /api/me answers, with the household's language tag. */
export function setLanguage(tag: string): void {
  language = tag || "en";
  document.documentElement.lang = language;
}

export function addTranslations(entries: Record<string, string>): void {
  Object.assign(dict, entries);
}

/** For toLocaleString and Intl. Plain "en" reads day before month and a 24 h clock. */
export const loc = (): string => (language === "en" ? "en-GB" : language);

/** t("Good morning, {name}", { name }) */
export function t(en: string, vars?: Record<string, string | number>): string {
  let s = dict[en] ?? en;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** One or many: n(3, "light on", "lights on") → "3 lights on". Both forms are dictionary keys. */
export const n = (count: number, one: string, many: string): string => `${count} ${t(count === 1 ? one : many)}`;
