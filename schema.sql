CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  customer TEXT NOT NULL,
  item TEXT NOT NULL,
  freq REAL NOT NULL,
  status TEXT NOT NULL DEFAULT '待處理',
  remarks TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT '正常營業',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS records_date_idx ON records(date);
CREATE INDEX IF NOT EXISTS records_customer_idx ON records(customer);
INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '0');
