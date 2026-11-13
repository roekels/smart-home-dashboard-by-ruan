# setup/

The scripts an AI runs to set a household up, and the checks that keep this repository safe. The step-by-step guide
is [AGENTS.md](../AGENTS.md). These scripts were written against Cloudflare's documented API and tested against a
stand-in; **they have not yet been run against a live account**, so always start with `--dry-run`.

| Script | What it does | Changes anything? |
|---|---|---|
| `feasibility.mjs` | token, domain, Zero Trust, config, name clashes | no |
| `provision.mjs --dry-run` | prints the plan and every change it would make | no |
| `provision.mjs` | creates stores and Access applications, writes `resources.json` and the wrangler configs; reuses what exists | yes |
| `deploy.mjs` | first deploy of the Workers with the setup token | yes |
| `secrets.mjs --dry-run` / `secrets.mjs` | makes the machine-made secrets (service tokens, gateway keys) and sets them on the Workers without printing them; lists what the person and the key page still owe | yes |
| `keys.mjs open` / `keys.mjs close` | opens the one-time key page with a token that can only edit Worker secrets (24 hours), and removes it again; never sees a key | yes |
| `verify.mjs` | checks the live dashboard from outside, with no credentials | no |
| `handover.mjs` | passes only when the full setup token no longer works | no |
| `teardown.mjs --dry-run` / `--confirm "<household>"` | removes what the setup created, data included | yes |
| `wrangler-config.mjs` | renders every `apps/*/wrangler.jsonc` from the config, `resources.json` and the module files | writes files |
| `check-manifest.mjs`, `scrub-check.mjs` | `npm run check` | no |

The setup token is read from the environment secret `SETUP_CLOUDFLARE_FULL_TOKEN` and is never printed.

## Encryption keys and the key page

A secret marked `key-page` in `secrets.manifest.json` is made in the admin's browser on `/setup/keys`
(`apps/shell/src/setup-keys.ts`, `apps/shell/web/src/pages/setup-keys.ts`), shown once, and stored by the dashboard
Worker on the Worker named in the module file's `secrets` list. Formats, fixed for every module:

- a name ending in `_KEY`: 32 random bytes as standard base64 (44 characters);
- a name ending in `_PASSPHRASE`: five groups of five letters and digits joined by dashes.

A key that is already set is never replaced, and the page locks itself once every key is stored.

## Module files: `setup/modules/<module>.json`

One file per module says what the module needs. Provisioning, the wrangler configs, verification and teardown are
all driven by these files, so a module is installed only when its file exists **and** it is switched on in
`household.config.json` (`core.json` is always on). Names are short; the household's prefix is added for you
(`brain` becomes `home-brain`).

```jsonc
{
  "module": "brain",                       // "core" or an id from MODULE_IDS in packages/core/src/household.ts

  // Stores this module owns. Short names, unique across all modules.
  "d1": [{ "name": "brain" }],
  "kv": [],
  "r2": [{ "name": "brain-files" }],

  // Workers of its own (code in apps/<app>). Leave out when the module only adds to the shell.
  "workers": [{
    "app": "brain",                        // folder under apps/, also the Worker's short name
    "main": "src/index.ts",                // optional entry file; this is the default
    "compatibilityFlags": ["nodejs_compat"],
    "d1": [{ "binding": "DB", "store": "brain", "migrations": "migrations" }],
    "kv": [],
    "r2": [{ "binding": "FILES", "store": "brain-files" }],
    "durableObjects": [{ "binding": "PULSE", "className": "Pulse" }],   // SQLite-backed, migration tag "v1"
    "services": [{ "binding": "GATEWAY", "app": "gateway", "entrypoint": "Optional" }],
    "vars": { "SOME_SETTING": "value" },   // never a secret, never personal data
    "crons": ["0 3 * * *"],
    "build": "npm run build"               // optional build command
  }],

  // What the module adds to the shell and gateway Workers when it is on. Same keys as a Worker entry.
  "shell":   { "d1": [], "r2": [], "services": [{ "binding": "BRAIN", "app": "brain", "entrypoint": "BrainUi" }], "vars": {}, "crons": [] },
  "gateway": { "services": [{ "binding": "BRAIN", "app": "brain", "entrypoint": "BrainMcp" }] },

  // Secrets the module reads, by their name in secrets.manifest.json, and the Worker (app) each is set on.
  "secrets": [{ "name": "BRAIN_SENSITIVE_ENCRYPTION_KEY", "app": "brain" }],

  // Gateway API keys the setup makes for the module: only the hash is stored; the value goes into the named secret.
  // "{person}" in a scope is filled in for every person of the household: "cal.{person}.read" gives one scope each.
  "gatewayKeys": [{ "name": "alfred", "scopes": ["household.read"], "secret": "ALFRED_GATEWAY_KEY", "app": "alfred" }],

  // Extra hostnames next to the dashboard's own. The host is <label>.<parent of the dashboard's domain>
  // (dashboard home.example.com, label "kiosk" -> kiosk.example.com) unless household.config.json sets hosts.<key>.
  //   use "customDomain": a second custom domain of a Worker (no Access application; the Worker guards it itself)
  //   use "tunnel": a Cloudflared tunnel hostname the person sets up at home, behind a service-token-only Access app
  // "var" hands the host to a Worker as a var; "asUrl" writes it as https://<host>.
  "hosts": [
    { "key": "kiosk", "label": "kiosk", "use": "customDomain", "app": "shell", "var": { "app": "shell", "name": "KIOSK_HOST" } },
    { "key": "homeAssistant", "label": "ha", "use": "tunnel", "var": { "app": "shell", "name": "HA_URL", "asUrl": true } }
  ],

  // Cloudflare Access service tokens the setup creates once. The two halves go into the named secrets on that app.
  // "for" is a host key above or a path listed in serviceAuthPaths. Tokens made later, one per machine (edge
  // agents), are not listed here: the dashboard's own enrol flow makes those.
  "serviceTokens": [{ "name": "ha-tunnel", "for": "host:homeAssistant", "app": "shell", "idSecret": "HA_TUNNEL_SERVICE_TOKEN_ID", "keySecret": "HA_TUNNEL_SERVICE_TOKEN_KEY" }],

  // Paths on the dashboard's domain that programs call. publicPaths get no sign-in page (the Worker checks tokens
  // itself); serviceAuthPaths need a Cloudflare Access service token. An entry is a path, or
  // { "path": "/api/agents/*", "audVar": { "app": "shell", "name": "AGENTS_ACCESS_AUD" } } to also give that Worker
  // the application's AUD tag as a var, so it can check the Access token itself.
  "publicPaths": ["/brain/mcp*"],
  "serviceAuthPaths": [],

  // Checks verify.mjs runs from outside with no credentials.
  "checks": [{ "name": "Brain MCP refuses a caller with no token", "path": "/brain/mcp", "method": "POST", "expectStatus": 401 }]
}
```

Rules:

- Every Worker has `workers_dev` and preview URLs off. Only the shell (custom domain) and the gateway (routes from
  `apps/gateway/src/services.ts`) are reachable from outside; a module's own Worker is reached over service bindings.
- A Worker every module can bind to: `shell`, `gateway`, or any `app` a module file declares.
- Do not write `wrangler.jsonc` by hand and do not edit `wrangler-config.mjs` for a module: add the module file and
  run `node setup/wrangler-config.mjs`. A module that is off is left out of the shell's and gateway's config.
- The committed `wrangler.jsonc` files are rendered from `household.config.example.json`, where only Brain is on.
  To see your module's config locally, switch it on in a scratch `household.config.json` (do not
  commit that file).
- Which module needs which stays in `MODULE_NEEDS` (packages/core/src/household.ts), not in the module file.
- Several modules may add to the same shell store: declare the store in one module file and bind it from the
  others' `shell` block by its short name.
- Ids of the created stores land in `setup/resources.json` as `d1.<name>` and `kv.<name>`.
- A binding name is declared once per Worker. A module that needs another module's store (and cannot run without
  that module) uses its binding and does not declare it again.
- An Access application for machines names the exact service tokens that may pass, never "any valid token": the
  tokens a module file's `serviceTokens` point at it, and for a `serviceAuthPaths` application also every token
  named `<prefix>-agent-<machine>`. Until one exists the application has no policy and nobody gets through.
  A machine's token is made by the person in Cloudflare (Zero Trust, Service credentials) under that name, so its
  value never passes through the AI; `node setup/provision.mjs` then adds it to the policy.
- A check passes on `expectStatus`, or on `expectAccessLogin: true` (a redirect to the Cloudflare Access sign-in).
