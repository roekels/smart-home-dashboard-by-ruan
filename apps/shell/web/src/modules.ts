// What a module adds to the UI: its pages. The Worker's list (src/modules.ts) says which paths exist and who may
// open them; this list says what each path draws. To add a module: import its descriptor and add it to UI_MODULES.
import type { Raw } from "./html.ts";

/** leave() runs before the next page renders (stop timers, sockets, observers). */
export interface Page { title: string; view: () => Raw; init?: () => void; leave?: () => void }

export interface UiModule {
  /** The module's id in the household config. */
  id: string;
  /** Path -> page. The paths must match the module's PageDef paths on the Worker. */
  pages: Record<string, Page>;
}

export const UI_MODULES: UiModule[] = [];
