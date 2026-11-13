// Draws the app icons from the house mark into web/icons. Dev only: it needs a headless Chromium (Playwright).
// The PNGs are committed; run this again only after changing the mark.
//   node scripts/icons.mjs
//   mark-180.png            iPhone Home Screen and the sign-in page (full square; iOS rounds the corners)
//   mark-192.png, -512.png  manifest "any" (rounded tile)
//   mark-maskable-512.png   manifest "maskable" (full bleed, mark inside the safe zone)
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createRequire } from "node:module";

const out = fileURLToPath(new URL("../web/icons", import.meta.url));
const INK = "#14161a", PAPER = "#ffffff";

/** The mark on a tile. `scale` shrinks the house towards the middle (the maskable icon keeps a safe zone). */
function tile({ radius = 0, scale = 1 } = {}) {
  const t = 32 * (1 - scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="${radius}" fill="${INK}"/>` +
    `<g transform="translate(${t} ${t}) scale(${scale})" fill="none" stroke="${PAPER}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M14 31 32 15l18 16"/><path d="M19 28v20h26V28"/><path d="M28 48V37h8v11"/></g></svg>`;
}

// Playwright from wherever it is installed (a global install is fine): require resolves NODE_PATH, import does not
const { chromium } = createRequire(import.meta.url)("playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function png(svg, size, name) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: join(out, name), omitBackground: true });
}
mkdirSync(out, { recursive: true });
await png(tile({ scale: 0.9 }), 180, "mark-180.png");
await png(tile({ radius: 15 }), 192, "mark-192.png");
await png(tile({ radius: 15 }), 512, "mark-512.png");
await png(tile({ scale: 0.7 }), 512, "mark-maskable-512.png");
await browser.close();
console.log("icons drawn");
