// Shared feature extraction for imbalance prediction, with as-of discipline:
// every feature for target interval T computed "as of" time A uses only data that was
// actually available at A (publication lags applied).
//
// Availability model (v1, refine as first_seen lag measurements accumulate):
//  - damas_* series: available ~25 min after interval END
//  - ws_fc_da_* (ENTSO-E day-ahead RES forecast for day D): available from 18:00 EET on D-1
//  - ws_fc_cur_*: treated as available for same-day targets only (history approximation)
//  - sched_* / net_pos_da (DA commitments for D): available from 14:00 EET on D-1
//  - offers (merit order for day D): published one day behind -> for targets on D use
//    stack of D-1 (proxy); for D+1 targets use stack of D-1 as well (latest known)
//  - weather: every stored run keyed by pulled_at; use latest run <= A
const { roDateIsp } = require('./db');

const MIN = 60000;
const DAMAS_LAG_MIN = 25;

function loadSeries(db, names, fromIso) {
  const maps = {};
  for (const n of names) maps[n] = new Map();
  const stmt = db.prepare(
    `SELECT series, ts_utc, value FROM series WHERE series IN (${names.map(() => '?').join(',')}) AND ts_utc >= ?`,
  );
  for (const r of stmt.iterate(...names, fromIso)) maps[r.series]?.set(r.ts_utc, r.value);
  return maps;
}

// merit-order summary per (date_ro, mtu): depth + cheap-end prices
function loadStacks(db, fromDate) {
  const stacks = new Map(); // key date|mtu -> {upMw, downMw, upP25, downP75}
  const rows = db.prepare(`
    SELECT date_ro, mtu, direction, COUNT(*) n, SUM(pmax) mw,
           AVG(price) avg_price, MIN(price) min_price, MAX(price) max_price
    FROM offers WHERE date_ro >= ? GROUP BY date_ro, mtu, direction
  `).all(fromDate);
  for (const r of rows) {
    const key = r.date_ro + '|' + r.mtu;
    if (!stacks.has(key)) stacks.set(key, {});
    const s = stacks.get(key);
    if (r.direction === 'up') { s.upMw = r.mw; s.upAvgP = r.avg_price; }
    else { s.downMw = r.mw; s.downAvgP = r.avg_price; }
  }
  return stacks;
}

// weather averaged across points per (var, hour ts) for the LATEST run <= asOf, plus cross-model std
function loadWeather(db, fromIso) {
  // rows: var, ts_utc, pulled_at, model -> avg over points
  const rows = db.prepare(`
    SELECT var, ts_utc, pulled_at, model, AVG(value) v
    FROM weather WHERE ts_utc >= ? GROUP BY var, ts_utc, pulled_at, model
  `).all(fromIso);
  // index: var|ts -> sorted list of {pulled_at, perModel:{}}
  const idx = new Map();
  for (const r of rows) {
    const key = r.var + '|' + r.ts_utc;
    if (!idx.has(key)) idx.set(key, new Map());
    const runs = idx.get(key);
    if (!runs.has(r.pulled_at)) runs.set(r.pulled_at, {});
    runs.get(r.pulled_at)[r.model] = r.v;
  }
  const out = new Map();
  for (const [key, runs] of idx) {
    out.set(key, [...runs.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  }
  return out;
}

function weatherAt(weatherIdx, varName, ts, asOfIso) {
  const hourTs = ts.slice(0, 13) + ':00:00Z';
  const runs = weatherIdx.get(varName + '|' + hourTs);
  if (!runs) return { mean: null, spread: null };
  let chosen = null;
  for (const [pulledAt, perModel] of runs) {
    if (pulledAt <= asOfIso) chosen = perModel;
    else break;
  }
  if (!chosen) chosen = runs[0][1]; // earliest run (training-era fallback before our pulls began)
  const vals = Object.values(chosen).filter(Number.isFinite);
  if (!vals.length) return { mean: null, spread: null };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const spread = vals.length > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) : 0;
  return { mean, spread };
}

const get = (map, ts) => { const v = map.get(ts); return v === undefined ? null : v; };
const tsAt = (d) => d.toISOString().slice(0, 19) + '.000Z';

// mean of last n values of `series` whose interval END (+lag) <= asOf
function recentMean(map, asOf, n, lagMin = DAMAS_LAG_MIN) {
  // newest available interval start: asOf - lag - 15min
  let t = new Date(Math.floor((asOf.getTime() - (lagMin + 15) * MIN) / (15 * MIN)) * 15 * MIN);
  const vals = [];
  for (let i = 0; i < n * 3 && vals.length < n; i++) {
    const v = map.get(tsAt(t));
    if (v !== null && v !== undefined) vals.push(v);
    t = new Date(t.getTime() - 15 * MIN);
  }
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

const FEATURE_NAMES = [
  'bias', 'sin_isp', 'cos_isp', 'is_weekend',
  'recent_imb_2h', 'recent_imb_45m', 'recent_price_2h',
  'yesterday_same_isp_imb',
  'solar_fc', 'solar_ramp_1h', 'wind_fc', 'load_fc',
  'net_export_sched', 'swrad', 'wind100_mean', 'wind100_spread', 'temp',
  'stack_down_mw', 'stack_up_mw',
  'horizon_h',
  'blk1', 'blk2', 'blk3', 'blk4', 'blk5', 'blk6', 'blk7', // 3h-block dummies (blk0 = ref)
];

// ctx = {maps, stacks, weatherIdx}; target = Date of ISP start (UTC); asOf = Date
function featuresFor(ctx, target, asOf) {
  const ts = tsAt(target);
  const { date, isp } = roDateIsp(target);
  const dow = new Date(date + 'T12:00:00Z').getUTCDay();
  const m = ctx.maps;

  const yesterday = tsAt(new Date(target.getTime() - 96 * 15 * MIN));
  // commitments: scheduled net export for the target interval (null until published)
  let netExport = null;
  let any = false;
  for (const cc of ['HU', 'BG', 'RS', 'UA', 'MD']) {
    const exp = get(m['sched_RO_' + cc], ts);
    const imp = get(m['sched_' + cc + '_RO'], ts);
    if (exp !== null || imp !== null) { any = true; netExport = (netExport ?? 0) + (exp ?? 0) - (imp ?? 0); }
  }
  if (!any) netExport = null;
  // commitments for day D publish with the DA results ~14:00 EET on D-1; before that mask out
  // (a 10:00 CET D-1 decision must NOT see them)
  const dayStart = new Date(new Date(ts).getTime() - (isp - 1) * 15 * MIN);
  const commitAvail = asOf.getTime() >= dayStart.getTime() - 10 * 3600000;
  if (!commitAvail) netExport = null;

  // stack proxy: latest published merit order = (target date - 1)
  const stackDate = new Date(new Date(date + 'T12:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const stack = ctx.stacks.get(stackDate + '|' + isp) || {};

  const sw = weatherAt(ctx.weatherIdx, 'shortwave_radiation', ts, tsAt(asOf));
  const w100 = weatherAt(ctx.weatherIdx, 'wind_speed_100m', ts, tsAt(asOf));
  const temp = weatherAt(ctx.weatherIdx, 'temperature_2m', ts, tsAt(asOf));

  const sameDay = roDateIsp(asOf).date === date;
  const horizonH = (target.getTime() - asOf.getTime()) / 3600000;
  const block = Math.floor((isp - 1) / 12); // 0..7
  const solarNow = sameDay ? (get(m.ws_fc_cur_solar, ts) ?? get(m.ws_fc_da_solar, ts)) : get(m.ws_fc_da_solar, ts);
  const tsPrev1h = tsAt(new Date(target.getTime() - 4 * 15 * MIN));
  const solarPrev = sameDay ? (get(m.ws_fc_cur_solar, tsPrev1h) ?? get(m.ws_fc_da_solar, tsPrev1h)) : get(m.ws_fc_da_solar, tsPrev1h);
  const solarRamp = solarNow !== null && solarPrev !== null ? solarNow - solarPrev : null;

  return {
    names: FEATURE_NAMES,
    values: [
      1,
      Math.sin((2 * Math.PI * isp) / 96), Math.cos((2 * Math.PI * isp) / 96),
      dow === 0 || dow === 6 ? 1 : 0,
      recentMean(m.damas_est_sys_imbalance, asOf, 8),
      recentMean(m.damas_est_sys_imbalance, asOf, 3),
      recentMean(m.damas_est_price_pos, asOf, 8),
      get(m.damas_est_sys_imbalance, yesterday),
      solarNow,
      solarRamp,
      sameDay ? (get(m.ws_fc_cur_wind_onshore, ts) ?? get(m.ws_fc_da_wind_onshore, ts)) : get(m.ws_fc_da_wind_onshore, ts),
      get(m.load_fc_da, ts),
      netExport,
      sw.mean, w100.mean, w100.spread, temp.mean,
      stack.downMw ?? null, stack.upMw ?? null,
      horizonH,
      block === 1 ? 1 : 0, block === 2 ? 1 : 0, block === 3 ? 1 : 0, block === 4 ? 1 : 0,
      block === 5 ? 1 : 0, block === 6 ? 1 : 0, block === 7 ? 1 : 0,
    ],
    meta: { date, isp, ts },
  };
}

const SERIES_NEEDED = [
  'damas_est_sys_imbalance', 'damas_est_price_pos',
  'ws_fc_da_solar', 'ws_fc_da_wind_onshore', 'ws_fc_cur_solar', 'ws_fc_cur_wind_onshore',
  'load_fc_da',
  'sched_RO_HU', 'sched_HU_RO', 'sched_RO_BG', 'sched_BG_RO', 'sched_RO_RS', 'sched_RS_RO',
  'sched_RO_UA', 'sched_UA_RO', 'sched_RO_MD', 'sched_MD_RO',
];

function buildContext(db, fromIso) {
  return {
    maps: loadSeries(db, SERIES_NEEDED, fromIso),
    stacks: loadStacks(db, fromIso.slice(0, 10)),
    weatherIdx: loadWeather(db, fromIso),
  };
}

module.exports = { buildContext, featuresFor, FEATURE_NAMES, tsAt, MIN };
