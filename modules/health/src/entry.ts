// The Health entrypoint: the gateway's /health/mcp reaches the health records over a service binding
// (binding HEALTH -> <prefix>-shell, entrypoint Health). All the rules are in service.ts; this file only exists
// because an entrypoint must extend WorkerEntrypoint, which plain Node (tests, the demo server) cannot import.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { HealthAddInput, HealthApi, HealthListQuery, HealthPrincipal, HealthUpdateInput } from "./contract.ts";
import { type HealthServiceEnv, healthService } from "./service.ts";

export class Health extends WorkerEntrypoint<HealthServiceEnv> implements HealthApi {
  private get s() { return healthService(this.env); }
  version() { return this.s.version(); }
  schema(p: HealthPrincipal) { return this.s.schema(p); }
  overview(p: HealthPrincipal, person?: string) { return this.s.overview(p, person); }
  list(p: HealthPrincipal, q: HealthListQuery) { return this.s.list(p, q); }
  get(p: HealthPrincipal, id: string, person?: string) { return this.s.get(p, id, person); }
  trends(p: HealthPrincipal, person: string, name?: string) { return this.s.trends(p, person, name); }
  add(p: HealthPrincipal, input: HealthAddInput) { return this.s.add(p, input); }
  update(p: HealthPrincipal, id: string, input: HealthUpdateInput, person?: string) { return this.s.update(p, id, input, person); }
  archive(p: HealthPrincipal, id: string, archived: boolean, person?: string) { return this.s.archive(p, id, archived, person); }
}
