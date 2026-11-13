// What a module adds to the UI: its pages. The Worker's list (src/modules.ts) says which paths exist and who may
// open them; this list says what each path draws. To add a module: import its descriptor and add it to UI_MODULES.
import type { Raw } from "./html.ts";
import { brainUi } from "./modules/brain/page.ts";
import { calendarUi } from "./modules/calendar/page.ts";
import { financeUi } from "./modules/finance/page.ts";
import { healthUi } from "./modules/health/page.ts";
import { assistant, assistantInit } from "./pages/assistant.ts";
import { alfredSettings, alfredSettingsInit } from "./pages/alfred-settings.ts";

/** leave() runs before the next page renders (stop timers, sockets, observers). */
export interface Page { title: string; view: () => Raw; init?: () => void; leave?: () => void }

export interface UiModule {
  /** The module's id in the household config. */
  id: string;
  /** Path -> page. The paths must match the module's PageDef paths on the Worker. */
  pages: Record<string, Page>;
}

import { controlsPage, controlsInit, controlsLeave } from "./pages/controls.ts";
import { haSetupPage, haSetupInit } from "./pages/ha-setup.ts";
import { energyPage, energyInit, energyLeave } from "./pages/energy.ts";
import { energySetupPage, energySetupInit } from "./pages/energy-setup.ts";
import { kioskPage, kioskInit, kioskLeave } from "./pages/kiosk.ts";
import { wallTabletsPage, wallTabletsInit } from "./pages/wall-tablets.ts";
import { systemsPage, systemsInit, systemsLeave } from "./pages/systems.ts";
import { agentsPage, agentsInit, agentsLeave } from "./pages/agents.ts";

export const UI_MODULES: UiModule[] = [
  calendarUi, brainUi, financeUi, healthUi,
  { id: "homeAssistant", pages: {
    "/home/controls": { title: "Lights", view: controlsPage, init: controlsInit, leave: controlsLeave },
    "/dashboard/home-assistant": { title: "Home Assistant", view: haSetupPage, init: haSetupInit },
  } },
  { id: "energy", pages: {
    "/home/energy": { title: "Energy", view: energyPage, init: energyInit, leave: energyLeave },
    "/dashboard/energy-setup": { title: "Energy sensors", view: energySetupPage, init: energySetupInit },
  } },
  { id: "kiosk", pages: {
    "/kiosk": { title: "Wall tablet", view: kioskPage, init: kioskInit, leave: kioskLeave },
    "/dashboard/wall-tablets": { title: "Wall tablets", view: wallTabletsPage, init: wallTabletsInit },
  } },
  { id: "edgeAgents", pages: {
    "/dashboard/systems": { title: "Systems", view: systemsPage, init: systemsInit, leave: systemsLeave },
    "/dashboard/agents": { title: "Edge agents", view: agentsPage, init: agentsInit, leave: agentsLeave },
  } },
  { id: "alfred", pages: {
    "/home/assistant": { title: "Assistant", view: assistant, init: assistantInit },
    "/dashboard/alfred": { title: "Assistant settings", view: alfredSettings, init: alfredSettingsInit },
  } },
];
