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
  } catch { /* table/column may be missing */ }
  if (sf) {
    if (sf.sold != null && sf.plan != null) f.devNow = sf.plan - sf.sold;
    if (f.dev == null && f.devNow != null) f.dev = f.devNow;
    if (sf.storage != null) f.storage = sf.storage;
    if (sf.hydro != null) f.hydro = sf.hydro;
  }
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
  return f;
}

// Score the deficit evidence (+) vs surplus evidence (−) and turn it into an action. forNext = the interval after the live one:
// same live state (persistence 0.93–0.97) but its own scheduled mFRR and a higher bar.
function decide(f, forNext) {
  const why = []; let s = 0;
  const dev = f.devTrue != null ? f.devTrue : f.dev, devNow = f.devNowTrue != null ? f.devNowTrue : f.devNow;
  if (dev == null) return { action: 'HOLD', strength: null, score: 0, reasons: ['no live deviation reading'] };
  const r0 = (v) => Math.round(v);
  const act = f.mUpL - f.mDnL; if (act) why.push(`pre-activation read: sold−plan ${f.dev >= 0 ? '+' : ''}${r0(f.dev)} MW − mFRR ${act >= 0 ? '+' : ''}${r0(act)} MW activated = ${dev >= 0 ? '+' : ''}${r0(dev)} MW (Real − True X-B)`);
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
  const mUp = forNext ? f.mUpN : f.mUpL, mDn = forNext ? f.mDnN : f.mDnL;
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
  return { action, strength, score: s, reasons: why };
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
  const ins = db.prepare('INSERT OR REPLACE INTO bat_action(date_ro, isp, target, at, action, strength, score, dev, storage, st_slope, hydro, m_sch, last_price, reasons) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [target, o] of [['cur', pd.cur], ['next', pd.next]]) {
      if (!o) continue; const f = o.f, d = o.d;
      ins.run(date, o.isp, target, at, d.action, d.strength, d.score, f.dev, f.storage, f.stSlope, f.hydro, target === 'cur' ? f.mUpL - f.mDnL : f.mUpN - f.mDnN, f.lastPrice, d.reasons.join(' | '));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { ensureTable, features, decide, pageData, logDue };
