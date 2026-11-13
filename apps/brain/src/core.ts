// What every part of the Brain shares: who is acting, what they may do, and the pieces a store needs.
// Plain TypeScript, no Worker-only imports: tests run it on node with a stand-in for D1.
import type { Sealer } from "../../../packages/core/src/seal.ts";

export const SCOPES = {
  "brain.read": "Search and read notes",
  "brain.read.sensitive": "Also read sensitive notes (sealed): yours and the shared ones",
  "brain.create": "Create new notes; cannot change existing ones",
  "brain.update": "Edit, move and link notes that are not locked",
  "brain.write.sensitive": "Create and edit sensitive notes (with create or update)",
  "brain.archive": "Lock and archive notes, and unlock them",
} as const;
export type Scope = keyof typeof SCOPES;
export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];

export interface Principal {
  /** A key's name, "oauth:<client>" or "dashboard", followed by " (<person id>)" when a person is acting. */
  actor: string;
  via: "key" | "oauth" | "dashboard";
  scopes: Scope[];
  /** Roots whose sensitive notes this caller may reach, given the sensitive scopes. A person: their own root and
   *  the shared one. null = every root (a gateway key: it belongs to the household's own programs). */
  sensitiveRoots: string[] | null;
}

export const can = (p: Principal, s: Scope) => p.scopes.includes(s);

/** A rule said no. Its message is written for the person or AI on the other side and is safe to show. */
export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

export function need(p: Principal, ...scopes: Scope[]) {
  const missing = scopes.filter((s) => !can(p, s));
  if (missing.length) throw new Refused(`Not allowed: this connection lacks ${missing.join(", ")}.`);
}

/** What a Brain works with. roots: the top of the tree, one per person (their first name) and the shared one last. */
export interface BrainCtx {
  db: D1Database;
  seal: Sealer;
  p: Principal;
  roots: string[];
  /** Today in the household's time zone, YYYY-MM-DD. */
  today: () => string;
}

export const nowIso = () => new Date().toISOString();

/** One audit row: names and paths only. Never throws. */
export function audit(db: D1Database, p: Pick<Principal, "actor" | "via">, tool: string, target: string | null, ok: boolean, detail?: string): Promise<unknown> {
  return db.prepare("INSERT INTO audit (ts, actor, via, tool, target, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(nowIso(), p.actor, p.via, tool, target ? String(target).slice(0, 300) : null, ok ? 1 : 0, detail ? detail.slice(0, 300) : null)
    .run()
    .catch(() => {});
}
