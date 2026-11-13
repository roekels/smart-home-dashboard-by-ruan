#!/usr/bin/env node
// The last step of the setup: prove the 7-day full-access token is gone.
//   node setup/handover.mjs
// Passes when the environment secret SETUP_CLOUDFLARE_FULL_TOKEN is no longer set, or when Cloudflare refuses it.
// Fails while the token still works. Changes nothing.
import { fileURLToPath } from "node:url";
import { CloudflareError, TOKEN_ENV, client } from "./lib/cloudflare.mjs";
import { run } from "./lib/io.mjs";

/** { gone, text }. `token` and `fetch` can be passed in for tests. */
export async function handover({ token = process.env[TOKEN_ENV], fetch: f } = {}) {
  if (!token) return { gone: true, text: `${TOKEN_ENV} is no longer in this environment. Ask the person to confirm they also deleted the token in Cloudflare (My Profile, API Tokens).` };
  try {
    const status = (await client({ token, fetch: f }).get("/user/tokens/verify")).result?.status;
    if (status !== "active") return { gone: true, text: `Cloudflare reports the token as ${status ?? "not active"}. Ask the person to remove ${TOKEN_ENV} from this environment too.` };
    return { gone: false, text: `The full-access token still works. Ask the person to delete it in Cloudflare (My Profile, API Tokens) and to remove the environment secret ${TOKEN_ENV}, then run this again.` };
  } catch (e) {
    if (e instanceof CloudflareError && (e.status === 401 || e.status === 403 || e.status === 400)) {
      return { gone: true, text: `Cloudflare refuses the token. Ask the person to remove ${TOKEN_ENV} from this environment too.` };
    }
    throw e;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(async () => {
    const r = await handover();
    console.log(r.text);
    if (!r.gone) throw new Error("Do not finish the setup while the full-access token works.");
  });
}
