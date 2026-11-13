import { householdFromVar, personById, publicUrl } from "../../../packages/core/src/household.ts";
import { type Env, DEFAULT_MODEL, json, err } from "./env.ts";
import type { TurnRequest } from "./conversation.ts";
import { McpPool, forgetCatalog } from "./mcp.ts";
import { modeFor, parseOverrides, qualified, serviceName } from "./policy.ts";
import { isSkill } from "./prompt.ts";
import { effortOf } from "./agent.ts";
export { Conversation } from "./conversation.ts";
export { Registry } from "./registry.ts";

/**
 * <prefix>-alfred: the house assistant. It has no public route: the only caller is the dashboard Worker, through
 * its ALFRED service binding, after it verified the person's sign-in. The dashboard sets X-Alfred-Person to that
 * person's id from the household config (and never forwards one a browser sent). This Worker looks the id up in
 * its own copy of the config, so an unknown id gets nothing.
 *
 *   POST /v1/chat                  { conversation_id?, message, skill? } or { conversation_id, decisions: [{ id, ok }] }  -> event stream
 *   GET  /v1/conversations         the person's recent conversations
 *   GET  /v1/conversations/:id     one conversation's turns and waiting writes
 *   GET  /v1/settings              everyone: the assistant's name. Admins: everything on the settings page
 *   POST /v1/settings              admins: { name?, persona?, permissions?: { "brain.read": bool, … }, fast? }
 *   GET  /v1/tools                 admins: every tool with its mode (auto / confirm / off)
 *   GET  /v1/usage, /v1/traces     admins: tokens per day; where the last turns spent their time
 *   GET  /v1/health                no person needed: is it set up? Names what is missing, never a value
 */
const MAX_MESSAGE = 20_000;
const ID = /^[0-9a-f-]{36}$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/v1/health") {
      const missing = (["ALFRED_ANTHROPIC_API_KEY", "ALFRED_GATEWAY_KEY"] as const).filter((k) => !env[k]);
      return json({ status: missing.length ? "setup" : "ok", service: "alfred", model: env.ALFRED_MODEL || DEFAULT_MODEL, missing });
    }

    const h = householdFromVar(env.HOUSEHOLD);
    const person = personById(h, (req.headers.get("X-Alfred-Person") ?? "").trim());
    if (!person) return err("forbidden", "Not allowed.", 403);

    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("main"));

    if (req.method === "POST" && path === "/v1/chat") {
      let body: { conversation_id?: unknown; message?: unknown; skill?: unknown; decisions?: unknown };
      try { body = await req.json(); } catch { return err("bad_request", "Body must be JSON.", 400); }

      let id = typeof body.conversation_id === "string" ? body.conversation_id : "";
      if (id && !ID.test(id)) return err("bad_request", "Bad conversation_id.", 400);

      let input: TurnRequest["input"];
      if (typeof body.message === "string") {
        const text = body.message.trim();
        if (!text) return err("bad_request", "Empty message.", 400);
        if (text.length > MAX_MESSAGE) return err("bad_request", `Message is longer than ${MAX_MESSAGE} characters.`, 400);
        // skill: extra instructions for where the message was typed (prompt.ts SKILLS); an unknown name is ignored
        input = { kind: "message", text, ...(isSkill(body.skill) ? { skill: body.skill } : {}) };
        id ||= crypto.randomUUID();
      } else if (Array.isArray(body.decisions)) {
        if (!id) return err("bad_request", "Decisions need a conversation_id.", 400);
        const decisions = body.decisions
          .filter((d: any) => d && typeof d.id === "string" && typeof d.ok === "boolean")
          .map((d: any) => ({ id: String(d.id), ok: d.ok === true }));
        if (!decisions.length) return err("bad_request", "No valid decisions.", 400);
        input = { kind: "decisions", decisions };
      } else {
        return err("bad_request", "Send a message or decisions.", 400);
      }

      const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(id));
      const turn: TurnRequest = { conversation_id: id, owner: person.id, input };
      return stub.fetch("https://alfred/turn", { method: "POST", body: JSON.stringify(turn), headers: { "content-type": "application/json" } });
    }

    if (req.method === "GET" && path === "/v1/conversations") return json({ conversations: await registry.list(person.id) });

    const m = path.match(/^\/v1\/conversations\/([0-9a-f-]{36})$/);
    if (req.method === "GET" && m) {
      const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(m[1]));
      return stub.fetch(`https://alfred/history?owner=${encodeURIComponent(person.id)}`);
    }

    if (req.method === "GET" && path === "/v1/settings" && !person.admin) return json({ name: (await registry.settings()).name });

    // everything below manages the assistant: admins only
    if (!person.admin) return err("forbidden", "Only an admin can manage the assistant.", 403);

    if (path === "/v1/settings" && (req.method === "GET" || req.method === "POST")) {
      let settings;
      if (req.method === "POST") {
        let body: unknown;
        try { body = await req.json(); } catch { return err("bad_request", "Body must be JSON.", 400); }
        settings = await registry.saveSettings(body, person.id);
        console.log(`settings changed by ${person.id}`);
      } else settings = await registry.settings();
      // the services the gateway offers right now: one pair of check boxes each
      const pool = new McpPool(env, publicUrl(h), person);
      let services: { id: string; name: string }[] = [], down: string[] = [];
      try {
        const c = await pool.catalog();
        services = [...new Set(c.tools.map((t) => t.server))].map((id) => ({ id, name: serviceName(id) }));
        down = c.down;
      } catch { down = ["gateway"]; } finally { await pool.close(); }
      return json({
        ...settings, services, down, model: env.ALFRED_MODEL || DEFAULT_MODEL, effort: effortOf(env.ALFRED_EFFORT),
        usage: { today: await registry.spentToday(), limit: Number(env.ALFRED_DAILY_TOKEN_LIMIT) || null },
      });
    }

    if (req.method === "GET" && path === "/v1/tools") {
      forgetCatalog(); // this is where a change to the key's scopes is checked
      const pool = new McpPool(env, publicUrl(h), person);
      try {
        const { tools, down } = await pool.catalog();
        const overrides = parseOverrides(env.ALFRED_TOOL_POLICY);
        const settings = await registry.settings();
        return json({ down, tools: tools.map((t) => ({ name: qualified(t), server: t.server, mode: modeFor(t, overrides, settings), read_only: t.readOnly, description: t.description })) });
      } finally {
        await pool.close();
      }
    }

    if (req.method === "GET" && path === "/v1/usage") return json({ limit: Number(env.ALFRED_DAILY_TOKEN_LIMIT) || null, today: await registry.spentToday(), days: await registry.usage() });

    if (req.method === "GET" && path === "/v1/traces") return json({ traces: await registry.traces(Number(url.searchParams.get("limit")) || 30) });

    return err("not_found", "Not found.", 404);
  },
} satisfies ExportedHandler<Env>;
