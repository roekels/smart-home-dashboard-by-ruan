// A stand-in for D1 on node:sqlite, loaded with a module's real migrations. For tests only.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

class Stmt {
  db: DatabaseSync; sql: string; args: unknown[];
  constructor(db: DatabaseSync, sql: string, args: unknown[] = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args: unknown[]) { return new Stmt(this.db, this.sql, args); }
  async first<T>() { return (this.db.prepare(this.sql).get(...(this.args as never[])) ?? null) as T | null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] }; }
  async run() { const r = this.db.prepare(this.sql).run(...(this.args as never[])); return { success: true, meta: { changes: Number(r.changes) } }; }
}

/** `migrations`: a URL of a folder of .sql files, applied in name order. */
export function fakeD1(migrations: URL): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = fileURLToPath(migrations);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(`${dir}/${f}`, "utf8"));
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (list: Stmt[]) => { const out = []; for (const s of list) out.push(await s.run()); return out; },
    exec: async (sql: string) => { db.exec(sql); return { count: 0, duration: 0 }; },
  } as unknown as D1Database;
}
