/**
 * What the assistant may do on its own. Every MCP tool gets one of three modes:
 *   auto     it runs straight away
 *   confirm  it is proposed, the page shows a card, the person approves or declines
 *   off      not offered to the model at all
 *
 * Three layers, each only narrowing the one before:
 *   1. the gateway key's scopes (the hard limit, enforced by the gateway)
 *   2. the check boxes on the Assistant settings page (settings.ts): a box that is off switches its tools off
 *   3. the defaults here, read from each tool's own MCP annotations:
 *        read-only                      runs
 *        a house action (service home)  runs: a light or a scene is quick to undo
 *        any other write                needs a yes on a card
 *        destructive                    off
 * ALFRED_TOOL_POLICY can change one tool's mode, but a destructive tool never runs without a card.
 */
import { type Settings, DEFAULT_SETTINGS, allowed } from "./settings.ts";

export type Mode = "auto" | "confirm" | "off";

export interface ToolInfo {
  /** The gateway service the tool belongs to: brain, calendar, home, finance, health … */
  server: string;
  /** Its name on that MCP server, e.g. "search". */
  name: string;
  readOnly: boolean;
  destructive: boolean;
}

/** Services whose ordinary writes run without a card. */
const AUTO_WRITE_SERVICES = new Set(["home"]);

export const qualified = (t: Pick<ToolInfo, "server" | "name">): string => `${t.server}__${t.name}`;

export function parseOverrides(raw: string | undefined): Record<string, Mode> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, Mode> = {};
    for (const [k, v] of Object.entries(obj)) if (v === "auto" || v === "confirm" || v === "off") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function modeFor(t: ToolInfo, overrides: Record<string, Mode> = {}, settings: Settings = DEFAULT_SETTINGS): Mode {
  if (!allowed(settings, t.server, t.readOnly ? "read" : "write")) return "off";
  const q = qualified(t);
  const destructive = t.destructive && !t.readOnly;
  if (overrides[q]) return destructive && overrides[q] === "auto" ? "confirm" : overrides[q];
  if (destructive) return "off";
  if (t.readOnly || AUTO_WRITE_SERVICES.has(t.server)) return "auto";
  return "confirm";
}

const NAMES: Record<string, string> = { brain: "Brain", calendar: "Calendar", home: "Home", devices: "Devices", finance: "Finance", health: "Health", household: "Household" };
export const serviceName = (s: string): string => NAMES[s] ?? (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Short label for the page, e.g. "Brain · search". */
export const label = (t: Pick<ToolInfo, "server" | "name">): string => `${serviceName(t.server)} · ${t.name.replace(/_/g, " ")}`;
