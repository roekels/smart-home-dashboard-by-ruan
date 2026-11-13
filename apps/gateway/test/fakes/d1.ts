// A stand-in for D1 on node:sqlite, with just the calls the gateway uses.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function fakeD1(migration = new URL("../../migrations/0001_init.sql", import.meta.url)): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(migration, "utf8"));
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const stmt = {
      bind(...a: unknown[]) { args = a; return stmt; },
      async first() { return db.prepare(sql).get(...(args as any[])) ?? null; },
      async all() { return { results: db.prepare(sql).all(...(args as any[])) }; },
      async run() { db.prepare(sql).run(...(args as any[])); return { success: true }; },
    };
    return stmt;
  };
  return { prepare } as unknown as D1Database;
}
