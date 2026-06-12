// SQLite store for market data, keyed by UTC interval start + Romanian (date, ISP 1..96).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// On Render the database lives on the persistent disk (DATA_DIR=/data); locally it
// defaults to ./data inside this repo so the original local project is never touched.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
require('fs').mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'market.db');

function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;   -- allow concurrent pullers
    PRAGMA busy_timeout = 60000; -- wait instead of "database is locked"
    PRAGMA synchronous = NORMAL; -- avoid fsync stalls on every commit (safe with WAL)
    PRAGMA wal_autocheckpoint = 2000; -- checkpoint in smaller slices so readers never stall long
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS series (
      series      TEXT NOT NULL,
      ts_utc      TEXT NOT NULL,   -- 15-min interval start, ISO UTC
      date_ro     TEXT NOT NULL,   -- delivery date in Europe/Bucharest (matches workbooks/DECONTARE)
      isp         INTEGER NOT NULL,-- 15-min interval of the RO day, 1..96 (92/100 on DST days)
      value       REAL NOT NULL,   -- latest known value
      first_value REAL NOT NULL,   -- value as first published (for revision analysis)
      first_seen  TEXT NOT NULL,   -- when we first stored this point (publication-lag measurement)
      last_seen   TEXT NOT NULL,
      PRIMARY KEY (series, ts_utc)
    );
    CREATE INDEX IF NOT EXISTS idx_series_date ON series (series, date_ro, isp);
    CREATE INDEX IF NOT EXISTS idx_series_day ON series (date_ro);
    CREATE TABLE IF NOT EXISTS weather (
      point     TEXT NOT NULL,
      model     TEXT NOT NULL,
      var       TEXT NOT NULL,
      ts_utc    TEXT NOT NULL,     -- forecast valid time (hourly)
      pulled_at TEXT NOT NULL,     -- pull time; keep every run to compute run-to-run revisions
      value     REAL,
      PRIMARY KEY (point, model, var, ts_utc, pulled_at)
    );
    CREATE TABLE IF NOT EXISTS pull_log (
      source TEXT, args TEXT, started TEXT, finished TEXT, rows INTEGER, error TEXT
    );
  `);
  return db;
}

const roFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit',
});

function roDate(d) {
  return roFmt.format(d); // en-CA gives YYYY-MM-DD
}

// Map a UTC instant to the Romanian delivery date and 15-min ISP index.
// ISPs are numbered sequentially within the local day (1..96; 92 on spring DST, 100 on fall DST),
// the same convention as ENTSO-E Point positions. Midnights are cached per date.
const midnightCache = new Map();
function roDateIsp(d) {
  const date = roDate(d);
  let mid = midnightCache.get(date);
  if (mid === undefined) {
    let t = d.getTime() - (d.getTime() % 900000);
    while (roDate(new Date(t - 900000)) === date) t -= 900000;
    midnightCache.set(date, (mid = t));
  }
  return { date, isp: Math.floor((d.getTime() - mid) / 900000) + 1 };
}

function makeUpserter(db) {
  const stmt = db.prepare(`
    INSERT INTO series (series, ts_utc, date_ro, isp, value, first_value, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (series, ts_utc) DO UPDATE SET
      value = excluded.value,
      last_seen = excluded.last_seen
  `);
  return (series, tsUtc, value) => {
    const now = new Date().toISOString();
    const { date, isp } = roDateIsp(new Date(tsUtc));
    stmt.run(series, tsUtc, date, isp, value, value, now, now);
  };
}

module.exports = { openDb, roDateIsp, makeUpserter, DB_PATH };
