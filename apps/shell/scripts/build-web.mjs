// Builds the UI from web/ into public/ (git-ignored; the Worker serves it as static assets).
// Compiles the TypeScript with tsc, copies the page, the styles, the fonts and the icons, and builds the Brain
// map's libraries into /vendor/.
// The public sign-in page's own files go to /login/, so one Access bypass covers them.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL("..", import.meta.url));
const web = join(here, "web");
const out = join(here, "public");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync("npx", ["tsc", "-p", web], { stdio: "inherit", cwd: here });
for (const dir of ["styles", "fonts", "icons"]) cpSync(join(web, dir), join(out, dir), { recursive: true });
// The Brain map's graph, 3D and markdown libraries: one module built from the pinned versions in web/vendor/source
// (THIRD_PARTY.md lists them). Its packages are installed on the first build only.
const vendor = join(web, "vendor", "source");
if (!existsSync(join(vendor, "node_modules"))) execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { stdio: "inherit", cwd: vendor });
mkdirSync(join(out, "vendor"), { recursive: true });
execFileSync("node", ["build.mjs", join(out, "vendor", "brain-map.js")], { stdio: "inherit", cwd: vendor });
cpSync(join(web, "index.html"), join(out, "index.html"));

mkdirSync(join(out, "login"), { recursive: true });
cpSync(join(web, "login", "login.css"), join(out, "login", "login.css"));
cpSync(join(web, "login", "mark.svg"), join(out, "login", "mark.svg"));
cpSync(join(web, "icons", "mark-180.png"), join(out, "login", "icon-180.png"));
cpSync(join(web, "fonts", "Geist-Variable.woff2"), join(out, "login", "Geist-Variable.woff2"));
// the wall tablet's pairing page (modules/kiosk): its script and style, public on the kiosk host only
cpSync(join(web, "pair"), join(out, "pair"), { recursive: true });
console.log(`UI built into ${out}`);
