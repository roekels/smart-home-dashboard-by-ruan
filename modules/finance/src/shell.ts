// What Finance adds to the shell Worker: its page, its API, the daily exchange-rate sync and its place on the
// Security page.
import { resourceName } from "../../../packages/core/src/household.ts";
import { localDate } from "../../../packages/core/src/ids.ts";
import type { ShellModule } from "../../../apps/shell/src/modules.ts";
import { financeRoute } from "./api.ts";
import { syncRates } from "./fx.ts";

export const financeModule: ShellModule = {
  id: "finance",
  pages: [{ path: "/dashboard/finance", label: "Finance", icon: "wallet", where: "metrics" }],
  api: { finance: (c) => financeRoute(c.req, c.url, c.env, c.household, c.person, c.write) },
  // once a day: the European Central Bank's reference rates for the currencies in use (public data)
  scheduled: async (env, h) => {
    if (env.FINANCE_DB) await syncRates(env.FINANCE_DB, localDate(h.timezone), h.currency);
  },
  security: (h) => ({
    nodes: [{
      id: "finance-db", zone: "cf", name: resourceName(h, "finance"), sub: "D1 · sealed", icon: "wallet", status: "ok",
      text: "Money records: accounts and their balances, holdings, property and cars, contracts, transactions and deadlines. Admins only.",
      guard: ["Every row is encrypted before it is stored; the database can read only which table a row is in, its date and when it changed",
        "The audit says who changed which row and which fields, never a value", "Nothing is deleted: a row is archived and can be brought back",
        "No full account or card numbers are stored: the last four digits at most"],
      keys: ["FINANCE_DATA_ENCRYPTION_KEY: without it the rows cannot be read"],
    }, {
      id: "ecb", zone: "out", name: "European Central Bank", sub: "exchange rates", icon: "globe", status: "ok",
      text: "Public daily reference rates, fetched once a day for the currencies in use. The request names a currency and a date, nothing else.",
    }],
    links: [
      { from: "shell", to: "finance-db", kind: "service", label: "the Finance page" },
      { from: "gateway", to: "finance-db", kind: "service", label: "/finance/mcp, through the dashboard Worker" },
      { from: "shell", to: "ecb", kind: "service", label: "daily rates" },
    ],
  }),
};
