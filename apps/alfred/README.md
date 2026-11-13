# Alfred

The optional chat assistant inside the dashboard. It answers questions about the house, the calendars, the notes and
a person's own records, and it can change things: lights at once, everything else after a yes on a card.

It runs on the household's own Anthropic API key, so every message costs a little (billed by Anthropic). The module
is off unless `modules.alfred` is `true` in `household.config.json`. The name "Alfred" is only a default: an admin
can rename it and set its tone on the Assistant settings page.

## How it is built

```
browser ── /api/alfred/* ──> dashboard Worker (shell) ── service binding ──> <prefix>-alfred ──> gateway MCPs
           after the sign-in        sends only the person's id                  its own gateway key    Claude API
```

- **Its own Worker with no address.** Only the dashboard can call it, over the `ALFRED` service binding. The
  dashboard checks the sign-in, then sends one header, `X-Alfred-Person`, with the person's id from the household
  config. Nothing a browser sent is copied along (`shell.ts`).
- **All tools come from the gateway.** At the start of a turn it asks the gateway which MCPs exist
  (`/oauth/health`) and lists their tools with its own key. A module that is off simply has no MCP, so the
  assistant works with whatever is there, down to nothing but conversation.
- **It has no data of its own** apart from conversations (each deletes itself 30 days after its last message), its settings, token counts and timing
  traces, all in two Durable Objects.

| File | What |
|---|---|
| `src/index.ts` | the routes, and who may call which |
| `src/agent.ts` | one turn: the model loop, tools, cards |
| `src/mcp.ts` | finds the gateway's MCPs and calls their tools |
| `src/policy.ts` | which tool runs, which waits for a yes, which is off |
| `src/scope.ts` | whose finance and health records a call may touch |
| `src/prompt.ts` | the system prompt, built from the household and the tools that exist |
| `src/context.ts` | what is fetched before the model is asked (house status, lists, calendar, notes) |
| `src/settings.ts` | name, tone, check boxes, fast mode |
| `src/conversation.ts`, `src/registry.ts` | the two Durable Objects |
| `shell.ts` | what the module adds to the dashboard Worker: two pages and the proxy |
| `demo.ts` | the same routes answered from `demo/data/alfred.json` in demo mode |

The pages live with the rest of the UI: `apps/shell/web/src/pages/assistant.ts`, `pages/alfred-settings.ts`,
`chat.ts`, `alfred.ts` and `styles/alfred.css`.

## What it may do

Three layers, each only narrowing the one before:

1. **The gateway key's scopes.** The hard limit, enforced by the gateway. Listed in `setup/modules/alfred.json`.
2. **The check boxes** on Assistant settings: Read and Change per service. A box that is off takes those tools away.
3. **Defaults read from each tool's own MCP annotations:**

| Tool | What happens |
|---|---|
| read-only | runs |
| a change on the `home` service (a light, a scene, a list item) | runs: quick to undo |
| any other change | a card shows what would be written; it runs only after Approve |
| marked destructive (plugs, device commands), or named archive, delete or remove | not offered at all |

`ALFRED_TOOL_POLICY` (a JSON var, `{ "home__set_plug": "confirm" }`) can change one tool. A destructive tool can be
raised to "needs a card" at most, never to "runs".

### Finance, health and calendars

- **Finance** is for admins: for everyone else the finance tools are not even listed.
- **Health** is per person. Where a tool takes a `person` and the model leaves it out, the Worker fills in the
  person who is signed in. A call that names someone else is refused, except as below.
- **Someone else's records** can only be written by an admin who asked for it in their own words. Those words are
  quoted on the card, with whose records it is for.
- **Calendars**: a person reaches their own calendar and the shared one through the assistant, never another
  person's, whatever the gateway key could reach. This is checked in the Worker (`src/scope.ts`), not left to the
  prompt.
- **A health conversation leaves no text behind** outside the conversation itself: its trace line reads
  `[health, not traced]` and its title is "Health".
- **Nothing clinical goes into the notes.** A note written from a health conversation always shows a card, marked
  as coming from a health chat, so the person can check it. The prompt allows it only for a life moment the person
  explicitly asked to keep.

## Settings and secrets

| Name | Kind | What |
|---|---|---|
| `ALFRED_ANTHROPIC_API_KEY` | secret | the household's Claude API key (the person creates it) |
| `ALFRED_GATEWAY_KEY` | secret | its key for the gateway (the setup makes it; only the hash is stored) |
| `ALFRED_MODEL` | var | the Claude model |
| `ALFRED_EFFORT` | var | thinking effort: `low` (the default), `medium`, `high`, `xhigh` or `max` |
| `ALFRED_DAILY_TOKEN_LIMIT` | var | it stops answering for the day past this many tokens |
| `ALFRED_TOOL_POLICY` | var | per-tool overrides, see above |

`setup/modules/alfred.json` declares all of this; `node setup/wrangler-config.mjs` renders the Worker's config from
it. Never write `wrangler.jsonc` by hand.

**Gateway key scopes.** The module file gives the key `household.read` and the home scopes. When you switch on a
data module (notes, calendar, finance, health), add that module's scopes to `gatewayKeys[0].scopes` and run
`node setup/secrets.mjs` again, or the assistant will not see those tools. `GET /api/alfred/tools` (admins) lists
every tool it can reach and its mode, which is the quickest way to check.

`GET /api/alfred/health` (admins) says whether it is set up and names what is missing, never a value.

## What an MCP must do to work well with it

The assistant knows no tool by name. It relies on:

- `readOnlyHint` and `destructiveHint` annotations that are true to what the tool does;
- finance and health tools taking the person as `person` (a person id from the household config);
- short tool descriptions, since they are the model's only guide.

`src/context.ts` names a few read tools it calls up front when they exist (`home_status`, `read_lists`,
`list_events`, `search`). A missing one is skipped.

## Try it

```
npm ci && npm test        # in apps/alfred: policy, scoping, cards, health privacy, against stand-in MCPs
npm run demo              # in the repository root: the chat with canned answers, no key needed
```

What goes to Anthropic: the messages, first names, the time zone and whatever the tools return for a turn. Never an
email address.
