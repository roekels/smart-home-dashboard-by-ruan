-- D1 <prefix>-gateway: connection state only. No module's data lives here.

-- Bearer keys (hmcp_<name>_…) for the household's own programs, such as Alfred. Only the SHA-256 is stored.
-- One key may hold scopes of several services; each MCP path uses only its own.
CREATE TABLE api_keys (
  name        TEXT PRIMARY KEY,
  sha256      TEXT NOT NULL UNIQUE,
  scopes      TEXT NOT NULL,                    -- JSON array
  created     TEXT NOT NULL,
  last_used   TEXT,
  revoked_at  TEXT,
  note        TEXT
);

-- Connection audit: every MCP tool call and every approved connection, allowed or refused.
-- Names and ids only: a tool never writes note text, amounts or health details here.
CREATE TABLE audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,
  service  TEXT NOT NULL,                       -- the service id, e.g. household
  actor    TEXT NOT NULL,
  via      TEXT NOT NULL,                       -- key | oauth | access
  tool     TEXT NOT NULL,
  target   TEXT,
  ok       INTEGER NOT NULL,
  detail   TEXT
);
CREATE INDEX audit_ts ON audit(ts);
CREATE INDEX audit_service_ts ON audit(service, ts);
