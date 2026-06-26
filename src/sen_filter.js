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
// the RO-day interval (date YYYY-MM-DD + isp 1..96) a SCADA timestamp belongs to — position in the local day,
// no tz math. Used so the live Real-X-B value lands in the interval its SCADA time falls in, not the wall-clock one.
const tsInterval = (s) => { const m = /(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+)/.exec(s || ''); if (!m) return null; return { date: (2000 + +m[1]) + '-' + String(+m[2]).padStart(2, '0') + '-' + String(+m[3]).padStart(2, '0'), isp: Math.floor((+m[4] * 60 + +m[5]) / 15) + 1 }; };

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

// ---- per-interval TIME-WEIGHTED average (energy-industry: Σ value×duration / Σ duration) over sen_live ----
// CANONICAL impl — server.js intervalTWA delegates here; saveIntervalAvg persists it. Keep the weighting ONLY here.
function roWallMs() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date());
  const g = (t) => +p.find((x) => x.type === t).value;
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')); // RO wall-clock naive ms
}
function intervalAvg(db, dateRo, isp) {
  const [Y, Mo, D] = dateRo.split('-').map(Number);
  const tStart = Date.UTC(Y, Mo - 1, D, 0, 0, 0) + (isp - 1) * 900000;
  const tFull = tStart + 900000;
  // End the integration at the latest SCADA timestamp ("scada now"), NOT the wall clock — so the denominator is the
  // seconds ELAPSED BY SCADA TIME (latest SCADA ts − interval start), and the last reading is never extrapolated
  // across the feed's ~1-min lag. Past intervals: scadaNow >> tFull → full 15 min. Current: up to the freshest reading.
  let scadaNow = tStart + 1; try { const r = db.prepare('SELECT MAX(ts_ms) m FROM sen_live WHERE ts_ms IS NOT NULL').get(); if (r && r.m) scadaNow = r.m; } catch { /* ignore */ }
  const tEnd = Math.min(tFull, Math.max(scadaNow, tStart + 1)); // completed → full 15min; current → scada-elapsed
  let inWin, carry;
  try {
    inWin = db.prepare('SELECT ts_ms, sold FROM sen_live WHERE ts_ms >= ? AND ts_ms < ? AND sold IS NOT NULL ORDER BY ts_ms').all(tStart, tEnd);
    carry = db.prepare('SELECT sold FROM sen_live WHERE ts_ms < ? AND sold IS NOT NULL ORDER BY ts_ms DESC LIMIT 1').get(tStart);
  } catch { return null; }
  const segs = [];
  if (carry) segs.push({ t: tStart, sold: carry.sold }); // carry fills [tStart, first reading]
  for (const r of inWin) segs.push({ t: r.ts_ms, sold: r.sold });
  if (!segs.length) return null;
  // NO extend-back: never over-weight the first reading by claiming time before its own SCADA timestamp.
  let num = 0, den = 0;
  for (let i = 0; i < segs.length; i++) { const e = i === segs.length - 1 ? tEnd : segs[i + 1].t; const w = Math.max(0, e - segs[i].t); num += segs[i].sold * w; den += w; }
  if (den <= 0) return null;
  const avgSold = num / den;
  return { avgSold, avgRealxb: -avgSold, n: segs.length, tStart, complete: tEnd >= tFull };
}
function ensureIntervalTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sen_interval (
    date_ro TEXT, isp INTEGER, avg_sold REAL, avg_realxb REAL, n INTEGER, saved_at TEXT,
    PRIMARY KEY (date_ro, isp)
  );
  CREATE INDEX IF NOT EXISTS ix_seninterval_date ON sen_interval(date_ro);`);
}
// compute + upsert one COMPLETED interval's time-weighted average. Returns true if saved.
function saveIntervalAvg(db, dateRo, isp) {
  const r = intervalAvg(db, dateRo, isp);
  if (!r || !r.complete) return false;
  db.prepare(`INSERT INTO sen_interval (date_ro, isp, avg_sold, avg_realxb, n, saved_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(date_ro, isp) DO UPDATE SET avg_sold=excluded.avg_sold, avg_realxb=excluded.avg_realxb, n=excluded.n, saved_at=excluded.saved_at`)
    .run(dateRo, isp, +r.avgSold.toFixed(2), +r.avgRealxb.toFixed(2), r.n, new Date().toISOString());
  return true;
}
// persist per-interval averages: backfill every COMPLETED interval in sen_live (idempotent, bounded) and
// re-finalize the last few (late SCADA readings can still land ~1-2 min after an interval ends).
function backfillIntervals(db, { maxNew = 500, refinishMin = 4 } = {}) {
  ensureIntervalTable(db);
  const roNow = roWallMs();
  const ivs = db.prepare('SELECT DISTINCT date_ro, isp FROM sen_live').all();
  const saved = new Set(db.prepare('SELECT date_ro, isp FROM sen_interval').all().map((r) => r.date_ro + '|' + r.isp));
  const todo = [];
  for (const { date_ro, isp } of ivs) {
    const [Y, Mo, D] = date_ro.split('-').map(Number);
    const tEnd = Date.UTC(Y, Mo - 1, D, 0, 0, 0) + isp * 900000; // interval end
    if (tEnd > roNow - 120000) continue;                          // not safely complete yet (SCADA lag buffer)
    const already = saved.has(date_ro + '|' + isp);
    if (!already || tEnd > roNow - refinishMin * 60000) todo.push({ date_ro, isp, already });
  }
  todo.sort((a, b) => (a.date_ro + String(a.isp).padStart(3, '0')).localeCompare(b.date_ro + String(b.isp).padStart(3, '0')));
  let n = 0, newN = 0;
  for (const it of todo) { if (!it.already) { if (newN >= maxNew) continue; newN++; } if (saveIntervalAvg(db, it.date_ro, it.isp)) n++; }
  return n;
}

module.exports = { fetchSenFilter, ensureTable, record, naiveMs, tsInterval, intervalAvg, ensureIntervalTable, saveIntervalAvg, backfillIntervals, roWallMs, DECODE, URL };
