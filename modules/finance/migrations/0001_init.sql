-- Finance: accounts, balances, holdings, assets, contracts, transactions, deadlines, documents, logbook, tax years.
-- Every row of every table is one line in `rows`, with its fields sealed in `data` (AES-256-GCM under
-- FINANCE_DATA_ENCRYPTION_KEY). Readable in the database: which table a row belongs to, its date (so a date
-- range needs no decrypting), when it changed and whether it is archived. No names, amounts or notes.
CREATE TABLE rows (
  id         TEXT PRIMARY KEY,
  tbl        TEXT NOT NULL,
  day        TEXT,
  data       TEXT NOT NULL,
  created    INTEGER NOT NULL,
  updated    INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  archived   INTEGER
);
CREATE INDEX rows_tbl_day ON rows (tbl, day);

-- Public reference rates of the European Central Bank: 1 EUR = per_eur units of the currency.
CREATE TABLE fx_rates (
  date     TEXT NOT NULL,
  currency TEXT NOT NULL,
  per_eur  REAL NOT NULL,
  PRIMARY KEY (date, currency)
);

-- The currencies in use, so the daily rate sync knows what to fetch without decrypting anything.
CREATE TABLE currencies (currency TEXT PRIMARY KEY);

-- Who changed what and when. `detail` holds field names and counts, never a value.
CREATE TABLE audit (
  ts     INTEGER NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX audit_ts ON audit (ts);
