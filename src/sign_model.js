// Servable LIVE SIGN model: P(surplus) for an upcoming interval.
// Validated in tool/predict_sign.js + tool/revalidate_signals.js (publication-safe, per-month blocked CV).
// Trained on the FULL settled-imbalance history, POOLED across leads (one model serves every horizon via `lead`).
// Features (all no-lookahead at prediction time A = T_start − lead, settled reads gated at A − PUB_LAG):
//   persist        last settled imbalance (the anchor)
//   |persist|      magnitude ("did a big one just happen")
//   pi_move        net cross-border repositioning so far (0 where no PI snapshot — imputed; weight learned on the live tail)
//   |pi_move|, pi_move×|persist|/100   the big-trade / panic-after-big-imbalance interaction
//   fracsurp       fraction of the last 48 settled intervals that were SURPLUS (slow surplus/deficit REGIME base-rate)
//   netting        damas_netting_export − import (IGCC cross-border imbalance netting; orthogonal grid-state read)
//   sin,cos isp    time-of-day
//   lead           minutes to delivery
// fracsurp + netting added 2026-06-26 after publication-safe re-validation: +3.0pt acc / +0.006–0.008 Brier over the
// full live baseline, calibration-positive every held-out month. (act_reserve was REJECTED — its raw +4.5pt was a
// freshness-advantage mirage that collapsed to noise when read on equal footing with persist.)
const PUB_LAG = 30, MIN = 60000, WIN_FROM = 33, WIN_TO = 93; // 33=07:00, 93=22:00 (work window incl. the 22:00 row)
const LEADS = [15, 30, 45, 60, 75, 90, 120];
const FRAC_W = 48; // ~12h surplus-fraction window
const CAP = 9000;  // build training rows from the last CAP in-window settled intervals (the validated window; full history still used for lookback reads). Keeps the hourly retrain fast.

//   notifbal       notified plan mismatch = notif_prod − notif_cons − net_export_schedule (forward schedules,
//                  known at A; centered by standardization). +0.9pt/+0.3pt-blocked-CV, Brier-neutral (2026-06-29).
//                  The only feature reading the production/cross-border PLAN — fills the model's flip blind spot.
const NB_IDX = 7; // index of notifbal in the featvec array (for mean-imputation when absent)
const featvec = (persist, pi_move, fracsurp, netting, notifbal, isp, lead) => [
  persist, Math.abs(persist), pi_move, Math.abs(pi_move), pi_move * Math.abs(persist) / 100,
  fracsurp, netting, notifbal,
  Math.sin(2 * Math.PI * isp / 96), Math.cos(2 * Math.PI * isp / 96), Math.min(150, Math.max(10, lead)),
];

// last value of a settled series with ts ≤ cutoff (binary search over an ascending ts array)
const leLE = (arr, t) => { let lo = 0, hi = arr.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; };

function train(db) {
  const imb = db.prepare("SELECT ts_utc, value FROM series WHERE series='damas_est_sys_imbalance' AND value IS NOT NULL ORDER BY ts_utc").all();
  const ims = imb.map((r) => Date.parse(r.ts_utc));
  const persistAt = (A) => { const j = leLE(ims, A - PUB_LAG * MIN); return j < 0 ? null : imb[j].value; };
  const fracsurpAt = (A) => { const j = leLE(ims, A - PUB_LAG * MIN); if (j < 0) return null; const lo = Math.max(0, j - FRAC_W + 1); let s = 0, n = 0; for (let i = lo; i <= j; i++) { n++; if (imb[i].value > 0) s++; } return n ? s / n : null; };
  const ser = (name) => { const rows = db.prepare('SELECT ts_utc, value FROM series WHERE series=? AND value IS NOT NULL ORDER BY ts_utc').all(name); const ts = rows.map((r) => Date.parse(r.ts_utc)); return (A) => { const j = leLE(ts, A - PUB_LAG * MIN); return j < 0 ? null : rows[j].value; }; };
  const expAt = ser('damas_netting_export'), impAt = ser('damas_netting_import');
  const nettingAt = (A) => { const e = expAt(A), i = impAt(A); return e == null || i == null ? 0 : e - i; };
  // notif_bal = notif_prod − notif_cons − net_export, read at the DELIVERY interval's own ts (forward schedules,
  // known at A; revised <5 MW so effectively gate-safe). exact-ts maps (no publication lag — these aren't settled reads).
  const exactSer = (name) => { const m = new Map(); for (const r of db.prepare('SELECT ts_utc, value FROM series WHERE series=? AND value IS NOT NULL').all(name)) m.set(Date.parse(r.ts_utc), r.value); return (t) => (m.has(t) ? m.get(t) : null); };
  const npX = exactSer('damas_notif_prod'), ncX = exactSer('damas_notif_cons');
  const EXP = ['sched_RO_HU', 'sched_RO_BG', 'sched_RO_RS', 'sched_RO_UA', 'sched_RO_MD'].map(exactSer);
  const IMP = ['sched_HU_RO', 'sched_BG_RO', 'sched_RS_RO', 'sched_UA_RO', 'sched_MD_RO'].map(exactSer);
  const notifBalAt = (t) => { const P = npX(t), C = ncX(t); if (P == null || C == null) return null; let e = 0, i = 0, a = false; for (const f of EXP) { const v = f(t); if (v != null) { e += v; a = true; } } for (const f of IMP) { const v = f(t); if (v != null) { i += v; a = true; } } return a ? P - C - (e - i) : null; };
  // PI snapshots (commercial repositioning), indexed by interval ts — present only on the recent tail
  const piByMs = new Map();
  for (const s of db.prepare('SELECT ts_utc, isp, pulled_at, commercial FROM xb_pi_snap ORDER BY ts_utc, pulled_at').all()) {
    const t = Date.parse(s.ts_utc); (piByMs.get(t) || piByMs.set(t, []).get(t)).push({ p: Date.parse(s.pulled_at), c: s.commercial });
  }
  const roDateIsp = require('./db').roDateIsp;

  // in-window settled intervals; train on the LAST CAP of them (full imb still used for lookback reads)
  const winIdx = [];
  for (let bi = 0; bi < imb.length; bi++) { const isp = roDateIsp(new Date(ims[bi])).isp; if (isp >= WIN_FROM && isp <= WIN_TO) winIdx.push({ bi, isp }); }
  const X = [], Y = [];
  for (const { bi, isp } of winIdx.slice(-CAP)) {
    const Tms = ims[bi]; const y = imb[bi].value > 0 ? 1 : 0; const frames = piByMs.get(Tms);
    const notifbal = notifBalAt(Tms); if (notifbal === null) continue; // skip rows without the schedule (≈none in the recent CAP window)
    for (const lead of LEADS) {
      const A = Tms - lead * MIN;
      const persist = persistAt(A); if (persist === null) continue;
      const fracsurp = fracsurpAt(A); if (fracsurp === null) continue;
      let pi_move = 0; if (frames) { const pre = frames.filter((f) => f.p <= A); if (pre.length >= 2) pi_move = pre[pre.length - 1].c - pre[0].c; }
      X.push(featvec(persist, pi_move, fracsurp, nettingAt(A), notifbal, isp, lead)); Y.push(y);
    }
  }
  if (X.length < 100) throw new Error(`sign_model: only ${X.length} training rows`);
  const d = X[0].length, mean = new Array(d).fill(0), sd = new Array(d).fill(1);
  for (let k = 0; k < d; k++) { let m = 0; for (const x of X) m += x[k]; m /= X.length; let v = 0; for (const x of X) v += (x[k] - m) ** 2; mean[k] = m; sd[k] = Math.sqrt(v / X.length) || 1; }
  const Z = X.map((x) => [1, ...x.map((v, k) => (v - mean[k]) / sd[k])]);
  const w = new Array(d + 1).fill(0), l2 = 1.0;
  for (let it = 0; it < 600; it++) { const g = new Array(d + 1).fill(0);
    for (let i = 0; i < Z.length; i++) { let z = 0; for (let k = 0; k <= d; k++) z += w[k] * Z[i][k]; const p = 1 / (1 + Math.exp(-z)); const e = p - Y[i]; for (let k = 0; k <= d; k++) g[k] += e * Z[i][k]; }
    for (let k = 0; k <= d; k++) w[k] -= 0.3 * (g[k] / Z.length + (k ? l2 * w[k] / Z.length : 0)); }
  return { w, mean, sd, n: X.length, trainedAt: Date.now() };
}

// P(surplus) for an upcoming interval given the live factors.
//   persist  = last settled imbalance; pi_move = net commercial repositioning so far (0 if none);
//   fracsurp = fraction of the last 48 settled intervals that were surplus; netting = export−import;
//   lead     = minutes to delivery.
function prob(model, persist, pi_move, fracsurp, netting, notifbal, isp, lead) {
  if (notifbal == null) notifbal = model.mean[NB_IDX]; // absent schedule → impute training mean (standardizes to 0 = neutral)
  const f = featvec(persist, pi_move, fracsurp, netting, notifbal, isp, lead);
  const x = [1, ...f.map((v, k) => (v - model.mean[k]) / model.sd[k])];
  let z = 0; for (let k = 0; k < x.length; k++) z += model.w[k] * x[k];
  return 1 / (1 + Math.exp(-z));
}

module.exports = { train, prob, featvec, PUB_LAG, MIN, WIN_FROM, WIN_TO, FRAC_W };
