// Worker <prefix>-calendar: the only holder of the iCloud app password. No hostname and no database; reachable
// only over service bindings.
//   Calendar    the gateway serves /calendar/mcp through it (apps/gateway/src/tools/calendar.ts)
//   CalendarUi  the dashboard reads events for Today and the Calendar page, read only
// All the rules are in service.ts; this file only exists because an entrypoint must extend WorkerEntrypoint.
import { WorkerEntrypoint } from "cloudflare:workers";
import { CALENDAR_CONTRACT, CALENDAR_UI_CONTRACT, type AddInput, type CalendarApi, type CalendarPrincipal, type CalendarUiApi, type UpdateInput } from "./contract.ts";
import { type CalendarEnv, calendarService, calendarUi } from "./service.ts";

export class Calendar extends WorkerEntrypoint<CalendarEnv> implements CalendarApi {
  private get s() { return calendarService(this.env); }
  version() { return this.s.version(); }
  calendars(p: CalendarPrincipal) { return this.s.calendars(p); }
  list(p: CalendarPrincipal, q: { from?: string; to?: string; calendars?: string[] }) { return this.s.list(p, q); }
  find(p: CalendarPrincipal, q: { text: string; from?: string; to?: string; calendars?: string[] }) { return this.s.find(p, q); }
  get(p: CalendarPrincipal, calendar: string, uid: string) { return this.s.get(p, calendar, uid); }
  add(p: CalendarPrincipal, input: AddInput) { return this.s.add(p, input); }
  update(p: CalendarPrincipal, input: UpdateInput) { return this.s.update(p, input); }
  confirm(p: CalendarPrincipal, calendar: string, uid: string) { return this.s.confirm(p, calendar, uid); }
  remove(p: CalendarPrincipal, calendar: string, uid: string, confirm?: boolean) { return this.s.remove(p, calendar, uid, confirm); }
}

export class CalendarUi extends WorkerEntrypoint<CalendarEnv> implements CalendarUiApi {
  version() { return calendarUi(this.env).version(); }
  events(q: { from: string; to: string }) { return calendarUi(this.env).events(q); }
}

export default {
  async fetch(req: Request): Promise<Response> {
    // No public route. A direct fetch over a binding only gets the health line.
    if (new URL(req.url).pathname === "/health") return Response.json({ status: "ok", service: "calendar", contracts: [CALENDAR_CONTRACT, CALENDAR_UI_CONTRACT] });
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<CalendarEnv>;
