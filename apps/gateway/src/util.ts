import type { Env } from "./env.ts";

export const nowIso = (): string => new Date().toISOString();

export function bearer(req: Request): string {
  const h = req.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

export interface AuditRow { service: string; actor: string; via: string; tool: string; target?: string | null; ok: boolean; detail?: string }

/**
 * Connection audit in the gateway's D1. Never throws; runs after the response when a context is given.
 * Tools pass names and ids only: never note text, amounts or anything from a health record.
 */
export function audit(env: Env, ctx: Pick<ExecutionContext, "waitUntil"> | undefined, r: AuditRow): Promise<void> {
  const q = env.DB.prepare("INSERT INTO audit (ts, service, actor, via, tool, target, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(nowIso(), r.service, r.actor, r.via, r.tool, r.target ? String(r.target).slice(0, 300) : null, r.ok ? 1 : 0, r.detail ? r.detail.slice(0, 500) : null)
    .run()
    .then(() => undefined)
    .catch((e) => console.error("audit", e));
  if (ctx) ctx.waitUntil(q);
  return q;
}

/** The consent page carries its own small style block and no script. No form-action: the answer redirects to the app. */
export const PAGE_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};
