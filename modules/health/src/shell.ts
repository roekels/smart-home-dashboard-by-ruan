// What Health adds to the shell Worker: its page, its API and its place on the Security page.
import { resourceName } from "../../../packages/core/src/household.ts";
import type { ShellModule } from "../../../apps/shell/src/modules.ts";
import { healthRoute } from "./api.ts";

export const healthModule: ShellModule = {
  id: "health",
  // under Metrics, but open to everyone: each person sees their own records, an admin everyone's (api.ts)
  pages: [{ path: "/dashboard/health", label: "Health", icon: "activity", where: "metrics", admin: false }],
  api: { health: (c) => healthRoute(c.req, c.url, c.env, c.household, c.person, c.write) },
  security: (h) => ({
    nodes: [{
      id: "health-db", zone: "cf", name: resourceName(h, "health"), sub: "D1 · sealed", icon: "activity", status: "ok",
      text: "Health records: doctor visits, test results, vaccinations and medication. Each person sees their own, an admin everyone's.",
      guard: ["Every record is encrypted before it is stored; only whose it is, its type and its date are readable in the database",
        "Nothing from a record is ever written to a log or an audit row", "Nothing is deleted: a record is archived, and every change keeps the earlier version"],
      keys: ["HEALTH_DATA_ENCRYPTION_KEY: without it the records cannot be read"],
    }],
    links: [
      { from: "shell", to: "health-db", kind: "service", label: "the Health page" },
      { from: "gateway", to: "health-db", kind: "service", label: "/health/mcp, through the dashboard Worker" },
    ],
  }),
};
