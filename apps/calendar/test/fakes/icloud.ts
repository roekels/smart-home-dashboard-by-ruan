// A stand-in for iCloud's CalDAV server, just enough for caldav.ts: discovery, calendar queries, multiget, PUT
// with ETags and DELETE. Everything in it is made up. It records every request so tests can see what was sent where.
export interface Seen { method: string; url: string; authorization: string | null }

const HOST = "https://p01-caldav.icloud.com"; // scrub-check: allow (the shape of Apple's CalDAV hosts, for the fake)
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function ics(uid: string, summary: string, start: string, end: string, extra = ""): string {
  const day = start.length === 8;
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", "BEGIN:VEVENT", `UID:${uid}`, `SUMMARY:${summary}`,
    day ? `DTSTART;VALUE=DATE:${start}` : `DTSTART:${start}`, day ? `DTEND;VALUE=DATE:${end}` : `DTEND:${end}`, ...(extra ? [extra] : []), "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
}

export function fakeIcloud(calendars: Record<string, Record<string, string>>, opts: { password?: string; redirectTo?: string } = {}) {
  const seen: Seen[] = [];
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const store = new Map<string, Map<string, { data: string; etag: number }>>();
  for (const [name, events] of Object.entries(calendars)) store.set(slug(name), new Map(Object.entries(events).map(([uid, data]) => [`${uid}.ics`, { data, etag: 1 }])));
  const names = new Map(Object.keys(calendars).map((n) => [slug(n), n]));
  const multi = (body: string) => new Response(`<?xml version="1.0"?><multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</multistatus>`, { status: 207 });
  const obj = (cal: string, file: string, o: { data: string; etag: number }) =>
    `<response><href>/1234/calendars/${cal}/${file}</href><propstat><prop><getetag>"e${o.etag}"</getetag><c:calendar-data>${esc(o.data)}</c:calendar-data></prop></propstat></response>`;

  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)), method = init.method ?? "GET", headers = new Headers(init.headers), body = String(init.body ?? "");
    seen.push({ method, url: url.toString(), authorization: headers.get("authorization") });
    if (headers.get("authorization") !== "Basic " + btoa(`someone@example.com:${opts.password ?? "app-pass"}`)) return new Response("", { status: 401 });
    if (url.hostname === "caldav.icloud.com" && url.pathname === "/") {
      if (opts.redirectTo) return new Response("", { status: 302, headers: { location: opts.redirectTo } });
      return multi(`<response><href>/</href><propstat><prop><current-user-principal><href>/1234/principal/</href></current-user-principal></prop></propstat></response>`);
    }
    const path = url.pathname;
    if (path === "/1234/principal/") return multi(`<response><href>${path}</href><propstat><prop><c:calendar-home-set><href>${HOST}/1234/calendars/</href></c:calendar-home-set></prop></propstat></response>`);
    if (path === "/1234/calendars/" && method === "PROPFIND") {
      return multi(`<response><href>${path}</href><propstat><prop><displayname/><resourcetype><collection/></resourcetype></prop></propstat></response>` +
        `<response><href>/1234/calendars/tasks/</href><propstat><prop><displayname>Reminders</displayname><resourcetype><collection/></resourcetype></prop></propstat></response>` +
        [...names].map(([s, n]) => `<response><href>/1234/calendars/${s}/</href><propstat><prop><displayname>${esc(n)}</displayname><resourcetype><collection/><c:calendar/></resourcetype></prop></propstat></response>`).join(""));
    }
    const m = path.match(/^\/1234\/calendars\/([^/]+)\/([^/]*)$/);
    const cal = m && store.get(m[1]);
    if (!m || !cal) return new Response("", { status: 404 });
    const file = decodeURIComponent(m[2]);
    if (method === "REPORT") {
      const href = body.match(/<d:href>([^<]+)<\/d:href>/)?.[1];
      if (href) { const f = decodeURIComponent(href.split("/").pop()!); const o = cal.get(f); return multi(o ? obj(m[1], f, o) : ""); }
      return multi([...cal].map(([f, o]) => obj(m[1], f, o)).join(""));
    }
    const have = cal.get(file), match = headers.get("if-match");
    if (method === "PUT") {
      if (headers.get("if-none-match") === "*" && have) return new Response("", { status: 412 });
      if (match && (!have || match !== `"e${have.etag}"`)) return new Response("", { status: 412 });
      cal.set(file, { data: body, etag: (have?.etag ?? 0) + 1 });
      return new Response(have ? null : "", { status: have ? 204 : 201 });
    }
    if (method === "DELETE") {
      if (!have) return new Response("", { status: 404 });
      if (match && match !== `"e${have.etag}"`) return new Response("", { status: 412 });
      cal.delete(file);
      return new Response(null, { status: 204 });
    }
    return new Response("", { status: 405 });
  }) as typeof fetch;

  return { fetcher, seen, raw: (calendar: string, uid: string) => store.get(slug(calendar))?.get(`${uid}.ics`)?.data };
}
