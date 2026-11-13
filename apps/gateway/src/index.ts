// The MCP gateway Worker. Its routes (wrangler.jsonc) sit on the dashboard's own domain and win over the shell's
// custom domain for these paths:
//   /household/mcp, and /<module>/mcp for each module that is on     one MCP each (OAuth token or hmcp_ key)
//   /oauth/authorize (behind Cloudflare Access), /oauth/token, /oauth/register   the one OAuth server
//   /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource/<service>/mcp
//   /oauth/health                                                    which MCPs this household has
// No data of its own beyond connection state (D1: key hashes and the audit; KV: OAuth grants).
import { OAuthResourceServer, type OAuthAuthorizationServer, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { HouseholdError, householdFromVar, type Household } from "../../../packages/core/src/household.ts";
import type { Env, Principal } from "./env.ts";
import { AUTHORIZE_PATH, authorize, makeAuthServer } from "./oauth.ts";
import { KEY_SHAPE, principalFromKey } from "./keys.ts";
import { baseUrl, cutScopes, resourceOf, serviceForPath, serviceProblems, servicesFor, type Service } from "./services.ts";
import { serveMcp } from "./mcp.ts";
import { SERVERS } from "./servers.ts";
import { PAGE_HEADERS } from "./util.ts";

const VERSION = "0.1.0";

interface State {
  h: Household;
  base: string;
  services: Service[];
  as: OAuthAuthorizationServer<Env>;
  resources: Map<string, OAuthResourceServer<Env, Principal>>;
}

let state: { key: string; value: State } | undefined;

/** Everything derived from the household config, built once per isolate. */
function stateFor(env: Env): State {
  const key = `${env.HOUSEHOLD}\n${env.DEV_PUBLIC_URL ?? ""}`;
  if (state?.key === key) return state.value;
  const h = householdFromVar(env.HOUSEHOLD);
  const base = baseUrl(h, env.DEV_PUBLIC_URL);
  const services = servicesFor(h).filter((s) => s.id in SERVERS);
  const problems = serviceProblems(services);
  if (problems.length) throw new HouseholdError(problems);
  const value: State = { h, base, services, as: makeAuthServer(base, services), resources: new Map() };
  state = { key, value };
  return value;
}

/** One protected resource per MCP. Tokens from the shared OAuth server, or an hmcp_ API key. */
function resourceFor(st: State, s: Service): OAuthResourceServer<Env, Principal> {
  let r = st.resources.get(s.id);
  if (r) return r;
  r = new OAuthResourceServer<Env, Principal>({
    resourceMetadata: {
      resource: resourceOf(st.base, s),
      authorization_servers: [st.base],
      bearer_methods_supported: ["header"],
      resource_name: `${st.h.household}: ${s.title}`,
    },
    validateToken: (env) => async (resource, token) => {
      if (KEY_SHAPE.test(token)) {
        const p = await principalFromKey(env, token);
        return p ? { props: p, audience: resource, scope: p.scopes } : null;
      }
      return st.as.validateToken<Principal>(resource, token, env);
    },
    handler: {
      async fetch(req: Request, env: Env, ctx: OAuthResourceContext<Principal>) {
        const props = ctx.props;
        // The token's own scopes and the stored grant must both allow it, then only this service's scopes count.
        const granted = props.via === "key" ? props.scopes : props.scopes.filter((x) => ctx.auth.scope.includes(x));
        const principal: Principal = { actor: props.actor, via: props.via, user: props.user, scopes: cutScopes(granted, s, props.via) };
        return serveMcp(SERVERS[s.id]({ env, ctx, principal, h: st.h, service: s, services: st.services, base: st.base }), req);
      },
    },
  });
  st.resources.set(s.id, r);
  return r;
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(req.url).pathname;
  const st = stateFor(env);

  if (path === AUTHORIZE_PATH) return authorize(req, env, ctx, st);
  if (path === "/oauth/health") {
    return Response.json({ status: "ok", service: "gateway", version: VERSION, mcps: st.services.map((s) => s.path) }, { headers: { "cache-control": "no-store" } });
  }

  const svc = serviceForPath(st.services, path) ?? st.services.find((s) => path === `/.well-known/oauth-protected-resource${s.path}`);
  if (svc) return resourceFor(st, svc).fetch(req, env, ctx);

  if (path.startsWith("/oauth/") || path.startsWith("/.well-known/oauth-")) return st.as.fetch(req, env, ctx);
  return new Response("not found", { status: 404, headers: PAGE_HEADERS });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      console.error(e instanceof HouseholdError ? e.message : e);
      return Response.json({ error: e instanceof HouseholdError ? "the gateway is not set up: check the HOUSEHOLD var" : "internal error" }, { status: 500 });
    }
  },
  // Sweep expired OAuth grants and tokens.
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(stateFor(env).as.purgeExpiredData(env).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
