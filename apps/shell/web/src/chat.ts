// The conversation view: questions, streamed answers, the tools used, and a card for every change that waits for a
// yes. Everything the assistant or a tool returns goes into the page as text (textContent), never as HTML.
import { html, mount, type Raw } from "./html.ts";
import { icon } from "./icons.ts";
import { who } from "./api.ts";
import { alfred, toolName, type AlfredEvent, type Turn, type Waiting } from "./alfred.ts";
import { t } from "./i18n.ts";

/** A conversation left alone this long is over: the next message starts a fresh one. Short conversations keep
 *  the assistant quick. Earlier ones stay under Recent. */
const IDLE_MS = 15 * 60_000;

/** An icon per gateway service; a service not listed here gets the spark. */
const TOOL_ICON: Record<string, string> = { brain: "brain", calendar: "calendar", home: "home", devices: "monitor", finance: "wallet", health: "activity" };
const toolIcon = (name: string): Raw => icon(TOOL_ICON[name.split("__")[0]] ?? "spark");

/** A compact, readable view of what a write would do: "path: Family/Home · append: …". */
function preview(input: Record<string, unknown>): string {
  return Object.entries(input)
    .filter(([k]) => k !== "base_version")
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n")
    .slice(0, 1200);
}

export interface ChatOptions {
  thread: HTMLElement;
  /** called when a conversation starts or is cleared */
  onConversation?: (id: string) => void;
  /** a skill the assistant applies to every message sent from here */
  skill?: string;
}

interface AnswerBox {
  box: HTMLElement;
  labels: Map<string, string>;
  text(delta: string): void;
  label(id: string, l: string): void;
  tool(id: string, name: string, label: string, status: string): void;
  error(msg: string): void;
  finish(): void;
}

export class Chat {
  id = "";
  private busy = false;
  private last = 0;
  private o: ChatOptions;
  /** Every page load starts a new conversation: nothing is restored. */
  constructor(o: ChatOptions) { this.o = o; }

  private setId(id: string): void {
    this.id = id;
    this.o.onConversation?.(id);
  }

  get isBusy(): boolean { return this.busy; }

  reset(): void {
    this.o.thread.replaceChildren();
    document.body.classList.remove("is-chatting");
    this.setId("");
  }

  /** Show an earlier conversation. */
  async open(id: string): Promise<void> {
    const { turns, waiting } = await alfred.history(id);
    this.o.thread.replaceChildren();
    document.body.classList.toggle("is-chatting", turns.length > 0);
    let a: HTMLElement | null = null;
    for (const turn of turns) a = this.renderTurn(turn);
    if (waiting.length && a) this.renderConfirms(a, waiting);
    this.last = Date.now();
    this.setId(id);
  }

  async send(q: string): Promise<void> {
    q = q.trim();
    if (!q || this.busy) return;
    if (this.id && Date.now() - this.last > IDLE_MS) this.reset();
    this.last = Date.now();
    document.body.classList.add("is-chatting");
    const turn = el("div", "turn");
    turn.append(el("p", "turn__q", q));
    const a = this.answerBox();
    turn.append(a.box);
    this.o.thread.append(turn);
    this.scroll();
    await this.stream(alfred.ask(q, this.id, this.o.skill), a);
  }

  private async stream(events: AsyncGenerator<AlfredEvent>, a: AnswerBox): Promise<void> {
    this.busy = true;
    const waiting: Waiting[] = [];
    try {
      for await (const e of events) {
        switch (e.type) {
          case "start":
            if (e.conversation_id !== this.id) this.setId(e.conversation_id);
            break;
          case "text": a.text(e.delta); break;
          case "tool": a.tool(e.id, e.name, e.label, e.status); break;
          case "confirm": waiting.push({ id: e.id, name: e.name, input: e.input, for_other: e.for_other, health_chat: e.health_chat }); a.label(e.id, e.label); break;
          case "error": a.error(e.message); break;
          case "done": break;
        }
        this.scroll();
      }
    } catch {
      a.error(t("The connection dropped. Your message is saved; ask again to continue."));
    } finally {
      a.finish();
      this.busy = false;
      this.last = Date.now();
    }
    if (waiting.length) this.renderConfirms(a.box, waiting, a.labels);
  }

  /** One card per waiting write, under the answer that proposed it. Once every card has an answer, the decisions
   *  go to the assistant together. */
  private renderConfirms(box: HTMLElement, waiting: Waiting[], labels: Map<string, string> = new Map()): void {
    const decided = new Map<string, boolean>();
    const wrap = el("div", "confirms");
    for (const w of waiting) {
      const card = el("div", "confirm");
      mount(card, html`
        <header>${toolIcon(w.name)}<b></b><span class="pill pill--amber">${t("needs your OK")}</span></header>
        <pre class="confirm__what"></pre>
        <footer>
          <button type="button" class="btn btn--line btn--sm" data-ok="0">${icon("x")}${t("Decline")}</button>
          <button type="button" class="btn btn--ink btn--sm" data-ok="1">${icon("check")}${t("Approve")}</button>
        </footer>`);
      const what = card.querySelector("pre")!;
      card.querySelector("b")!.textContent = labels.get(w.id) ?? toolName(w.name);
      what.textContent = preview(w.input);
      if (w.for_other) {
        // a write to another person's records: say whose, and show the words that asked for it
        const name = who.people.find((p) => p.id === w.for_other!.person)?.name ?? w.for_other.person;
        what.before(note(t("This is for {name}, not for you.", { name }), `${t("You asked")}: “${w.for_other.asked}”`));
      }
      if (w.health_chat) {
        // from a chat about health records: notes are shared memory, so check nothing clinical goes in
        what.before(note(t("From a health chat."), t("This goes into the shared notes: check that no results, values or diagnoses are in it.")));
      }
      card.querySelectorAll<HTMLButtonElement>("[data-ok]").forEach((b) => b.addEventListener("click", () => {
        if (this.busy) return;
        const ok = b.dataset.ok === "1";
        decided.set(w.id, ok);
        card.classList.add(ok ? "is-approved" : "is-declined");
        card.querySelector(".pill")!.textContent = ok ? t("approved") : t("declined");
        card.querySelectorAll("button").forEach((x) => { x.disabled = true; });
        if (decided.size === waiting.length) void this.decide(box, [...decided].map(([id, yes]) => ({ id, ok: yes })));
      }));
      wrap.append(card);
    }
    (box.querySelector(".turn__body") ?? box).append(wrap);
    this.scroll();
  }

  private async decide(after: HTMLElement, decisions: { id: string; ok: boolean }[]): Promise<void> {
    const a = this.answerBox();
    after.after(a.box);
    await this.stream(alfred.decide(this.id, decisions), a);
  }

  private renderTurn(turn: Turn): HTMLElement {
    if (turn.role === "user") {
      const box = el("div", "turn");
      box.append(el("p", "turn__q", turn.text));
      this.o.thread.append(box);
      return box;
    }
    const a = this.answerBox();
    turn.tools.forEach((name, i) => a.tool(`h${i}`, name, toolName(name), "done"));
    if (turn.text) a.text(turn.text);
    a.finish();
    (this.o.thread.lastElementChild ?? this.o.thread).append(a.box);
    return a.box;
  }

  /** The answer area: a mark that pulses while waiting, tool chips, the streamed text, and errors. */
  private answerBox(): AnswerBox {
    const box = el("div", "turn__a is-waiting");
    mount(box, html`<span class="turn__mark">${icon("spark")}</span><div class="turn__body"><ul class="tools"></ul><p class="turn__text"><span class="turn__wait">${t("Thinking …")}</span></p></div>`);
    const tools = box.querySelector<HTMLUListElement>(".tools")!;
    const p = box.querySelector<HTMLParagraphElement>(".turn__text")!;
    const chips = new Map<string, HTMLLIElement>();
    const labels = new Map<string, string>();
    let started = false;
    const clearWait = () => { if (!started) { started = true; p.textContent = ""; } };
    return {
      box,
      labels,
      text(delta) { clearWait(); p.append(delta); },
      label(id, l) { labels.set(id, l); },
      tool(id, name, label, status) {
        labels.set(id, label);
        let li = chips.get(id);
        if (!li) {
          li = el("li", "tool");
          mount(li, html`${toolIcon(name)}<span></span>`);
          li.querySelector("span")!.textContent = label;
          tools.append(li);
          chips.set(id, li);
        }
        li.dataset.status = status;
      },
      error(msg) { clearWait(); p.after(el("p", "turn__err", msg)); },
      finish() {
        if (!started) p.remove();
        box.classList.remove("is-waiting");
      },
    };
  }

  private scroll(): void {
    this.o.thread.lastElementChild?.scrollIntoView({ block: "end", behavior: "smooth" });
  }
}

function note(strong: string, rest: string): HTMLElement {
  const p = el("p", "confirm__for");
  p.append(el("b", "", strong), el("span", "", ` ${rest}`));
  return p;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
