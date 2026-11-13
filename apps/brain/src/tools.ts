// What each Brain MCP tool does and which scopes it needs. The descriptions and input schemas are in the gateway
// (apps/gateway/src/tools/brain.ts); the mapping lives here, so the Brain refuses a tool the caller could not have
// been shown, before store.ts checks again.
import type { Scope } from "./core.ts";
import type { Brain } from "./store.ts";
import type { BrainTool } from "./contract.ts";

interface Tool { scope: Scope[]; run: (b: Brain, a: any) => Promise<unknown> }

export const TOOLS: Record<BrainTool, Tool> = {
  search: { scope: ["brain.read"], run: (b, a) => b.search(a) },
  read: { scope: ["brain.read"], run: (b, a) => b.read(a.ref) },
  tree: { scope: ["brain.read"], run: (b, a) => b.tree(a.path, a.depth) },
  recent: { scope: ["brain.read"], run: (b, a) => b.recent(a.since, a.limit) },
  log_read: { scope: ["brain.read"], run: (b, a) => b.logRead(a) },
  history: { scope: ["brain.read"], run: (b, a) => b.history(a.ref, a.version) },
  lint: { scope: ["brain.read"], run: (b) => b.lint() },
  create: { scope: ["brain.create"], run: (b, a) => b.create(a) },
  edit: { scope: ["brain.update"], run: (b, a) => b.edit(a) },
  move: { scope: ["brain.update"], run: (b, a) => b.move(a) },
  link: { scope: ["brain.update"], run: (b, a) => b.link(a) },
  record_add: { scope: ["brain.create"], run: (b, a) => b.recordAdd(a) },
  booking_link: { scope: ["brain.update"], run: (b, a) => b.bookingLink(a) },
  restore: { scope: ["brain.update"], run: (b, a) => b.restore(a) },
  lock_archive: { scope: ["brain.archive"], run: (b, a) => b.lock(a) },
  unlock: { scope: ["brain.archive"], run: (b, a) => b.lock({ ...a, unlock: true }) },
};

/** The note a call is about, for the audit row. A search's words are not kept. */
export const targetOf = (a: any): string | null => {
  const t = a?.ref ?? a?.path ?? a?.from ?? null;
  return typeof t === "string" ? t : null;
};
