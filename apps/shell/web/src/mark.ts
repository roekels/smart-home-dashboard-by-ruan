import { raw, type Raw } from "./html.ts";

/** The neutral house mark: a roof, a body and a door, drawn in the current colour. Replace it with your own in
 *  one place: this file (the menu), web/login/mark.svg (the sign-in page) and scripts/icons.mjs (the app icons). */
export function mark(size = 34): Raw {
  return raw(`<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="currentColor"/>` +
    `<g fill="none" stroke="var(--on-ink)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 31 32 15l18 16"/><path d="M19 28v20h26V28"/><path d="M28 48V37h8v11"/></g></svg>`);
}
