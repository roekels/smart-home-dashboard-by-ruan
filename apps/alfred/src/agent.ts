import Anthropic from "@anthropic-ai/sdk";
import type { Household, Person } from "../../../packages/core/src/household.ts";
import type { Catalog, McpTool, Server } from "./mcp.ts";
import { type Mode, modeFor, qualified, label } from "./policy.ts";
import { systemPrompt, turnContext, SKILLS, CONTEXT_LINE, type Skill } from "./prompt.ts";
import { type Emit, type ForOther, type Usage, type Trace, zeroUsage } from "./events.ts";
import { type Settings, DEFAULT_SETTINGS } from "./settings.ts";
import { autoContext } from "./context.ts";
import { scopeCall, HEALTH_WORDS } from "./scope.ts";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type Tool = Anthropic.Beta.Messages.BetaTool;
type ToolUse = Anthropic.Beta.Messages.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type Effort = NonNullable<Anthropic.Beta.Messages.BetaOutputConfig["effort"]>;

/** Model calls per turn before the assistant stops and says so (each tool round is one call). */
export const MAX_STEPS = 12;

/** A write that was proposed and is waiting, plus the results of the reads from the same step. */
export interface Pending {
  order: string[]; // every tool_use id of that assistant message, in order
  waiting: { id: string; name: string; input: Record<string, unknown>; for_other?: ForOther; health_chat?: boolean }[];
  done: ToolResult[];
}

export interface TurnStore {
  history(): MessageParam[];
  append(m: MessageParam): void;
  pending(): Pending | null;
  setPending(p: Pending | null): void;
}

export interface Toolbox {
  catalog(): Promise<Catalog>;
  call(server: Server, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

export interface Budget {
  /** false when today's token budget is spent */
  check(): Promise<boolean>;
  add(u: Usage): Promise<void>;
  /** One line per turn for the settings page and the Worker logs: where the time and the tokens went. */
  trace?(t: Trace): Promise<void>;
}

export interface TurnConfig {
  household: Household;
  /** The person the assistant is talking to, as the dashboard verified them. Finance and health are theirs by default. */
  speaker: Person;
  model: string;
  effort: Effort;
  overrides: Record<string, Mode>;
  /** Name, tone, check boxes and fast mode. Default: everything on, standard speed. */
  settings?: Settings;
  /** false: no auto-context (tests of the bare loop). */
  autoContext?: boolean;
  /** This conversation already touched health records: nothing of it is traced, and Brain writes always show a card
   *  that says so (a life moment the speaker asks for may go there, clinical details never). */
  health?: boolean;
  /** Called once a turn touches the health tools, so the conversation remembers it (conversation.ts). */
  onHealth?: () => void;
}

export type TurnInput =
  | { kind: "message"; text: string; skill?: Skill }
  | { kind: "decisions"; decisions: { id: string; ok: boolean }[] };

export class TurnError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface TurnDeps { client: Anthropic; tools: Toolbox; store: TurnStore; budget: Budget; config: TurnConfig }

const DECLINED = "The person declined this action. It was not carried out.";
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const effortOf = (s: string | undefined): Effort => ((EFFORTS as string[]).includes(s ?? "") ? (s as Effort) : "low");

type Offered = McpTool & { mode: Mode };

function toolsFor(catalog: Catalog, overrides: Record<string, Mode>, settings: Settings): { defs: Tool[]; byName: Map<string, Offered> } {
  const defs: Tool[] = [];
  const byName = new Map<string, Offered>();
  for (const t of catalog.tools) {
    const mode = modeFor(t, overrides, settings);
    if (mode === "off") continue;
    const name = qualified(t);
    byName.set(name, { ...t, mode });
    defs.push({
      name,
      description: mode === "confirm" ? `${t.description}\n\n(Shown to the person for approval before it runs.)` : t.description,
      input_schema: t.inputSchema as Tool["input_schema"],
      eager_input_streaming: true,
    });
  }
  return { defs, byName };
}

async function runTool(tb: Toolbox, t: McpTool, use: { id: string; input: unknown }, emit: Emit): Promise<ToolResult> {
  const name = qualified(t);
  emit({ type: "tool", id: use.id, name, label: label(t), status: "running" });
  // With eager input streaming the API no longer validates inputs; the MCP server checks the schema itself, so
  // here we only make sure it is an object.
  if (!use.input || typeof use.input !== "object" || Array.isArray(use.input)) {
    emit({ type: "tool", id: use.id, name, label: label(t), status: "error" });
    return { type: "tool_result", tool_use_id: use.id, is_error: true, content: "INVALID_INPUT: tool input must be a JSON object." };
  }
  try {
    const r = await tb.call(t.server, t.name, use.input as Record<string, unknown>);
    emit({ type: "tool", id: use.id, name, label: label(t), status: r.isError ? "error" : "done" });
    return { type: "tool_result", tool_use_id: use.id, is_error: r.isError || undefined, content: r.text || "(no output)" };
  } catch (e) {
    emit({ type: "tool", id: use.id, name, label: label(t), status: "error" });
    return { type: "tool_result", tool_use_id: use.id, is_error: true, content: `Tool failed: ${(e as Error).message}` };
  }
}

/**
 * One turn: take a new message (or the person's decisions on waiting writes), then call Claude and run tools until
 * Claude answers, asks for approval, or MAX_STEPS is reached. History is append-only: assistant content goes back
 * exactly as it came (thinking blocks included).
 */
export async function runTurn(deps: TurnDeps, input: TurnInput, emit: Emit): Promise<{ status: "complete" | "awaiting_approval"; usage: Usage }> {
  const started = Date.now();
  const trace: Trace = {
    at: new Date(started).toISOString(), kind: input.kind, ask: input.kind === "message" ? input.text.replace(/\s+/g, " ").trim().slice(0, 80) : "",
    setup_ms: 0, context: [], rounds: [], total_ms: 0, status: "error", usage: zeroUsage(),
  };
  try {
    const r = await turn(deps, input, emit, trace, started);
    trace.status = r.status;
    return r;
  } catch (e) {
    trace.status = e instanceof TurnError ? e.code : "error";
    throw e;
  } finally {
    // Health stays out of the traces and the Worker logs: not even the first words of the message.
    if (deps.config.health || touchesHealth(trace) || (input.kind === "message" && HEALTH_WORDS.test(input.text))) trace.ask = "[health, not traced]";
    trace.total_ms = Date.now() - started;
    console.log("alfred turn", JSON.stringify(trace));
    await deps.budget.trace?.(trace).catch((e) => console.error("trace not saved", e));
  }
}

async function turn(deps: TurnDeps, input: TurnInput, emit: Emit, trace: Trace, started: number): Promise<{ status: "complete" | "awaiting_approval"; usage: Usage }> {
  const { client, tools, store, budget, config } = deps;
  const { household: h, speaker } = config;
  const usage = trace.usage;
  const catalog = await tools.catalog();
  const settings = config.settings ?? DEFAULT_SETTINGS;
  const { defs, byName } = toolsFor(catalog, config.overrides, settings);
  let health = !!config.health;
  const touched = (name: string) => {
    if (!name.startsWith("health__") || health) return;
    health = true;
    config.onHealth?.();
  };
  const system = systemPrompt(h, catalog, settings);

  // ---- 1. The new user message ----
  const pending = store.pending();
  if (input.kind === "message") {
    const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
    if (pending) {
      // A new message while writes wait: they count as declined, and every tool_use still gets its result.
      const declined = new Map(pending.waiting.map((w) => [w.id, { type: "tool_result", tool_use_id: w.id, content: DECLINED } as ToolResult]));
      for (const w of pending.waiting) emit({ type: "tool", id: w.id, name: w.name, label: label(byName.get(w.name) ?? splitName(w.name)), status: "declined" });
      content.push(...ordered(pending, declined));
      store.setPending(null);
    }
    // What the message most likely needs, fetched before the first model call. Its own block, before the person's
    // words, so the page can show the conversation without it.
    if (config.autoContext !== false) {
      const ctx = await autoContext(input.text, (s, n, a) => {
        // the same person rules as a call the model makes (scope.ts): the calendar fetched up front is the speaker's
        const scoped = scopeCall(h, speaker, { server: s, inputSchema: byName.get(`${s}__${n}`)?.inputSchema }, a, [], settings);
        if (!scoped.ok) throw new Error(scoped.reason);
        return tools.call(s, n, scoped.input);
      }, (q) => byName.get(q)?.mode === "auto", emit, {
        timezone: h.timezone, previous: lastAsk(store.history()), brainOnly: input.skill === "brain_note",
        timed: (source, ms, ok) => trace.context.push({ source, ms, ok }),
      }).catch((e) => { console.error("auto-context failed", e); return ""; });
      if (ctx) content.push({ type: "text", text: ctx });
    }
    // A skill goes before the person's words too: the last text block stays theirs alone (history, lastAsk).
    if (input.skill) content.push({ type: "text", text: SKILLS[input.skill] });
    content.push({ type: "text", text: `${turnContext(h, speaker.name)}\n\n${input.text}` });
    store.append({ role: "user", content });
  } else {
    if (!pending) throw new TurnError("nothing_pending", "There is nothing waiting for approval in this conversation.");
    const decided = new Map(input.decisions.map((d) => [d.id, d.ok]));
    const missing = pending.waiting.filter((w) => !decided.has(w.id));
    if (missing.length) throw new TurnError("decisions_missing", `Decide every waiting action: ${missing.map((m) => m.id).join(", ")}`);
    const results = new Map<string, ToolResult>();
    for (const w of pending.waiting) {
      const t = byName.get(w.name);
      touched(w.name);
      if (!decided.get(w.id)) {
        emit({ type: "tool", id: w.id, name: w.name, label: label(t ?? splitName(w.name)), status: "declined" });
        results.set(w.id, { type: "tool_result", tool_use_id: w.id, content: DECLINED });
      } else if (!t) {
        // The settings changed or the service dropped the tool since it was proposed.
        results.set(w.id, { type: "tool_result", tool_use_id: w.id, is_error: true, content: "This tool is no longer available." });
      } else {
        results.set(w.id, await runTool(tools, t, w, emit));
      }
    }
    store.append({ role: "user", content: ordered(pending, results) });
    store.setPending(null);
  }

  // ---- 2. The loop ----
  trace.setup_ms = Date.now() - started;
  let jsonRetries = 0;
  let fast = settings.fast;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (!(await budget.check())) throw new TurnError("budget", "Today's token budget for the assistant is used up. It resets at midnight UTC.");

    const stream = client.beta.messages.stream({
      model: config.model,
      max_tokens: 16_000,
      system: [{ type: "text", text: system }],
      tools: defs,
      messages: store.history(),
      thinking: { type: "adaptive" },
      output_config: { effort: config.effort },
      cache_control: { type: "ephemeral" },
      // A reply the safety classifiers decline is retried on a fallback model inside the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      ...(fast ? { speed: "fast" as const } : {}),
    });
    const t0 = Date.now();
    let first = 0;
    stream.on("text", (delta) => { first ||= Date.now() - t0; emit({ type: "text", delta }); });

    let msg: Anthropic.Beta.Messages.BetaMessage;
    try {
      msg = await stream.finalMessage();
      jsonRetries = 0;
    } catch (e) {
      // Fast mode has its own rate limit (and isn't on every account): carry on at standard speed.
      if (fast && (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.BadRequestError)) { fast = false; continue; }
      // Only a tool input that could not be parsed is retried; API errors go up.
      if (e instanceof Anthropic.APIError || jsonRetries++ >= 2) throw e;
      continue;
    }

    const spent: Usage = {
      input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens,
      cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0, cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
    };
    for (const k of Object.keys(spent) as (keyof Usage)[]) usage[k] += spent[k];
    await budget.add(spent).catch((e) => console.error("budget add failed", e));

    const uses = msg.content.filter((b): b is ToolUse => b.type === "tool_use");
    const round: Trace["rounds"][number] = {
      ms: Date.now() - t0, first_text_ms: first || null, model: msg.model, stop: msg.stop_reason ?? "",
      input: spent.input_tokens, output: spent.output_tokens, cache_read: spent.cache_read_input_tokens, cache_write: spent.cache_creation_input_tokens,
      tools: uses.map((u) => u.name), tools_ms: 0,
    };
    trace.rounds.push(round);

    switch (msg.stop_reason) {
      case "refusal":
        // Partial output is discarded and not kept in history.
        throw new TurnError("refusal", "The assistant can't help with that request.");
      case "model_context_window_exceeded":
        throw new TurnError("too_long", "This conversation is too long. Start a new one.");
      case "max_tokens":
        if (uses.length) throw new TurnError("max_tokens", "The reply was cut off mid-action. Ask again, a bit narrower.");
        store.append({ role: "assistant", content: msg.content });
        emit({ type: "text", delta: "\n\n[Reply cut off at the length limit.]" });
        return { status: "complete", usage };
      case "pause_turn":
        store.append({ role: "assistant", content: msg.content });
        continue;
      case "tool_use":
        break;
      default: // end_turn, stop_sequence
        store.append({ role: "assistant", content: msg.content });
        return { status: "complete", usage };
    }

    store.append({ role: "assistant", content: msg.content });
    const results = new Map<string, ToolResult>();
    const waiting: Pending["waiting"] = [];
    const t1 = Date.now();
    for (const u of uses) touched(u.name);
    const said = speakerWords(store.history());
    await Promise.all(uses.map(async (u) => {
      const t = byName.get(u.name);
      const raw = (u.input && typeof u.input === "object" && !Array.isArray(u.input) ? u.input : {}) as Record<string, unknown>;
      if (!t) {
        results.set(u.id, { type: "tool_result", tool_use_id: u.id, is_error: true, content: `Unknown or disabled tool: ${u.name}` });
        return;
      }
      // whose records or calendar is this? (scope.ts)
      const scoped = scopeCall(h, speaker, t, raw, said, settings);
      if (!scoped.ok) {
        results.set(u.id, { type: "tool_result", tool_use_id: u.id, is_error: true, content: scoped.reason });
        return;
      }
      // a Brain write from a health chat always waits for a card that says where it comes from
      const healthChat = health && t.server === "brain" && !t.readOnly;
      if (t.mode === "confirm" || healthChat) {
        waiting.push({ id: u.id, name: u.name, input: scoped.input, ...(scoped.other ? { for_other: scoped.other } : {}), ...(healthChat ? { health_chat: true } : {}) });
      } else {
        results.set(u.id, await runTool(tools, t, { id: u.id, input: scoped.input }, emit));
      }
    }));
    round.tools_ms = Date.now() - t1;

    if (waiting.length) {
      const order = uses.map((u) => u.id);
      waiting.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      store.setPending({ order, waiting, done: [...results.values()] });
      for (const w of waiting) emit({ type: "confirm", id: w.id, name: w.name, label: label(byName.get(w.name)!), input: w.input, ...(w.for_other ? { for_other: w.for_other } : {}), ...(w.health_chat ? { health_chat: true } : {}) });
      return { status: "awaiting_approval", usage };
    }
    store.append({ role: "user", content: uses.map((u) => results.get(u.id)!) });
  }
  throw new TurnError("too_many_steps", `The assistant stopped after ${MAX_STEPS} steps without finishing. Ask again, or split the request.`);
}

/** Every tool_use of the paused step gets exactly one result, in the original order. */
function ordered(p: Pending, extra: Map<string, ToolResult>): ToolResult[] {
  const all = new Map<string, ToolResult>(p.done.map((r) => [r.tool_use_id, r]));
  for (const [k, v] of extra) all.set(k, v);
  return p.order.map((id) => all.get(id) ?? { type: "tool_result", tool_use_id: id, is_error: true, content: "No result." });
}

/** Did this turn call or propose a health tool? */
const touchesHealth = (t: Trace): boolean => t.rounds.some((r) => r.tools.some((n) => n.startsWith("health__")));

/** Everything the person wrote in this conversation: their own words only, without the context added around them. */
export function speakerWords(history: MessageParam[]): string[] {
  const out: string[] = [];
  for (const m of history) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    const texts = m.content.filter((b) => b.type === "text");
    const last = texts[texts.length - 1];
    if (last && last.type === "text") out.push(last.text.replace(CONTEXT_LINE, ""));
  }
  return out;
}

/** The person's previous message in this conversation, for routing a short follow-up. */
const lastAsk = (history: MessageParam[]): string | undefined => speakerWords(history).at(-1);

function splitName(q: string): { server: Server; name: string } {
  const [server, ...rest] = q.split("__");
  return { server, name: rest.join("__") };
}
