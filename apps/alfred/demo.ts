// The assistant in demo mode: /api/alfred/* answered from demo/data/alfred.json, with the same shapes and the same
// event stream as the real Worker (src/index.ts, src/events.ts). No model is called and nothing leaves the Worker.
// Conversations and settings live in memory and are gone when it restarts.
import type { Person } from "../../packages/core/src/household.ts";
import { HttpError, SECURITY_HEADERS, json } from "../../packages/core/src/util.ts";
import data from "../../demo/data/alfred.json" with { type: "json" };
import { DEFAULT_MODEL } from "./src/env.ts";
import type { AlfredEvent } from "./src/events.ts";
import { type Settings, DEFAULT_SETTINGS, mergeSettings } from "./src/settings.ts";
import { HEALTH_WORDS } from "./src/scope.ts";

interface Card { id: string; name: string; label: string; input: Record<string, unknown>; approved: string; declined: string }
interface Turn { role: "user" | "assistant"; text: string; tools: string[] }
interface Chat { id: string; owner: string; title: string; created: string; updated: string; turns: Turn[]; waiting: Card | null }

const chats = new Map<string, Chat>();
let settings: Settings = { ...DEFAULT_SETTINGS, name: data.name };
const usage = { input_tokens: 420, output_tokens: 60, cache_read_input_tokens: 9200, cache_creation_input_tokens: 0 };
const ID = /^[0-9a-f-]{36}$/;

const today = (): string => new Date().toISOString().slice(0, 10);
const fill = (v: unknown, p: Person): unknown =>
  typeof v === "string" ? v.replace("{person}", p.id).replace("{today}", today())
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, p)])) : v;

function stream(events: AlfredEvent[]): Response {
  const body = events.map(({ type, ...rest }) => `event: ${type}\ndata: ${JSON.stringify(rest)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS } });
}

function chat(body: any, person: Person): Response {
  let id = typeof body.conversation_id === "string" && ID.test(body.conversation_id) ? body.conversation_id : "";
  const now = new Date().toISOString();
  if (typeof body.message === "string" && body.message.trim()) {
    const text = body.message.trim().slice(0, 2000);
    id ||= crypto.randomUUID();
    let c = chats.get(id);
    if (c && c.owner !== person.id) throw new HttpError(404, "No such conversation.");
    if (!c) {
      if (chats.size >= 50) chats.delete(chats.keys().next().value!);
      c = { id, owner: person.id, title: HEALTH_WORDS.test(text) ? "Health" : text.slice(0, 80), created: now, updated: now, turns: [], waiting: null };
      chats.set(id, c);
    }
    const events: AlfredEvent[] = [{ type: "start", conversation_id: id }];
    if (c.waiting) { events.push({ type: "tool", id: c.waiting.id, name: c.waiting.name, label: c.waiting.label, status: "declined" }); c.waiting = null; }
    const a = data.answers.find((x) => new RegExp(`\\b(${x.match})`, "i").test(text));
    const tools = a?.tools ?? [];
    tools.forEach((t, i) => events.push({ type: "tool", id: `demo_${i}`, name: t.name, label: t.label, status: "done" }));
    const reply = a?.text ?? data.fallback;
    events.push({ type: "text", delta: reply });
    c.turns.push({ role: "user", text, tools: [] }, { role: "assistant", text: reply, tools: [...tools.map((t) => t.name), ...(a?.card ? [a.card.name] : [])] });
    c.updated = now;
    if (a?.card) {
      c.waiting = { id: `demo_card_${c.turns.length}`, name: a.card.name, label: a.card.label, input: fill(a.card.input, person) as Record<string, unknown>, approved: a.approved ?? "Done.", declined: a.declined ?? "Left as it was." };
      events.push({ type: "confirm", id: c.waiting.id, name: c.waiting.name, label: c.waiting.label, input: c.waiting.input });
    }
    events.push({ type: "done", conversation_id: id, status: c.waiting ? "awaiting_approval" : "complete", usage });
    return stream(events);
  }
  const c = chats.get(id);
  if (!c || c.owner !== person.id) throw new HttpError(404, "No such conversation.");
  const d = Array.isArray(body.decisions) ? body.decisions.find((x: any) => x && x.id === c.waiting?.id && typeof x.ok === "boolean") : null;
  if (!c.waiting || !d) return stream([{ type: "start", conversation_id: id }, { type: "error", code: "nothing_pending", message: "There is nothing waiting for approval in this conversation." }]);
  const w = c.waiting;
  c.waiting = null;
  const reply = d.ok ? w.approved : w.declined;
  c.turns.push({ role: "assistant", text: reply, tools: [] });
  c.updated = now;
  return stream([
    { type: "start", conversation_id: id },
    { type: "tool", id: w.id, name: w.name, label: w.label, status: d.ok ? "done" : "declined" },
    { type: "text", delta: reply },
    { type: "done", conversation_id: id, status: "complete", usage },
  ]);
}

const traces = () => data.traces.map(({ minutes_ago, ...t }) => ({ ...t, at: new Date(Date.now() - minutes_ago * 60_000).toISOString() }));

/** Answers /api/alfred/* in demo mode; null for any other path. */
export async function demoAlfred(req: Request, url: URL, person: Person, write: boolean): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/alfred/")) return null;
  const sub = url.pathname.slice("/api/alfred/".length);
  const get = req.method === "GET";
  if (!get && (req.method !== "POST" || !write)) throw new HttpError(403, "cross-site or wrong method");
  if (!get && sub === "chat") return chat(await req.json().catch(() => ({})), person);
  if (get && sub === "conversations") {
    const mine = [...chats.values()].filter((c) => c.owner === person.id).sort((a, b) => b.updated.localeCompare(a.updated));
    return json({ conversations: mine.map(({ id, title, created, updated }) => ({ id, title, created, updated })) });
  }
  const m = /^conversations\/([0-9a-f-]{36})$/.exec(sub);
  if (get && m) {
    const c = chats.get(m[1]);
    if (!c || c.owner !== person.id) throw new HttpError(404, "No such conversation.");
    return json({ turns: c.turns, waiting: c.waiting ? [{ id: c.waiting.id, name: c.waiting.name, input: c.waiting.input }] : [] });
  }
  if (sub === "settings") {
    if (get && !person.admin) return json({ name: settings.name });
    if (!person.admin) throw new HttpError(403, "Only an admin can manage the assistant.");
    if (!get) settings = mergeSettings(settings, await req.json().catch(() => null));
    return json({ ...settings, services: data.services, down: [], model: DEFAULT_MODEL, effort: "low", usage: { today: 184_000, limit: 2_000_000 } });
  }
  if (get && sub === "traces") {
    if (!person.admin) throw new HttpError(403, "Only an admin can manage the assistant.");
    return json({ traces: traces() });
  }
  throw new HttpError(404, "not in the demo");
}
