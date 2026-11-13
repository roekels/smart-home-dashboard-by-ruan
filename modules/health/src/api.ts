// /api/health/*: the Health page's API on D1 <prefix>-health.
//   GET  /api/health/mine                                  the caller's own reminders only (Today): shots due, meds, follow-ups
//   GET  /api/health/schema                                the fields of each type, the people this caller may see
//   GET  /api/health/overview[?person=]                    due vaccinations, medication taken now, last test, recent visits
//   GET  /api/health/records[?person=&type=&from=&to=&archived=1]
//   GET  /api/health/records/<id>
//   GET  /api/health/trends?person=[&name=]                every analyte across the person's tests
//   POST /api/health/records                               { type, person, date, data }
//   POST /api/health/records/<id>                          { date?, person?, data? } only what is sent
//   POST /api/health/records/<id>/archive                  { archived: true | false }
// Who sees whose records: everyone their own, an admin everyone's (visibleTo). Writes need the page's same-origin
// header. Errors name fields, never values. Nothing here is logged.
import type { Household, Person } from "../../../packages/core/src/household.ts";
import { localDate } from "../../../packages/core/src/ids.ts";
import { SealError, sealer } from "../../../packages/core/src/seal.ts";
import { HttpError, json } from "../../../packages/core/src/util.ts";
import { FIELDS, FieldError } from "./schema.ts";
import { type HealthCtx, HEALTH_SEAL_LABEL, HEALTH_SECRET, ID, add, archive, get, list, mine, overview, trends, update } from "./store.ts";

export interface HealthEnv { HEALTH_DB?: D1Database; HEALTH_DATA_ENCRYPTION_KEY?: string }

/** The person ids a signed-in person may read and write: their own, and for an admin everyone's. */
export const visibleTo = (h: Household, person: Person): string[] => (person.admin ? h.people.map((p) => p.id) : [person.id]);

/** The store's context for one caller, or why there is none. */
export function healthCtx(env: HealthEnv, h: Household, actor: string, visible: string[]): HealthCtx {
  if (!env.HEALTH_DB) throw new HttpError(503, "the health database is not set up");
  return {
    db: env.HEALTH_DB, seal: sealer(env.HEALTH_DATA_ENCRYPTION_KEY, HEALTH_SEAL_LABEL, HEALTH_SECRET), actor,
    people: h.people.map((p) => p.id), visible, today: localDate(h.timezone),
  };
}

const q = (url: URL, k: string) => url.searchParams.get(k) ?? undefined;

export async function healthApi(req: Request, url: URL, c: HealthCtx, self: string, write: boolean): Promise<Response> {
  const p = url.pathname.replace(/^\/api\/health/, "");
  try {
    if (req.method === "GET") {
      if (p === "/schema") return json({ people: c.visible, fields: FIELDS, locked: !c.seal.ready });
      if (p === "/mine") return json(c.seal.ready ? await mine(c, self) : { person: self, vaccinations_due: [], current_meds: [], follow_ups: [] });
      if (p === "/overview") return json(await overview(c, q(url, "person")));
      if (p === "/records") return json({ records: await list(c, { person: q(url, "person"), type: q(url, "type"), from: q(url, "from"), to: q(url, "to"), archived: url.searchParams.get("archived") === "1" }) });
      if (p === "/trends") {
        const person = q(url, "person");
        if (!person) throw new FieldError("person is required");
        return json({ series: await trends(c, person, q(url, "name")) });
      }
      const m = /^\/records\/([^/]+)$/.exec(p);
      if (m) {
        const r = await get(c, m[1]);
        return r ? json(r) : json({ error: "no such record" }, 404);
      }
      throw new HttpError(404, "not found");
    }
    if (req.method !== "POST") throw new HttpError(405, "method not allowed");
    if (!write) throw new HttpError(403, "cross-site write refused");
    const body: any = await req.json().catch(() => { throw new FieldError("body must be JSON"); });
    if (p === "/records") return json(await add(c, body), 201);
    const m = /^\/records\/([^/]+)(\/archive)?$/.exec(p);
    if (m && ID.test(m[1])) return json(m[2] ? await archive(c, m[1], body?.archived !== false) : await update(c, m[1], body ?? {}));
    throw new HttpError(404, "not found");
  } catch (e) {
    if (e instanceof FieldError) throw new HttpError(e.message === "no such record" ? 404 : 400, e.message);
    if (e instanceof SealError) throw new HttpError(503, e.message);
    throw e;
  }
}

/** The shell's handler for /api/health/*. */
export function healthRoute(req: Request, url: URL, env: HealthEnv, h: Household, person: Person, write: boolean): Promise<Response> {
  return healthApi(req, url, healthCtx(env, h, person.id, visibleTo(h, person)), person.id, write);
}
