-- <prefix>-home: what the Home Assistant, Energy and Kiosk modules keep. No personal data beyond first names in
-- the audit lines; nothing here is a secret.

-- One JSON row per key:
--   ha.states      the newest compact reading of Home Assistant (lights, switches, scenes, lists, power sensors)
--   ha.settings    which lists belong to whom, which switches are plugs, which lights are hidden
--   energy.config  which sensors are solar, grid, battery and devices
--   energy.day     today's running totals
CREATE TABLE home_kv (
  key   TEXT PRIMARY KEY,
  data  TEXT NOT NULL,
  at    INTEGER NOT NULL                      -- ms, when it was written
);

-- One energy sample a minute, kept for 48 hours (the tick deletes older rows).
CREATE TABLE energy_samples (
  ts    INTEGER PRIMARY KEY,                  -- ms, rounded to the minute
  data  TEXT NOT NULL                         -- JSON: { solar, home, grid, battery, level }
);

-- Wall tablets. A tablet asks for a code; an admin approves it in Settings; the tablet's next poll gets its key.
CREATE TABLE kiosk_pairings (
  code        TEXT PRIMARY KEY,               -- shown on the tablet, typed in Settings (10 minutes)
  secret_hash TEXT NOT NULL UNIQUE,           -- sha256 of the tablet's poll secret
  created     INTEGER NOT NULL,
  expires     INTEGER NOT NULL,
  name        TEXT,                           -- set at approval
  approved_by TEXT,                           -- person id
  approved    INTEGER,
  device      TEXT                            -- kiosk_devices.id once the tablet picked up its key
);

CREATE TABLE kiosk_devices (
  id          TEXT PRIMARY KEY,               -- ks_...
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,           -- sha256 of the cookie value; the value itself is never stored
  created     INTEGER NOT NULL,
  approved_by TEXT NOT NULL,                  -- person id
  expires     INTEGER NOT NULL,
  last_seen   INTEGER,
  revoked     INTEGER,
  revoked_by  TEXT
);

-- Who changed what: settings, pairings, revocations. Ids and names of things only.
CREATE TABLE home_audit (
  ts     INTEGER NOT NULL,
  actor  TEXT NOT NULL,                       -- person id, "kiosk", "mcp:<name>" or "system"
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE INDEX home_audit_ts ON home_audit(ts);
