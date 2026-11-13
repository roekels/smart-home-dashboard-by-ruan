import { html, mount, raw, $, $$, type Raw } from "../../html.ts";
import { icon } from "../../icons.ts";
import { call, who } from "../../api.ts";
import { t } from "../../i18n.ts";
import type { UiModule } from "../../modules.ts";
import { cap, day, todayIso, useStyles } from "../fmt.ts";

// /dashboard/health (Metrics > Health): doctor visits, test results, vaccinations and medication, one person at a time.
// Data: /api/health (modules/health), sealed at rest. Each person sees their own records, an admin everyone's.
// Most records come in through an AI app (/health/mcp on the gateway); the page shows them and takes quick edits.
// Tabs: Overview · Tests (every value across reports) · Vaccinations · Visits · Medication.

type Type = "visit" | "test" | "vaccination" | "medication";
interface Rec { id: string; person: string; type: Type; date: string; data: Record<string, any>; archived: number | null }
interface FieldSpec { t: "text" | "date" | "enum" | "meds" | "results" | "visit"; max?: number; of?: string[]; required?: boolean; what: string }
interface Schema { people: string[]; fields: Record<Type, Record<string, FieldSpec>>; locked: boolean }
interface Point { date: string; test: string; value: string; num: number | null; flag: "low" | "high" | null }
interface Series { name: string; group?: string; unit?: string; low?: number; high?: number; ref?: string; points: Point[] }
interface Due { id: string; for: string; due: string; overdue: boolean }
interface CurrentMed { id: string; name: string; for: string | null; dose: string | null; schedule: string | null; since: string; until: string | null }
interface PersonOverview {
  counts: Record<Type, number>; vaccinations_due: Due[]; current_meds: CurrentMed[];
  last_test: { id: string; date: string; title: string; flagged: { name: string; value: string; unit?: string; flag: string }[] } | null;
  recent_visits: { id: string; date: string; what: string; who?: string; follow_up: string | null; healthy_on: string | null }[];
}

const get = <T>(p: string) => call<T>("GET", `/health${p}`);
const post = <T>(p: string, body: unknown) => call<T>("POST", `/health${p}`, body);

const TABS = (): { id: string; label: string }[] => [
  { id: "overview", label: t("Overview") }, { id: "tests", label: t("Tests") }, { id: "vaccinations", label: t("Vaccinations") }, { id: "visits", label: t("Visits") },
  { id: "meds", label: t("Medication") },
];
const NEW: Record<Type, () => string> = { visit: () => t("New visit"), test: () => t("New test"), vaccination: () => t("New vaccination"), medication: () => t("New medication") };
const EDIT: Record<Type, () => string> = { visit: () => t("Edit visit"), test: () => t("Edit test"), vaccination: () => t("Edit vaccination"), medication: () => t("Edit medication") };
/** Field names on the form (the schema's keys). Unknown keys show as they are. */
const FIELD = (): Record<string, string> => ({
  for: t("For"), vaccine: t("Vaccine"), dose: t("Dose"), due: t("Due again"), given_by: t("Given by"), notes: t("Notes"), source: t("Source"),
  what: t("What"), who: t("Who"), why: t("Why"), outcome: t("Outcome"), meds: t("Medication"), follow_up: t("Follow-up"), healthy_on: t("Healthy again"),
  cost: t("Cost"), kind: t("Kind"), title: t("Title"), lab: t("Lab"), results: t("Results"), name: t("Medicine"), schedule: t("How often"),
  until: t("Until"), effects: t("Effects"), prescribed_by: t("Prescribed by"), visit: t("Visit"),
});
const KIND = (k: string): string => ({ blood: t("blood"), urine: t("urine"), allergy: t("allergy"), stool: t("stool"), imaging: t("imaging"), other: t("other") } as Record<string, string>)[k] ?? k;
const FLAG = (f: string): string => (f === "high" ? t("high") : f === "low" ? t("low") : f);

/** A text field of a record, or "" when it is empty. */
const tx = (data: Record<string, any> | undefined, k: string): string => data?.[k] ?? "";
const nameOf = (id: string): string => who.people.find((p) => p.id === id)?.name ?? cap(id);

let schema: Schema | null = null;
let person = "";
let tab = "overview";
let records: Rec[] = [];
let series: Series[] = [];
let ov: PersonOverview | null = null;

// ---------------------------------------------------------------- frame

function view(): Raw {
  useStyles("data");
  return html`
  <header class="page-head fin-head">
    <div><h1 class="h1">${t("Health")}</h1><p class="muted">${t("Doctor visits, test results, vaccinations and medication. Encrypted in the database. An AI app you connected can add records through the health connector.")}</p></div>
    <div class="page-head__actions">
      <div class="seg-pick hl-who" role="group" aria-label="${t("Whose")}" id="hl-who"></div>
      <button class="btn btn--line btn--sm" data-add="vaccination">${icon("plus")}${t("Vaccination")}</button>
      <button class="btn btn--line btn--sm" data-add="visit">${icon("plus")}${t("Visit")}</button>
      <button class="btn btn--line btn--sm" data-add="test">${icon("plus")}${t("Test")}</button>
      <button class="btn btn--line btn--sm" data-add="medication">${icon("plus")}${t("Medication")}</button>
    </div>
  </header>
  <div class="fin-tabs-row"><div class="tabs" role="tablist" aria-label="${t("Health")}" id="hl-tabs"></div></div>
  <div id="hl-body" class="fin-body"><p class="muted small">${t("Loading …")}</p></div>
  <dialog id="hl-dlg" class="fin-dialog" aria-labelledby="hl-dlg-h"></dialog>`;
}

function init(): void {
  schema = null; person = "";
  $$<HTMLButtonElement>("[data-add]").forEach((b) => b.addEventListener("click", () => form(b.dataset.add as Type, null)));
  void load();
}

async function load(): Promise<void> {
  try {
    schema ??= await get<Schema>("/schema");
    if (!person) person = schema.people.includes(who.person.id) ? who.person.id : schema.people[0] ?? "";
    if (schema.locked) {
      mount($("#hl-body")!, html`<section class="card fin-empty"><p>${t("Health records are locked: the secret HEALTH_DATA_ENCRYPTION_KEY is not set on the dashboard Worker yet.")}</p></section>`);
      return;
    }
    const q = `person=${encodeURIComponent(person)}`;
    const [r, tr, o] = await Promise.all([get<{ records: Rec[] }>(`/records?${q}`), get<{ series: Series[] }>(`/trends?${q}`), get<Record<string, PersonOverview>>(`/overview?${q}`)]);
    records = r.records; series = tr.series; ov = o[person] ?? null;
    draw();
  } catch (e) {
    const box = $("#hl-body");
    if (box) mount(box, html`<section class="card fin-empty"><p>${t("Health could not load: {error}", { error: (e as Error).message })}</p></section>`);
  }
}

function draw(): void {
  const box = $("#hl-body");
  if (!box || !schema) return;
  mount($("#hl-who")!, html`${schema.people.map((p) => html`<button data-person="${p}" class="${p === person ? "on" : ""}" aria-pressed="${String(p === person)}">${nameOf(p)}</button>`)}`);
  $$<HTMLButtonElement>("#hl-who [data-person]").forEach((b) => b.addEventListener("click", () => { person = b.dataset.person!; void load(); }));
  mount($("#hl-tabs")!, html`${TABS().map((x) => html`<button role="tab" data-tab="${x.id}" aria-selected="${String(x.id === tab)}">${x.label}</button>`)}`);
  $$<HTMLButtonElement>("#hl-tabs [data-tab]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab!; draw(); }));
  if (tab === "tests") mount(box, testsTab());
  else if (tab === "vaccinations") mount(box, vaccTab());
  else if (tab === "visits") mount(box, visitsTab());
  else if (tab === "meds") mount(box, medsTab());
  else mount(box, overviewTab());
  $$<HTMLElement>("[data-open]", box).forEach((el) => el.addEventListener("click", () => {
    const r = records.find((x) => x.id === el.dataset.open);
    if (r) form(r.type, r);
  }));
}

const empty = (what: string): Raw => html`<p class="muted small fin-pad">${what}</p>`;
const dueTone = (d: string | undefined): string => (!d ? "" : d < todayIso() ? "tone-rose" : d <= addDays(todayIso(), 90) ? "tone-amber" : "");
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- overview

function overviewTab(): Raw {
  const o = ov;
  if (!o) return empty(t("Nothing yet."));
  return html`
  <div class="kpis fin-kpis">
    <div class="card kpi"><span class="chip-ic">${icon("activity")}</span><div><b class="num">${o.counts.test}</b><small>${t("Test reports")}</small></div></div>
    <div class="card kpi"><span class="chip-ic">${icon("shield")}</span><div><b class="num">${o.counts.vaccination}</b><small>${t("Vaccinations")}</small></div></div>
    <div class="card kpi"><span class="chip-ic">${icon("user")}</span><div><b class="num">${o.counts.visit}</b><small>${t("Doctor visits")}</small></div></div>
    <div class="card kpi"><span class="chip-ic">${icon("pill")}</span><div><b class="num">${o.current_meds.length}</b><small>${t("Taking now")}</small></div></div>
  </div>
  <div class="fin-split">
    <section class="card fin-panel">
      <div class="h2-row"><h2 class="h2">${icon("clock")}${t("Vaccinations due")}</h2><span class="muted small">${t("overdue or next 90 days")}</span></div>
      ${o.vaccinations_due.length ? html`<div class="table-wrap"><table class="table"><tbody>
        ${o.vaccinations_due.map((d) => html`<tr class="hl-click" data-open="${d.id}"><td>${tx(d as any, "for")}</td><td class="r ${d.overdue ? "tone-rose" : "tone-amber"}">${d.overdue ? t("overdue since {date}", { date: day(d.due) }) : day(d.due)}</td></tr>`)}
      </tbody></table></div>` : empty(t("Nothing due."))}
    </section>
    <section class="card fin-panel">
      <div class="h2-row"><h2 class="h2">${icon("activity")}${t("Last test")}${o.last_test ? `, ${day(o.last_test.date)}` : ""}</h2>${o.last_test ? html`<span class="count">${t("{n} outside range", { n: o.last_test.flagged.length })}</span>` : ""}</div>
      ${!o.last_test ? empty(t("No tests yet.")) : o.last_test.flagged.length ? html`<div class="table-wrap"><table class="table"><tbody>
        ${o.last_test.flagged.map((f) => html`<tr><td>${f.name}</td><td class="r num tone-rose">${f.value} ${f.unit ?? ""}</td><td class="muted">${FLAG(f.flag)}</td></tr>`)}
      </tbody></table></div>` : empty(t("Everything inside the reference ranges."))}
    </section>
  </div>
  <section class="card fin-panel">
    <div class="h2-row"><h2 class="h2">${icon("pill")}${t("Taking now")}</h2><span class="muted small">${t("medication without a stop date")}</span></div>
    ${o.current_meds.length ? html`<div class="table-wrap"><table class="table"><tbody>
      ${o.current_meds.map((m) => html`<tr class="hl-click" data-open="${m.id}"><td>${tx(m as any, "name")}</td><td>${tx(m as any, "for")}</td><td class="muted">${[m.dose, m.schedule].filter(Boolean).join(", ")}</td>
        <td class="muted">${t("since {date}", { date: day(m.since) })}${m.until ? `, ${t("until {date}", { date: day(m.until) })}` : ""}</td></tr>`)}
    </tbody></table></div>` : empty(t("No medication right now."))}
  </section>
  <section class="card fin-panel">
    <div class="h2-row"><h2 class="h2">${icon("user")}${t("Recent visits")}</h2></div>
    ${o.recent_visits.length ? html`<div class="table-wrap"><table class="table"><tbody>
      ${o.recent_visits.map((v) => html`<tr class="hl-click" data-open="${v.id}"><td class="muted">${day(v.date)}</td><td>${tx(v as any, "what")}</td><td>${v.who ?? ""}</td>
        <td class="muted">${v.healthy_on ? t("healthy {date}", { date: day(v.healthy_on) }) : v.follow_up ? t("follow-up: {what}", { what: tx(v as any, "follow_up") }) : ""}</td></tr>`)}
    </tbody></table></div>` : empty(t("No visits yet."))}
  </section>`;
}

// ---------------------------------------------------------------- tests: every value across reports

function spark(s: Series): Raw {
  const pts = s.points.filter((p) => p.num !== null);
  if (pts.length < 2) return html``;
  const nums = pts.map((p) => p.num!);
  const lo = Math.min(...nums, s.low ?? Infinity), hi = Math.max(...nums, s.high ?? -Infinity);
  const y = (v: number) => (hi === lo ? 10 : 18 - ((v - lo) / (hi - lo)) * 16);
  const x = (i: number) => 2 + (i / (pts.length - 1)) * 56;
  const band = s.low !== undefined && s.high !== undefined ? `<rect x="0" width="60" y="${y(s.high)}" height="${Math.max(0, y(s.low) - y(s.high))}" class="hl-band"/>` : "";
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.num!).toFixed(1)}`).join("");
  const dots = pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.num!).toFixed(1)}" r="1.8" class="${p.flag ? "hl-dot--off" : "hl-dot"}"/>`).join("");
  // numbers and fixed class names only: safe to insert as markup
  return raw(`<svg class="hl-spark" viewBox="0 0 60 20" aria-hidden="true">${band}<path d="${line}" class="hl-line"/>${dots}</svg>`);
}

function range(s: Series): string {
  if (s.low !== undefined && s.high !== undefined) return `${s.low}–${s.high}`;
  if (s.high !== undefined) return `< ${s.high}`;
  if (s.low !== undefined) return `> ${s.low}`;
  return s.ref ?? "";
}

function testsTab(): Raw {
  const tests = records.filter((r) => r.type === "test").slice().reverse();
  if (!tests.length) return html`<section class="card fin-empty">${empty(t("No tests yet. Ask your AI app to file a lab report, or add one with + Test."))}</section>`;
  const groups = [...new Set(series.map((s) => s.group ?? ""))];
  return html`<section class="card fin-panel"><div class="table-wrap"><table class="table hl-trend">
    <thead><tr><th>${t("Value")}</th><th>${t("Unit")}</th><th>${t("Range")}</th><th>${t("Trend")}</th>
      ${tests.map((x) => html`<th class="r"><button class="hl-link" data-open="${x.id}" title="${tx(x.data, "title") || KIND(x.data.kind)}">${day(x.date)}</button></th>`)}</tr></thead>
    ${groups.map((g) => html`<tbody>
      ${g ? html`<tr class="hl-group"><td colspan="${4 + tests.length}">${g}</td></tr>` : ""}
      ${series.filter((s) => (s.group ?? "") === g).map((s) => html`<tr><td>${s.name}</td><td class="muted">${s.unit ?? ""}</td><td class="muted">${range(s)}</td><td>${spark(s)}</td>
        ${tests.map((x) => {
          const p = s.points.find((y) => y.test === x.id);
          return html`<td class="r num${p?.flag ? " tone-rose" : ""}" title="${p?.flag ? FLAG(p.flag) : ""}">${p ? p.value : html`<span class="faint">·</span>`}</td>`;
        })}</tr>`)}
    </tbody>`)}
  </table></div></section>`;
}

// ---------------------------------------------------------------- vaccinations and visits

function vaccTab(): Raw {
  const v = records.filter((r) => r.type === "vaccination");
  if (!v.length) return html`<section class="card fin-empty">${empty(t("No vaccinations yet."))}</section>`;
  return html`<section class="card fin-panel"><div class="table-wrap"><table class="table">
    <thead><tr><th>${t("For")}</th><th>${t("Vaccine")}</th><th>${t("Dose")}</th><th>${t("Given")}</th><th>${t("Due again")}</th><th>${t("Where")}</th></tr></thead>
    <tbody>${v.map((r) => html`<tr class="hl-click" data-open="${r.id}"><td>${tx(r.data, "for")}</td><td>${r.data.vaccine ?? ""}</td><td class="muted">${tx(r.data, "dose")}</td>
      <td class="muted">${day(r.date)}</td><td class="${dueTone(r.data.due)}">${r.data.due ? day(r.data.due) : html`<span class="faint">–</span>`}</td><td class="muted">${tx(r.data, "given_by")}</td></tr>`)}</tbody>
  </table></div></section>`;
}

function visitsTab(): Raw {
  const v = records.filter((r) => r.type === "visit");
  if (!v.length) return html`<section class="card fin-empty">${empty(t("No visits yet."))}</section>`;
  return html`<section class="card fin-panel"><div class="table-wrap"><table class="table hl-visits">
    <thead><tr><th>${t("Date")}</th><th>${t("What")}</th><th>${t("Who")}</th><th>${t("Why")}</th><th>${t("Outcome")}</th><th>${t("Medication")}</th><th>${t("Healthy")}</th></tr></thead>
    <tbody>${v.map((r) => html`<tr class="hl-click" data-open="${r.id}"><td class="muted">${day(r.date)}</td><td>${tx(r.data, "what")}</td><td>${r.data.who ?? ""}</td>
      <td class="hl-wrap">${tx(r.data, "why")}</td><td class="hl-wrap">${tx(r.data, "outcome")}</td>
      <td class="hl-wrap">${[...(r.data.meds ?? []).map((m: any) => m.name + (m.dose ? ` (${m.dose})` : "")), ...records.filter((m) => m.type === "medication" && m.data.visit === r.id).map((m) => tx(m.data, "name"))].join(", ")}</td>
      <td class="muted">${r.data.healthy_on ? day(r.data.healthy_on) : r.data.follow_up ? t("follow-up: {what}", { what: tx(r.data, "follow_up") }) : ""}</td></tr>`)}</tbody>
  </table></div></section>`;
}

function medsTab(): Raw {
  const now = todayIso();
  const m = records.filter((r) => r.type === "medication")
    .sort((a, b) => Number(!!a.data.until && a.data.until < now) - Number(!!b.data.until && b.data.until < now) || b.date.localeCompare(a.date));
  if (!m.length) return html`<section class="card fin-empty">${empty(t("No medication yet. Add one with + Medication, or ask your AI app."))}</section>`;
  const visit = (id?: string) => records.find((r) => r.id === id);
  return html`<section class="card fin-panel"><div class="table-wrap"><table class="table hl-visits">
    <thead><tr><th>${t("Medicine")}</th><th>${t("For")}</th><th>${t("Dose")}</th><th>${t("How often")}</th><th>${t("Since")}</th><th>${t("Until")}</th><th>${t("Effects")}</th><th>${t("Prescribed")}</th></tr></thead>
    <tbody>${m.map((r) => {
      const v = visit(r.data.visit), done = !!r.data.until && r.data.until < now;
      return html`<tr class="hl-click${done ? " faint" : ""}" data-open="${r.id}"><td>${tx(r.data, "name")}</td><td>${tx(r.data, "for")}</td><td class="muted">${tx(r.data, "dose")}</td>
        <td class="muted">${tx(r.data, "schedule")}</td><td class="muted">${day(r.date)}</td><td class="muted">${r.data.until ? day(r.data.until) : t("still taking")}</td>
        <td class="hl-wrap">${tx(r.data, "effects")}</td><td class="muted">${v ? `${tx(v.data, "what")}, ${day(v.date)}` : tx(r.data, "prescribed_by")}</td></tr>`;
    })}</tbody>
  </table></div></section>`;
}

// ---------------------------------------------------------------- add / edit

/** Medication as lines: "name; dose; until". Results as lines: "name; value; unit; low-high or ref; group". */
const medsToText = (m: any[] = []) => m.map((x) => [x.name, x.dose ?? "", x.until ?? ""].join("; ").replace(/(; )+$/, "")).join("\n");
function textToMeds(s: string) {
  return s.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, dose, until] = l.split(";").map((x) => x.trim());
    return { name, ...(dose ? { dose } : {}), ...(until ? { until } : {}) };
  });
}
const resultsToText = (r: any[] = []) => r.map((x) => [x.name, x.value, x.unit ?? "", x.low !== undefined || x.high !== undefined ? `${x.low ?? ""}-${x.high ?? ""}` : x.ref ?? "", x.group ?? ""].join("; ").replace(/(; )+$/, "")).join("\n");
function textToResults(s: string) {
  return s.split("\n").map((l) => l.trim()).filter(Boolean).map((l, i) => {
    const [name, value, unit, rng, group] = l.split(";").map((x) => x.trim());
    if (!name || !value) throw new Error(t("Results line {n}: needs at least \"name; value\"", { n: i + 1 }));
    const out: Record<string, unknown> = { name, value };
    if (unit) out.unit = unit;
    if (group) out.group = group;
    const m = rng ? /^(-?[\d.,]*)\s*-\s*(-?[\d.,]*)$/.exec(rng) : null;
    if (m && (m[1] || m[2])) {
      if (m[1]) out.low = Number(m[1].replace(",", "."));
      if (m[2]) out.high = Number(m[2].replace(",", "."));
    } else if (rng) out.ref = rng;
    return out;
  });
}

function form(type: Type, row: Rec | null): void {
  if (!schema) return;
  const d = $<HTMLDialogElement>("#hl-dlg")!;
  const fields = Object.entries(schema.fields[type]);
  const v = (k: string) => row?.data[k];
  const input = (k: string, f: FieldSpec): Raw => {
    const id = `hf-${k}`, req = f.required ? "required" : "";
    let control: Raw;
    if (f.t === "date") control = html`<input type="date" id="${id}" value="${v(k) ?? ""}" ${req}>`;
    else if (f.t === "enum") control = html`<select id="${id}" ${req}>${f.of!.map((o) => html`<option value="${o}" ${o === v(k) ? "selected" : ""}>${k === "kind" ? KIND(o) : o}</option>`)}</select>`;
    else if (f.t === "visit") {
      const visits = records.filter((r) => r.type === "visit");
      control = html`<select id="${id}"><option value="">–</option>${visits.map((r) => html`<option value="${r.id}" ${r.id === v(k) ? "selected" : ""}>${day(r.date)} · ${r.data.what}${r.data.who ? ` · ${r.data.who}` : ""}</option>`)}</select>`;
    } else if (f.t === "meds") control = html`<textarea id="${id}" rows="3" placeholder="${t("name; dose; until (one per line)")}">${medsToText(v(k))}</textarea>`;
    else if (f.t === "results") control = html`<textarea id="${id}" rows="8" class="hl-mono" placeholder="${t("name; value; unit; low-high; group (one per line)")}">${resultsToText(v(k))}</textarea>`;
    else if ((f.max ?? 0) > 300) control = html`<textarea id="${id}" rows="2" maxlength="${f.max}">${v(k) ?? ""}</textarea>`;
    else control = html`<input id="${id}" value="${v(k) ?? ""}" maxlength="${f.max ?? 200}" ${req}>`;
    const wide = f.t === "meds" || f.t === "results" || (f.max ?? 0) > 300;
    return html`<label class="fin-field${wide ? " fin-field--wide" : ""}" title="${f.what}"><span>${FIELD()[k] ?? cap(k.replace(/_/g, " "))}${f.required ? " *" : ""}</span>${control}</label>`;
  };
  mount(d, html`<form class="fin-form" id="hl-form" novalidate>
    <h3 id="hl-dlg-h">${row ? EDIT[type]() : NEW[type]()}, ${nameOf(row?.person ?? person)}</h3>
    <div class="fin-fields">
      <label class="fin-field"><span>${type === "medication" ? t("Started") : t("Date")} *</span><input type="date" id="hf-date" value="${row?.date ?? todayIso()}" required></label>
      ${fields.map(([k, f]) => input(k, f))}
    </div>
    <p class="fin-err tone-rose small" id="hl-err" hidden></p>
    <div class="fin-form__btns">
      ${row ? html`<button type="button" class="btn btn--line fin-archive" id="hl-archive">${row.archived ? t("Restore") : t("Archive")}</button>` : ""}
      <button type="button" class="btn btn--line" id="hl-cancel">${t("Cancel")}</button>
      <button type="submit" class="btn btn--ink">${t("Save")}</button>
    </div>
  </form>`);
  const err = (m: string) => { const p = $("#hl-err", d)!; p.hidden = false; p.textContent = m; };
  $("#hl-cancel", d)!.addEventListener("click", () => d.close());
  $("#hl-archive", d)?.addEventListener("click", async () => {
    try { await post(`/records/${encodeURIComponent(row!.id)}/archive`, { archived: !row!.archived }); d.close(); await load(); } catch (e) { err((e as Error).message); }
  });
  $<HTMLFormElement>("#hl-form", d)!.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const data: Record<string, unknown> = {};
      for (const [k, f] of fields) {
        const text = ($<HTMLInputElement>(`#hf-${k}`, d)!.value ?? "").trim();
        let val: unknown = text === "" ? (row ? null : undefined) : text;
        if (text && f.t === "meds") val = textToMeds(text);
        if (text && f.t === "results") val = textToResults(text);
        if (val === undefined) continue;
        if (row && JSON.stringify(val ?? null) === JSON.stringify(row.data[k] ?? null)) continue;
        if (row && val === null && row.data[k] === undefined) continue;
        data[k] = val;
      }
      const date = $<HTMLInputElement>("#hf-date", d)!.value;
      if (row) await post(`/records/${encodeURIComponent(row.id)}`, { ...(date !== row.date ? { date } : {}), data });
      else await post("/records", { type, person, date, data });
      d.close();
      await load();
    } catch (x) {
      err((x as Error).message);
    }
  });
  d.showModal();
}

export const healthUi: UiModule = { id: "health", pages: { "/dashboard/health": { title: "Health", view, init } } };
