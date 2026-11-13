// The assistant's page (/home/assistant): the conversation, with the recent ones on the side.
// The name on the page is the household's own (Assistant settings); "Alfred" until it is known.
import { html, mount, $, type Raw } from "../html.ts";
import { icon } from "../icons.ts";
import { Chat } from "../chat.ts";
import { alfred, type ConversationRow } from "../alfred.ts";
import { t, loc } from "../i18n.ts";

export function assistant(): Raw {
  return html`
  <div class="split assistant">
    <div class="split__main">
      <section class="hello">
        <div class="hello__orb">${icon("spark")}</div>
        <h1 class="hello__title" id="al-name">Alfred</h1>
        <p class="muted small hello__sub">${t("Ask about your home, calendars, notes and records. Lights switch at once; every other change waits for your OK.")}</p>
        <div class="thread" id="thread" aria-live="polite"></div>
        <form class="ask" id="ask">
          <textarea id="ask-input" rows="2" placeholder="${t("Ask something …")}" aria-label="${t("Your message")}"></textarea>
          <div class="ask__bar">
            <button type="button" class="btn btn--line btn--sm" id="new-chat">${icon("plus")}${t("New conversation")}</button>
            <button type="submit" class="btn btn--ink btn--square ask__send" aria-label="${t("Send")}">${icon("send")}</button>
          </div>
        </form>
        <p class="fine">${t("The assistant can make mistakes: check what matters. It only reaches what its key and its settings allow.")}</p>
      </section>
    </div>
    <aside class="split__side">
      <h2 class="h2">${icon("chat")}${t("Recent")}</h2>
      <div class="card list" id="recent"><p class="muted small list__empty">${t("Loading …")}</p></div>
    </aside>
  </div>`;
}

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(loc(), { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(loc(), { day: "2-digit", month: "short" });
}

export function assistantInit(): void {
  const form = $<HTMLFormElement>("#ask")!;
  const input = $<HTMLTextAreaElement>("#ask-input")!;
  const recent = $("#recent")!;
  let rows: ConversationRow[] = [];

  void alfred.name().then((name) => {
    const h = $("#al-name");
    if (h) h.textContent = name; // gone when the person has already moved to another page
  });

  const renderRecent = (active: string) => {
    if (!recent.isConnected) return;
    if (!rows.length) {
      mount(recent, html`<p class="muted small list__empty">${t("No conversations yet.")}</p>`);
      return;
    }
    mount(recent, html`${rows.map((r) => html`
      <button type="button" class="list__row list__row--btn${r.id === active ? " is-active" : ""}" data-id="${r.id}">
        <span class="chip-ic">${icon("chat")}</span><span class="list__txt"><b></b><small>${when(r.updated)}</small></span>
      </button>`)}`);
    // titles are the person's own words: set as text
    recent.querySelectorAll<HTMLButtonElement>("[data-id]").forEach((b, i) => {
      b.querySelector("b")!.textContent = rows[i].title;
      b.addEventListener("click", () => { if (!chat.isBusy) void chat.open(b.dataset.id!).catch(() => chat.reset()); });
    });
  };

  const refresh = async (active: string) => {
    try { rows = (await alfred.conversations()).conversations; } catch { rows = []; }
    renderRecent(active);
  };

  const chat = new Chat({ thread: $("#thread")!, onConversation: (id) => renderRecent(id) });

  const send = (q: string) => {
    if (!q.trim() || chat.isBusy) return;
    input.value = "";
    void chat.send(q).then(() => refresh(chat.id));
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  $("#new-chat")!.addEventListener("click", () => { if (!chat.isBusy) { chat.reset(); input.focus(); } });

  void refresh(chat.id);
}
