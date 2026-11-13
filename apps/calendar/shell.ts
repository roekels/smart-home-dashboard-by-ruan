// What Calendar adds to the shell Worker: the Calendar page, GET /api/calendar (also Today's card) and its place
// on the Security page. The events come from the calendar Worker over a service binding; the shell never sees
// the iCloud password.
import { resourceName } from "../../packages/core/src/household.ts";
import { HttpError, json } from "../../packages/core/src/util.ts";
import type { ShellModule } from "../shell/src/modules.ts";
import type { CalendarUiApi } from "./src/contract.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/calendar?from=&to= (inclusive days). Everyone in the household sees every calendar. */
export async function calendarRoute(req: Request, url: URL, calendar: CalendarUiApi | undefined): Promise<Response> {
  if (req.method !== "GET") throw new HttpError(405, "method not allowed");
  const from = url.searchParams.get("from") ?? "", to = url.searchParams.get("to") ?? "";
  if (!DATE.test(from) || !DATE.test(to)) throw new HttpError(400, "from and to are required, YYYY-MM-DD");
  if (!calendar) throw new HttpError(503, "the calendar Worker is not connected");
  try {
    return json(await calendar.events({ from, to }));
  } catch (e) {
    // the calendar Worker's own messages are safe to show (service.ts); they never quote an event
    throw new HttpError(502, (e as Error).message.slice(0, 300));
  }
}

export const calendarModule: ShellModule = {
  id: "calendar",
  pages: [{ path: "/home/calendar", label: "Calendar", icon: "calendar", where: "home" }],
  api: { calendar: (c) => calendarRoute(c.req, c.url, c.env.CALENDAR) },
  security: (h) => ({
    nodes: [{
      id: "calendar-worker", zone: "cf", name: resourceName(h, "calendar"), sub: "Worker", icon: "calendar", status: "ok",
      text: "Reads and writes the household's iCloud calendars. It has no address of its own: only the dashboard and the MCP gateway can call it.",
      guard: ["The only place the iCloud app password lives", "Each AI connection is held to the calendars and actions that were ticked for it", "Nothing an event says is written to a log"],
      keys: ["CALENDAR_ICLOUD_USER_ID", "CALENDAR_ICLOUD_APP_PASSWORD: an app-specific password, never the Apple ID's own"],
    }, {
      id: "icloud", zone: "out", name: "iCloud", sub: "calendars (CalDAV)", icon: "cloud", status: "ok",
      text: "Apple's calendar service. The calendars are found by their names, so no account id is stored anywhere.",
      guard: ["An app-specific password can be revoked at account.apple.com at any time"],
    }],
    links: [
      { from: "shell", to: "calendar-worker", kind: "service", label: "Today and the Calendar page, read only" },
      { from: "gateway", to: "calendar-worker", kind: "service", label: "/calendar/mcp" },
      { from: "calendar-worker", to: "icloud", kind: "service", label: "CalDAV with the app password" },
    ],
  }),
};
