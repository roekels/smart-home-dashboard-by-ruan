// What other Workers may call on the calendar Worker over a service binding. Types only, plus version strings.
//   Calendar    the gateway's /calendar/mcp (binding CALENDAR on <prefix>-gateway)
//   CalendarUi  the dashboard's pages, read only (binding CALENDAR on <prefix>-shell)
export const CALENDAR_CONTRACT = "calendar@1";
export const CALENDAR_UI_CONTRACT = "calendar-ui@1";

/** Who the gateway says is calling. Scopes are cal.<calendar id>.<read|add|update|remove>, re-checked on every call. */
export interface CalendarPrincipal { id: string; scopes: string[] }
export type CalOp = "read" | "add" | "update" | "remove";

/** One calendar of the household: a person's own (id = the person id) or the shared one (id "shared"). */
export interface CalendarInfo { id: string; name: string; owner: string | null; found: boolean; can?: CalOp[] }

/** uid is the iCloud event id; occurrences of a repeating event share it (tell them apart by start / occurrence).
 *  status "idea" = the title is in round brackets: planned, not fixed. Times are local to the household, with offset. */
export interface CalendarEvent {
  /** The calendar's name as shown. */
  calendar: string;
  /** The calendar's id: use this in tool calls. */
  calendar_id: string;
  /** The person id the calendar belongs to, or null for the shared calendar. */
  owner: string | null;
  uid: string; title: string; status: "idea" | "confirmed"; start: string; end: string; all_day: boolean; recurring: boolean;
  occurrence?: string; location?: string; notes?: string;
}
export interface EventDetail extends CalendarEvent { repeats?: string; organizer?: string; attendees: number }
export interface AddInput { calendar: string; title: string; start: string; end?: string; location?: string; notes?: string; tentative?: boolean }
export interface UpdateInput { calendar: string; uid: string; title?: string; start?: string; end?: string; location?: string | null; notes?: string | null }

export interface CalendarApi {
  version(): string | Promise<string>;
  calendars(p: CalendarPrincipal): Promise<CalendarInfo[]>;
  list(p: CalendarPrincipal, q: { from?: string; to?: string; calendars?: string[] }): Promise<CalendarEvent[]>;
  find(p: CalendarPrincipal, q: { text: string; from?: string; to?: string; calendars?: string[] }): Promise<CalendarEvent[]>;
  get(p: CalendarPrincipal, calendar: string, uid: string): Promise<EventDetail>;
  add(p: CalendarPrincipal, input: AddInput): Promise<EventDetail>;
  update(p: CalendarPrincipal, input: UpdateInput): Promise<EventDetail>;
  confirm(p: CalendarPrincipal, calendar: string, uid: string): Promise<EventDetail | { already_confirmed: string }>;
  /** Without confirm it only says what would be removed. */
  remove(p: CalendarPrincipal, calendar: string, uid: string, confirm?: boolean): Promise<Record<string, unknown>>;
}

export interface CalendarUiApi {
  version(): string | Promise<string>;
  /** Events of every calendar that was found, from..to inclusive (YYYY-MM-DD, the household's time zone). No notes. */
  events(q: { from: string; to: string }): Promise<{ events: CalendarEvent[] }>;
}
