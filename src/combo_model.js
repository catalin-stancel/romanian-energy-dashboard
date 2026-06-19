// combo_model.js — LIVE-callable version of the validated xb_combo colour model.
// Feature logic is ported verbatim from tool/xb_combo.js (the proven research artifact) —
// KEEP THE TWO IN SYNC. Two models share one feature builder:
//   • SHORT (groups A-F, LEAD=75min freeze): the intraday model (+2.4pt vs persistence,
//     +2.5 on confident+big). Usable only where the persistence anchor (T-105min) is already
//     settled — i.e. the next ~hour of upcoming intervals → drives PI-live scoring.
//   • FWD   (groups B,C,D,E, forward-only): the D-1 model (+5.2 vs climatology). No persistence,
//     so it works for tomorrow's intervals → drives the PZU shadow signal.
// Used by combo_score.js for live (paper) scoring only — it NEVER drives real positions.
// Self-test: `node tool/combo_model.js` trains both and prints in-sample/holdout accuracy
// (should land near the xb_combo walk-forward figures ~65% short / ~60% fwd).
const { roDateIsp } = require('./db');

const PUB_LAG = 30, WIN_FROM = 33, WIN_TO = 92, MIN = 60000, ISP_MS = 15 * MIN;
const LEAD_SHORT = 75;

const GROUPS = {
  A: ['persist_sign', 'persist_mag'],
  B: ['isp_n', 'tod_sin', 'tod_cos', 'dow_sin', 'dow_cos', 'mon_sin', 'mon_cos'],
  C: ['sol_fc', 'wind_fc'],
  D: ['load_fc', 'gen_fc', 'net_pos', 'net_xb', 'plan_bal', 'commit_stress'],
  E: ['da_price'],
  F: ['load_dev', 'gen_dev', 'xb_dev'],
};
// LIVE short model = A,B,C,D,E. Group F (dev regime) is DROPPED on purpose: it needs load_actual/
// gen_actual AT the anchor (T-105min), but ENTSO-E actuals lag more than the imbalance, so F is
// unservable at the freeze in real time — and the xb_combo ablation showed F is inert (−0.2pt). So
// dropping it costs ~nothing and makes the model live-computable. (Persistence A uses the settled
// imbalance at the anchor, which IS available with the normal ~30-min lag.)
const FEAT_SHORT = [...GROUPS.A, ...GROUPS.B, ...GROUPS.C, ...GROUPS.D, ...GROUPS.E];
const FEAT_FWD = [...GROUPS.B, ...GROUPS.C, ...GROUPS.D, ...GROUPS.E];

// ---- load all series into ts->value maps (first_value for forward/anti-leak, value for settled) ----
function load(db) {
  const serFirst = (name) => new Map(db.prepare('SELECT ts_utc, first_value v FROM series WHERE series=? AND first_value IS NOT NULL').all(name).map((r) => [Date.parse(r.ts_utc), r.v]));
  const serVal = (name) => new Map(db.prepare('SELECT ts_utc, value v FROM series WHERE series=? AND value IS NOT NULL').all(name).map((r) => [Date.parse(r.ts_utc), r.v]));
  const imbRows = db.prepare("SELECT ts_utc, isp, value FROM series WHERE series='damas_est_sys_imbalance' AND value IS NOT NULL ORDER BY ts_utc").all();
  const ms = imbRows.map((r) => Date.parse(r.ts_utc));
  const N = ms.length;
  const latestLE = (t) => { let lo = 0, hi = N - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ms[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; };

  const loadFc = serFirst('load_fc_da'), genFc = serFirst('gen_fc_da'), netPos = serFirst('net_pos_da');
  const solFc = serFirst('ws_fc_da_solar'), windFc = serFirst('ws_fc_da_wind_onshore'), daPrice = serFirst('da_price');
  const schedOut = ['sched_RO_HU', 'sched_RO_BG', 'sched_RO_RS', 'sched_RO_UA', 'sched_RO_MD'].map(serFirst);
  const schedIn = ['sched_HU_RO', 'sched_BG_RO', 'sched_RS_RO', 'sched_UA_RO', 'sched_MD_RO'].map(serFirst);
  const loadAct = serVal('load_actual');
  const genActMaps = ['gen_actual_gas', 'gen_actual_lignite', 'gen_actual_hydro_reservoir', 'gen_actual_hydro_ror', 'gen_actual_nuclear', 'gen_actual_solar', 'gen_actual_wind_onshore', 'gen_actual_biomass'].map(serVal);

  const g = (map, t) => (map.has(t) ? map.get(t) : null);
  const netXB = (t) => { let o = 0, i = 0, any = false; for (const m of schedOut) { const v = g(m, t); if (v !== null) { o += v; any = true; } } for (const m of schedIn) { const v = g(m, t); if (v !== null) { i += v; any = true; } } return any ? o - i : null; };
  const sumGenAct = (t) => { let s = 0, any = false; for (const m of genActMaps) { const v = g(m, t); if (v !== null) { s += v; any = true; } } return any ? s : null; };

  return { imbRows, ms, N, latestLE, g, loadFc, genFc, netPos, solFc, windFc, daPrice, netXB, loadAct, sumGenAct };
}

// time / climatology features (pure)
function featTime(Tms, isp) {
  const th = (isp - 1) * 2 * Math.PI / 96;
  const d = new Date(Tms); const dow = d.getUTCDay(), mon = d.getUTCMonth();
  const dth = dow * 2 * Math.PI / 7, mth = mon * 2 * Math.PI / 12;
  return { isp_n: isp, tod_sin: Math.sin(th), tod_cos: Math.cos(th), dow_sin: Math.sin(dth), dow_cos: Math.cos(dth), mon_sin: Math.sin(mth), mon_cos: Math.cos(mth) };
}

// forward (day-ahead) features for interval T — null if any leg missing
function featForward(ctx, Tms, isp) {
  const { g, loadFc, genFc, netPos, solFc, windFc, daPrice, netXB } = ctx;
  const lf = g(loadFc, Tms), gf = g(genFc, Tms), np = g(netPos, Tms);
  const sf = g(solFc, Tms), wf = g(windFc, Tms), dp = g(daPrice, Tms), nxb = netXB(Tms);
  if (lf === null || gf === null || np === null || sf === null || wf === null || dp === null || nxb === null) return null;
  return {
    ...featTime(Tms, isp), sol_fc: sf, wind_fc: wf,
    load_fc: lf, gen_fc: gf, net_pos: np, net_xb: nxb,
    plan_bal: gf - lf - np, commit_stress: lf !== 0 ? np / lf : 0, da_price: dp,
  };
}

// SHORT-horizon features for interval T at LEAD: forward bundle (B,C,D,E) + persistence (A) taken
// at the settled anchor (T-LEAD-PUB_LAG). Returns { feat, persistSurplus, knownMag } or null.
// Group F is intentionally excluded (see FEAT_SHORT note) so this is computable live at the freeze.
function featShort(ctx, Tms, isp, LEAD = LEAD_SHORT) {
  const fwd = featForward(ctx, Tms, isp); if (!fwd) return null;
  const GAP = (LEAD + PUB_LAG) * MIN;
  const a = ctx.latestLE(Tms - GAP); if (a < 4) return null;
  const persist = ctx.imbRows[a].value;
  const feat = { persist_sign: persist > 0 ? 1 : -1, persist_mag: persist, ...fwd };
  return { feat, persistSurplus: persist > 0, knownMag: Math.abs(persist), anchorMs: ctx.ms[a] };
}

// ---- logistic (full-batch GD + L2, train-fold standardisation) — ported from xb_combo.js ----
function fit(rows, featList, { lr = 0.3, iters = 400, l2 = 1e-3 } = {}) {
  const D = featList.length, n = rows.length;
  const mean = new Array(D).fill(0), sd = new Array(D).fill(0);
  for (const r of rows) for (let k = 0; k < D; k++) mean[k] += r.feat[featList[k]];
  for (let k = 0; k < D; k++) mean[k] /= n;
  for (const r of rows) for (let k = 0; k < D; k++) sd[k] += (r.feat[featList[k]] - mean[k]) ** 2;
  for (let k = 0; k < D; k++) sd[k] = Math.sqrt(sd[k] / n) || 1;
  const Z = rows.map((r) => featList.map((f, k) => (r.feat[f] - mean[k]) / sd[k]));
  let w = new Array(D).fill(0), b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(D).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b; for (let k = 0; k < D; k++) z += w[k] * Z[i][k];
      const p = 1 / (1 + Math.exp(-z)); const e = p - rows[i].y;
      gb += e; for (let k = 0; k < D; k++) gw[k] += e * Z[i][k];
    }
    b -= lr * gb / n; for (let k = 0; k < D; k++) w[k] -= lr * (gw[k] / n + l2 * w[k]);
  }
  return { w, b, mean, sd, featList };
}
function prob(model, feat) { let z = model.b; for (let k = 0; k < model.featList.length; k++) z += model.w[k] * (feat[model.featList[k]] - model.mean[k]) / model.sd[k]; return 1 / (1 + Math.exp(-z)); }

// ---- build training rows over the SETTLED imbalance spine ----
function buildTraining(ctx, kind) {
  const rows = [];
  for (let i = 0; i < ctx.N; i++) {
    const T = ctx.imbRows[i]; if (T.isp < WIN_FROM || T.isp > WIN_TO) continue;
    const Tms = ctx.ms[i];
    if (kind === 'short') {
      const f = featShort(ctx, Tms, T.isp); if (!f) continue;
      rows.push({ feat: f.feat, y: T.value > 0 ? 1 : 0, persistSurplus: f.persistSurplus, t: Tms });
    } else {
      const feat = featForward(ctx, Tms, T.isp); if (!feat) continue;
      rows.push({ feat, y: T.value > 0 ? 1 : 0, t: Tms });
    }
  }
  return rows.sort((a, b) => a.t - b.t);
}

// train one model on ALL complete-case rows (the live model = trained on everything available)
function train(db, kind) {
  const ctx = load(db);
  const rows = buildTraining(ctx, kind);
  if (rows.length < 500) return null;
  const featList = kind === 'short' ? FEAT_SHORT : FEAT_FWD;
  const model = fit(rows, featList);
  model.kind = kind; model.featList = featList;
  model.n = rows.length;
  model.range = [new Date(rows[0].t).toISOString().slice(0, 10), new Date(rows[rows.length - 1].t).toISOString().slice(0, 10)];
  return { model, ctx, rows };
}

// enumerate upcoming in-window targets (rest of today + tomorrow), like predict.js
function upcomingTargets(nowMs) {
  const first = Math.ceil(nowMs / ISP_MS) * ISP_MS;
  const tomorrow = roDateIsp(new Date(nowMs + 86400000)).date;
  const out = [];
  for (let t = first; ; t += ISP_MS) {
    const ri = roDateIsp(new Date(t));
    if (ri.date > tomorrow) break;
    if (ri.isp >= WIN_FROM && ri.isp <= WIN_TO) out.push({ Tms: t, isp: ri.isp, date: ri.date });
  }
  return out;
}

module.exports = {
  load, train, buildTraining, fit, prob, featShort, featForward, upcomingTargets,
  FEAT_SHORT, FEAT_FWD, GROUPS, LEAD_SHORT, PUB_LAG, WIN_FROM, WIN_TO, MIN,
};

// ---- self-test: train both, report holdout accuracy vs persistence/majority ----
if (require.main === module) {
  const { openDb } = require('./db');
  const db = openDb();
  for (const kind of ['short', 'fwd']) {
    const t = train(db, kind);
    if (!t) { console.log(`${kind}: not enough data`); continue; }
    const { rows, model } = t;
    // simple time-ordered holdout: train on first 80%, test last 20% (sanity check vs walk-forward)
    const cut = Math.floor(rows.length * 0.8);
    const tr = rows.slice(0, cut), te = rows.slice(cut);
    const m = fit(tr, model.featList);
    let h = 0, ph = 0, mh = 0; const surplusShare = tr.reduce((s, r) => s + r.y, 0) / tr.length; const majSurplus = surplusShare >= 0.5;
    for (const r of te) {
      const p = prob(m, r.feat);
      if ((p > 0.5) === (r.y === 1)) h++;
      if (kind === 'short' && r.persistSurplus === (r.y === 1)) ph++;
      if (majSurplus === (r.y === 1)) mh++;
    }
    const pct = (x) => (x / te.length * 100).toFixed(1);
    console.log(`${kind.toUpperCase()} model: n=${model.n} range ${model.range.join('..')}  | holdout(20%) acc=${pct(h)}%` +
      (kind === 'short' ? ` vs persist ${pct(ph)}%` : ` vs majority ${pct(mh)}%`) + `  (n_test=${te.length})`);
  }
}
