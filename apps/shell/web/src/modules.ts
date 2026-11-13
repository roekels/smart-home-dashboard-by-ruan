// What a module adds to the UI: its pages. The Worker's list (src/modules.ts) says which paths exist and who may
// open them; this list says what each path draws. To add a module: import its descriptor and add it to UI_MODULES.
import type { Raw } from "./html.ts";
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

export const UI_MODULES: UiModule[] = [
  financeUi, healthUi,
  { id: "alfred", pages: {
    "/home/assistant": { title: "Assistant", view: assistant, init: assistantInit },
    "/dashboard/alfred": { title: "Assistant settings", view: alfredSettings, init: alfredSettingsInit },
  } },
];
