// X-B PI trajectory logger (append-only). Every run, snapshot the NET cross-border position by timeframe
// (dayAhead / intraday(PI) / longTerm / commercial) for every UPCOMING delivery interval, keyed by pull time.
// Purpose: capture how intraday (PI) trading moves a delivery interval's position through the day, so we can
// later test whether that belief-updating (the PI evolution) LEADS the realized imbalance.
//   node tool/log_xb_pi.js     (schedule every ~10 min)
const { openDb, roDateIsp } = require('./db');
const BASE = 'https://newmarkets.transelectrica.ro/usy-durom-publicreportg01/00121002500000000000000000000100/';
const num = (v) => { const n = Number(v); return v !== null && v !== undefined && v !== 'N/A' && Number.isFinite(n) ? n : null; };
const EXPB = ['rohu', 'robg', 'rors', 'roua', 'romd'], IMPB = ['huro', 'bgro', 'rsro', 'uaro', 'mdro'];

(async () => {
  const db = openDb();
  db.exec('CREATE TABLE IF NOT EXISTS xb_pi_snap(pulled_at TEXT, ts_utc TEXT, date_ro TEXT, isp INTEGER, d1 REAL, pi REAL, lt REAL, commercial REAL)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_xbsnap ON xb_pi_snap(ts_utc, pulled_at)');
  const todayUtc = new Date().toISOString().slice(0, 10);
  const from = new Date(todayUtc + 'T00:00:00Z').toISOString();
  const to = new Date(new Date(todayUtc + 'T00:00:00Z').getTime() + 2 * 86400000).toISOString(); // today + tomorrow
  const u = new URL(BASE + 'publicReport/scheduledExchanges');
  u.searchParams.set('timeInterval', JSON.stringify({ from, to }));
  const items = (await (await fetch(u)).json()).itemList || [];
  const pulledAt = new Date().toISOString();
  const nowMs = Date.now();
  const netTf = (item, tf) => { let s = 0, any = false; for (const b of EXPB) { const o = item[b]; const v = o ? num(o[tf]) : null; if (v !== null) { s += v; any = true; } } for (const b of IMPB) { const o = item[b]; const v = o ? num(o[tf]) : null; if (v !== null) { s -= v; any = true; } } return any ? s : null; };
  const snap = db.prepare('INSERT INTO xb_pi_snap VALUES (?,?,?,?,?,?,?,?)');
  // DEDUP: only append a frame when the net position CHANGED since this interval's last frame, so we can poll
  // every 60s (catch the heavy last-5-min trading) while storing only real belief-moves — flat intervals cost 0.
  const lastMap = new Map();
  for (const r of db.prepare('SELECT ts_utc, pi, commercial, MAX(pulled_at) mp FROM xb_pi_snap WHERE ts_utc > ? GROUP BY ts_utc').all(new Date(nowMs).toISOString())) lastMap.set(r.ts_utc, r);
  let n = 0;
  db.exec('BEGIN');
  for (const item of items) {
    const ts = item.timeInterval && item.timeInterval.from;
    if (!ts || new Date(ts).getTime() <= nowMs) continue; // only pre-delivery (upcoming) intervals
    const cm = netTf(item, 'commercial');
    if (cm === null) continue;
    const pi = netTf(item, 'intraday');
    const prev = lastMap.get(ts);
    if (prev && Math.abs(cm - prev.commercial) < 0.5 && Math.abs((pi ?? 0) - (prev.pi ?? 0)) < 0.5) continue; // unchanged → skip
    const ri = roDateIsp(new Date(ts));
    snap.run(pulledAt, ts, ri.date, ri.isp, netTf(item, 'dayAhead'), pi, netTf(item, 'longTerm'), cm);
    n++;
  }
  db.exec('COMMIT');
  console.log(`xb_pi_snap +${n} changed rows @ ${pulledAt}`);
})().catch((e) => { console.error(e); process.exit(1); });
