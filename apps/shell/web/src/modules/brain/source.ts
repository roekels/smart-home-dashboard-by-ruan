// Where the Brain map gets its data: /api/brain/* on the dashboard Worker, which forwards each call to the Brain
// Worker for the signed-in person (apps/brain/shell.ts, apps/brain/src/ui.ts). Demo mode answers the same paths
// from demo/data/brain.json.
import { call } from "../../api.ts";

export interface GNode {
  id: string; parent_id: string | null; root: string; title: string; path: string;
  kind: string; type: string; status: string; sensitivity: string; updated: string;
  archived: boolean; locked: boolean; booking: string | null; degree: number;
  x?: number; y?: number; z?: number; __flash?: number;
}
export interface GLink { source: string | GNode; target: string | GNode; kind: string }
/** roots: the tops of the tree, in order: one per person, then the shared one. */
export interface Graph { roots: string[]; nodes: GNode[]; links: GLink[] }
export interface PulseEvent { op: string; paths: string[]; actor: string }
export interface Activity { ts: string; job: string; summary?: string; paths: string[]; actor?: string }
export interface SearchHit { path: string; title: string; snippet?: string }
export interface SaveResult { path: string; version: number; links_updated_in?: string[]; not_updated?: string[] }

export interface BrainSource {
  graph(): Promise<Graph>;
  note(path: string): Promise<any>;
  search(q: string): Promise<SearchHit[]>;
  activity(since: string): Promise<Activity[]>;
  save(path: string, base_version: number, body: string, summary: string, title?: string): Promise<SaveResult>;
  create(parent: string, title: string): Promise<{ path: string }>;
  lock(path: string, unlock?: boolean): Promise<unknown>;
}

const enc = encodeURIComponent;

export const brainSource: BrainSource = {
  graph: () => call<Graph>("GET", "/brain/graph"),
  note: (path) => call<any>("GET", `/brain/note?path=${enc(path)}`),
  search: async (q) => {
    const r = await call<SearchHit[] | { results?: SearchHit[] }>("GET", `/brain/search?q=${enc(q)}`);
    return Array.isArray(r) ? r : r.results ?? [];
  },
  activity: (since) => call<Activity[]>("GET", `/brain/activity?since=${enc(since)}`),
  save: (path, base_version, body, summary, title) => call<SaveResult>("POST", "/brain/note/save", { path, base_version, body, summary, title }),
  create: (parent, title) => call<{ path: string }>("POST", "/brain/note/new", { parent, title }),
  lock: (path, unlock = false) => call<unknown>("POST", `/brain/note/${unlock ? "unlock" : "lock"}`, { path }),
};
