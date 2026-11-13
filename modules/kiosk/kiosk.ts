// Wall tablets: a tablet on the wall is not a person. Cloudflare Access sessions end after a month at most, so a
// paired tablet never uses Access. It lives on its own hostname (var KIOSK_HOST), where the Worker accepts only a
// tablet's key, never a person's sign-in, and only for the wall page and the few things it needs.
//
// Pairing:
//   1. the tablet opens /pair on the kiosk host: POST /api/kiosk/pair/start gives a code (shown) and a poll secret
//   2. an admin types the code in Settings > Wall tablets on the dashboard (behind the sign-in): POST /api/kiosk/approve
//   3. the tablet's next POST /api/kiosk/pair/poll gets its key as an HttpOnly cookie; only its hash is stored
// Settings lists the tablets and revokes one with a click. A key lasts 180 days.
import type { Env } from "../../apps/shell/src/env.ts";
import { HttpError, b64urlEncode, json, sha256hex } from "../../packages/core/src/util.ts";
import { audit, db } from "../home-assistant/store.ts";

/** Who a paired tablet is, for audit lines. "#" cannot be part of a person's id, so it can never be mistaken for one. */
export const KIOSK_ID = "#kiosk";
export const KIOSK_DAYS = 180;
const DAY = 86_400_000;
const PAIR_MS = 10 * 60_000;
const MAX_OPEN_PAIRINGS = 5;
export const COOKIE = "__Host-kiosk";
const CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** The kiosk host: set, and equal to this request's host. */
export const isKioskHost = (env: Env, url: URL): boolean => !!env.KIOSK_HOST && url.hostname === env.KIOSK_HOST.toLowerCase();

// ---- what a tablet may do: read the house, switch lights and scenes, read and tick the shared lists. No plugs,
// no settings, no setup pages, nobody's own lists or records.

const READS = [/^\/api\/me$/, /^\/api\/ha$/, /^\/api\/energy$/, /^\/api\/calendar$/, /^\/api\/lists$/];
const WRITES = [/^\/api\/ha\/(light|scene)$/, /^\/api\/lists\/(add|done)$/];

export function kioskApi(method: string, path: string): boolean {
  if (method === "GET") return READS.some((r) => r.test(path));
  if (method === "POST") return WRITES.some((r) => r.test(path));
  return false;
}

// ---- the tablet's key

function cookieValue(req: Request): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

/** The paired tablet's id, or null. Touches last_seen at most once an hour. */
export async function kioskSession(req: Request, env: Env, now = Date.now()): Promise<string | null> {
  const token = cookieValue(req);
  if (!token || !SECRET.test(token)) return null;
  const d = await db(env).prepare("SELECT id, expires, last_seen FROM kiosk_devices WHERE token_hash = ? AND revoked IS NULL")
    .bind(await sha256hex(token)).first<{ id: string; expires: number; last_seen: number | null }>();
  if (!d || d.expires < now) return null;
  if (!d.last_seen || now - d.last_seen > 3600_000) await db(env).prepare("UPDATE kiosk_devices SET last_seen = ? WHERE id = ?").bind(now, d.id).run();
  return d.id;
}

const randomToken = () => b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
const newId = () => "ks_" + b64urlEncode(crypto.getRandomValues(new Uint8Array(9)));

function pairCode(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 letters: no I, O, 0, 1
  const c = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => A[b % A.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

// ---- pairing (kiosk host, no identity yet)

export async function pairStart(env: Env, now = Date.now()): Promise<Response> {
  await db(env).prepare("DELETE FROM kiosk_pairings WHERE expires < ?").bind(now).run();
  const open = await db(env).prepare("SELECT COUNT(*) AS n FROM kiosk_pairings WHERE device IS NULL").first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_PAIRINGS) throw new HttpError(429, "too many open pairings, try again in a few minutes");
  const code = pairCode(), secret = randomToken();
  await db(env).prepare("INSERT INTO kiosk_pairings (code, secret_hash, created, expires) VALUES (?, ?, ?, ?)")
    .bind(code, await sha256hex(secret), now, now + PAIR_MS).run();
  return json({ code, secret, expires: now + PAIR_MS });
}

/** pending until approved; then the key is made once, set as the cookie, and the pairing is used up. */
export async function pairPoll(env: Env, secret: unknown, now = Date.now()): Promise<Response> {
  if (typeof secret !== "string" || !SECRET.test(secret)) throw new HttpError(400, "bad secret");
  const p = await db(env).prepare("SELECT code, expires, name, approved_by, approved, device FROM kiosk_pairings WHERE secret_hash = ?")
    .bind(await sha256hex(secret)).first<{ code: string; expires: number; name: string | null; approved_by: string | null; approved: number | null; device: string | null }>();
  if (!p || p.device) throw new HttpError(410, "pairing ended, start again");
  if (!p.approved) {
    if (p.expires < now) throw new HttpError(410, "code expired, start again");
    return json({ status: "pending", expires: p.expires });
  }
  const id = newId(), token = randomToken(), expires = now + KIOSK_DAYS * DAY;
  const used = await db(env).prepare("UPDATE kiosk_pairings SET device = ? WHERE code = ? AND device IS NULL").bind(id, p.code).run();
  if (!used.meta.changes) throw new HttpError(410, "pairing ended, start again");
  await db(env).prepare("INSERT INTO kiosk_devices (id, name, token_hash, created, approved_by, expires) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, p.name ?? "Wall tablet", await sha256hex(token), now, p.approved_by ?? "", expires).run();
  await audit(env, p.approved_by ?? KIOSK_ID, "kiosk.paired", id);
  return json({ status: "paired", name: p.name, expires }, 200, {
    "set-cookie": `${COOKIE}=${token}; Path=/; Max-Age=${KIOSK_DAYS * 86_400}; HttpOnly; Secure; SameSite=Strict`,
  });
}

// ---- management (the dashboard's own host, behind the sign-in, admins)

export async function approve(env: Env, by: string, body: any, now = Date.now()): Promise<Response> {
  const code = String(body?.code ?? "").trim().toUpperCase().replace(/^([A-Z0-9]{4})([A-Z0-9]{4})$/, "$1-$2");
  const name = String(body?.name ?? "").trim().slice(0, 40) || "Wall tablet";
  if (!CODE.test(code)) throw new HttpError(400, "the code looks like ABCD-EF23");
  const r = await db(env).prepare("UPDATE kiosk_pairings SET name = ?, approved_by = ?, approved = ? WHERE code = ? AND approved IS NULL AND expires >= ?")
    .bind(name, by, now, code, now).run();
  if (!r.meta.changes) throw new HttpError(404, "no open pairing with that code (it lasts 10 minutes)");
  await audit(env, by, "kiosk.approved", undefined, { name });
  return json({ ok: true, name });
}

export async function devices(env: Env): Promise<Response> {
  const r = await db(env).prepare("SELECT id, name, created, approved_by, expires, last_seen, revoked, revoked_by FROM kiosk_devices ORDER BY created DESC LIMIT 50").all();
  return json({ devices: r.results ?? [], days: KIOSK_DAYS, host: env.KIOSK_HOST ?? null });
}

export async function revoke(env: Env, by: string, id: string, now = Date.now()): Promise<Response> {
  const r = await db(env).prepare("UPDATE kiosk_devices SET revoked = ?, revoked_by = ? WHERE id = ? AND revoked IS NULL").bind(now, by, id).run();
  if (!r.meta.changes) throw new HttpError(404, "no such tablet, or already revoked");
  await audit(env, by, "kiosk.revoked", id);
  return json({ ok: true });
}
