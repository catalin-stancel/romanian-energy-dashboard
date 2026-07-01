// Pull day-ahead PZU signals from the external "RO Signal Override" desk into market.db.
// The page is server-rendered HTML (no JSON API); per 15-min slot it carries hidden slot_<key>=UTC-ISO,
// a sig_<key> select (BUY/SELL/HOLD; the model's choice is the `selected` option), and q_<key> = MW (0–2.5).
// Night slots only offer BUY/HOLD (no SELL) — the desk's "night = buy-only from PZU" rule is baked in.
// Stored per (date_ro, isp) in ext_signals so /pzu and /pi can show these as the positions.
//   node src/pull_signals.js         (scheduled every ~15 min)
// CONFIG: set SIGNAL_URL / SIGNAL_USER / SIGNAL_PASS in the environment (Render dashboard). Public repo → NO defaults.
const https = require('https');
const { openDb, roDateIsp } = require('./db');

const SRC = process.env.SIGNAL_URL || '';
const USER = process.env.SIGNAL_USER || '';
const PASS = process.env.SIGNAL_PASS || '';

function fetchPage() {
  return new Promise((resolve, reject) => {
    const u = new URL(SRC);
    const req = https.request({ host: u.hostname, port: u.port || 443, path: u.pathname, method: 'GET',
      rejectUnauthorized: false, // self-signed cert on a raw IP
      headers: { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') }, timeout: 25000 },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => (res.statusCode === 200 ? resolve(d) : reject(new Error('HTTP ' + res.statusCode)))); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end();
  });
}

function parse(html) {
  const out = [];
  // one entry per hidden slot_<key> = UTC ISO timestamp
  const slotRe = /name="slot_([^"]+)"\s+value="([^"]+)"/g; let m;
  while ((m = slotRe.exec(html))) {
    const key = m[1], ts = m[2];
    // selected option in the matching sig_<key> select
    const selBlk = new RegExp(`name="sig_${key}"[\\s\\S]*?</select>`).exec(html);
    let sig = null; if (selBlk) { const s = /<option value="([A-Z]+)"\s+selected/.exec(selBlk[0]); sig = s ? s[1] : (/<option value="([A-Z]+)"/.exec(selBlk[0]) || [])[1] || null; }
    // q_<key> number input value
    const qm = new RegExp(`name="q_${key}"[^>]*\\svalue="([-0-9.]+)"`).exec(html);
    const q = qm ? +qm[1] : null;
    const d = new Date(ts); if (isNaN(d)) continue;
    const { date, isp } = roDateIsp(d);
    out.push({ ts, date, isp, sig, q });
  }
  return out;
}

// 10:00 CET (= 11:00 EET) on the day before delivery, DST-safe — mirrors predict.js lockTimeFor
function lockTimeFor(deliveryDate) {
  const prev = new Date(new Date(deliveryDate + 'T12:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const base = new Date(prev + 'T00:00:00Z').getTime();
  for (const off of [3, 2]) { const cand = new Date(base + (11 - off) * 3600000); const r = roDateIsp(cand); if (r.date === prev && Math.floor(((r.isp - 1) * 15) / 60) === 11) return cand; }
  return new Date(base + 9 * 3600000);
}
// Auto-fill user_bets from the desk signals (BUY→+Q, SELL→−Q, HOLD→0). Same policy as the old model auto-fill:
// refresh 'auto' rows each run until the sheet locks at 10:00 CET D-1; never overwrite 'manual' rows.
function autoFillFromDesk(db, now) {
  const sigs = db.prepare('SELECT date_ro, isp, sig, q FROM ext_signals').all();
  const upsert = db.prepare(`INSERT INTO user_bets (date_ro, isp, qty, updated_at, source) VALUES (?,?,?,?, 'auto')
    ON CONFLICT (date_ro, isp) DO UPDATE SET qty=excluded.qty, updated_at=excluded.updated_at
    WHERE user_bets.source = 'auto' AND user_bets.qty != excluded.qty`);
  const log = db.prepare('INSERT INTO user_bets_log (date_ro, isp, qty, saved_at) VALUES (?,?,?,?)');
  const today = roDateIsp(now).date; // sync the desk's active/future delivery date(s); never rewrite settled past days
  const ts = now.toISOString(); let n = 0;
  db.exec('BEGIN');
  for (const s of sigs) {
    if (s.date_ro < today) continue; // no fixed 10:00 freeze → the FINAL desk plan is always captured each day; a date naturally freezes once the desk rolls to the next delivery date (its ext_signals stop updating)
    const signed = s.sig === 'BUY' ? s.q : s.sig === 'SELL' ? -s.q : 0; // PZU-side: BUY=+ (surplus), SELL=−
    const before = db.prepare('SELECT qty, source FROM user_bets WHERE date_ro=? AND isp=?').get(s.date_ro, s.isp);
    upsert.run(s.date_ro, s.isp, signed, ts);
    if (!before || (before.source === 'auto' && before.qty !== signed)) { log.run(s.date_ro, s.isp, signed, ts); n++; }
  }
  db.exec('COMMIT');
  return n;
}

async function main() {
  if (!SRC) { console.log('SIGNAL_URL not set — desk pull skipped (set SIGNAL_URL/SIGNAL_USER/SIGNAL_PASS in the Render env)'); return; }
  const html = await fetchPage();
  const dd = (/Delivery date:\s*<b>([0-9-]+)/.exec(html) || [])[1] || '?';
  const rows = parse(html);
  console.log(`fetched. delivery_date=${dd}  parsed ${rows.length} slots`);
  if (!rows.length) { console.log('NO SLOTS PARSED — page format may have changed'); process.exit(1); }
  // persist per (date_ro, isp) — re-pulls update in place; different delivery dates accumulate
  const db = openDb();
  db.exec('CREATE TABLE IF NOT EXISTS ext_signals(date_ro TEXT, isp INTEGER, sig TEXT, q REAL, ts_utc TEXT, delivery_date TEXT, pulled_at TEXT, PRIMARY KEY(date_ro, isp))');
  const now = new Date().toISOString();
  const up = db.prepare('INSERT INTO ext_signals(date_ro,isp,sig,q,ts_utc,delivery_date,pulled_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(date_ro,isp) DO UPDATE SET sig=excluded.sig, q=excluded.q, ts_utc=excluded.ts_utc, delivery_date=excluded.delivery_date, pulled_at=excluded.pulled_at');
  db.exec('BEGIN'); let n = 0; for (const r of rows) { up.run(r.date, r.isp, r.sig, r.q, r.ts, dd, now); n++; } db.exec('COMMIT');
  console.log(`stored ${n} rows into ext_signals`);
  // desk signal IS the position: auto-fill user_bets (replaces the old model auto-fill), then lock@10:00 + PI P&L track it
  const nf = autoFillFromDesk(db, new Date());
  console.log(`auto-filled ${nf} user_bets positions from the desk (current + future delivery dates; past days untouched, manual preserved)`);
  const bySig = {}; for (const r of rows) bySig[r.sig] = (bySig[r.sig] || 0) + 1;
  console.log('signal counts:', JSON.stringify(bySig));
  console.log('date span:', rows[0].date, 'isp', rows[0].isp, '→', rows[rows.length - 1].date, 'isp', rows[rows.length - 1].isp);
}
main().catch((e) => { console.error('pull_signals error:', e.message); process.exit(1); });
