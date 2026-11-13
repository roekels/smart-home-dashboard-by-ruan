// The household config (household.config.json): who lives here, on which domain, with which modules.
// One parser for every Worker and for the setup scripts. setup/household.schema.json describes the same shape for
// editors; test/household.test.ts keeps the two in step.

export const MODULE_IDS = ["brain", "calendar", "finance", "health", "dataExport", "homeAssistant", "energy", "kiosk", "edgeAgents", "alfred"] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** A module that only works when another one is on. */
export const MODULE_NEEDS: Partial<Record<ModuleId, ModuleId>> = { energy: "homeAssistant", kiosk: "homeAssistant" };

export const MAX_PEOPLE = 6;

export interface Person {
  /** Stable id used in data and scopes: lower case, never shown. */
  id: string;
  /** First name, as shown. */
  name: string;
  /** The address this person signs in with, lower case. */
  email: string;
  admin: boolean;
}

export interface Household {
  household: string;
  domain: string;
  resourcePrefix: string;
  language: string;
  timezone: string;
  /** ISO 4217 code of the currency money is shown in (the Finance module's totals). */
  currency: string;
  people: Person[];
  modules: Record<ModuleId, boolean>;
  /** Extra hostnames some modules use (a wall tablet host, a tunnel to Home Assistant), by key. Empty = the defaults. */
  hosts: Record<string, string>;
}

export class HouseholdError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`household config: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

const DOMAIN = /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;
const PREFIX = /^[a-z][a-z0-9-]{1,15}$/;
const PERSON_ID = /^[a-z][a-z0-9-]{0,23}$/;
const EMAIL = /^[^\s@,;<>"]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const CURRENCY = /^[A-Z]{3}$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const TOP = ["$schema", "household", "domain", "resourcePrefix", "language", "timezone", "currency", "people", "modules", "hosts"];
const HOST_KEY = /^[a-z][A-Za-z0-9]{0,31}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Every problem with a config, in plain words. Empty = valid. */
export function householdProblems(input: unknown): string[] {
  const out: string[] = [];
  if (!isObj(input)) return ["must be a JSON object"];
  for (const k of Object.keys(input)) if (!TOP.includes(k)) out.push(`unknown setting "${k}"`);
  if (typeof input.household !== "string" || !input.household.trim() || input.household.length > 60) out.push("household: a name of 1 to 60 characters is required");
  if (typeof input.domain !== "string" || !DOMAIN.test(input.domain)) out.push("domain: a hostname such as home.example.com is required (lower case, no https://)");
  if (input.resourcePrefix !== undefined && (typeof input.resourcePrefix !== "string" || !PREFIX.test(input.resourcePrefix))) out.push("resourcePrefix: 2 to 16 characters, lower-case letters, digits and hyphens, starting with a letter");
  if (input.language !== undefined && (typeof input.language !== "string" || !LANGUAGE.test(input.language))) out.push('language: a language tag such as "en" or "de-AT"');
  if (input.timezone !== undefined && (typeof input.timezone !== "string" || !validTimezone(input.timezone))) out.push('timezone: an IANA time zone such as "Europe/London"');

  if (input.currency !== undefined && (typeof input.currency !== "string" || !CURRENCY.test(input.currency))) out.push('currency: a three-letter code such as "EUR", "USD" or "GBP"');

  const people = input.people;
  if (!Array.isArray(people) || people.length < 1 || people.length > MAX_PEOPLE) out.push(`people: 1 to ${MAX_PEOPLE} people are required`);
  else {
    const ids = new Set<string>(), emails = new Set<string>();
    people.forEach((p, i) => {
      const at = `people[${i}]`;
      if (!isObj(p)) return void out.push(`${at}: must be an object`);
      for (const k of Object.keys(p)) if (!["id", "name", "email", "admin"].includes(k)) out.push(`${at}: unknown setting "${k}"`);
      if (typeof p.id !== "string" || !PERSON_ID.test(p.id)) out.push(`${at}.id: lower-case letters, digits and hyphens, starting with a letter`);
      else if (ids.has(p.id)) out.push(`${at}.id: "${p.id}" is used twice`);
      else ids.add(p.id);
      if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 40) out.push(`${at}.name: a first name is required`);
      const email = typeof p.email === "string" ? p.email.trim().toLowerCase() : "";
      if (!EMAIL.test(email)) out.push(`${at}.email: the address this person signs in with is required`);
      else if (emails.has(email)) out.push(`${at}.email: used twice (each person signs in with their own address)`);
      else emails.add(email);
      if (p.admin !== undefined && typeof p.admin !== "boolean") out.push(`${at}.admin: true or false`);
    });
    if (!people.some((p) => isObj(p) && p.admin === true)) out.push("people: at least one person must be admin");
  }

  if (input.hosts !== undefined) {
    if (!isObj(input.hosts)) out.push("hosts: an object of hostnames, such as { \"kiosk\": \"kiosk.example.com\" }");
    else for (const [k, v] of Object.entries(input.hosts)) {
      if (!HOST_KEY.test(k)) out.push(`hosts: "${k}" is not a valid key`);
      if (typeof v !== "string" || !DOMAIN.test(v)) out.push(`hosts.${k}: a hostname such as kiosk.example.com (lower case, no https://)`);
      else if (v === input.domain) out.push(`hosts.${k}: must differ from the dashboard's own domain`);
    }
  }

  const modules = input.modules;
  if (!isObj(modules)) out.push("modules: required, one true or false per module");
  else {
    for (const [k, v] of Object.entries(modules)) {
      if (!(MODULE_IDS as readonly string[]).includes(k)) out.push(`modules: unknown module "${k}"`);
      else if (typeof v !== "boolean") out.push(`modules.${k}: true or false`);
    }
    for (const [m, needs] of Object.entries(MODULE_NEEDS)) if (modules[m] === true && modules[needs] !== true) out.push(`modules.${m} needs modules.${needs}`);
  }
  return out;
}

/** The config with defaults filled in. Throws a HouseholdError that lists every problem. */
export function parseHousehold(input: unknown): Household {
  const problems = householdProblems(input);
  if (problems.length) throw new HouseholdError(problems);
  const c = input as Record<string, any>;
  return {
    household: c.household.trim(),
    domain: c.domain,
    resourcePrefix: c.resourcePrefix ?? "home",
    language: c.language ?? "en",
    timezone: c.timezone ?? "UTC",
    currency: c.currency ?? "EUR",
    people: c.people.map((p: any) => ({ id: p.id, name: p.name.trim(), email: p.email.trim().toLowerCase(), admin: p.admin === true })),
    modules: Object.fromEntries(MODULE_IDS.map((m) => [m, c.modules[m] === true])) as Record<ModuleId, boolean>,
    hosts: { ...(c.hosts ?? {}) },
  };
}

let cached: { raw: string; value: Household } | undefined;

/** From a Worker var (JSON text, written by setup/wrangler-config.mjs). Parsed once per isolate. */
export function householdFromVar(raw: string | undefined): Household {
  if (!raw) throw new HouseholdError(["the HOUSEHOLD var is not set: render wrangler.jsonc with setup/wrangler-config.mjs"]);
  if (cached?.raw === raw) return cached.value;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HouseholdError(["the HOUSEHOLD var is not valid JSON"]);
  }
  const value = parseHousehold(data);
  cached = { raw, value };
  return value;
}

export const personByEmail = (h: Household, email: string): Person | null =>
  h.people.find((p) => p.email === email.trim().toLowerCase()) ?? null;

export const personById = (h: Household, id: string): Person | null => h.people.find((p) => p.id === id) ?? null;

export const enabledModules = (h: Household): ModuleId[] => MODULE_IDS.filter((m) => h.modules[m]);

/** Cloudflare resource names all start with the prefix: home-shell, home-gateway, home-brain … */
export const resourceName = (h: Household, what: string): string => `${h.resourcePrefix}-${what}`;

export const publicUrl = (h: Household): string => `https://${h.domain}`;
