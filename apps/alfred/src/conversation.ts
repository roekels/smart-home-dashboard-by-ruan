import { DurableObject } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import { householdFromVar, personById, publicUrl } from "../../../packages/core/src/household.ts";
import { type Env, DEFAULT_MODEL, json, err } from "./env.ts";
import { type Pending, type TurnInput, type TurnStore, runTurn, TurnError, effortOf } from "./agent.ts";
import { McpPool } from "./mcp.ts";
import { parseOverrides } from "./policy.ts";
import { CONTEXT_LINE } from "./prompt.ts";
import { sseStream } from "./events.ts";
import { HEALTH_WORDS } from "./scope.ts";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

export interface TurnRequest {
  conversation_id: string;
  /** The person's id from the household config, as the dashboard verified it. */
  owner: string;
  input: TurnInput;
}

/** How long a conversation is kept after its last turn. The list (registry.ts prune) drops it at the same age. */
const KEEP_MS = 30 * 864e5;

/**
 * One conversation. Holds its history (append-only) and any write waiting for approval, and runs one turn at a time.
 * It belongs to the person who started it: nobody else can read or continue it.
 */
export class Conversation extends DurableObject<Env> {
  private sql: SqlStorage;
  private messages: MessageParam[] | null = null;
  private busy = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.tables();
  }

  private tables(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
  }

  private meta(k: string): string | null {
    const r = this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0];
    return r ? String(r.v) : null;
  }
  private setMeta(k: string, v: string | null): void {
    if (v === null) this.sql.exec(`DELETE FROM meta WHERE k = ?`, k);
    else this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
  }

  private store(): TurnStore {
    this.messages ??= this.sql.exec(`SELECT role, content FROM messages ORDER BY seq`).toArray()
      .map((r) => ({ role: r.role as MessageParam["role"], content: JSON.parse(String(r.content)) }));
    return {
      history: () => this.messages!,
      append: (m) => {
        this.sql.exec(`INSERT INTO messages (role, content) VALUES (?, ?)`, m.role, JSON.stringify(m.content));
        this.messages!.push(m);
      },
      pending: () => {
        const p = this.meta("pending");
        return p ? (JSON.parse(p) as Pending) : null;
      },
      setPending: (p) => this.setMeta("pending", p ? JSON.stringify(p) : null),
    };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/turn") return this.turn(await req.json<TurnRequest>());
    if (req.method === "GET" && url.pathname === "/history") return this.history(url.searchParams.get("owner") ?? "");
    return err("not_found", "Not found.", 404);
  }

  /** Nothing was said for 30 days: the history and everything else this object holds is deleted. */
  async alarm(): Promise<void> {
    this.messages = null;
    await this.ctx.storage.deleteAll();
    this.tables(); // this object may still be in memory when the next request comes
  }

  private owns(owner: string): boolean {
    const o = this.meta("owner");
    return o === null || o === owner;
  }

  private turn(t: TurnRequest): Response {
    const env = this.env;
    const h = householdFromVar(env.HOUSEHOLD);
    const speaker = personById(h, t.owner);
    if (!speaker || !this.owns(t.owner)) return err("not_found", "No such conversation.", 404);
    if (this.busy) return err("busy", "The assistant is still answering in this conversation.", 409);
    this.busy = true;
    if (this.meta("owner") === null) this.setMeta("owner", t.owner);
    // 30 days after its last turn the conversation deletes itself (alarm below); each turn moves that date on
    void this.ctx.storage.setAlarm(Date.now() + KEEP_MS);

    const { response, emit, close } = sseStream();
    const tools = new McpPool(env, publicUrl(h), speaker);
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("main"));
    const limit = Number(env.ALFRED_DAILY_TOKEN_LIMIT) || 0;
    // A conversation about health keeps no telling title in the list: "Health" is enough to find it again.
    let health = this.meta("health") === "1";
    const text = t.input.kind === "message" ? t.input.text.replace(/\s+/g, " ").trim() : "";
    let title = health || HEALTH_WORDS.test(text) ? "Health" : text.slice(0, 80);

    emit({ type: "start", conversation_id: t.conversation_id });
    (async () => {
      try {
        const settings = await registry.settings();
        const { status, usage } = await runTurn({
          client: new Anthropic({ apiKey: env.ALFRED_ANTHROPIC_API_KEY, maxRetries: 2 }),
          tools,
          store: this.store(),
          budget: { check: async () => !limit || (await registry.spentToday()) < limit, add: async (u) => { await registry.addUsage(u); }, trace: async (tr) => { await registry.addTrace(tr, speaker.name); } },
          config: {
            household: h, speaker, model: env.ALFRED_MODEL || DEFAULT_MODEL, effort: effortOf(env.ALFRED_EFFORT), overrides: parseOverrides(env.ALFRED_TOOL_POLICY),
            settings, health,
            onHealth: () => { this.setMeta("health", "1"); health = true; title = "Health"; },
          },
        }, t.input, emit);
        emit({ type: "done", conversation_id: t.conversation_id, status, usage });
      } catch (e) {
        emit(errorEvent(e));
      } finally {
        await Promise.resolve(registry.touch(t.conversation_id, t.owner, title || "Conversation", health)).catch(() => {});
        await tools.close();
        this.busy = false;
        close();
      }
    })();
    return response;
  }

  /** The conversation as the page shows it: text turns, tool names, and any waiting writes. */
  private history(owner: string): Response {
    if (!this.owns(owner) || this.meta("owner") === null) return err("not_found", "No such conversation.", 404);
    const turns: { role: string; text: string; tools: string[] }[] = [];
    for (const m of this.store().history()) {
      const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as any[]);
      // a user turn: only the person's own words (its last text block), without the auto-context before it
      const texts = blocks.filter((b) => b.type === "text").map((b) => String(b.text));
      const text = (m.role === "user" ? texts.slice(-1) : texts).join("").replace(CONTEXT_LINE, "");
      const tools = blocks.filter((b) => b.type === "tool_use").map((b) => String(b.name));
      if (!text && !tools.length) continue; // tool results only
      turns.push({ role: m.role, text, tools });
    }
    const pending = this.store().pending();
    return json({ turns, waiting: pending?.waiting ?? [] });
  }
}

function errorEvent(e: unknown) {
  if (e instanceof TurnError) return { type: "error" as const, code: e.code, message: e.message };
  if (e instanceof Anthropic.AuthenticationError) return { type: "error" as const, code: "api_key", message: "The Claude API key is missing or wrong (secret ALFRED_ANTHROPIC_API_KEY)." };
  if (e instanceof Anthropic.RateLimitError) return { type: "error" as const, code: "rate_limited", message: "The Claude API is rate limiting the assistant. Try again in a minute." };
  if (e instanceof Anthropic.APIError) return { type: "error" as const, code: "api", message: `Claude API error ${e.status ?? ""}`.trim() };
  console.error("turn failed", e instanceof Error ? e.message : "unknown error");
  return { type: "error" as const, code: "internal", message: "The assistant hit an internal error. The details are in the Worker logs." };
}
