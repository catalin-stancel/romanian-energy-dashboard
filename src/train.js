// Train the imbalance models on history in market.db and save tool/model.json.
//
//   node tool\train.js [fromDate] [holdoutDays]
//
// v1 models (transparent, upgradeable):
//  - sign of system imbalance: logistic regression, two horizon buckets
//      short: as-of = ISP start - 90 min   (PI decisions, just above the 75-min freeze)
//      long : as-of = D-1 06:00 UTC        (09:00 EET, PZU morning decision for D)
//  - price: empirical quantiles conditioned on (3h block, realized sign), mixed by
//    predicted sign probability at inference time.
// Labels: damas_est_sys_imbalance / damas_est_price_pos (estimated values; final settlement
// differs slightly — CINTA file is ground truth for economics, revisit in backtest).
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { buildContext, featuresFor, FEATURE_NAMES, MIN } = require('./features');

const FROM = process.argv[2] || '2024-08-01';
const HOLDOUT_DAYS = Number(process.argv[3] || 30);

function fitLogistic(X, y, epochs = 400) {
  const n = X.length, k = X[0].length;
  const w = new Array(k).fill(0);
  let lr = 0.5;
  for (let e = 0; e < epochs; e++) {
    const grad = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let j = 0; j < k; j++) z += w[j] * X[i][j];
      const p = 1 / (1 + Math.exp(-z));
      const d = p - y[i];
      for (let j = 0; j < k; j++) grad[j] += d * X[i][j];
    }
    for (let j = 0; j < k; j++) w[j] -= (lr / n) * (grad[j] + 0.001 * w[j]); // tiny L2
    if (e % 100 === 99) lr *= 0.5;
  }
  return w;
}

function normalize(rows) {
  const k = rows[0].length;
  const mu = new Array(k).fill(0), sd = new Array(k).fill(0), cnt = new Array(k).fill(0);
  for (const r of rows) for (let j = 0; j < k; j++) if (Number.isFinite(r[j])) { mu[j] += r[j]; cnt[j]++; }
  for (let j = 0; j < k; j++) mu[j] = cnt[j] ? mu[j] / cnt[j] : 0;
  for (const r of rows) for (let j = 0; j < k; j++) if (Number.isFinite(r[j])) sd[j] += (r[j] - mu[j]) ** 2;
  for (let j = 0; j < k; j++) sd[j] = cnt[j] > 1 ? Math.sqrt(sd[j] / cnt[j]) || 1 : 1;
  mu[0] = 0; sd[0] = 1; // bias column untouched
  const apply = (r) => r.map((v, j) => (Number.isFinite(v) ? (v - mu[j]) / sd[j] : 0));
  return { mu, sd, X: rows.map(apply) };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[i];
}

function main() {
  const db = openDb();
  const ctx = buildContext(db, FROM + 'T00:00:00Z');
  const imb = ctx.maps.damas_est_sys_imbalance;
  const price = ctx.maps.damas_est_price_pos;

  const cutoffHoldout = new Date(Date.now() - HOLDOUT_DAYS * 86400000);
  const samples = { short: { X: [], y: [], hold: [] }, long: { X: [], y: [], hold: [] } };
  const priceBuckets = {}; // block|sign -> prices (trailing window)
  const imbBuckets = {}; // block|sign -> signed imbalance MWh (trailing window)

  console.log('building samples...');
  const start = new Date(FROM + 'T00:00:00Z');
  const end = new Date(Date.now() - 86400000);
  for (let t = start.getTime(); t < end.getTime(); t += 15 * MIN) {
    const target = new Date(t);
    const ts = target.toISOString().slice(0, 19) + '.000Z';
    const yImb = imb.get(ts);
    if (yImb === undefined || yImb === null) continue;
    const y = yImb > 0 ? 1 : 0;
    const p = price.get(ts);
    const isHold = target >= cutoffHoldout;

    for (const [bucket, asOf] of [
      ['short', new Date(t - 90 * MIN)],
      ['long', (() => { const d = new Date(t); const dayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); return new Date(dayStart.getTime() - 86400000 + 6 * 3600000); })()],
    ]) {
      const f = featuresFor(ctx, target, asOf);
      if (isHold) samples[bucket].hold.push({ x: f.values, y, isp: f.meta.isp, mag: Math.abs(yImb) });
      else { samples[bucket].X.push(f.values); samples[bucket].y.push(y); }
    }
    // price/imbalance quantiles: trailing 120 days only (older regimes distort the levels),
    // holdout included — quantile tables are not what the holdout evaluates
    if (target.getTime() > Date.now() - 120 * 86400000) {
      const { isp } = require('./db').roDateIsp(target);
      const key = Math.floor((isp - 1) / 12) + '|' + y;
      if (p !== undefined && p !== null) (priceBuckets[key] = priceBuckets[key] || []).push(p);
      (imbBuckets[key] = imbBuckets[key] || []).push(yImb);
    }
  }

  const model = { version: 'v1-logistic', trainedAt: new Date().toISOString(), from: FROM, featureNames: FEATURE_NAMES, buckets: {}, priceQuantiles: {}, eval: {} };

  for (const bucket of ['short', 'long']) {
    const { X, y, hold } = samples[bucket];
    console.log(`${bucket}: train ${X.length}, holdout ${hold.length}`);
    const norm = normalize(X);
    const w = fitLogistic(norm.X, y);
    model.buckets[bucket] = { w, mu: norm.mu, sd: norm.sd };

    // holdout eval vs baselines
    const applyNorm = (r) => r.map((v, j) => (Number.isFinite(v) ? (v - norm.mu[j]) / norm.sd[j] : 0));
    let ok = 0, okClim = 0, okPersist = 0, n = 0;
    let okConf = 0, nConf = 0, okBig = 0, nBig = 0, okConfBig = 0, nConfBig = 0;
    // climatology: majority sign per 3h block from training
    const blockCounts = {};
    samples[bucket].X.forEach((x, i) => {
      // recover isp from sin/cos is messy; approximate climatology from holdout-independent priceBuckets keys instead
    });
    const longShare = y.reduce((a, b) => a + b, 0) / y.length;
    for (const h of hold) {
      const xn = applyNorm(h.x);
      let z = 0;
      for (let j = 0; j < w.length; j++) z += w[j] * xn[j];
      const prob = 1 / (1 + Math.exp(-z));
      const pred = prob > 0.5 ? 1 : 0;
      if (pred === h.y) ok++;
      const confident = prob > 0.65 || prob < 0.35;
      const big = h.mag > 50; // MWh per 15min — the economically relevant intervals
      if (confident) { nConf++; if (pred === h.y) okConf++; }
      if (big) { nBig++; if (pred === h.y) okBig++; }
      if (confident && big) { nConfBig++; if (pred === h.y) okConfBig++; }
      if ((longShare > 0.5 ? 1 : 0) === h.y) okClim++;
      const recent = h.x[FEATURE_NAMES.indexOf('recent_imb_45m')];
      if ((Number.isFinite(recent) && recent > 0 ? 1 : 0) === h.y) okPersist++;
      n++;
    }
    model.eval[bucket] = {
      holdoutN: n,
      accuracy: +(ok / n).toFixed(4),
      baselineMajority: +(okClim / n).toFixed(4),
      baselinePersistence: +(okPersist / n).toFixed(4),
      confidentAcc: nConf ? +(okConf / nConf).toFixed(4) : null,
      confidentCoverage: +(nConf / n).toFixed(4),
      bigImbAcc: nBig ? +(okBig / nBig).toFixed(4) : null,
      bigImbN: nBig,
      confidentBigAcc: nConfBig ? +(okConfBig / nConfBig).toFixed(4) : null,
      confidentBigN: nConfBig,
    };
    console.log(`${bucket}: acc ${(ok / n * 100).toFixed(1)}% | majority ${(okClim / n * 100).toFixed(1)}% | persistence ${(okPersist / n * 100).toFixed(1)}%`);
    console.log(`  confident(>65%): acc ${nConf ? (okConf / nConf * 100).toFixed(1) : '-'}% on ${(nConf / n * 100).toFixed(0)}% of ISPs | big(|imb|>50MWh): acc ${nBig ? (okBig / nBig * 100).toFixed(1) : '-'}% (n=${nBig}) | confident+big: ${nConfBig ? (okConfBig / nConfBig * 100).toFixed(1) : '-'}% (n=${nConfBig})`);
  }

  for (const [key, arr] of Object.entries(priceBuckets)) {
    arr.sort((a, b) => a - b);
    model.priceQuantiles[key] = { p10: quantile(arr, 0.1), p50: quantile(arr, 0.5), p90: quantile(arr, 0.9), n: arr.length };
  }
  model.imbQuantiles = {};
  for (const [key, arr] of Object.entries(imbBuckets)) {
    arr.sort((a, b) => a - b);
    model.imbQuantiles[key] = { p50: quantile(arr, 0.5), n: arr.length };
  }

  fs.writeFileSync(path.join(__dirname, 'model.json'), JSON.stringify(model));
  console.log('saved tool/model.json');
}

main();
