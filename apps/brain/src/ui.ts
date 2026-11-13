// The Brain page's API, reached through BrainUi from the shell: the map, one note, search, what changed, and the
// page's own writes (new, save, lock, unlock). The shell has verified who is signed in; every rule is in store.ts.
import { type Principal, Refused, audit } from "./core.ts";
import type { Brain } from "./store.ts";
import { retitleHeading } from "./markdown.ts";
import type { BrainUiRequest, BrainUiResponse } from "./contract.ts";

const json = (data: unknown, status = 200): BrainUiResponse => ({ status, body: JSON.stringify(data) });

const parse = <T>(body?: string): T => {
  try { return JSON.parse(body ?? "") as T; } catch { throw new Refused("The request body isn't valid JSON."); }
};

interface Moved { to?: string; links_updated_in?: string[]; not_updated?: string[] }

export interface UiDeps {
  db: D1Database;
  brain: Brain;
  p: Principal;
  /** Messages of errors that are safe to show besides Refused (a locked sealer, for example). */
  safe?: (e: unknown) => boolean;
  /** Lets a write's audit row finish after the answer went out. */
  waitUntil?: (p: Promise<unknown>) => void;
}

export async function handleUi(d: UiDeps, r: BrainUiRequest): Promise<BrainUiResponse> {
  const method = String(r?.method ?? "GET").toUpperCase();
  const path = String(r?.path ?? "");
  const q = new URLSearchParams(r?.query ?? "");
  const { brain } = d;
  const log = (ok: boolean, target: string | null, detail?: string) => {
    const row = audit(d.db, d.p, `ui${path}`, target, ok, detail);
    if (d.waitUntil) d.waitUntil(row);
    return row;
  };
  let target: string | null = null;
  try {
    let out: unknown;
    switch (`${method} ${path}`) {
      case "GET /graph": out = await brain.graph(); break;
      case "GET /note": {
        const ref = q.get("path") ?? "";
        const [note, history] = await Promise.all([brain.read(ref), brain.history(ref)]);
        out = { ...note, history: (history as { earlier: unknown[] }).earlier };
        break;
      }
      case "GET /search": out = await brain.search({ query: q.get("q") ?? "", limit: 25 }); break;
      case "GET /activity": {
        const since = q.get("since") ?? "";
        const at = Date.parse(since);
        out = await brain.activity(Number.isNaN(at) ? new Date(Date.now() - 864e5).toISOString() : new Date(at).toISOString());
        break;
      }
      case "POST /note/save": {
        // Save the text and, if the title changed, rename first: links to the note in other notes follow.
        const b = parse<{ path: string; base_version: number; body: string; summary?: string; title?: string }>(r.body);
        if (typeof b.path !== "string" || typeof b.body !== "string" || !Number.isInteger(b.base_version)) throw new Refused("path, base_version and body are required");
        target = b.path;
        const summary = String(b.summary ?? "").trim().slice(0, 300) || "Edited on the Brain page";
        let notePath = b.path, version = b.base_version, body = b.body;
        const cur = await brain.read(notePath);
        if (cur.version !== version) throw new Refused(`"${notePath}" changed since you opened it (now version ${cur.version}). Reopen it and redo the change.`);
        const title = typeof b.title === "string" ? b.title.trim() : "";
        let moved: Moved | null = null as Moved | null;
        if (title && title !== cur.title) {
          moved = await brain.move({ ref: notePath, new_title: title, summary: `Renamed "${cur.title}" to "${title}"` }) as Moved;
          notePath = moved.to ?? notePath;
          version += 1;
          body = retitleHeading(body, cur.title, title);
        }
        const edited = await brain.edit({ ref: notePath, base_version: version, rewrite: body, summary }) as { version: number };
        out = { path: notePath, version: edited.version, ...(moved?.links_updated_in ? { links_updated_in: moved.links_updated_in } : {}), ...(moved?.not_updated ? { not_updated: moved.not_updated } : {}) };
        break;
      }
      case "POST /note/new": {
        // An empty note under an existing one; the page then opens it in the editor.
        const b = parse<{ parent: string; title: string }>(r.body);
        const title = typeof b.title === "string" ? b.title.trim() : "";
        if (typeof b.parent !== "string" || !title || title.length > 120 || title.includes("/")) throw new Refused("parent and a title without / are required");
        target = `${b.parent}/${title}`;
        const made = await brain.create({ path: target, body: `# ${title}\n`, summary: "Created on the Brain page" }) as { created?: string };
        out = { path: made.created ?? target };
        break;
      }
      case "POST /note/lock":
      case "POST /note/unlock": {
        const b = parse<{ path: string; summary?: string }>(r.body);
        if (typeof b.path !== "string") throw new Refused("path is required");
        target = b.path;
        const unlock = path.endsWith("unlock");
        out = await brain.lock({ ref: b.path, unlock, summary: String(b.summary ?? "").trim().slice(0, 300) || (unlock ? "Unlocked on the Brain page" : "Locked and archived on the Brain page") });
        break;
      }
      default: return json({ error: "not found" }, 404);
    }
    if (method === "POST") await log(true, target);
    return json(out);
  } catch (e) {
    const shown = e instanceof Refused || d.safe?.(e) === true;
    if (method === "POST") await log(false, target, shown ? (e as Error).message : "error");
    // an unexpected error is named by its kind only: a message could quote a note
    if (!shown) console.error("brain ui", path, (e as Error)?.name);
    return json({ error: shown ? (e as Error).message : "Something went wrong" }, shown ? 400 : 500);
  }
}
