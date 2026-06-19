// tool/sen_filter.js — Transelectrica live homepage SCADA feed (the /sen-filter endpoint the homepage
// polls every ~10s). Shared fetch + field decode + recorder. Saves every distinct snapshot to sen_live
// so the rich, high-frequency real-time data is available for prediction. Used by server.js (live UI) and
// log_xb_pi.js (24/7 capture).
//
// FIELD IDENTIFICATION (decoded from the /sen-filter JSON array of single-key objects):
//   row1_HARTASEN_DATA = SCADA snapshot timestamp "YY/M/DD HH:MM:SS" (RO local)
//   PROD = total national production (MW)          CONS = realized consumption (MW)
//   CONS2 / CONS15 = consumption variants (alt/forecast/15-min)
//   SOLD = exchange balance = CONS − PROD (MW; NEGATIVE = net export, positive = net import)
//   PLAN = scheduled / programmed exchange ("sold programat")   PROG / Prot1TMS = program/metadata (often empty)
//   Generation by source (instantaneous MW; the *15 twins are the 15-min values):
//     CARB = coal (cărbune)  GAZE = gas  NUCL = nuclear  APE = hydro (ape)
//     EOLIAN = wind (eolian)  FOTO = solar (fotovoltaic)  BMASA = biomass (biomasă)
//   Cross-border tie-line / interconnector flows (per substation, MW; sign = direction):
//     MUKA = Mukachevo (UA)  ISPOZ/IS = Isaccea (UA)  VULC = Vulcănești (MD)  UNGE = Ungheni (MD)  IAS2 = Iași (MD)
//     KOZL1/KOZL2 = Kozloduy (BG)  VARN = Varna (BG)  DOBR = Dobrudja (BG)
//     DJER = Đerdap / Iron Gates (RS)  PANCEVO21/PANCEVO22 = Pančevo (RS)  SAND = Sándorfalva (HU)  BEKE1 = Békéscsaba (HU)
//     CHEA / CHEF = internal hydro nodes;  KUSJ/GOTE/PARO/S110/SIP_/COSE/CIOA/MINT/KIKI = other tie-lines/nodes
//   We store the DECODED core (below) as columns + the FULL raw payload (JSON) so any field can be mined later.
const URL = 'https://www.transelectrica.ro/sen-filter';
const HDRS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest',
  'Referer': 'https://www.transelectrica.ro/web/tel/home',
};
const DECODE = { PROD: 'prod', CONS: 'cons', SOLD: 'sold', PLAN: 'plan', CARB: 'coal', GAZE: 'gas', NUCL: 'nuclear', APE: 'hydro', EOLIAN: 'wind', FOTO: 'solar', BMASA: 'biomass' };
const num = (v) => { const n = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : null; };
// SCADA timestamp "YY/M/DD HH:MM:SS" (RO wall-clock) → "naive" ms (Europe/Bucharest wall-clock treated as UTC).
// Used to bucket readings into intervals by their TRUE data time (not our ~1-min-lagged record time) and to
// time-weight the interval average. Shares the clock with server.js roWallMs()/tStart, so the tz offset cancels.
const naiveMs = (s) => { const m = /(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+)/.exec(s || ''); return m ? Date.UTC(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null; };

async function fetchSenFilter() {
  const r = await fetch(URL + '?_=' + Date.now(), { headers: HDRS });
  if (!r.ok) return null;
  const arr = await r.json();
  const m = {}; for (const o of arr) for (const k in o) m[k] = o[k]; // flatten array of {key:val}
  const d = { ts: m.row1_HARTASEN_DATA || null, raw: m };
  for (const [code, name] of Object.entries(DECODE)) d[name] = num(m[code]);
  return d.sold !== null ? d : null;
}

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sen_live (
    pulled_at TEXT, ts_feed TEXT PRIMARY KEY, date_ro TEXT, isp INTEGER, ts_ms INTEGER,
    sold REAL, plan REAL, prod REAL, cons REAL,
    coal REAL, gas REAL, nuclear REAL, hydro REAL, wind REAL, solar REAL, biomass REAL,
    raw TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_senlive_di ON sen_live(date_ro, isp);`);
  try { db.exec('ALTER TABLE sen_live ADD COLUMN ts_ms INTEGER'); } catch { /* already present */ }
  db.exec('CREATE INDEX IF NOT EXISTS ix_senlive_tsms ON sen_live(ts_ms)');
  // backfill ts_ms (true SCADA time, naive ms) for any rows recorded before the column existed
  try {
    const need = db.prepare('SELECT ts_feed FROM sen_live WHERE ts_ms IS NULL').all();
    if (need.length) { const upd = db.prepare('UPDATE sen_live SET ts_ms=? WHERE ts_feed=?'); db.exec('BEGIN'); for (const r of need) { const t = naiveMs(r.ts_feed); if (t != null) upd.run(t, r.ts_feed); } db.exec('COMMIT'); }
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} }
}

// record one snapshot, deduped by the SCADA timestamp (PK) — so we keep every DISTINCT reading exactly once,
// no matter how often it's polled. Returns true if a new row was stored.
function record(db, d, roDateIsp) {
  if (!d || !d.ts) return false;
  const ri = roDateIsp(new Date());
  const info = db.prepare(`INSERT OR IGNORE INTO sen_live
    (pulled_at, ts_feed, date_ro, isp, ts_ms, sold, plan, prod, cons, coal, gas, nuclear, hydro, wind, solar, biomass, raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    new Date().toISOString(), d.ts, ri.date, ri.isp, naiveMs(d.ts), d.sold, d.plan, d.prod, d.cons,
    d.coal, d.gas, d.nuclear, d.hydro, d.wind, d.solar, d.biomass, JSON.stringify(d.raw));
  return info.changes > 0;
}

module.exports = { fetchSenFilter, ensureTable, record, naiveMs, DECODE, URL };
