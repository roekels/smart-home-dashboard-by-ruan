// The map's own settings (gear menu), kept in this browser. Theme is not here: the dashboard owns Light / Dark / System.

export interface Settings {
  animations: boolean;
  wheelZoom: boolean;
  orbit: boolean;
  showArchived: boolean;
  view: "3d" | "2d";
  /** How far back the opening replay goes. */
  replay: "24h" | "3d" | "1w" | "1m";
  /** Name the notes while the opening replay plays. Off by default: the map may be on a screen others can see. */
  replayLabels: boolean;
}

export const REPLAY_MS = { "24h": 864e5, "3d": 3 * 864e5, "1w": 7 * 864e5, "1m": 30 * 864e5 } as const;

const KEY = "brain.map.settings.v1";
/** Reduced motion turns the map's motion off (synapses, flashes, orbit, fly-ins, replay), whatever the toggle says. */
export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const defaults: Settings = { animations: true, wheelZoom: true, orbit: true, showArchived: true, view: "3d", replay: "24h", replayLabels: false };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    const s: Settings = raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
    return reducedMotion() ? { ...s, animations: false } : s;
  } catch {
    return { ...defaults, animations: !reducedMotion() };
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: keep in memory */ }
}

/** The theme the dashboard shows right now: its data-theme attribute, or the system preference. */
export function effectiveTheme(): "dark" | "light" {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark" || t === "light") return t;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
