import { html, mount, $, $$, raw, type Raw } from "../../html.ts";
import { icon } from "../../icons.ts";
import { call, who } from "../../api.ts";
import { t, n, loc } from "../../i18n.ts";
import type { UiModule } from "../../modules.ts";
import { cap, day, money, parseMoney, todayIso, useStyles, words } from "../fmt.ts";

// /dashboard/finance (Metrics > Finance): what we have, what is coming up, and one tab per flat or car.
// Data: /api/finance (modules/finance), encrypted at rest, admins only. Values are dated rows: "Update balances" adds
// today's numbers, it never overwrites. Forms are built from the Worker's own field list (GET /api/finance/schema),
// so a new column needs no change here. Tabs: Overview · one per property or vehicle · Records. The tab is in the hash.

type Row = Record<string, any> & { id: string };
interface FieldSpec { t: string; of?: string[]; to?: string; req?: boolean; max?: number; min?: number; when?: { field: string; is: string[] } }
interface Schema { tables: Record<string, { prefix: string; dated: boolean; fields: Record<string, FieldSpec> }>; categories: string[]; owners: string[]; currencies: string[]; base: string; locked: boolean }
type Group = "cash" | "investments" | "property" | "car" | "debts";
interface Line { subject_kind: string; id: string; name: string; group: Group; owner: string; base: number | null; amount_cents: number; currency: string; as_of: string | null; source: string | null;
  kind?: string; parent?: { id: string; name: string }; secured?: { id: string; name: string; base: number | null; as_of: string | null }; merged?: boolean }
interface Due { title: string; due: string; kind: string; source: "deadline" | "contract"; id: string; asset_id: string | null; amount_cents: number | null; currency: string | null }
interface Overview {
  today: string; base: string; lines: Line[]; totals: Record<Group | "net", number>; byOwner: Record<string, number>; unconverted: number;
  upcoming: Due[]; assets: Row[]; rates: { date: string; currency: string; per_eur: number }[]; owners: string[];
}
interface Point { date: string; net: number; byOwner: Record<string, number> }

const get = <T>(p: string) => call<T>("GET", `/finance${p}`);
const post = <T>(p: string, body: unknown) => call<T>("POST", `/finance${p}`, body);
const fin = {
  overview: () => get<Overview>("/overview?days=120"),
  history: () => get<{ points: Point[] }>("/history"),
  schema: () => get<Schema>("/schema"),
  list: (table: string, q = "") => get<Record<string, Row[]>>(`/${table}${q}`).then((r) => r[table] ?? []),
  create: (table: string, body: Record<string, unknown>) => post<{ id: string }>(`/${table}`, body),
  update: (table: string, id: string, body: Record<string, unknown>) => post<{ ok: boolean }>(`/${table}/${encodeURIComponent(id)}`, body),
  archive: (table: string, id: string, archived = true) => post<{ ok: boolean }>(`/${table}/${encodeURIComponent(id)}/archive`, { archived }),
  balances: (as_of: string, items: { subject_kind: string; subject_id: string; amount_cents: number; currency: string }[]) => post<{ ids: string[] }>("/valuations/batch", { as_of, items }),
  done: (id: string) => post<{ ok: boolean; next: string | null }>(`/deadlines/${encodeURIComponent(id)}/done`, {}),
};

const GROUPS: { id: Group; icon: string }[] = [
  { id: "cash", icon: "wallet" }, { id: "investments", icon: "graph" }, { id: "property", icon: "home" }, { id: "car", icon: "car" }, { id: "debts", icon: "alert" },
];
const groupLabel = (g: Group): string => ({ cash: t("Cash"), investments: t("Investments"), property: t("Property"), car: t("Vehicles"), debts: t("Debts") })[g];

let ov: Overview | null = null;
let points: Point[] = [];
let schema: Schema | null = null;
let owner = "all";
const refCache = new Map<string, Promise<Row[]>>();

const ROLE = (): Record<string, string> => ({ owned_let: t("Owned, let out"), owned_home: t("Owned home"), rented_home: t("Rented home"), owned: t("Owned"), leased: t("Leased") });
/** What the Records tab lists and the columns it shows. */
const RECORDS: { table: string; label: string; cols: string[] }[] = [
  { table: "accounts", label: "Accounts", cols: ["name", "kind", "owner", "currency", "last4"] },
  { table: "holdings", label: "Holdings", cols: ["name", "kind", "symbol", "owner", "quantity"] },
  { table: "assets", label: "Assets", cols: ["name", "kind", "role", "owner"] },
  { table: "contracts", label: "Contracts", cols: ["name", "kind", "owner", "ends", "amount_cents", "every"] },
  { table: "deadlines", label: "Deadlines", cols: ["due", "title", "kind", "repeat", "done"] },
  { table: "transactions", label: "Transactions", cols: ["date", "amount_cents", "category", "owner", "description"] },
  { table: "asset_events", label: "Logbook", cols: ["date", "asset_id", "title", "kind"] },
  { table: "valuations", label: "Values", cols: ["as_of", "subject_kind", "amount_cents", "source"] },
  { table: "documents", label: "Documents", cols: ["date", "title", "kind", "amount_cents"] },
  { table: "tax_years", label: "Taxes", cols: ["year", "person", "kind", "status"] },
  { table: "institutions", label: "Institutions", cols: ["name", "kind", "country"] },
];
/** The Records tabs in the page's language. */
const recLabel = (table: string, en: string): string => ({
  accounts: t("Accounts"), holdings: t("Holdings"), assets: t("Assets"), contracts: t("Contracts"), deadlines: t("Deadlines"), transactions: t("Transactions"),
  asset_events: t("Logbook"), valuations: t("Values"), documents: t("Documents"), tax_years: t("Taxes"), institutions: t("Institutions"),
} as Record<string, string>)[table] ?? en;

/** The open tab is in the hash (#as_…), so a reload or a shared link opens the same one. */
const tabOf = (): string => decodeURIComponent(location.hash.replace(/^#/, "")) || "overview";
function setTab(id: string): void {
  history.replaceState(null, "", `${location.pathname}${location.search}${id === "overview" ? "" : `#${id}`}`);
}
const ownerName = (o: string) => (o === "joint" ? t("Joint") : who.people.find((p) => p.id === o)?.name ?? cap(o));
/** An amount in the household's own currency, whole units. */
const eur = (c: number | null | undefined) => money(c, ov?.base ?? schema?.base ?? "EUR", true);

// ---------------------------------------------------------------- frame

function view(): Raw {
  useStyles("data");
  return html`
  <header class="page-head fin-head">
    <h1 class="h1">${t("Finance")}</h1>
    <div class="page-head__actions">
      <button class="icon-btn icon-btn--line" id="fin-add" title="${t("Fill in a form by hand")}" aria-label="${t("By hand")}">${icon("plus")}</button>
      <button class="btn btn--ink" id="fin-bal">${icon("edit")}${t("Update balances")}</button>
    </div>
  </header>
  <div class="fin-tabs-row"><div class="tabs" role="tablist" aria-label="${t("Finance")}" id="fin-tabs"></div></div>
  <div id="fin-body" class="fin-body"><p class="muted small">${t("Loading …")}</p></div>
  <dialog id="fin-dlg" class="fin-dialog" aria-labelledby="fin-dlg-h"></dialog>`;
}

function init(): void {
  ov = null; schema = null; owner = "all";
  $("#fin-bal")!.addEventListener("click", () => void balancesDialog());
  $("#fin-add")!.addEventListener("click", () => void addPicker());
  window.addEventListener("hashchange", onHash);
  void load();
}

function leave(): void {
  window.removeEventListener("hashchange", onHash);
}

function onHash(): void {
  if ($("#fin-body")) draw();
}

async function load(): Promise<void> {
  try {
    schema ??= await fin.schema();
    if (schema.locked) {
      mount($("#fin-body")!, html`<section class="card fin-empty"><p>${t("Finance is locked: the secret FINANCE_DATA_ENCRYPTION_KEY is not set on the dashboard Worker yet.")}</p></section>`);
      return;
    }
    [ov, { points }] = await Promise.all([fin.overview(), fin.history()]);
    refCache.clear();
    draw();
  } catch (e) {
    const box = $("#fin-body");
    if (box) mount(box, html`<section class="card fin-empty"><p>${t("Finance could not load: {error}", { error: (e as Error).message })}</p></section>`);
  }
}

function tabs(): { id: string; label: string }[] {
  const assets = (ov?.assets ?? []).filter((a) => a.kind === "property" || a.kind === "vehicle");
  return [{ id: "overview", label: t("Overview") }, ...assets.map((a) => ({ id: a.id, label: a.name })), { id: "records", label: t("Records") }];
}

function draw(): void {
  const box = $("#fin-body");
  if (!box || !ov) return;
  const list = tabs(), cur = list.some((x) => x.id === tabOf()) ? tabOf() : "overview";
  mount($("#fin-tabs")!, html`${list.map((x) => html`<button role="tab" data-tab="${x.id}" aria-selected="${String(x.id === cur)}">${x.label}</button>`)}`);
  $$<HTMLButtonElement>("#fin-tabs [data-tab]").forEach((b) => b.addEventListener("click", () => {
    setTab(b.dataset.tab!);
    draw();
  }));
  if (cur === "overview") overview(box);
  else if (cur === "records") void records(box);
  else void assetTab(box, ov.assets.find((a) => a.id === cur)!);
}

// ---------------------------------------------------------------- overview

function mine(l: { owner: string }): boolean {
  return owner === "all" || l.owner === owner;
}

function overview(box: HTMLElement): void {
  const o = ov!;
  const lines = o.lines.filter(mine);
  const sum = (g: string) => lines.filter((l) => l.group === g && l.base !== null).reduce((a, l) => a + (l.base ?? 0), 0);
  const net = lines.reduce((a, l) => a + (l.base ?? 0), 0);
  const oldest = (g: string) => lines.filter((l) => l.group === g && l.as_of).map((l) => l.as_of!).sort()[0];
  const series = points.map((p) => ({ date: p.date, v: owner === "all" ? p.net : p.byOwner[owner] ?? 0 }));
  mount(box, html`
  <section class="card fin-hero">
    <div class="fin-hero__top">
      <div>
        <small class="muted">${t("Net worth")}${owner === "all" ? "" : `, ${ownerName(owner)}`}</small>
        <b class="fin-big num">${eur(net)}</b>
        <small class="muted">${o.rates.length ? t("ECB rates per EUR: {rates}", { rates: o.rates.map((r) => `${r.currency} ${r.per_eur.toFixed(4)} (${day(r.date)})`).join(", ") }) : ""}${o.unconverted ? ` · ${t("{n} value(s) not converted: no exchange rate yet", { n: o.unconverted })}` : ""}</small>
      </div>
      <div class="tabs fin-who" role="tablist" aria-label="${t("Whose")}">
        ${["all", ...o.owners].map((w) => html`<button role="tab" data-owner="${w}" aria-selected="${String(w === owner)}">${w === "all" ? t("All") : ownerName(w)}</button>`)}
      </div>
    </div>
    <div class="fin-chart" id="fin-chart">${chart(series)}</div>
  </section>
  <div class="kpis fin-kpis">
    ${GROUPS.map((g) => html`<div class="card kpi"><span class="chip-ic">${icon(g.icon)}</span><div>
      <b class="num${g.id === "debts" && sum(g.id) < 0 ? " tone-rose" : ""}">${eur(sum(g.id))}</b><small>${groupLabel(g.id)}</small>
      <small class="kpi__sub">${oldest(g.id) ? t("oldest value {date}", { date: day(oldest(g.id)) }) : t("nothing entered")}</small></div></div>`)}
  </div>
  <div class="fin-split fin-split--main">
    <section class="card fin-panel">
      <div class="h2-row"><h2 class="h2">${icon("wallet")}${t("Accounts and values")}</h2><span class="count">${lines.length}</span></div>
      ${linesTable(lines)}
    </section>
    <section class="card fin-panel">
      <div class="h2-row"><h2 class="h2">${icon("clock")}${t("Coming up")}</h2><span class="muted small">${t("next 120 days")}</span></div>
      ${dueList(o.upcoming)}
    </section>
  </div>`);
  $$<HTMLButtonElement>("[data-owner]", box).forEach((b) => b.addEventListener("click", () => { owner = b.dataset.owner!; overview(box); }));
  bindDue(box);
  bindChart();
}

function linesTable(all: Line[]): Raw {
  // a loan on an owned asset shows as one line (the asset still counts in the totals)
  const lines = all.filter((l) => !l.merged);
  if (!lines.length) return html`<p class="muted small fin-pad">${t("No accounts yet. Add one with +, then use Update balances.")}</p>`;
  const sub = (l: Line) => {
    const s = l.secured;
    if (!s || s.base === null || l.base === null) return "";
    return html`<small class="muted fin-sub">${t("worth {value} · equity {equity}", { value: eur(s.base), equity: eur(s.base + l.base) })}</small>`;
  };
  const value = (l: Line) => html`${l.currency !== ov!.base ? html`<span class="muted">${money(l.amount_cents, l.currency, true)}</span> ` : ""}${l.base === null ? "–" : eur(l.base)}`;
  const when = (l: Line) => (l.as_of ? day(l.as_of) : t("no value yet")) + (l.source === "estimate" ? ` (${t("estimate")})` : "");
  const row = (l: Line, cls = "") => html`<tr class="${cls}">
    <td>${cls ? "" : html`<span class="fin-dot fin-dot--${l.group}"></span>`}${l.name}${sub(l)}</td><td>${ownerName(l.owner)}</td>
    <td class="r num${(l.base ?? 0) < 0 ? " tone-rose" : ""}">${value(l)}</td><td class="muted">${when(l)}</td></tr>`;
  const total = (ls: Line[]) => ls.reduce((a, l) => a + (l.base ?? 0), 0);
  // each group under its own heading; investments by where they are held, the holdings under their platform
  return html`<div class="table-wrap"><table class="table fin-table">
    <thead><tr><th>${t("Name")}</th><th>${t("Whose")}</th><th class="r">${t("Value")}</th><th>${t("As of")}</th></tr></thead>
    ${GROUPS.map((g) => {
      const ls = lines.filter((l) => l.group === g.id);
      if (!ls.length) return "";
      const blocks = new Map<string, { name: string; items: Line[] }>();
      const single: Line[] = [];
      for (const l of ls) {
        if (!l.parent) { single.push(l); continue; }
        const b = blocks.get(l.parent.id) ?? { name: l.parent.name, items: [] };
        b.items.push(l);
        blocks.set(l.parent.id, b);
      }
      const units = [
        ...single.map((l) => ({ v: Math.abs(l.base ?? 0), out: row(l) })),
        ...[...blocks.values()].map((b) => {
          const owners = [...new Set(b.items.map((l) => l.owner))];
          const dates = b.items.map((l) => l.as_of).filter(Boolean).sort() as string[];
          const items = [...b.items].sort((x, y) => (y.base ?? 0) - (x.base ?? 0));
          return { v: Math.abs(total(b.items)), out: html`<tr class="fin-plat">
            <td><span class="fin-dot fin-dot--${g.id}"></span>${b.name}<small class="muted"> · ${n(items.length, "holding", "holdings")}</small></td>
            <td>${ownerName(owners.length === 1 ? owners[0] : "joint")}</td><td class="r num">${eur(total(b.items))}</td>
            <td class="muted">${dates.length ? day(dates[dates.length - 1]) : t("no value yet")}</td></tr>
            ${items.map((l) => row(l, "fin-hold"))}` };
        }),
      ].sort((a, b) => b.v - a.v);
      const sumG = total(ls);
      return html`<tbody class="fin-grp">
        <tr class="fin-grp__h"><th colspan="2">${groupLabel(g.id)}</th><th class="r num${sumG < 0 ? " tone-rose" : ""}">${eur(sumG)}</th><th></th></tr>
        ${units.map((u) => u.out)}</tbody>`;
    })}
  </table></div>`;
}

function dueList(list: Due[]): Raw {
  if (!list.length) return html`<p class="muted small fin-pad">${t("Nothing due. Contracts with an end or renewal date and deadlines show up here.")}</p>`;
  const today = ov!.today;
  return html`<ul class="fin-due">${list.map((d) => html`<li class="${d.due < today ? "is-late" : ""}">
    <span class="fin-due__date num">${day(d.due)}</span>
    <span class="fin-due__what"><b>${d.title}</b><small class="muted">${words(d.kind)}${d.amount_cents ? ` · ${money(d.amount_cents, d.currency ?? ov!.base, true)}` : ""}${d.due < today ? ` · ${t("overdue")}` : ""}</small></span>
    ${d.source === "deadline" ? html`<button class="btn btn--line btn--sm" data-done="${d.id}" title="${t("Mark done")}">${icon("check")}${t("Done")}</button>` : ""}
  </li>`)}</ul>`;
}

function bindDue(root: ParentNode): void {
  $$<HTMLButtonElement>("[data-done]", root).forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try { await fin.done(b.dataset.done!); await load(); } catch (e) { b.disabled = false; b.title = (e as Error).message; b.classList.add("tone-rose"); }
  }));
}

// ---------------------------------------------------------------- the net worth line (one series, hover readout)

let chartPts: { x: number; y: number; date: string; v: number }[] = [];

function chart(series: { date: string; v: number }[]): Raw {
  if (series.length < 2) return html`<p class="muted small fin-pad">${t("The line starts once values exist for two month ends.")}</p>`;
  const W = 720, H = 150, padL = 8, padR = 8, padT = 12, padB = 4;
  const vs = series.map((s) => s.v), min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1;
  chartPts = series.map((s, i) => ({ x: padL + (i / (series.length - 1)) * (W - padL - padR), y: padT + (1 - (s.v - min) / span) * (H - padT - padB), date: s.date, v: s.v }));
  const d = chartPts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("");
  const area = `${d}L${chartPts.at(-1)!.x.toFixed(1)} ${H - padB}L${padL} ${H - padB}Z`;
  const last = chartPts.at(-1)!;
  return raw(`<svg class="fin-line" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Net worth over time">
    <line class="fin-line__base" x1="${padL}" x2="${W - padR}" y1="${H - padB}" y2="${H - padB}"/>
    <path class="fin-line__area" d="${area}"/><path class="fin-line__path" d="${d}"/>
    <circle class="fin-line__now" cx="${last.x}" cy="${last.y}" r="4"/>
    <line class="fin-line__hair" id="fin-hair" x1="0" x2="0" y1="${padT}" y2="${H - padB}" visibility="hidden"/>
    <circle class="fin-line__dot" id="fin-hdot" r="4" visibility="hidden"/>
  </svg><div class="fin-line__x muted"><span>${day(series[0].date)}</span><span>${day(series.at(-1)!.date)}</span></div><div class="fin-tip" id="fin-tip" hidden></div>`);
}

function bindChart(): void {
  const box = $("#fin-chart"), svg = $<SVGSVGElement>("#fin-chart svg");
  if (!box || !svg || !chartPts.length) return;
  const hair = $<SVGLineElement>("#fin-hair")!, dot = $<SVGCircleElement>("#fin-hdot")!, tip = $("#fin-tip")!;
  const hide = () => { hair.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.hidden = true; };
  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * 720;
    const p = chartPts.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
    hair.setAttribute("x1", String(p.x)); hair.setAttribute("x2", String(p.x)); hair.setAttribute("visibility", "visible");
    dot.setAttribute("cx", String(p.x)); dot.setAttribute("cy", String(p.y)); dot.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.textContent = `${day(p.date)} · ${eur(p.v)}`;
    const left = (p.x / 720) * r.width;
    tip.style.left = `${Math.min(Math.max(left, 60), r.width - 60)}px`;
  });
  svg.addEventListener("pointerleave", hide);
}

// ---------------------------------------------------------------- one flat or the car

async function assetTab(box: HTMLElement, a: Row): Promise<void> {
  const year = ov!.today.slice(0, 4);
  const value = ov!.lines.find((l) => l.subject_kind === "asset" && l.id === a.id);
  const details = a.details && typeof a.details === "object" ? Object.entries(a.details as Record<string, unknown>) : [];
  mount(box, html`
  <section class="card fin-asset">
    <div class="fin-asset__facts">
      <div class="fin-asset__name"><span class="chip-ic">${icon(a.kind === "vehicle" ? "car" : "home")}</span><h2 class="h2">${a.name}</h2><span class="pill">${ROLE()[a.role] ?? a.role}</span></div>
      <dl class="fin-stats">
        <div><dt>${t("Whose")}</dt><dd>${ownerName(a.owner)}</dd></div>
        ${a.acquired ? html`<div><dt>${t("Since")}</dt><dd>${day(a.acquired)}</dd></div>` : ""}
        ${typeof a.price_cents === "number" ? html`<div><dt>${a.role === "rented_home" ? t("Rent") : t("Price")}</dt><dd class="num">${money(a.price_cents, a.currency ?? ov!.base, true)}</dd></div>` : ""}
        ${value ? html`<div><dt>${t("Value")}</dt><dd class="num">${eur(value.base)}</dd><small class="muted">${day(value.as_of)}</small></div>` : ""}
        ${details.map(([k, v]) => html`<div><dt>${k === "m2" ? "m²" : words(k)}</dt><dd>${typeof v === "object" ? JSON.stringify(v) : typeof v === "number" && k === "km" ? km(v) : String(v)}</dd></div>`)}
      </dl>
      ${a.note ? html`<p class="muted small">${a.note}</p>` : ""}
      ${html`<div class="row"><button class="btn btn--line btn--sm" data-edit="assets" data-id="${a.id}">${icon("edit")}${t("Edit")}</button>
        <button class="btn btn--line btn--sm" data-new="asset_events">${icon("plus")}${t("Logbook entry")}</button>
        ${a.kind === "vehicle" ? html`<button class="btn btn--line btn--sm" id="fin-tyre-new">${icon("plus")}${t("Tyre change")}</button>` : ""}
        <button class="btn btn--line btn--sm" data-new="transactions">${icon("plus")}${t("Cost or income")}</button></div>`}
    </div>
    <span id="fin-asset-open" data-asset="${a.id}" hidden></span>
  </section>
  <div class="kpis" id="fin-year"></div>
  <div class="fin-split">
    <section class="card fin-panel"><div class="h2-row"><h2 class="h2">${icon("clock")}${t("Coming up")}</h2></div>${dueList(ov!.upcoming.filter((d) => d.asset_id === a.id))}</section>
    <section class="card fin-panel"><div class="h2-row"><h2 class="h2">${icon("file")}${t("Contracts")}</h2></div><div id="fin-a-contracts"><p class="muted small fin-pad">…</p></div></section>
  </div>
  ${a.kind === "vehicle" ? html`<section class="card fin-panel"><div class="h2-row"><h2 class="h2">${icon("car")}${t("Tyres")}</h2></div><div id="fin-a-tyres"><p class="muted small fin-pad">…</p></div></section>` : ""}
  <section class="card fin-panel"><div class="h2-row"><h2 class="h2">${icon("list")}${t("Logbook")}</h2></div><div id="fin-a-events"><p class="muted small fin-pad">…</p></div></section>
  <section class="card fin-panel"><div class="h2-row"><h2 class="h2">${icon("activity")}${t("Money in {year}", { year })}</h2></div><div id="fin-a-tx"><p class="muted small fin-pad">…</p></div></section>`);
  bindDue(box);
  bindEdits(box, { asset_id: a.id });
  $("#fin-tyre-new")?.addEventListener("click", () => void formDialog("asset_events", null, { asset_id: a.id, kind: "tyres", title: t("Tyre change"), date: todayIso() }));
  const q = `?asset=${encodeURIComponent(a.id)}`;
  const [contracts, events, tx] = await Promise.all([fin.list("contracts", q), fin.list("asset_events", q), fin.list("transactions", `${q}&from=${year}-01-01`)]);
  if ($("#fin-asset-open")?.dataset.asset !== a.id) return;           // another tab opened meanwhile
  const inc = tx.filter((x) => x.amount_cents > 0 && x.currency === ov!.base).reduce((s, x) => s + x.amount_cents, 0);
  const out = tx.filter((x) => x.amount_cents < 0 && x.currency === ov!.base).reduce((s, x) => s + x.amount_cents, 0);
  mount($("#fin-year")!, html`
    <div class="card kpi"><span class="chip-ic">${icon("down")}</span><div><b class="num">${eur(inc)}</b><small>${t("In, {year}", { year })}</small></div></div>
    <div class="card kpi"><span class="chip-ic">${icon("arrow")}</span><div><b class="num">${eur(Math.abs(out))}</b><small>${t("Out, {year}", { year })}</small></div></div>
    <div class="card kpi"><span class="chip-ic">${icon("wallet")}</span><div><b class="num${inc + out < 0 ? " tone-rose" : ""}">${eur(inc + out)}</b><small>${t("Net, {year}", { year })}</small></div></div>`);
  mount($("#fin-a-contracts")!, rowsTable("contracts", contracts, ["name", "kind", "ends", "amount_cents", "every"]));
  // the odometer is the car's: a flat's logbook has no such column
  mount($("#fin-a-events")!, rowsTable("asset_events", events, a.kind === "vehicle" ? ["date", "title", "kind", "odometer_km"] : ["date", "title", "kind"]));
  if ($("#fin-a-tyres")) mount($("#fin-a-tyres")!, tyres(events));
  mount($("#fin-a-tx")!, rowsTable("transactions", tx, ["date", "amount_cents", "category", "description"]));
  bindEdits(box, { asset_id: a.id });
}

// ---------------------------------------------------------------- tyres

const LABEL: Record<string, string> = {
  tyre_set: "Tyres now on", tread_mm: "Tread, lowest (mm)", tread_fl: "Front left (mm)", tread_fr: "Front right (mm)", tread_rl: "Rear left (mm)", tread_rr: "Rear right (mm)",
};
const WHEELS = [["tread_fl", "Front left"], ["tread_fr", "Front right"], ["tread_rl", "Rear left"], ["tread_rr", "Rear right"]] as const;
const km = (v: number) => `${Math.round(v).toLocaleString(loc())} km`;
const mm = (v: number) => `${v.toLocaleString(loc(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} mm`;

/** The tyre log from the vehicle's logbook: the set on the car, km per set, last rotation, the latest tread depth. */
function tyres(events: Row[]): Raw {
  const asc = [...events].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  const log = asc.filter((e) => e.kind === "tyres");
  const odo = asc.filter((e) => typeof e.odometer_km === "number").at(-1);
  if (!log.length) return html`<p class="muted small fin-pad">No tyre changes yet. Use <b>Tyre change</b> to log a swap, a rotation or a tread check.</p>`;
  const changes = log.filter((e) => e.tyre_set && typeof e.odometer_km === "number");
  const fitted = log.filter((e) => e.tyre_set).at(-1);
  // km on each set: from one change to the next, the open stretch up to the latest odometer reading
  const per: Record<string, number> = {};
  changes.forEach((c, i) => {
    const end = i + 1 < changes.length ? changes[i + 1].odometer_km : odo?.odometer_km;
    if (typeof end === "number" && end > c.odometer_km) per[c.tyre_set] = (per[c.tyre_set] ?? 0) + end - c.odometer_km;
  });
  const rot = log.filter((e) => /rotat/i.test(String(e.title ?? "")) || /rotat/i.test(String(e.note ?? ""))).at(-1);
  const depth = log.filter((e) => typeof e.tread_mm === "number" || WHEELS.some(([k]) => typeof e[k] === "number")).at(-1);
  const wheels = depth ? WHEELS.map(([k, l]) => [l, typeof depth[k] === "number" ? depth[k] : null] as const) : [];
  const vals = depth ? [depth.tread_mm, ...WHEELS.map(([k]) => depth[k])].filter((v): v is number => typeof v === "number") : [];
  const low = vals.length ? Math.min(...vals) : null;
  // a common rule of thumb: replace summer tyres around 3 mm, winter tyres around 4 mm (check your country's law)
  const limit = (depth?.tyre_set ?? fitted?.tyre_set) === "winter" ? 4 : 3;
  const tone = low === null ? "" : low < limit ? " tone-rose" : low < limit + 1 ? " tone-amber" : "";
  const at = (e: Row) => html`${day(e.date)}${typeof e.odometer_km === "number" ? html` <span class="muted">at ${km(e.odometer_km)}</span>` : ""}`;
  return html`<div class="fin-tyres">
    <dl class="facts">
      ${fitted ? html`<dt>On the car</dt><dd><b>${words(fitted.tyre_set)}</b> since ${at(fitted)}</dd>` : ""}
      ${Object.entries(per).map(([set, n]) => html`<dt>${words(set)} set</dt><dd>${km(n)} driven</dd>`)}
      ${rot ? html`<dt>Last rotation</dt><dd>${at(rot)}</dd>` : ""}
      ${odo ? html`<dt>Odometer</dt><dd>${km(odo.odometer_km)} <span class="muted">${day(odo.date)}</span></dd>` : ""}
    </dl>
    ${depth ? html`<div class="fin-tread">
      <div class="fin-tread__head"><span class="muted small">Tread, ${day(depth.date)}</span><b class="num${tone}">${low === null ? "–" : mm(low)}</b></div>
      ${wheels.some(([, v]) => v !== null) ? html`<div class="fin-tread__car" aria-label="Tread per wheel">
        ${wheels.map(([l, v]) => html`<div class="fin-tread__wheel${typeof v === "number" && v < limit ? " tone-rose" : ""}"><small>${l}</small><b>${typeof v === "number" ? mm(v) : "–"}</b></div>`)}
      </div>` : html`<p class="muted small">One reading for all wheels.</p>`}
    </div>` : ""}
  </div>`;
}

// ---------------------------------------------------------------- records

let recTable = "accounts";

async function records(box: HTMLElement): Promise<void> {
  const spec = RECORDS.find((r) => r.table === recTable) ?? RECORDS[0];
  mount(box, html`
  <div class="h2-row fin-rec-head">
    <div class="tabs fin-rec-tabs" role="tablist" aria-label="${t("Records")}">${RECORDS.map((r) => html`<button role="tab" data-rec="${r.table}" aria-selected="${String(r.table === spec.table)}">${recLabel(r.table, r.label)}</button>`)}</div>
    <button class="btn btn--line btn--sm" data-new="${spec.table}">${icon("plus")}${t("New")}</button>
  </div>
  <section class="card fin-panel" id="fin-rec"><p class="muted small fin-pad">${t("Loading …")}</p></section>`);
  $$<HTMLButtonElement>("[data-rec]", box).forEach((b) => b.addEventListener("click", () => { recTable = b.dataset.rec!; void records(box); }));
  bindEdits(box);
  const rows = await fin.list(spec.table);
  if (recTable !== spec.table || !$("#fin-rec")) return;
  mount($("#fin-rec")!, rowsTable(spec.table, rows, spec.cols));
  bindEdits($("#fin-rec")!);
}

function cell(table: string, col: string, r: Row): Raw | string {
  const v = r[col];
  if (v === null || v === undefined || v === "") return "–";
  if (col.endsWith("_cents")) return html`<span class="num${v < 0 ? " tone-rose" : ""}">${money(v, r.currency ?? ov?.base ?? "EUR")}</span>`;
  if (col === "owner" || col === "person") return ownerName(String(v));
  if (col === "asset_id") return ov?.assets.find((a) => a.id === v)?.name ?? "–";
  if (col === "odometer_km") return html`<span class="num">${km(Number(v))}</span>`;
  if (col === "role") return ROLE()[String(v)] ?? String(v);
  if (/^(date|due|ends|starts|as_of|done|acquired)$/.test(col)) return day(String(v));
  if (col === "subject_kind" && table === "valuations") {
    const l = ov?.lines.find((x) => x.id === r.subject_id);
    return l ? l.name : `${v} ${r.subject_id}`;
  }
  if (/^(kind|category|source|repeat|every|status|renews)$/.test(col)) return words(String(v));
  return String(v);
}

function rowsTable(table: string, rows: Row[], cols: string[]): Raw {
  if (!rows.length) return html`<p class="muted small fin-pad">${t("Nothing here yet.")}</p>`;
  return html`<div class="table-wrap"><table class="table fin-table">
    <thead><tr>${cols.map((c) => html`<th class="${c.endsWith("_cents") ? "r" : ""}">${c === "subject_kind" ? "What" : c === "odometer_km" ? "Odometer" : words(c)}</th>`)}<th></th></tr></thead>
    <tbody>${rows.map((r) => html`<tr>${cols.map((c) => html`<td class="${c.endsWith("_cents") ? "r" : ""}">${cell(table, c, r)}</td>`)}
      <td class="r"><button class="icon-btn" data-edit="${table}" data-id="${r.id}" aria-label="${t("Edit")}">${icon("edit")}</button></td></tr>`)}</tbody>
  </table></div>`;
}

function bindEdits(root: ParentNode, preset: Record<string, unknown> = {}): void {
  $$<HTMLButtonElement>("[data-edit]", root).forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = "1";
    b.addEventListener("click", () => void editDialog(b.dataset.edit!, b.dataset.id!));
  });
  $$<HTMLButtonElement>("[data-new]", root).forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = "1";
    b.addEventListener("click", () => void formDialog(b.dataset.new!, null, preset));
  });
}

// ---------------------------------------------------------------- dialogs

function dialog(): HTMLDialogElement {
  return $<HTMLDialogElement>("#fin-dlg")!;
}

function refRows(table: string): Promise<Row[]> {
  if (!refCache.has(table)) refCache.set(table, fin.list(table));
  return refCache.get(table)!;
}

const label = (r: Row) => String(r.name ?? r.title ?? (r.date ? `${r.date} ${r.description ?? ""}` : r.id));

async function addPicker(): Promise<void> {
  const d = dialog();
  mount(d, html`<form method="dialog" class="fin-form">
    <h3 id="fin-dlg-h">Add</h3>
    <div class="fin-pick">${RECORDS.filter((r) => r.table !== "valuations").map((r) => html`<button type="button" class="btn btn--line" data-pick="${r.table}">${r.label.replace(/s$/, "")}</button>`)}</div>
    <div class="fin-form__btns"><button class="btn btn--line" value="cancel">Cancel</button></div>
  </form>`);
  $$<HTMLButtonElement>("[data-pick]", d).forEach((b) => b.addEventListener("click", () => void formDialog(b.dataset.pick!, null)));
  d.showModal();
}

async function editDialog(table: string, id: string): Promise<void> {
  const rows = await fin.list(table, "?archived=1");
  const row = rows.find((r) => r.id === id);
  if (row) await formDialog(table, row);
}

/** A form for one row, built from the Worker's field list. Money fields take "1.234,56" or "1234.56". */
async function formDialog(table: string, row: Row | null, preset: Record<string, unknown> = {}): Promise<void> {
  schema ??= await fin.schema();
  const t = schema.tables[table];
  if (!t) return;
  const fields = Object.entries(t.fields);
  const refs: Record<string, Row[]> = {};
  for (const [, f] of fields) if (f.t === "ref" && f.to) refs[f.to] = await refRows(f.to);
  const subjects = table === "valuations"
    ? [...(await refRows("accounts")).map((r) => ({ v: `account:${r.id}`, l: `Account: ${r.name}` })), ...(await refRows("holdings")).map((r) => ({ v: `holding:${r.id}`, l: `Holding: ${r.name}` })), ...(await refRows("assets")).map((r) => ({ v: `asset:${r.id}`, l: `Asset: ${r.name}` }))]
    : [];
  const val = (k: string) => (row ? row[k] : preset[k]);
  const input = (k: string, f: (typeof fields)[number][1]): Raw => {
    const v = val(k), req = f.req ? "required" : "";
    const id = `ff-${k}`;
    if (table === "valuations" && k === "subject_kind") {
      const cur = row ? `${row.subject_kind}:${row.subject_id}` : "";
      return html`<label class="fin-field"><span>What</span><select id="ff-subject" ${row ? "disabled" : ""} required>${subjects.map((s) => html`<option value="${s.v}" ${s.v === cur ? "selected" : ""}>${s.l}</option>`)}</select></label>`;
    }
    if (table === "valuations" && k === "subject_id") return html``;
    const name = LABEL[k] ?? words(k);
    let control: Raw;
    if (f.t === "enum" || f.t === "owner" || f.t === "currency") {
      const opts = f.t === "owner" ? schema!.owners : f.t === "currency" ? schema!.currencies : f.of ?? [];
      const dflt = v ?? (f.t === "currency" ? schema!.base : "");
      control = html`<select id="${id}" ${req}>${f.req ? "" : html`<option value="">–</option>`}${opts.map((o) => html`<option value="${o}" ${o === dflt ? "selected" : ""}>${f.t === "owner" ? ownerName(o) : f.t === "currency" ? o : words(o)}</option>`)}</select>`;
    } else if (f.t === "ref") {
      control = html`<select id="${id}" ${req}><option value="">–</option>${(refs[f.to!] ?? []).map((r) => html`<option value="${r.id}" ${r.id === v ? "selected" : ""}>${label(r)}</option>`)}</select>`;
    } else if (f.t === "date") {
      control = html`<input id="${id}" type="date" value="${v ?? (f.req && !row ? todayIso() : "")}" ${req}>`;
    } else if (f.t === "int" && k.endsWith("_cents")) {
      control = html`<input id="${id}" inputmode="decimal" autocomplete="off" value="${typeof v === "number" ? (v / 100).toFixed(2) : ""}" ${req} placeholder="0.00">`;
    } else if (f.t === "int" || f.t === "real") {
      control = html`<input id="${id}" type="number" step="${f.t === "real" ? "any" : "1"}" value="${v ?? ""}" ${req}>`;
    } else if (f.t === "bool") {
      control = html`<input id="${id}" type="checkbox" ${v ? "checked" : ""}>`;
    } else if (f.t === "json") {
      control = html`<textarea id="${id}" rows="3" placeholder='{"m2": 62}'>${v ? JSON.stringify(v, null, 1) : ""}</textarea>`;
    } else if (f.t === "text" && (f.max ?? 200) > 300) {
      control = html`<textarea id="${id}" rows="2" maxlength="${f.max ?? 2000}">${v ?? ""}</textarea>`;
    } else {
      control = html`<input id="${id}" value="${v ?? ""}" maxlength="${f.max ?? 200}" ${req}>`;
    }
    const when = f.when ? html` data-when="${f.when.field}" data-is="${f.when.is.join(" ")}"` : "";
    return html`<label class="fin-field${f.t === "json" || (f.t === "text" && (f.max ?? 0) > 300) ? " fin-field--wide" : ""}"${when}><span>${name}${f.req ? " *" : ""}</span>${control}</label>`;
  };
  const d = dialog();
  const title = (RECORDS.find((r) => r.table === table)?.label ?? words(table)).replace(/s$/, "");
  mount(d, html`<form class="fin-form" id="fin-form" novalidate>
    <h3 id="fin-dlg-h">${row ? `Edit ${title.toLowerCase()}` : `New ${title.toLowerCase()}`}</h3>
    <div class="fin-fields">${fields.map(([k, f]) => input(k, f))}</div>
    <p class="fin-err tone-rose small" id="fin-err" hidden></p>
    <div class="fin-form__btns">
      ${row ? html`<button type="button" class="btn btn--line fin-archive" id="fin-archive">${row.archived ? "Restore" : "Archive"}</button>` : ""}
      <button type="button" class="btn btn--line" id="fin-cancel">Cancel</button>
      <button type="submit" class="btn btn--ink">Save</button>
    </div>
  </form>`);
  // fields that only apply to some kinds (tyre depth on a tyre entry) follow the field they depend on
  const shown = (k: string): boolean => {
    const w = t.fields[k]?.when;
    return !w || w.is.includes($<HTMLSelectElement>(`#ff-${w.field}`, d)?.value ?? "");
  };
  // a logbook entry asks for the odometer only when it is about a vehicle
  const odo = table === "asset_events" ? $<HTMLElement>("#ff-odometer_km", d)?.closest<HTMLElement>("label") : null;
  const forCar = () => (refs.assets ?? []).find((r) => r.id === $<HTMLSelectElement>("#ff-asset_id", d)?.value)?.kind === "vehicle";
  const follow = () => {
    $$<HTMLElement>("[data-when]", d).forEach((el) => { el.hidden = !el.dataset.is!.split(" ").includes($<HTMLSelectElement>(`#ff-${el.dataset.when}`, d)?.value ?? ""); });
    if (odo) odo.hidden = !forCar();
  };
  $("#ff-asset_id", d)?.addEventListener("change", follow);
  new Set(fields.map(([, f]) => f.when?.field).filter(Boolean)).forEach((k) => $(`#ff-${k}`, d)?.addEventListener("change", follow));
  follow();
  $("#fin-cancel", d)!.addEventListener("click", () => d.close());
  $("#fin-archive", d)?.addEventListener("click", async () => {
    try { await fin.archive(table, row!.id, !row!.archived); d.close(); await load(); } catch (e) { showErr((e as Error).message); }
  });
  $<HTMLFormElement>("#fin-form", d)!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    try {
      for (const [k, f] of fields) {
        if (table === "valuations" && k === "subject_id") continue;
        if (table === "valuations" && k === "subject_kind") {
          if (row) continue;
          const [kind, sid] = ($<HTMLSelectElement>("#ff-subject", d)!.value).split(":");
          body.subject_kind = kind; body.subject_id = sid;
          continue;
        }
        if (!shown(k)) continue;
        const el = $<HTMLInputElement>(`#ff-${k}`, d)!;
        let v: unknown;
        if (f.t === "bool") v = el.checked;
        else if (el.value.trim() === "") v = row ? null : undefined;
        else if (f.t === "int" && k.endsWith("_cents")) { v = parseMoney(el.value); if (v === null) throw new Error(`${words(k)}: not an amount`); }
        else if (f.t === "int") v = Number.parseInt(el.value, 10);
        else if (f.t === "real") v = Number(el.value);
        else if (f.t === "json") { try { v = JSON.parse(el.value); } catch { throw new Error(`${words(k)}: not valid JSON`); } }
        else v = el.value.trim();
        if (v === undefined) continue;
        if (row && JSON.stringify(v ?? null) === JSON.stringify(row[k] ?? null)) continue;   // only what changed
        if (row && f.t === "bool" && Boolean(row[k]) === v) continue;
        body[k] = v;
      }
      if (row) { if (Object.keys(body).length) await fin.update(table, row.id, body); }
      else await fin.create(table, body);
      d.close();
      await load();
    } catch (err) {
      showErr((err as Error).message);
    }
  });
  if (!d.open) d.showModal();
}

function showErr(m: string): void {
  const p = $("#fin-err");
  if (p) { p.hidden = false; p.textContent = m; }
}

const BAL_GROUPS = [
  { id: "current", label: "Current accounts and cards" }, { id: "savings", label: "Savings" }, { id: "high_yield", label: "High-yield savings" },
  { id: "invest", label: "Investments" }, { id: "commodity", label: "Commodities" }, { id: "home", label: "Home and loans" },
] as const;
const BAL_OF: Record<string, string> = {
  current: "current", credit_card: "current", cash: "current", other: "current", savings: "savings", deposit: "savings",
  high_yield: "high_yield", brokerage: "invest", crypto: "invest", pension: "invest", commodity: "commodity", loan: "home",
};

/** "Update balances": every open account, holding and owned asset with its last value; changed lines are saved. */
async function balancesDialog(): Promise<void> {
  const [accounts, holdings] = await Promise.all([refRows("accounts"), refRows("holdings")]);
  const last = new Map(ov!.lines.map((l) => [`${l.subject_kind}:${l.id}`, l]));
  const merged = new Set(ov!.lines.filter((l) => l.merged).map((l) => l.id));
  const debt = (k: string) => k === "loan" || k === "credit_card";
  // an account with holdings is updated through them, so it is not asked itself
  const open = new Map(accounts.filter((a) => !a.closed).map((a) => [a.id as string, a]));
  const held = new Set(holdings.filter((h) => open.has(h.account_id)).map((h) => h.account_id as string));
  const all: { kind: string; r: Row; cur: string; g: string; debt: boolean; plat?: string }[] = [
    ...[...open.values()].filter((a) => !held.has(a.id)).map((a) => ({ kind: "account", r: a, cur: a.currency ?? ov!.base, g: BAL_OF[a.kind] ?? "current", debt: debt(a.kind) })),
    ...holdings.filter((h) => open.has(h.account_id)).sort((x, y) => String(open.get(x.account_id)!.name).localeCompare(open.get(y.account_id)!.name))
      .map((h) => ({ kind: "holding", r: h, cur: h.currency ?? open.get(h.account_id)!.currency ?? ov!.base, g: "invest", debt: false, plat: open.get(h.account_id)!.name as string })),
    ...ov!.assets.filter((a) => a.role !== "rented_home" && a.role !== "leased" && !merged.has(a.id))
      .map((a) => ({ kind: "asset", r: a, cur: a.currency ?? ov!.base, g: "home", debt: false })),
  ];
  // grouped like the bank apps: everyday, savings, high-yield, investments, commodities, home and loans
  const items = BAL_GROUPS.flatMap((g) => all.filter((it) => it.g === g.id));
  const shown = (c: number, it: { debt: boolean }) => (it.debt ? -c : c);
  const d = dialog();
  mount(d, html`<form class="fin-form" id="fin-bform">
    <h3 id="fin-dlg-h">Update balances</h3>
    <p class="muted small">Type today's numbers where they changed. Each one is saved as a new dated value; the old ones stay. Loans and cards: what is owed, with or without the minus.</p>
    <label class="fin-field"><span>As of</span><input type="date" id="fin-asof" value="${todayIso()}" required></label>
    ${items.length ? html`<div class="fin-bal">${BAL_GROUPS.filter((g) => items.some((it) => it.g === g.id)).map((g) => html`
      <h4 class="fin-bal__h">${g.label}</h4>
      ${items.map((it, i) => {
        if (it.g !== g.id) return "";
        const l = last.get(`${it.kind}:${it.r.id}`);
        const was = l?.as_of ? shown(l.amount_cents, it) : null;
        const head = it.plat && items[i - 1]?.plat !== it.plat ? html`<div class="fin-bal__plat">${it.plat}</div>` : "";
        return html`${head}<label class="fin-bal__row${it.plat ? " fin-bal__row--held" : ""}"><span><b>${it.r.name}</b><small class="muted">${was !== null ? `${money(was, l!.currency)} · ${day(l!.as_of!)}${l!.source === "estimate" ? " (estimate)" : ""}` : "no value yet"}</small></span>
          <span class="fin-bal__in"><input inputmode="decimal" autocomplete="off" data-i="${i}" placeholder="${was !== null ? (was / 100).toFixed(2) : "0.00"}"><small class="muted">${it.cur}</small></span></label>`;
      })}`)}</div>` : html`<p class="muted small">No accounts yet: add one first.</p>`}
    <p class="fin-err tone-rose small" id="fin-err" hidden></p>
    <div class="fin-form__btns"><button type="button" class="btn btn--line" id="fin-cancel">Cancel</button><button type="submit" class="btn btn--ink">Save</button></div>
  </form>`);
  $("#fin-cancel", d)!.addEventListener("click", () => d.close());
  $<HTMLFormElement>("#fin-bform", d)!.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const out = [];
      for (const el of $$<HTMLInputElement>("[data-i]", d)) {
        if (!el.value.trim()) continue;
        const c = parseMoney(el.value);
        if (c === null) throw new Error(`"${el.value}" is not an amount`);
        const it = items[Number(el.dataset.i)];
        // debts are stored as what is owed: "-182401" and "182401" mean the same
        out.push({ subject_kind: it.kind, subject_id: it.r.id, amount_cents: it.debt ? Math.abs(c) : c, currency: it.cur });
      }
      if (!out.length) { d.close(); return; }
      await fin.balances($<HTMLInputElement>("#fin-asof", d)!.value, out);
      d.close();
      await load();
    } catch (err) {
      showErr((err as Error).message);
    }
  });
  d.showModal();
}

export const financeUi: UiModule = { id: "finance", pages: { "/dashboard/finance": { title: "Finance", view, init, leave } } };
