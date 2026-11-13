// /setup/keys: the one-time key page (admins). The keys are made here, in this browser, with the browser's own
// random generator. They are shown once so the person can save them in a password manager, then sent to the
// dashboard Worker, which stores them as secrets and locks the page. They are never kept in the page's storage.
import { html, mount, $, $$, type Raw } from "../html.ts";
import { icon } from "../icons.ts";
import { call } from "../api.ts";
import { t } from "../i18n.ts";

type Kind = "key" | "passphrase";
interface KeyRow { name: string; purpose: string; kind: Kind; set: boolean }
interface Status { state: "closed" | "open" | "locked"; keys: KeyRow[]; saved?: string[] }

let status: Status | null = null;
let made: Record<string, string> = {};

/** 32 random bytes as base64: what every encryption key in this system is. */
export function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}

/** Five groups of five characters, without the ones that look alike (0 O 1 l I). About 145 bits. */
export function newPassphrase(): string {
  const abc = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const limit = 256 - (256 % abc.length);   // drop the bytes that would favour the first letters
  const out: string[] = [];
  while (out.length < 25) for (const b of crypto.getRandomValues(new Uint8Array(40))) if (b < limit && out.length < 25) out.push(abc[b % abc.length]!);
  return [0, 5, 10, 15, 20].map((i) => out.slice(i, i + 5).join("")).join("-");
}

const head = (text: string): Raw => html`
  <section class="page-head"><div>
    <h1 class="h1">${t("Encryption keys")}</h1>
    <p class="muted">${text}</p>
  </div></section>`;

function note(ic: string, title: string, text: string): Raw {
  return html`<section class="card set__card keys__note"><h2 class="h2">${icon(ic)}${title}</h2><p class="muted">${text}</p></section>`;
}

function body(): Raw {
  if (!status) return html`<p class="muted">${t("Loading…")}</p>`;
  if (status.state === "closed") {
    return note("lock", t("This page is closed"),
      t("Keys are made here once, during setup. Your AI opens this page when it is time and closes it afterwards. If your keys are already made, there is nothing to do."));
  }
  if (status.state === "locked") {
    return html`
    ${note("shield", t("Done. This page is now locked"), t("Every key is stored and the page can no longer write anything. Tell your AI it can go on."))}
    <section class="card set__card"><ul class="keys">${status.keys.map((k) => html`
      <li class="set__row"><span class="chip-ic">${icon("key")}</span><span class="set__txt"><b>${k.name}</b><small>${k.purpose}</small></span><span class="pill pill--green">${t("stored")}</span></li>`)}</ul></section>`;
  }
  const todo = status.keys.filter((k) => !k.set);
  const ready = todo.length > 0 && todo.every((k) => made[k.name]);
  return html`
  <section class="card set__card">
    <h2 class="h2">${icon("key")}${t("Your keys")}</h2>
    <p class="muted">${t("These keys lock your private data. They are made in this browser and shown only once. Save each one in your password manager under exactly its name before you go on. If a key is lost, the data it locks cannot be read again.")}</p>
    <ul class="keys">${status.keys.map((k) => html`
      <li class="keys__row">
        <div class="set__row"><span class="chip-ic">${icon("key")}</span><span class="set__txt"><b>${k.name}</b><small>${k.purpose}</small></span>
          ${k.set ? html`<span class="pill pill--green">${t("stored")}</span>` : ""}</div>
        ${!k.set && made[k.name] ? html`<div class="keys__val"><code>${made[k.name]}</code><button class="btn btn--line btn--sm" data-copy="${k.name}">${t("Copy")}</button></div>` : ""}
      </li>`)}</ul>
    ${ready ? html`
    <label class="keys__sure"><input type="checkbox" id="keys-sure"> <span>${t("I have saved every key in my password manager.")}</span></label>
    <div class="keys__go"><button class="btn btn--ink" id="keys-store" disabled>${icon("lock")}${t("Store the keys and lock this page")}</button></div>`
    : html`<div class="keys__go"><button class="btn btn--ink" id="keys-make">${icon("key")}${t("Make my keys")}</button></div>`}
    <p class="muted small" id="keys-msg" role="status"></p>
  </section>`;
}

export function setupKeys(): Raw {
  return html`${head(t("Made once, in your browser. Your AI never sees them."))}<div class="set keys__page" id="keys-body">${body()}</div>`;
}

function paint(): void {
  const el = $("#keys-body");
  if (!el) return;
  mount(el, body());
  bind();
}

function say(text: string): void {
  const el = $("#keys-msg");
  if (el) el.textContent = text;
}

function bind(): void {
  $("#keys-make")?.addEventListener("click", () => {
    for (const k of status?.keys ?? []) if (!k.set) made[k.name] = k.kind === "passphrase" ? newPassphrase() : newKey();
    paint();
  });
  for (const b of $$<HTMLButtonElement>("[data-copy]")) {
    b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(made[b.dataset.copy!] ?? ""); b.textContent = t("Copied"); }
      catch { say(t("Copying is blocked here. Select the key and copy it by hand.")); }
    });
  }
  const sure = $<HTMLInputElement>("#keys-sure"), store = $<HTMLButtonElement>("#keys-store");
  sure?.addEventListener("change", () => { if (store) store.disabled = !sure.checked; });
  store?.addEventListener("click", async () => {
    store.disabled = true;
    say(t("Storing…"));
    try {
      status = await call<Status>("POST", "/setup/keys", { keys: made });
      made = {};
      paint();
    } catch (e) {
      store.disabled = false;
      say(t("That did not work: {why}", { why: (e as Error).message }));
    }
  });
}

export async function setupKeysInit(): Promise<void> {
  made = {};
  status = null;
  try { status = await call<Status>("GET", "/setup/keys"); }
  catch { status = { state: "closed", keys: [] }; }
  paint();
}

/** Leaving the page forgets the keys that were shown. */
export function setupKeysLeave(): void {
  made = {};
  status = null;
}
