// Fill realized outcomes into the predictions log (the learning record) and print a summary.
//   node tool\score_predictions.js     (scheduled hourly)
const { openDb } = require('./db');
const db = openDb();

const updated = db.prepare(`
  UPDATE predictions SET
    realized_imb = (SELECT value FROM series WHERE series='damas_est_sys_imbalance' AND ts_utc = predictions.ts_utc),
    realized_price = (SELECT value FROM series WHERE series='damas_est_price_pos' AND ts_utc = predictions.ts_utc)
  WHERE realized_imb IS NULL
    AND EXISTS (SELECT 1 FROM series WHERE series='damas_est_sys_imbalance' AND ts_utc = predictions.ts_utc)
`).run();

// score bets: settle at the realized imbalance price vs the ACTUAL PZU price (the recorded
// da_ref was only the decision-time estimate); falls back to da_ref if pzu_ron is missing
const betsScored = db.prepare(`
  UPDATE bets SET
    realized_price = (SELECT value FROM series WHERE series='damas_est_price_pos' AND ts_utc = bets.ts_utc),
    realized_revenue = qty * (CASE dir WHEN 'surplus' THEN 1 ELSE -1 END) *
      ((SELECT value FROM series WHERE series='damas_est_price_pos' AND ts_utc = bets.ts_utc) -
       COALESCE((SELECT value FROM series WHERE series='pzu_ron' AND ts_utc = bets.ts_utc), da_ref))
  WHERE realized_price IS NULL
    AND EXISTS (SELECT 1 FROM series WHERE series='damas_est_price_pos' AND ts_utc = bets.ts_utc)
`).run();

const bs = db.prepare(`
  SELECT COUNT(*) n, SUM(realized_revenue) rev, SUM(exp_revenue) exp_rev,
    AVG(CASE WHEN realized_revenue > 0 THEN 1.0 ELSE 0 END) hit
  FROM bets b
  JOIN (SELECT ts_utc, MAX(run_at) mr FROM bets WHERE actionable=1 GROUP BY ts_utc) x
    ON x.ts_utc=b.ts_utc AND x.mr=b.run_at
  WHERE realized_revenue IS NOT NULL AND qty > 0 AND b.ts_utc >= datetime('now','-7 days')
`).get();

const s = db.prepare(`
  SELECT COUNT(*) n,
    AVG(CASE WHEN (prob_long>0.5)=(realized_imb>0) THEN 1.0 ELSE 0 END) acc,
    AVG(ABS(price_p50-realized_price)) mae
  FROM predictions p
  JOIN (SELECT ts_utc, MAX(run_at) mr FROM predictions WHERE actionable=1 GROUP BY ts_utc) x
    ON x.ts_utc=p.ts_utc AND x.mr=p.run_at
  WHERE realized_imb IS NOT NULL AND p.ts_utc >= datetime('now','-7 days')
`).get();

console.log(`${new Date().toISOString()}: scored ${updated.changes} predictions, ${betsScored.changes} bets | 7d locked: n=${s.n} acc=${s.acc ? (s.acc * 100).toFixed(1) + '%' : '-'} priceMAE=${s.mae ? Math.round(s.mae) : '-'} | 7d bets: n=${bs.n} hit=${bs.hit !== null ? (bs.hit * 100).toFixed(0) + '%' : '-'} realized=${bs.rev !== null ? Math.round(bs.rev) + ' RON' : '-'} (expected ${bs.exp_rev !== null ? Math.round(bs.exp_rev) : '-'})`);
