// /dashboard/agents (admins): add a computer, approve it after comparing its fingerprint, choose which commands
// may be sent to it, confirm a risky command, revoke it. An AI app can propose a command through /devices/mcp;
// only a person on this page can confirm one that is marked destructive.
import { html, mount, $, $$, type Raw } from "../html.ts";
import { call, ago, who } from "../api.ts";
import { icon } from "../icons.ts";
import { t } from "../i18n.ts";
import { kindIcon, type Agent, type Command, type Devices, type Op } from "./systems.ts";

let timer = 0;

export function agentsPage(): Raw {
  return html`
  <section class="page-head"><div><h1 class="h1">${t("Edge agents")}</h1>
    <p class="muted">${t("A small program on each computer that sends its numbers to this dashboard and can run a short, fixed list of commands.")}</p>
    <p class="banner" id="ag-error" role="alert"></p></div></section>
  <div class="setup">
    <div id="ag-confirm"></div>
    <section class="card pane" aria-label="${t("Add a computer")}">
      <div class="pane__head"><h2 class="h2">${icon("plus")}${t("Add a computer")}</h2></div>
      <form class="form" id="ag-form">
        <div class="fields">
          <label class="field"><span>${t("Name")}</span><input class="input" name="name" placeholder="${t("Gaming PC")}" maxlength="60" autocomplete="off" required></label>
          <label class="field"><span>${t("Short id (letters, digits, hyphens)")}</span><input class="input" name="id" placeholder="gaming-pc" maxlength="43" autocomplete="off" autocapitalize="none" required></label>
          <label class="field"><span>${t("System")}</span><select class="select" name="kind"><option value="mac">macOS</option><option value="windows">Windows</option><option value="linux">Linux</option><option value="other">${t("Other")}</option></select></label>
        </div>
        <div class="checks" id="ag-new-ops"></div>
        <div><button class="btn btn--ink">${icon("key")}${t("Get a one-time code")}</button></div>
      </form>
      <div id="ag-code"></div>
    </section>
    <section class="card pane" aria-label="${t("Computers")}">
      <div class="pane__head"><h2 class="h2">${icon("agents")}${t("Computers")}</h2></div>
      <div id="ag-list"><p class="muted small">${t("Loading …")}</p></div>
    </section>
    <section class="card pane" aria-label="${t("Recent commands")}">
      <div class="pane__head"><h2 class="h2">${icon("activity")}${t("Recent commands")}</h2></div>
      <div class="table-wrap" id="ag-commands"></div>
    </section>
  </div>`;
}

const person = (id: string | null) => (id ? who.people.find((p) => p.id === id)?.name ?? id : "");
const opChecks = (ops: Op[], chosen: string[], group: string): Raw => html`${ops.map((o) => html`<label class="check" title="${o.what}">
  <input type="checkbox" data-op="${group}" value="${o.op}" ${chosen.includes(o.op) ? html`checked` : ""}><span>${o.op}</span>${o.tier === "destructive" ? html`<small>${t("needs your confirmation")}</small>` : ""}</label>`)}`;

function state(a: Agent): Raw {
  if (a.revoked) return html`<span class="pill pill--slate">${t("revoked")}</span>`;
  if (!a.has_key) return html`<span class="pill pill--amber">${t("waiting for the computer")}</span>`;
  if (!a.approved) return html`<span class="pill pill--amber">${t("waiting for your approval")}</span>`;
  return html`<span class="pill ${a.online ? "pill--green" : "pill--slate"}">${a.online ? t("online") : t("last seen {when}", { when: ago(a.last_seen) })}</span>`;
}

function agentRow(a: Agent, ops: Op[]): Raw {
  const pending = a.has_key && !a.approved && !a.revoked;
  return html`<div class="list__row list__row--stack"><span class="chip-ic">${icon(kindIcon(a.kind))}</span>
    <div class="list__txt agent" data-agent="${a.id}">
      <div class="agent__acts"><b>${a.name}</b><span class="mono muted">${a.id}</span>${state(a)}</div>
      ${pending ? html`<p class="small">${t("The computer printed a fingerprint when it enrolled. Approve only if it is exactly this one:")} <span class="mono">${a.fingerprint}</span></p>
        <div class="agent__acts"><button class="btn btn--ink btn--sm" data-approve="${a.fingerprint ?? ""}">${icon("check")}${t("They match: approve")}</button></div>` : ""}
      ${a.approved && !a.revoked ? html`<div class="checks">${opChecks(ops, a.allow_ops, a.id)}</div>
        <div class="agent__acts">
          <button class="btn btn--line btn--sm" data-save-ops>${t("Save commands")}</button>
          ${a.allow_ops.map((o) => html`<button class="btn btn--line btn--sm" data-send="${o}">${icon("play")}${o}</button>`)}
        </div>` : ""}
      ${a.revoked ? "" : html`<div class="agent__acts">
        <button class="btn btn--line btn--sm" data-new-code>${t("New code (reinstall)")}</button>
        <button class="btn btn--danger btn--sm" data-revoke>${t("Revoke")}</button></div>`}
    </div></div>`;
}

function codeBox(r: { id: string; code: string }): Raw {
  return html`<p class="small">${t("One-time code for {id}, valid for 10 minutes:", { id: r.id })}</p><p class="big-code">${r.code}</p>
    <p class="small muted">${t("On that computer, with the agent downloaded (see agent/README.md in your repository), run:")}</p>
    <div class="code-box">edge-agent enrol --server ${location.origin} --id ${r.id} --code ${r.code}</div>
    <p class="small muted">${t("It prints a fingerprint. Compare it with the one that appears below, then approve.")}</p>`;
}

function commandRows(list: Command[]): Raw {
  if (!list.length) return html`<p class="muted small">${t("No commands yet.")}</p>`;
  return html`<table class="table"><thead><tr><th>${t("When")}</th><th>${t("Computer")}</th><th>${t("Command")}</th><th>${t("Asked by")}</th><th>${t("State")}</th></tr></thead>
    <tbody>${list.map((c) => html`<tr><td>${ago(c.created)}</td><td class="mono">${c.agent}</td><td class="mono">${c.op}</td><td>${person(c.proposed_by)}${c.confirmed_by ? ` · ${t("confirmed by {who}", { who: person(c.confirmed_by) })}` : ""}</td>
      <td><span class="pill ${c.status === "done" ? "pill--green" : c.status === "failed" || c.status === "rejected" ? "pill--rose" : c.status === "proposed" ? "pill--amber" : ""}">${t(c.status)}</span></td></tr>`)}</tbody></table>`;
}

function draw(d: Devices): void {
  const list = $("#ag-list");
  if (!list || list.contains(document.activeElement)) return;
  const newOps = $("#ag-new-ops")!;
  if (!newOps.children.length) mount(newOps, opChecks(d.ops, ["agent.ping"], "new"));
  mount(list, d.agents.length ? html`<div class="list">${d.agents.map((a) => agentRow(a, d.ops))}</div>` : html`<p class="muted small">${t("No computer yet.")}</p>`);
  mount($("#ag-commands")!, commandRows(d.commands));
  const waiting = d.commands.filter((c) => c.status === "proposed" && c.expires > Date.now());
  mount($("#ag-confirm")!, html`${waiting.map((c) => html`<section class="card pane" aria-label="${t("Confirm a command")}">
    <div class="pane__head"><h2 class="h2">${icon("alert")}${t("Confirm: {op} on {agent}", { op: c.op, agent: d.agents.find((a) => a.id === c.agent)?.name ?? c.agent })}</h2></div>
    <p class="small">${t("Asked by {who} {when}. It runs only if you confirm within 5 minutes.", { who: person(c.proposed_by), when: ago(c.created) })}</p>
    <div class="agent__acts"><button class="btn btn--danger" data-confirm="${c.id}">${t("Yes, run it")}</button></div></section>`)}`);
  if (!d.signing) $("#ag-error")!.textContent = t("The command signing key is not set yet (SHELL_COMMAND_SIGNING_KEY): computers cannot enrol. Ask your AI to open the one-time key page.");
}

async function load(): Promise<void> {
  try { draw(await call<Devices>("GET", "/devices")); } catch (e) { const el = $("#ag-error"); if (el) el.textContent = (e as Error).message; }
}

export function agentsLeave(): void {
  if (timer) window.clearInterval(timer);
  timer = 0;
}

export function agentsInit(): void {
  agentsLeave();
  const say = (m: string) => { const e = $("#ag-error"); if (e) e.textContent = m; };
  const run = async (what: () => Promise<unknown>) => { try { await what(); say(""); } catch (e) { say((e as Error).message); } (document.activeElement as HTMLElement | null)?.blur(); await load(); };
  $("#ag-form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement, d = new FormData(f);
    void run(async () => {
      const r = await call<{ id: string; code: string }>("POST", "/devices", { id: d.get("id"), name: d.get("name"), kind: d.get("kind"), allow_ops: $$<HTMLInputElement>('[data-op="new"]:checked').map((i) => i.value) });
      mount($("#ag-code")!, codeBox(r));
      f.reset();
    });
  });
  $(".setup")!.addEventListener("click", (e) => {
    const el = e.target as HTMLElement, b = el.closest<HTMLButtonElement>("button");
    if (!b) return;
    if (b.dataset.confirm) { void run(() => call("POST", `/devices/command/${b.dataset.confirm}/confirm`, {})); return; }
    const id = b.closest<HTMLElement>("[data-agent]")?.dataset.agent;
    if (!id) return;
    if (b.dataset.approve !== undefined) void run(() => call("POST", `/devices/${id}/approve`, { fingerprint: b.dataset.approve }));
    else if (b.dataset.saveOps !== undefined) void run(() => call("POST", `/devices/${id}/ops`, { allow_ops: $$<HTMLInputElement>(`[data-op="${id}"]:checked`).map((i) => i.value) }));
    else if (b.dataset.send) void run(() => call("POST", "/devices/command", { agent: id, op: b.dataset.send, args: b.dataset.send === "pc.shutdown" ? { delay_s: 60 } : {} }));
    else if (b.dataset.newCode !== undefined) void run(async () => mount($("#ag-code")!, codeBox(await call("POST", `/devices/${id}/code`, {}))));
    else if (b.dataset.revoke !== undefined) {
      if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = t("Revoke for good? Tap again"); return; }
      void run(() => call("POST", `/devices/${id}/revoke`, {}));
    }
  });
  void load();
  timer = window.setInterval(load, 15_000);
}
