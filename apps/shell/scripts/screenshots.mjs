// Takes the screenshots in docs/screenshots from demo mode (made-up data only). Needs Playwright with Chromium,
// which is not a dependency of this repository: run it where one is installed.
//   node apps/shell/scripts/demo-server.mjs &      then      node apps/shell/scripts/screenshots.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? import.meta.url);
const { chromium } = require("playwright");
const out = fileURLToPath(new URL("../../../docs/screenshots/", import.meta.url));
const base = process.env.DEMO_URL ?? "http://127.0.0.1:4173";

const shots = [
  { name: "today", path: "/home", w: 1280, h: 860 },
  { name: "today-dark", path: "/home", w: 1280, h: 860, dark: true },
  { name: "today-phone", path: "/home", w: 390, h: 844 },
  { name: "security", path: "/dashboard/security", w: 1280, h: 860 },
];

const browser = await chromium.launch();
for (const s of shots) {
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 2, colorScheme: s.dark ? "dark" : "light" });
  const page = await ctx.newPage();
  await page.goto(base + s.path, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}${s.name}.png` });
  await ctx.close();
  console.log(`docs/screenshots/${s.name}.png`);
}
await browser.close();
