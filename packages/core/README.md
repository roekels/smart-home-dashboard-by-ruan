# Core

Code every Worker shares. No dependencies, no Worker-only globals: it runs in Workers and in `node --test`.

| File | What |
|---|---|
| `src/household.ts` | the household config: parse, check, look people up. The only place that knows its shape |
| `src/access.ts` | verifies a Cloudflare Access token (signature, issuer, audience, expiry) with WebCrypto |
| `src/util.ts` | base64url, SHA-256, security headers, JSON responses, `HttpError` |

Tests are in `test/`. Workers import these by relative path (`../../../packages/core/src/household.ts`); the bundler includes them.
