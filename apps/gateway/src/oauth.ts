// One OAuth server for every MCP on the host. Tokens are bound to one MCP (RFC 8707 resource), the consent page
// offers only that MCP's scopes, and it sits behind Cloudflare Access, verified again here.
import { AuthorizationError, CimdFetchError, OAuthAuthorizationServer } from "@cloudflare/workers-oauth-provider";
import { accessEmail } from "../../../packages/core/src/access.ts";
import { personByEmail, type Household, type Person } from "../../../packages/core/src/household.ts";
import { esc } from "../../../packages/core/src/util.ts";
import type { Env, Principal } from "./env.ts";
import { oauthScopes, resourceOf, serviceForResource, type Service } from "./services.ts";
import { audit } from "./util.ts";
import { allowedRedirect } from "./clients.ts";
import { consentBody, page } from "./consent.ts";

export const AUTHORIZE_PATH = "/oauth/authorize";

export function makeAuthServer(base: string, services: Service[]): OAuthAuthorizationServer<Env> {
  return new OAuthAuthorizationServer<Env>({
    issuer: base,
    resources: services.map((s) => resourceOf(base, s)),
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: oauthScopes(services),
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    refreshTokenTTL: 90 * 86400,
    refreshTokenIdleTTL: 90 * 86400,
    clientRegistrationCallback: ({ clientMetadata }) => {
      const uris = Array.isArray(clientMetadata.redirect_uris) ? (clientMetadata.redirect_uris as string[]) : [];
      return uris.length > 0 && uris.every(allowedRedirect)
        ? undefined
        : { code: "invalid_redirect_uri", description: "This server only accepts the AI apps on its list (src/clients.ts).", status: 400 };
    },
  });
}

/**
 * The household member signed in through Cloudflare Access, verified here as well (never trust the header alone):
 * signature, issuer, one of our app AUDs, and an email that belongs to a person in the household config.
 */
export async function signedIn(req: Request, env: Env, h: Household): Promise<Person | null> {
  const auds = (env.ACCESS_AUD ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const email = env.DEV_EMAIL
    ? env.DEV_EMAIL.toLowerCase()
    : await accessEmail(req.headers.get("Cf-Access-Jwt-Assertion"), { team: env.ACCESS_TEAM ?? "", aud: auds });
  return email ? personByEmail(h, email) : null;
}

export interface AuthorizeDeps { h: Household; base: string; services: Service[]; as: OAuthAuthorizationServer<Env> }

export async function authorize(req: Request, env: Env, ctx: ExecutionContext, d: AuthorizeDeps): Promise<Response> {
  const person = await signedIn(req, env, d.h);
  if (!person) return page("Not allowed", "<h1>Not allowed</h1><p>Sign in to the dashboard first, as a person of this household.</p>", 403);
  const oauth = d.as.getOAuthApi(env);
  const serviceOf = (resource: string | undefined) => serviceForResource(d.services, d.base, resource);

  try {
    if (req.method === "GET") {
      const request = await oauth.parseAuthRequest(req);
      const service = serviceOf(request.resource);
      if (!service) return page("Unknown service", "<h1>Unknown service</h1><p>This connection doesn't name one of the MCPs on this host.</p>", 400);
      if (!allowedRedirect(request.redirectUri)) return page("Not allowed", "<h1>This app is not on the list of apps that may connect</h1>", 400);
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      return page(`Connect ${service.title}`, consentBody({
        service, signedInAs: person.name, clientName: details.clientName, clientDomain: details.clientDomain ?? undefined,
        redirectHost: details.redirectHost, redirectIsLoopback: details.redirectIsLoopback, asked: request.scope, handle: consent.handle,
      }), 200, consent.headers);
    }

    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const form = await req.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(req, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    // Only scopes a person can grant; key-only scopes are never in that list.
    const grantable = oauthScopes(d.services);
    const picked = form.getAll("scope").map(String);
    const approved = await oauth.approveConsent(req, handle, { scope: picked.filter((x) => grantable.includes(x)) });
    const service = serviceOf(approved.request.resource);
    if (!service) return page("Unknown service", "<h1>Unknown service</h1>", 400);
    const scopes = approved.request.scope.filter((x) => x in service.scopes);
    if (!scopes.length) return page("Nothing allowed", "<h1>No permissions chosen</h1><p>Start the connection again.</p>", 400);
    const client = (await oauth.lookupClient(approved.request.clientId))?.clientName ?? approved.request.clientId;
    const props: Principal = { actor: `oauth:${client}`, via: "oauth", scopes, user: person.email };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request, userId: person.email, metadata: { client, service: service.id }, scope: scopes, props,
    });
    void audit(env, ctx, { service: service.id, actor: person.id, via: "access", tool: "connect", target: client, ok: true, detail: scopes.join(" ") });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError) return page("Can't connect", `<h1>Can't connect</h1><p>${esc(e.description ?? e.message)}</p><p>Start the connection again from the app.</p>`, 400);
    if (e instanceof CimdFetchError) return page("Can't connect", "<h1>This app could not be verified</h1>", 400);
    throw e;
  }
}
