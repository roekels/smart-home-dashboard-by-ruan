// Demo mode without Cloudflare: runs the Worker's own code in Node, with the built UI from public/ as its assets
// and DEMO_MODE on. Loopback only. For previews, screenshots and the browser tests.
//   npm run demo            (builds the UI first)   ->   http://127.0.0.1:4173/
//   PORT=5000 node scripts/demo-server.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";

const root = fileURLToPath(new URL("../public", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };

/** Stands in for the ASSETS binding: a file from public/, or index.html for a page path (the SPA fallback). */
const ASSETS = {
  async fetch(req) {
    const path = normalize(decodeURIComponent(new URL(req.url).pathname));
    const file = join(root, path);
    if (!file.startsWith(root)) return new Response("forbidden", { status: 403 });
    try {
      if (!extname(file)) throw new Error("page");
      return new Response(await readFile(file), { headers: { "content-type": types[extname(file)] ?? "application/octet-stream" } });
    } catch {
      if (extname(file)) return new Response("not found", { status: 404 });
      return new Response(await readFile(join(root, "index.html")), { headers: { "content-type": types[".html"] } });
    }
  },
};
const env = { ASSETS, DEMO_MODE: "on", HOUSEHOLD: "", ACCESS_TEAM: "", ACCESS_AUD: "" };

export function start(port = Number(process.env.PORT ?? 4173)) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body, redirect: "manual" });
    const out = await worker.fetch(request, env);
    const h = {};
    out.headers.forEach((v, k) => {
      // plain http on loopback: drop what only makes sense behind TLS
      if (k === "strict-transport-security") return;
      h[k] = k === "set-cookie" ? v.replace(/;\s*Secure/i, "") : v;
    });
    res.writeHead(out.status, h);
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await start();
  console.log(`demo on http://127.0.0.1:${server.address().port}/`);
}
