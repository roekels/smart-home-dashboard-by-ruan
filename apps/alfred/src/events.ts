/**
 * The stream the assistant sends back for one turn (text/event-stream). The chat page reads exactly these events.
 *
 *   start   { conversation_id }
 *   text    { delta }                                   a piece of the answer
 *   tool    { id, name, label, status }                  status: running | done | error | declined
 *   confirm { id, name, label, input, for_other?, health_chat? }
 *                                                        a write waiting for a yes; the turn pauses.
 *                                                        for_other: it touches another person's records, with the
 *                                                        speaker's words that asked for it.
 *                                                        health_chat: a Brain write proposed in a chat about health
 *   done    { conversation_id, status, usage }           status: complete | awaiting_approval
 *   error   { code, message }                            the turn ended without an answer
 */
export interface ForOther { person: string; asked: string }

export type AlfredEvent =
  | { type: "start"; conversation_id: string }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; label: string; status: "running" | "done" | "error" | "declined" }
  | { type: "confirm"; id: string; name: string; label: string; input: Record<string, unknown>; for_other?: ForOther; health_chat?: boolean }
  | { type: "done"; conversation_id: string; status: "complete" | "awaiting_approval"; usage: Usage }
  | { type: "error"; code: string; message: string };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** Where one turn spent its time and tokens. `ask` is the first 80 characters of the message (none when the turn is
 *  about health, agent.ts). Never tool inputs or results. */
export interface Trace {
  at: string;
  kind: "message" | "decisions";
  ask: string;
  /** tool list + auto-context, before the first model call */
  setup_ms: number;
  context: { source: string; ms: number; ok: boolean }[];
  rounds: { ms: number; first_text_ms: number | null; model: string; stop: string; input: number; output: number; cache_read: number; cache_write: number; tools: string[]; tools_ms: number }[];
  total_ms: number;
  /** complete | awaiting_approval | an error code */
  status: string;
  usage: Usage;
}

export const zeroUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

export type Emit = (e: AlfredEvent) => void;

/** A Response that streams events, and the emit function that feeds it. Write errors (the tab closed) are ignored. */
export function sseStream(): { response: Response; emit: Emit; close: () => void } {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let open = true;
  const emit: Emit = (e) => {
    if (!open) return;
    const { type, ...data } = e;
    writer.write(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => { open = false; });
  };
  const close = () => {
    if (!open) return;
    open = false;
    writer.close().catch(() => {});
  };
  const response = new Response(readable, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
  return { response, emit, close };
}
