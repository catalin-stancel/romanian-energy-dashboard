// Balancing-activation estimate ("Bal") + current-interval imbalance nowcast, from the live Transelectrica feed.
//
// WHY: Real X-B − Notif X-B is the imbalance AFTER the operator has activated aFRR/mFRR (hydro, batteries, gas ramp
// back toward schedule), so in a big deficit the Δ understates what is happening. True X-B = Notif X-B + Bal restores
// the pre-activation picture: Real − True ≈ imbalance before activation. Measured 2026-10-22 on 9.2k live-era ISPs:
//   activation (MW)  ~ consDev + prodDev + gas + storage + dev + mFRR-scheduled flags → R² 0.51 all / 0.58 deficits, MAE ~80-105 MW
//   imbalance (MWh)  ~ same inputs → R² 0.70 all / 0.85 deficits, MAE ~21-25 MWh (dev = sold − plan carries most of it)
// Published truth (DAMAS activatedBalancingEnergyOverview) lands ~16 min after the interval ends → settled rows show it,
// with the live estimate frozen at interval end (bal_lock) in brackets so the error stays visible, like the Wind column.
// Sign: Bal > 0 = upward activation (deficit), < 0 = downward. Netting (IGCC) is NOT in Bal — it already crosses the
// border physically and so is already inside Real X-B.
const { roDateIsp } = require('./db');

const NAMES = ['one', 'consDev', 'prodDev', 'gas', 'storage', 'dev', 'mUpSch', 'mDnSch'];
const SCALE = [1, 100, 100, 100, 100, 100, 1, 1];

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS bal_lock (date_ro TEXT, isp INTEGER, act_est REAL, imb_est REAL, n INTEGER, locked_at TEXT, PRIMARY KEY(date_ro, isp));`);
}

const seriesMap = (db, name, from) => new Map(db.prepare("SELECT date_ro||'|'||isp k, value FROM series WHERE series=? AND date_ro>=?").all(name, from).map((r) => [r.k, r.value]));

function featVec(f) {
  const x = [1, f.consDev, f.prodDev, f.gas, f.storage, f.dev, f.mUpSch ? 1 : 0, f.mDnSch ? 1 : 0];
  return x.map((v, i) => (v == null ? 0 : v) / SCALE[i]);
}

// OLS with a tiny ridge on the non-intercept terms (normal equations; k = 8 → trivial)
function ols(y, X, lam = 1e-3) {
  const k = X[0].length; const A = Array.from({ length: k }, () => Array(k).fill(0)), b = Array(k).fill(0);
  for (let i = 0; i < y.length; i++) for (let p = 0; p < k; p++) { b[p] += X[i][p] * y[i]; for (let q = 0; q < k; q++) A[p][q] += X[i][p] * X[i][q]; }
  for (let p = 1; p < k; p++) A[p][p] += lam * y.length;
  for (let p = 0; p < k; p++) { let mx = p; for (let r = p + 1; r < k; r++) if (Math.abs(A[r][p]) > Math.abs(A[mx][p])) mx = r; [A[p], A[mx]] = [A[mx], A[p]]; [b[p], b[mx]] = [b[mx], b[p]]; for (let r = 0; r < k; r++) if (r !== p) { const f = A[r][p] / A[p][p]; for (let q = p; q < k; q++) A[r][q] -= f * A[p][q]; b[r] -= f * b[p]; } }
  return b.map((v, p) => v / A[p][p]);
}
const dot = (b, x) => x.reduce((s, v, i) => s + v * b[i], 0);

function train(db) {
  const from = '2026-06-19'; // live-era (sen_live) start
  const aU = seriesMap(db, 'damas_abe_afrr_up', from), aD = seriesMap(db, 'damas_abe_afrr_down', from), mU = seriesMap(db, 'damas_abe_mfrr_up', from), mD = seriesMap(db, 'damas_abe_mfrr_down', from);
  const imb = seriesMap(db, 'damas_est_sys_imbalance', from), nC = seriesMap(db, 'damas_notif_cons', from), nP = seriesMap(db, 'damas_notif_prod', from);
  const sU = seriesMap(db, 'damas_mp_mfrr_up_sch', from), sD = seriesMap(db, 'damas_mp_mfrr_down_sch', from);
  const sen = db.prepare(`SELECT date_ro, isp, AVG(cons) cons, AVG(prod) prod, AVG(gas) gas, AVG(storage) st, AVG(sold-plan) dev, COUNT(*) n FROM sen_live WHERE date_ro>=? AND cons IS NOT NULL AND prod IS NOT NULL AND gas IS NOT NULL AND sold IS NOT NULL AND plan IS NOT NULL GROUP BY date_ro, isp HAVING n>=3`).all(from);
  const yA = [], yI = [], X = [];
  for (const r of sen) {
    const k = r.date_ro + '|' + r.isp; if (!aU.has(k) || !aD.has(k) || !imb.has(k) || !nC.has(k) || !nP.has(k)) continue;
    const act = 4 * ((aU.get(k) ?? 0) - (aD.get(k) ?? 0) + (mU.get(k) ?? 0) - (mD.get(k) ?? 0)); // MWh/ISP → MW
    yA.push(act); yI.push(imb.get(k));
    X.push(featVec({ consDev: r.cons - nC.get(k), prodDev: r.prod - nP.get(k), gas: r.gas, storage: r.st ?? 0, dev: r.dev, mUpSch: (sU.get(k) ?? 0) > 0, mDnSch: (sD.get(k) ?? 0) > 0 }));
  }
  if (X.length < 500) throw new Error('bal_model: only ' + X.length + ' training rows');
  const bA = ols(yA, X), bI = ols(yI, X);
  const score = (y, b) => { const m = y.reduce((s, v) => s + v, 0) / y.length; let ss = 0, st = 0, mae = 0; for (let i = 0; i < y.length; i++) { const e = y[i] - dot(b, X[i]); ss += e * e; st += (y[i] - m) ** 2; mae += Math.abs(e); } return { r2: +(1 - ss / st).toFixed(3), mae: +(mae / y.length).toFixed(1), sd: +Math.sqrt(ss / y.length).toFixed(1) }; };
  return { v: 1, kind: 'bal', names: NAMES, scale: SCALE, bAct: bA, bImb: bI, n: X.length, act: score(yA, bA), imb: score(yI, bI), trainedAt: new Date().toISOString() };
}

function estimate(model, f) { if (!model || !model.bAct) return null; const x = featVec(f); return { act: dot(model.bAct, x), imb: dot(model.bImb, x) }; }

// live aggregate of one interval (so far, or complete) + the notified plan → feature object (null when the feed has no rows)
function intervalFeat(db, date, isp) {
  const r = db.prepare('SELECT AVG(cons) cons, AVG(prod) prod, AVG(gas) gas, AVG(storage) st, AVG(sold-plan) dev, COUNT(*) n FROM sen_live WHERE date_ro=? AND isp=? AND cons IS NOT NULL AND prod IS NOT NULL AND gas IS NOT NULL AND sold IS NOT NULL AND plan IS NOT NULL').get(date, isp);
  if (!r || !r.n) return null;
  const s = db.prepare('SELECT series, value FROM series WHERE date_ro=? AND isp=? AND series IN (?,?,?,?)').all(date, isp, 'damas_notif_cons', 'damas_notif_prod', 'damas_mp_mfrr_up_sch', 'damas_mp_mfrr_down_sch');
  const v = Object.fromEntries(s.map((x) => [x.series, x.value]));
  if (v.damas_notif_cons == null || v.damas_notif_prod == null) return null;
  return { n: r.n, consDev: r.cons - v.damas_notif_cons, prodDev: r.prod - v.damas_notif_prod, gas: r.gas, storage: r.st ?? 0, dev: r.dev, mUpSch: (v.damas_mp_mfrr_up_sch ?? 0) > 0, mDnSch: (v.damas_mp_mfrr_down_sch ?? 0) > 0 };
}

// Freeze the live estimate for intervals that just ENDED (full-interval aggregate) so settled rows can show (estimate) vs published.
function lockDue(db, dayTimestamps, model) {
  if (!model) return;
  const ni = roDateIsp(new Date()); const nowMs = Date.now();
  const has = db.prepare('SELECT 1 FROM bal_lock WHERE date_ro=? AND isp=?'), ins = db.prepare('INSERT OR IGNORE INTO bal_lock(date_ro, isp, act_est, imb_est, n, locked_at) VALUES (?,?,?,?,?,?)');
  for (const { isp, ts } of dayTimestamps(ni.date)) {
    const end = new Date(ts).getTime() + 900000; if (end > nowMs || end < nowMs - 3 * 3600000) continue; // ended, within the last 3 h
    if (has.get(ni.date, isp)) continue;
    const f = intervalFeat(db, ni.date, isp); if (!f || f.n < 3) continue;
    const e = estimate(model, f); if (!e) continue;
    ins.run(ni.date, isp, +e.act.toFixed(1), +e.imb.toFixed(1), f.n, new Date().toISOString());
  }
}

// Everything the Predict page needs for one date.
function pageData(db, date, nowInfo, liveIsp, model) {
  const pub = new Map(), lock = new Map(), sch = new Map();
  try {
    for (const r of db.prepare("SELECT isp, series, value FROM series WHERE date_ro=? AND series IN ('damas_abe_afrr_up','damas_abe_afrr_down','damas_abe_mfrr_up','damas_abe_mfrr_down','damas_netting_import','damas_netting_export','damas_mp_mfrr_up_sch','damas_mp_mfrr_down_sch')").all(date)) {
      if (r.series === 'damas_mp_mfrr_up_sch') { (sch.get(r.isp) || sch.set(r.isp, {}).get(r.isp)).up = r.value; continue; }
      if (r.series === 'damas_mp_mfrr_down_sch') { (sch.get(r.isp) || sch.set(r.isp, {}).get(r.isp)).dn = r.value; continue; }
      const o = pub.get(r.isp) || pub.set(r.isp, { aU: 0, aD: 0, mU: 0, mD: 0, nI: 0, nE: 0, any: false }).get(r.isp);
      const key = { damas_abe_afrr_up: 'aU', damas_abe_afrr_down: 'aD', damas_abe_mfrr_up: 'mU', damas_abe_mfrr_down: 'mD', damas_netting_import: 'nI', damas_netting_export: 'nE' }[r.series];
      o[key] = r.value; if (key[0] !== 'n' && r.value) o.any = true;
    }
    for (const r of db.prepare('SELECT isp, act_est, imb_est, n FROM bal_lock WHERE date_ro=?').all(date)) lock.set(r.isp, r);
  } catch { /* tables may be missing on a fresh db */ }
  for (const [, o] of pub) { o.act = 4 * (o.aU - o.aD + o.mU - o.mD); o.net = 4 * (o.nI - o.nE); }
  let live = null;
  if (model && nowInfo.date === date && liveIsp > 0) { const f = intervalFeat(db, date, liveIsp); if (f) { const e = estimate(model, f); if (e) live = { ...e, n: f.n, f }; } }
  return { pub, lock, sch, live, model };
}

module.exports = { ensureTable, train, estimate, intervalFeat, lockDue, pageData, NAMES };
