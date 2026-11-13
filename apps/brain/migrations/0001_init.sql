-- Brain: the household's notes as a tree, with links, records and every earlier version.

-- Every note, hub and dated entry. One parent each; path is the chain of titles.
CREATE TABLE nodes (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT REFERENCES nodes(id),
  root         TEXT NOT NULL,                     -- a person's first name, or the shared root
  title        TEXT NOT NULL,
  path         TEXT NOT NULL UNIQUE,              -- e.g. Alex/Work/People/Jo Bloggs
  kind         TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'entry', 'hub')),
  type         TEXT NOT NULL DEFAULT 'note',
  status       TEXT NOT NULL DEFAULT 'active',
  sensitivity  TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'sensitive')),
  tags         TEXT NOT NULL DEFAULT '[]',        -- JSON array
  frontmatter  TEXT NOT NULL DEFAULT '{}',        -- JSON object: type, status, created, updated, tags, related …
  body         TEXT NOT NULL DEFAULT '',          -- markdown, or a sealed value when encrypted = 1
  encrypted    INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  created      TEXT NOT NULL,
  updated      TEXT NOT NULL,
  locked_at    TEXT,
  archived_at  TEXT,
  deleted_at   TEXT
);
CREATE INDEX nodes_parent  ON nodes(parent_id);
CREATE INDEX nodes_root    ON nodes(root);
CREATE INDEX nodes_updated ON nodes(updated);
CREATE INDEX nodes_title   ON nodes(title COLLATE NOCASE);

-- Keyword search. Sensitive notes are indexed by title and path only.
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  node_id UNINDEXED, title, path, body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Connections. target is the link text; dst is the note it resolves to (NULL = no such note yet).
CREATE TABLE edges (
  src         TEXT NOT NULL,
  target      TEXT NOT NULL,
  dst         TEXT,
  kind        TEXT NOT NULL,                     -- link | related | followed | caused_by | about
  created     TEXT NOT NULL,
  created_by  TEXT,
  PRIMARY KEY (src, target, kind)
);
CREATE INDEX edges_dst ON edges(dst);

-- Rows by date on a note (trip costs, measurements). Sealed when the note is sensitive.
CREATE TABLE records (
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL,
  date        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  fields      TEXT NOT NULL,                     -- JSON, or a sealed value when encrypted = 1
  encrypted   INTEGER NOT NULL DEFAULT 0,
  created     TEXT NOT NULL,
  created_by  TEXT,
  deleted_at  TEXT
);
CREATE INDEX records_node ON records(node_id, date);

-- A note tied to a calendar event: confirmed, or an idea (the event's title was in round brackets).
CREATE TABLE calendar_refs (
  node_id    TEXT NOT NULL,
  calendar   TEXT NOT NULL,
  event_uid  TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('confirmed', 'idea')),
  title      TEXT,
  start      TEXT,
  linked_at  TEXT NOT NULL,
  linked_by  TEXT,
  PRIMARY KEY (node_id, calendar, event_uid)
);

-- Every earlier version of every note.
CREATE TABLE revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id     TEXT NOT NULL,
  version     INTEGER NOT NULL,
  title       TEXT,
  path        TEXT,
  frontmatter TEXT,
  body        TEXT,
  encrypted   INTEGER NOT NULL DEFAULT 0,
  changed_at  TEXT NOT NULL,
  changed_by  TEXT NOT NULL,
  summary     TEXT NOT NULL
);
CREATE INDEX revisions_node ON revisions(node_id, version);
CREATE INDEX revisions_time ON revisions(changed_at);

-- What changed, one line per write. sensitive rows are hidden from callers who may not read those notes.
CREATE TABLE log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  ts         TEXT NOT NULL,
  job        TEXT NOT NULL,
  summary    TEXT NOT NULL,
  paths      TEXT NOT NULL DEFAULT '[]',
  actor      TEXT,
  sensitive  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX log_date ON log(date);
CREATE INDEX log_ts ON log(ts);

-- Every tool call and dashboard write, allowed or refused. Names and paths only, never a note's text.
CREATE TABLE audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  via     TEXT NOT NULL,
  tool    TEXT NOT NULL,
  target  TEXT,
  ok      INTEGER NOT NULL,
  detail  TEXT
);
CREATE INDEX audit_ts ON audit(ts);
