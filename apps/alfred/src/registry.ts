import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import type { Usage, Trace } from "./events.ts";
import { type Settings, DEFAULT_SETTINGS, mergeSettings } from "./settings.ts";

/** One instance ("main"): the settings, the conversation list, the daily token budget and the last traces. */
export class Registry extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conversations_owner ON conversations (owner, updated);
      CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL, changed_by TEXT, changed_at TEXT);
      CREATE TABLE IF NOT EXISTS traces (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, who TEXT NOT NULL, data TEXT NOT NULL);`);
  }

  /** Name, tone and check boxes (settings.ts). Nothing stored yet: the defaults. */
  settings(): Settings {
    const r = this.sql.exec(`SELECT v FROM settings WHERE k = 'alfred'`).toArray()[0];
    try { return mergeSettings(DEFAULT_SETTINGS, r ? JSON.parse(String(r.v)) : null); } catch { return DEFAULT_SETTINGS; }
  }

  /** `by`: the person's id. */
  saveSettings(raw: unknown, by: string): Settings {
    const next = mergeSettings(this.settings(), raw);
    this.sql.exec(`INSERT INTO settings (k, v, changed_by, changed_at) VALUES ('alfred', ?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, changed_by = excluded.changed_by, changed_at = excluded.changed_at`,
      JSON.stringify(next), by, new Date().toISOString());
    return next;
  }

  /** Conversations idle for more than `days` drop out of the list: a house assistant, not an archive. */
  prune(days = 30): void {
    this.sql.exec(`DELETE FROM conversations WHERE updated < ?`, new Date(Date.now() - days * 864e5).toISOString());
  }

  /** `retitle`: replace the stored title too (a conversation that turned out to be about health). */
  touch(id: string, owner: string, title: string, retitle = false): void {
    const now = new Date().toISOString();
    this.sql.exec(`INSERT INTO conversations (id, owner, title, created, updated) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated = excluded.updated${retitle ? ", title = excluded.title" : ""}`, id, owner, title, now, now);
    this.prune();
  }

  list(owner: string, limit = 30) {
    return this.sql.exec(`SELECT id, title, created, updated FROM conversations WHERE owner = ? ORDER BY updated DESC LIMIT ?`, owner, limit).toArray();
  }

  /** Tokens billed today (UTC). Cache reads count at a tenth, the way they are priced. */
  spentToday(): number {
    const r = this.sql.exec(`SELECT input, output, cache_read, cache_write FROM usage WHERE day = ?`, today()).toArray()[0];
    if (!r) return 0;
    return Number(r.input) + Number(r.output) + Number(r.cache_write) + Math.round(Number(r.cache_read) / 10);
  }

  addUsage(u: Usage): void {
    this.sql.exec(`INSERT INTO usage (day, input, output, cache_read, cache_write) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET input = input + excluded.input, output = output + excluded.output,
        cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write`,
      today(), u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens);
  }

  /** The last 200 turns: time and tokens per step (events.ts Trace). `who` is a first name. */
  addTrace(t: Trace, who: string): void {
    this.sql.exec(`INSERT INTO traces (at, who, data) VALUES (?, ?, ?)`, t.at, who, JSON.stringify(t));
    this.sql.exec(`DELETE FROM traces WHERE id <= (SELECT MAX(id) FROM traces) - 200`);
  }

  traces(limit = 30): (Trace & { who: string })[] {
    return this.sql.exec(`SELECT who, data FROM traces ORDER BY id DESC LIMIT ?`, Math.min(Math.max(limit, 1), 200)).toArray()
      .map((r) => ({ ...(JSON.parse(String(r.data)) as Trace), who: String(r.who) }));
  }

  usage(days = 14) {
    return this.sql.exec(`SELECT day, input, output, cache_read, cache_write FROM usage ORDER BY day DESC LIMIT ?`, days).toArray();
  }
}

const today = (): string => new Date().toISOString().slice(0, 10);
