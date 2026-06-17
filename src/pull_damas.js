// Pull Transelectrica DAMAS II public reports (estimated imbalance prices & system imbalance)
// into market.db. Keyless public API, JSON, 15-min ISPs.
//
//   node tool\pull_damas.js backfill 2024-06-01 2026-06-12
//   node tool\pull_damas.js update          (last 2 days + today; schedule every 5-15 min)
//
// Discovered endpoint (no auth):
//   GET https://newmarkets.transelectrica.ro/usy-durom-publicreportg01/00121002500000000000000000000100/
//       publicReport/estimatedImbalancePrices?timeInterval={"from":"<ISO>","to":"<ISO>"}
const { openDb, makeUpserter } = require('./db');

const BASE = 'https://newmarkets.transelectrica.ro/usy-durom-publicreportg01/00121002500000000000000000000100/';

// Each DAMAS public-report endpoint → {srcField: seriesName}. Gate field decides if a row is
// "real" (future intervals carry nulls / "N/A" / stale placeholders). Existing series names kept.
const REPORTS = [
  { cmd: 'estimatedImbalancePrices', gate: 'estimatedPricePositiveImbalance', fields: {
    estimatedPriceNegativeImbalance: 'damas_est_price_neg',
    estimatedPricePositiveImbalance: 'damas_est_price_pos',
    estimatedSystemImbalance: 'damas_est_sys_imbalance',
    sumQup: 'damas_qup', sumQdn: 'damas_qdn',
    sumQupPup: 'damas_qup_value', sumQdownPdn: 'damas_qdn_value',
    fcr: 'damas_fcr', aFRR_Up: 'damas_afrr_up', aFRR_Down: 'damas_afrr_down',
    mFRR_Up: 'damas_mfrr_up', mFRR_Down: 'damas_mfrr_down', rr_Up: 'damas_rr_up', rr_Down: 'damas_rr_down',
    realizedConsumption: 'damas_consumption',
    imbalanceNettingImport: 'damas_netting_import', imbalanceNettingExport: 'damas_netting_export',
  } },
  { cmd: 'estimatedPowerSystemImbalance', gate: 'estimatedSystemImbalance', fields: {
    estimatedUnintendedDeviationINArea: 'damas_dev_in', estimatedUnintendedDeviationOUTArea: 'damas_dev_out',
    contractedBMVolumeUp: 'damas_contr_up', contractedBMVolumeDown: 'damas_contr_down',
    activatedReserve: 'damas_act_reserve',
    frequencyBiasFactorImport: 'damas_bias_imp', frequencyBiasFactorExport: 'damas_bias_exp',
  } },
  { cmd: 'marginalPricesOverview', gate: 'aFRR_Up', fields: {
    aFRR_Up: 'damas_mp_afrr_up', aFRR_Down: 'damas_mp_afrr_down',
    mFRR_Up: 'damas_mp_mfrr_up', mFRR_Down: 'damas_mp_mfrr_down',
    mFRR_Up_Scheduled: 'damas_mp_mfrr_up_sch', mFRR_Down_Scheduled: 'damas_mp_mfrr_down_sch',
    mFRR_Up_Direct: 'damas_mp_mfrr_up_dir', mFRR_Down_Direct: 'damas_mp_mfrr_down_dir',
    rr_Up: 'damas_mp_rr_up', rr_Down: 'damas_mp_rr_down',
  } },
  { cmd: 'generationSchedules', gate: 'brpsProduction', fields: {
    brpsProduction: 'damas_notif_prod', brpsConsumption: 'damas_notif_cons',
    nonDuProduction: 'damas_nondu_prod', nonDuConsumption: 'damas_nondu_cons',
  } },
  { cmd: 'dailyConsumptionOverview', gate: 'grossForecastConsumption', fields: {
    grossForecastConsumption: 'damas_cons_fc', grossRealizedConsumption: 'damas_cons_real',
  } },
  { cmd: 'activatedBalancingEnergyOverview', gate: 'aFRR_Up', fields: {
    aFRR_Up: 'damas_abe_afrr_up', aFRR_Down: 'damas_abe_afrr_down',
    mFRR_Up: 'damas_abe_mfrr_up', mFRR_Down: 'damas_abe_mfrr_down',
    rr_Up: 'damas_abe_rr_up', rr_Down: 'damas_abe_rr_down',
  } },
  // scheduledExchanges is nested per-border ({pair:{dayAhead,intraday,longTerm,...}}); handled specially
  { cmd: 'scheduledExchanges', gate: null, borders: ['huro', 'rohu', 'bgro', 'robg', 'rors', 'rsro', 'roua', 'uaro', 'mdro', 'romd'] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchInterval(cmd, fromIso, toIso) {
  const url = new URL(BASE + 'publicReport/' + cmd);
  url.searchParams.set('timeInterval', JSON.stringify({ from: fromIso, to: toIso }));
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url);
    if (r.ok) return (await r.json()).itemList || [];
    if (attempt < 4 && (r.status === 429 || r.status >= 500)) { await sleep(attempt * 3000); continue; }
    throw new Error(`DAMAS ${cmd} ${r.status}: ${(await r.text()).slice(0, 160)}`);
  }
}

const num = (v) => { const n = Number(v); return v !== null && v !== undefined && Number.isFinite(n) ? n : null; };

async function pull(db, from, to) {
  const upsert = makeUpserter(db);
  const counts = {};
  const CHUNK = 7 * 86400000;
  for (const rep of REPORTS) {
    let total = 0;
    for (let t = from.getTime(); t < to.getTime(); t += CHUNK) {
      const tEnd = Math.min(to.getTime(), t + CHUNK);
      let items;
      try { items = await fetchInterval(rep.cmd, new Date(t).toISOString(), new Date(tEnd).toISOString()); }
      catch (e) { console.warn(`  ${rep.cmd}: ${e.message}`); continue; }
      db.exec('BEGIN');
      for (const item of items) {
        const ts = item.timeInterval.from;
        if (rep.borders) {
          // scheduledExchanges per direction: use the 'commercial' rollup (= dayAhead + intraday).
          // NOT sum-of-all-leaves — that double-counts commercial with its own DA/ID components.
          for (const b of rep.borders) {
            const o = item[b];
            if (o && typeof o === 'object') {
              let v = num(o.commercial);
              if (v === null) { const da = num(o.dayAhead), id = num(o.intraday); if (da !== null || id !== null) v = (da ?? 0) + (id ?? 0); }
              if (v !== null) { upsert('damas_sx_' + b, ts, v); total++; }
            }
          }
          continue;
        }
        for (const [field, series] of Object.entries(rep.fields)) {
          const v = num(item[field]);
          if (v !== null) { upsert(series, ts, v); total++; }
        }
      }
      db.exec('COMMIT');
      await sleep(350);
    }
    counts[rep.cmd] = total;
    console.log(`  ${rep.cmd}: ${total} points`);
  }
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

async function main() {
  const [mode, a1, a2] = process.argv.slice(2);
  const db = openDb();
  let from, to;
  if (mode === 'backfill') {
    from = new Date(a1 + 'T00:00:00Z');
    to = new Date(a2 + 'T00:00:00Z');
  } else if (mode === 'update') {
    // IMPORTANT: the API returns its grid anchored to `from` — misaligned timestamps yield
    // empty placeholder intervals. Always query from UTC midnight boundaries.
    const todayUtc = new Date().toISOString().slice(0, 10);
    from = new Date(new Date(todayUtc + 'T00:00:00Z').getTime() - 2 * 86400000);
    to = new Date(new Date(todayUtc + 'T00:00:00Z').getTime() + 86400000);
  } else {
    console.error('Usage: pull_damas.js backfill <from> <to> | update');
    process.exit(1);
  }
  const started = new Date().toISOString();
  const n = await pull(db, from, to);
  db.prepare('INSERT INTO pull_log VALUES (?,?,?,?,?,?)')
    .run('damas:estimatedImbalancePrices', `${mode} ${from.toISOString()}..${to.toISOString()}`, started, new Date().toISOString(), n, null);
  console.log(`stored ${n} points`);
}

main().catch((e) => { console.error(e); process.exit(1); });
