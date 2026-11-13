# Home Assistant

Lights, scenes, plugs and lists, read from and switched in your own Home Assistant. Nothing in your home listens to
the internet: Home Assistant calls out through its Cloudflared add-on, and only the dashboard may use that tunnel.

## What you get

| Where | What |
|---|---|
| Today | the scenes, and each person's shared and own lists |
| Home > Lights (`/home/controls`) | every light as a tile (tap, drag to dim), scenes, the switches you chose as plugs |
| Settings > Home Assistant (`/dashboard/home-assistant`) | a connection check, whose list is whose, which switches are plugs, which scripts sit with the scenes, which lights stay hidden |
| AI apps (`/home/mcp`) | `home_status`, `set_light`, `run_scene`, `read_lists`, `add_list_item`, `set_list_item_done`, `set_plug` |

No entity id of your home is written in the code or in `household.config.json`. What exists is read from Home
Assistant; what it means on the dashboard is chosen on the setup page and stored in the `home` database.

## How it is locked

1. The tunnel hostname (var `HA_URL`) sits behind a Cloudflare Access application whose only policy is of type
   Service Auth and names one service token. No person can sign in there and no browser can open it.
2. The dashboard Worker holds that service token (`HA_TUNNEL_SERVICE_TOKEN_ID`, `HA_TUNNEL_SERVICE_TOKEN_KEY`).
3. Inside, Home Assistant checks its own long-lived token (`HA_API_LONGLIVED_TOKEN`) of a dedicated user that is
   **not** an administrator.

The dashboard can do five things and no others: switch a light, run a scene, run a script you ticked, switch a
switch you ticked, and read, add to and tick off to-do lists. A switch or script you did not tick cannot be reached,
whatever a page or an AI app sends. Every change writes an audit line (who, what, which entity; never a list item's
text).

Lists: a list set to "Everyone" is shared (also shown on wall tablets and to AI apps using an API key), a list set
to a person is only theirs, and a list nobody assigned is shown to admins only.

## Setting it up

Your AI does the Cloudflare side from `setup/modules/homeAssistant.json`: the `home` database, the tunnel hostname
`ha.<your domain's parent>` (or `hosts.homeAssistant` in the household config), its Access application and the
service token. Three things need your hands, once:

1. In Home Assistant, install the **Cloudflared** add-on and give it the tunnel hostname the setup names.
2. In Home Assistant, create a user for the dashboard (not an administrator), sign in as that user, and under
   Security create a **long-lived access token**. Keep a copy in your password manager as `HA_API_LONGLIVED_TOKEN`.
3. Put that token on the dashboard Worker as a secret yourself, in the Cloudflare dashboard
   ([docs/secrets.md](../../docs/secrets.md#putting-a-secret-into-cloudflare-yourself)), never into the chat.

Then open Settings > Home Assistant: five green ticks mean it works. Assign the lists and tick your plugs.

## Files

| File | What |
|---|---|
| `ha.ts` | the calls to Home Assistant, what is kept from a reading, the allowed actions |
| `lists.ts` | to-do lists and who may use which |
| `store.ts` | the `home` database: the newest reading (kept 20 seconds), your choices, the audit |
| `service.ts` | the same functions for the pages, the wall tablet and `/home/mcp` |
| `worker.ts` | the pages, `/api/ha*`, `/api/lists*`, the Security page part |
| `demo.ts` | the made-up house of demo mode (`demo/data/home.json`) |
