import type { Conversation } from "./conversation.ts";
import type { Registry } from "./registry.ts";

export interface Env {
  /** Secret: the household's own Claude API key. Usage is billed by Anthropic to that account. */
  ALFRED_ANTHROPIC_API_KEY: string;
  /** Secret: the assistant's own key for the MCP gateway (hmcp_alfred_…). Its scopes are the hard limit. */
  ALFRED_GATEWAY_KEY: string;
  /** Service binding to <prefix>-gateway. Every tool comes through it; nothing goes over the public internet. */
  GATEWAY: Fetcher;
  CONVERSATIONS: DurableObjectNamespace<Conversation>;
  REGISTRY: DurableObjectNamespace<Registry>;
  /** Var: household.config.json as JSON text (setup/wrangler-config.mjs writes it). */
  HOUSEHOLD: string;
  /** Var: the Claude model. Default claude-opus-5-5. */
  ALFRED_MODEL?: string;
  /** Var: low | medium | high | xhigh | max. Default low: a house assistant should answer in a second or two. */
  ALFRED_EFFORT?: string;
  /** Var: tokens per UTC day before the assistant stops answering. Empty or 0 = no limit. */
  ALFRED_DAILY_TOKEN_LIMIT?: string;
  /** Var: per-tool overrides as JSON, e.g. {"calendar__add_event": "auto", "brain__edit": "off"}. */
  ALFRED_TOOL_POLICY?: string;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/** Errors in the shape the dashboard's own API uses: { error: "plain words" }, plus a code for the chat page. */
export const err = (code: string, message: string, status: number): Response => json({ error: message, code }, status);
