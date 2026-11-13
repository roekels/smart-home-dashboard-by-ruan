// What the assistant adds to the dashboard Worker: its chat page, its settings page, and /api/alfred/*, which
// hands each request to the assistant's own Worker over the ALFRED service binding. The dashboard has already
// verified who is signed in; the only identity that travels on is that person's id from the household config.
// A browser cannot choose it: this file builds the request from scratch and copies nothing but the body.
import { resourceName } from "../../packages/core/src/household.ts";
import { HttpError, SECURITY_HEADERS, json } from "../../packages/core/src/util.ts";
import type { ApiCtx, ShellModule } from "../shell/src/modules.ts";

/** /api/alfred/<this> -> the assistant Worker's /v1/<this>. Anything else is a 404 here. */
const ROUTES = /^(chat|conversations|conversations\/[0-9a-f-]{36}|settings|tools|usage|traces|health)$/;
const MAX_BODY = 64_000;

async function forward(c: ApiCtx): Promise<Response> {
  const sub = c.url.pathname.replace(/^\/api\/alfred\/?/, "");
  if (!ROUTES.test(sub)) throw new HttpError(404, "not found");
  const method = c.req.method;
  if (method !== "GET" && method !== "POST") throw new HttpError(405, "method not allowed");
  if (method === "POST" && !c.write) throw new HttpError(403, "cross-site write refused");
  // the health check tells an admin what is missing; nobody else needs it
  if (sub === "health" && !c.person.admin) throw new HttpError(403, "for admins");

  const alfred = (c.env as { ALFRED?: Fetcher }).ALFRED;
  if (!alfred) return json({ error: "The assistant's Worker is not connected to the dashboard yet.", code: "not_connected" }, 503);

  let body: string | undefined;
  if (method === "POST") {
    body = await c.req.text();
    if (body.length > MAX_BODY) throw new HttpError(413, "too long");
  }
  const res = await alfred.fetch(new Request(`https://alfred/v1/${sub}${c.url.search}`, {
    method,
    headers: { "X-Alfred-Person": c.person.id, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body,
  }));
  // the answer goes back as it came (an event stream for /chat), with the dashboard's own headers on top
  const out = new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json; charset=utf-8", "cache-control": "no-store" } });
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export const alfredModule: ShellModule = {
  id: "alfred",
  pages: [
    { path: "/home/assistant", label: "Assistant", icon: "chat", where: "home" },
    { path: "/dashboard/alfred", label: "Assistant settings", icon: "spark", where: "manage", text: "Its name and tone, what it may read and change, and where each message spent its time." },
  ],
  api: { alfred: forward },
  security: (h) => {
    const worker = resourceName(h, "alfred");
    return {
      nodes: [
        { id: "alfred", zone: "cf", name: worker, sub: "the assistant", icon: "chat", status: "ok",
          text: "The chat assistant. It has no address of its own: only the dashboard can call it, after the sign-in. Conversations are kept for 30 days in its own storage.",
          guard: ["Reached only through the dashboard's service binding", "Every change to notes, calendars, finance or health waits for a yes on a card", "Health conversations leave no trace line and no telling title"],
          keys: ["ALFRED_ANTHROPIC_API_KEY and ALFRED_GATEWAY_KEY: Worker secrets"] },
        { id: "anthropic", zone: "out", name: "Anthropic", sub: "Claude API", icon: "cloud", status: "info",
          text: "The assistant's messages, and what its tools return for them, are sent to the Claude API on the household's own key. Only first names go along, never an email address.",
          guard: ["The household's own API key and billing", "A daily token limit on the assistant's Worker"] },
      ],
      links: [
        { from: "shell", to: "alfred", kind: "service", label: "service binding, with the person's id" },
        { from: "alfred", to: "gateway", kind: "service", label: "its own gateway key" },
        { from: "alfred", to: "anthropic", kind: "service", label: "Claude API key" },
        { from: "github", to: "alfred", kind: "deploy", label: "Workers Builds on merge" },
      ],
      signIns: [
        { where: "The assistant", who: "Its own gateway key", how: "A key whose scopes are the hard limit of what it can reach", status: "ok", note: "Narrow it further with the check boxes on the Assistant settings page." },
      ],
    };
  },
};
