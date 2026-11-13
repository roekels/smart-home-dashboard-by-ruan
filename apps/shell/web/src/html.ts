// Tiny safe templating: every interpolated value is escaped unless it was made with raw().
// No innerHTML of untrusted strings anywhere else in the UI.

const RAW = Symbol("raw");
export interface Raw { [RAW]: true; s: string }

export const raw = (s: string): Raw => ({ [RAW]: true, s });

const isRaw = (v: unknown): v is Raw => typeof v === "object" && v !== null && RAW in v;

export function esc(v: unknown): string {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Part = string | number | Raw | null | undefined | false | Part[];

function render(v: Part): string {
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map(render).join("");
  if (isRaw(v)) return v.s;
  return esc(v);
}

/** html`<p>${value}</p>` returns Raw, so templates nest without double escaping. */
export function html(strings: TemplateStringsArray, ...values: Part[]): Raw {
  let out = strings[0];
  values.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return raw(out);
}

export function mount(el: Element, content: Raw): void {
  el.innerHTML = content.s;
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(sel);

export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(sel));
