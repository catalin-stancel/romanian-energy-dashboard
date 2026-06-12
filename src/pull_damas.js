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

// numeric fields of estimatedImbalancePrices items → series names
const FIELDS = {
  estimatedPriceNegativeImbalance: 'damas_est_price_neg',
  estimatedPricePositiveImbalance: 'damas_est_price_pos',
  estimatedSystemImbalance: 'damas_est_sys_imbalance',
  sumQup: 'damas_qup',
  sumQdn: 'damas_qdn',
  sumQupPup: 'damas_qup_value',
  sumQdownPdn: 'damas_qdn_value',
  fcr: 'damas_fcr',
  aFRR_Up: 'damas_afrr_up',
  aFRR_Down: 'damas_afrr_down',
  mFRR_Up: 'damas_mfrr_up',
  mFRR_Down: 'damas_mfrr_down',
  rr_Up: 'damas_rr_up',
  rr_Down: 'damas_rr_down',
  realizedConsumption: 'damas_consumption',
  imbalanceNettingImport: 'damas_netting_import',
  imbalanceNettingExport: 'damas_netting_export',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchInterval(fromIso, toIso) {
  const url = new URL(BASE + 'publicReport/estimatedImbalancePrices');
  url.searchParams.set('timeInterval', JSON.stringify({ from: fromIso, to: toIso }));
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url);
    if (r.ok) return (await r.json()).itemList || [];
    if (attempt < 4 && (r.status === 429 || r.status >= 500)) { await sleep(attempt * 3000); continue; }
    throw new Error(`DAMAS ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
}

async function pull(db, from, to) {
  const upsert = makeUpserter(db);
  let total = 0;
  const CHUNK = 7 * 86400000;
  for (let t = from.getTime(); t < to.getTime(); t += CHUNK) {
    const tEnd = Math.min(to.getTime(), t + CHUNK);
    const items = await fetchInterval(new Date(t).toISOString(), new Date(tEnd).toISOString());
    db.exec('BEGIN');
    for (const item of items) {
      const ts = item.timeInterval.from;
      for (const [field, series] of Object.entries(FIELDS)) {
        const v = Number(item[field]); // unfilled intervals carry null or the string "N/A"
        if (item[field] !== null && item[field] !== undefined && Number.isFinite(v)) {
          upsert(series, ts, v);
          total++;
        }
      }
    }
    db.exec('COMMIT');
    await sleep(500);
  }
  return total;
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
