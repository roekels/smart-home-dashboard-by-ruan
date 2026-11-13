// Shopping and to-do lists on Today: each person sees the shared lists and their own (GET /api/lists).
// Tick an item off, tap again to bring it back; add with the line under each list. Nothing is deleted from here.
import { html, mount, $, type Raw } from "./html.ts";
import { api, type TodoList } from "./api.ts";
import { icon } from "./icons.ts";
import { t } from "./i18n.ts";

/** Ticked here since the last reading: shown struck through until the list is read again, so it can be undone. */
const ticked = new Set<string>();
let busy = 0;

export function listsSection(): Raw {
  return html`<section class="lists" aria-labelledby="lists-h" id="lists-box" hidden>
    <h2 class="h2" id="lists-h">${icon("list")}${t("Lists")}</h2>
    <div class="todo-grid" id="lists"></div>
  </section>`;
}

function card(l: TodoList): Raw {
  const items = l.items.filter((i) => !i.done || ticked.has(`${l.entity}|${i.uid}`));
  return html`<article class="card todo" data-list="${l.entity}">
    <header class="room__head"><h3>${l.name}</h3><span class="kicker">${l.shared ? `${t("shared")} · ` : ""}${t("{n} open", { n: l.open })}</span></header>
    <ul class="todo__items">${items.length ? items.map((i) => html`<li>
      <button class="todo__item${i.done ? " is-done" : ""}" data-item="${i.uid}" aria-pressed="${String(i.done)}">
        <span class="todo__box">${i.done ? icon("check") : ""}</span><span>${i.text}</span></button></li>`) : html`<li class="muted small">${t("Nothing open.")}</li>`}</ul>
    <form class="ask-line todo__add" data-add="${l.entity}">${icon("plus")}<input name="text" maxlength="200" autocomplete="off" placeholder="${t("Add to {list}", { list: l.name })}" aria-label="${t("Add to {list}", { list: l.name })}"></form>
  </article>`;
}

export async function loadLists(): Promise<void> {
  const box = $("#lists");
  if (!box || busy) return;
  let lists: TodoList[];
  try {
    lists = (await api.lists()).lists;
  } catch {
    return; // not answering: the rest of the page carries on, the next round tries again
  }
  if (!$("#lists") || busy || box.contains(document.activeElement)) return; // never redraw under typing
  ticked.clear();
  $("#lists-box")!.hidden = !lists.length;
  mount(box, html`${lists.map(card)}`);
}

async function run(what: () => Promise<unknown>, say: (m: string) => void): Promise<void> {
  busy++;
  try { await what(); say(""); } catch (e) { say(t("List: {error}", { error: (e as Error).message })); } finally { busy--; }
}

export function wireLists(root: HTMLElement, say: (m: string) => void): void {
  ticked.clear();
  busy = 0;
  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-item]");
    const list = b?.closest<HTMLElement>("[data-list]")?.dataset.list;
    if (!b || !list || b.disabled) return;
    const done = b.getAttribute("aria-pressed") !== "true", key = `${list}|${b.dataset.item}`;
    b.setAttribute("aria-pressed", String(done));
    b.classList.toggle("is-done", done);
    mount(b.querySelector(".todo__box")!, done ? icon("check") : html``);
    if (done) ticked.add(key); else ticked.delete(key);
    b.disabled = true;
    void run(() => api.setListItem(list, b.dataset.item!, done), say).finally(() => { b.disabled = false; });
  });
  root.addEventListener("submit", (e) => {
    const f = (e.target as HTMLElement).closest<HTMLFormElement>("[data-add]");
    if (!f) return;
    e.preventDefault();
    const input = f.querySelector("input")!, text = input.value.trim();
    if (!text) return;
    input.value = "";
    void run(async () => {
      await api.addListItem(f.dataset.add!, text);
      input.blur();
      await loadLists();
    }, say);
  });
}
