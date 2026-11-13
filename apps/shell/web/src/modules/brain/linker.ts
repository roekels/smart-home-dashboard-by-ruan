// Link suggestions while typing in the editor: "@" or "[[" followed by a few letters shows matching notes;
// Enter, Tab or a click puts in [[Title]] (or [[path|Title]] when two notes share that title).

import { swatch } from "./palette.ts";

export interface Suggestion { title: string; path: string; root: string; degree: number }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Where the caret is inside a textarea, in page pixels (a hidden copy of the text measures it). */
function caretXY(ta: HTMLTextAreaElement, pos: number) {
  const cs = getComputedStyle(ta);
  const m = document.createElement("div");
  for (const k of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderLeftWidth", "boxSizing", "tabSize"] as const) (m.style as any)[k] = cs[k];
  Object.assign(m.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word", width: `${ta.clientWidth}px`, top: "0", left: "-9999px" });
  m.textContent = ta.value.slice(0, pos);
  const mark = document.createElement("span");
  mark.textContent = "​";
  m.append(mark);
  document.body.append(m);
  const r = ta.getBoundingClientRect();
  const out = { x: r.left + mark.offsetLeft - ta.scrollLeft, y: r.top + mark.offsetTop - ta.scrollTop, h: parseFloat(cs.lineHeight) || 20 };
  m.remove();
  return out;
}

export function attachLinker(ta: HTMLTextAreaElement, notes: () => Suggestion[]) {
  const box = document.createElement("div");
  box.className = "bm-linker";
  box.hidden = true;
  document.body.append(box);
  let items: Suggestion[] = [];
  let sel = 0;
  let trigger: { start: number; end: number } | null = null;

  const close = () => { box.hidden = true; trigger = null; items = []; };

  /** "@query" (not inside a word or an email) or "[[query" right before the caret. */
  function findTrigger() {
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) return null;
    const before = ta.value.slice(Math.max(0, pos - 60), pos);
    const m = before.match(/(?:^|[^\w@])(@|\[\[)([^@\n\[\]|#]{0,50})$/);
    if (!m) return null;
    const q = m[2];
    if (m[1] === "@" && /^\s/.test(q)) return null;
    return { start: pos - q.length - m[1].length, end: pos, q };
  }

  function rank(q: string) {
    const t = q.trim().toLowerCase();
    const all = notes();
    if (!t) return [...all].sort((a, b) => b.degree - a.degree).slice(0, 8);
    const score = (n: Suggestion) => {
      const title = n.title.toLowerCase();
      if (title === t) return 0;
      if (title.startsWith(t)) return 1;
      if (title.split(/\s+/).some((w) => w.startsWith(t))) return 2;
      if (title.includes(t)) return 3;
      if (n.path.toLowerCase().includes(t)) return 4;
      return 9;
    };
    return all.map((n) => [score(n), n] as const).filter(([s]) => s < 9)
      .sort((a, b) => a[0] - b[0] || b[1].degree - a[1].degree).slice(0, 8).map(([, n]) => n);
  }

  function render() {
    box.innerHTML = items.map((n, i) => `<button type="button" data-i="${i}" class="${i === sel ? "on" : ""}">${swatch(n.root)}<b>${esc(n.title)}</b><small>${esc(n.path.split("/").slice(0, -1).join(" / "))}</small></button>`).join("")
      + `<div class="bm-hint">↑↓ choose · Enter links · Esc closes</div>`;
  }

  function update() {
    const t = findTrigger();
    if (!t) return close();
    items = rank(t.q);
    if (!items.length) return close();
    trigger = { start: t.start, end: t.end };
    sel = Math.min(sel, items.length - 1);
    render();
    const c = caretXY(ta, t.start);
    box.hidden = false;
    const w = Math.min(340, innerWidth - 24);
    box.style.width = `${w}px`;
    box.style.left = `${Math.max(12, Math.min(c.x, innerWidth - w - 12))}px`;
    const below = c.y + c.h + 4;
    box.style.top = below + box.offsetHeight > innerHeight - 8 ? `${Math.max(8, c.y - box.offsetHeight - 4)}px` : `${below}px`;
  }

  function choose(i: number) {
    const n = items[i];
    if (!n || !trigger) return;
    const shared = notes().filter((x) => x.title.toLowerCase() === n.title.toLowerCase()).length > 1;
    const link = shared ? `[[${n.path}|${n.title}]]` : `[[${n.title}]]`;
    ta.focus();
    ta.setSelectionRange(trigger.start, trigger.end);
    // execCommand keeps the browser's undo history; fall back to plain assignment.
    if (!document.execCommand("insertText", false, link)) {
      ta.value = ta.value.slice(0, trigger.start) + link + ta.value.slice(trigger.end);
      ta.setSelectionRange(trigger.start + link.length, trigger.start + link.length);
    }
    close();
  }

  ta.addEventListener("input", () => { sel = 0; update(); });
  ta.addEventListener("click", update);
  ta.addEventListener("blur", () => setTimeout(close, 150));
  ta.addEventListener("scroll", () => { if (!box.hidden) update(); });
  ta.addEventListener("keydown", (e) => {
    if (box.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      render();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      choose(sel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  box.addEventListener("mousedown", (e) => {
    e.preventDefault(); // keep focus in the textarea
    const b = (e.target as HTMLElement).closest("button[data-i]") as HTMLElement | null;
    if (b) choose(Number(b.dataset.i));
  });
  return { destroy: () => box.remove() };
}
