// The Brain in demo mode: the made-up notes from demo/data/brain.json behind the same /api/brain/* answers the
// Brain Worker gives (src/ui.ts), read-only. Sensitive notes follow the real rule: a person sees them under their
// own root and the shared one.
import type { Household, Person } from "../../packages/core/src/household.ts";
import { addDays } from "../../packages/core/src/ids.ts";
import { HttpError, json } from "../../packages/core/src/util.ts";
import { wikilinks } from "./src/markdown.ts";
import { brainRoots, rootOf } from "./src/service.ts";

interface SeedNote { path: string; kind: string; type: string; updated: string; body: string; status?: string; sensitivity?: string; archived?: boolean; locked?: boolean; booking?: string }
export interface DemoBrain { notes: SeedNote[]; activity: { minutes_ago: number; job: string; summary: string; paths: string[]; actor: string }[] }

const day = (v: string, today: string) => (/^@-?\d+$/.test(v) ? addDays(today, Number(v.slice(1))) : v);
const idOf = (path: string) => `demo_${path.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/** GET /api/brain/* in demo mode. Anything that would change a note is refused. */
export function demoBrainApi(req: Request, url: URL, h: Household, person: Person, seed: DemoBrain, today: string, now = Date.now()): Response {
  if (req.method !== "GET") throw new HttpError(403, "The demo is read-only: nothing is saved.");
  const roots = brainRoots(h);
  const mine = [rootOf(person), roots[roots.length - 1]];
  const notes = seed.notes.filter((n) => n.sensitivity !== "sensitive" || mine.includes(n.path.split("/")[0]));
  const byPath = new Map(notes.map((n) => [n.path, n]));
  const titleOf = (n: SeedNote) => n.path.split("/").pop()!;
  /** A [[link]] names a path or a title. */
  const resolve = (target: string) => byPath.get(target) ?? notes.find((n) => titleOf(n).toLowerCase() === target.toLowerCase());
  const parentOf = (n: SeedNote) => n.path.split("/").slice(0, -1).join("/");
  const p = url.pathname.replace(/^\/api\/brain/, ""), q = (k: string) => url.searchParams.get(k) ?? "";

  if (p === "/graph") {
    const links: { source: string; target: string; kind: string }[] = [];
    const seen = new Set<string>();
    const add = (a: SeedNote, b: SeedNote | undefined, kind: string) => {
      if (!b || a === b) return;
      const k = [a.path, b.path].sort().join("|");
      if (seen.has(k)) return;
      seen.add(k);
      links.push({ source: idOf(a.path), target: idOf(b.path), kind });
    };
    for (const n of notes) add(n, byPath.get(parentOf(n)), "tree");
    for (const n of notes) for (const t of wikilinks(n.body)) add(n, resolve(t), "link");
    const degree = new Map<string, number>();
    for (const l of links) for (const id of [l.source, l.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
    return json({
      roots,
      nodes: notes.map((n) => ({
        id: idOf(n.path), parent_id: byPath.has(parentOf(n)) ? idOf(parentOf(n)) : null, root: n.path.split("/")[0], title: titleOf(n), path: n.path,
        kind: n.kind, type: n.type, status: n.status ?? "active", sensitivity: n.sensitivity ?? "normal", updated: day(n.updated, today),
        archived: !!n.archived, locked: !!n.locked, booking: n.booking ?? null, degree: degree.get(idOf(n.path)) ?? 0,
      })),
      links,
    });
  }
  if (p === "/note") {
    const n = byPath.get(q("path"));
    if (!n) throw new HttpError(400, `No note at "${q("path")}".`);
    const updated = day(n.updated, today);
    return json({
      path: n.path, id: idOf(n.path), title: titleOf(n), kind: n.kind, version: 1,
      sensitivity: n.sensitivity ?? "normal", locked: !!n.locked, archived: n.archived ? updated : null,
      frontmatter: { type: n.type, status: n.status ?? "active", updated, ...(n.booking ? { booking: n.booking } : {}) },
      body: n.body,
      children: notes.filter((c) => parentOf(c) === n.path).map((c) => ({ title: titleOf(c), path: c.path, kind: c.kind, type: c.type, archived_at: c.archived ? day(c.updated, today) : null })),
      links: wikilinks(n.body).map((t) => ({ target: t, kind: "link", path: resolve(t)?.path ?? null })),
      backlinks: notes.filter((o) => o !== n && wikilinks(o.body).some((t) => resolve(t) === n)).map((o) => ({ path: o.path, kind: "link" })),
      records: [], calendar: [], history: [],
    });
  }
  if (p === "/search") {
    const text = q("q").trim().toLowerCase();
    if (!text) throw new HttpError(400, "Empty query");
    return json(notes.filter((n) => n.sensitivity !== "sensitive" ? n.body.toLowerCase().includes(text) : titleOf(n).toLowerCase().includes(text)).slice(0, 25).map((n) => {
      const at = n.body.toLowerCase().indexOf(text);
      const from = Math.max(0, at - 40);
      const cut = at < 0 ? "" : `${from ? "…" : ""}${n.body.slice(from, at)}«${n.body.slice(at, at + text.length)}»${n.body.slice(at + text.length, at + text.length + 60)}…`.replace(/\s+/g, " ");
      return { path: n.path, title: titleOf(n), snippet: cut };
    }));
  }
  if (p === "/activity") {
    const since = Date.parse(q("since")) || now - 864e5;
    return json(seed.activity.filter((a) => a.paths.every((x) => byPath.has(x))).map((a) => ({ ts: new Date(now - a.minutes_ago * 60_000).toISOString(), job: a.job, summary: a.summary, paths: a.paths, actor: a.actor }))
      .filter((a) => Date.parse(a.ts) >= since).sort((a, b) => a.ts.localeCompare(b.ts)));
  }
  throw new HttpError(404, "not found");
}
