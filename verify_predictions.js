// Remote check: are predictions refreshing, and do they track the live imbalance trend?
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/market.db');

const runs = db.prepare(`
  SELECT DISTINCT run_at FROM predictions ORDER BY run_at DESC LIMIT 5
`).all().map((r) => r.run_at);
console.log('last 5 prediction runs:', JSON.stringify(runs));

// recent realized imbalance (the trend the trader sees)
const recent = db.prepare(`
  SELECT ts_utc, ROUND(value,0) imb FROM series
  WHERE series='damas_est_sys_imbalance' ORDER BY ts_utc DESC LIMIT 6
`).all();
console.log('recent system imbalance (newest first):', JSON.stringify(recent));

// how prob_long for the NEXT few upcoming ISPs evolved across the last 3 runs
const next = db.prepare(`
  SELECT ts_utc FROM predictions WHERE run_at=? AND ts_utc > datetime('now') ORDER BY ts_utc LIMIT 4
`).all(runs[0]).map((r) => r.ts_utc);
for (const ts of next) {
  const hist = db.prepare(`
    SELECT run_at, prob_long FROM predictions WHERE ts_utc=? AND run_at IN (?,?,?)
    ORDER BY run_at
  `).all(ts, runs[2], runs[1], runs[0]);
  console.log(ts, '->', hist.map((h) => `${h.run_at.slice(11, 16)}Z:${(h.prob_long * 100).toFixed(0)}%`).join(' '));
}
