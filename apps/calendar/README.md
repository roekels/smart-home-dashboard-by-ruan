# Calendar

The household's iCloud calendars: one per person and one that everyone shares. This Worker is the only place the
iCloud app-specific password lives. It has no address of its own and no database; the dashboard and the MCP gateway
reach it over service bindings.

| Caller | Entrypoint | What it gets |
| --- | --- | --- |
| Dashboard (Today, `/home/calendar`) | `CalendarUi` | Events of every calendar, read only, without notes |
| Gateway (`/calendar/mcp`) | `Calendar` | Read, add, change, confirm and remove, held to the connection's scopes |

## Which calendars

Calendars are found by their **name** in the iCloud account, so no account id or address is stored anywhere:

- one per person in `household.config.json`, named like the person's first name (`"name": "Alex"` looks for a
  calendar called "Alex", upper or lower case);
- one shared calendar, called "Family" unless the var `CALENDAR_SHARED_NAME` says otherwise.

A calendar that does not exist yet is simply left out; create it in the Calendar app and it appears within six hours
(or at the next deploy). Any other calendar in the account is never read. The calendars can belong to one Apple ID
that shares them with the others: that Apple ID is the one whose app-specific password is set here.

## Secrets

| Name | What |
| --- | --- |
| `CALENDAR_ICLOUD_USER_ID` | The Apple ID (an email address) whose calendars are shown |
| `CALENDAR_ICLOUD_APP_PASSWORD` | An app-specific password from account.apple.com. Never the Apple ID's own password |

Both are Worker secrets on `<prefix>-calendar` (see `secrets.manifest.json`). While they are unset, every call
answers "not connected yet" instead of failing.

## Rules the code keeps

- **Scopes per calendar and action**: `cal.<calendar id>.<read|add|update|remove>`, where the calendar id is a person
  id or `shared`. The gateway offers them on its consent page; this Worker checks them again on every call.
- **The bracket rule**: a title in round brackets, "(dinner with friends)", is an idea: planned, not fixed. Events
  come back with `status: "idea"` or `"confirmed"` and the title without brackets. `confirm` removes the brackets.
- **Removing asks first**: without `confirm: true`, `remove` only says what would be removed.
- **The password only goes to Apple**: every address is checked to be `https://…icloud.com` before a request, and
  redirects are followed by hand under the same check.
- **Event text is data**: invitations come from other people. Nothing an event says is logged, and errors that
  leave this Worker are its own sentences, never iCloud's.
- Timed events are written in UTC and read back in the household's time zone.

## Files

| File | What |
| --- | --- |
| `src/contract.ts` | What the two entrypoints offer (types only) |
| `src/caldav.ts` | CalDAV over `fetch`, iCalendar parsing and repeats with ical.js |
| `src/service.ts` | The rules: scopes, ranges, the two callers |
| `src/index.ts` | The entrypoints |
| `shell.ts` | What Calendar adds to the dashboard: the page, `GET /api/calendar`, its Security entry |
| `test/` | Tests against a stand-in for iCloud (`test/fakes/icloud.ts`) |

The MCP tools are in `apps/gateway/src/tools/calendar.ts`; the page is `apps/shell/web/src/modules/calendar/page.ts`.
