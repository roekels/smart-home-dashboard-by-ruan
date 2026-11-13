// node build.mjs <outfile>  ->  the Brain map's libraries as one ES module, plus <outfile>.LEGAL.txt beside it.
// apps/shell/scripts/build-web.mjs runs this on every UI build (after `npm ci` here, once); nothing built is committed.
// The graph libraries inject a <style> tag at load; the page's CSP (style-src 'self') blocks that, so the injection
// is dropped here and the same few rules live in web/styles/brain-map.css instead.
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const outfile = process.argv[2];
if (!outfile) throw new Error("usage: node build.mjs <outfile>");

const noStyleInject = {
  name: "no-style-inject",
  setup(b) {
    b.onLoad({ filter: /node_modules[\\/](3d-force-graph|force-graph|three-render-objects|float-tooltip)[\\/].*\.m?js$/ }, async (args) => {
      const src = await readFile(args.path, "utf8");
      return { contents: src.replace(/function styleInject\(([^)]*)\)\s*\{/g, "function styleInject($1) { return;"), loader: "js" };
    });
  },
};

await build({
  entryPoints: ["entry.js"],
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2022",
  legalComments: "external",
  outfile,
  plugins: [noStyleInject],
  logLevel: "warning",
});
