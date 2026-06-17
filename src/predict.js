// Generate balancing predictions for all upcoming ISPs (rest of today + tomorrow),
// append them to the predictions table (append-only — full revision history is the
// learning record), and regenerate the dashboard.
//
//   node tool\predict.js        (scheduled every 15 min)
//
// Freeze rule: a prediction is ACTIONABLE only if issued >= 75 min before ISP start
// (PI gate closure H-1 + 15 min order-entry buffer). The "locked" prediction per ISP —
// the one decisions were made on — is the LAST actionable one; later revisions never
// replace it, they only appear as "live view".
const fs = require('fs');
const path = require('path');
const { openDb, roDateIsp } = require('./db');
const { buildContext, featuresFor, FEATURE_NAMES, MIN } = require('./features');

const FREEZE_MIN = 75;

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS predictions (
      run_at TEXT NOT NULL,
      ts_utc TEXT NOT NULL,
      date_ro TEXT NOT NULL,
      isp INTEGER NOT NULL,
      horizon_min REAL NOT NULL,
      actionable INTEGER NOT NULL,
      prob_long REAL,
      price_p10 REAL, price_p50 REAL, price_p90 REAL,
      model_version TEXT,
      realized_imb REAL, realized_price REAL,
      PRIMARY KEY (run_at, ts_utc)
    );
    CREATE INDEX IF NOT EXISTS idx_pred_target ON predictions (ts_utc, actionable, run_at);
  `);
  try { db.exec('ALTER TABLE predictions ADD COLUMN imb_p50 REAL'); } catch { /* exists */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS bets (
      run_at TEXT NOT NULL,
      ts_utc TEXT NOT NULL,
      date_ro TEXT NOT NULL,
      isp INTEGER NOT NULL,
      actionable INTEGER NOT NULL,
      dir TEXT NOT NULL,             -- 'surplus' (get paid imbalance price) | 'deficit' (pay it)
      qty REAL NOT NULL,             -- MWh, 0 = no bet
      prob REAL,                     -- model confidence in the chosen direction
      exp_price REAL,                -- predicted imbalance price p50
      da_ref REAL,                   -- PZU benchmark RON/MWh used for the edge
      da_ref_est INTEGER,            -- 1 = DA price not yet published, 7d same-ISP average used
      exp_edge REAL,                 -- RON/MWh vs PZU
      exp_revenue REAL,              -- qty * |edge|
      model_version TEXT,
      realized_price REAL, realized_revenue REAL,
      PRIMARY KEY (run_at, ts_utc)
    );
  `);
  try { db.exec('ALTER TABLE bets ADD COLUMN tail_loss REAL'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE bets ADD COLUMN reason TEXT'); } catch { /* exists */ }
  db.exec(`CREATE TABLE IF NOT EXISTS user_bets (
    date_ro TEXT NOT NULL, isp INTEGER NOT NULL, qty REAL NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (date_ro, isp))`);
  try { db.exec(`ALTER TABLE user_bets ADD COLUMN source TEXT DEFAULT 'manual'`); } catch { /* exists */ }
}

function loadConfig() {
  const defaults = {
    eur_ron: 5.24, trade_window_cet: [7, 22],
    max_mwh_per_isp: 2.5,
    min_mwh_per_isp: 2.0,  // always-bet policy (user 2026-06-11): every window interval gets >= this
    risk_aversion: 0.5,    // λ: still used to pick base vs max size
  };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8').replace(/^﻿/, '')) };
  } catch { return defaults; }
}

function predictOne(model, bucket, values) {
  const { w, mu, sd } = model.buckets[bucket];
  let z = 0;
  for (let j = 0; j < w.length; j++) {
    const v = Number.isFinite(values[j]) ? (values[j] - mu[j]) / sd[j] : 0;
    z += w[j] * v;
  }
  return 1 / (1 + Math.exp(-z));
}

function imbP50(model, isp, prob) {
  const block = Math.floor((isp - 1) / 12);
  const tS = model.imbQuantiles?.[block + '|1'];
  const tD = model.imbQuantiles?.[block + '|0'];
  if (!tS || !tD) return null;
  if (prob >= 0.65) return tS.p50;
  if (prob <= 0.35) return tD.p50;
  return prob * tS.p50 + (1 - prob) * tD.p50;
}

function priceQuantiles(model, isp, prob) {
  const block = Math.floor((isp - 1) / 12);
  const tLong = model.priceQuantiles[block + '|1'];
  const tShort = model.priceQuantiles[block + '|0'];
  if (!tLong || !tShort) return { p10: null, p50: null, p90: null };
  if (prob >= 0.65) return { ...tLong };
  if (prob <= 0.35) return { ...tShort };
  return {
    p10: Math.min(tLong.p10, tShort.p10),
    p50: prob * tLong.p50 + (1 - prob) * tShort.p50,
    p90: Math.max(tLong.p90, tShort.p90),
  };
}

const ispLabel = (isp) => `${String(Math.floor((isp - 1) / 4)).padStart(2, '0')}:${['00', '15', '30', '45'][(isp - 1) % 4]}`;

const cetLabel = (isp) => {
  const minutes = (isp - 1) * 15 - 60; // EET -> CET
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

function betsSection(db, today, tomorrow) {
  const cfg = loadConfig();
  const lastRun = db.prepare(`SELECT MAX(run_at) m FROM bets`).get().m;
  if (!lastRun) return '';
  const bets = db.prepare(`SELECT * FROM bets WHERE run_at=? ORDER BY ts_utc`).all(lastRun);
  const lockedBets = new Map(db.prepare(`
    SELECT b.* FROM bets b
    JOIN (SELECT ts_utc, MAX(run_at) mr FROM bets WHERE actionable=1 GROUP BY ts_utc) x
      ON x.ts_utc=b.ts_utc AND x.mr=b.run_at
  `).all().map((r) => [r.ts_utc, r]));

  const renderDay = (date, label) => {
    const rows = bets.filter((b) => b.date_ro === date);
    if (!rows.length) return '';
    let totalExp = 0, totalQty = 0;
    const body = rows.map((b) => {
      const lk = lockedBets.get(b.ts_utc);
      totalExp += b.qty > 0 ? b.exp_revenue : 0;
      totalQty += b.qty;
      const action = b.qty === 0
        ? '<span class="mid">no position</span>'
        : `<span class="${b.dir}">${b.dir === 'surplus' ? 'GO SURPLUS' : 'GO DEFICIT'}</span> ${b.qty.toFixed(1)} MWh`;
      return `<tr>
        <td><b>${b.isp}</b></td><td>${ispLabel(b.isp)}</td><td>${cetLabel(b.isp)}</td>
        <td>${action}</td>
        <td>${(b.prob * 100).toFixed(0)}%</td>
        <td>${Math.round(b.exp_price)}</td>
        <td>${Math.round(b.da_ref)}${b.da_ref_est ? '<small>~est</small>' : ''}</td>
        <td>${b.exp_edge > 0 ? '+' : ''}${Math.round(b.exp_edge)}</td>
        <td>${b.qty > 0 ? Math.round(b.exp_revenue) : '—'}</td>
        <td>${lk && lk.qty > 0 ? `${lk.dir} ${lk.qty.toFixed(1)} MWh @ ${lk.run_at.slice(11, 16)}Z` : '—'}</td>
        <td>${lk?.realized_revenue !== null && lk?.realized_revenue !== undefined ? Math.round(lk.realized_revenue) + ' RON' : ''}</td>
      </tr>`;
    }).join('\n');
    return `<h2>Suggested positions — ${dayTitle(date)} (${label}) · window ${String(cfg.trade_window_cet[0]).padStart(2, '0')}:00–${String(cfg.trade_window_cet[1]).padStart(2, '0')}:00 CET · max ${cfg.max_mwh_per_isp} MWh/interval</h2>
<table><tr><th>Interval</th><th>EET</th><th>CET</th><th>Position</th><th>Confidence</th><th>Pred. price</th><th>PZU ref</th><th>Edge [RON/MWh]</th><th>Expected [RON]</th><th>Locked position</th><th>Realized [RON]</th></tr>
${body}
<tr><td colspan="8" style="text-align:right"><b>Day total (expected)</b></td><td><b>${Math.round(totalExp)} RON</b></td><td colspan="2">${totalQty.toFixed(1)} MWh committed</td></tr></table>`;
  };
  return renderDay(today, 'today') + renderDay(tomorrow, 'tomorrow');
}

const dayTitle = (dateStr) => {
  const d = new Date(dateStr + 'T12:00:00Z');
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()];
  return `${weekday} ${dateStr}`;
};

function stance(prob) {
  if (prob >= 0.65) return 'Surplus expected — deficit position settles cheap';
  if (prob <= 0.35) return 'Deficit expected — surplus position gets paid';
  return 'stay balanced';
}

function main() {
  const db = openDb();
  ensureTables(db);
  const model = JSON.parse(fs.readFileSync(path.join(__dirname, 'model.json'), 'utf8'));
  const now = new Date();
  const runAt = now.toISOString();
  const ctx = buildContext(db, new Date(now.getTime() - 10 * 86400000).toISOString());

  // targets: next 15-min boundary -> end of tomorrow (RO day)
  const first = new Date(Math.ceil(now.getTime() / (15 * MIN)) * 15 * MIN);
  const targets = [];
  const tomorrow = roDateIsp(new Date(now.getTime() + 86400000)).date;
  for (let t = first.getTime(); ; t += 15 * MIN) {
    const d = new Date(t);
    const { date } = roDateIsp(d);
    if (date > tomorrow) break;
    targets.push(d);
  }

  const ins = db.prepare(`INSERT OR REPLACE INTO predictions
    (run_at, ts_utc, date_ro, isp, horizon_min, actionable, prob_long, price_p10, price_p50, price_p90, model_version, imb_p50)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.exec('BEGIN');
  let n = 0;
  for (const target of targets) {
    const horizonMin = (target.getTime() - now.getTime()) / MIN;
    const bucket = horizonMin <= 360 ? 'short' : 'long';
    const f = featuresFor(ctx, target, now);
    const prob = predictOne(model, bucket, f.values);
    const q = priceQuantiles(model, f.meta.isp, prob);
    ins.run(runAt, f.meta.ts, f.meta.date, f.meta.isp, horizonMin, horizonMin >= FREEZE_MIN ? 1 : 0,
      +prob.toFixed(4), q.p10, q.p50, q.p90, model.version, imbP50(model, f.meta.isp, prob));
    n++;
  }
  db.exec('COMMIT');
  console.log(`${runAt}: ${n} predictions stored`);
  const nBets = computeBets(db, model, now, runAt);
  console.log(`${nBets} bet rows stored`);
  const nAuto = autoFillUserBets(db, runAt, now);
  console.log(`${nAuto} user bets auto-filled from advice`);
  renderDashboard(db, model, now);
}

// 10:00 CET (= 11:00 EET) on the day before delivery, DST-safe
function lockTimeFor(deliveryDate) {
  const prev = new Date(new Date(deliveryDate + 'T12:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const base = new Date(prev + 'T00:00:00Z').getTime();
  for (const off of [3, 2]) {
    const cand = new Date(base + (11 - off) * 3600000);
    const r = roDateIsp(cand);
    if (r.date === prev && Math.floor(((r.isp - 1) * 15) / 60) === 11) return cand;
  }
  return new Date(base + 9 * 3600000);
}

// Default policy (user 2026-06-11): the advice IS the bet unless the user typed their own.
// Auto rows refresh with the latest advice on every run until the sheet locks; manual rows
// (entered via the UI) are never overwritten.
function autoFillUserBets(db, runAt, now) {
  const bets = db.prepare(`SELECT date_ro, isp, dir, qty FROM bets WHERE run_at=?`).all(runAt);
  const upsert = db.prepare(`
    INSERT INTO user_bets (date_ro, isp, qty, updated_at, source) VALUES (?,?,?,?, 'auto')
    ON CONFLICT (date_ro, isp) DO UPDATE SET qty=excluded.qty, updated_at=excluded.updated_at
    WHERE user_bets.source = 'auto' AND user_bets.qty != excluded.qty
  `);
  const log = db.prepare(`INSERT INTO user_bets_log (date_ro, isp, qty, saved_at) VALUES (?,?,?,?)`);
  let n = 0;
  let unlocked = new Set();
  try {
    unlocked = new Set(db.prepare(`SELECT date_ro FROM page_unlocks WHERE unlocked=1`).all().map((r) => r.date_ro));
  } catch { /* table created by server on first run */ }
  db.exec('BEGIN');
  for (const b of bets) {
    // frozen after 10:00 CET D-1 — unless the user explicitly unlocked the sheet
    if (now.getTime() >= lockTimeFor(b.date_ro).getTime() && !unlocked.has(b.date_ro)) continue;
    const signed = b.dir === 'surplus' ? b.qty : -b.qty;
    const before = db.prepare(`SELECT qty, source FROM user_bets WHERE date_ro=? AND isp=?`).get(b.date_ro, b.isp);
    upsert.run(b.date_ro, b.isp, signed, runAt);
    if (!before || (before.source === 'auto' && before.qty !== signed)) {
      log.run(b.date_ro, b.isp, signed, runAt);
      n++;
    }
  }
  db.exec('COMMIT');
  return n;
}

// Suggested balancing bets for the solar+battery flexibility window.
// Edge = predicted imbalance price (p50) - PZU benchmark. Positive edge -> surplus position
// (under-sell PZU / deliver extra; paid imbalance price). Negative edge -> deficit position
// (over-sell PZU / deliver less; buy back at imbalance price). Sized by model confidence.
function computeBets(db, model, now, runAt) {
  const cfg = loadConfig();
  const [h0, h1] = cfg.trade_window_cet; // CET hours -> EET = CET+1
  const ispFrom = (h0 + 1) * 4 + 1, ispTo = (h1 + 1) * 4; // 7-10 CET -> ISP 33..44
  const rows = db.prepare(`SELECT * FROM predictions WHERE run_at=? AND isp BETWEEN ? AND ? ORDER BY ts_utc`)
    .all(runAt, ispFrom, ispTo);
  const pzuAt = db.prepare(`SELECT value FROM series WHERE series='pzu_ron' AND ts_utc=?`);
  const pzuAvg = db.prepare(`SELECT AVG(value) v FROM series WHERE series='pzu_ron' AND isp=? AND date_ro>=date(?, '-7 days') AND date_ro<?`);
  const daAt = db.prepare(`SELECT value FROM series WHERE series='da_price' AND ts_utc=?`);
  const ins = db.prepare(`INSERT OR REPLACE INTO bets
    (run_at, ts_utc, date_ro, isp, actionable, dir, qty, prob, exp_price, da_ref, da_ref_est, exp_edge, exp_revenue, model_version, tail_loss, reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  // Structural imbalance-vs-PZU spread per 3h block (trailing 120d): mean(imbalance price − PZU). This is
  // the STABLE signal (both move together, so the spread survives even when levels swing on solar days),
  // and it is base-rate-correct (uses realized prices, not a 50/50 quantile average). Negative = imbalance
  // structurally below PZU → lean DEFICIT (over-sell PZU, buy back cheap). The validated D-1 edge.
  const fromDate = new Date(now.getTime() - 120 * 86400000).toISOString().slice(0, 10);
  const spreadByBlock = {};
  for (const row of db.prepare(`
    SELECT (s1.isp-1)/12 AS blk, AVG(s1.value - s2.value*?) AS sp, COUNT(*) n
    FROM series s1 JOIN series s2 ON s1.ts_utc=s2.ts_utc
    WHERE s1.series='damas_est_price_pos' AND s2.series='da_price' AND s1.date_ro >= ?
    GROUP BY blk`).all(cfg.eur_ron, fromDate)) {
    if (row.n >= 50) spreadByBlock[row.blk] = row.sp;
  }

  let n = 0;
  db.exec('BEGIN');
  for (const r of rows) {
    // PZU benchmark: official OPCOM RON price > ENTSO-E EUR converted > 7d same-ISP RON average
    let daRef, est = 0;
    const official = pzuAt.get(r.ts_utc)?.value;
    const daEur = daAt.get(r.ts_utc)?.value;
    if (official !== undefined && official !== null) daRef = official;
    else if (daEur !== undefined && daEur !== null) { daRef = daEur * cfg.eur_ron; est = 1; }
    else { daRef = pzuAvg.get(r.isp, r.date_ro, r.date_ro)?.v ?? 0; est = 1; }
    // EV-based sizing: bet whenever risk-adjusted expected value is positive; hold only
    // when the wrong-case tail loss is costly enough to eat the edge.
    // STRUCTURAL LEAN (validated 2026-06-17, see [[pzu-bidding]]): the day-specific imbalance-direction
    // call (prob_long) is a coin-flip at the D-1 horizon and the old EV tilt was a NET DRAG vs a structural
    // deficit lean (backtest 1.89M vs 3.43M). So the bet direction/size now comes from the STRUCTURAL
    // imbalance-price-vs-PZU spread (tS/tD per block are the structural price levels), NOT prob_long.
    // Confidence is the structural hit-rate (~60%, and ERODING — size modestly), not a day-specific signal.
    const block = Math.floor((r.isp - 1) / 12);
    const tS = model.priceQuantiles[block + '|1'];
    const tD = model.priceQuantiles[block + '|0'];
    const meanSpread = spreadByBlock[block]; // structural mean(imbalance price − PZU) for this block
    let dir, ev = 0, wrongProb = 0.4, tailLoss = 0, expPrice = r.price_p50; // wrongProb 0.4 → ~60% structural conf
    if (meanSpread !== undefined) {
      dir = meanSpread >= 0 ? 'surplus' : 'deficit'; // imb below PZU (negative) → over-sell PZU & buy back cheap
      ev = Math.abs(meanSpread);
      expPrice = +(daRef + meanSpread).toFixed(2); // structural implied imbalance price for the day
      if (tS && tD) tailLoss = dir === 'surplus' ? Math.max(0, tS.p50 - tS.p10) : Math.max(0, tD.p90 - tD.p50);
    } else if (tS && tD) { // fallback if no structural spread for the block
      const evSurplus = 0.5 * (tS.p50 + tD.p50) - daRef;
      dir = evSurplus >= 0 ? 'surplus' : 'deficit'; ev = Math.abs(evSurplus);
    } else {
      dir = (r.price_p50 ?? daRef) >= daRef ? 'surplus' : 'deficit';
    }
    // always-bet policy: direction = EV sign, size scales between min and max with the
    // risk-adjusted signal strength (tail risk reduces size, never blocks the bet)
    const riskAdj = ev - cfg.risk_aversion * wrongProb * tailLoss;
    const qty = riskAdj >= 50 ? cfg.max_mwh_per_isp : cfg.min_mwh_per_isp;
    const reason = riskAdj >= 50 ? 'strong' : 'base';
    ins.run(runAt, r.ts_utc, r.date_ro, r.isp, r.actionable, dir, qty, +((1 - wrongProb)).toFixed(4),
      expPrice, +daRef.toFixed(2), est, +ev.toFixed(2), +(qty * ev).toFixed(2), r.model_version,
      +tailLoss.toFixed(2), reason);
    n++;
  }
  db.exec('COMMIT');
  return n;
}

function renderDashboard(db, model, now) {
  const today = roDateIsp(now).date;
  const tomorrow = roDateIsp(new Date(now.getTime() + 86400000)).date;

  // locked prediction per ISP = last actionable row; live = last row of latest run
  const locked = db.prepare(`
    SELECT p.* FROM predictions p
    JOIN (SELECT ts_utc, MAX(run_at) mr FROM predictions WHERE actionable=1 GROUP BY ts_utc) x
      ON x.ts_utc = p.ts_utc AND x.mr = p.run_at
    WHERE p.date_ro IN (?, ?) ORDER BY p.ts_utc
  `).all(today, tomorrow);
  const lockedBy = new Map(locked.map((r) => [r.ts_utc, r]));

  const lastRun = db.prepare(`SELECT MAX(run_at) m FROM predictions`).get().m;
  const live = db.prepare(`SELECT * FROM predictions WHERE run_at=? ORDER BY ts_utc`).all(lastRun);

  const actuals = new Map(
    db.prepare(`SELECT ts_utc, value FROM series WHERE series='damas_est_sys_imbalance' AND date_ro=?`)
      .all(today).map((r) => [r.ts_utc, r.value]),
  );
  const actualPrices = new Map(
    db.prepare(`SELECT ts_utc, value FROM series WHERE series='damas_est_price_pos' AND date_ro=?`)
      .all(today).map((r) => [r.ts_utc, r.value]),
  );

  // model health: last 7 days of scored locked predictions
  const health = db.prepare(`
    SELECT COUNT(*) n,
      AVG(CASE WHEN (prob_long>0.5) = (realized_imb>0) THEN 1.0 ELSE 0 END) acc,
      AVG(CASE WHEN (prob_long>0.65 OR prob_long<0.35) THEN 1.0 ELSE NULL END) conf_share,
      AVG(CASE WHEN (prob_long>0.65 OR prob_long<0.35) AND (prob_long>0.5)=(realized_imb>0) THEN 1.0
               WHEN (prob_long>0.65 OR prob_long<0.35) THEN 0 ELSE NULL END) conf_acc,
      AVG(ABS(price_p50 - realized_price)) price_mae
    FROM predictions p
    JOIN (SELECT ts_utc, MAX(run_at) mr FROM predictions WHERE actionable=1 GROUP BY ts_utc) x
      ON x.ts_utc=p.ts_utc AND x.mr=p.run_at
    WHERE realized_imb IS NOT NULL AND p.ts_utc >= ?
  `).get(new Date(now.getTime() - 7 * 86400000).toISOString());

  const fmtP = (v) => (v === null || v === undefined ? '—' : Math.round(v));
  const dirCell = (p) => {
    if (p === null) return '—';
    const cls = p >= 0.65 ? 'surplus' : p <= 0.35 ? 'deficit' : 'mid';
    return `<span class="${cls}">${p >= 0.5 ? 'Surplus' : 'Deficit'}</span>`;
  };
  const chanceCell = (p) => (p === null ? '—' : `${(Math.max(p, 1 - p) * 100).toFixed(0)}%`);

  const rowsHtml = (rows, showLocked) => rows.map((r) => {
    const lk = lockedBy.get(r.ts_utc);
    const act = actuals.get(r.ts_utc);
    const ap = actualPrices.get(r.ts_utc);
    const frozen = r.horizon_min < FREEZE_MIN;
    return `<tr class="${frozen ? 'frozen' : ''}">
      <td><b>${r.isp}</b></td>
      <td>${ispLabel(r.isp)}</td>
      <td>${dirCell(r.prob_long)}</td>
      <td>${chanceCell(r.prob_long)}</td>
      <td>${r.imb_p50 === null || r.imb_p50 === undefined ? '—' : r.imb_p50.toFixed(0)}</td>
      <td><b>${fmtP(r.price_p50)}</b></td>
      <td>${fmtP(r.price_p10)} … ${fmtP(r.price_p90)}</td>
      <td>${stance(r.prob_long)}</td>
      ${showLocked ? `<td>${lk ? dirCell(lk.prob_long) + ' ' + chanceCell(lk.prob_long) + ' @ ' + lk.run_at.slice(11, 16) + 'Z' : '—'}</td>` : ''}
      ${showLocked ? `<td>${act !== undefined ? `<span class="${act > 0 ? 'surplus' : 'deficit'}">${act > 0 ? 'Surplus' : 'Deficit'}</span> ${act.toFixed(0)} MWh / ${ap !== undefined ? Math.round(ap) + ' RON' : ''}` : ''}</td>` : ''}
    </tr>`;
  }).join('\n');

  const liveToday = live.filter((r) => r.date_ro === today);
  const liveTomorrow = live.filter((r) => r.date_ro === tomorrow);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="120">
<title>GAN Balancing Outlook</title><style>
body{font:13px/1.45 Verdana,Arial,sans-serif;margin:0;background:#fff;color:#333}
.banner{background:#103a63;color:#fff;padding:14px 24px;margin:0 0 16px}
.banner h1{margin:0;font-size:19px;font-weight:600;letter-spacing:0.3px}
.banner .sub{color:#bcd0e4;font-size:11px;margin-top:3px}
.content{padding:0 24px 30px}
table{border-collapse:collapse;margin:8px 0 28px;background:#fff;border:1px solid #c5d3e0}
td,th{border:1px solid #c5d3e0;padding:3px 10px;text-align:left;font-size:12px}
th{background:#28618f;color:#fff;font-weight:600;border-color:#28618f;white-space:nowrap}
tr:nth-child(even) td{background:#eef3f8}
.surplus{color:#1565c0;font-weight:700}.deficit{color:#d2691e;font-weight:700}.mid{color:#8a8a8a}
.frozen td{opacity:0.55}.frozen td:first-child::after{content:" 🔒";opacity:1}
h2{margin:26px 0 4px;font-size:15px;color:#103a63;border-bottom:2px solid #28618f;padding-bottom:4px}
small{color:#999}.meta{color:#555;font-size:11px;max-width:1100px}
</style></head><body>
<div class="banner"><h1>GAN Energy — Balancing Outlook</h1>
<div class="sub">Romania (10YRO-TEL------P) · 15-min imbalance settlement periods · prices in RON/MWh · times in EET</div></div>
<div class="content">
<p class="meta">Generated ${now.toISOString()} (${model.version}, trained ${model.trainedAt?.slice(0, 10)}) —
auto-refresh 2 min. <span class="surplus">Surplus</span> = system imbalance positive → low/negative imbalance price.
<span class="deficit">Deficit</span> = system imbalance negative → high price.
🔒 = inside the ${FREEZE_MIN}-min freeze window (locked column is binding).
Price columns are p10/p50/p90 in RON/MWh. Model health, locked predictions, last 7 days:
sign accuracy <b>${health.acc ? (health.acc * 100).toFixed(1) + '%' : 'n/a'}</b>
(confident calls: ${health.conf_acc ? (health.conf_acc * 100).toFixed(1) + '%' : 'n/a'} on ${health.conf_share ? (health.conf_share * 100).toFixed(0) + '%' : '—'} of ISPs),
price p50 MAE ${health.price_mae ? Math.round(health.price_mae) + ' RON' : 'n/a'}, scored n=${health.n}.</p>

${betsSection(db, today, tomorrow)}

<h2>PI corrections — ${dayTitle(today)} (today, live)</h2>
<table><tr><th>Interval</th><th>Time</th><th>Direction</th><th>Chance</th><th>Imbalance [MWh]</th><th>Price [RON/MWh]</th><th>Price range</th><th>Suggested stance</th><th>Locked (binding)</th><th>Realized</th></tr>
${rowsHtml(liveToday, true)}</table>

<h2>PZU offers — ${dayTitle(tomorrow)} (tomorrow)</h2>
<table><tr><th>Interval</th><th>Time</th><th>Direction</th><th>Chance</th><th>Imbalance [MWh]</th><th>Price [RON/MWh]</th><th>Price range</th><th>Suggested stance</th></tr>
${rowsHtml(liveTomorrow, false)}</table>
</div></body></html>`;

  const out = path.join(__dirname, 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'dashboard.html'), html);
  console.log('dashboard -> tool/out/dashboard.html');
}

main();
