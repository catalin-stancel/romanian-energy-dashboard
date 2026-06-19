// combo_score.js — LIVE (paper) scoring of the xb_combo colour model. Additive & read-only:
// it writes ONLY to its own combo_pred table and NEVER touches bets/user_bets/predictions, so it
// cannot change any real position. Purpose: forward-validate the +2.4pt / +70 RON/MWh backtest
// edge out-of-sample BEFORE it is ever allowed to drive positions (staged rollout, user 2026-06-19).
//
//   node tool/combo_score.js     (scheduled every 15 min)
//
// Two horizons, each frozen like the real desk:
//   • intraday : SHORT model (A-F), locked at the 75-min PI freeze — the headline edge.
//   • d1       : FWD model (B,C,D,E), locked at 10:00 CET D-1 — the PZU shadow (thin, watch it).
// Each run: (1) ensure models trained (cache combo_model.json, weekly retrain), (2) freeze upcoming
// predictions, (3) score any settled rows (realized colour + hypothetical paper P&L), (4) print a
// rolling scorecard.
const fs = require('fs');
const path = require('path');
const { openDb, roDateIsp } = require('./db');
const M = require('./combo_model');

const FREEZE_MIN = 75;
// cache the trained model on the writable disk (cloud: DATA_DIR=/data; local: alongside this file)
const CACHE = path.join(process.env.DATA_DIR || __dirname, 'combo_model.json');
const RETRAIN_AGE_MS = 7 * 86400000;

function loadConfig() {
  const d = { eur_ron: 5.24, max_mwh_per_isp: 2.5, min_mwh_per_isp: 2.0 };
  // config.json lives at ../ on cloud (src/) and alongside this file locally (tool/) — try both
  for (const p of [path.join(__dirname, '..', 'config.json'), path.join(__dirname, 'config.json')]) {
    try { return { ...d, ...JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')) }; } catch { /* try next */ }
  }
  return d;
}

// 10:00 CET (=11:00 EET) on the day before delivery, DST-safe — ported from predict.js
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

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS combo_pred (
    kind TEXT NOT NULL,                 -- 'intraday' | 'd1'
    ts_utc TEXT NOT NULL,
    date_ro TEXT NOT NULL,
    isp INTEGER NOT NULL,
    locked_at TEXT NOT NULL,
    horizon_min REAL,
    p_surplus REAL,
    pred_surplus INTEGER,
    conf REAL,
    qty REAL,
    da_ref REAL,
    persist_surplus INTEGER,
    realized_imb REAL, realized_surplus INTEGER, realized_price REAL,
    model_correct INTEGER, persist_correct INTEGER,
    pnl_ron REAL,
    model_version TEXT,
    PRIMARY KEY (kind, ts_utc)
  );
  CREATE INDEX IF NOT EXISTS idx_combo_date ON combo_pred (kind, date_ro, isp);`);
}

// load cached weights or (re)train both models from ctx, save cache
function getModels(db, ctx) {
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { /* none */ }
  const fresh = cache && cache.trainedAt && (Date.now() - Date.parse(cache.trainedAt) < RETRAIN_AGE_MS)
    && cache.short?.featList?.length === M.FEAT_SHORT.length && cache.fwd?.featList?.length === M.FEAT_FWD.length;
  if (fresh) return cache;
  const out = { trainedAt: new Date().toISOString() };
  for (const kind of ['short', 'fwd']) {
    const rows = M.buildTraining(ctx, kind);
    if (rows.length < 500) { out[kind] = cache?.[kind] || null; continue; }
    const featList = kind === 'short' ? M.FEAT_SHORT : M.FEAT_FWD;
    const m = M.fit(rows, featList);
    m.kind = kind; m.featList = featList; m.n = rows.length;
    m.range = [new Date(rows[0].t).toISOString().slice(0, 10), new Date(rows[rows.length - 1].t).toISOString().slice(0, 10)];
    out[kind] = m;
  }
  out.version = 'combo_v1';
  try { fs.writeFileSync(CACHE, JSON.stringify(out)); } catch (e) { console.error('cache write failed', e.message); }
  console.log(`combo models trained (short n=${out.short?.n}, fwd n=${out.fwd?.n})`);
  return out;
}

function main() {
  const db = openDb();
  ensureTable(db);
  const cfg = loadConfig();
  const ctx = M.load(db);
  const models = getModels(db, ctx);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  // PZU benchmark in RON for an interval: official pzu_ron > da_price(EUR)*eur_ron
  const pzuAt = db.prepare("SELECT value v FROM series WHERE series='pzu_ron' AND ts_utc=?");
  const daAt = db.prepare("SELECT value v FROM series WHERE series='da_price' AND ts_utc=?");
  const daRefFor = (ts) => {
    const o = pzuAt.get(ts)?.v; if (o !== undefined && o !== null) return o;
    const e = daAt.get(ts)?.v; if (e !== undefined && e !== null) return e * cfg.eur_ron;
    return null;
  };
  const qtyFor = (conf) => (conf >= 0.15 ? cfg.max_mwh_per_isp : cfg.min_mwh_per_isp);

  const ins = db.prepare(`INSERT OR REPLACE INTO combo_pred
    (kind, ts_utc, date_ro, isp, locked_at, horizon_min, p_surplus, pred_surplus, conf, qty, da_ref, persist_surplus,
     realized_imb, realized_surplus, realized_price, model_correct, persist_correct, pnl_ron, model_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, NULL,NULL,NULL,NULL,NULL,NULL, ?)`);
  // never overwrite a row already scored (settled)
  const isScored = db.prepare('SELECT realized_imb FROM combo_pred WHERE kind=? AND ts_utc=?');
  const isLocked = db.prepare('SELECT horizon_min FROM combo_pred WHERE kind=? AND ts_utc=?');

  let nIntra = 0, nD1 = 0;
  db.exec('BEGIN');
  const today = roDateIsp(new Date(nowMs)).date;
  for (const tg of M.upcomingTargets(nowMs)) {
    const horizon = (tg.Tms - nowMs) / M.MIN;
    // ---- intraday SHORT model: lock at the 75-min freeze ----
    if (models.short && horizon >= FREEZE_MIN) {
      if (!isScored.get('intraday', new Date(tg.Tms).toISOString())?.realized_imb) {
        const f = M.featShort(ctx, tg.Tms, tg.isp);
        if (f) {
          const p = M.prob(models.short, f.feat); const conf = Math.abs(p - 0.5);
          ins.run('intraday', new Date(tg.Tms).toISOString(), tg.date, tg.isp, now, +horizon.toFixed(1),
            +p.toFixed(4), p > 0.5 ? 1 : 0, +conf.toFixed(4), qtyFor(conf), daRefFor(new Date(tg.Tms).toISOString()),
            f.persistSurplus ? 1 : 0, models.version);
          nIntra++;
        }
      }
    }
    // ---- d1 FWD model: only tomorrow, lock at 10:00 CET D-1 ----
    if (models.fwd && tg.date > today && nowMs < lockTimeFor(tg.date).getTime()) {
      if (!isScored.get('d1', new Date(tg.Tms).toISOString())?.realized_imb) {
        const feat = M.featForward(ctx, tg.Tms, tg.isp);
        if (feat) {
          const p = M.prob(models.fwd, feat); const conf = Math.abs(p - 0.5);
          ins.run('d1', new Date(tg.Tms).toISOString(), tg.date, tg.isp, now, +horizon.toFixed(1),
            +p.toFixed(4), p > 0.5 ? 1 : 0, +conf.toFixed(4), qtyFor(conf), daRefFor(new Date(tg.Tms).toISOString()),
            null, models.version);
          nD1++;
        }
      }
    }
  }
  db.exec('COMMIT');

  // ---- score settled rows: realized colour + hypothetical paper P&L ----
  const imbAt = db.prepare("SELECT value v FROM series WHERE series='damas_est_sys_imbalance' AND ts_utc=?");
  const priceAt = db.prepare("SELECT value v FROM series WHERE series='damas_est_price_pos' AND ts_utc=?");
  const upd = db.prepare(`UPDATE combo_pred SET realized_imb=?, realized_surplus=?, realized_price=?,
    model_correct=?, persist_correct=?, pnl_ron=? WHERE kind=? AND ts_utc=?`);
  const pending = db.prepare('SELECT kind, ts_utc, isp, pred_surplus, conf, qty, da_ref, persist_surplus FROM combo_pred WHERE realized_imb IS NULL');
  let nScored = 0;
  db.exec('BEGIN');
  for (const r of pending.all()) {
    const imb = imbAt.get(r.ts_utc)?.v; if (imb === undefined || imb === null) continue;
    const realizedSurplus = imb > 0 ? 1 : 0;
    const price = priceAt.get(r.ts_utc)?.v ?? null;
    const modelCorrect = (r.pred_surplus === 1) === (realizedSurplus === 1) ? 1 : 0;
    const persistCorrect = r.persist_surplus === null ? null : ((r.persist_surplus === 1) === (realizedSurplus === 1) ? 1 : 0);
    // hypothetical paper P&L: predict deficit (pred_surplus=0) -> qty=+V (profits when imb price>PZU);
    // predict surplus -> qty=-V. pnl = qty_signed*(realized_price - da_ref). null if price/da_ref missing.
    let pnl = null;
    if (price !== null && r.da_ref !== null) { const signed = r.pred_surplus === 1 ? -r.qty : r.qty; pnl = +(signed * (price - r.da_ref)).toFixed(2); }
    upd.run(imb, realizedSurplus, price, modelCorrect, persistCorrect, pnl, r.kind, r.ts_utc);
    nScored++;
  }
  db.exec('COMMIT');

  console.log(`${now}: combo_pred +${nIntra} intraday / +${nD1} d1 frozen, ${nScored} scored`);

  // ---- rolling scorecard (all scored history) ----
  const card = (kind) => {
    const rows = db.prepare('SELECT * FROM combo_pred WHERE kind=? AND realized_imb IS NOT NULL').all(kind);
    if (!rows.length) return `${kind}: no scored rows yet`;
    const acc = rows.reduce((s, r) => s + r.model_correct, 0) / rows.length;
    const base = kind === 'intraday'
      ? rows.reduce((s, r) => s + (r.persist_correct || 0), 0) / rows.length
      : rows.reduce((s, r) => s + ((r.realized_surplus === 1) === (rows.reduce((a, x) => a + x.realized_surplus, 0) >= rows.length / 2) ? 1 : 0), 0) / rows.length;
    const pnlRows = rows.filter((r) => r.pnl_ron !== null);
    const pnl = pnlRows.reduce((s, r) => s + r.pnl_ron, 0);
    const mwh = pnlRows.reduce((s, r) => s + Math.abs(r.qty), 0);
    const baseLabel = kind === 'intraday' ? 'persist' : 'majority';
    return `${kind}: n=${rows.length} acc=${(acc * 100).toFixed(1)}% vs ${baseLabel} ${(base * 100).toFixed(1)}%`
      + (mwh ? ` | paper P&L ${Math.round(pnl).toLocaleString()} RON (${(pnl / mwh).toFixed(0)} RON/MWh, n=${pnlRows.length})` : '');
  };
  console.log('  ' + card('intraday'));
  console.log('  ' + card('d1'));
}

main();
