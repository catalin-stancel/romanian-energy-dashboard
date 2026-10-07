// One-off: seed wind_obs with the station archives so wind_interval has history, then build the interval averages.
// Sources: Weather Underground 5-min archive (cached day files from _wind_obs_fit.mjs in out/windobs/, fetched for
// the belt stations that were not cached), IEM METAR history (LRCK/LRTC/LRCV). Idempotent (INSERT OR IGNORE).
//   node backfill_wind_history.js [YYYY-MM-DD start]   (default 2026-03-10)
const fs = require('fs'), path = require('path');
const { openDb } = require('./db');
const windObs = require('./wind_obs');
const CACHE = path.join(__dirname, 'out', 'windobs'); fs.mkdirSync(CACHE, { recursive: true });
const K = process.env.WU_KEY || 'e1f10a1e78da46f5b10a1e78da96f525', H = { 'User-Agent': 'Mozilla/5.0' };
const START = process.argv[2] || '2026-03-10';
const days = []; for (let d = new Date(START + 'T00:00:00Z'); d < new Date(Date.now() - 86400e3); d = new Date(d.getTime() + 86400e3)) days.push(d.toISOString().slice(0, 10));
const fetchText = async (u, ms = 60000) => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); try { const r = await fetch(u, { headers: H, signal: ac.signal }); return r.ok ? await r.text() : null; } catch { return null; } finally { clearTimeout(t); } };
async function wuDay(id, d) {
  const f = path.join(CACHE, `wu_${id}_${d}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const t = await fetchText(`https://api.weather.com/v2/pws/history/all?stationId=${id}&format=json&units=m&date=${d.replace(/-/g, '')}&apiKey=${K}`);
  let v = []; try { v = t ? (JSON.parse(t).observations || []).map((o) => [o.obsTimeUtc, o.metric && o.metric.windspeedAvg != null ? o.metric.windspeedAvg / 3.6 : null, o.metric && o.metric.windgustHigh != null ? o.metric.windgustHigh / 3.6 : null, o.winddirAvg]) : []; } catch { v = []; }
  fs.writeFileSync(f, JSON.stringify(v)); return v;
}
(async () => {
  const db = openDb(); windObs.ensureTables(db);
  const ins = db.prepare('INSERT OR IGNORE INTO wind_obs(station, obs_ts, pulled_at, ws, gust, dir) VALUES (?,?,?,?,?,?)');
  const now = new Date().toISOString(); let total = 0;
  const store = (rows) => { let n = 0; db.exec('BEGIN IMMEDIATE'); try { for (const r of rows) if (r[1] != null && r[0]) n += ins.run(r.station, new Date(r[0]).toISOString(), now, r[1], r[2] ?? null, r[3] ?? null).changes; db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } return n; };
  for (const p of windObs.PWS) {
    let i = 0; const rows = [];
    await Promise.all(Array.from({ length: 4 }, async () => { while (i < days.length) { const d = days[i++]; for (const o of await wuDay(p.id, d)) { const r = o.slice(); r.station = p.id; rows.push(r); } } }));
    const n = store(rows); total += n; console.log(`${p.id} (${p.name}): ${rows.length} archive obs, +${n} new`);
  }
  // METAR history (IEM ASOS archive), 30-min reports, knots → m/s
  const [y, m, d] = START.split('-').map(Number); const e = new Date();
  const csv = await fetchText(`https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?${windObs.METAR.map((s) => 'station=' + s).join('&')}&data=sknt&data=drct&data=gust&year1=${y}&month1=${m}&day1=${d}&year2=${e.getUTCFullYear()}&month2=${e.getUTCMonth() + 1}&day2=${e.getUTCDate()}&tz=Etc/UTC&format=onlycomma&latlon=no&missing=M&trace=T&direct=no&report_type=3`, 180000);
  if (csv) {
    const rows = [];
    for (const l of csv.split('\n').slice(1)) { const c = l.split(','); if (c.length < 5 || c[2] === 'M') continue; const r = [c[1].replace(' ', 'T') + 'Z', +c[2] * 0.5144, c[4] !== 'M' ? +c[4] * 0.5144 : null, c[3] !== 'M' ? +c[3] : null]; r.station = c[0]; rows.push(r); }
    const n = store(rows); total += n; console.log(`METAR ${windObs.METAR.join('/')}: ${rows.length} reports, +${n} new`);
  } else console.log('METAR history: fetch failed');
  const hours = Math.ceil((Date.now() - new Date(START + 'T00:00:00Z').getTime()) / 3600e3) + 24;
  const ni = windObs.backfillIntervals(db, hours);
  console.log(`wind_obs +${total} readings total · wind_interval rows written: ${ni}`);
  console.log('composite intervals:', db.prepare("SELECT COUNT(*) c, MIN(date_ro) a, MAX(date_ro) b FROM wind_interval WHERE station='COMPOSITE'").get());
})().catch((e) => { console.error(e); process.exit(1); });
