import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/** Stateless MCP over Streamable HTTP: a fresh server per request, JSON responses. */
export async function serveMcp(server: McpServer, request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const text = (out: unknown) => ({ content: [{ type: "text" as const, text: typeof out === "string" ? out : JSON.stringify(out, null, 1) }] });
export const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });
