import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Person } from "../../../packages/core/src/household.ts";
import type { ToolInfo } from "./policy.ts";
import { ADMIN_ONLY, PERSONAL } from "./scope.ts";

/** A gateway service: brain, calendar, home, finance, health … */
export type Server = string;

export interface McpTool extends ToolInfo {
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Catalog {
  tools: McpTool[];
  /** Services that could not be listed this turn. */
  down: Server[];
}

/** What the pool needs from the Worker's environment. */
export interface GatewayEnv {
  GATEWAY: Fetcher;
  ALFRED_GATEWAY_KEY: string;
}

/** How long a tool list is reused. Listing costs two round trips per service before Claude is even called. */
const CATALOG_TTL_MS = 5 * 60_000;
let cached: { key: string; at: number; catalog: Catalog } | null = null;
/** For tests, and for the settings page after the key's scopes change. */
export function forgetCatalog(): void { cached = null; }

/** Longest tool result handed to the model. Longer results are cut, and the model is told so. */
export const MAX_RESULT_CHARS = 60_000;

/** The core MCP only says who lives here and which modules are on; the system prompt already does. */
const SKIP = new Set(["household"]);

const OTHER_PERSON_REQUEST = {
  type: "string",
  description: "Only when this touches the records of ANOTHER person (not the speaker, not shared): the speaker's own words that ask for it, quoted exactly from their message. It is shown on the approval card.",
};

/** Personal services get one extra input the model fills in when a call is for someone else (scope.ts). It never
 *  reaches the MCP: call() takes it out again. */
function withOtherPersonRequest(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties && typeof schema.properties === "object" ? schema.properties : {}) as Record<string, unknown>;
  return { ...schema, type: "object", properties: { ...props, other_person_request: OTHER_PERSON_REQUEST } };
}

/**
 * MCP over the gateway's service binding: the request never leaves Cloudflare, the key never leaves this Worker.
 * One key for every service; the gateway keeps only the scopes of the MCP being called. One connection per
 * service, opened on first use and reused for the rest of a turn.
 */
export class McpPool {
  private clients = new Map<Server, Promise<Client>>();
  private env: GatewayEnv;
  private base: string;
  private person: Person;

  /** `base`: the household's public address (https://<domain>), so the gateway's resource checks match.
   *  `person`: who the assistant is talking to, as the dashboard verified them. */
  constructor(env: GatewayEnv, base: string, person: Person) {
    this.env = env;
    this.base = base;
    this.person = person;
  }

  private gateway(path: string, init?: RequestInit): Promise<Response> {
    return this.env.GATEWAY.fetch(new Request(new URL(path, this.base), init));
  }

  private client(server: Server): Promise<Client> {
    let c = this.clients.get(server);
    if (!c) {
      if (!this.env.ALFRED_GATEWAY_KEY) throw new Error("the gateway key is not set (secret ALFRED_GATEWAY_KEY)");
      const transport = new StreamableHTTPClientTransport(new URL(`/${server}/mcp`, this.base), {
        requestInit: { headers: { Authorization: `Bearer ${this.env.ALFRED_GATEWAY_KEY}` } },
        fetch: (input, init) => this.env.GATEWAY.fetch(new Request(input, init)),
      });
      const client = new Client({ name: "alfred", version: "0.1.0" });
      c = client.connect(transport).then(() => client);
      c.catch(() => this.clients.delete(server));
      this.clients.set(server, c);
    }
    return c;
  }

  /** The MCPs this household has, as the gateway reports them: /brain/mcp -> "brain". Whatever modules are on. */
  private async services(): Promise<Server[]> {
    const res = await this.gateway("/oauth/health");
    if (!res.ok) throw new Error(`gateway health: HTTP ${res.status}`);
    const body = (await res.json()) as { mcps?: unknown };
    const paths = Array.isArray(body.mcps) ? body.mcps : [];
    return [...new Set(paths.map((p) => /^\/([a-z][a-z0-9-]{0,30})\/mcp$/.exec(String(p))?.[1]).filter((s): s is string => !!s && !SKIP.has(s)))].sort();
  }

  /**
   * Every tool this person may be offered. Services are asked side by side but listed in a fixed order, so the tool
   * list sent to Claude is byte-identical between requests and the prompt cache holds. A complete list is reused
   * for a few minutes. The servers' own instructions are not used (prompt.ts says what is needed, without dates).
   */
  async catalog(): Promise<Catalog> {
    const all = await this.everything();
    return this.person.admin ? all : { tools: all.tools.filter((t) => !ADMIN_ONLY.has(t.server)), down: all.down };
  }

  private async everything(): Promise<Catalog> {
    if (cached && cached.key === this.base && Date.now() - cached.at < CATALOG_TTL_MS) return cached.catalog;
    let list: Server[];
    try {
      list = await this.services();
    } catch (e) {
      console.error("gateway: could not list the MCPs", e);
      return { tools: [], down: ["gateway"] };
    }
    const out: Catalog = { tools: [], down: [] };
    const listed = await Promise.all(list.map(async (server) => {
      try {
        const c = await this.client(server);
        const { tools } = await c.listTools();
        return [...tools].sort((a, b) => a.name.localeCompare(b.name)).map((t): McpTool => ({
          server,
          name: t.name,
          description: t.description ?? "",
          inputSchema: PERSONAL.has(server) ? withOtherPersonRequest(t.inputSchema as Record<string, unknown>) : (t.inputSchema as Record<string, unknown>),
          readOnly: t.annotations?.readOnlyHint === true,
          destructive: t.annotations?.destructiveHint === true,
        }));
      } catch (e) {
        // One service being down shouldn't take the assistant down; the model is told in the system prompt.
        console.error(`mcp ${server}: listing failed`, e);
        return null;
      }
    }));
    listed.forEach((tools, i) => { if (tools) out.tools.push(...tools); else out.down.push(list[i]); });
    if (!out.down.length) cached = { key: this.base, at: Date.now(), catalog: out };
    return out;
  }

  async call(server: Server, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    if (ADMIN_ONLY.has(server) && !this.person.admin) return { text: `${server} is only open to the household's admins.`, isError: true };
    const { other_person_request: _quote, ...rest } = args;
    const c = await this.client(server);
    const res = await c.callTool({ name, arguments: PERSONAL.has(server) ? rest : args });
    const parts = (res.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    let text = parts.map((p) => (p.type === "text" ? p.text ?? "" : `[${p.type} content omitted]`)).join("\n");
    if (text.length > MAX_RESULT_CHARS) {
      text = `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Result cut at ${MAX_RESULT_CHARS} characters of ${text.length}. Narrow the request to see the rest.]`;
    }
    return { text, isError: res.isError === true };
  }

  async close(): Promise<void> {
    for (const c of this.clients.values()) await c.then((x) => x.close()).catch(() => {});
    this.clients.clear();
  }
}
