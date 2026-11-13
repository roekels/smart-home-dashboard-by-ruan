// /dashboard/wall-tablets (admins): pair a tablet with the code it shows, see when each was last on, revoke one.
import { html, mount, $, type Raw } from "../html.ts";
import { call, ago, who } from "../api.ts";
import { icon } from "../icons.ts";
import { t, loc } from "../i18n.ts";

interface Tablet { id: string; name: string; created: number; approved_by: string; expires: number; last_seen: number | null; revoked: number | null }
interface Reply { devices: Tablet[]; days: number; host: string | null }

export function wallTabletsPage(): Raw {
  return html`
  <section class="page-head"><div><h1 class="h1">${t("Wall tablets")}</h1>
    <p class="muted">${t("A tablet on the wall is not a person: it gets a key of its own and only ever shows the wall page.")}</p>
    <p class="banner" id="wt-error" role="alert"></p></div></section>
  <div class="setup">
    <section class="card pane" aria-label="${t("Pair a tablet")}">
      <div class="pane__head"><h2 class="h2">${icon("plus")}${t("Pair a tablet")}</h2></div>
      <p class="muted small" id="wt-how"></p>
      <form class="fields" id="wt-form">
        <label class="field"><span>${t("Code on the tablet")}</span><input class="input input--code" name="code" placeholder="ABCD-EF23" maxlength="9" autocomplete="off" autocapitalize="characters" required></label>
        <label class="field"><span>${t("Where it hangs")}</span><input class="input" name="name" placeholder="${t("Hallway")}" maxlength="40" autocomplete="off"></label>
        <button class="btn btn--ink">${icon("check")}${t("Pair")}</button>
      </form>
      <p class="muted small" id="wt-done" role="status"></p>
    </section>
    <section class="card pane" aria-label="${t("Paired tablets")}">
      <div class="pane__head"><h2 class="h2">${icon("tablet")}${t("Paired tablets")}</h2></div>
      <div class="list" id="wt-list"><p class="muted small list__empty">${t("Loading …")}</p></div>
    </section>
  </div>`;
}

const day = (ms: number) => new Date(ms).toLocaleDateString(loc(), { day: "numeric", month: "short", year: "numeric" });
const person = (id: string) => who.people.find((p) => p.id === id)?.name ?? id;

async function load(): Promise<void> {
  const box = $("#wt-list");
  if (!box) return;
  try {
    const r = await call<Reply>("GET", "/kiosk/devices");
    $("#wt-how")!.textContent = r.host
      ? t("On the tablet, open https://{host}/pair. It shows a code for 10 minutes; type it here. A key lasts {days} days.", { host: r.host, days: r.days })
      : t("The tablets' own address is not set up yet (KIOSK_HOST). Ask your AI to finish the kiosk setup.");
    mount(box, r.devices.length ? html`${r.devices.map((d) => html`<div class="list__row"><span class="chip-ic">${icon("tablet")}</span>
      <span class="list__txt"><b>${d.name}</b><small>${d.revoked ? t("revoked {date}", { date: day(d.revoked) })
        : t("paired {date} by {who} · last on {seen} · key until {until}", { date: day(d.created), who: person(d.approved_by), seen: ago(d.last_seen), until: day(d.expires) })}</small></span>
      ${d.revoked ? html`<span class="pill pill--slate">${t("revoked")}</span>` : html`<button class="btn btn--danger btn--sm" data-revoke="${d.id}" data-name="${d.name}">${t("Revoke")}</button>`}</div>`)}`
      : html`<p class="muted small list__empty">${t("No tablet is paired yet.")}</p>`);
  } catch (e) { $("#wt-error")!.textContent = (e as Error).message; }
}

export function wallTabletsInit(): void {
  const say = (m: string) => { const e = $("#wt-error"); if (e) e.textContent = m; };
  $("#wt-form")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement, d = new FormData(f);
    try {
      const r = await call<{ name: string }>("POST", "/kiosk/approve", { code: d.get("code"), name: d.get("name") });
      f.reset(); say("");
      $("#wt-done")!.textContent = t("{name} is paired. The tablet opens the wall page within a few seconds.", { name: r.name });
      window.setTimeout(load, 4000);
    } catch (err) { say((err as Error).message); }
  });
  $("#wt-list")!.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-revoke]");
    if (!b) return;
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = t("Revoke {name}? Tap again", { name: b.dataset.name! }); window.setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = t("Revoke"); } }, 4000); return; }
    b.disabled = true;
    try { await call("POST", `/kiosk/devices/${b.dataset.revoke}/revoke`, {}); say(""); await load(); } catch (err) { say((err as Error).message); b.disabled = false; }
  });
  void load();
}
