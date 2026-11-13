import { html, mount, $, $$, type Raw } from "../html.ts";
import { icon } from "../icons.ts";
import { call } from "../api.ts";
import { t, loc } from "../i18n.ts";

// /dashboard/security: how everything is connected and what guards each door.
//   Map              zones with what sits in them; lines show who reaches what (drawn from where the boxes really are)
//   Sign-ins & keys  who signs in where, and every key: what it is for and where it lives (never its value)
//   Checks           what the dashboard can verify itself, and what only you can
// The content comes from the Worker (GET /api/security), which works it out from the household config, the secrets
// manifest and the modules that are switched on.

type Status = "ok" | "fix" | "info" | "rm";
type Kind = "user" | "service" | "agent" | "tunnel" | "deploy";
interface Zone { id: string; name: string; text: string }
interface SecNode { id: string; zone: string; name: string; sub: string; icon: string; status: Status; text: string; guard?: string[]; keys?: string[] }
interface SecLink { from: string; to: string; kind: Kind; label: string; status?: Status }
interface SignIn { where: string; who: string; how: string; status: Status; note: string }
interface KeyRow { name: string; use: string; lives: string; status: Status; state: string; rotate: string; ifLost: string; warn: boolean }
interface KeyGroup { id: string; name: string; icon: string; rows: KeyRow[] }
interface Check { title: string; text: string; state: "done" | "open" | "self" }
interface Model { checked: string; zones: Zone[]; nodes: SecNode[]; links: SecLink[]; signIns: SignIn[]; keyGroups: KeyGroup[]; checks: Check[] }

const STATUS: Record<Status, { label: string; tone: string }> = {
  ok: { label: "in place", tone: "green" },
  fix: { label: "to fix", tone: "amber" },
  rm: { label: "to retire", tone: "rose" },
  info: { label: "note", tone: "slate" },
};
const KIND: Record<Kind, { label: string; text: string }> = {
  user: { label: "Sign-in", text: "a person, through a sign-in" },
  service: { label: "Service", text: "Worker to Worker or to an API, with a key" },
  agent: { label: "Edge agent", text: "outbound only, signed" },
  tunnel: { label: "Tunnel", text: "Cloudflare Tunnel into the house" },
  deploy: { label: "Deploy", text: "code and updates" },
};
const CHECK: Record<Check["state"], { label: string; tone: string }> = {
  done: { label: "checked", tone: "green" },
  open: { label: "to fix", tone: "amber" },
  self: { label: "check yourself", tone: "slate" },
};

const NS = "http://www.w3.org/2000/svg";
let model: Model | null = null;
let byId = new Map<string, SecNode>();
let watch: ResizeObserver | null = null;
let picked: string | null = null;
let kind: Kind | null = null;

const pill = (s: Status) => html`<span class="pill pill--${STATUS[s].tone}">${t(STATUS[s].label)}</span>`;

function nodeChip(n: SecNode): Raw {
  return html`<button class="snode" data-node="${n.id}" data-status="${n.status}" aria-pressed="false">
    <span class="snode__ic">${icon(n.icon)}</span><span class="snode__txt"><b>${n.name}</b><small>${n.sub}</small></span><i class="sdot sdot--${n.status}" title="${t(STATUS[n.status].label)}"></i></button>`;
}

function mapView(m: Model): Raw {
  const kinds = (Object.keys(KIND) as Kind[]).filter((k) => m.links.some((l) => l.kind === k));
  return html`
  <div class="sec-map">
    <div class="smap-wrap">
      <div class="slegend" role="group" aria-label="${t("Show one kind of link")}">
        ${kinds.map((k) => html`<button class="slegend__k" data-kind="${k}" aria-pressed="false" title="${t(KIND[k].text)}"><i class="sline sline--${k}"></i>${t(KIND[k].label)}</button>`)}
      </div>
      <div class="smap" id="smap">
        <svg class="smap__links" id="smap-links" aria-hidden="true"></svg>
        ${m.zones.map((z) => html`
        <section class="zone zone--${z.id}" aria-label="${z.name}">
          <header class="zone__head"><h3>${z.name}</h3><small>${z.text}</small></header>
          <div class="zone__nodes">${m.nodes.filter((n) => n.zone === z.id).map(nodeChip)}</div>
        </section>`)}
      </div>
    </div>
    <aside class="card sdetail" id="sdetail" aria-live="polite"></aside>
  </div>`;
}

function overviewPanel(m: Model): Raw {
  const count = (s: Status) => m.nodes.filter((n) => n.status === s).length;
  return html`
  <h2 class="h2">${icon("eye")}${t("How to read this")}</h2>
  <p class="muted small">${t("Left to right: who comes in, the door they use, what runs in the cloud, and what that depends on. Anything in your house sits below.")}</p>
  <p class="muted small">${t("Tap a box to see what guards it, where its keys live and what it talks to.")}</p>
  <ul class="sstat">
    ${(Object.keys(STATUS) as Status[]).filter((s) => count(s)).map((s) => html`<li><i class="sdot sdot--${s}"></i><span>${t(STATUS[s].label)}</span><b class="num">${count(s)}</b></li>`)}
  </ul>
  <p class="muted small">${t("Worked out from your household config and the secrets manifest.")}</p>`;
}

function linkRow(l: SecLink, self: string): Raw {
  const out = l.from === self, other = byId.get(out ? l.to : l.from)!;
  return html`<li><button class="slinkrow" data-node="${other.id}"><i class="sline sline--${l.kind}"></i>
    <span><b>${out ? t("to") : t("from")} ${other.name}</b><small>${t(KIND[l.kind].label)} · ${l.label}</small></span>${l.status ? pill(l.status) : ""}</button></li>`;
}

function nodePanel(m: Model, n: SecNode): Raw {
  const mine = m.links.filter((l) => l.from === n.id || l.to === n.id);
  const zone = m.zones.find((z) => z.id === n.zone);
  return html`
  <header class="sdetail__head"><span class="chip-ic">${icon(n.icon)}</span><div><h2>${n.name}</h2><small class="muted">${zone?.name ?? ""}</small></div>
    <button class="icon-btn" data-clear aria-label="${t("Close")}">${icon("x")}</button></header>
  <p>${pill(n.status)}</p>
  <p class="small">${n.text}</p>
  ${n.guard?.length ? html`<p class="kicker">${t("Guarded by")}</p><ul class="sfacts">${n.guard.map((g) => html`<li>${icon("shield")}<span>${g}</span></li>`)}</ul>` : ""}
  ${n.keys?.length ? html`<p class="kicker">${t("Where its keys live")}</p><ul class="sfacts">${n.keys.map((g) => html`<li>${icon("key")}<span>${g}</span></li>`)}</ul>` : ""}
  ${mine.length ? html`<p class="kicker">${t("Talks to")}</p><ul class="slinks">${mine.map((l) => linkRow(l, n.id))}</ul>` : ""}`;
}

function signView(m: Model): Raw {
  const keyCount = m.keyGroups.reduce((a, g) => a + g.rows.length, 0);
  return html`
  <h2 class="h2">${icon("user")}${t("Who signs in where")}</h2>
  <div class="card table-wrap"><table class="table table--wrap">
    <thead><tr><th>${t("Where")}</th><th>${t("Who")}</th><th>${t("How")}</th><th>${t("State")}</th><th>${t("Note")}</th></tr></thead>
    <tbody>${m.signIns.map((s) => html`<tr><td data-th="Where"><b>${s.where}</b></td><td data-th="Who">${s.who}</td><td data-th="How">${s.how}</td><td data-th="State">${pill(s.status)}</td><td data-th="Note" class="muted">${s.note}</td></tr>`)}</tbody>
  </table></div>
  <div class="h2-row"><h2 class="h2">${icon("key")}${t("Keys and tokens")} <span class="count">${keyCount}</span></h2><span class="muted small">${t("Names and places only. A value is never shown here or kept in the repository.")}</span></div>
  <div class="keys">
    ${m.keyGroups.map((g) => html`
    <article class="card keygroup">
      <header class="pane__head"><h3 class="h2">${icon(g.icon)}${g.name}</h3></header>
      <ul>${g.rows.map((r) => html`<li>
        <div class="key__top"><b>${r.name}</b>${pill(r.status)}</div>
        <p class="small">${r.use}</p>
        <p class="small muted key__lives">${icon("pin")}<span>${r.lives} · <span class="key__state">${r.state}</span></span></p>
        <div class="small muted key__more"><span><b>${t("To replace it:")}</b> ${r.rotate}</span><span class="${r.warn ? "key__note" : ""}"><b>${t("If it is lost:")}</b> ${r.ifLost}</span></div>
      </li>`)}</ul>
    </article>`)}
  </div>`;
}

function checksView(m: Model): Raw {
  return html`
  <div class="card list">${m.checks.map((c) => html`<div class="list__row clean clean--${c.state}">
    <span class="clean__box">${c.state === "done" ? icon("check") : ""}</span>
    <span class="list__txt"><b>${c.title}</b><small>${c.text}</small></span>
    <span class="pill pill--${CHECK[c.state].tone}">${t(CHECK[c.state].label)}</span></div>`)}</div>`;
}

const TABS = [["map", "Map"], ["sign", "Sign-ins & keys"], ["checks", "Checks"]] as const;
const kpi = (ic: string, value: string, label: string) =>
  html`<div class="card kpi"><span class="chip-ic">${icon(ic)}</span><div><b class="num">${value}</b><small>${label}</small></div></div>`;

export function security(): Raw {
  return html`
  <header class="page-head">
    <div><h1 class="h1">${t("Security")}</h1><p class="muted" id="sec-sub">${t("Who comes in, the doors between the zones, and the keys that open them.")}</p></div>
    <div class="tabs" role="tablist" aria-label="${t("Security views")}">
      ${TABS.map(([id, label], i) => html`<button role="tab" id="sec-tab-${id}" data-tab="${id}" aria-selected="${String(i === 0)}" aria-controls="sec-${id}">${t(label)}</button>`)}
    </div>
  </header>
  <p class="banner" id="sec-error" role="alert"></p>
  <div class="kpis" id="sec-kpis"></div>
  <section id="sec-map" role="tabpanel" aria-labelledby="sec-tab-map"><p class="muted small">${t("Loading …")}</p></section>
  <section id="sec-sign" role="tabpanel" aria-labelledby="sec-tab-sign" hidden></section>
  <section id="sec-checks" role="tabpanel" aria-labelledby="sec-tab-checks" hidden></section>`;
}

// ---------------------------------------------------------------- the lines

type Box = { l: number; t: number; r: number; b: number; cx: number; cy: number };
const f = (n: number) => n.toFixed(1);

/** A line through corner points, with the corners rounded off. */
function elbow(pts: [number, number][], r = 10): string {
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [x, y] = pts[i], [nx, ny] = pts[i + 1];
    const a = Math.min(r, Math.hypot(x - px, y - py) / 2), b = Math.min(r, Math.hypot(nx - x, ny - y) / 2);
    const ux = Math.sign(x - px), uy = Math.sign(y - py), vx = Math.sign(nx - x), vy = Math.sign(ny - y);
    d += ` L${f(x - ux * a)} ${f(y - uy * a)} Q${f(x)} ${f(y)} ${f(x + vx * b)} ${f(y + vy * b)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${f(last[0])} ${f(last[1])}`;
}

/** Between two boxes in the top row: a soft curve between the facing sides, or a small bow inside one column. */
function curve(a: Box, b: Box): string {
  if (Math.abs(a.cx - b.cx) < 8) {
    const x = Math.max(a.r, b.r), k = 20;
    return `M${f(x)} ${f(a.cy)} C${f(x + k)} ${f(a.cy)} ${f(x + k)} ${f(b.cy)} ${f(x)} ${f(b.cy)}`;
  }
  const ltr = a.cx < b.cx;
  const x1 = ltr ? a.r : a.l, x2 = ltr ? b.l : b.r, k = Math.max(20, Math.abs(x2 - x1) * 0.45) * (ltr ? 1 : -1);
  return `M${f(x1)} ${f(a.cy)} C${f(x1 + k)} ${f(a.cy)} ${f(x2 - k)} ${f(b.cy)} ${f(x2)} ${f(b.cy)}`;
}

function drawLinks(): void {
  const map = $("#smap"), svg = $<SVGSVGElement>("#smap-links");
  if (!map || !svg || !model) return;
  const links = model.links;
  const m = map.getBoundingClientRect();
  if (!m.width || getComputedStyle(svg).display === "none") return;
  svg.setAttribute("viewBox", `0 0 ${m.width} ${m.height}`);
  const rel = (el: Element): Box => {
    const r = el.getBoundingClientRect();
    return { l: r.left - m.left, t: r.top - m.top, r: r.right - m.left, b: r.bottom - m.top, cx: r.left - m.left + r.width / 2, cy: r.top - m.top + r.height / 2 };
  };
  const el = (id: string) => map.querySelector(`[data-node="${CSS.escape(id)}"]`);
  const cols = $$(".zone:not(.zone--home)", map).map(rel);
  const houseEl = $(".zone--home", map);
  const house = houseEl ? rel(houseEl) : null;
  const gap = cols.length > 1 ? cols[1].l - cols[0].r : 40;
  const rowGap = house ? house.t - Math.max(...cols.map((c) => c.b)) : 0;
  // lines to the house run down the gap beside their column, then along the gap above the house
  const lane = new Map<number, number>(), land = new Map<string, number>(), want = new Map<string, number>();
  const inHouse = (id: string) => byId.get(id)?.zone === "home";
  links.forEach((l) => { if (inHouse(l.from) !== inHouse(l.to)) { const h = inHouse(l.from) ? l.from : l.to; want.set(h, (want.get(h) ?? 0) + 1); } });
  let cross = 0;
  svg.replaceChildren(...links.flatMap((l) => {
    const ea = el(l.from), eb = el(l.to);
    if (!ea || !eb) return [];
    const a = rel(ea), b = rel(eb);
    let d: string;
    const ha = inHouse(l.from), hb = inHouse(l.to);
    if (ha && hb) {
      // two boxes in the house: a bow under them
      const y = Math.max(a.b, b.b), k = 16;
      d = `M${f(a.cx)} ${f(y)} C${f(a.cx)} ${f(y + k)} ${f(b.cx)} ${f(y + k)} ${f(b.cx)} ${f(y)}`;
    } else if ((ha || hb) && house) {
      const top = ha ? b : a, home = ha ? a : b, hid = ha ? l.from : l.to;
      const ci = Math.max(0, cols.findIndex((c) => top.cx >= c.l && top.cx <= c.r));
      const right = ci < cols.length - 1, g = Math.max(0, right ? ci : ci - 1);
      const n = lane.get(g) ?? 0;
      lane.set(g, n + 1);
      const gx = cols[g].r + gap / 2 + ((n % 5) - 2) * Math.min(6, gap / 8);
      const k = land.get(hid) ?? 0, total = want.get(hid) ?? 1;
      land.set(hid, k + 1);
      const hx = home.cx + (k - (total - 1) / 2) * 12;
      const y = house.t - rowGap / 2 + ((cross++ % 7) - 3) * Math.min(5, rowGap / 10);
      const pts: [number, number][] = [[right ? top.r : top.l, top.cy], [gx, top.cy], [gx, y], [hx, y], [hx, home.t]];
      d = elbow(ha ? pts.reverse() : pts);
    } else {
      d = curve(a, b);
    }
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("class", `slink slink--${l.kind}${l.status ? ` slink--${l.status}` : ""}`);
    p.dataset.from = l.from;
    p.dataset.to = l.to;
    p.dataset.kind = l.kind;
    return [p];
  }));
  paint();
}

/** Light up what is picked (a box and its lines, or one kind of line); everything else steps back. */
function paint(): void {
  const map = $("#smap");
  if (!map || !model) return;
  const hot = (l: { from?: string; to?: string; kind?: string }) => (picked ? l.from === picked || l.to === picked : kind ? l.kind === kind : false);
  const near = new Set<string>();
  model.links.filter(hot).forEach((l) => { near.add(l.from); near.add(l.to); });
  if (picked) near.add(picked);
  map.classList.toggle("has-pick", !!picked || !!kind);
  $$<SVGPathElement>(".slink", map).forEach((p) => p.classList.toggle("is-hot", hot(p.dataset)));
  $$<HTMLButtonElement>(".snode", map).forEach((b) => {
    b.classList.toggle("is-near", near.has(b.dataset.node!));
    b.setAttribute("aria-pressed", String(b.dataset.node === picked));
  });
  $$<HTMLButtonElement>("[data-kind]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === kind)));
}

function pick(id: string | null): void {
  if (!model) return;
  picked = id;
  if (id) kind = null;
  const panel = $("#sdetail")!;
  const n = id ? byId.get(id) : null;
  mount(panel, n ? nodePanel(model, n) : overviewPanel(model));
  panel.classList.toggle("is-open", !!n);
  paint();
}

export function securityLeave(): void {
  watch?.disconnect();
  watch = null;
}

function draw(m: Model): void {
  model = m;
  byId = new Map(m.nodes.map((n) => [n.id, n]));
  const keyCount = m.keyGroups.reduce((a, g) => a + g.rows.length, 0);
  const open = m.checks.filter((c) => c.state === "open").length;
  $("#sec-sub")!.textContent = t("Who comes in, the doors between the zones, and the keys that open them. Checked {when}.", {
    when: new Date(m.checked).toLocaleString(loc(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) });
  mount($("#sec-kpis")!, html`
    ${kpi("users", String(m.nodes.filter((n) => n.zone === "who").length), t("People and apps that come in"))}
    ${kpi("lock", String(m.nodes.filter((n) => n.zone === "edge").length), t("Doors at the edge"))}
    ${kpi("key", String(keyCount), t("Keys and tokens"))}
    ${kpi("alert", String(open), t("Checks to fix"))}`);
  mount($("#sec-map")!, mapView(m));
  mount($("#sec-sign")!, signView(m));
  mount($("#sec-checks")!, checksView(m));
  pick(null);
  drawLinks();
  watch = new ResizeObserver(() => drawLinks());
  watch.observe($("#smap")!);
  // the font arrives after the first paint and moves the boxes
  void document.fonts?.ready.then(drawLinks);
}

export function securityInit(): void {
  securityLeave();
  picked = kind = null;
  model = null;
  const tabs = $$<HTMLButtonElement>("[data-tab]");
  tabs.forEach((tab) => tab.addEventListener("click", () => {
    tabs.forEach((x) => x.setAttribute("aria-selected", String(x === tab)));
    TABS.forEach(([id]) => { $(`#sec-${id}`)!.hidden = id !== tab.dataset.tab; });
    if (tab.dataset.tab === "map") drawLinks();
  }));
  $("#sec-map")!.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    if (el.closest("[data-clear]")) return pick(null);
    const k = el.closest<HTMLElement>("[data-kind]");
    if (k) {
      kind = kind === k.dataset.kind ? null : (k.dataset.kind as Kind);
      if (picked) pick(null); else paint();
      return;
    }
    const n = el.closest<HTMLElement>("[data-node]");
    if (n) return pick(n.dataset.node === picked && n.classList.contains("snode") ? null : n.dataset.node!);
    if (el.closest("#smap") && picked) pick(null);
  });
  call<Model>("GET", "/security").then((m) => { if ($("#sec-map")) draw(m); }, (e: Error) => {
    const box = $("#sec-error");
    if (box) box.textContent = t("The Security page did not load: {error}", { error: e.message });
    const map = $("#sec-map");
    if (map) mount(map, html``);
  });
}
