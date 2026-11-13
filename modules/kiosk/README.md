# Kiosk: wall tablets

A tablet on the wall that shows a clock, the lights and scenes, the shared lists and the energy numbers. A tablet is
not a person: it never signs in, never sees anyone's own lists or records, and has no way to the settings. Needs the
Home Assistant module.

## Why it has its own address

Cloudflare Access sessions end after a month at most, and nobody wants to sign in on a wall every month. So tablets
live on their own hostname (`kiosk.<your domain's parent>`, var `KIOSK_HOST`) with no Access in front. The dashboard
Worker guards that hostname itself:

- an unpaired device gets one page, the pairing page, and nothing else;
- a paired tablet holds a random key for 180 days in a cookie scripts cannot read; only its hash is stored;
- a person's sign-in does nothing on that hostname;
- a tablet can call eight things: read the house, the energy numbers, the shared calendar and the shared lists,
  switch a light, run a scene, add to and tick a shared list. Plugs, setup pages and everything personal are refused.

## Pairing a tablet

1. On the tablet, open `https://<kiosk host>/pair`. It shows a code for 10 minutes.
2. On your own device, open Settings > Wall tablets, type the code and say where the tablet hangs.
3. The tablet opens the wall page within a few seconds. Add it to the home screen for full screen.

Settings > Wall tablets lists every tablet, when it was last on, and revokes one with two taps. A revoked or expired
tablet falls back to the pairing page.

## Files

`kiosk.ts` is pairing, the key and the short list of allowed calls; `worker.ts` routes the kiosk hostname and the
admin API. The pairing page's script and style are `apps/shell/web/pair/`. Cloudflare needs: one more custom domain
on the dashboard Worker (`setup/modules/kiosk.json`); it uses the `home` database of the Home Assistant module.
