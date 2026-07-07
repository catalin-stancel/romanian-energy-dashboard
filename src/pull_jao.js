// Pull official border-capacity data from the JAO Core publication tool (public API, no key) into market.db.
//   maxExchanges: the flow-based domain's max bilateral exchange per hour — the OFFICIAL capacity-equivalent
//                 for the RO-HU border (no bilateral NTC exists in Core; this is the FB answer).
//   atc:          remaining/offered ATC on the RO-BG virtual-hub border after day-ahead (the intraday-stage capacity).
//   node tool\pull_jao.js            (today + tomorrow; schedule hourly)
//   node tool\pull_jao.js backfill 2026-06-20 2026-07-08
const { openDb, makeUpserter } = require('./db');
const BASE = 'https://publicationtool.jao.eu/core/api/data/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchDay(ep, day) {
  const from = day + 'T00:00:00.000Z', to = day + 'T23:59:59.000Z';
  const u = BASE + ep + '?FromUtc=' + encodeURIComponent(from) + '&ToUtc=' + encodeURIComponent(to);
  const r = await fetch(u, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(ep + ' HTTP ' + r.status);
  const j = await r.json();
  return j.data || [];
}

const MAPS = [
  { ep: 'maxExchanges', fields: { border_HU_RO: 'jao_max_HU_RO', border_RO_HU: 'jao_max_RO_HU' } },
  { ep: 'atc', fields: { border_BG_RO_BG_VH: 'jao_atc_BG_RO', border_RO_BG_VH_BG: 'jao_atc_RO_BG' } },
];

async function main() {
  const db = openDb();
  const upsert = makeUpserter(db);
  const args = process.argv.slice(2);
  let days = [];
  if (args[0] === 'backfill') {
    for (let t = Date.parse(args[1] + 'T12:00:00Z'); t <= Date.parse(args[2] + 'T12:00:00Z'); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
  } else {
    const now = Date.now();
    days = [new Date(now).toISOString().slice(0, 10), new Date(now + 86400000).toISOString().slice(0, 10)];
  }
  let total = 0;
  for (const { ep, fields } of MAPS) {
    for (const day of days) {
      try {
        const rows = await fetchDay(ep, day);
        db.exec('BEGIN');
        for (const r of rows) {
          const ts = new Date(r.dateTimeUtc).toISOString();
          for (const [src, name] of Object.entries(fields)) {
            const v = Number(r[src]);
            if (Number.isFinite(v)) { upsert(name, ts, v); total++; }
          }
        }
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch { /* no txn */ } console.warn(`${ep} ${day}: ${e.message}`); }
      await sleep(400);
    }
  }
  console.log(`jao: stored ${total} points across ${days.length} day(s)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
