// /health/mcp: the household's health records (doctor visits, test results, vaccinations, medication) through the
// shell Worker's Health entrypoint (modules/health). The shell seals every record, checks the scopes again and
// decides whose records a connection may see: the person who approved it sees their own, an admin everyone's.
// The gateway audit gets the tool and the record id, never a value.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Household } from "../../../../packages/core/src/household.ts";
import type { HealthApi, HealthPrincipal } from "../../../../modules/health/src/contract.ts";
import type { Principal } from "../env.ts";
import { fail, text } from "../mcp.ts";

const instructions = (h: Household) => `Health: the medical records of ${h.household}, in one sealed database. Four record types, each with a person and a date:
- vaccination: for (what it protects against), vaccine, dose, due (when it needs a refresh), given_by, notes, source.
- visit: what (kind or specialty: GP, dentist, hospital), who (doctor or clinic), why, outcome, meds [{ name, dose?, until? }], follow_up, healthy_on (date healthy again), cost, notes, source.
- test: kind (blood, urine, allergy, stool, imaging, other), title, lab, results [{ name, value, unit?, low?, high?, ref?, group?, note? }], notes, source. One record per lab report; keep each result's name exactly as the report writes it so trends line up, and copy the report's reference range into low/high (or ref when it is not two numbers). value is text as printed ("5.3", "<0.5", "negative").
- medication: name, for (what it treats), dose, schedule (daily, as needed …), until (stopped on; empty while still taking it), effects (how it works for them, side effects), prescribed_by, visit (id of the visit that prescribed it, same person), notes, source. The record date is when they started. One record per person: if two people take the same medicine, add one for each.

How to work:
- person is a person id from health_schema (${h.people.map((p) => `${p.id} = ${p.name}`).join(", ")}). A connection sees the records of the person who approved it; an admin's connection sees everyone's.
- Simple entry matters: ask only for what is missing (person, date, what it is). Dates are YYYY-MM-DD; if only a month is known, use the 1st and say so in notes.
- Check before adding: health_list for that person and type, so a report or shot is not filed twice. Fix with health_update instead (only the fields sent change; null clears one; the old version is kept).
- source: where the paper or file is kept, in the person's own words.
- Nothing is ever deleted: health_archive hides a record. Health records are private: don't copy them into notes or other tools unless the person asks.
- Medication from a visit: the visit's meds list is the quick note; when it is something taken over time, also add a medication record with visit set to that visit's id.
- health_trends shows every analyte across a person's tests with flags outside the range: use it for "how is my cholesterol doing".
- You are not a doctor: point out values outside their range or shots that are overdue, but do not diagnose.`;

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");
const ID = z.string().regex(/^h[vtxm]_[A-Za-z0-9_-]{4,40}$/).describe("Record id, e.g. ht_…, hv_…, hx_…, hm_…");
const PERSON = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).describe("A person id from health_schema");
const OWNER = PERSON.optional().describe("Whose record this is. When given, the record must belong to that person");
const TYPE = z.enum(["visit", "test", "vaccination", "medication"]);

export function healthPrincipal(p: Principal): HealthPrincipal {
  return { id: p.actor.toLowerCase().replace(/[^a-z0-9:._-]/g, "-").slice(0, 80), scopes: p.scopes, ...(p.via === "oauth" && p.user ? { user: p.user } : {}) };
}

export interface HealthDeps {
  h: Household;
  /** The HEALTH binding; undefined when the shell is not connected. */
  health: HealthApi | undefined;
  /** Writes one audit row; never throws. target is a record id or a type, never a value. */
  log(tool: string, ok: boolean, target: string | null, detail?: string): void;
}

export function buildHealthServer(p: Principal, d: HealthDeps): McpServer {
  const server = new McpServer({ name: "health", version: "0.1.0" }, { instructions: instructions(d.h) });
  const hp = healthPrincipal(p);
  const read = p.scopes.includes("health.read"), write = p.scopes.includes("health.write");
  const tool = (name: string, run: (api: HealthApi, a: any) => Promise<unknown>) => async (args: any) => {
    const target = args?.id ?? args?.type ?? null;
    if (!d.health) {
      d.log(name, false, target, "health binding missing");
      return fail("The health records are not connected to the gateway right now.");
    }
    try {
      const out = await run(d.health, args ?? {});
      d.log(name, true, target);
      return text(out);
    } catch (e) {
      // the shell's messages name fields, never values
      const msg = (e as Error)?.message ?? String(e);
      d.log(name, false, target, msg.slice(0, 200));
      return fail(msg);
    }
  };
  const RO = { readOnlyHint: true }, RW = { readOnlyHint: false, destructiveHint: false };

  if (read) {
    server.registerTool("health_schema", { description: "The people whose records this connection may see, and every record type's fields, one line each.", inputSchema: {}, annotations: RO },
      tool("health_schema", (api) => api.schema(hp)));
    server.registerTool("health_overview", { description: "Per person: counts, vaccinations overdue or due in 90 days, medication taken now, the last test with values outside range, recent visits.", inputSchema: { person: PERSON.optional() }, annotations: RO },
      tool("health_overview", (api, a) => api.overview(hp, a.person)));
    server.registerTool("health_list", {
      description: "Records, newest first, with all their fields. Filter by person, type and date range.",
      inputSchema: { person: PERSON.optional(), type: TYPE.optional(), from: DATE.optional(), to: DATE.optional(), archived: z.boolean().optional().describe("Include archived records") },
      annotations: RO,
    }, tool("health_list", (api, a) => api.list(hp, { person: a.person, type: a.type, from: a.from, to: a.to, archived: a.archived })));
    server.registerTool("health_get", { description: "One record by id.", inputSchema: { id: ID, person: OWNER }, annotations: RO },
      tool("health_get", (api, a) => api.get(hp, a.id, a.person)));
    server.registerTool("health_trends", {
      description: "Every analyte across one person's tests, oldest first, each point flagged low/high against the newest reference range. name narrows to analytes containing it.",
      inputSchema: { person: PERSON, name: z.string().max(80).optional() },
      annotations: RO,
    }, tool("health_trends", (api, a) => api.trends(hp, a.person, a.name)));
  }
  if (write) {
    server.registerTool("health_add", {
      description: "Add one record. data holds the type's fields (see health_schema); unknown fields are refused. Returns the id.",
      inputSchema: { type: TYPE, person: PERSON, date: DATE.describe("When it happened: the visit, the shot, the sample"), data: z.record(z.string(), z.unknown()) },
      annotations: RW,
    }, tool("health_add", (api, a) => api.add(hp, { type: a.type, person: a.person, date: a.date, data: a.data })));
    server.registerTool("health_update", {
      description: "Change a record: only the fields sent change, a data field set to null is cleared, results/meds are replaced as a whole. The old version is kept.",
      inputSchema: { id: ID, person: OWNER, date: DATE.optional(), data: z.record(z.string(), z.unknown()).optional() },
      annotations: RW,
    }, tool("health_update", (api, a) => api.update(hp, a.id, { date: a.date, data: a.data }, a.person)));
    server.registerTool("health_archive", {
      description: "Hide a record (archived true) or bring it back (false). Nothing is ever deleted.",
      inputSchema: { id: ID, person: OWNER, archived: z.boolean().default(true) },
      annotations: RW,
    }, tool("health_archive", (api, a) => api.archive(hp, a.id, a.archived, a.person)));
  }
  return server;
}
