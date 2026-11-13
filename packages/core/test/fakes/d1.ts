// A stand-in for D1 on node:sqlite, loaded with a module's real migrations. For tests only.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

class Stmt {
  db: DatabaseSync; sql: string; args: unknown[];
  constructor(db: DatabaseSync, sql: string, args: unknown[] = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args: unknown[]) { return new Stmt(this.db, this.sql, args); }
  // rows as plain objects, like D1's (node:sqlite gives objects without a prototype)
  async first<T>() { const r = this.db.prepare(this.sql).get(...(this.args as never[])); return (r ? { ...r } : null) as T | null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...(this.args as never[])).map((r) => ({ ...r })) as T[] }; }
  async run() { const r = this.db.prepare(this.sql).run(...(this.args as never[])); return { success: true, meta: { changes: Number(r.changes) } }; }
}

/** `migrations`: a URL of a folder of .sql files, applied in name order. */
export function fakeD1(migrations: URL): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = fileURLToPath(migrations);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(`${dir}/${f}`, "utf8"));
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    // like D1: all or nothing, and a statement that reads gives its rows
    batch: async (list: Stmt[]) => {
      const out = [];
      db.exec("BEGIN");
      try {
        for (const s of list) out.push(/^\s*(SELECT|WITH)\b/i.test(s.sql) ? { success: true, meta: { changes: 0 }, ...(await s.all()) } : await s.run());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return out;
    },
    exec: async (sql: string) => { db.exec(sql); return { count: 0, duration: 0 }; },
  } as unknown as D1Database;
}
