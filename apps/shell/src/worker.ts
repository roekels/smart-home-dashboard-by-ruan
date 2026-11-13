// The Worker's main module (wrangler "main"): the dashboard itself plus the named entrypoints other Workers bind to.
// index.ts stays importable in plain Node (tests, the demo server); the entrypoints need "cloudflare:workers",
// which only exists in the Workers runtime, so they are exported from here and nowhere else.
export { default } from "./index.ts";
export { Health } from "../../../modules/health/src/entry.ts";
export { Finance } from "../../../modules/finance/src/entry.ts";
export { Home, Devices } from "./entrypoints.ts";
