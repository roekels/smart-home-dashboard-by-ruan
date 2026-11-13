# Energy

What your home makes, uses, stores and buys, worked out from Home Assistant power sensors and nothing else. No
vendor cloud is polled and no extra account is needed. Needs the Home Assistant module.

## What you get

| Where | What |
|---|---|
| Home > Energy (`/home/energy`) | solar, the house, the grid and the battery right now; today and yesterday in kWh; the last 24 hours as a chart; your devices by draw |
| Settings > Energy sensors (`/dashboard/energy-setup`) | which sensor is solar, grid, battery and battery charge, and which are single devices |
| Wall tablet | the same numbers, large |
| AI apps | `home_status` on `/home/mcp` includes the energy picture |

## How it works

Once a minute the dashboard Worker reads Home Assistant (the same reading the lights use), stores one sample and adds
it to today's totals. Samples are kept for 48 hours; the chart shows 10-minute averages. Everything lives in the
`home` database.

On the setup page the dashboard guesses from your sensors' names; check the guess and press Save. Useful to know:

- **Grid**: positive means buying. Tick "negative when buying" if your meter reports the other way round.
- **Battery**: positive means charging. Same tick box for the other way round.
- **Whole house**: leave on "Work it out" unless you have a sensor for it (solar + grid − battery charging).
- **Devices**: a device on one of your plugs shows "off" when the plug is off. Plugs are chosen under
  Settings > Home Assistant.

The totals are sums of one-minute readings, so they are close to, not equal to, your meter.

## Files

`engine.ts` is the arithmetic (pure functions, tested), `worker.ts` the page's API and the minute tick, `demo.ts`
the made-up house. Cloudflare needs: one cron trigger on the dashboard Worker (`setup/modules/energy.json`).
