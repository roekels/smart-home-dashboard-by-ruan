# Demo data

A made-up family, used by demo mode and for the screenshots. Nothing here is real: the names are invented and every
address ends in `example.com`.

| File | What |
|---|---|
| `household.config.json` | the Maple family: four people, two of them admins, every module on |
| `data/calendar.json` | events over the next few days, per person and shared |
| `data/home.json` | scenes, lights and plugs |
| `data/lists.json` | a shared shopping list and a to-do list per person |
| `data/health.json` | what Today's "For you" card shows per person |
| `data/alfred.json` | the assistant's canned answers, cards and trace lines |

Run it: `npm run demo` in the repository root, then open the address it prints. In demo mode the dashboard asks for
no sign-in, answers every request from these files, and keeps changes in memory only. Settings has a "Viewing as"
switch to look at it as each person.

A module adds its own demo file here and serves it from `apps/shell/src/demo.ts`.
