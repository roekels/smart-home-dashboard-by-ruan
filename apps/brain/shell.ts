// What the Brain adds to the shell Worker: the Brain page, /api/brain/* (forwarded to the Brain Worker for the
// signed-in person) and its place on the Security page. The shell never sees the key that seals sensitive notes.
import { resourceName } from "../../packages/core/src/household.ts";
import { HttpError, json } from "../../packages/core/src/util.ts";
import type { ApiCtx, ShellModule } from "../shell/src/modules.ts";
import type { BrainUiApi } from "./src/contract.ts";

const ROUTES: Record<string, "GET" | "POST"> = {
  "/graph": "GET", "/note": "GET", "/search": "GET", "/activity": "GET",
  "/note/new": "POST", "/note/save": "POST", "/note/lock": "POST", "/note/unlock": "POST",
};
const MAX_BODY = 400_000;

/** /api/brain/<route>. Reads for everyone in the household; a write needs the same origin and our header. */
export async function brainRoute(c: Pick<ApiCtx, "req" | "url" | "person" | "write">, brain: BrainUiApi | undefined): Promise<Response> {
  const path = c.url.pathname.replace(/^\/api\/brain/, "") || "/";
  const method = ROUTES[path];
  if (!method) throw new HttpError(404, "not found");
  if (c.req.method !== method) throw new HttpError(405, "method not allowed");
  if (method === "POST" && !c.write) throw new HttpError(403, "cross-site or wrong method");
  if (!c.person.id || c.person.id.startsWith("#")) throw new HttpError(403, "the Brain is for the people of the household");
  if (!brain) throw new HttpError(503, "the Brain Worker is not connected");
  let body: string | undefined;
  if (method === "POST") {
    body = await c.req.text();
    if (body.length > MAX_BODY) throw new HttpError(413, "too large");
  }
  let r: { status: number; body: string };
  try {
    r = await brain.api(c.person.id, { method, path, query: c.url.search.slice(1), body });
  } catch {
    throw new HttpError(502, "the Brain did not answer");
  }
  let data: unknown;
  try { data = JSON.parse(r.body); } catch { throw new HttpError(502, "the Brain did not answer"); }
  return json(data, r.status >= 200 && r.status < 600 ? r.status : 502);
}

export const brainModule: ShellModule = {
  id: "brain",
  pages: [{ path: "/home/brain", label: "Brain", icon: "brain", where: "home" }],
  api: { brain: (c) => brainRoute(c, c.env.BRAIN) },
  security: (h) => ({
    nodes: [{
      id: "brain-worker", zone: "cf", name: resourceName(h, "brain"), sub: "Worker + D1", icon: "brain", status: "ok",
      text: "The household's notes: a tree with links, every earlier version, and a sealed tier for sensitive notes. It has no address of its own: only the dashboard and the MCP gateway can call it.",
      guard: [
        "Sensitive notes (a Health or Private branch, or marked sensitive) are encrypted; search only knows their titles",
        "A person reaches sealed notes under their own root and the shared one, never another person's",
        "Nothing is deleted: an edit keeps the old version, and archiving locks a note",
        "Text that looks like a password, key or card number is refused",
      ],
      keys: ["BRAIN_SENSITIVE_ENCRYPTION_KEY: seals the sensitive notes. If it is lost, they cannot be read again"],
    }],
    links: [
      { from: "shell", to: "brain-worker", kind: "service", label: "the Brain page, for the signed-in person" },
      { from: "gateway", to: "brain-worker", kind: "service", label: "/brain/mcp" },
    ],
  }),
};
