// A small Cloudflare API client for the setup scripts. No dependencies.
// Reads go out as they are. Writes go out only when `dryRun` is false; in a dry run they are recorded and answered
// with a placeholder, so a plan can be shown without changing anything.
// The token is read from the environment and never printed.
export const TOKEN_ENV = "SETUP_CLOUDFLARE_FULL_TOKEN";
const API = "https://api.cloudflare.com/client/v4";

export class CloudflareError extends Error {
  constructor(method, path, status, errors) {
    super(`Cloudflare ${method} ${path} failed (${status}): ${errors.map((e) => e.message ?? String(e)).join("; ") || "no detail"}`);
    this.status = status;
    this.errors = errors;
  }
}

export function client({ token = process.env[TOKEN_ENV], dryRun = false, fetch: f = fetch } = {}) {
  if (!token) throw new Error(`${TOKEN_ENV} is not set. Store the 7-day Cloudflare token as an environment secret with that name; never paste it into chat.`);
  const writes = [];
  async function call(method, path, body) {
    const isWrite = method !== "GET";
    if (isWrite) {
      writes.push({ method, path, body });
      if (dryRun) return { result: { id: "dry-run", uuid: "dry-run", aud: "dry-run" }, dryRun: true };
    }
    const res = await f(API + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || data?.success === false) throw new CloudflareError(method, path, res.status, data?.errors ?? []);
    return data ?? {};
  }
  /** Every page of a list endpoint. */
  async function list(path) {
    const out = [];
    for (let page = 1; page <= 50; page++) {
      const data = await call("GET", `${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=50`);
      const items = Array.isArray(data.result) ? data.result : data.result?.buckets ?? [];
      out.push(...items);
      const info = data.result_info;
      if (!info || !info.total_pages || page >= info.total_pages || !items.length) break;
    }
    return out;
  }
  return {
    dryRun,
    writes,
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    put: (path, body) => call("PUT", path, body),
    del: (path) => call("DELETE", path),
    list,
  };
}
