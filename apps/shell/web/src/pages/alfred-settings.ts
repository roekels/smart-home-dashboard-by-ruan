// Assistant settings (/dashboard/alfred, admins): its name and tone, one pair of check boxes per service the
// gateway offers, fast mode, and where the last messages spent their time. Saved the moment something changes.
// The boxes only narrow: the assistant's gateway key is the hard limit, and a change still shows a card first.
import { html, mount, $, $$, type Raw } from "../html.ts";
import { icon } from "../icons.ts";
import { who } from "../api.ts";
import { alfred, toolName, type AlfredSettings, type AlfredTrace, type SettingsChange } from "../alfred.ts";
import { t, loc } from "../i18n.ts";

const ICON: Record<string, string> = { brain: "brain", calendar: "calendar", home: "home", devices: "monitor", finance: "wallet", health: "activity" };

/** What "change" means for a service. A service not listed here gets the general line. */
const WRITE: Record<string, string> = {
  calendar: "Add and change events there, each with a card first. Removing stays off.",
  home: "Switch lights and scenes and tick off list items at once. Anything marked risky (plugs, commands) stays off.",
  finance: "File balances, contracts and receipts, each with a card first. Admins only.",
  health: "File what a person tells it about their own records, each with a card first. Someone else's only when an admin asks in writing. Nothing clinical goes into the notes.",
};
const READ: Record<string, string> = {
  calendar: "See events in the calendar of the person who is asking and in the shared one.",
  finance: "See accounts, contracts and deadlines, for admins only.",
  health: "See the records of the person who is asking, to avoid filing something twice.",
};

export function alfredSettings(): Raw {
  return html`
  <header class="page-head"><div><h1 class="h1">${t("Assistant settings")}</h1>
    <p class="muted">${t("What the assistant is called, how it talks and what it may do. A box that is off takes those tools away completely.")}</p></div>
    <div class="page-head__actions"><span class="pill" id="al-state">${t("Loading …")}</span></div></header>
  <div class="grid grid--2 al-grid">
    <section class="card al-card">
      <h2 class="h2">${icon("chat")}${t("Name and tone")}</h2>
      <label class="al-field"><span><b>${t("Name")}</b><small class="muted">${t("What the household calls it. Up to 24 characters.")}</small></span>
        <input type="text" id="al-name" maxlength="24" autocomplete="off" disabled></label>
      <label class="al-field"><span><b>${t("Tone")}</b><small class="muted">${t("A sentence or two on how it should talk, e.g. \"Short and dry.\" It cannot change what the assistant is allowed to do.")}</small></span>
        <textarea id="al-persona" rows="3" maxlength="400" disabled></textarea></label>
    </section>
    <section class="card al-card">
      <h2 class="h2">${icon("bolt")}${t("Speed and use")}</h2>
      <label class="al-row">
        <input type="checkbox" id="al-fast" disabled>
        <span><b>${t("Fast mode")}</b><small class="muted">${t("Quicker answers at a higher token price, where the model offers it.")}</small></span>
      </label>
      <p class="al-kv"><span class="muted">${t("Model")}</span><b id="al-model">-</b></p>
      <p class="al-kv"><span class="muted">${t("Thinking effort")}</span><b id="al-effort">-</b></p>
      <p class="al-kv"><span class="muted">${t("Tokens used today")}</span><b id="al-usage">-</b></p>
    </section>
  </div>
  <h2 class="h2">${icon("shield")}${t("What it may do")}</h2>
  <div class="grid grid--3 al-grid" id="al-services"><p class="muted small">${t("Loading …")}</p></div>
  <section class="card al-card al-traces">
    <h2 class="h2">${icon("activity")}${t("Recent messages")}</h2>
    <p class="muted small">${t("Where each message spent its time and tokens. A message about health shows no text.")}</p>
    <div class="al-scroll"><table class="al-table">
      <thead><tr><th>${t("When")}</th><th>${t("Message")}</th><th>${t("Total")}</th><th>${t("Before the model")}</th><th>${t("Model")}</th><th>${t("Tools")}</th><th>${t("Tokens in / out")}</th><th>${t("Cached")}</th></tr></thead>
      <tbody id="al-traces"><tr><td colspan="8" class="muted">${t("Loading …")}</td></tr></tbody>
    </table></div>
  </section>
  <p class="muted small" id="al-error" role="alert"></p>`;
}

const num = (v: number): string => v >= 1e6 ? `${(v / 1e6).toFixed(2)} M` : v >= 1e3 ? `${Math.round(v / 1e3)} k` : String(v);
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

function serviceCards(s: AlfredSettings): Raw {
  if (!s.services.length) {
    return html`<p class="muted small">${s.down.length
      ? t("The gateway did not answer, so there is nothing to list yet.")
      : t("The assistant's gateway key reaches no service yet. Give the key scopes and they show up here.")}</p>`;
  }
  return html`${s.services.map((g) => html`<section class="card al-card">
    <h2 class="h2">${icon(ICON[g.id] ?? "spark")}${g.name}${s.down.includes(g.id) ? html`<span class="pill pill--rose">${t("not answering")}</span>` : ""}</h2>
    <label class="al-row"><input type="checkbox" data-perm="${g.id}.read">
      <span><b>${t("Read")}</b><small class="muted">${t(READ[g.id] ?? "Look things up and read them.")}</small></span></label>
    <label class="al-row"><input type="checkbox" data-perm="${g.id}.write">
      <span><b>${t("Change")}</b><small class="muted">${t(WRITE[g.id] ?? "Add and change things. Each change shows a card first; deleting stays off.")}</small></span></label>
    ${g.id === "calendar" ? html`<label class="al-row"><input type="checkbox" data-flag="adminCalendars">
      <span><b>${t("Admins can open everyone's calendars")}</b><small class="muted">${t("Off: each person reaches their own calendar and the shared one. On: an admin may also ask about another person's calendar by name. Everyone else stays with their own.")}</small></span></label>` : ""}
  </section>`)}`;
}

function showTraces(list: AlfredTrace[]): void {
  const body = $("#al-traces");
  if (!body) return;
  body.replaceChildren();
  if (!list.length) {
    const tr = document.createElement("tr");
    tr.append(Object.assign(document.createElement("td"), { colSpan: 8, className: "muted", textContent: t("No messages yet.") }));
    body.append(tr);
    return;
  }
  for (const tr of list) {
    const row = document.createElement("tr");
    const model = tr.rounds.reduce((a, r) => a + r.ms, 0), tools = tr.rounds.reduce((a, r) => a + r.tools_ms, 0);
    const ctx = tr.context.map((c) => `${c.source} ${secs(c.ms)}${c.ok ? "" : ` (${t("dropped")})`}`).join(", ");
    const used = [...new Set(tr.rounds.flatMap((r) => r.tools.map(toolName)))].join(", ");
    const at = new Date(tr.at).toLocaleString(loc(), { timeZone: who.timezone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const fine = tr.status === "complete" || tr.status === "awaiting_approval";
    const cells: [string, string?][] = [
      [at], [tr.kind === "decisions" ? t("(card answered)") : tr.ask, fine ? tr.who : `${tr.who} · ${tr.status}`],
      [secs(tr.total_ms)], [secs(tr.setup_ms), ctx], [`${secs(model)} / ${tr.rounds.length}`], [secs(tools), used],
      [`${num(tr.usage.input_tokens + tr.usage.cache_creation_input_tokens)} / ${num(tr.usage.output_tokens)}`], [num(tr.usage.cache_read_input_tokens)],
    ];
    for (const [main, sub] of cells) {
      const td = document.createElement("td");
      td.textContent = main;
      if (sub) td.append(Object.assign(document.createElement("small"), { className: "muted", textContent: sub }));
      row.append(td);
    }
    body.append(row);
  }
}

export function alfredSettingsInit(): void {
  const state = $("#al-state")!, error = $("#al-error")!;
  const name = $<HTMLInputElement>("#al-name")!, persona = $<HTMLTextAreaElement>("#al-persona")!, fast = $<HTMLInputElement>("#al-fast")!;
  const mark = (text: string, tone = "") => { state.textContent = text; state.className = `pill${tone ? ` pill--${tone}` : ""}`; };
  let drawn = "";

  /** Fill the page from what the Worker holds. The service cards are redrawn only when the list changed. */
  const show = (s: AlfredSettings) => {
    if (!state.isConnected) return;
    if (document.activeElement !== name) name.value = s.name;
    if (document.activeElement !== persona) persona.value = s.persona;
    fast.checked = s.fast;
    $("#al-model")!.textContent = s.model;
    $("#al-effort")!.textContent = s.effort;
    $("#al-usage")!.textContent = s.usage.limit ? t("{used} of {limit}", { used: num(s.usage.today), limit: num(s.usage.limit) }) : num(s.usage.today);
    const key = JSON.stringify([s.services, s.down]);
    if (key !== drawn) {
      drawn = key;
      mount($("#al-services")!, serviceCards(s));
      $$<HTMLInputElement>("[data-perm]").forEach((b) => b.addEventListener("change", () => void save({ permissions: { [b.dataset.perm!]: b.checked } }, () => { b.checked = !b.checked; })));
      $$<HTMLInputElement>("[data-flag='adminCalendars']").forEach((b) => b.addEventListener("change", () => void save({ adminCalendars: b.checked }, () => { b.checked = !b.checked; })));
    }
    $$<HTMLInputElement>("[data-perm]").forEach((b) => { b.checked = s.permissions[b.dataset.perm!] !== false; });
    $$<HTMLInputElement>("[data-flag='adminCalendars']").forEach((b) => { b.checked = s.adminCalendars === true; });
  };

  const save = async (change: SettingsChange, undo: () => void) => {
    mark(t("Saving …"));
    error.textContent = "";
    try {
      show(await alfred.saveSettings(change));
      mark(t("Saved"), "green");
    } catch (e) {
      undo(); // put it back: nothing changed
      mark(t("Not saved"), "rose");
      error.textContent = t("Could not save: {why}", { why: (e as Error).message });
    }
  };

  alfred.settings().then((s) => {
    show(s);
    for (const f of [name, persona, fast]) f.disabled = false;
    mark(who.demo ? t("Demo") : t("Live"), who.demo ? "" : "green");
    let held = { name: s.name, persona: s.persona };
    fast.addEventListener("change", () => void save({ fast: fast.checked }, () => { fast.checked = !fast.checked; }));
    name.addEventListener("change", () => {
      const before = held.name, v = name.value.trim();
      if (!v) { name.value = before; return; }
      held = { ...held, name: v };
      void save({ name: v }, () => { name.value = before; held = { ...held, name: before }; });
    });
    persona.addEventListener("change", () => {
      const before = held.persona, v = persona.value.trim();
      held = { ...held, persona: v };
      void save({ persona: v }, () => { persona.value = before; held = { ...held, persona: before }; });
    });
    alfred.traces().then((r) => showTraces(r.traces), () => showTraces([]));
  }, (e: Error) => {
    mark(t("Not reachable"), "rose");
    error.textContent = t("Could not load the assistant's settings: {why}", { why: e.message });
    $("#al-services")?.replaceChildren();
    showTraces([]);
  });
}
