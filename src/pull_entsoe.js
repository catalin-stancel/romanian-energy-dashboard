// Pull Romanian market data from the ENTSO-E Transparency Platform into market.db.
//
//   node tool\pull_entsoe.js backfill 2024-06-01 2026-06-11 [seriesName]
//   node tool\pull_entsoe.js update            (re-pull last 3 days + tomorrow, all series)
//   node tool\pull_entsoe.js list              (show catalog)
//
// Token: tool\config.json {"entsoe_token":"..."} or ENTSOE_TOKEN env var.
const { openDb, makeUpserter } = require('./db');
const { getToken, apiGet, parseDocument, fmtPeriod, sleep } = require('./entsoe');

const RO = '10YRO-TEL------P';
const NEIGHBOURS = {
  HU: '10YHU-MAVIR----U',
  BG: '10YCA-BULGARIA-R',
  RS: '10YCS-SERBIATSOV',
  UA: '10Y1001C--00003F',
  MD: '10Y1001A1001A990',
};

const CATALOG = [
  // target side
  { name: 'imb_price',    params: { documentType: 'A85', controlArea_Domain: RO }, chunkDays: 30 },
  { name: 'imb_volume',   params: { documentType: 'A86', controlArea_Domain: RO }, chunkDays: 30 },
  { name: 'abe_afrr',     params: { documentType: 'A83', businessType: 'A96', controlArea_Domain: RO }, chunkDays: 7 },
  { name: 'abe_mfrr',     params: { documentType: 'A83', businessType: 'A97', controlArea_Domain: RO }, chunkDays: 7 },
  { name: 'abe_price',    params: { documentType: 'A84', processType: 'A16', controlArea_Domain: RO }, chunkDays: 7 },
  // feature side
  { name: 'load_actual',  params: { documentType: 'A65', processType: 'A16', outBiddingZone_Domain: RO }, chunkDays: 30 },
  { name: 'load_fc_da',   params: { documentType: 'A65', processType: 'A01', outBiddingZone_Domain: RO }, chunkDays: 30 },
  { name: 'ws_fc_da',     params: { documentType: 'A69', processType: 'A01', in_Domain: RO }, chunkDays: 30 },
  { name: 'ws_fc_cur',    params: { documentType: 'A69', processType: 'A40', in_Domain: RO }, chunkDays: 30 },
  { name: 'gen_fc_da',    params: { documentType: 'A71', processType: 'A01', in_Domain: RO }, chunkDays: 30 },
  { name: 'gen_actual',   params: { documentType: 'A75', processType: 'A16', in_Domain: RO }, chunkDays: 7 },
  { name: 'da_price',     params: { documentType: 'A44', 'in_Domain': RO, 'out_Domain': RO, 'contract_MarketAgreement.type': 'A01' }, chunkDays: 30 },
  { name: 'net_pos_da',   params: { documentType: 'A25', businessType: 'B09', 'Contract_MarketAgreement.Type': 'A01', in_Domain: RO, out_Domain: RO }, chunkDays: 30, optional: true },
];
// per-border flows (A11, physical) and total scheduled exchanges (A09), both directions
for (const [cc, eic] of Object.entries(NEIGHBOURS)) {
  CATALOG.push(
    { name: `flow_${cc}_RO`,  params: { documentType: 'A11', in_Domain: RO, out_Domain: eic }, chunkDays: 30, optional: true },
    { name: `flow_RO_${cc}`,  params: { documentType: 'A11', in_Domain: eic, out_Domain: RO }, chunkDays: 30, optional: true },
    { name: `sched_${cc}_RO`, params: { documentType: 'A09', 'contract_MarketAgreement.Type': 'A05', in_Domain: RO, out_Domain: eic }, chunkDays: 30, optional: true },
    { name: `sched_RO_${cc}`, params: { documentType: 'A09', 'contract_MarketAgreement.Type': 'A05', in_Domain: eic, out_Domain: RO }, chunkDays: 30, optional: true },
  );
}

async function pullSeries(db, token, entry, from, to) {
  const upsert = makeUpserter(db);
  let total = 0;
  for (let t = new Date(from); t < to; ) {
    const tEnd = new Date(Math.min(to.getTime(), t.getTime() + entry.chunkDays * 86400000));
    try {
      const docs = await apiGet(
        { ...entry.params, periodStart: fmtPeriod(t), periodEnd: fmtPeriod(tEnd) },
        token,
      );
      if (docs) {
        db.exec('BEGIN');
        for (const xml of docs) {
          const rows = parseDocument(xml);
          for (const r of rows) upsert(entry.name + r.suffix, r.ts.toISOString(), r.value);
          total += rows.length;
        }
        db.exec('COMMIT');
      }
    } catch (e) {
      if (!entry.optional) throw e;
      console.warn(`  [${entry.name}] skipped chunk (${e.message.slice(0, 120)})`);
    }
    t = tEnd;
    await sleep(350); // stay far below the rate limit
  }
  return total;
}

async function main() {
  const [mode, a1, a2, a3] = process.argv.slice(2);
  if (mode === 'list') {
    for (const e of CATALOG) console.log(`${e.name.padEnd(14)} ${JSON.stringify(e.params)}`);
    return;
  }
  const token = getToken();
  if (!token) {
    console.error(
      'No ENTSO-E token. Register at https://transparency.entsoe.eu, email transparency@entsoe.eu\n' +
      '("Restful API access" in the subject), generate the token under My Account Settings,\n' +
      'then put it in tool\\config.json as {"entsoe_token":"..."} or set ENTSOE_TOKEN.',
    );
    process.exit(1);
  }
  const db = openDb();
  let from, to, only;
  if (mode === 'backfill') {
    from = new Date(a1 + 'T00:00:00Z');
    to = new Date(a2 + 'T00:00:00Z');
    only = a3;
  } else if (mode === 'update') {
    from = new Date(Date.now() - 3 * 86400000);
    to = new Date(Date.now() + 2 * 86400000); // includes D+1 forecasts/schedules
  } else {
    console.error('Usage: pull_entsoe.js backfill <from> <to> [series] | update | list');
    process.exit(1);
  }
  const started = new Date().toISOString();
  for (const entry of CATALOG) {
    if (only && entry.name !== only) continue;
    process.stdout.write(`${entry.name} ... `);
    try {
      const n = await pullSeries(db, token, entry, from, to);
      console.log(`${n} points`);
      db.prepare('INSERT INTO pull_log VALUES (?,?,?,?,?,?)')
        .run('entsoe:' + entry.name, `${mode} ${from.toISOString()}..${to.toISOString()}`, started, new Date().toISOString(), n, null);
    } catch (e) {
      console.log('FAILED: ' + e.message.slice(0, 200));
      db.prepare('INSERT INTO pull_log VALUES (?,?,?,?,?,?)')
        .run('entsoe:' + entry.name, mode, started, new Date().toISOString(), 0, e.message.slice(0, 500));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
