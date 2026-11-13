// The Brain itself: a tree of notes with links, records, history and a sealed sensitive tier.
// Every method checks the caller's scopes; nothing is ever deleted (edits keep the old version, archive locks).
// Sensitive notes: body and records are sealed, search indexes only their title and path, and a person reaches
// them only under their own root and the shared one (Principal.sensitiveRoots).
import { newId } from "../../../packages/core/src/ids.ts";
import { type BrainCtx, type Principal, type Scope, can, need, Refused, nowIso } from "./core.ts";
import {
  type Sensitivity, wikilinks, relatedTargets, assertNoSecrets, normalizeFrontmatter,
  splitPath, forcedSensitivity, appendToSection, retarget, retargetRelated, retitleHeading,
} from "./markdown.ts";

export interface NodeRow {
  id: string; parent_id: string | null; root: string; title: string; path: string;
  kind: "page" | "entry" | "hub"; type: string; status: string; sensitivity: Sensitivity;
  tags: string; frontmatter: string; body: string; encrypted: number;
  version: number; created: string; updated: string;
  locked_at: string | null; archived_at: string | null; deleted_at: string | null;
}

export const LINK_KINDS = ["link", "followed", "caused_by", "about"] as const;
const MAX_SENSITIVE_SCAN = 2000;

const isBracketed = (title: string) => /^\s*\(.*\)\s*$/.test(title);

const today = (c: BrainCtx) => c.today();
const sqlText = (s: string) => `'${s.replace(/'/g, "''")}'`;

export class Brain {
  private db: D1Database;
  readonly p: Principal;
  private c: BrainCtx;
  constructor(c: BrainCtx) {
    this.c = c;
    this.db = c.db;
    this.p = c.p;
  }

  private seal(plain: string) { return this.c.seal.seal(plain); }
  private unseal(sealed: string) { return this.c.seal.unseal<string>(sealed); }

  // ---------- visibility ----------

  /** May this caller use the sensitive tier of a root, with the given scope? */
  private sensitiveIn(root: string, scope: Scope) {
    return can(this.p, scope) && (this.p.sensitiveRoots === null || this.p.sensitiveRoots.includes(root));
  }
  private canSee(n: { sensitivity: string; root: string; deleted_at?: string | null }) {
    return !n.deleted_at && (n.sensitivity !== "sensitive" || this.sensitiveIn(n.root, "brain.read.sensitive"));
  }
  /** SQL that leaves out the sensitive notes this caller may not read. */
  private hideSensitiveSql(alias = "n") {
    if (!can(this.p, "brain.read.sensitive")) return ` AND ${alias}.sensitivity != 'sensitive'`;
    if (this.p.sensitiveRoots === null) return "";
    if (!this.p.sensitiveRoots.length) return ` AND ${alias}.sensitivity != 'sensitive'`;
    return ` AND (${alias}.sensitivity != 'sensitive' OR ${alias}.root IN (${this.p.sensitiveRoots.map(sqlText).join(", ")}))`;
  }
  private needSensitiveWrite(root: string) {
    if (!this.sensitiveIn(root, "brain.write.sensitive")) {
      need(this.p, "brain.write.sensitive");
      throw new Refused(`Not allowed: sensitive notes under "${root}" belong to someone else.`);
    }
  }
  private assertWritable(n: NodeRow) {
    if (n.deleted_at) throw new Refused(`"${n.path}" was deleted`);
    if (n.sensitivity === "sensitive") this.needSensitiveWrite(n.root);
    if (n.locked_at) throw new Refused(`"${n.path}" is locked (archived ${n.archived_at ?? n.locked_at}). Unlock it first.`);
  }

  /** Find a node by path, id or unique title. Doesn't check read scope. */
  async find(ref: string): Promise<NodeRow | null> {
    const r = ref.trim().replace(/^\[\[|\]\]$/g, "").replace(/\.md$/, "");
    let n = await this.db.prepare("SELECT * FROM nodes WHERE path = ? AND deleted_at IS NULL").bind(r).first<NodeRow>();
    if (n) return n;
    n = await this.db.prepare("SELECT * FROM nodes WHERE id = ? AND deleted_at IS NULL").bind(r).first<NodeRow>();
    if (n) return n;
    const { results } = await this.db.prepare("SELECT * FROM nodes WHERE title = ? COLLATE NOCASE AND deleted_at IS NULL LIMIT 6").bind(r).all<NodeRow>();
    if (results.length === 1) return results[0];
    if (results.length > 1) throw new Refused(`"${ref}" matches several notes; use the path: ${results.map((x) => x.path).join(" | ")}`);
    const { results: al } = await this.db.prepare(
      "SELECT n.* FROM nodes n, json_each(n.frontmatter, '$.aliases') a WHERE n.deleted_at IS NULL AND lower(a.value) = lower(?) LIMIT 6",
    ).bind(r).all<NodeRow>();
    if (al.length === 1) return al[0];
    if (al.length > 1) throw new Refused(`"${ref}" matches several notes; use the path: ${al.map((x) => x.path).join(" | ")}`);
    return null;
  }

  private async mustRead(ref: string): Promise<NodeRow> {
    need(this.p, "brain.read");
    const n = await this.find(ref);
    if (!n || !this.canSee(n)) throw new Refused(`No note "${ref}"`);
    return n;
  }
  private async mustWrite(ref: string): Promise<NodeRow> {
    const n = await this.find(ref);
    if (!n || (n.sensitivity === "sensitive" && !this.sensitiveIn(n.root, "brain.write.sensitive") && !this.sensitiveIn(n.root, "brain.read.sensitive"))) throw new Refused(`No note "${ref}"`);
    this.assertWritable(n);
    return n;
  }

  async bodyOf(n: Pick<NodeRow, "body" | "encrypted">): Promise<string> {
    return n.encrypted ? this.unseal(n.body) : n.body;
  }

  // ---------- reads ----------

  async read(ref: string, opts: { records?: boolean } = {}) {
    const n = await this.mustRead(ref);
    const hide = this.hideSensitiveSql("c");
    const [children, out, back, recs, cal] = await this.db.batch([
      this.db.prepare(`SELECT c.title, c.path, c.kind, c.type, c.archived_at FROM nodes c WHERE c.parent_id = ? AND c.deleted_at IS NULL${hide} ORDER BY c.kind = 'hub' DESC, c.title COLLATE NOCASE`).bind(n.id),
      this.db.prepare(`SELECT e.target, e.kind, c.path FROM edges e LEFT JOIN nodes c ON c.id = e.dst AND c.deleted_at IS NULL${hide} WHERE e.src = ?`).bind(n.id),
      this.db.prepare(`SELECT DISTINCT c.path, e.kind FROM edges e JOIN nodes c ON c.id = e.src WHERE e.dst = ? AND c.deleted_at IS NULL${hide} ORDER BY c.path`).bind(n.id),
      this.db.prepare("SELECT id, date, kind, fields, encrypted FROM records WHERE node_id = ? AND deleted_at IS NULL ORDER BY date, created").bind(n.id),
      this.db.prepare("SELECT calendar, event_uid, status, title, start FROM calendar_refs WHERE node_id = ? ORDER BY start").bind(n.id),
    ]);
    const records = opts.records === false ? undefined : await Promise.all(
      (recs.results as any[]).map(async (r) => ({ id: r.id, date: r.date, kind: r.kind, fields: JSON.parse(r.encrypted ? await this.unseal(r.fields) : r.fields) })),
    );
    return {
      path: n.path, id: n.id, title: n.title, kind: n.kind, version: n.version,
      sensitivity: n.sensitivity, locked: !!n.locked_at, archived: n.archived_at,
      frontmatter: JSON.parse(n.frontmatter),
      body: await this.bodyOf(n),
      children: children.results,
      links: (out.results as any[]).map((e) => ({ target: e.target, kind: e.kind, path: e.path ?? null })),
      backlinks: back.results,
      records, calendar: cal.results,
    };
  }

  async search(q: { query: string; root?: string; under?: string; type?: string; status?: string; include_archived?: boolean; limit?: number }) {
    need(this.p, "brain.read");
    const limit = Math.min(Math.max(q.limit ?? 15, 1), 50);
    const terms = q.query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’._-]*/gu) ?? [];
    if (!terms.length) throw new Refused("Empty query");
    const fts = terms.map((t, i) => `"${t.replace(/"/g, '""')}"${i === terms.length - 1 ? "*" : ""}`).join(" ");
    const where: string[] = ["n.deleted_at IS NULL"];
    const args: unknown[] = [fts];
    const root = q.root ? this.c.roots.find((r) => r.toLowerCase() === q.root!.toLowerCase()) ?? q.root : undefined;
    if (root) { where.push("n.root = ?"); args.push(root); }
    if (q.under) { where.push("(n.path = ? OR n.path LIKE ? ESCAPE '\\')"); args.push(q.under, likePrefix(q.under)); }
    if (q.type) { where.push("n.type = ?"); args.push(q.type); }
    if (q.status) { where.push("n.status = ?"); args.push(q.status); }
    if (q.include_archived === false) where.push("n.archived_at IS NULL");
    const sql = `SELECT n.path, n.title, n.type, n.status, n.kind, n.sensitivity, n.updated, n.archived_at,
        snippet(nodes_fts, 3, '«', '»', '…', 14) AS snippet, bm25(nodes_fts, 0, 10, 3, 1) AS rank
      FROM nodes_fts JOIN nodes n ON n.id = nodes_fts.node_id
      WHERE nodes_fts MATCH ? AND ${where.join(" AND ")}${this.hideSensitiveSql()}
      ORDER BY rank LIMIT ${limit}`;
    const { results } = await this.db.prepare(sql).bind(...args).all<any>();
    const hits = results.map(({ rank, ...r }) => r);

    // Sensitive bodies aren't in the index: decrypt and scan when allowed.
    if (can(this.p, "brain.read.sensitive") && this.c.seal.ready) {
      const sw: string[] = ["deleted_at IS NULL", "encrypted = 1"];
      const sa: unknown[] = [];
      if (root) { sw.push("root = ?"); sa.push(root); }
      if (this.p.sensitiveRoots !== null) sw.push(this.p.sensitiveRoots.length ? `root IN (${this.p.sensitiveRoots.map(sqlText).join(", ")})` : "0");
      if (q.under) { sw.push("(path = ? OR path LIKE ? ESCAPE '\\')"); sa.push(q.under, likePrefix(q.under)); }
      if (q.include_archived === false) sw.push("archived_at IS NULL");
      const { results: enc } = await this.db.prepare(`SELECT * FROM nodes WHERE ${sw.join(" AND ")} LIMIT ${MAX_SENSITIVE_SCAN}`).bind(...sa).all<NodeRow>();
      const seen = new Set(hits.map((h) => h.path));
      for (const n of enc) {
        if (seen.has(n.path)) continue;
        const body = (await this.bodyOf(n)).toLowerCase();
        const hay = `${n.title.toLowerCase()} ${n.path.toLowerCase()} ${body}`;
        if (terms.every((t) => hay.includes(t))) {
          const i = body.indexOf(terms[0]!);
          hits.push({ path: n.path, title: n.title, type: n.type, status: n.status, kind: n.kind, sensitivity: n.sensitivity, updated: n.updated, archived_at: n.archived_at,
            snippet: i >= 0 ? "…" + body.slice(Math.max(0, i - 60), i + 100).replace(/\s+/g, " ") + "…" : "" });
        }
      }
    }
    return hits.slice(0, limit);
  }

  async tree(path?: string, depth = 2) {
    need(this.p, "brain.read");
    depth = Math.min(Math.max(depth, 1), 6);
    const starts = path ? [await this.mustRead(path)] : (await this.roots());
    const out: string[] = [];
    for (const s of starts) {
      const base = s.path.split("/").length;
      const like = likePrefix(s.path);
      const { results } = await this.db.prepare(
        `SELECT n.path, n.kind, n.type, n.archived_at, n.locked_at, (SELECT COUNT(*) FROM nodes c WHERE c.parent_id = n.id AND c.deleted_at IS NULL) AS kids
         FROM nodes n WHERE (n.path = ? OR n.path LIKE ? ESCAPE '\\') AND n.deleted_at IS NULL${this.hideSensitiveSql()} ORDER BY n.path COLLATE NOCASE`,
      ).bind(s.path, like).all<any>();
      for (const r of results) {
        const lvl = r.path.split("/").length - base;
        if (lvl > depth) continue;
        const flags = [r.kind === "hub" ? "hub" : r.type, r.archived_at ? "archived" : "", lvl === depth && r.kids ? `+${r.kids}` : ""].filter(Boolean).join(", ");
        out.push(`${"  ".repeat(lvl)}- ${r.path.split("/").pop()}${flags ? ` (${flags})` : ""}`);
      }
    }
    return out.join("\n");
  }

  async recent(since: string, limit = 50) {
    need(this.p, "brain.read");
    const { results } = await this.db.prepare("SELECT date, ts, job, summary, paths, actor, sensitive FROM log WHERE date >= ? ORDER BY id DESC LIMIT ?").bind(since, 600).all<any>();
    return this.visibleLog(results).slice(0, Math.min(Math.max(limit, 1), 200));
  }

  async logRead(q: { since?: string; until?: string; job?: string; limit?: number }) {
    need(this.p, "brain.read");
    const w = ["1=1"]; const a: unknown[] = [];
    if (q.since) { w.push("date >= ?"); a.push(q.since); }
    if (q.until) { w.push("date <= ?"); a.push(q.until); }
    if (q.job) { w.push("job = ?"); a.push(q.job); }
    const { results } = await this.db.prepare(`SELECT date, ts, job, summary, paths, actor, sensitive FROM log WHERE ${w.join(" AND ")} ORDER BY id DESC LIMIT ?`).bind(...a, 900).all<any>();
    return this.visibleLog(results).slice(0, Math.min(Math.max(q.limit ?? 50, 1), 300));
  }

  /** Log rows this caller may see. A sensitive row shows only when every note it names is in a root they may read. */
  visibleLog(rows: any[]) {
    const out = [];
    for (const { sensitive, ...r } of rows) {
      const paths = JSON.parse(r.paths) as string[];
      if (sensitive && !(can(this.p, "brain.read.sensitive") && (this.p.sensitiveRoots === null || paths.every((p) => this.p.sensitiveRoots!.includes(p.split("/")[0]))))) continue;
      out.push({ ...r, paths });
    }
    return out;
  }

  /** The top of the tree, in the household's order. Missing roots are made on the way (they are plain hubs). */
  async roots(): Promise<NodeRow[]> {
    const read = async () => (await this.db.prepare("SELECT * FROM nodes WHERE parent_id IS NULL AND deleted_at IS NULL").all<NodeRow>()).results;
    let rows = await read();
    const missing = this.c.roots.filter((r) => !rows.some((x) => x.path === r));
    if (missing.length) {
      const day = today(this.c);
      await this.db.batch(missing.flatMap((r) => {
        const id = newId("bn_");
        const fm = JSON.stringify({ type: "hub", status: "active", created: day, updated: day, tags: [], related: [], sensitivity: "normal" });
        return [
          this.db.prepare("INSERT OR IGNORE INTO nodes (id, parent_id, root, title, path, kind, type, status, sensitivity, tags, frontmatter, body, encrypted, version, created, updated) VALUES (?, NULL, ?, ?, ?, 'hub', 'hub', 'active', 'normal', '[]', ?, '', 0, 1, ?, ?)").bind(id, r, r, r, fm, day, day),
          this.db.prepare("INSERT INTO nodes_fts (node_id, title, path, body) SELECT id, title, path, '' FROM nodes WHERE path = ? AND id = ?").bind(r, id),
        ];
      }));
      rows = await read();
    }
    return this.c.roots.flatMap((r) => rows.filter((x) => x.path === r));
  }

  async history(ref: string, version?: number) {
    const n = await this.mustRead(ref);
    if (version != null) {
      if (version === n.version) return { version, current: true, frontmatter: JSON.parse(n.frontmatter), body: await this.bodyOf(n) };
      const r = await this.db.prepare("SELECT * FROM revisions WHERE node_id = ? AND version = ?").bind(n.id, version).first<any>();
      if (!r) throw new Refused(`No version ${version} of "${n.path}"`);
      return { version, path: r.path, changed_at: r.changed_at, changed_by: r.changed_by, summary: r.summary, frontmatter: JSON.parse(r.frontmatter), body: r.encrypted ? await this.unseal(r.body) : r.body };
    }
    const { results } = await this.db.prepare("SELECT version, changed_at, changed_by, summary FROM revisions WHERE node_id = ? ORDER BY version DESC LIMIT 100").bind(n.id).all();
    return { path: n.path, current_version: n.version, updated: n.updated, earlier: results };
  }

  async lint() {
    need(this.p, "brain.read");
    const hide = this.hideSensitiveSql();
    const [unresolved, emptyHubs, missing, big] = await this.db.batch([
      this.db.prepare(`SELECT n.path, e.target FROM edges e JOIN nodes n ON n.id = e.src WHERE e.dst IS NULL AND n.deleted_at IS NULL${hide} ORDER BY n.path LIMIT 200`),
      this.db.prepare(`SELECT n.path FROM nodes n WHERE n.kind = 'hub' AND n.deleted_at IS NULL AND n.body = '' AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = n.id AND c.deleted_at IS NULL)${hide}`),
      this.db.prepare(`SELECT n.path FROM nodes n WHERE n.deleted_at IS NULL AND n.kind != 'hub' AND (json_extract(n.frontmatter, '$.type') IS NULL OR json_extract(n.frontmatter, '$.created') IS NULL OR json_extract(n.frontmatter, '$.updated') IS NULL OR json_extract(n.frontmatter, '$.status') IS NULL)${hide}`),
      this.db.prepare(`SELECT n.path, length(n.body) AS bytes FROM nodes n WHERE n.deleted_at IS NULL AND n.encrypted = 0 AND length(n.body) > 30720${hide} ORDER BY bytes DESC`),
    ]);
    return { unresolved_links: unresolved.results, empty_hubs: emptyHubs.results, missing_frontmatter: missing.results, oversized_pages: big.results };
  }

  // ---------- writes ----------

  /** Writes made by this Brain since the last drain, for the dashboard's live pulses. */
  private changes: { op: string; paths: string[] }[] = [];
  drainChanges() {
    const c = this.changes;
    this.changes = [];
    return c;
  }

  private logStmt(op: string, summary: string, paths: string[], sensitive: boolean) {
    this.changes.push({ op, paths });
    return this.db.prepare("INSERT INTO log (date, ts, job, summary, paths, actor, sensitive) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(today(this.c), nowIso(), op, summary, JSON.stringify(paths), this.p.actor, sensitive ? 1 : 0);
  }
  private ftsStmts(id: string, title: string, path: string, body: string, sensitive: boolean) {
    return [
      this.db.prepare("DELETE FROM nodes_fts WHERE node_id = ?").bind(id),
      this.db.prepare("INSERT INTO nodes_fts (node_id, title, path, body) VALUES (?, ?, ?, ?)").bind(id, title, path, sensitive ? "" : body),
    ];
  }
  /** Recompute the automatic edges (wikilinks and `related`) of one node. */
  private async edgeStmts(id: string, body: string, fm: Record<string, unknown>) {
    const want = new Map<string, string>();
    for (const t of relatedTargets(fm)) want.set(`related\u0000${t}`, t);
    for (const t of wikilinks(body)) if (!want.has(`related\u0000${t}`)) want.set(`link\u0000${t}`, t);
    const targets = [...new Set(want.values())];
    const ids = new Map<string, string>();
    for (let i = 0; i < targets.length; i += 50) {
      const chunk = targets.slice(i, i + 50);
      const ph = chunk.map(() => "?").join(",");
      const { results } = await this.db.prepare(
        `SELECT id, title, path FROM nodes WHERE deleted_at IS NULL AND (lower(title) IN (${ph}) OR path IN (${ph})) ORDER BY kind = 'hub'`,
      ).bind(...chunk.map((t) => t.toLowerCase()), ...chunk).all<any>();
      for (const r of results) {
        if (!ids.has(r.title.toLowerCase())) ids.set(r.title.toLowerCase(), r.id);
        ids.set(r.path, r.id);
      }
      // Old names kept in frontmatter `aliases` (a renamed note keeps its old title there).
      const { results: al } = await this.db.prepare(
        `SELECT n.id, lower(a.value) AS alias FROM nodes n, json_each(n.frontmatter, '$.aliases') a WHERE n.deleted_at IS NULL AND lower(a.value) IN (${ph})`,
      ).bind(...chunk.map((t) => t.toLowerCase())).all<any>();
      for (const r of al) if (!ids.has(r.alias)) ids.set(r.alias, r.id);
    }
    const stmts = [this.db.prepare(`DELETE FROM edges WHERE src = ? AND kind IN ('link', 'related')`).bind(id)];
    for (const [key, t] of want) {
      const kind = key.split("\u0000")[0];
      const dst = ids.get(t) ?? ids.get(t.toLowerCase()) ?? null;
      if (dst === id) continue;
      stmts.push(this.db.prepare("INSERT OR REPLACE INTO edges (src, target, dst, kind, created, created_by) VALUES (?, ?, ?, ?, ?, ?)").bind(id, t, dst, kind, nowIso(), this.p.actor));
    }
    return stmts;
  }

  async create(a: { path: string; body?: string; frontmatter?: Record<string, unknown>; kind?: "page" | "entry" | "hub"; summary: string }) {
    need(this.p, "brain.create");
    const parts = splitPath(a.path, this.c.roots);
    const path = parts.join("/");
    const title = parts[parts.length - 1];
    const body = a.body ?? "";
    assertNoSecrets(body + "\n" + JSON.stringify(a.frontmatter ?? {}));
    if (parts.length < 2) throw new Refused(`"${path}" is the top of a tree. Notes go below it, e.g. "${path}/Projects".`);
    await this.roots();
    if (await this.db.prepare("SELECT 1 FROM nodes WHERE path = ?").bind(path).first()) throw new Refused(`"${path}" already exists. Read it and edit instead.`);
    const parent = await this.db.prepare("SELECT * FROM nodes WHERE path = ? AND deleted_at IS NULL").bind(parts.slice(0, -1).join("/")).first<NodeRow>();
    if (!parent) throw new Refused(`Parent "${parts.slice(0, -1).join("/")}" doesn't exist. Create it first (kind: "hub") or pick an existing branch with tree.`);
    if (parent.locked_at) throw new Refused(`"${parent.path}" is locked. Unlock it first.`);
    const forced = forcedSensitivity(parts) ?? (parent.sensitivity === "sensitive" ? "sensitive" : null);
    const norm = normalizeFrontmatter(a.frontmatter ?? {}, { type: a.kind === "hub" ? "hub" : undefined, sensitivity: forced ?? undefined }, today(this.c));
    if (forced) norm.fm.sensitivity = norm.sensitivity = forced;
    const sensitive = norm.sensitivity === "sensitive";
    if (sensitive) this.needSensitiveWrite(parts[0]);
    norm.fm.updated = today(this.c);
    const id = newId("bn_");
    const stored = sensitive ? await this.seal(body) : body;
    const stmts = [
      this.db.prepare(`INSERT INTO nodes (id, parent_id, root, title, path, kind, type, status, sensitivity, tags, frontmatter, body, encrypted, version, created, updated)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .bind(id, parent.id, parts[0], title, path, a.kind ?? "page", norm.type, norm.status, norm.sensitivity, JSON.stringify(norm.tags), JSON.stringify(norm.fm), stored, sensitive ? 1 : 0, norm.fm.created, norm.fm.updated),
      ...this.ftsStmts(id, title, path, body, sensitive),
      ...(await this.edgeStmts(id, body, norm.fm)),
      // Links elsewhere that were waiting for this title now resolve.
      this.db.prepare("UPDATE edges SET dst = ? WHERE dst IS NULL AND (lower(target) = lower(?) OR target = ?)").bind(id, title, path),
      this.logStmt("create", a.summary, [path], sensitive),
    ];
    await this.db.batch(stmts);
    return { created: path, id, version: 1, sensitivity: norm.sensitivity };
  }

  async edit(a: {
    ref: string; base_version: number; summary: string;
    replace?: { old: string; new: string }[]; rewrite?: string; append?: string; under_heading?: string;
    set?: Record<string, unknown>;
  }) {
    need(this.p, "brain.update");
    const n = await this.mustWrite(a.ref);
    if (a.base_version !== n.version) throw new Refused(`"${n.path}" is at version ${n.version}, not ${a.base_version}. Read it again and redo the change.`);
    const old = await this.bodyOf(n);
    let body = old;
    if (a.rewrite != null) body = a.rewrite;
    for (const r of a.replace ?? []) {
      const count = body.split(r.old).length - 1;
      if (count !== 1) throw new Refused(`replace: "${r.old.slice(0, 60)}" occurs ${count} times; it must occur exactly once.`);
      body = body.replace(r.old, () => r.new);
    }
    if (a.append) body = appendToSection(body, a.append, a.under_heading);

    let fm = JSON.parse(n.frontmatter) as Record<string, unknown>;
    for (const [k, v] of Object.entries(a.set ?? {})) {
      if (["updated", "archived"].includes(k)) continue;
      if (v === null) delete fm[k]; else fm[k] = v;
    }
    const forced = forcedSensitivity(n.path.split("/"));
    const norm = normalizeFrontmatter(fm, { sensitivity: n.sensitivity }, today(this.c));
    if (forced) norm.fm.sensitivity = norm.sensitivity = forced;
    if ((n.sensitivity === "sensitive") !== (norm.sensitivity === "sensitive")) this.needSensitiveWrite(n.root);
    fm = norm.fm;
    fm.updated = today(this.c);

    const oldLines = new Set(old.split("\n"));
    const added = body.split("\n").filter((l) => !oldLines.has(l)).join("\n");
    assertNoSecrets(added + "\n" + JSON.stringify(a.set ?? {}));
    if (body === old && JSON.stringify(fm) === n.frontmatter) return { unchanged: n.path, version: n.version };

    const sensitive = norm.sensitivity === "sensitive";
    const stored = sensitive ? await this.seal(body) : body;
    const res = await this.db.batch([
      this.revisionStmt(n, a.summary),
      this.db.prepare(`UPDATE nodes SET body = ?, encrypted = ?, frontmatter = ?, type = ?, status = ?, sensitivity = ?, tags = ?, updated = ?, version = version + 1
                       WHERE id = ? AND version = ?`)
        .bind(stored, sensitive ? 1 : 0, JSON.stringify(fm), norm.type, norm.status, norm.sensitivity, JSON.stringify(norm.tags), fm.updated, n.id, n.version),
      ...this.ftsStmts(n.id, n.title, n.path, body, sensitive),
      ...(await this.edgeStmts(n.id, body, fm)),
      this.logStmt("edit", a.summary, [n.path], sensitive),
    ]);
    if (!res[1].meta.changes) throw new Refused(`"${n.path}" changed while saving. Read it again.`);
    return { edited: n.path, version: n.version + 1 };
  }

  private revisionStmt(n: NodeRow, summary: string) {
    return this.db.prepare(`INSERT INTO revisions (node_id, version, title, path, frontmatter, body, encrypted, changed_at, changed_by, summary)
                            SELECT id, version, title, path, frontmatter, body, encrypted, ?, ?, ? FROM nodes WHERE id = ? AND version = ?`)
      .bind(nowIso(), this.p.actor, summary, n.id, n.version);
  }

  async move(a: { ref: string; new_parent?: string; new_title?: string; summary: string }) {
    need(this.p, "brain.update");
    const n = await this.mustWrite(a.ref);
    if (!n.parent_id) throw new Refused("Roots can't be moved");
    const parentPath = a.new_parent ?? n.path.split("/").slice(0, -1).join("/");
    const title = (a.new_title ?? n.title).trim();
    if (!title || title.includes("/")) throw new Refused("Titles can't be empty or contain /");
    const newPath = `${parentPath}/${title}`;
    if (newPath === n.path) return { unchanged: n.path };
    if (newPath.startsWith(n.path + "/")) throw new Refused("Can't move a note under itself");
    const parts = splitPath(newPath, this.c.roots);
    const parent = await this.db.prepare("SELECT * FROM nodes WHERE path = ? AND deleted_at IS NULL").bind(parentPath).first<NodeRow>();
    if (!parent) throw new Refused(`Parent "${parentPath}" doesn't exist`);
    if (parent.locked_at) throw new Refused(`"${parent.path}" is locked. Unlock it first.`);
    if (await this.db.prepare("SELECT 1 FROM nodes WHERE path = ?").bind(newPath).first()) throw new Refused(`"${newPath}" already exists`);
    const intoSensitive = !!forcedSensitivity(parts) || parent.sensitivity === "sensitive";
    if (intoSensitive) this.needSensitiveWrite(parts[0]);
    const renamed = title !== n.title;

    const { results: subtree } = await this.db.prepare("SELECT * FROM nodes WHERE (path = ? OR path LIKE ? ESCAPE '\\') AND deleted_at IS NULL").bind(n.path, likePrefix(n.path)).all<NodeRow>();
    const newPathOf = (s: NodeRow) => newPath + s.path.slice(n.path.length);
    const inSubtree = new Map(subtree.map((x) => [x.id, x]));

    // ---- Ripple: links elsewhere that name a moved note by its old title or old path get the new one. ----
    // A new title that another note already has would make [[title]] ambiguous, so then the link uses the path.
    const titleTaken = renamed && !!(await this.db.prepare("SELECT 1 FROM nodes WHERE title = ? COLLATE NOCASE AND id != ? AND deleted_at IS NULL").bind(title, n.id).first());
    const ids = subtree.map((x) => x.id);
    const incoming: { src: string; dst: string; target: string; kind: string }[] = [];
    for (let i = 0; i < ids.length; i += 80) {
      const chunk = ids.slice(i, i + 80);
      const { results } = await this.db.prepare(`SELECT src, dst, target, kind FROM edges WHERE kind IN ('link', 'related') AND dst IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<any>();
      incoming.push(...results);
    }
    const perSrc = new Map<string, Map<string, { to: string; alias?: string }>>();
    const edgeFix: { src: string; dst: string; from: string; to: string }[] = [];
    for (const e of incoming) {
      const d = inSubtree.get(e.dst)!;
      const t = e.target.trim().toLowerCase();
      let to: { to: string; alias?: string } | null = null;
      if (t === d.path.toLowerCase()) to = { to: newPathOf(d) };
      else if (d.id === n.id && renamed && t === n.title.toLowerCase()) to = titleTaken ? { to: newPath, alias: title } : { to: title };
      if (!to) continue; // linked by an alias or a title that didn't change: still right
      (perSrc.get(e.src) ?? perSrc.set(e.src, new Map()).get(e.src)!).set(t, to);
      edgeFix.push({ src: e.src, dst: e.dst, from: e.target, to: to.to });
    }

    const stmts: D1PreparedStatement[] = [this.revisionStmt(n, a.summary)];
    const relinked: string[] = [];
    const skipped: string[] = [];
    // Plain-text bodies and frontmatter after the ripple, for notes it changed.
    const rippled = new Map<string, { body: string; fm: Record<string, unknown> }>();
    if (perSrc.size) {
      const srcIds = [...perSrc.keys()];
      const rows: NodeRow[] = [];
      for (let i = 0; i < srcIds.length; i += 80) {
        const chunk = srcIds.slice(i, i + 80);
        const { results } = await this.db.prepare(`SELECT * FROM nodes WHERE deleted_at IS NULL AND id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<NodeRow>();
        rows.push(...results);
      }
      for (const src of rows) {
        // Locked notes stay as they are (their links still resolve by id); sensitive ones need the sensitive write scope.
        if (src.locked_at || (src.sensitivity === "sensitive" && !this.sensitiveIn(src.root, "brain.write.sensitive"))) { skipped.push(src.path); continue; }
        const map = perSrc.get(src.id)!;
        const body0 = await this.bodyOf(src);
        const body = retarget(body0, map);
        const fm = JSON.parse(src.frontmatter);
        const fmChanged = retargetRelated(fm, map);
        if (body === body0 && !fmChanged) continue;
        rippled.set(src.id, { body, fm });
        relinked.push(src.path);
      }
    }

    for (const s of subtree) {
      const p2 = newPathOf(s);
      const isN = s.id === n.id;
      const t2 = isN ? title : s.title;
      const rip = rippled.get(s.id);
      let fmObj = rip?.fm ?? JSON.parse(s.frontmatter);
      let plain: string | null = rip?.body ?? null;
      if (isN && renamed) {
        // Keep the old title as an alias, so search and old references still find the note.
        const aliases = Array.isArray(fmObj.aliases) ? fmObj.aliases : [];
        if (!aliases.some((x: unknown) => String(x).toLowerCase() === n.title.toLowerCase())) fmObj.aliases = [...aliases, n.title];
        // A first heading that repeats the old title follows the rename.
        plain ??= await this.bodyOf(s);
        plain = retitleHeading(plain, n.title, title);
        fmObj.updated = today(this.c);
      }
      let sens = s.sensitivity;
      let encrypted = s.encrypted;
      if (intoSensitive && !s.encrypted) { encrypted = 1; sens = "sensitive"; fmObj = { ...fmObj, sensitivity: "sensitive" }; }
      const changedHere = plain !== null || encrypted !== s.encrypted;
      const plainBody = plain ?? (changedHere ? await this.bodyOf(s) : null);
      const stored = plainBody === null ? s.body : encrypted ? await this.seal(plainBody) : plainBody;
      if (!isN && rip) stmts.push(this.revisionStmt(s, `${a.summary} (links updated)`));
      stmts.push(this.db.prepare(`UPDATE nodes SET path = ?, title = ?, root = ?, parent_id = CASE WHEN id = ? THEN ? ELSE parent_id END,
                                  body = ?, encrypted = ?, sensitivity = ?, frontmatter = ?, version = version + ?, updated = ? WHERE id = ?`)
        .bind(p2, t2, parts[0], n.id, parent.id, stored, encrypted, sens, JSON.stringify(fmObj), isN || rip ? 1 : 0, isN || rip ? today(this.c) : s.updated, s.id));
      stmts.push(...this.ftsStmts(s.id, t2, p2, encrypted ? "" : plainBody ?? (await this.bodyOf(s)), !!encrypted));
    }
    for (const src of rippled.keys()) {
      if (inSubtree.has(src)) continue;
      const row = (await this.db.prepare("SELECT * FROM nodes WHERE id = ?").bind(src).first<NodeRow>())!;
      const { body, fm } = rippled.get(src)!;
      fm.updated = today(this.c);
      const sensitive = row.sensitivity === "sensitive";
      stmts.push(this.revisionStmt(row, `${a.summary} (links updated)`));
      stmts.push(this.db.prepare("UPDATE nodes SET body = ?, frontmatter = ?, updated = ?, version = version + 1 WHERE id = ? AND version = ?")
        .bind(sensitive ? await this.seal(body) : body, JSON.stringify(fm), today(this.c), src, row.version));
      stmts.push(...this.ftsStmts(src, row.title, row.path, body, sensitive));
    }
    // Edge targets follow the text, so a later edit of the linking note resolves to the same place.
    for (const f of edgeFix) if (rippled.has(f.src)) {
      stmts.push(this.db.prepare("UPDATE OR REPLACE edges SET target = ? WHERE src = ? AND dst = ? AND target = ? AND kind IN ('link', 'related')").bind(f.to, f.src, f.dst, f.from));
    }
    stmts.push(this.logStmt("move", relinked.length ? `${a.summary} (links updated in ${relinked.length} note${relinked.length > 1 ? "s" : ""})` : a.summary,
      [n.path, newPath, ...relinked.filter((x) => !x.startsWith(n.path + "/") && x !== n.path)], n.sensitivity === "sensitive" || intoSensitive));
    await this.db.batch(stmts);
    return {
      moved: n.path, to: newPath, notes_moved: subtree.length,
      ...(relinked.length ? { links_updated_in: relinked } : {}),
      ...(skipped.length ? { not_updated: skipped, note: "These still use the old name in their text (locked, or sensitive without the scope); their links still work." } : {}),
    };
  }

  async link(a: { from: string; to: string; kind: (typeof LINK_KINDS)[number]; summary: string; remove?: boolean }) {
    need(this.p, "brain.update");
    const src = await this.mustWrite(a.from);
    const dst = await this.find(a.to);
    if (!dst || !this.canSee(dst)) throw new Refused(`No note "${a.to}"`);
    const stmts = a.remove
      ? [this.db.prepare("DELETE FROM edges WHERE src = ? AND dst = ? AND kind = ?").bind(src.id, dst.id, a.kind)]
      : [this.db.prepare("INSERT OR REPLACE INTO edges (src, target, dst, kind, created, created_by) VALUES (?, ?, ?, ?, ?, ?)").bind(src.id, dst.path, dst.id, a.kind, nowIso(), this.p.actor)];
    stmts.push(this.logStmt(a.remove ? "unlink" : "link", a.summary, [src.path, dst.path], src.sensitivity === "sensitive" || dst.sensitivity === "sensitive"));
    await this.db.batch(stmts);
    return { [a.remove ? "unlinked" : "linked"]: `${src.path} -[${a.kind}]-> ${dst.path}` };
  }

  async lock(a: { ref: string; summary: string; unlock?: boolean }) {
    need(this.p, "brain.archive");
    const n = await this.find(a.ref);
    if (!n || !this.canSee(n)) throw new Refused(`No note "${a.ref}"`);
    if (!a.unlock && n.locked_at) return { already_locked: n.path };
    if (a.unlock && !n.locked_at) return { not_locked: n.path };
    const fm = JSON.parse(n.frontmatter);
    if (a.unlock) delete fm.archived; else fm.archived = today(this.c);
    await this.db.batch([
      this.revisionStmt(n, a.summary),
      this.db.prepare("UPDATE nodes SET locked_at = ?, archived_at = ?, frontmatter = ?, version = version + 1 WHERE id = ?")
        .bind(a.unlock ? null : nowIso(), a.unlock ? null : today(this.c), JSON.stringify(fm), n.id),
      this.logStmt(a.unlock ? "unlock" : "lock_archive", a.summary, [n.path], n.sensitivity === "sensitive"),
    ]);
    return { [a.unlock ? "unlocked" : "locked_and_archived"]: n.path };
  }

  async restore(a: { ref: string; version: number; summary: string }) {
    need(this.p, "brain.update");
    const n = await this.mustWrite(a.ref);
    const r = await this.db.prepare("SELECT * FROM revisions WHERE node_id = ? AND version = ?").bind(n.id, a.version).first<any>();
    if (!r) throw new Refused(`No version ${a.version} of "${n.path}"`);
    const body = r.encrypted ? await this.unseal(r.body) : r.body;
    const fm = JSON.parse(r.frontmatter);
    delete fm.updated;
    return this.edit({ ref: n.path, base_version: n.version, rewrite: body, set: Object.fromEntries(Object.keys({ ...JSON.parse(n.frontmatter), ...fm }).map((k) => [k, fm[k] ?? null])), summary: `${a.summary} (restored version ${a.version})` });
  }

  async recordAdd(a: { ref: string; date: string; kind: string; fields: Record<string, unknown>; summary: string }) {
    need(this.p, "brain.create");
    const n = await this.mustWrite(a.ref);
    if (!/^\d{4}-\d{2}-\d{2}/.test(a.date)) throw new Refused("date must be YYYY-MM-DD");
    assertNoSecrets(JSON.stringify(a.fields));
    const sensitive = n.sensitivity === "sensitive";
    const json = JSON.stringify(a.fields);
    const id = newId("br_");
    await this.db.batch([
      this.db.prepare("INSERT INTO records (id, node_id, date, kind, fields, encrypted, created, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, n.id, a.date, a.kind, sensitive ? await this.seal(json) : json, sensitive ? 1 : 0, nowIso(), this.p.actor),
      this.db.prepare("UPDATE nodes SET updated = ? WHERE id = ?").bind(today(this.c), n.id),
      this.logStmt("record_add", a.summary, [n.path], sensitive),
    ]);
    return { record: id, on: n.path };
  }

  async bookingLink(a: { ref: string; calendar: string; event_uid: string; event_title: string; start?: string; summary: string }) {
    need(this.p, "brain.update");
    const n = await this.mustWrite(a.ref);
    const status = isBracketed(a.event_title) ? "idea" : "confirmed";
    await this.db.prepare("INSERT OR REPLACE INTO calendar_refs (node_id, calendar, event_uid, status, title, start, linked_at, linked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(n.id, a.calendar, a.event_uid, status, a.event_title, a.start ?? null, nowIso(), this.p.actor).run();
    const { results } = await this.db.prepare("SELECT status FROM calendar_refs WHERE node_id = ?").bind(n.id).all<any>();
    const booking = results.some((r) => r.status === "confirmed") ? "confirmed" : "idea";
    const fm = JSON.parse(n.frontmatter);
    if (fm.booking !== booking) await this.edit({ ref: n.path, base_version: n.version, set: { booking }, summary: a.summary });
    else await this.logStmt("booking_link", a.summary, [n.path], n.sensitivity === "sensitive").run();
    return { linked: n.path, event: a.event_title, status, booking };
  }

  // ---------- the map and the export ----------

  /** Every note this caller may see, and the lines between them: the tree, and the links. No text. */
  async graph() {
    need(this.p, "brain.read");
    await this.roots();
    const hide = this.hideSensitiveSql();
    const [nodes, edges] = await this.db.batch([
      this.db.prepare(`SELECT n.id, n.parent_id, n.root, n.title, n.path, n.kind, n.type, n.status, n.sensitivity, n.updated,
                         n.archived_at IS NOT NULL AS archived, n.locked_at IS NOT NULL AS locked,
                         json_extract(n.frontmatter, '$.booking') AS booking
                       FROM nodes n WHERE n.deleted_at IS NULL${hide}`),
      this.db.prepare("SELECT e.src, e.dst, e.kind FROM edges e WHERE e.dst IS NOT NULL"),
    ]);
    const ns = nodes.results as any[];
    const known = new Set(ns.map((n) => n.id));
    const links: { source: string; target: string; kind: string }[] = [];
    const seen = new Set<string>();
    const add = (s: string, t: string, kind: string) => {
      const k = s < t ? `${s}|${t}` : `${t}|${s}`;
      if (s === t || seen.has(k) || !known.has(s) || !known.has(t)) return;
      seen.add(k);
      links.push({ source: s, target: t, kind });
    };
    for (const n of ns) if (n.parent_id) add(n.parent_id, n.id, "tree");
    for (const e of edges.results as any[]) add(e.src, e.dst, e.kind);
    const degree = new Map<string, number>();
    for (const l of links) for (const id of [l.source, l.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
    return {
      roots: this.c.roots,
      nodes: ns.map((n) => ({ ...n, archived: !!n.archived, locked: !!n.locked, degree: degree.get(n.id) ?? 0 })),
      links,
    };
  }

  /** What changed since a moment, oldest first, for the map's live pulses. */
  async activity(since: string) {
    need(this.p, "brain.read");
    const { results } = await this.db.prepare("SELECT ts, job, summary, paths, actor, sensitive FROM log WHERE ts >= ? ORDER BY id DESC LIMIT 400").bind(since).all<any>();
    return this.visibleLog(results).reverse();
  }

  /** Everything this caller may read, one JSON object per line: notes (sensitive ones unsealed), then links,
   *  records, calendar links and the log. */
  async exportAll(): Promise<string> {
    need(this.p, "brain.read");
    const { results: nodes } = await this.db.prepare(`SELECT * FROM nodes n WHERE n.deleted_at IS NULL${this.hideSensitiveSql()} ORDER BY n.path`).all<NodeRow>();
    const ids = new Set(nodes.map((n) => n.id));
    const lines: string[] = [];
    for (const n of nodes) {
      lines.push(JSON.stringify({ t: "node", path: n.path, id: n.id, kind: n.kind, sensitivity: n.sensitivity, version: n.version,
        locked_at: n.locked_at, archived_at: n.archived_at, frontmatter: JSON.parse(n.frontmatter), body: await this.bodyOf(n) }));
    }
    const { results: edges } = await this.db.prepare("SELECT * FROM edges").all<any>();
    for (const e of edges) if (ids.has(e.src) && (!e.dst || ids.has(e.dst))) lines.push(JSON.stringify({ t: "edge", ...e }));
    const { results: records } = await this.db.prepare("SELECT * FROM records WHERE deleted_at IS NULL ORDER BY date, created").all<any>();
    for (const r of records) {
      if (!ids.has(r.node_id)) continue;
      lines.push(JSON.stringify({ t: "record", id: r.id, node_id: r.node_id, date: r.date, kind: r.kind, fields: JSON.parse(r.encrypted ? await this.unseal(r.fields) : r.fields), created: r.created, created_by: r.created_by }));
    }
    const { results: refs } = await this.db.prepare("SELECT * FROM calendar_refs").all<any>();
    for (const r of refs) if (ids.has(r.node_id)) lines.push(JSON.stringify({ t: "calendar_ref", ...r }));
    const { results: log } = await this.db.prepare("SELECT date, ts, job, summary, paths, actor, sensitive FROM log ORDER BY id").all<any>();
    for (const l of this.visibleLog(log)) lines.push(JSON.stringify({ t: "log", ...l }));
    return lines.join("\n") + "\n";
  }
}

/** LIKE pattern for "everything under this path". */
export function likePrefix(path: string) {
  return path.replace(/[\\%_]/g, (c) => "\\" + c) + "/%";
}
