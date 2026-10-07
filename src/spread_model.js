// spread_model.js — E[settlement spread] model: Ê[S] where S = P_imb(sign-aligned) − PZU [RON/MWh].
// A surplus position earns +S per MWh, a deficit position −S (settlement = qty·(imb−PZU)).
// v1 of the price/profit project (see price-profit-model memory; v0 lab: price_model_v0.js).
//
// PUBLICATION HONESTY (measured 2026-08-19 on first_seen, Jul-Aug 2026):
//   imbalance 25m · netting 20m · imb prices / load_actual / wind / abe ~40m · gen_actual_solar p75 325m ·
//   damas_qup p50 345m (DROPPED — v0 used it at 2h = lookahead).
// The 40-min series mean an anchor is only visible at the 75-min gate from lead ≥ 9 ISPs → train leads start at 10.
// solErr is read one extra hour back (anchor−4) for its fat lag tail. Training and serving share the same
// feature builder so there is no train/serve skew; serving reads whatever is ACTUALLY published (reality
// enforces the lag) and computes the true lead to the anchor, clamped into the trained range.
const path = require('path');

const LEADS = [10, 12, 16, 20, 26, 34, 44, 56]; // ISPs between anchor and target (2.5h .. 14h)
const LEAD_MIN = 10, LEAD_MAX = 56;
const WIN_FROM = 33, WIN_TO = 93; // trading window (trading-constraints)
const NAMES = ['lead', 'spread@A', 'spreadK', 'imb@A', 'imbK', 'sign(imb)', '|imb|', 'netting', 'abeUp', 'abeDn',
  'loadErr', 'loadErrK', 'winErr', 'solErr', 'solF', 'winF', 'loadF', 'weekday', 'sin1', 'cos1', 'sin2', 'cos2', 'pzu'];
const NF = NAMES.length;

function eurRon() { for (const f of ['../config.json', './config.json']) { try { const v = require(f).eur_ron; if (v) return v; } catch { /* next */ } } return 5.24; } // cloud keeps config.json in the repo root, local in tool/

// ---------- shared feature builder ----------
// anchor = {s, imb, net, abeUp, abeDn, loadErr, winErr, solErr}; target = {tsMs, isp, solF, winF, loadF, pzu, wd}
function featVec(lead, a, t) {
  const k = 10 / Math.max(lead, 1); // decay: anchor info fades with lead; k=1 at the closest trained lead
  const ang = 2 * Math.PI * (t.isp - 1) / 96;
  return [
    lead,
    a.s, a.s * k,
    a.imb, a.imb * k,
    Math.sign(a.imb), Math.abs(a.imb),
    a.net, a.abeUp, a.abeDn,
    a.loadErr, a.loadErr * k,
    a.winErr, a.solErr,
    t.solF / 1000, t.winF / 1000, t.loadF / 1000,
    t.wd,
    Math.sin(ang), Math.cos(ang), Math.sin(2 * ang), Math.cos(2 * ang),
    t.pzu / 100,
  ];
}

function loadRaw(db) {
  const S = (name) => {
    const m = new Map();
    for (const r of db.prepare('SELECT ts_utc, value FROM series WHERE series=?').all(name)) m.set(r.ts_utc, r.value);
    return m;
  };
  const EUR = eurRon();
  const def = S('imb_price_deficit'), exc = S('imb_price_excedent'), pz = S('pzu_ron'), da = S('da_price');
  const imb = S('damas_est_sys_imbalance'), netx = S('damas_netting_export'), netm = S('damas_netting_import');
  const abeU = S('abe_price_up'), abeD = S('abe_price_down');
  const loadF = S('load_fc_da'), loadA = S('load_actual');
  const solF = S('ws_fc_da_solar'), solA = S('gen_actual_solar');
  const winF = S('ws_fc_da_wind_onshore'), winA = S('gen_actual_wind_onshore');
  const base = db.prepare("SELECT ts_utc, date_ro, isp FROM series WHERE series='imb_price_deficit' ORDER BY ts_utc").all();
  const raw = [];
  for (const b of base) {
    const pzu = pz.get(b.ts_utc) ?? (da.has(b.ts_utc) ? da.get(b.ts_utc) * EUR : null);
    const d = def.get(b.ts_utc), e = exc.get(b.ts_utc), i = imb.get(b.ts_utc);
    if (pzu == null || d == null || e == null || i == null) continue;
    raw.push({
      ts: Date.parse(b.ts_utc), date: b.date_ro, isp: b.isp, month: b.date_ro.slice(0, 7),
      pzu, imb: i, s: (i < 0 ? d : e) - pzu,
      net: netx.has(b.ts_utc) && netm.has(b.ts_utc) ? netx.get(b.ts_utc) - netm.get(b.ts_utc) : null,
      abeUp: abeU.get(b.ts_utc) ?? null, abeDn: abeD.get(b.ts_utc) ?? null,
      loadErr: loadA.has(b.ts_utc) && loadF.has(b.ts_utc) ? loadA.get(b.ts_utc) - loadF.get(b.ts_utc) : null,
      winErr: winA.has(b.ts_utc) && winF.has(b.ts_utc) ? winA.get(b.ts_utc) - winF.get(b.ts_utc) : null,
      solErr: solA.has(b.ts_utc) && solF.has(b.ts_utc) ? solA.get(b.ts_utc) - solF.get(b.ts_utc) : null,
      solF: solF.get(b.ts_utc) ?? null, winF: winF.get(b.ts_utc) ?? null, loadF: loadF.get(b.ts_utc) ?? null,
    });
  }
  raw.sort((x, y) => x.ts - y.ts);
  return raw;
}

function buildRows(raw) {
  const idx = new Map(raw.map((r, i) => [r.ts, i]));
  const rows = [];
  for (const r of raw) {
    if (r.isp < WIN_FROM || r.isp > WIN_TO) continue;
    if ([r.solF, r.winF, r.loadF].some((v) => v == null)) continue;
    const wd = ![0, 6].includes(new Date(r.ts).getUTCDay()) ? 1 : 0;
    for (const L of LEADS) {
      const j = idx.get(r.ts - L * 900000);
      if (j == null) continue;
      const a = raw[j];
      const jSol = idx.get(r.ts - (L + 4) * 900000); // solar actual read 1h further back (fat publication tail)
      const solErr = jSol != null ? raw[jSol].solErr : null;
      if ([a.s, a.imb, a.net, a.abeUp, a.abeDn, a.loadErr, a.winErr, solErr].some((v) => v == null)) continue;
      rows.push({
        y: r.s, month: r.month, lead: L,
        x: featVec(L, { s: a.s, imb: a.imb, net: a.net, abeUp: a.abeUp, abeDn: a.abeDn, loadErr: a.loadErr, winErr: a.winErr, solErr },
          { tsMs: r.ts, isp: r.isp, solF: r.solF, winF: r.winF, loadF: r.loadF, pzu: r.pzu, wd }),
      });
    }
  }
  return rows;
}

// ---------- ridge fit (normal equations, standardized on the given rows) ----------
function fit(rows, lambda = 3) {
  const n = rows.length;
  const mu = new Array(NF).fill(0), sd = new Array(NF).fill(0);
  for (const r of rows) for (let k = 0; k < NF; k++) mu[k] += r.x[k] / n;
  for (const r of rows) for (let k = 0; k < NF; k++) sd[k] += (r.x[k] - mu[k]) ** 2 / n;
  for (let k = 0; k < NF; k++) sd[k] = Math.sqrt(sd[k]) || 1;
  const D = NF + 1;
  const A = Array.from({ length: D }, () => new Array(D).fill(0));
  const b = new Array(D).fill(0);
  const z = new Array(D);
  for (const r of rows) {
    for (let k = 0; k < NF; k++) z[k] = (r.x[k] - mu[k]) / sd[k];
    z[NF] = 1;
    for (let i = 0; i < D; i++) { b[i] += z[i] * r.y; const zi = z[i]; const Ai = A[i]; for (let j = i; j < D; j++) Ai[j] += zi * z[j]; }
  }
  for (let i = 0; i < D; i++) for (let j = 0; j < i; j++) A[i][j] = A[j][i];
  for (let i = 0; i < NF; i++) A[i][i] += lambda * n / 1000;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < D; c++) {
    let piv = c; for (let r2 = c + 1; r2 < D; r2++) if (Math.abs(M[r2][c]) > Math.abs(M[piv][c])) piv = r2;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r2 = 0; r2 < D; r2++) { if (r2 === c || M[c][c] === 0) continue; const f = M[r2][c] / M[c][c]; for (let c2 = c; c2 <= D; c2++) M[r2][c2] -= f * M[c][c2]; }
  }
  const w = M.map((row, i) => row[D] / (row[i] || 1));
  return { w, mu, sd };
}

function predictOne(model, x) {
  let s = model.w[NF];
  for (let k = 0; k < NF; k++) s += model.w[k] * (x[k] - model.mu[k]) / model.sd[k];
  return s;
}

// ---------- public: train (cached by train_models.js / loadModel) ----------
function train(db) {
  const rows = buildRows(loadRaw(db));
  if (rows.length < 5000) throw new Error('spread train: only ' + rows.length + ' rows');
  const m = fit(rows);
  return { v: 1, kind: 'spread', ...m, names: NAMES, nrows: rows.length, leadMin: LEAD_MIN, leadMax: LEAD_MAX, trainedAt: new Date().toISOString() };
}

// ---------- public: live forecast for a date ----------
// Returns { anchorTs, rows: Map(isp -> { es, pzu, lead }) } for intervals STARTING at/after fromMs.
function forecastDay(db, model, date, fromMs) {
  const EUR = eurRon();
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch { return null; } };
  // anchor = latest interval whose spread is actually computable from PUBLISHED data (reality enforces lags)
  const A = one(`SELECT d.ts_utc ts, d.value def, e.value exc, i.value imb,
      COALESCE(p.value, da.value * ?) pzu
    FROM series d
    JOIN series e ON e.series='imb_price_excedent' AND e.ts_utc=d.ts_utc
    JOIN series i ON i.series='damas_est_sys_imbalance' AND i.ts_utc=d.ts_utc
    LEFT JOIN series p ON p.series='pzu_ron' AND p.ts_utc=d.ts_utc
    LEFT JOIN series da ON da.series='da_price' AND da.ts_utc=d.ts_utc
    WHERE d.series='imb_price_deficit' AND COALESCE(p.value, da.value) IS NOT NULL
    ORDER BY d.ts_utc DESC LIMIT 1`, EUR);
  if (!A) return null;
  const Ams = Date.parse(A.ts);
  const latest = (series, cutIso) => { const r = one("SELECT value FROM series WHERE series=? AND ts_utc<=? AND value IS NOT NULL ORDER BY ts_utc DESC LIMIT 1", series, cutIso); return r ? r.value : null; };
  const pairLatest = (sa, sf, cutIso) => {
    const r = one(`SELECT a.value - f.value v FROM series a JOIN series f ON f.series=? AND f.ts_utc=a.ts_utc
      WHERE a.series=? AND a.ts_utc<=? AND a.value IS NOT NULL AND f.value IS NOT NULL ORDER BY a.ts_utc DESC LIMIT 1`, sf, sa, cutIso);
    return r ? r.v : null;
  };
  const anchor = {
    s: (A.imb < 0 ? A.def : A.exc) - A.pzu, imb: A.imb,
    net: (latest('damas_netting_export', A.ts) ?? 0) - (latest('damas_netting_import', A.ts) ?? 0),
    abeUp: latest('abe_price_up', A.ts), abeDn: latest('abe_price_down', A.ts),
    loadErr: pairLatest('load_actual', 'load_fc_da', A.ts),
    winErr: pairLatest('gen_actual_wind_onshore', 'ws_fc_da_wind_onshore', A.ts),
    solErr: pairLatest('gen_actual_solar', 'ws_fc_da_solar', new Date(Ams - 4 * 900000).toISOString()),
  };
  if ([anchor.abeUp, anchor.abeDn, anchor.loadErr, anchor.winErr, anchor.solErr].some((v) => v == null)) return null;
  const mp = (series) => { const m = new Map(); try { for (const r of db.prepare('SELECT isp, ts_utc, value FROM series WHERE series=? AND date_ro=? AND value IS NOT NULL').all(series, date)) m.set(r.isp, { ts: Date.parse(r.ts_utc), v: r.value }); } catch { /* absent */ } return m; };
  const solF = mp('ws_fc_da_solar'), winF = mp('ws_fc_da_wind_onshore'), loadF = mp('load_fc_da');
  const pzuM = mp('pzu_ron'), daM = mp('da_price');
  const out = new Map();
  for (const [isp, sf] of solF) {
    if (isp < WIN_FROM || isp > WIN_TO) continue;
    if (sf.ts < (fromMs ?? 0)) continue;
    const wf = winF.get(isp), lf = loadF.get(isp);
    const pzu = pzuM.get(isp) ? pzuM.get(isp).v : (daM.get(isp) ? daM.get(isp).v * EUR : null);
    if (!wf || !lf || pzu == null) continue;
    const leadRaw = Math.round((sf.ts - Ams) / 900000);
    if (leadRaw < 1) continue; // anchor at/after target — settled territory
    const lead = Math.max(LEAD_MIN, Math.min(LEAD_MAX, leadRaw));
    const wd = ![0, 6].includes(new Date(sf.ts).getUTCDay()) ? 1 : 0;
    const x = featVec(lead, anchor, { tsMs: sf.ts, isp, solF: sf.v, winF: wf.v, loadF: lf.v, pzu, wd });
    out.set(isp, { es: predictOne(model, x), pzu, lead: leadRaw });
  }
  return { anchorTs: A.ts, rows: out };
}

module.exports = { train, forecastDay, predictOne, featVec, NAMES, LEAD_MIN, LEAD_MAX, WIN_FROM, WIN_TO };

// ---------- CV mode: node spread_model.js cv ----------
if (require.main === module && process.argv[2] === 'cv') {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(__dirname, 'market.db'), { readOnly: true });
  console.error('loading + building pooled-lead rows...');
  const rows = buildRows(loadRaw(db));
  const months = [...new Set(rows.map((r) => r.month))].sort();
  console.error(`rows ${rows.length} (targets x ${LEADS.length} leads), months ${months.length}`);
  const buckets = [[10, 12], [16, 20], [26, 34], [44, 56]];
  const pool = new Map(buckets.map((b) => [b.join('-'), []]));
  const monthly = [];
  for (const m of months) {
    const tr = rows.filter((r) => r.month !== m), te = rows.filter((r) => r.month === m);
    if (te.length < 1000) continue;
    const mod = fit(tr);
    let pnl = 0, n = 0;
    for (const r of te) {
      const p = predictOne(mod, r.x);
      for (const b of buckets) if (r.lead >= b[0] && r.lead <= b[1]) pool.get(b.join('-')).push([p, r.y]);
      if (r.lead <= 12) { pnl += Math.sign(p) * r.y; n++; }
    }
    monthly.push({ m, pnl: pnl / (n || 1), n });
  }
  console.log('\n== gate-relevant leads (10-12) per month: P&L RON/MWh of sign(Ê)');
  for (const r of monthly) console.log(`  ${r.m}  ${r.pnl.toFixed(0).padStart(6)}  (n=${r.n})`);
  const wtot = monthly.reduce((a, r) => a + r.n, 0);
  console.log(`  WEIGHTED ${monthly.reduce((a, r) => a + r.pnl * r.n, 0) / wtot | 0}   worst ${Math.min(...monthly.map((r) => r.pnl)).toFixed(0)}   losing months ${monthly.filter((r) => r.pnl < 0).length}/${monthly.length}`);
  console.log('\n== pooled OOS by lead bucket');
  for (const [k, ps] of pool) {
    if (ps.length < 500) continue;
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const mx = mean(ps.map((p) => p[0])), my = mean(ps.map((p) => p[1]));
    let xy = 0, xx = 0, yy = 0;
    for (const [px, py] of ps) { xy += (px - mx) * (py - my); xx += (px - mx) ** 2; yy += (py - my) ** 2; }
    const pnl = mean(ps.map(([px, py]) => Math.sign(px) * py));
    const hit = ps.filter(([px, py]) => Math.sign(px) === Math.sign(py)).length / ps.length;
    const sel = ps.filter(([px]) => Math.abs(px) > 200);
    console.log(`  lead ${k.padEnd(6)} corr ${(xy / Math.sqrt(xx * yy)).toFixed(3)}  P&L ${pnl.toFixed(0).padStart(5)}  hit ${(100 * hit).toFixed(1)}%  | >200: ${sel.length ? (mean(sel.map(([px, py]) => Math.sign(px) * py))).toFixed(0) : '-'} @ ${(100 * sel.length / ps.length).toFixed(0)}%  n=${ps.length}`);
  }
}
