-- D1 <prefix>-health: the household's health records (doctor visits, test results, vaccinations, medication).
-- Everything about a record is in `data`, sealed with AES-256-GCM (packages/core/src/seal.ts, Worker secret
-- HEALTH_DATA_ENCRYPTION_KEY). In the clear: only whose record it is (a person id from the household config), its
-- type and its date, so lists can be sorted without the key.
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  person TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('visit', 'test', 'vaccination', 'medication')),
  date TEXT NOT NULL,
  data TEXT NOT NULL,
  created INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  archived INTEGER
);
CREATE INDEX records_person ON records (person, type, date);

-- The sealed data a record had before each change, so any edit can be undone.
CREATE TABLE versions (
  record_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX versions_record ON versions (record_id, ts);

-- Who did what, never the values.
CREATE TABLE audit (
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT
);
CREATE INDEX audit_ts ON audit (ts);
