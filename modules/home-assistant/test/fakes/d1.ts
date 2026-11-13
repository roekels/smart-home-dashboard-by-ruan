// A stand-in for D1 on node:sqlite for the home modules' tests: prepare/bind/first/all/run and batch.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function fakeD1(migration: URL): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(migration, "utf8"));
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const stmt = {
      bind(...a: unknown[]) { args = a; return stmt; },
      async first() { return db.prepare(sql).get(...(args as any[])) ?? null; },
      async all() { return { results: db.prepare(sql).all(...(args as any[])) }; },
      async run() { const r = db.prepare(sql).run(...(args as any[])); return { success: true, meta: { changes: Number(r.changes) } }; },
    };
    return stmt;
  };
  const batch = async (list: { run: () => Promise<unknown> }[]) => { const out = []; for (const s of list) out.push(await s.run()); return out; };
  return { prepare, batch } as unknown as D1Database;
}

export const homeDb = (): D1Database => fakeD1(new URL("../../../../apps/shell/migrations/home/0001_init.sql", import.meta.url));
export const agentsDb = (): D1Database => fakeD1(new URL("../../../../apps/shell/migrations/agents/0001_init.sql", import.meta.url));

/** A fetch that plays Home Assistant: records every call and answers from `routes` (path -> body or Response). */
export function fakeHa(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; body: any; headers: Headers }[] = [];
  const fetcher = (async (input: Request) => {
    const url = new URL(input.url), body = input.method === "POST" ? await input.json().catch(() => null) : null;
    calls.push({ method: input.method, path: url.pathname + url.search, body, headers: input.headers });
    const hit = routes[url.pathname];
    if (hit instanceof Response) return hit.clone();
    if (hit === undefined) return new Response("not found", { status: 404 });
    return Response.json(hit);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

export const HA_ENV = {
  HA_URL: "https://ha.example.com", HA_API_LONGLIVED_TOKEN: "test-ha-token",
  HA_TUNNEL_SERVICE_TOKEN_ID: "test-id.access", HA_TUNNEL_SERVICE_TOKEN_KEY: "test-key",
};

/** What Home Assistant's /api/states returns for a small made-up house. */
export const STATES = [
  { entity_id: "light.kitchen_ceiling", state: "on", attributes: { friendly_name: "Kitchen Ceiling", brightness: 255, color_mode: "color_temp", color_temp_kelvin: 2700 } },
  { entity_id: "light.hallway", state: "off", attributes: { friendly_name: "Hallway" } },
  { entity_id: "light.router_status", state: "on", attributes: { friendly_name: "Router Status LED" } },
  { entity_id: "switch.office_desk", state: "on", attributes: { friendly_name: "Office Desk" } },
  { entity_id: "switch.oven_child_lock", state: "off", attributes: { friendly_name: "Oven Child Lock" } },
  { entity_id: "scene.movie_time", state: "2026-01-01T00:00:00+00:00", attributes: { friendly_name: "Movie Time" } },
  { entity_id: "script.good_night", state: "off", attributes: { friendly_name: "Good Night" } },
  { entity_id: "script.open_garage", state: "off", attributes: { friendly_name: "Open Garage" } },
  { entity_id: "todo.shopping", state: "2", attributes: { friendly_name: "Shopping" } },
  { entity_id: "todo.alex_tasks", state: "1", attributes: { friendly_name: "Alex Tasks" } },
  { entity_id: "todo.unnamed", state: "0", attributes: { friendly_name: "Unnamed" } },
  { entity_id: "sensor.solar_power", state: "1.2", attributes: { friendly_name: "Solar Power", unit_of_measurement: "kW", device_class: "power" } },
  { entity_id: "sensor.grid_power", state: "-300", attributes: { friendly_name: "Grid Power", unit_of_measurement: "W", device_class: "power" } },
  { entity_id: "sensor.battery_power", state: "400", attributes: { friendly_name: "Battery Power", unit_of_measurement: "W", device_class: "power" } },
  { entity_id: "sensor.battery_charge", state: "81", attributes: { friendly_name: "Battery Charge", unit_of_measurement: "%", device_class: "battery" } },
  { entity_id: "sensor.fridge_power", state: "45", attributes: { friendly_name: "Fridge Power", unit_of_measurement: "W", device_class: "power" } },
  { entity_id: "sensor.outdoor_temperature", state: "9.5", attributes: { friendly_name: "Outdoor", unit_of_measurement: "°C", device_class: "temperature" } },
  { entity_id: "person.alex", state: "home", attributes: { friendly_name: "Alex" } },
];
