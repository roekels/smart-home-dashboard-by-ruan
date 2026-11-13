// The Brain map as one mountable piece: graph, search, settings, note panel, what changed, and the opening replay.
//  - everything lives inside `host` and is torn down by destroy(), because the dashboard swaps pages;
//  - the theme follows the dashboard (Light / Dark / System);
//  - changes made elsewhere (an AI app over MCP, another person) arrive by asking /activity every 20 seconds;
//  - the opening replay shows no note names unless switched on in the gear menu (the map may be on a shared screen);
//  - left alone it turns slowly, and after 30 s it becomes a screensaver that loops the last 24 hours;
//  - a full-screen button gives an edge-to-edge view (over the dashboard's menu too).

import type { BrainSource, PulseEvent, Activity, SearchHit } from "./source.ts";
import { BrainGraph } from "./graph.ts";
import { Panel } from "./panel.ts";
import { readPalette, setRoots, swatch } from "./palette.ts";
import { loadSettings, saveSettings, effectiveTheme, reducedMotion, REPLAY_MS, type Settings } from "./settings.ts";
import { t } from "../../i18n.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const ICON = {
  search: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.3-4.3"/></svg>',
  gear: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/></svg>',
  expand: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  plus: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  shrink: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
};

const seg = (key: string, opts: [string, string][]) =>
  `<div class="bm-seg" data-seg="${key}">${opts.map(([v, t]) => `<button type="button" data-v="${v}">${t}</button>`).join("")}</div>`;
const toggle = (key: string, label: string) =>
  `<label class="bm-row"><span>${label}</span><span class="switch"><input type="checkbox" data-set="${key}"><i></i></span></label>`;

function template(): string {
  return `
  <div class="bm-graph" aria-label="${esc(t("Brain graph"))}"></div>
  <header class="bm-bar">
    <div class="bm-search">
      ${ICON.search}<input type="search" placeholder="${esc(t("Search the brain…"))}" autocomplete="off" spellcheck="false" aria-label="${esc(t("Search the brain"))}"><kbd>/</kbd>
      <div class="bm-results" hidden></div>
    </div>
    <div class="bm-tools">
      <button class="bm-new" type="button" data-new aria-expanded="false">${ICON.plus}<span>${esc(t("New note"))}</span></button>
      <button class="bm-icon" type="button" data-full aria-label="${esc(t("Full screen"))}" title="${esc(t("Full screen"))}">${ICON.expand}</button>
      <button class="bm-icon" type="button" data-gear aria-label="${esc(t("Map settings"))}" title="${esc(t("Map settings"))}" aria-expanded="false">${ICON.gear}</button>
    </div>
  </header>
  <form class="bn" hidden aria-label="${esc(t("New note"))}">
    <label class="bm-field"><span>${esc(t("Title"))}</span><input name="title" maxlength="120" required autocomplete="off"></label>
    <label class="bm-field"><span>${esc(t("Inside"))}</span><select name="parent"></select></label>
    <div class="bm-actions"><button class="bm-btn bm-btn--primary" type="submit">${esc(t("Create"))}</button><button class="bm-btn" type="button" data-new-cancel>${esc(t("Cancel"))}</button></div>
    <p class="muted bm-foot">${esc(t("Open a note first to put the new one inside it. An AI app connected to the Brain can file notes for you too."))}</p>
  </form>
  <div class="bm-settings" hidden role="dialog" aria-label="${esc(t("Map settings"))}">
    <h3>${esc(t("Map"))}</h3>
    ${toggle("animations", esc(t("Animations")))}
    <div class="bm-row bm-row--sub"><span>${esc(t("Replay on open"))}</span>${seg("replay", [["24h", "24h"], ["3d", "3d"], ["1w", "1w"], ["1m", "1m"]])}</div>
    <label class="bm-row bm-row--sub" title="${esc(t("Show each note's name while the replay plays"))}"><span>${esc(t("Note names in replay"))}</span><span class="switch"><input type="checkbox" data-set="replayLabels"><i></i></span></label>
    ${toggle("wheelZoom", esc(t("Scroll-wheel zoom")))}
    ${toggle("orbit", esc(t("Rotate / orbit")))}
    ${toggle("showArchived", esc(t("Show archived")))}
    <div class="bm-row"><span>${esc(t("View"))}</span>${seg("view", [["3d", "3D"], ["2d", "2D"]])}</div>
    <p class="bm-settings__foot muted">${esc(t("Light and dark follow the dashboard theme."))}</p>
  </div>
  <aside class="bm-panel" hidden aria-live="polite"></aside>
  <div class="bm-grip" title="${esc(t("Drag to resize · double-click to reset"))}" aria-hidden="true"></div>
  <footer class="bm-legend">
    <span class="bm-roots"></span>
    <span><i class="bm-sw bm-sw--ring"></i>${esc(t("archived"))}</span>
    <span class="bm-stats"></span>
    <span class="bm-live" title="${esc(t("Changes made elsewhere show up here within 20 seconds"))}"><i></i><em>${esc(t("live"))}</em></span>
  </footer>
  <div class="bm-toast" hidden></div>`;
}

/** "dashboard (alex)" -> "alex", "key:claude" -> "claude": who made a change, without the plumbing. */
const who = (actor: string) => actor.replace(/^dashboard \((.*)\)$/, "$1").replace(/^[a-z]+:/, "");

/** How often the map asks what changed. */
const POLL_MS = 20_000;

/** Left alone this long, the map becomes a screensaver: the last 24 hours on a loop, at half speed, without names. */
const SCREENSAVER_AFTER_MS = 30_000;

const PANEL_DEFAULT = 520;
const PHONE = 720;

export class BrainMap {
  private settings: Settings = loadSettings();
  private graph: BrainGraph;
  private panel: Panel;
  private panelOpen = false;
  private panelWidth = PANEL_DEFAULT;
  private mounted: { view: string; theme: string } | null = null;
  private toastTimer = 0;
  private refreshTimer = 0;
  private replayTimers: number[] = [];
  private lastActive = Date.now();
  private saver = false;
  private picks: { path: string }[] = [];
  private sel = -1;
  private cleanup: (() => void)[] = [];
  private visible = true;
  private dead = false;
  /** The newest change the map has seen (the Brain's own clock), so a poll only fires what is new. */
  private lastSeen = "";
  private host: HTMLElement;
  private api: BrainSource;
  private people: { name: string; n: number }[];

  constructor(host: HTMLElement, api: BrainSource, people: { name: string; n: number }[]) {
    this.host = host; this.api = api; this.people = people;
    host.classList.add("bm");
    host.innerHTML = template();

    this.graph = new BrainGraph(this.q(".bm-graph"), host, {
      onNodeClick: (n) => {
        if (this.panel.current === n.path) { this.panel.close(); return; }
        this.openNote(n.path);
      },
      // A click in empty space lets go of the note and goes back to the whole brain.
      onBackgroundClick: () => {
        if (this.panel.current) { this.panel.close(); return; }
        this.graph.setFocus(null);
        this.graph.overview();
      },
    });

    this.panel = new Panel(this.q(".bm-panel"), api, {
      go: (p) => this.openNote(p),
      toast: (m, e) => this.toast(m, e),
      changed: () => this.refresh(),
      closed: () => { this.fitToPanel(false); this.graph.setFocus(null); this.graph.overview(); },
    }, (title) => this.graph.nodes.find((n) => n.title.toLowerCase() === title.toLowerCase())?.path ?? null,
    () => this.graph.nodes.filter((n) => !n.archived));

    this.panelWidth = (() => { try { return Number(localStorage.getItem("brain.panelWidth")) || PANEL_DEFAULT; } catch { return PANEL_DEFAULT; } })();
    this.setPanelWidth(this.panelWidth);

    this.wireResize();
    this.wireGrip();
    this.wireSettings();
    this.wireSearch();
    this.wireNew();
    this.wireTheme();
    this.wireFullScreen();
    this.wireIdle();

    this.syncSettingsUi();
    this.mount();
    this.refresh().then(() => {
      if (this.dead) return;
      this.wirePoll();
      void this.replay();
    });
  }

  /** Stop everything: timers, sockets, WebGL, listeners. The host is left empty. */
  destroy(): void {
    this.dead = true;
    this.stopReplay();
    clearTimeout(this.toastTimer);
    clearTimeout(this.refreshTimer);
    this.cleanup.forEach((f) => f());
    this.panel.dispose();
    this.graph.destroy();
    this.host.replaceChildren();
    this.host.classList.remove("bm", "bm--full", "bm--panel", "bm--saver");
    document.documentElement.classList.remove("bm-lock");
  }

  /** The dashboard hides the map when another Brain tab is open: stop drawing, keep the layout. */
  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    if (on) { this.graph.resume(); this.lastActive = Date.now(); } else { this.endScreensaver(); this.graph.pause(); this.stopReplay(); }
  }

  // ---------- helpers ----------

  private q<T extends HTMLElement = HTMLElement>(sel: string): T { return this.host.querySelector(sel) as T; }
  private on<K extends keyof DocumentEventMap>(t: Document | Window | MediaQueryList, type: K | string, fn: (e: any) => void): void {
    t.addEventListener(type, fn);
    this.cleanup.push(() => t.removeEventListener(type, fn));
  }

  private toast(msg: string, err = false): void {
    const t = this.q(".bm-toast");
    t.textContent = msg;
    t.className = `bm-toast${err ? " is-err" : ""}`;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (t.hidden = true), err ? 5000 : 2200);
  }

  // ---------- graph + panel ----------

  private get phone() { return this.host.clientWidth <= PHONE; }

  /** Give the graph only the space the panel leaves free, so the focused node isn't hidden behind it. */
  private fitToPanel(open: boolean): void {
    this.panelOpen = open;
    this.host.classList.toggle("bm--panel", open);
    if (!open) this.graph.setInset(0, 0);
    else if (this.phone) this.graph.setInset(0, Math.round(this.host.clientHeight * 0.72));
    else this.graph.setInset(Math.min(this.panelWidth, this.host.clientWidth), 0);
  }

  // Drag the panel's left edge; double-click it to go back to the default. The width is remembered in this browser.
  private clampPanel(w: number) { return Math.round(Math.max(340, Math.min(w, this.host.clientWidth - 220))); }
  private setPanelWidth(w: number, save = false): void {
    this.panelWidth = this.clampPanel(w);
    this.host.style.setProperty("--panel-w", `${this.panelWidth}px`);
    if (this.panelOpen) this.fitToPanel(true);
    if (save) try { localStorage.setItem("brain.panelWidth", String(this.panelWidth)); } catch { /* fine */ }
  }

  private wireResize(): void {
    const ro = new ResizeObserver(() => {
      if (!this.host.clientWidth) return;
      this.setPanelWidth(this.panelWidth);
      if (!this.panelOpen) this.graph.resize();
    });
    ro.observe(this.host);
    this.cleanup.push(() => ro.disconnect());
  }

  private wireGrip(): void {
    const grip = this.q(".bm-grip");
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      grip.classList.add("drag");
      const left = () => this.host.getBoundingClientRect().right;
      const move = (ev: PointerEvent) => this.setPanelWidth(left() - ev.clientX);
      const up = () => {
        grip.classList.remove("drag");
        grip.removeEventListener("pointermove", move);
        this.setPanelWidth(this.panelWidth, true);
        if (this.graph.focused) this.graph.frame();
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up, { once: true });
    });
    grip.addEventListener("dblclick", () => { this.setPanelWidth(PANEL_DEFAULT, true); if (this.graph.focused) this.graph.frame(); });
  }

  /** Open a note: focus it in the graph, fly there and show the panel. */
  private openNote(path: string, edit = false): void {
    const n = this.graph.node(path);
    this.fitToPanel(true);
    this.graph.setFocus(n ?? null);
    if (n) this.graph.frame();
    void this.panel.open(path, edit);
  }

  private stats(): void {
    const n = this.graph.nodes;
    this.q(".bm-stats").textContent = t("{n} notes · {a} archived", { n: n.length, a: n.filter((x) => x.archived).length });
  }

  private async refresh(): Promise<void> {
    try {
      const g = await this.api.graph();
      if (this.dead) return;
      setRoots(g.roots ?? [], this.people);
      this.q(".bm-roots").innerHTML = (g.roots ?? []).map((r) => `<span>${swatch(r)}${esc(r)}</span>`).join("");
      this.graph.setData(g);
      this.stats();
    } catch (e) {
      this.toast(t("Couldn't load the brain: {why}", { why: (e as Error).message }), true);
    }
  }

  // ---------- theme and settings ----------

  /** (Re)build the graph only when the view or the effective theme really changed. */
  private mount(force = false): void {
    const want = { view: this.settings.view, theme: effectiveTheme() };
    if (!force && this.mounted && this.mounted.view === want.view && this.mounted.theme === want.theme) return;
    this.mounted = want;
    this.graph.mount(this.settings, readPalette(this.host, want.theme === "dark"));
    if (!this.visible) this.graph.pause();
  }

  private wireTheme(): void {
    // The shell sets data-theme on <html> (or removes it for System); the OS can flip System too.
    const mo = new MutationObserver(() => this.mount());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    this.cleanup.push(() => mo.disconnect());
    this.on(matchMedia("(prefers-color-scheme: dark)"), "change", () => this.mount());
  }

  private syncSettingsUi(): void {
    this.host.querySelectorAll<HTMLInputElement>("[data-set]").forEach((i) => (i.checked = !!(this.settings as any)[i.dataset.set!]));
    if (reducedMotion()) {
      const a = this.q<HTMLInputElement>('[data-set="animations"]');
      a.disabled = true;
      a.closest("label")!.title = t("Off: this device asks for reduced motion");
    }
    this.host.querySelectorAll<HTMLElement>("[data-seg]").forEach((s) => {
      const key = s.dataset.seg as "view" | "replay";
      s.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === this.settings[key])));
    });
  }

  private wireSettings(): void {
    const box = this.q(".bm-settings"), gear = this.q("[data-gear]");
    this.host.querySelectorAll<HTMLInputElement>("[data-set]").forEach((i) => i.addEventListener("change", () => {
      (this.settings as any)[i.dataset.set!] = i.checked;
      if (i.dataset.set === "replayLabels") { saveSettings(this.settings); this.replay(0); return; }
      if (reducedMotion()) this.settings.animations = false;
      saveSettings(this.settings);
      this.graph.applyControls(this.settings);
    }));
    this.host.querySelectorAll<HTMLElement>("[data-seg]").forEach((s) => s.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      const key = s.dataset.seg as "view" | "replay";
      if (this.settings[key] === b.dataset.v) return;
      (this.settings as any)[key] = b.dataset.v;
      saveSettings(this.settings);
      this.syncSettingsUi();
      if (key === "replay") this.replay(0);
      else this.mount();
    }));
    const show = (on: boolean) => { box.hidden = !on; gear.setAttribute("aria-expanded", String(on)); };
    gear.addEventListener("click", () => show(!!box.hidden));
    this.on(document, "click", (e: MouseEvent) => {
      if (!box.hidden && !box.contains(e.target as Node) && !gear.contains(e.target as Node)) show(false);
    });
  }

  private wireFullScreen(): void {
    const btn = this.q("[data-full]");
    const set = (on: boolean) => {
      this.host.classList.toggle("bm--full", on);
      document.documentElement.classList.toggle("bm-lock", on);
      btn.innerHTML = on ? ICON.shrink : ICON.expand;
      btn.setAttribute("aria-label", on ? t("Exit full screen") : t("Full screen"));
      btn.title = on ? t("Exit full screen (Esc)") : t("Full screen");
      // Let the box take its new size, then re-frame what was in view.
      requestAnimationFrame(() => { this.setPanelWidth(this.panelWidth); this.graph.resize(); this.graph.frame(); });
    };
    btn.addEventListener("click", () => set(!this.host.classList.contains("bm--full")));
    this.on(document, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && !this.panel.current && this.host.classList.contains("bm--full") && document.activeElement?.tagName !== "INPUT") set(false);
    });
  }

  // ---------- search ----------

  private wireSearch(): void {
    const q = this.q<HTMLInputElement>(".bm-search input");
    const results = this.q(".bm-results");
    const showResults = (html: string) => { results.innerHTML = html; results.hidden = !html; };
    const pick = (path: string) => { showResults(""); q.value = ""; q.blur(); this.openNote(path); };
    const renderPicks = (items: { path: string; title: string; root: string; snippet?: string }[], hint: string) => {
      this.picks = items;
      this.sel = -1;
      showResults(items.map((r, i) => `<button type="button" data-i="${i}"><div class="t">${swatch(r.root)}${esc(r.title)}</div><div class="p">${esc(r.path)}</div>${r.snippet ? `<div class="s">${esc(r.snippet).replace(/«/g, "<b>").replace(/»/g, "</b>")}</div>` : ""}</button>`).join("") + `<div class="bm-hint">${hint}</div>`);
    };
    q.addEventListener("input", () => {
      const text = q.value.trim().toLowerCase();
      if (!text) return showResults("");
      const hits = this.graph.nodes.filter((n) => n.title.toLowerCase().includes(text) || n.path.toLowerCase().includes(text))
        .sort((a, b) => Number(!a.title.toLowerCase().startsWith(text)) - Number(!b.title.toLowerCase().startsWith(text)) || b.degree - a.degree)
        .slice(0, 8);
      renderPicks(hits, esc(t("Enter to search inside notes")));
    });
    q.addEventListener("keydown", async (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.sel = Math.max(0, Math.min(this.picks.length - 1, this.sel + (e.key === "ArrowDown" ? 1 : -1)));
        results.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", i === this.sel));
      } else if (e.key === "Enter") {
        if (this.sel >= 0 && this.picks[this.sel]) return pick(this.picks[this.sel].path);
        const text = q.value.trim();
        if (text.length < 2) return;
        try {
          const hits: SearchHit[] = await this.api.search(text);
          renderPicks(hits.map((h) => ({ ...h, root: h.path.split("/")[0] })), esc(hits.length ? t("{n} notes mention “{q}”", { n: hits.length, q: text }) : t("Nothing mentions “{q}”", { q: text })));
        } catch (err) { this.toast((err as Error).message, true); }
      } else if (e.key === "Escape") { showResults(""); q.blur(); }
    });
    results.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button[data-i]") as HTMLElement | null;
      if (b) pick(this.picks[Number(b.dataset.i)].path);
    });
    this.on(document, "click", (e: MouseEvent) => { if (!this.q(".bm-search").contains(e.target as Node)) showResults(""); });
    this.on(document, "keydown", (e: KeyboardEvent) => {
      if (!this.visible || !this.host.isConnected) return;
      const a = document.activeElement;
      const typing = a instanceof HTMLTextAreaElement || (a instanceof HTMLInputElement && a !== q);
      if (e.key === "/" && a !== q && !typing) { e.preventDefault(); q.focus(); }
      if (e.key === "Escape" && !this.panel.current) this.q(".bm-settings").hidden = true;
    });
  }

  // ---------- new note ----------

  /** A title and where it goes (the open note, or the top of a tree); the new note opens in the editor. */
  private wireNew(): void {
    const box = this.q<HTMLFormElement>(".bn"), btn = this.q("[data-new]");
    const title = box.querySelector<HTMLInputElement>('[name="title"]')!, parent = box.querySelector<HTMLSelectElement>('[name="parent"]')!;
    const show = (on: boolean) => {
      box.hidden = !on;
      btn.setAttribute("aria-expanded", String(on));
      if (!on) return;
      const here = this.panel.current, roots = this.graph.nodes.filter((n) => n.parent_id === null).map((n) => n.path);
      const hubs = this.graph.nodes.filter((n) => n.parent_id !== null && n.kind === "hub" && !n.locked).map((n) => n.path).sort();
      const paths = [...new Set([...(here ? [here] : []), ...roots, ...hubs])];
      parent.replaceChildren(...paths.map((p) => Object.assign(document.createElement("option"), { value: p, textContent: p.split("/").join(" / ") })));
      title.value = "";
      title.focus();
    };
    btn.addEventListener("click", () => show(!!box.hidden));
    box.querySelector("[data-new-cancel]")!.addEventListener("click", () => show(false));
    box.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = title.value.trim();
      if (!name || name.includes("/")) { this.toast(t("A title can't be empty or contain /"), true); return; }
      const go = box.querySelector<HTMLButtonElement>('[type="submit"]')!;
      go.disabled = true;
      try {
        const made = await this.api.create(parent.value, name);
        show(false);
        await this.refresh();
        this.openNote(made.path, true);
      } catch (err) { this.toast((err as Error).message, true); }
      go.disabled = false;
    });
    this.on(document, "keydown", (e: KeyboardEvent) => { if (e.key === "Escape" && !box.hidden) show(false); });
  }

  // ---------- what changed elsewhere ----------

  /** Ask what changed since the last look; each change fires its notes like a live pulse. */
  private wirePoll(): void {
    const live = this.q(".bm-live");
    const tick = window.setInterval(async () => {
      if (this.dead || !this.visible || document.hidden) return;
      try {
        const acts = (await this.api.activity(this.lastSeen || new Date(Date.now() - POLL_MS).toISOString())).filter((a) => a.ts > this.lastSeen);
        if (this.dead) return;
        live.classList.add("on");
        if (!this.lastSeen) { this.lastSeen = acts.at(-1)?.ts ?? new Date().toISOString(); return; }
        if (!acts.length) return;
        this.lastSeen = acts.at(-1)!.ts;
        this.onPulse(acts.filter((a) => a.paths?.length).map((a) => ({ op: a.job, paths: a.paths, actor: a.actor ?? "" })));
      } catch { live.classList.remove("on"); }
    }, POLL_MS);
    this.cleanup.push(() => clearInterval(tick));
  }

  private onPulse(events: PulseEvent[]): void {
    if (this.dead || !events.length) return;
    let unknown = false;
    for (const ev of events) {
      const fired = this.graph.pulse(ev.paths, `${ev.op.replace(/_/g, " ")} · ${who(ev.actor)}`);
      if (fired.length < ev.paths.length) unknown = true;
      // someone else changed the note that is open (and it is not being edited): show the new text
      if (this.panel.current && ev.paths.includes(this.panel.current) && !this.host.querySelector(".bm-editor")) void this.panel.open(this.panel.current);
    }
    if (unknown || events.some((e) => ["create", "move", "lock_archive", "unlock", "link", "restore"].includes(e.op))) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(async () => { await this.refresh(); for (const ev of events) this.graph.pulse(ev.paths); }, 600);
    }
  }

  // ---------- replay and screensaver ----------

  private stopReplay(): void {
    this.replayTimers.forEach(clearTimeout);
    this.replayTimers = [];
  }

  /** Fire the changes in the order they happened, `step` ms apart; `names` puts each note's title next to its flash. */
  private play(acts: Activity[], o: { delay: number; slow: number; names: boolean; done?: () => void }): void {
    // About 20 seconds in all, never faster than ~6 changes a second or slower than one a second.
    const step = Math.max(160, Math.min(1000, 20000 / Math.max(1, acts.length))) * o.slow;
    acts.forEach((a, i) => this.replayTimers.push(window.setTimeout(() => {
      this.graph.pulse(a.paths, o.names ? this.graph.node(a.paths[0])?.title ?? a.paths[0].split("/").pop() : undefined);
    }, o.delay + i * step)));
    this.replayTimers.push(window.setTimeout(() => { this.replayTimers = []; o.done?.(); }, o.delay + acts.length * step + 1800));
  }

  private async changes(ms: number): Promise<Activity[]> {
    try {
      const acts = await this.api.activity(new Date(Date.now() - ms).toISOString());
      const newest = acts.at(-1)?.ts;
      if (newest && newest > this.lastSeen) this.lastSeen = newest;
      return acts.filter((a) => a.paths?.length).slice(-150);
    } catch { return []; /* not important */ }
  }

  /** On opening, play the changes of the chosen window (map settings → Replay) in the order they happened. */
  private async replay(delay = 2200): Promise<void> {
    this.stopReplay();
    if (!this.settings.animations || !this.visible || this.saver) return;
    const acts = await this.changes(REPLAY_MS[this.settings.replay]);
    if (this.dead || this.saver || !this.visible) return;
    this.play(acts, { delay, slow: 1, names: this.settings.replayLabels });
  }

  /** Anything the person does counts: the orbit waits 2 s again and a running screensaver ends. */
  private wireIdle(): void {
    const active = () => {
      this.lastActive = Date.now();
      this.graph.touch();
      if (this.saver) this.endScreensaver();
    };
    for (const type of ["pointermove", "pointerdown", "wheel", "keydown", "touchstart"]) this.on(document, type, active);
    const tick = window.setInterval(() => {
      if (this.saver || this.dead || !this.visible || document.hidden || !this.settings.animations) return;
      // Not over a note someone may be reading, an open box (New note, map settings), or the opening replay.
      if (this.panel.current || this.replayTimers.length || this.host.querySelector(".bn:not([hidden]), .bm-settings:not([hidden])")) { this.lastActive = Math.max(this.lastActive, Date.now() - SCREENSAVER_AFTER_MS + 5000); return; }
      if (Date.now() - this.lastActive >= SCREENSAVER_AFTER_MS) this.startScreensaver();
    }, 1000);
    this.cleanup.push(() => clearInterval(tick));
  }

  private startScreensaver(): void {
    this.saver = true;
    this.host.classList.add("bm--saver");
    this.graph.setScreensaver(true);
    const loop = async () => {
      const acts = await this.changes(REPLAY_MS["24h"]);
      if (!this.saver || this.dead) return;
      // A quiet day: only the orbit, and another look in a minute.
      if (!acts.length) { this.replayTimers.push(window.setTimeout(loop, 60_000)); return; }
      this.play(acts, { delay: 600, slow: 2, names: false, done: () => { if (this.saver) void loop(); } });
    };
    void loop();
  }

  private endScreensaver(): void {
    if (!this.saver) return;
    this.saver = false;
    this.host.classList.remove("bm--saver");
    this.graph.setScreensaver(false);
    this.stopReplay();
  }
}
