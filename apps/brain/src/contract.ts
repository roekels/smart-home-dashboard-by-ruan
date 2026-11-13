// What other Workers may call on the Brain Worker over a service binding. Types only, plus version strings.
//   Brain    the gateway's /brain/mcp (binding BRAIN on <prefix>-gateway)
//   BrainUi  the dashboard's Brain page (binding BRAIN on <prefix>-shell)
// The caller says who is acting; the Brain checks every scope itself and writes its own audit row.
export const BRAIN_CONTRACT = "brain@1";
export const BRAIN_UI_CONTRACT = "brain-ui@1";

export type BrainScope = "brain.read" | "brain.read.sensitive" | "brain.create" | "brain.update" | "brain.write.sensitive" | "brain.archive";

/** Who the gateway says is calling. user: the email of the person who approved an OAuth connection; a key has none. */
export interface BrainPrincipal { id: string; via: "key" | "oauth"; scopes: string[]; user?: string }

export const BRAIN_TOOLS = [
  "search", "read", "tree", "recent", "log_read", "history", "lint",
  "create", "edit", "move", "link", "record_add", "booking_link", "restore", "lock_archive", "unlock",
] as const;
export type BrainTool = (typeof BRAIN_TOOLS)[number];

/** Errors never cross the binding as classes: a rule that said no is `refused: true` (show its message). */
export type BrainResult<T = unknown> = { ok: true; value: T } | { ok: false; refused: boolean; error: string };

export interface BrainApi {
  version(): string | Promise<string>;
  /** The household's roots, in order (one per person, then the shared one). */
  roots(): Promise<string[]>;
  call(p: BrainPrincipal, tool: BrainTool, args: Record<string, unknown>): Promise<BrainResult>;
}

/** One call from the Brain page. `path` is what follows /api/brain (e.g. "/graph", "/note/save"); `query` has no "?". */
export interface BrainUiRequest { method: string; path: string; query?: string; body?: string }
export interface BrainUiResponse { status: number; body: string }

export interface BrainUiApi {
  version(): string | Promise<string>;
  /** personId: the signed-in person, verified by the shell. They get every scope, with the sensitive tier limited
   *  to their own root and the shared one. Routes: GET /graph /note /search /activity, POST /note/save /note/lock
   *  /note/unlock. */
  api(personId: string, req: BrainUiRequest): Promise<BrainUiResponse>;
  /** Every note this person may read as NDJSON, sensitive ones unsealed: for a data export. */
  exportAll(personId: string): Promise<string>;
}
