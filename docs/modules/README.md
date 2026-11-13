# Modules

Each module is a part of the dashboard you can switch on or off in `household.config.json`. Your AI asks which ones
you want during setup; you can switch more on later by asking it.

| Module | Page | What you get |
|---|---|---|
| [Core](core.md) | Today, Settings, Security | sign-in, a Today page per person, the household, the Security page |
| [Brain](brain.md) | Brain | shared notes as a map, readable and writable by your AI app |
| [Calendar](calendar.md) | Calendar, Today | your iCloud calendars |
| [Finance](finance.md) | Metrics > Finance | accounts, balances, contracts, deadlines; encrypted, admins only |
| [Health](health.md) | Metrics > Health, Today | each person's visits, tests, vaccinations and medication; encrypted |
| [Home Assistant](home-assistant.md) | Lights, Today | lights, scenes, plugs and to-do lists |
| [Energy](energy.md) | Energy | solar, grid, battery and the house from your Home Assistant sensors |
| [Kiosk](kiosk.md) | Wall tablet | a tablet on the wall: clock, lights, lists, energy |
| [Edge agents](edge-agents.md) | Metrics > Systems | your computers' processor, memory and disk, and a few safe commands |
| [Alfred](alfred.md) | Assistant | a chat assistant inside the dashboard, on your own Anthropic API key |
| [Data export](data-export.md) | | an encrypted zip of everything. **Not built yet** |

Each page here is for you, the owner. The technical notes for your AI are in the README of each module's folder
(`apps/<name>/` or `modules/<name>/`).
