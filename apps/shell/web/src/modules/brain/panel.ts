// The note panel: read, follow links, edit with link suggestions, lock & archive.
// Note text is markdown: it is turned into HTML and cleaned (DOMPurify) before it is shown.

import { marked, DOMPurify } from "../../../vendor/brain-map.js";
import type { BrainSource } from "./source.ts";
import { attachLinker, type Suggestion } from "./linker.ts";
import { t } from "../../i18n.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface PanelHandlers {
  go(path: string): void;          // open another note (and fly to it)
  toast(msg: string, err?: boolean): void;
  changed(): void;                 // a write happened: refresh the graph
  closed(): void;
}

/** Turn [[Target|alias]] into links the panel can follow. */
function wikilinksToHtml(md: string, resolve: (title: string) => string | null) {
  return md.replace(/\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|([^\]\n]*))?\]\]/g, (_, target: string, alias?: string) => {
    const path = resolve(target.trim());
    const text = esc(alias?.trim() || target.trim());
    return path ? `<a class="wl" data-path="${esc(path)}">${text}</a>` : `<a class="wl missing" title="No note yet">${text}</a>`;
  });
}

function sparkline(values: number[], w = 120, h = 28) {
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * (w - 4) + 2;
  const y = (v: number) => h - 2 - ((v - min) / span) * (h - 4);
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  return `<svg class="bm-spark__svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}"/>${values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="1.8"/>`).join("")}</svg>`;
}

function recordsHtml(records: any[]) {
  if (!records?.length) return "";
  const byKind = new Map<string, any[]>();
  for (const r of records) (byKind.get(r.kind) ?? byKind.set(r.kind, []).get(r.kind)!).push(r);
  let html = "";
  for (const [kind, rows] of byKind) {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r.fields)))];
    html += `<div class="bm-section"><h4>${esc(kind.replace(/_/g, " "))}</h4>`;
    // A small trend per marker when there are two or more numeric values over time.
    const markerKey = cols.includes("marker") ? "marker" : null;
    if (markerKey && cols.includes("value")) {
      const series = new Map<string, { d: string; v: number; u: string }[]>();
      for (const r of rows) {
        const v = Number(r.fields.value);
        if (!Number.isFinite(v)) continue;
        const m = String(r.fields.marker);
        (series.get(m) ?? series.set(m, []).get(m)!).push({ d: r.date, v, u: r.fields.unit ?? "" });
      }
      for (const [m, pts] of series) if (pts.length > 1) {
        pts.sort((a, b) => a.d.localeCompare(b.d));
        html += `<div class="bm-spark">${sparkline(pts.map((p) => p.v))}<span><b>${esc(m)}</b> ${esc(pts.at(-1)!.v)} ${esc(pts.at(-1)!.u)} <span class="muted">· ${pts.length} results since ${esc(pts[0].d)}</span></span></div>`;
      }
    }
    html += `<table class="bm-rec"><thead><tr><th>Date</th>${cols.map((c) => `<th>${esc(c.replace(/_/g, " "))}</th>`).join("")}</tr></thead><tbody>`;
    for (const r of [...rows].sort((a, b) => b.date.localeCompare(a.date))) {
      html += `<tr><td>${esc(r.date)}</td>${cols.map((c) => `<td>${esc(r.fields[c] ?? "")}</td>`).join("")}</tr>`;
    }
    html += "</tbody></table></div>";
  }
  return html;
}

export class Panel {
  current: string | null = null;
  private note: any = null;
  private revealed = false;
  private linker: { destroy(): void } | null = null;
  private el: HTMLElement;
  private api: BrainSource;
  private h: PanelHandlers;
  private resolveTitle: (title: string) => string | null;
  private notes: () => Suggestion[];

  constructor(el: HTMLElement, api: BrainSource, h: PanelHandlers, resolveTitle: (title: string) => string | null, notes: () => Suggestion[]) {
    this.el = el; this.api = api; this.h = h; this.resolveTitle = resolveTitle; this.notes = notes;
    el.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("[data-path]") as HTMLElement | null;
      if (a?.dataset.path) { e.preventDefault(); this.h.go(a.dataset.path); }
    });
  }

  /** edit: go straight to the editor (a note that was just made). */
  async open(path: string, edit = false) {
    this.current = path;
    this.revealed = false;
    this.el.hidden = false;
    this.el.innerHTML = `<div class="bm-scroll"><p class="muted bm-loading">${esc(t("Loading…"))}</p></div>`;
    try {
      this.note = await this.api.note(path);
      if (this.current === path) { if (edit && !this.note.locked) this.edit(); else this.render(); }
    } catch (e) {
      this.el.innerHTML = `<button class="bm-close" aria-label="Close">×</button><div class="bm-scroll"><p class="bm-loading">Couldn't open this note: ${esc((e as Error).message)}</p></div>`;
      this.el.querySelector(".bm-close")!.addEventListener("click", () => this.close());
    }
  }

  close() {
    this.dropLinker();
    this.current = null;
    this.note = null;
    this.el.hidden = true;
    this.el.innerHTML = "";
    this.h.closed();
  }

  /** Leave quietly (the map is being torn down): no callbacks. */
  dispose() { this.dropLinker(); }

  private header() {
    const n = this.note;
    const parts = n.path.split("/");
    const crumbs = parts.slice(0, -1).map((p: string, i: number) => `<a data-path="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</a>`).join("<span>/</span>");
    const fm = n.frontmatter ?? {};
    const chips = [
      fm.type && `<span class="bm-chip">${esc(fm.type)}</span>`,
      fm.status && fm.status !== "active" && `<span class="bm-chip">${esc(fm.status)}</span>`,
      n.sensitivity !== "normal" && `<span class="bm-chip bm-chip--warn">${esc(n.sensitivity)}</span>`,
      n.locked && `<span class="bm-chip bm-chip--lock">locked · archived ${esc(n.archived ?? "")}</span>`,
      fm.booking && `<span class="bm-chip ${fm.booking === "confirmed" ? "bm-chip--ok" : "bm-chip--warn"}">booking: ${esc(fm.booking)}</span>`,
      fm.updated && `<span class="bm-chip">updated ${esc(fm.updated)}</span>`,
      `<span class="bm-chip">v${esc(n.version)}</span>`,
    ].filter(Boolean).join("");
    return `<button class="bm-close" aria-label="Close">×</button>
      <header class="bm-panel__head">
        <div class="bm-crumbs">${crumbs || "&nbsp;"}</div>
        <h1>${esc(n.title)}</h1>
        <div class="bm-chips">${chips}</div>
        <div class="bm-actions">
          ${n.locked ? `<button class="bm-btn" data-act="unlock">Unlock</button>` : `<button class="bm-btn" data-act="edit">Edit</button><button class="bm-btn bm-btn--danger" data-act="lock">Lock &amp; archive</button>`}
        </div>
      </header>`;
  }

  private dropLinker() { this.linker?.destroy(); this.linker = null; }

  private render() {
    this.dropLinker();
    const n = this.note;
    const resolve = (title: string) => n.links?.find((l: any) => l.target.toLowerCase() === title.toLowerCase())?.path ?? this.resolveTitle(title);
    const body = DOMPurify.sanitize(marked.parse(wikilinksToHtml(n.body ?? "", resolve), { async: false }) as string, { ADD_ATTR: ["data-path"] });
    const hide = n.sensitivity === "sensitive" && !this.revealed;
    const list = (items: any[], fmt: (x: any) => string) => (items?.length ? `<div class="bm-list">${items.map(fmt).join("")}</div>` : `<p class="muted">None</p>`);
    const fm = n.frontmatter ?? {};
    const tags = Array.isArray(fm.tags) && fm.tags.length ? `<div class="bm-chips bm-tags">${fm.tags.map((tag: string) => `<span class="bm-chip">#${esc(tag)}</span>`).join("")}</div>` : "";
    this.el.innerHTML = `${this.header()}
      <div class="bm-scroll">
        <div class="bm-body${hide ? " bm-blurred" : ""}">
          <div class="bm-md">${body || '<p class="muted">Empty note.</p>'}</div>
          ${hide ? `<div class="bm-reveal"><button class="bm-btn" data-act="reveal">Show sensitive note</button></div>` : ""}
        </div>
        ${hide ? "" : recordsHtml(n.records)}
        ${n.calendar?.length ? `<div class="bm-section"><h4>Calendar</h4>${list(n.calendar, (c) => `<a>${esc(c.title)} <small>${esc(c.calendar)} · ${esc(c.status)}${c.start ? " · " + esc(String(c.start).slice(0, 10)) : ""}</small></a>`)}</div>` : ""}
        ${n.children?.length ? `<div class="bm-section"><h4>Inside</h4>${list(n.children, (c) => `<a data-path="${esc(c.path)}">${esc(c.title)}<small>${esc(c.kind === "hub" ? "hub" : c.type)}${c.archived_at ? " · archived" : ""}</small></a>`)}</div>` : ""}
        <div class="bm-section"><h4>Linked from</h4>${list(n.backlinks, (b) => `<a data-path="${esc(b.path)}">${esc(b.path.split("/").pop())}<small>${esc(b.kind)}</small></a>`)}</div>
        ${tags}
        <div class="bm-section"><h4>History</h4><div class="bm-hist">${
          (n.history ?? []).length
            ? n.history.slice(0, 12).map((h: any) => `<div><b>v${esc(h.version)}</b> · ${esc(String(h.changed_at).slice(0, 16).replace("T", " "))} · ${esc(h.changed_by)}<br>${esc(h.summary)}</div>`).join("")
            : `<div>Only this version.</div>`
        }</div></div>
      </div>`;
    this.wire();
  }

  private edit() {
    const n = this.note;
    this.el.innerHTML = `${this.header()}<div class="bm-scroll bm-scroll--edit">
      <label class="bm-field"><span>Title</span><input class="bm-title-in" value="${esc(n.title)}" maxlength="120" spellcheck="true" /></label>
      <textarea class="bm-editor" spellcheck="true">${esc(n.body ?? "")}</textarea>
      <p class="muted bm-tiptext">Type <kbd>@</kbd> or <kbd>[[</kbd> to link another note.</p>
      <input class="bm-summary" placeholder="What changed? (optional, goes in the log)" maxlength="300" />
      <div class="bm-actions"><button class="bm-btn bm-btn--primary" data-act="save">Save</button><button class="bm-btn" data-act="cancel">Cancel</button><span class="muted bm-kbd-hint">⌘↩ saves</span></div>
      <p class="muted bm-foot">Renaming updates the links to this note in every other note. Frontmatter stays as it is; the previous version is kept in history.</p></div>`;
    this.el.querySelector<HTMLElement>(".bm-actions [data-act=edit]")?.setAttribute("disabled", "");
    this.wire();
    const ta = this.el.querySelector<HTMLTextAreaElement>("textarea")!;
    this.linker = attachLinker(ta, this.notes);
    const save = this.el.querySelector<HTMLButtonElement>("[data-act=save]")!;
    this.el.querySelector(".bm-scroll")!.addEventListener("keydown", (e) => {
      const k = e as KeyboardEvent;
      if (k.key === "Enter" && (k.metaKey || k.ctrlKey)) { k.preventDefault(); save.click(); }
    });
    ta.focus();
  }

  private wire() {
    this.el.querySelector(".bm-close")!.addEventListener("click", () => this.close());
    this.el.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => b.addEventListener("click", () => this.act(b.dataset.act!, b)));
  }

  private async act(what: string, btn: HTMLButtonElement) {
    const n = this.note;
    try {
      if (what === "reveal") { this.revealed = true; this.render(); }
      if (what === "edit") this.edit();
      if (what === "cancel") this.render();
      if (what === "save") {
        const body = this.el.querySelector<HTMLTextAreaElement>("textarea")!.value;
        const title = this.el.querySelector<HTMLInputElement>("input.bm-title-in")!.value.trim();
        const summary = this.el.querySelector<HTMLInputElement>("input.bm-summary")!.value.trim();
        if (!title || title.includes("/")) { this.h.toast(t("A title can't be empty or contain /"), true); return; }
        if (body === n.body && title === n.title) { this.render(); return; }
        btn.disabled = true;
        const r = await this.api.save(n.path, n.version, body, summary || "Edited on the Brain page", title);
        const moved = r.links_updated_in?.length ?? 0;
        this.h.toast(title !== n.title ? `Renamed${moved ? ` · links updated in ${moved} note${moved > 1 ? "s" : ""}` : ""}` : "Saved");
        await this.open(r.path ?? n.path);
        this.h.changed();
      }
      if (what === "lock") {
        if (!confirm(`Lock & archive "${n.title}"?\n\nIt stays readable and searchable as long-distance memory, but can't be edited until it's unlocked.`)) return;
        btn.disabled = true;
        await this.api.lock(n.path);
        this.h.toast(t("Locked & archived"));
        await this.open(n.path);
        this.h.changed();
      }
      if (what === "unlock") {
        btn.disabled = true;
        await this.api.lock(n.path, true);
        this.h.toast(t("Unlocked"));
        await this.open(n.path);
        this.h.changed();
      }
    } catch (e) {
      btn.disabled = false;
      this.h.toast((e as Error).message, true);
    }
  }
}
