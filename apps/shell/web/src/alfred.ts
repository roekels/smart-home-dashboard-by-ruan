// The assistant's client: talks to /api/alfred/* on the page's own origin (the dashboard Worker hands it to the
// assistant's Worker after the sign-in check). The event names match apps/alfred/src/events.ts.
import { call } from "./api.ts";

export interface ForOther { person: string; asked: string }

export type AlfredEvent =
  | { type: "start"; conversation_id: string }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; label: string; status: "running" | "done" | "error" | "declined" }
  | { type: "confirm"; id: string; name: string; label: string; input: Record<string, unknown>; for_other?: ForOther; health_chat?: boolean }
  | { type: "done"; conversation_id: string; status: "complete" | "awaiting_approval"; usage: Record<string, number> }
  | { type: "error"; code: string; message: string };

export interface Turn { role: "user" | "assistant"; text: string; tools: string[] }
/** A write waiting for a yes. for_other: it is for another person's records; `asked` is the speaker's own words. */
export interface Waiting { id: string; name: string; input: Record<string, unknown>; for_other?: ForOther; health_chat?: boolean }
export interface ConversationRow { id: string; title: string; created: string; updated: string }

/** What an admin sees on the settings page. `services` are the gateway's services right now: a pair of check
 *  boxes each ("<id>.read", "<id>.write"; a missing key means on). `down` names services that did not answer. */
export interface AlfredSettings {
  name: string;
  persona: string;
  permissions: Record<string, boolean>;
  fast: boolean;
  /** Admins may open every person's calendar through the assistant. Off by default. */
  adminCalendars: boolean;
  services: { id: string; name: string }[];
  down: string[];
  model: string;
  effort: string;
  usage: { today: number; limit: number | null };
}
export type SettingsChange = Partial<Pick<AlfredSettings, "name" | "persona" | "permissions" | "fast" | "adminCalendars">>;

/** One turn as the assistant recorded it (events.ts Trace): where the time and the tokens went. */
export interface AlfredTrace {
  at: string; who: string; kind: string; ask: string; setup_ms: number; total_ms: number; status: string;
  context: { source: string; ms: number; ok: boolean }[];
  rounds: { ms: number; input: number; output: number; cache_read: number; cache_write: number; tools: string[]; tools_ms: number }[];
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
}

/** Reads a text/event-stream body and yields each event. */
async function* events(res: Response): AsyncGenerator<AlfredEvent> {
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({})) as { error?: string; code?: string };
    yield { type: "error", code: data.code ?? `http_${res.status}`, message: data.error ?? `The assistant is not reachable (HTTP ${res.status}).` };
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let type = "", data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) type = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!type || !data) continue;
      try { yield { type, ...JSON.parse(data) } as AlfredEvent; } catch { /* skip a broken event */ }
    }
  }
}

async function* post(body: unknown): AsyncGenerator<AlfredEvent> {
  const res = await fetch("/api/alfred/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Dashboard": "1", accept: "text/event-stream" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  yield* events(res);
}

export const alfred = {
  /** Send a message; leave conversationId empty to start a new conversation. `skill` names extra instructions
   *  the assistant follows for this message (apps/alfred/src/prompt.ts SKILLS). */
  ask: (message: string, conversationId?: string, skill?: string) =>
    post({ conversation_id: conversationId || undefined, message, skill }),
  /** Approve or decline the writes the assistant is waiting on. */
  decide: (conversationId: string, decisions: { id: string; ok: boolean }[]) => post({ conversation_id: conversationId, decisions }),
  conversations: () => call<{ conversations: ConversationRow[] }>("GET", "/alfred/conversations"),
  history: (id: string) => call<{ turns: Turn[]; waiting: Waiting[] }>("GET", `/alfred/conversations/${encodeURIComponent(id)}`),
  /** For everyone: what the household calls its assistant. */
  name: () => call<{ name: string }>("GET", "/alfred/settings").then((r) => r.name, () => "Alfred"),
  settings: () => call<AlfredSettings>("GET", "/alfred/settings"),
  saveSettings: (change: SettingsChange) => call<AlfredSettings>("POST", "/alfred/settings", change),
  traces: () => call<{ traces: AlfredTrace[] }>("GET", "/alfred/traces"),
};

/** "brain__create_note" -> "brain · create note", for a tool that came without a label. */
export const toolName = (q: string): string => q.replace("__", " · ").replace(/_/g, " ");
