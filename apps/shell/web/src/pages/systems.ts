// /dashboard/systems (admins): each computer that runs an edge agent, with what it last reported (processor,
// memory, disk, temperature, the busiest programs) and its processor load over the last day.
import { html, mount, $, type Raw } from "../html.ts";
import { call, ago } from "../api.ts";
import { icon } from "../icons.ts";
import { hasPage } from "../routes.ts";
import { t, loc } from "../i18n.ts";

export interface Agent {
  id: string; name: string; kind: string; fingerprint: string | null; allow_ops: string[]; created: number; enrolled: number | null;
  approved: number | null; approved_by: string | null; last_seen: number | null; revoked: number | null; has_key: boolean; online: boolean;
}
export interface Op { op: string; tier: "safe" | "destructive"; what: string }
export interface Command { id: string; agent: string; op: string; tier: string; status: string; proposed_by: string; confirmed_by: string | null; created: number; expires: number; finished: number | null; result: unknown }
export interface Devices { agents: Agent[]; records: { source: string; kind: string; ts: number; data: Record<string, any> }[]; ops: Op[]; commands: Command[]; signing: boolean }

let timer = 0;
const KIND_ICON: Record<string, string> = { mac: "monitor", windows: "game", linux: "server", other: "cpu" };
export const kindIcon = (k: string): string => KIND_ICON[k] ?? "cpu";

export function systemsPage(): Raw {
  return html`
  <section class="page-head"><div><h1 class="h1">${t("Systems")}</h1>
    <p class="muted">${t("What your computers report about themselves. Each one sends its numbers out; nothing on them listens.")}</p>
    <p class="banner" id="sy-error" role="alert"></p></div>
    ${hasPage("/dashboard/agents") ? html`<div class="page-head__actions"><a class="btn btn--line" href="/dashboard/agents">${icon("plus")}${t("Add a computer")}</a></div>` : ""}</section>
  <div class="machines" id="sy"><p class="muted small">${t("Loading …")}</p></div>`;
}

const gb = (bytes: unknown): string => (typeof bytes === "number" ? `${(bytes / 1e9).toLocaleString(loc(), { maximumFractionDigits: bytes >= 1e11 ? 0 : 1 })} GB` : "");
const pct = (v: unknown): number | null => (typeof v === "number" && v >= 0 && v <= 100 ? Math.round(v) : null);
const level = (p: number, warn: number, high: number): string => (p >= high ? "high" : p >= warn ? "warn" : "");

function meter(label: string, p: number | null, text: string, warn = 75, high = 90): Raw | string {
  if (p === null) return "";
  return html`<div class="meter"><span>${label}</span><span class="meter__bar"><i data-p="${p}" data-level="${level(p, warn, high)}"></i></span><b>${text}</b></div>`;
}

function uptime(s: unknown): string {
  if (typeof s !== "number" || s < 0) return "";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  return d ? t("up {d} d {h} h", { d, h }) : t("up {h} h {m} min", { h, m: Math.floor((s % 3600) / 60) });
}

function card(a: Agent, host: { ts: number; data: Record<string, any> } | undefined): Raw {
  const d = host?.data ?? {};
  const cpu = pct(d.cpu), mem = pct(d.mem), disk = pct(d.disk), gpu = pct(d.gpu);
  const top: { name: string; cpu: number }[] = Array.isArray(d.topCpu) ? d.topCpu.slice(0, 3) : [];
  return html`<section class="card pane machine" aria-label="${a.name}">
    <header class="machine__head"><span class="chip-ic">${icon(kindIcon(a.kind))}</span>
      <div><b>${a.name}</b><small>${[d.model, d.os, uptime(d.uptime)].filter(Boolean).join(" · ") || a.id}</small></div>
      <span class="pill ${a.online ? "pill--green" : "pill--slate"}">${a.online ? t("online") : t("last seen {when}", { when: ago(a.last_seen) })}</span></header>
    ${host ? html`<div class="meters">
      ${meter(t("Processor"), cpu, `${cpu} %${typeof d.cpuTemp === "number" ? ` · ${Math.round(d.cpuTemp)} °C` : ""}`)}
      ${meter(t("Memory"), mem, d.memTotal ? `${gb(d.memUsed)} / ${gb(d.memTotal)}` : `${mem} %`, 85, 95)}
      ${meter(t("Disk"), disk, d.diskTotal ? `${gb(d.diskUsed)} / ${gb(d.diskTotal)}` : `${disk} %`, 85, 95)}
      ${meter(t("Graphics"), gpu, `${gpu} %${typeof d.gpuTemp === "number" ? ` · ${Math.round(d.gpuTemp)} °C` : ""}`)}
    </div>
    <div><p class="kicker">${t("Processor, last 24 hours")}</p><svg class="spark" data-spark="${a.id}" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="${t("Processor load of {name} over the last 24 hours", { name: a.name })}"><path d=""/></svg></div>
    ${top.length ? html`<ul class="procs">${top.map((p) => html`<li><span>${p.name}</span><span>${Number(p.cpu).toLocaleString(loc(), { maximumFractionDigits: 1 })} %</span></li>`)}</ul>` : ""}`
    : html`<p class="muted small">${t("Nothing reported yet.")}</p>`}
  </section>`;
}

async function sparks(agents: Agent[]): Promise<void> {
  for (const a of agents) {
    const svg = $(`[data-spark="${a.id}"]`);
    if (!svg) continue;
    try {
      const r = await call<{ points: { ts: number; data: { cpu?: number } }[] }>("GET", `/devices/series?source=${a.id}&kind=metrics.host&fields=cpu&hours=24`);
      const pts = r.points.filter((p) => typeof p.data.cpu === "number");
      if (pts.length < 2) continue;
      const t0 = pts[0].ts, span = Math.max(1, pts[pts.length - 1].ts - t0);
      svg.querySelector("path")!.setAttribute("d", pts.map((p, i) => `${i ? "L" : "M"}${(((p.ts - t0) / span) * 100).toFixed(1)} ${(38 - (Math.min(100, p.data.cpu!) / 100) * 36).toFixed(1)}`).join(""));
    } catch { /* the meters stand without it */ }
  }
}

async function load(first: boolean): Promise<void> {
  const box = $("#sy");
  if (!box) return;
  try {
    const d = await call<Devices>("GET", "/devices");
    if (!$("#sy")) return;
    const live = d.agents.filter((a) => a.approved && !a.revoked);
    const host = new Map(d.records.filter((r) => r.kind === "metrics.host").map((r) => [r.source, r]));
    mount(box, live.length ? html`${live.map((a) => card(a, host.get(a.id)))}` : html`<section class="card pane"><p class="muted small">${t("No computer reports yet. Add one under Settings > Edge agents.")}</p></section>`);
    box.querySelectorAll<HTMLElement>("[data-p]").forEach((el) => el.style.setProperty("--p", el.dataset.p!));
    $("#sy-error")!.textContent = "";
    void sparks(live);
  } catch (e) { if (first) mount(box, html``); $("#sy-error")!.textContent = (e as Error).message; }
}

export function systemsLeave(): void {
  if (timer) window.clearInterval(timer);
  timer = 0;
}

export function systemsInit(): void {
  systemsLeave();
  void load(true);
  timer = window.setInterval(() => load(false), 60_000);
}
