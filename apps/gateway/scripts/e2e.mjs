// End-to-end test of the gateway in wrangler dev: discovery, an API key, the whole OAuth flow, the audit.
// Local only, example data only. Not part of `npm test`: it starts a local Worker.
// Usage (from apps/gateway): npm run test:e2e
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";

const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const persist = ".wrangler/e2e";
// The D1 name comes from the rendered config (the household's resource prefix).
const DB = /"database_name": "([^"]+)"/.exec(readFileSync("wrangler.jsonc", "utf8"))[1];
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const b64u = (b) => Buffer.from(b).toString("base64url");
const wrangler = (...a) => execFileSync("npx", ["wrangler", ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();

// ---------- local D1 with test keys ----------
rmSync(persist, { recursive: true, force: true });
wrangler("d1", "migrations", "apply", DB, "--local", "--persist-to", persist);
const key = (name) => `hmcp_${name}_${randomBytes(30).toString("base64url")}`;
const K = { read: key("e2e-read"), other: key("e2e-other"), gone: key("e2e-revoked") };
const rows = [
  ["e2e-read", K.read, ["household.read", "brain.read"], null],
  ["e2e-other", K.other, ["brain.read"], null], // a real key, but nothing for /household/mcp
  ["e2e-revoked", K.gone, ["household.read"], "2026-01-01"],
];
const sql = rows.map(([n, k, s, r]) => `INSERT INTO api_keys (name, sha256, scopes, created, revoked_at) VALUES ('${n}', '${sha(k)}', '${JSON.stringify(s)}', datetime('now'), ${r ? `'${r}'` : "NULL"});`).join(" ");
wrangler("d1", "execute", DB, "--local", "--persist-to", persist, "--command", sql);

// ---------- start the Worker ----------
const dev = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--local-upstream", `localhost:${PORT}`, "--persist-to", persist,
  "--var", `DEV_PUBLIC_URL:${BASE}`, "--var", "DEV_EMAIL:alex@example.com"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
let log = "";
dev.stdout.on("data", (d) => (log += d));
dev.stderr.on("data", (d) => (log += d));
// npx -> wrangler -> workerd: stop the whole process group, or the next run talks to a stale server.
const stop = () => { try { process.kill(-dev.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);

try { await fetch(`${BASE}/oauth/health`); console.error(`port ${PORT} is already in use: stop the other wrangler dev first`); process.exit(2); } catch {}
for (let i = 0; i < 120; i++) {
  try { const r = await fetch(`${BASE}/oauth/health`); if (r.status) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

let id = 0;
async function rpc(path, token, method, params = {}) {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, headers: r.headers, json: j, text: t };
}
async function call(path, token, name, args = {}) {
  const r = await rpc(path, token, "tools/call", { name, arguments: args });
  const text = r.json?.result?.content?.[0]?.text ?? r.text;
  let json = null; try { json = JSON.parse(text); } catch {}
  return { err: !!r.json?.result?.isError, text, json, status: r.status };
}

try {
  // ---------- discovery ----------
  let r = await fetch(`${BASE}/oauth/health`);
  let j = await r.json();
  check("health lists the household MCP", r.status === 200 && j.mcps.includes("/household/mcp"), j.mcps.join(" "));

  j = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check("AS metadata: issuer, endpoints, scopes", j.issuer === BASE && j.authorization_endpoint === `${BASE}/oauth/authorize` && j.scopes_supported?.includes("household.read"), (j.scopes_supported ?? []).join(" "));
  j = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/household/mcp`)).json();
  check("resource metadata for /household/mcp", j.resource === `${BASE}/household/mcp` && j.authorization_servers?.[0] === BASE);

  r = await rpc("/household/mcp", null, "tools/list");
  check("no token -> 401 pointing at the resource metadata", r.status === 401 && (r.headers.get("www-authenticate") ?? "").includes("/.well-known/oauth-protected-resource/household/mcp"));
  r = await rpc("/household/mcp", K.gone, "tools/list");
  check("revoked key -> 401", r.status === 401);
  r = await rpc("/household/mcp", "hmcp_nobody_" + "x".repeat(40), "tools/list");
  check("unknown key -> 401", r.status === 401);
  r = await fetch(`${BASE}/brain/mcp`, { method: "POST" });
  check("an MCP that is not built -> 404", r.status === 404);

  // ---------- API key ----------
  r = await rpc("/household/mcp", K.read, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  check("initialize", r.json?.result?.serverInfo?.name === "household", r.json?.result?.instructions?.slice(0, 60));
  let c = await call("/household/mcp", K.read, "household_info");
  check("household_info: first names and MCP addresses, no emails", !c.err && c.json?.people?.[0]?.name === "Alex" && c.json?.mcps?.[0]?.url === `${BASE}/household/mcp` && !c.text.includes("@"), c.text.replace(/\s+/g, " ").slice(0, 120));
  c = await call("/household/mcp", K.other, "household_info");
  check("a key without household.read is refused by the tool", c.err, c.text);

  // ---------- OAuth ----------
  const reg = (body) => fetch(`${BASE}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  r = await reg({ client_name: "Elsewhere", redirect_uris: ["https://elsewhere.example/cb"], token_endpoint_auth_method: "none" });
  check("register: a redirect off the list is refused", r.status === 400);
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  r = await reg({ client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
  const client = await r.json();
  check("register: an app on the list", r.status === 201 && !!client.client_id);

  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource: `${BASE}/household/mcp`, scope: "household.read" });
  r = await fetch(`${BASE}/oauth/authorize?${q}`);
  const html = await r.text();
  const cookie = (r.headers.getSetCookie?.() ?? []).map((x) => x.split(";")[0]).join("; ");
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  check("consent page: this MCP's scopes, first name, no email", r.status === 200 && /value="household\.read" checked/.test(html) && html.includes("Signed in as Alex") && !html.includes("@example.com"), `handle ${handle ? "ok" : "missing"}`);
  check("consent page: no script, no framing", (r.headers.get("content-security-policy") ?? "").includes("default-src 'none'") && r.headers.get("x-frame-options") === "DENY");

  const form = new URLSearchParams({ handle, decision: "approve" });
  for (const s of ["household.read", "brain.admin", "finance.write"]) form.append("scope", s); // tries to sneak in scopes that are not offered
  r = await fetch(`${BASE}/oauth/authorize`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });
  const loc = new URL(r.headers.get("location") ?? "about:blank");
  check("approve -> redirect with code", r.status === 302 && loc.origin + loc.pathname === redirect && !!loc.searchParams.get("code"), `${r.status} ${loc.origin}`);

  r = await fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code") ?? "", redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/household/mcp` }) });
  const tok = await r.json();
  check("token carries only the offered scope", r.status === 200 && !!tok.access_token && tok.scope === "household.read", tok.scope);
  c = await call("/household/mcp", tok.access_token, "household_info");
  check("the OAuth token works on /household/mcp", !c.err && c.json?.household === "Example family", c.text.slice(0, 60));

  // ---------- audit ----------
  const out = wrangler("d1", "execute", DB, "--local", "--persist-to", persist, "--json", "--command", "SELECT service, actor, via, tool, ok FROM audit ORDER BY id");
  const audit = JSON.parse(out)[0].results;
  const has = (tool, via, ok) => audit.some((a) => a.service === "household" && a.tool === tool && a.via === via && a.ok === ok);
  check("audit: calls, the refusal and the connection are logged, without emails", has("household_info", "key", 1) && has("household_info", "key", 0) && has("household_info", "oauth", 1) && has("connect", "access", 1) && !JSON.stringify(audit).includes("@"), `${audit.length} rows`);
} catch (e) {
  failed++;
  console.error(e);
  console.error(log.slice(-3000));
} finally {
  stop();
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
