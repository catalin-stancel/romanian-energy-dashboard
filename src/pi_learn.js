// Online learner: does the intraday X-B PI movement ADD predictive value over persistence for imbalance sign?
// Predicts each interval T as-of A = T-LEAD using ONLY data available then (no lookahead):
//   persist = last known imbalance at A (imbalance lags ~25min)
//   pi_move = net commercial(T) latest-snapshot-≤A  minus  first-snapshot  (the intraday repositioning so far)
// Logistic p = sigmoid(w0 + w1*tanh(persist/150) + w2*tanh(pi_move/100)); SGD-updated when T settles.
// Scoreboard: model (persist+PI) accuracy vs persist-alone baseline. If w2 stabilizes non-zero AND model>persist,
// the PI order-flow signal is real. Learns as it goes — starts uninformed, self-calibrates.
//   node tool/pi_learn.js     (schedule every ~15 min)
const { openDb } = require('./db');
const LEAD_MIN = 60, IMB_LAG_MIN = 25, LR = 0.05, L2 = 0.0005;
const sig = (z) => 1 / (1 + Math.exp(-z));

try {
  const db = openDb();
  db.exec(`CREATE TABLE IF NOT EXISTS pi_learn_state(id INTEGER PRIMARY KEY, w0 REAL, w1 REAL, w2 REAL, n INTEGER, model_ok INTEGER, persist_ok INTEGER, updated TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS pi_learn_log(ts_utc TEXT PRIMARY KEY, isp INTEGER, persist REAL, pi_move REAL, prob REAL, pred INTEGER, y INTEGER, ok_model INTEGER, ok_persist INTEGER, big INTEGER, learned_at TEXT)`);
  // log_xb_pi.js owns xb_pi_snap; create-if-absent here too so a fresh DB or job-order race (both jobs stagger 0-30s on boot) can't crash this learner — it just finds 0 rows.
  db.exec('CREATE TABLE IF NOT EXISTS xb_pi_snap(pulled_at TEXT, ts_utc TEXT, date_ro TEXT, isp INTEGER, d1 REAL, pi REAL, lt REAL, commercial REAL)');
  let st = db.prepare('SELECT * FROM pi_learn_state WHERE id=1').get();
  if (!st) { st = { w0: 0, w1: 0.4, w2: 0, n: 0, model_ok: 0, persist_ok: 0 }; db.prepare('INSERT INTO pi_learn_state VALUES (1,?,?,?,?,?,?,?)').run(0, 0.4, 0, 0, 0, 0, new Date().toISOString()); }

  // realized imbalance series
  const imbRows = db.prepare("SELECT ts_utc, value FROM series WHERE series='damas_est_sys_imbalance'").all();
  const imb = new Map(imbRows.map((r) => [r.ts_utc, r.value]));
  const imbTs = imbRows.map((r) => r.ts_utc).sort();
  const lastKnownImb = (atMs) => { // last imbalance with ts_utc end <= at - lag (publication realism)
    const cutoff = new Date(atMs - IMB_LAG_MIN * 60000).toISOString();
    let v = null; for (const t of imbTs) { if (t <= cutoff) v = imb.get(t); else break; } return v;
  };
  // PI snapshots grouped per delivery interval
  const snaps = db.prepare('SELECT ts_utc, isp, commercial, pulled_at FROM xb_pi_snap ORDER BY pulled_at').all();
  const byTs = new Map();
  for (const s of snaps) { if (!byTs.has(s.ts_utc)) byTs.set(s.ts_utc, []); byTs.get(s.ts_utc).push(s); }
  const done = new Set(db.prepare('SELECT ts_utc FROM pi_learn_log').all().map((r) => r.ts_utc));

  const ins = db.prepare('INSERT OR IGNORE INTO pi_learn_log VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  let learned = 0;
  // learnable = settled intervals (realized present) that have pre-A snapshots and weren't learned yet
  const candidates = [...byTs.keys()].filter((ts) => imb.has(ts) && !done.has(ts)).sort();
  // one transaction: keeps the logged samples and the SGD weight state in lockstep (no half-applied learning if it dies mid-loop)
  db.exec('BEGIN');
  for (const ts of candidates) {
    const T = new Date(ts).getTime();
    const A = T - LEAD_MIN * 60000;
    const pre = byTs.get(ts).filter((s) => new Date(s.pulled_at).getTime() <= A);
    if (pre.length < 1) continue;                 // need at least one snapshot before the decision time
    const persist = lastKnownImb(A);
    if (persist === null) continue;
    const piMove = pre[pre.length - 1].commercial - pre[0].commercial;
    const x1 = Math.tanh(persist / 150), x2 = Math.tanh(piMove / 100);
    const p = sig(st.w0 + st.w1 * x1 + st.w2 * x2);
    const yImb = imb.get(ts); const y = yImb > 0 ? 1 : 0; const pred = p > 0.5 ? 1 : 0;
    // SGD update
    const g = p - y;
    st.w0 -= LR * g; st.w1 -= LR * (g * x1 + L2 * st.w1); st.w2 -= LR * (g * x2 + L2 * st.w2);
    st.n++; if (pred === y) st.model_ok++; if ((persist > 0 ? 1 : 0) === y) st.persist_ok++;
    const big = Math.abs(yImb) > 50 ? 1 : 0;
    ins.run(ts, pre[0].isp, persist, piMove, p, pred, y, pred === y ? 1 : 0, (persist > 0 ? 1 : 0) === y ? 1 : 0, big, new Date().toISOString());
    learned++;
  }
  db.prepare('UPDATE pi_learn_state SET w0=?,w1=?,w2=?,n=?,model_ok=?,persist_ok=?,updated=? WHERE id=1').run(st.w0, st.w1, st.w2, st.n, st.model_ok, st.persist_ok, new Date().toISOString());
  db.exec('COMMIT');

  const acc = (ok) => st.n ? (ok / st.n * 100).toFixed(1) + '%' : '-';
  console.log(`pi_learn: +${learned} new (total n=${st.n})`);
  console.log(`  weights: w0=${st.w0.toFixed(3)} w1(persist)=${st.w1.toFixed(3)} w2(PI-move)=${st.w2.toFixed(3)}`);
  console.log(`  model(persist+PI) acc=${acc(st.model_ok)}  vs  persist-alone=${acc(st.persist_ok)}`);
} catch (e) { console.error('[pi_learn]', e); process.exit(1); } // mirror log_xb_pi.js: log + non-zero exit; scheduler isolates & logs it
