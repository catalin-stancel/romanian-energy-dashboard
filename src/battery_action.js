'use strict';
// Battery ACTION for passive balancing (user 2026-10-28): what to do with the batteries in the CURRENT interval and
// the NEXT one (the only horizons where the live boundary state is a reading, not a forecast). Direction-only rule:
// never act against the visible sign — discharge into a deficit, charge into a surplus, hold when the sign is flat.
// REAL DATA ONLY: live sold−plan deviation (Transelectrica feed), battery discharge level + its slope, the battery
// behaviour mode, scheduled mFRR (published up to ~7 min before the interval), the last published imbalance price
// and aFRR activation, hydro headroom. No model estimate. Every reading is logged (bat_action) so the decision
// record exists: timestamp, inputs, action — the ANRE answer if passive balancing is ever questioned.
//
// Evidence behind the thresholds (October 2026 studies, see memory project_bal_column / project_pi_plan_v3):
//   price = VWAP of activation in the direction of the FINAL imbalance; aFRR-up spikes 3,000–6,500, scheduled mFRR ~1,750;
//   scheduled mFRR-down ≥300 MW → median price −100, 60% negative (≥450 → 73%); hydro <400 MW doubles the surplus tail;
//   sold−plan persistence inside/next interval 0.93–0.97; unintended deviation p1/p99 −253/+215 MW.

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS bat_action (
    date_ro TEXT, isp INTEGER, target TEXT, at TEXT, action TEXT, strength TEXT, score INTEGER,
    dev REAL, storage REAL, st_slope REAL, hydro REAL, m_sch REAL, last_price REAL, reasons TEXT,
    PRIMARY KEY (date_ro, isp, target, at)
  ); CREATE INDEX IF NOT EXISTS ix_bat_di ON bat_action(date_ro, isp);`);
  for (const c of ['exp_price REAL', 'bar REAL']) { try { db.exec('ALTER TABLE bat_action ADD COLUMN ' + c); } catch { /* exists */ } }
}

// ---------------------------------------------------------------------------------------------------------------------
// EXPORT ECONOMICS (user 2026-11-02): "getting surplus power at 1,300 and selling at 1,800 in a deficit doesn't work — the
// power also carries network charges; export must go where aFRR activations make the price". No config: the bar follows the
// price the column's own CHARGE calls actually paid (last 7 days, settled), the expected price comes from the history of
// intervals that looked like this one at decision time. Until the VPP state of charge + PI prices are wired in (planned),
// two assumptions stand in for the contract: ~400 RON/MWh withdrawal network charges and 88% round-trip efficiency.
const NET_T = 400, ETA = 0.88, MARGIN = 200;
const mpB = (v) => v == null ? 'na' : v < 1500 ? 'lo' : v < 2000 ? 'mid' : v < 2500 ? 'hi' : 'vhi';
const stB = (v) => v == null ? 'na' : v < 50 ? 'low' : v < 150 ? 'mid' : 'high';
const hrB = (isp) => { const h = Math.floor((isp - 1) / 4); return h < 7 ? 'night' : h < 17 ? 'day' : 'eve'; };
const lpB = (v) => v == null ? 'na' : v < 300 ? 'floor' : v < 600 ? 'lo' : v < 1000 ? 'mid' : 'hi';
const mgB = (v) => v == null ? 'na' : v < 80 ? 'mild' : v < 150 ? 'mid' : 'big';
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * f)] : null; };
let _tbl = null, _tblAt = 0;
// price table: settled intervals of the last 60 days keyed by what was visible at decision time. Rebuilt hourly (one scan).
function priceTable(db) {
  if (_tbl && Date.now() - _tblAt < 3600000) return _tbl;
  const T = { def: new Map(), sur: new Map(), surAll: [] };
  try {
    const since = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const rows = db.prepare(`SELECT p.date_ro d, p.isp, p.value price, si.value si, mp.value mp1, lp.value lp2, ms.value ms0, st.st
      FROM series p JOIN series si ON si.series='damas_est_sys_imbalance' AND si.date_ro=p.date_ro AND si.isp=p.isp
      LEFT JOIN series qu ON qu.series='damas_qup' AND qu.date_ro=p.date_ro AND qu.isp=p.isp
      LEFT JOIN series qd ON qd.series='damas_qdn' AND qd.date_ro=p.date_ro AND qd.isp=p.isp
      LEFT JOIN series mp ON mp.series='damas_mp_afrr_up' AND mp.date_ro=p.date_ro AND mp.isp=p.isp-1
      LEFT JOIN series lp ON lp.series='damas_est_price_pos' AND lp.date_ro=p.date_ro AND lp.isp=p.isp-2
      LEFT JOIN series ms ON ms.series='damas_mp_mfrr_up_sch' AND ms.date_ro=p.date_ro AND ms.isp=p.isp
      LEFT JOIN (SELECT date_ro, isp, AVG(storage) st FROM sen_live WHERE date_ro>=? AND storage IS NOT NULL GROUP BY date_ro, isp) st ON st.date_ro=p.date_ro AND st.isp=p.isp
      WHERE p.series='damas_est_price_pos' AND p.date_ro>=? AND NOT (qu.value=0 AND qd.value=0)`).all(since, since);
    const add = (m, k, v) => { (m.get(k) || m.set(k, []).get(k)).push(v); };
    for (const r of rows) {
      if (r.si < 0) { const k1 = mpB(refPrice(r.ms0, r.mp1, r.lp2)), k2 = stB(r.st), k3 = hrB(r.isp); add(T.def, k1 + '|' + k2 + '|' + k3, r.price); add(T.def, k1 + '|' + k2, r.price); add(T.def, k1, r.price); add(T.def, '*', r.price); }
      else if (r.si > 0) { const k1 = lpB(r.lp2), k2 = mgB(r.si); add(T.sur, k1 + '|' + k2, r.price); add(T.sur, k2, r.price); add(T.sur, '*', r.price); T.surAll.push(r.price); }
    }
  } catch { /* history missing */ }
  _tbl = T; _tblAt = Date.now(); return T;
}
const refPrice = (...v) => { const a = v.filter((x) => x != null && x > 0); return a.length ? Math.max(...a) : null; };
const pick = (m, keys) => { for (const k of keys) { const a = m.get(k); if (a && a.length >= 12) return { key: k, n: a.length, p25: q(a, 0.25), med: q(a, 0.5), p75: q(a, 0.75) }; } return null; };
// expected DEFICIT price for this interval given the live evidence; expected SURPLUS price (what a charge would pay)
function expectDeficit(T, f, forNext) {
  const sch = forNext ? f.schPriceN : f.schPriceL;
  const ref = refPrice(sch, f.lastMpAge != null && f.lastMpAge <= 2 ? f.lastMp : null, f.lastPriceAge != null && f.lastPriceAge <= 3 ? f.lastPrice : null);
  const k1 = mpB(ref), k2 = stB(f.storage), k3 = hrB(f.isp + (forNext ? 1 : 0));
  const e = pick(T.def, [k1 + '|' + k2 + '|' + k3, k1 + '|' + k2, k1, '*']); if (!e) return null;
  e.ref = ref; e.sch = sch > 0 ? sch : null;
  if (e.sch) { const floor = 0.9 * e.sch; e.p25 = Math.max(e.p25, floor); e.med = Math.max(e.med, floor); e.p75 = Math.max(e.p75, floor); } // scheduled mFRR-up marginal = floor
  return e;
}
function expectSurplus(T, f, dev) { const k1 = lpB(f.lastPrice), k2 = mgB(dev == null ? null : Math.abs(dev)); return pick(T.sur, [k1 + '|' + k2, k2, '*']); }
let _cb = null, _cbAt = 0;
// charge basis = what the column's own CHARGE calls paid (settled, last 7 days); the export bar grosses it up by the assumed
// network charges and losses. Falls back to the 60-day median surplus price when the log is thin.
function costBasis(db, T) {
  if (_cb && Date.now() - _cbAt < 600000) return _cb;
  let paid = [];
  try {
    const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    paid = db.prepare(`SELECT p.value price FROM (SELECT date_ro, isp, MAX(at) at FROM bat_action WHERE target='cur' AND date_ro>=? GROUP BY date_ro, isp) l
      JOIN bat_action b ON b.date_ro=l.date_ro AND b.isp=l.isp AND b.target='cur' AND b.at=l.at AND b.action='CHARGE'
      JOIN series p ON p.series='damas_est_price_pos' AND p.date_ro=b.date_ro AND p.isp=b.isp
      LEFT JOIN series qu ON qu.series='damas_qup' AND qu.date_ro=b.date_ro AND qu.isp=b.isp
      LEFT JOIN series qd ON qd.series='damas_qdn' AND qd.date_ro=b.date_ro AND qd.isp=b.isp
      WHERE NOT (qu.value=0 AND qd.value=0)`).all(since).map((r) => r.price);
  } catch { /* table missing */ }
  const surMed = q(T.surAll, 0.5) ?? 450;
  const basis = paid.length >= 5 ? q(paid, 0.5) : surMed;
  _cb = { basis: Math.round(basis), nPaid: paid.length, bar: Math.round((basis + NET_T) / ETA + MARGIN), chargeBar: Math.round(surMed + 150), surMed: Math.round(surMed) };
  _cbAt = Date.now(); return _cb;
}

// Live features for interval `isp` of `date`. sf = latest liveSenFilter() reading (may be null). pub = bal_model pageData().pub
// (per-isp aFRR/mFRR energy, scheduled mFRR included forward). prices = Map isp → published imbalance price (RON/MWh).
function features(db, date, isp, sf, stMode, pub, prices, nowIsp) {
  const f = { isp, dev: null, devNow: null, storage: null, stSlope: null, hydro: null, stMode: stMode ? stMode.mode : null, mUpL: 0, mDnL: 0, mUpN: 0, mDnN: 0, lastPrice: null, lastPriceAge: null, lastAfrr: null, n: 0 };
  try {
    const r = db.prepare('SELECT AVG(plan - sold) dev, COUNT(*) n FROM sen_live WHERE date_ro=? AND isp=? AND sold IS NOT NULL AND plan IS NOT NULL').get(date, isp);
    if (r && r.n) { f.dev = r.dev; f.n = r.n; }
    // battery slope: mean of the last 3 min vs the 3 min before (MW per 3 min; + = ramping up = deficit response)
    const t = Date.now();
    const s1 = db.prepare('SELECT AVG(storage) v FROM sen_live WHERE ts_ms>? AND storage IS NOT NULL').get(t - 180000);
    const s0 = db.prepare('SELECT AVG(storage) v FROM sen_live WHERE ts_ms>? AND ts_ms<=? AND storage IS NOT NULL').get(t - 360000, t - 180000);
    if (s1 && s0 && s1.v != null && s0.v != null) f.stSlope = s1.v - s0.v;
    // wind fleet change over the last 10 min (MW): a drop matching a running mFRR-down = the activation landing on wind farms
    const w1 = db.prepare('SELECT AVG(wind) v FROM sen_live WHERE ts_ms>? AND wind IS NOT NULL').get(t - 120000);
    const w0 = db.prepare('SELECT AVG(wind) v FROM sen_live WHERE ts_ms>? AND ts_ms<=? AND wind IS NOT NULL').get(t - 720000, t - 600000);
    f.wind10 = w1 && w0 && w1.v != null && w0.v != null ? w1.v - w0.v : null;
  } catch { /* table/column may be missing */ }
  if (sf) {
    if (sf.sold != null && sf.plan != null) f.devNow = sf.plan - sf.sold;
    if (f.dev == null && f.devNow != null) f.dev = f.devNow;
    if (sf.storage != null) f.storage = sf.storage;
    if (sf.hydro != null) f.hydro = sf.hydro;
  }
  try {
    const np = db.prepare("SELECT isp, value FROM series WHERE date_ro=? AND series='damas_notif_prod' AND isp IN (?,?,?)").all(date, isp - 1, isp, isp + 1);
    const m = new Map(np.map((r) => [r.isp, r.value]));
    f.planStepL = m.has(isp) && m.has(isp - 1) ? m.get(isp) - m.get(isp - 1) : null;
    f.planStepN = m.has(isp + 1) && m.has(isp) ? m.get(isp + 1) - m.get(isp) : null;
  } catch { f.planStepL = f.planStepN = null; }
  const mw = (o, k) => (o && o[k] ? 4 * o[k] : 0);
  const pL = pub && pub.get(isp), pN = pub && pub.get(isp + 1);
  f.mUpL = mw(pL, 'mU'); f.mDnL = mw(pL, 'mD'); f.mUpN = mw(pN, 'mU'); f.mDnN = mw(pN, 'mD');
  // PRE-ACTIVATION deviation = Real − True X-B: once Transelectrica activates mFRR the flow is pulled back toward schedule, so
  // sold−plan alone understates the deficit (2026-10-28 11:30: dev −1 MW with 350 MW mFRR up scheduled and price 3,700). Same
  // identity as the True Cross border column. aFRR is only known afterwards, so this still understates an aFRR-covered deficit.
  f.devTrue = f.dev == null ? null : f.dev - (f.mUpL - f.mDnL);
  f.devNowTrue = f.devNow == null ? null : f.devNow - (f.mUpL - f.mDnL);
  if (prices) for (let k = (nowIsp || isp) - 1; k >= Math.max(1, (nowIsp || isp) - 8); k--) { const p = prices.get(k); if (p != null) { f.lastPrice = p; f.lastPriceAge = (nowIsp || isp) - k; break; } }
  if (pub) for (let k = (nowIsp || isp) - 1; k >= Math.max(1, (nowIsp || isp) - 6); k--) { const p = pub.get(k); if (p && p.any) { f.lastAfrr = 4 * (p.aU - p.aD); break; } }
  f.lastMp = null; f.lastMpAge = null;
  try { // aFRR-up marginal price of the latest settled interval (marginalPricesOverview lands ~3 min after the interval ends)
    const r = db.prepare("SELECT isp, value FROM series WHERE date_ro=? AND series='damas_mp_afrr_up' AND isp<? AND isp>=? AND value>0 ORDER BY isp DESC LIMIT 1").get(date, nowIsp || isp, (nowIsp || isp) - 4);
    if (r) { f.lastMp = r.value; f.lastMpAge = (nowIsp || isp) - r.isp; }
  } catch { /* series missing */ }
  f.schPriceL = f.schPriceN = null;
  try { // scheduled mFRR-up marginal price (marginalPricesOverview, mFRR_Up_Scheduled) — known at/just before the interval start
    for (const r of db.prepare("SELECT isp, value FROM series WHERE date_ro=? AND series='damas_mp_mfrr_up_sch' AND isp IN (?,?) AND value>0").all(date, isp, isp + 1)) { if (r.isp === isp) f.schPriceL = r.value; else f.schPriceN = r.value; }
  } catch { /* series missing */ }
  try { const T = priceTable(db); f.expDefL = expectDeficit(T, f, false); f.expDefN = expectDeficit(T, f, true); f.expSur = expectSurplus(T, f, f.devTrue != null ? f.devTrue : f.dev); f.econ = costBasis(db, T); } catch { f.expDefL = f.expDefN = f.expSur = f.econ = null; }
  return f;
}

// Score the deficit evidence (+) vs surplus evidence (−) and turn it into an action. forNext = the interval after the live one:
// same live state (persistence 0.93–0.97) but its own scheduled mFRR and a higher bar.
function decide(f, forNext) {
  const why = []; let s = 0;
  let dev = f.devTrue != null ? f.devTrue : f.dev, devNow = f.devNowTrue != null ? f.devNowTrue : f.devNow;
  if (dev == null) return { action: 'HOLD', strength: null, score: 0, reasons: ['no live deviation reading'] };
  const r0 = (v) => Math.round(v);
  // OVERSHOOT override (2026-10-29 04:30 CET): 220 MW mFRR-down scheduled against a fading +100 MW surplus → the system went −200 MW
  // and the batteries ramped 1→111 MW (aFRR up). The final direction was deficit, price 2,727 (aFRR-up VWAP), the down activation
  // excluded as counter-activation. So: raw deficit + batteries ramping while mFRR-down runs = deficit, no correction.
  const ramping = f.stMode === 'bal' || (f.stSlope != null && f.stSlope >= 40) || (f.storage != null && f.storage >= 80 && f.stSlope != null && f.stSlope > 0);
  let overshoot = false;
  // curtailment-induced deficit (user 2026-10-29): wind fell ≈ the scheduled down amount → the TSO curtailed wind against a surplus that
  // had already gone; the system crosses into deficit and aFRR up (batteries) is paid to fix it. Artificial, but it sets the price.
  const curtailed = f.mDnL > 0 && f.wind10 != null && f.wind10 <= -150 && f.dev != null && f.dev < 0;
  if (curtailed) why.push(`wind fleet ${r0(f.wind10)} MW in 10 min while ${r0(f.mDnL)} MW mFRR-down runs — curtailment-induced deficit (artificial, operator overshoot)`);
  if (f.mDnL > 0 && f.dev != null && f.dev <= -80 && (ramping || curtailed || f.dev <= -150)) { /* a raw deficit of 150+ MW while down-regulation runs is itself the overshoot tell */ dev = f.dev; devNow = f.devNow; overshoot = true; why.push(`OVERSHOOT: ${r0(f.mDnL)} MW mFRR-down running but the raw deviation is ${r0(f.dev)} MW and the batteries are ramping (aFRR up firing) — final direction deficit, no activation correction`); }
  const act = f.mUpL - f.mDnL; if (act && !overshoot) why.push(`pre-activation read: sold−plan ${f.dev >= 0 ? '+' : ''}${r0(f.dev)} MW − mFRR ${act >= 0 ? '+' : ''}${r0(act)} MW activated = ${dev >= 0 ? '+' : ''}${r0(dev)} MW (Real − True X-B)`);
  if (dev <= -150) { s += 2; why.push(`live deficit ${r0(-dev)} MW`); }
  else if (dev <= -80) { s += 1; why.push(`mild live deficit ${r0(-dev)} MW`); }
  else if (dev >= 150) { s -= 2; why.push(`live surplus +${r0(dev)} MW`); }
  else if (dev >= 80) { s -= 1; why.push(`mild live surplus +${r0(dev)} MW`); }
  else why.push(`deviation flat (${dev >= 0 ? '+' : ''}${r0(dev)} MW) — flip zone`);
  if (devNow != null && Math.abs(devNow - dev) >= 100) {
    if (devNow < dev && devNow < -80) { s += 1; why.push(`latest reading deepening the deficit (${r0(devNow)} MW now)`); }
    else if (devNow > dev && devNow > 80) { s -= 1; why.push(`latest reading deepening the surplus (+${r0(devNow)} MW now)`); }
  }
  if (f.stMode === 'bal' || (f.stSlope != null && f.stSlope >= 40)) { s += 1; why.push(f.stMode === 'bal' ? 'batteries in balancing mode (output tracking the import over plan = aFRR up)' : `batteries ramping +${r0(f.stSlope)} MW in 3 min`); }
  else if (f.stSlope != null && f.stSlope <= -40 && f.storage != null && f.storage < 60) { s -= 1; why.push(`batteries backing off (${r0(f.stSlope)} MW in 3 min) — aFRR up ending`); }
  let mUp = forNext ? f.mUpN : f.mUpL, mDn = forNext ? f.mDnN : f.mDnL;
  // plan-driven dispatch step of the target interval (notified production vs the previous interval): ≥300 MW votes with the sign it creates
  const ps = forNext ? f.planStepN : f.planStepL;
  if (ps != null && ps >= 300 && dev >= 40) { s -= 1; why.push(`notified production steps +${r0(ps)} MW ${forNext ? 'next interval' : 'this interval'} (plan dispatch) — surplus pressure`); }
  else if (ps != null && ps <= -300 && dev <= -40) { s += 1; why.push(`notified production steps ${r0(ps)} MW ${forNext ? 'next interval' : 'this interval'} (plan dispatch) — deficit pressure`); }
  else if (ps != null && Math.abs(ps) >= 300) why.push(`notified production steps ${ps >= 0 ? '+' : ''}${r0(ps)} MW ${forNext ? 'next interval' : 'this interval'} — watch for a flip`);
  if (overshoot) mDn = 0; // a counter-activation has no price effect — it must not vote
  if (curtailed && !forNext) { s += 1; }
  if (mUp > 0) { s += 1; why.push(`mFRR up ${r0(mUp)} MW scheduled ${forNext ? 'for the next interval' : 'this interval'} (price pinned ≥ ~1,750 while the deficit lasts)`); }
  if (mDn >= 300) { s -= 2; why.push(`mFRR down ${r0(mDn)} MW scheduled ${forNext ? 'for the next interval' : 'this interval'} — ${mDn >= 450 ? '73%' : '60%'} negative price historically`); }
  else if (mDn > 0) { s -= 1; why.push(`mFRR down ${r0(mDn)} MW scheduled ${forNext ? 'for the next interval' : 'this interval'}`); }
  // published price / aFRR are 2+ intervals old: persistence evidence, so they only vote WITH the live sign (a visible flip beats them;
  // 2026-10-28 13:15 RO: +105 MW live surplus was cancelled by a 2,085 RON price from the deficit two intervals earlier → wrong STOP)
  const liveDef = dev <= -40, liveSur = dev >= 40;
  if (f.lastPrice != null && f.lastPriceAge <= 5) {
    if (f.lastPrice > 1500 && liveDef) { s += 1; why.push(`last published price ${r0(f.lastPrice)} RON (${f.lastPriceAge} ISP ago) confirms`); }
    else if (f.lastPrice < 100 && liveSur) { s -= 1; why.push(`last published price ${r0(f.lastPrice)} RON (${f.lastPriceAge} ISP ago) confirms`); }
    else if ((f.lastPrice > 1500 && liveSur) || (f.lastPrice < 100 && liveDef)) why.push(`last published price ${r0(f.lastPrice)} RON is from the other regime (${f.lastPriceAge} ISP ago) — ignored, live sign wins`);
  }
  if (f.lastAfrr != null) {
    if (f.lastAfrr > 150 && liveDef) { s += 1; why.push(`last published aFRR up ${r0(f.lastAfrr)} MW confirms`); }
    else if (f.lastAfrr < -150 && liveSur) { s -= 1; why.push(`last published aFRR down ${r0(-f.lastAfrr)} MW confirms`); }
  }
  if (f.hydro != null && f.hydro < 400 && dev > 40) { s -= 1; why.push(`hydro at floor (${r0(f.hydro)} MW) — no cheap down-regulation left, crash tail doubles`); }
  const strongAt = forNext ? 4 : 3, leanAt = forNext ? 2 : 1;
  let action = 'HOLD', strength = null;
  if (s >= leanAt) { action = 'DISCHARGE'; strength = s >= strongAt ? 'strong' : 'lean'; }
  else if (s <= -leanAt) { action = 'CHARGE'; strength = s <= -strongAt ? 'strong' : 'lean'; }
  // direction-only guard: never act against the visible sign (that is the one pattern that reads as an intentional imbalance)
  if (action === 'DISCHARGE' && dev > -40) { action = 'HOLD'; strength = null; why.push('→ HOLD: deficit evidence but the live sign is not in deficit'); }
  if (action === 'CHARGE' && dev < 40 && mDn < 300) { action = 'HOLD'; strength = null; why.push('→ HOLD: surplus evidence but the live sign is not in surplus'); }
  // EXPORT BAR (2026-11-02): a deficit only pays when the aFRR merit order is pushed — the expected price of intervals that looked
  // like this one (last aFRR-up marginal, battery fleet output, hour) must clear the charge basis grossed up for network + losses.
  let expPrice = null, bar = null;
  const ex = forNext ? f.expDefN : f.expDefL;
  if (action === 'DISCHARGE' && ex && f.econ) {
    expPrice = ex.med; bar = f.econ.bar;
    const tag = `expected price ~${r0(ex.med)} RON (p25 ${r0(ex.p25)}, ${ex.n} similar intervals${ex.sch ? ', scheduled mFRR-up marginal ' + r0(ex.sch) + ' = floor' : ex.ref ? ', last marginal/price ' + r0(ex.ref) : ''}) vs export bar ${bar} (charge basis ${f.econ.basis} from ${f.econ.nPaid} charge calls + ~${NET_T} network, η ${ETA})`;
    if (ex.med < bar) { action = 'HOLD'; strength = null; why.push('→ HOLD: deficit, but ' + tag + ' — re-export would not cover the cost'); }
    else if (strength === 'strong' && ex.p25 < bar) { strength = 'lean'; why.push('→ lean: ' + tag + ' — a quarter of similar intervals settle under the bar'); }
    else why.push(tag);
  }
  // CHARGE BAR: only buy when this surplus is expected to settle near the floor; a mild surplus at ~800 cannot be re-exported profitably
  if (action === 'CHARGE' && f.expSur && f.econ) {
    expPrice = f.expSur.med; bar = f.econ.chargeBar;
    const tag = `expected surplus price ~${r0(f.expSur.med)} RON (p75 ${r0(f.expSur.p75)}, ${f.expSur.n} similar intervals) vs charge bar ${bar} (60-day surplus median ${f.econ.surMed} + 150)`;
    if (f.expSur.med > bar) { action = 'HOLD'; strength = null; why.push('→ HOLD: surplus, but ' + tag + ' — too expensive to re-export after network charges'); }
    else if (strength === 'strong' && f.expSur.p75 > bar) { strength = 'lean'; why.push('→ lean: ' + tag); }
    else why.push(tag);
  }
  return { action, strength, score: s, reasons: why, expPrice, bar };
  // MAGNITUDE cap (review 2026-11-02 of 465 settled calls): when the raw and the pre-activation deviations disagree in sign, the
  // pre-activation read wins 16/21 — but ONLY when it is the larger of the two. In every case where the raw deviation matched or
  // exceeded it, the interval settled within 10 MW of zero or went the raw way (2026-10-30 ISP 69/70: raw +274 vs −126 after 400 MW
  // mFRR up → settled +49 surplus, strong DISCHARGE lost 600 RON/MWh). Keep the direction, never call it strong.
  if (strength === 'strong' && !overshoot && f.dev != null && Math.sign(f.dev) !== Math.sign(dev) && Math.abs(f.dev) >= 40 && Math.abs(f.dev) >= Math.abs(dev)) {
    strength = 'lean'; why.push(`→ lean only: the raw deviation (${f.dev >= 0 ? '+' : ''}${r0(f.dev)} MW) is as large as the pre-activation read — the activation may be overshooting`);
  }
}

// Everything the Predict page needs: decisions for the live interval + the next one, and the last logged action per settled interval.
function pageData(db, date, nowInfo, liveIsp, sf, stModes, pub, prices) {
  const out = { cur: null, next: null, log: new Map() };
  if (nowInfo.date === date && liveIsp > 0) {
    const f = features(db, date, liveIsp, sf, stModes && stModes.get(liveIsp), pub, prices, nowInfo.isp);
    out.cur = { isp: liveIsp, f, d: decide(f, false) };
    out.next = { isp: liveIsp + 1, f, d: decide(f, true) };
  }
  try {
    for (const r of db.prepare("SELECT isp, target, action, strength, score, at FROM bat_action WHERE date_ro=? AND target='cur' ORDER BY at").all(date)) out.log.set(r.isp, r); // last write wins
  } catch { /* table missing */ }
  return out;
}

// 60-s logger (NOT from a request handler): record the live decision for the current + next interval.
function logDue(db, date, nowInfo, liveIsp, sf, stModes, pub, prices) {
  if (nowInfo.date !== date || !(liveIsp > 0)) return;
  const pd = pageData(db, date, nowInfo, liveIsp, sf, stModes, pub, prices);
  const at = new Date().toISOString().slice(0, 16) + 'Z'; // minute resolution → one row per minute per target
  const ins = db.prepare('INSERT OR REPLACE INTO bat_action(date_ro, isp, target, at, action, strength, score, dev, storage, st_slope, hydro, m_sch, last_price, reasons, exp_price, bar) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [target, o] of [['cur', pd.cur], ['next', pd.next]]) {
      if (!o) continue; const f = o.f, d = o.d;
      ins.run(date, o.isp, target, at, d.action, d.strength, d.score, f.dev, f.storage, f.stSlope, f.hydro, target === 'cur' ? f.mUpL - f.mDnL : f.mUpN - f.mDnN, f.lastPrice, d.reasons.join(' | '), d.expPrice ?? null, d.bar ?? null);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { ensureTable, features, decide, pageData, logDue, priceTable, costBasis };
