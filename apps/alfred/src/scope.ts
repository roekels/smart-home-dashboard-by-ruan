/**
 * Whose records a tool call touches. Finance and health are personal: the assistant works for the person it is
 * talking to (the speaker).
 *
 *   health   Everyone reaches their own records. Where a tool takes a `person`, the speaker is filled in when the
 *            model leaves it out. Another person's records: admins only, and only when the speaker asked for it in
 *            writing.
 *   finance  Admins only (like the Finance page). A row owned by another person needs the speaker's written request;
 *            shared rows ("joint") do not.
 *
 *   calendar Everyone reaches their own calendar and the shared one, never another person's. Calls that take a list
 *            of `calendars` are cut down to those two; a call that names another person's `calendar` is refused.
 *
 * "Asked in writing" is checked, not trusted: the model must quote the speaker's own words in `other_person_request`,
 * and the quote must really be in one of their messages in this conversation. A write then shows a card that names
 * the person and the quote.
 *
 * This reads only what the tool's input says, so it works with whichever finance and health MCPs the household has:
 * `person` at the top level, `owner` at the top level or inside `fields` or `data`.
 */
import type { Household, Person } from "../../../packages/core/src/household.ts";
import type { ForOther } from "./events.ts";

/** Services that hold one person's private records. */
export const PERSONAL = new Set(["finance", "health"]);
/** Services only admins reach through the assistant. */
export const ADMIN_ONLY = new Set(["finance"]);

/** The person a name or id in a tool input means, or null when it names nobody in the household ("joint" …). */
export function personNamed(h: Household, value: unknown): Person | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim().toLowerCase();
  return h.people.find((p) => p.id === v || p.name.toLowerCase() === v) ?? null;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Whose records the input names: `person` or `owner`, top level first, then inside `fields` / `data`. */
function subject(h: Household, input: Record<string, unknown>): Person | null {
  for (const src of [input, obj(input.fields), obj(input.data)]) {
    for (const key of ["person", "owner"]) {
      const p = personNamed(h, src[key]);
      if (p) return p;
    }
  }
  return null;
}

export type Scoped =
  | { ok: true; input: Record<string, unknown>; other: ForOther | null }
  | { ok: false; reason: string };

export interface ScopeTool { server: string; inputSchema?: Record<string, unknown> }

/**
 * Check one tool call against the rules above. Returns the input to run (with the speaker filled in where the tool
 * takes a `person`), plus who else it is for, or the reason it is refused (handed to the model as the tool's error).
 */
export function scopeCall(h: Household, speaker: Person, t: ScopeTool, input: Record<string, unknown>, said: string[]): Scoped {
  if (t.server === CALENDAR) return calendarCall(h, speaker, t, input);
  if (!PERSONAL.has(t.server)) return { ok: true, input, other: null };
  if (ADMIN_ONLY.has(t.server) && !speaker.admin) return { ok: false, reason: `${t.server} is only open to the household's admins.` };

  let out = input;
  const takesPerson = "person" in obj(obj(t.inputSchema).properties);
  if (takesPerson && (typeof input.person !== "string" || !input.person.trim())) out = { ...input, person: speaker.id };

  const who = subject(h, out);
  if (!who || who.id === speaker.id) return { ok: true, input: out, other: null };

  if (!speaker.admin) return { ok: false, reason: `These are ${who.name}'s records. ${speaker.name} can only reach their own here.` };
  const asked = typeof input.other_person_request === "string" ? input.other_person_request.trim() : "";
  if (!quoted(asked, said)) {
    return {
      ok: false,
      reason: `This touches ${who.name}'s records, not the speaker's. Do it only when the speaker asked for it in writing, and put their words, quoted exactly from their message, in other_person_request.`,
    };
  }
  return { ok: true, input: out, other: { person: who.name, asked } };
}

/** The calendar id every household has next to one per person (the gateway's calendar service). */
export const SHARED_CALENDAR = "shared";
const CALENDAR = "calendar";

/** Calendars: the speaker's own and the shared one. The gateway key may reach more; this is what keeps one person's
 *  diary out of another person's chat. Also used for the calendar fetched up front (context.ts). */
function calendarCall(h: Household, speaker: Person, t: ScopeTool, input: Record<string, unknown>): Scoped {
  const mine = [speaker.id, SHARED_CALENDAR];
  const refuse = (id: string): Scoped => {
    const who = personNamed(h, id);
    return { ok: false, reason: `${who ? `${who.name}'s calendar` : `The calendar "${id}"`} is not open here. ${speaker.name} reaches their own calendar and the shared one.` };
  };
  let out = input;
  if (typeof input.calendar === "string" && !mine.includes(input.calendar.trim().toLowerCase())) return refuse(input.calendar);
  if ("calendars" in obj(obj(t.inputSchema).properties)) {
    const asked = Array.isArray(input.calendars) ? input.calendars.filter((c): c is string => typeof c === "string").map((c) => c.trim().toLowerCase()) : null;
    const kept = asked ? asked.filter((c) => mine.includes(c)) : mine;
    if (asked && asked.length && !kept.length) return refuse(asked[0]);
    out = { ...input, calendars: kept.length ? kept : mine };
  }
  return { ok: true, input: out, other: null };
}

const norm = (s: string): string => s.toLowerCase().replace(/[“”„"'‘’«»]/g, "").replace(/\s+/g, " ").trim();

/** Is `quote` (at least a few words) found in what the speaker wrote? */
export function quoted(quote: string, speakerTexts: string[]): boolean {
  const q = norm(quote).replace(/^[.,;:!?…-]+|[.,;:!?…-]+$/g, "");
  if (q.length < 8) return false;
  return speakerTexts.some((t) => norm(t).includes(q));
}

/** Word stems that make a message health-related, in English and German. Over-matching only hides one trace line. */
export const HEALTH_WORDS = /(doctor|arzt|ärzt|gyn|hospital|kranken|spital|clinic|klinik|blood|blut|befund|vaccin|impf|booster|medic|medikament|prescri|rezept|diagnos|therap|symptom|health|gesund|sick|krank|schmerz|pregnan|schwanger|allerg|surgery|check-?up|untersuchung|ultrasound|ultraschall|dentist|\bdr\.|\bpills?\b|\bpain\b|\blabs?\b)/i;
