// The consent page: plain HTML, no script. Pure functions so the tests can read what a person would see.
import { esc } from "../../../packages/core/src/util.ts";
import type { Service } from "./services.ts";
import { PAGE_HEADERS } from "./util.ts";

const STYLE = `:root{color-scheme:light dark;--bg:#f4f5f7;--fg:#16171a;--muted:#62646b;--card:#fff;--line:#e2e4e8;--accent:#16171a;--on:#fff;--warn:#a35200}
@media (prefers-color-scheme:dark){:root{--bg:#111215;--fg:#ececef;--muted:#9a9ca4;--card:#1b1c20;--line:#2b2d33;--accent:#ececef;--on:#111215;--warn:#f0a35b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}main{max-width:560px;margin:6vh auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px}h1{font-size:20px;margin:0 0 6px}h2{font-size:15px;margin:18px 0 4px}p{color:var(--muted);margin:0 0 12px}
.warn{color:var(--warn)}label{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--line)}label small{display:block;color:var(--muted)}
.row{display:flex;gap:10px}button{margin-top:16px;flex:1;padding:11px;border:0;border-radius:999px;background:var(--accent);color:var(--on);font:inherit;cursor:pointer}
button.secondary{background:transparent;color:var(--fg);border:1px solid var(--line)}`;

export function page(title: string, body: string, status = 200, headers?: Headers): Response {
  const h = new Headers(headers);
  h.set("content-type", "text/html; charset=utf-8");
  for (const [k, v] of Object.entries(PAGE_HEADERS)) h.set(k, v);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>${STYLE}</style></head>
<body><main><div class="card">${body}</div></main></body></html>`,
    { status, headers: h },
  );
}

export function scopeBoxes(s: Service, ticked: Set<string>): string {
  const box = (scope: string) =>
    `<label><input type="checkbox" name="scope" value="${esc(scope)}"${ticked.has(scope) ? " checked" : ""}><span><b>${esc(scope)}</b><small>${esc(s.scopes[scope])}</small></span></label>`;
  if (s.groups) return s.groups.map((g) => `<h2>${esc(g.heading)}</h2>` + g.scopes.map(box).join("")).join("");
  return Object.keys(s.scopes).map(box).join("");
}

export interface ConsentView {
  service: Service;
  /** The name the person signed in with is shown as. */
  signedInAs: string;
  clientName: string;
  /** Set when the app's identity was verified from its own domain. */
  clientDomain?: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  /** Scopes the app asked for. */
  asked: string[];
  handle: string;
}

/** Tick what the app asked for within this service, or everything when it asked for nothing here. */
export function tickedScopes(s: Service, asked: string[]): Set<string> {
  const mine = asked.filter((x) => x in s.scopes);
  return new Set(mine.length ? mine : Object.keys(s.scopes));
}

export function consentBody(v: ConsentView): string {
  const who = v.clientDomain ? `Published by <b>${esc(v.clientDomain)}</b>.` : "This app registered itself; its name is not verified.";
  const local = v.redirectIsLoopback
    ? `<p class="warn">This sends access to an app on this computer (${esc(v.redirectHost)}). Continue only if you just started connecting from it.</p>`
    : "";
  return `<h1>Connect ${esc(v.clientName)} to ${esc(v.service.title)}</h1>
<p>Signed in as ${esc(v.signedInAs)}. ${who} Access goes to <b>${esc(v.redirectHost)}</b>.</p>${local}
<p>Untick anything this connection shouldn't do. It only works on ${esc(v.service.path)}, and stays connected while it's used at least every 90 days.</p>
<form method="post"><input type="hidden" name="handle" value="${esc(v.handle)}">${scopeBoxes(v.service, tickedScopes(v.service, v.asked))}
<div class="row"><button class="secondary" name="decision" value="deny">Deny</button><button name="decision" value="approve">Allow</button></div></form>`;
}
