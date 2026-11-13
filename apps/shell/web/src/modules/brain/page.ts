import { html, type Raw } from "../../html.ts";
import { who } from "../../api.ts";
import { t } from "../../i18n.ts";
import type { UiModule } from "../../modules.ts";
import { useStyles } from "../fmt.ts";

// /home/brain: the household's notes as a map. Every note is a dot, coloured by whose tree it is in; lines are the
// tree and the [[links]] between notes. Click a note to read or edit it; search finds text inside notes.
// The map's code (and the 3D library, vendor/brain-map.js) loads only when this page opens.
// Data: /api/brain/* (apps/brain over a service binding; demo mode answers from demo/data/brain.json).

let map: { destroy(): void } | null = null;
let opened = 0;

function view(): Raw {
  useStyles("brain-map");
  return html`<div class="bm-page" id="brain-map"><p class="bm-boot muted">${t("Loading the map…")}</p></div>`;
}

async function init(): Promise<void> {
  const mine = ++opened;
  try {
    const [{ BrainMap }, { brainSource }] = await Promise.all([import("./map.ts"), import("./source.ts")]);
    const host = document.getElementById("brain-map");
    // the person may have left the page while the map's code was loading
    if (!host || mine !== opened) return;
    host.replaceChildren();
    map = new BrainMap(host, brainSource, who.people);
  } catch {
    const host = document.getElementById("brain-map");
    if (host && mine === opened) host.replaceChildren(Object.assign(document.createElement("p"), { className: "bm-boot muted", textContent: t("The map could not be loaded.") }));
  }
}

function leave(): void {
  opened++;
  map?.destroy();
  map = null;
}

export const brainUi: UiModule = {
  id: "brain",
  pages: { "/home/brain": { title: "Brain", view, init: () => void init(), leave } },
};
