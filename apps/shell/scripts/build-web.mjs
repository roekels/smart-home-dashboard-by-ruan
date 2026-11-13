// Builds the UI from web/ into public/ (git-ignored; the Worker serves it as static assets).
// Compiles the TypeScript with tsc, then copies the page, the styles, the fonts and the icons.
// The public sign-in page's own files go to /login/, so one Access bypass covers them.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL("..", import.meta.url));
const web = join(here, "web");
const out = join(here, "public");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync("npx", ["tsc", "-p", web], { stdio: "inherit", cwd: here });
for (const dir of ["styles", "fonts", "icons"]) cpSync(join(web, dir), join(out, dir), { recursive: true });
cpSync(join(web, "index.html"), join(out, "index.html"));

mkdirSync(join(out, "login"), { recursive: true });
cpSync(join(web, "login", "login.css"), join(out, "login", "login.css"));
cpSync(join(web, "login", "mark.svg"), join(out, "login", "mark.svg"));
cpSync(join(web, "icons", "mark-180.png"), join(out, "login", "icon-180.png"));
cpSync(join(web, "fonts", "Geist-Variable.woff2"), join(out, "login", "Geist-Variable.woff2"));
console.log(`UI built into ${out}`);
