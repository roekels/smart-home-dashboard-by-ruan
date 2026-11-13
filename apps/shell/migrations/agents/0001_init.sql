-- <prefix>-agents: edge agents, what they send and the commands for them. Contract: agent/PROTOCOL.md

CREATE TABLE agents (
  id          TEXT PRIMARY KEY,                 -- ag_<slug>
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,                    -- mac | windows | linux | other
  pubkey      TEXT,                             -- raw Ed25519 public key, base64url; NULL until enrolled
  fingerprint TEXT,                             -- base64url of the first 16 bytes of sha256(raw public key)
  approved    INTEGER,                          -- ms; NULL = enrolled but not approved: signed requests are refused
  approved_by TEXT,                             -- person id
  enrol_hash  TEXT,                             -- sha256 of the one-time code; NULL once used
  enrol_until INTEGER,                          -- ms
  allow_ops   TEXT NOT NULL DEFAULT '[]',       -- JSON: commands the dashboard may queue for it
  created     INTEGER NOT NULL,
  enrolled    INTEGER,
  last_seen   INTEGER,
  revoked     INTEGER
);

CREATE TABLE records (
  source  TEXT NOT NULL,                        -- agent id; never taken from the body
  kind    TEXT NOT NULL,
  ts      INTEGER NOT NULL,                     -- ms, as reported by the agent
  rx      INTEGER NOT NULL,                     -- ms, Worker receive time
  data    TEXT NOT NULL                         -- JSON object
);
CREATE INDEX records_src_kind_ts ON records(source, kind, ts);
CREATE INDEX records_rx ON records(rx);

-- Latest record per (source, kind): what the pages read first.
CREATE TABLE latest (
  source  TEXT NOT NULL,
  kind    TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (source, kind)
);

CREATE TABLE nonces (
  agent  TEXT NOT NULL,
  nonce  TEXT NOT NULL,
  ts     INTEGER NOT NULL,
  PRIMARY KEY (agent, nonce)
);

CREATE TABLE commands (
  id            TEXT PRIMARY KEY,               -- cmd_<id>
  agent         TEXT NOT NULL REFERENCES agents(id),
  op            TEXT NOT NULL,
  args          TEXT NOT NULL DEFAULT '{}',
  tier          TEXT NOT NULL CHECK (tier IN ('safe', 'destructive')),
  status        TEXT NOT NULL CHECK (status IN ('proposed', 'queued', 'delivered', 'done', 'failed', 'expired', 'rejected')),
  proposed_by   TEXT NOT NULL,                  -- person id, or "mcp:<name>"
  confirmed_by  TEXT,                           -- person id
  created       INTEGER NOT NULL,
  confirmed     INTEGER,
  expires       INTEGER NOT NULL,
  delivered     INTEGER,
  finished      INTEGER,
  result        TEXT
);
CREATE INDEX commands_agent_status ON commands(agent, status);

CREATE TABLE audit (
  ts     INTEGER NOT NULL,
  actor  TEXT NOT NULL,                         -- person id, agent id, "mcp:<name>", "system"
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE INDEX audit_ts ON audit(ts);
