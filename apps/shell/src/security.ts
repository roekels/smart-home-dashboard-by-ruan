// What the Security page shows, worked out from the household config, the secrets manifest and the modules that are
// built in: the zones, what sits in them, who reaches what, who signs in where, and every key by name.
// Names and places only. A secret's value is never read here; for Worker secrets on this Worker the page can say
// "set" or "missing", for everything else it says where to look.
import { enabledModules, resourceName, type Household } from "../../../packages/core/src/household.ts";
import { builtModules, MODULES, type ShellModule } from "./modules.ts";

export type Status = "ok" | "fix" | "info" | "rm";
export type Kind = "user" | "service" | "agent" | "tunnel" | "deploy";

export interface Zone { id: string; name: string; text: string }
export interface SecNode { id: string; zone: string; name: string; sub: string; icon: string; status: Status; text: string; guard?: string[]; keys?: string[] }
export interface SecLink { from: string; to: string; kind: Kind; label: string; status?: Status }
export interface SignIn { where: string; who: string; how: string; status: Status; note: string }
export interface KeyRow { name: string; use: string; lives: string; status: Status; state: string; rotate: string; ifLost: string; warn: boolean }
export interface KeyGroup { id: string; name: string; icon: string; rows: KeyRow[] }
export interface Check { title: string; text: string; state: "done" | "open" | "self" }

/** What one module adds to the map and the sign-in table. Node ids must be unique; links may point at core ids. */
export interface SecurityPart { nodes?: SecNode[]; links?: SecLink[]; signIns?: SignIn[] }

export interface SecurityModel {
  checked: string;
  zones: Zone[];
  nodes: SecNode[];
  links: SecLink[];
  signIns: SignIn[];
  keyGroups: KeyGroup[];
  checks: Check[];
}

export interface ManifestSecret {
  name: string; module: string; purpose: string; livesIn: string; createdBy: string; rotate: string; ifLost: string;
  temporary?: boolean; optional?: boolean; losingDestroysData?: boolean; pattern?: boolean;
}

export const ZONES: Zone[] = [
  { id: "who", name: "People and apps", text: "Who comes in" },
  { id: "edge", name: "Cloudflare edge", text: "The doors" },
  { id: "cf", name: "Workers and data", text: "What runs in the cloud" },
  { id: "out", name: "Outside services", text: "What this depends on" },
  { id: "home", name: "At home", text: "Nothing here listens to the internet. Devices call out, or sit behind a tunnel that only the dashboard may use." },
];

const GROUPS: Record<string, { name: string; icon: string }> = {
  setup: { name: "Setup", icon: "settings" },
  core: { name: "Core", icon: "shield" },
  brain: { name: "Brain", icon: "brain" },
  calendar: { name: "Calendar", icon: "calendar" },
  finance: { name: "Finance", icon: "wallet" },
  health: { name: "Health", icon: "activity" },
  dataExport: { name: "Data export", icon: "db" },
  homeAssistant: { name: "Home Assistant", icon: "home" },
  energy: { name: "Energy", icon: "bolt" },
  kiosk: { name: "Wall tablets", icon: "tablet" },
  edgeAgents: { name: "Edge agents", icon: "agents" },
  alfred: { name: "Alfred", icon: "chat" },
};

export interface SecurityInput {
  household: Household;
  secrets: ManifestSecret[];
  /** Whether a Worker secret of this name is set on this Worker. Never returns the value. */
  present: (name: string) => boolean;
  demo?: boolean;
  modules?: ShellModule[];
  now?: Date;
}

function core(h: Household): Required<SecurityPart> {
  const shell = resourceName(h, "shell"), gateway = resourceName(h, "gateway");
  const nodes: SecNode[] = [
    ...h.people.map((p): SecNode => ({
      id: `person-${p.id}`, zone: "who", name: p.name, sub: p.admin ? "admin" : "member", icon: "user", status: "ok",
      text: p.admin ? "Signs in with their own email. Sees everything, including the Metrics and Management pages." : "Signs in with their own email. Sees the Home pages and what a module opens for them.",
      guard: ["Cloudflare Access: email, then a passkey (Face ID, Touch ID or a security key)"],
    })),
    { id: "ai-apps", zone: "who", name: "Your AI apps", sub: "Claude, ChatGPT", icon: "chat", status: "ok",
      text: "An AI app that a person connected reaches the dashboard's data through the MCP addresses, never through the pages.",
      guard: ["OAuth: the consent page sits behind the same sign-in as the dashboard", "Each connection is bound to one MCP and only the permissions that were ticked"] },
    { id: "access", zone: "edge", name: "Access · household", sub: "email + passkey", icon: "lock", status: "ok",
      text: `The front door of ${h.domain}: every page, /api and the OAuth consent page.`,
      guard: ["Only the emails in the household config pass", "The Worker checks the Access token again on every request and reads the email from it"],
      keys: ["Nothing to store: the session lives in the browser"] },
    { id: "bypass", zone: "edge", name: "Access · machine paths", sub: "bypass", icon: "key", status: "ok",
      text: "/login, the /…/mcp addresses, /oauth/token, /oauth/register and /.well-known pass Access untouched, because an app cannot do a person's sign-in.",
      guard: ["The gateway checks an OAuth token or a gateway key on every call", "A bypass that is too wide fails closed: the Workers check everything themselves"] },
    { id: "shell", zone: "cf", name: shell, sub: "the dashboard", icon: "monitor", status: "ok",
      text: "The pages and their API: sign-in, Today, Settings, Security, and the modules that are switched on.",
      guard: ["Access token verified on every request", "Changes need the same origin and the dashboard's own header"] },
    { id: "gateway", zone: "cf", name: gateway, sub: "MCP + OAuth", icon: "link", status: "ok",
      text: "One OAuth server and one MCP address per module. Keeps no data of its own beyond connections and its audit log.",
      guard: ["Every token is bound to one MCP", "Scopes are cut to that MCP before a tool sees them", "Every call is written to the audit log"],
      keys: [`Connections: KV ${gateway}-oauth`, `Gateway key hashes and the audit log: D1 ${gateway}`] },
    { id: "github", zone: "out", name: "GitHub", sub: "your private repository", icon: "file", status: "info",
      text: "Holds the code and the household config. A merge to main deploys. The repository must stay private.",
      guard: ["Two-factor sign-in on the GitHub account"] },
  ];
  const links: SecLink[] = [
    ...h.people.map((p): SecLink => ({ from: `person-${p.id}`, to: "access", kind: "user", label: "email + passkey" })),
    { from: "access", to: "shell", kind: "user", label: "verified Access token" },
    { from: "access", to: "gateway", kind: "user", label: "consent page only" },
    { from: "ai-apps", to: "bypass", kind: "service", label: "OAuth token or gateway key" },
    { from: "bypass", to: "gateway", kind: "service", label: "checked by the gateway" },
    { from: "github", to: "shell", kind: "deploy", label: "Workers Builds on merge" },
    { from: "github", to: "gateway", kind: "deploy", label: "Workers Builds on merge" },
  ];
  const signIns: SignIn[] = [
    { where: "The dashboard", who: h.people.map((p) => p.name).join(", "), how: "Cloudflare Access: email, then a passkey", status: "ok", note: "Per person. Add or remove someone in the household config and in the Access policy." },
    { where: "MCP addresses", who: "AI apps a person connected", how: "OAuth, approved on a consent page behind the same sign-in", status: "ok", note: "A connection ends when it is unused for 90 days." },
    { where: "Cloudflare and GitHub", who: "The account owner", how: "The accounts' own sign-in", status: "info", note: "Turn on two-factor sign-in for both. Whoever controls these accounts controls everything here." },
  ];
  return { nodes, links, signIns };
}

function keyGroups(h: Household, secrets: ManifestSecret[], present: (n: string) => boolean, built: Set<string>, demo: boolean): KeyGroup[] {
  const on = new Set<string>(["setup", "core", ...enabledModules(h)]);
  const shellSecret = new RegExp(`Worker secret on <prefix>-shell\\b`);
  const groups = new Map<string, KeyGroup>();
  for (const s of secrets) {
    if (!on.has(s.module)) continue;
    const g = groups.get(s.module) ?? { id: s.module, ...(GROUPS[s.module] ?? { name: s.module, icon: "key" }), rows: [] };
    let status: Status = "info", state = "kept elsewhere: not checked from here";
    if (s.temporary) { status = "rm"; state = "delete after setup"; }
    else if (demo) state = "demo: no real keys exist";
    else if (shellSecret.test(s.livesIn) && !s.pattern && !built.has(s.module)) state = "its module is not built into this Worker yet";
    else if (shellSecret.test(s.livesIn) && !s.pattern) {
      const set = present(s.name);
      status = set ? "ok" : s.optional ? "info" : "fix";
      state = set ? "set" : "not set on the Worker";
    }
    g.rows.push({
      name: s.name, use: s.purpose, lives: s.livesIn.replace(/<prefix>/g, h.resourcePrefix), status, state,
      rotate: s.rotate, ifLost: s.ifLost, warn: s.losingDestroysData === true,
    });
    groups.set(s.module, g);
  }
  return [...groups.values()];
}

export function securityModel(input: SecurityInput): SecurityModel {
  const { household: h, secrets, present } = input;
  const parts = [core(h), ...builtModules(h, input.modules ?? MODULES).map((m) => m.security?.(h) ?? {})];
  const nodes = parts.flatMap((p) => p.nodes ?? []);
  const ids = new Set(nodes.map((n) => n.id));
  const links = parts.flatMap((p) => p.links ?? []).filter((l) => ids.has(l.from) && ids.has(l.to));
  const mods = builtModules(h, input.modules ?? MODULES);
  const groups = keyGroups(h, secrets, present, new Set(["core", ...mods.map((m) => m.id)]), input.demo === true);
  const rows = groups.flatMap((g) => g.rows);
  const missing = rows.filter((r) => r.status === "fix");
  const destroy = rows.filter((r) => r.warn);
  const admins = h.people.filter((p) => p.admin);
  const checks: Check[] = [
    { title: "Demo mode is off", state: input.demo ? "open" : "done",
      text: input.demo ? "This is the demo: a made-up family, open to anyone with the address. Never switch demo mode on for your own dashboard." : "The dashboard only opens for the people in the household config." },
    { title: "Worker secrets are set", state: missing.length ? "open" : "done",
      text: missing.length ? `Missing on ${resourceName(h, "shell")}: ${missing.map((r) => r.name).join(", ")}.` : "Every secret this Worker needs for the modules that are on is set." },
    { title: "More than one way back in", state: admins.length > 1 ? "done" : "self",
      text: admins.length > 1 ? `${admins.length} people are admins.` : "One person is the only admin. Keep the Cloudflare account's own recovery codes somewhere safe." },
    { title: "The setup token is gone", state: "self",
      text: "SETUP_CLOUDFLARE_FULL_TOKEN was for setup only. Look under Cloudflare > My Profile > API Tokens: it should no longer be listed." },
    { title: "Two-factor sign-in on Cloudflare and GitHub", state: "self",
      text: "Both accounts sit above everything on this page. Check that each asks for a second factor." },
    { title: "Every key has a copy in your password manager", state: "self",
      text: destroy.length ? `One item with one field per name. Losing ${destroy.map((r) => r.name).join(" or ")} loses the data it protects for good.` : "One item with one field per name on the Sign-ins & keys tab." },
    { title: "The repository is private", state: "self",
      text: "It holds your household's names and sign-in emails. Check its visibility in GitHub > Settings." },
  ];
  return {
    checked: (input.now ?? new Date()).toISOString(),
    zones: ZONES.filter((z) => nodes.some((n) => n.zone === z.id)),
    nodes, links, signIns: parts.flatMap((p) => p.signIns ?? []), keyGroups: groups, checks,
  };
}
