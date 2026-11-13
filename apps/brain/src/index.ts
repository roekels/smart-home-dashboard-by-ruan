// Worker <prefix>-brain: the household's notes. No hostname; reachable only over service bindings.
//   Brain    the gateway serves /brain/mcp through it (apps/gateway/src/tools/brain.ts)
//   BrainUi  the dashboard's Brain page
// All the rules are in service.ts and store.ts; this file only exists because an entrypoint must extend
// WorkerEntrypoint.
import { WorkerEntrypoint } from "cloudflare:workers";
import { BRAIN_CONTRACT, BRAIN_UI_CONTRACT, type BrainApi, type BrainPrincipal, type BrainTool, type BrainUiApi, type BrainUiRequest } from "./contract.ts";
import { type BrainEnv, brainService, brainUi } from "./service.ts";

export class Brain extends WorkerEntrypoint<BrainEnv> implements BrainApi {
  private get s() { return brainService(this.env, (p) => this.ctx.waitUntil(p)); }
  version() { return this.s.version(); }
  roots() { return this.s.roots(); }
  call(p: BrainPrincipal, tool: BrainTool, args: Record<string, unknown>) { return this.s.call(p, tool, args); }
}

export class BrainUi extends WorkerEntrypoint<BrainEnv> implements BrainUiApi {
  private get s() { return brainUi(this.env, (p) => this.ctx.waitUntil(p)); }
  version() { return this.s.version(); }
  api(personId: string, req: BrainUiRequest) { return this.s.api(personId, req); }
  exportAll(personId: string) { return this.s.exportAll(personId); }
}

export default {
  async fetch(req: Request): Promise<Response> {
    // No public route. A direct fetch over a binding only gets the health line.
    if (new URL(req.url).pathname === "/health") return Response.json({ status: "ok", service: "brain", contracts: [BRAIN_CONTRACT, BRAIN_UI_CONTRACT] });
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<BrainEnv>;
