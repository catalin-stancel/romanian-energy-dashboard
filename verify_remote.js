// Remote data verification (runs on the Render instance against /data/market.db).
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/market.db');
const q = (sql) => db.prepare(sql).get();
console.log(JSON.stringify({
  series: q('SELECT COUNT(*) n FROM series').n,
  offers: q('SELECT COUNT(*) n FROM offers').n,
  predictions: q('SELECT COUNT(*) n FROM predictions').n,
  bets: q('SELECT COUNT(*) n FROM bets').n,
  user_bets: q('SELECT COUNT(*) n FROM user_bets').n,
  latest_damas: q(`SELECT MAX(ts_utc) m FROM series WHERE series='damas_est_sys_imbalance'`).m,
}));
