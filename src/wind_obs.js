// tool/wind_obs.js — real-time wind observations for the Predict "Wind" column (mirrors sen_filter.js).
// Records station wind speeds (seconds-cadence PWS + 30-min METAR + hourly ANM) to wind_obs, per-interval averages
// to wind_interval, a per-farm hub-height NWP run to wind_fc, and the forward forecast frozen at the 75-min gate to
// wind_lock. The fleet's own output (EOLIAN MW) comes from sen_live. Validation behind the choices: 6-month backtest
// (_wind_obs_fit.mjs) — no ground station explains the fleet level (best MAE 287 vs 170 for 100 m model wind), but a
// few stations LEAD ramp onsets by 1–4 h (_wind_onset.mjs); the MW forecast = ENTSO-E intraday + live error
// correction (decay 0.97/ISP) cut the 75-min MAE 128 → 69 on 60 days.
const { roDateIsp, beginImmediate } = require('./db');

// Weather Underground "Rapid Fire" PWS in/around the Dobrogea wind belt (12–16 s cadence, 5-min archive).
// NB: the key is weather.com's public web key — fine for a local desk tool; register a PWS-owner key for anything else.
const WU_KEY = process.env.WU_KEY || 'e1f10a1e78da46f5b10a1e78da96f525';
const PWS = [
  { id: 'ISCELE22', name: 'Săcele', near: 'Fântânele–Cogealac', lat: 44.49, lon: 28.64 },
  { id: 'IPANTE37', name: 'Pantelimon', near: 'Pantelimon / Corugea', lat: 44.60, lon: 28.33 },
  { id: 'ISARIC5', name: 'Sarichioi', near: 'Sălbatica / Baia', lat: 44.96, lon: 28.86 },
  { id: 'IBEIDA1', name: 'Beidaud', near: 'Baia / Topolog', lat: 44.72, lon: 28.57 },
  { id: 'IMIHAI16', name: 'Mihai Viteazu', near: 'Mihai Viteazu farm', lat: 44.64, lon: 28.68 },
];
const METAR = ['LRCK', 'LRTC', 'LRCV']; // Kogălniceanu (in the belt), Tulcea, Craiova (westerly fronts arrive here first)
const ANM = ['CORUGEA', 'MEDGIDIA', 'CERNAVODA', 'HARSOVA', 'AMZACEA', 'SULINA', 'TULCEA', 'CONSTANTA'];
// live composite = belt stations only (Craiova and ANM are context, not the belt read)
const COMPOSITE = new Set([...PWS.map((p) => p.id), 'LRCK', 'LRTC']);
// hub-height (120 m) ICON-EU wind at the five big farm clusters — the forward speed line
const SITES = { fantanele: [44.56, 28.56], corugea: [44.74, 28.34], targusor: [44.47, 28.42], chirnogeni: [43.93, 28.21], facaeni: [44.56, 27.89] };
const DECAY = 0.97;   // live error-correction decay per ISP (best of the 60-day sweep at 75/120 min)
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' };
const num = (v) => { const n = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : null; };

async function getJson(url, ms = 8000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { headers: H, signal: ac.signal }); if (!r.ok) return null; const txt = await r.text(); return txt ? JSON.parse(txt) : null; }
  catch { return null; } finally { clearTimeout(t); }
}

function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS wind_obs (station TEXT, obs_ts TEXT, pulled_at TEXT, ws REAL, gust REAL, dir REAL, PRIMARY KEY(station, obs_ts));
    CREATE INDEX IF NOT EXISTS ix_windobs_ts ON wind_obs(obs_ts);
    CREATE TABLE IF NOT EXISTS wind_interval (date_ro TEXT, isp INTEGER, station TEXT, avg_ws REAL, n INTEGER, PRIMARY KEY(date_ro, isp, station));
    CREATE TABLE IF NOT EXISTS wind_fc (run_at TEXT, ts_utc TEXT, site TEXT, ws REAL, PRIMARY KEY(run_at, ts_utc, site));
    CREATE TABLE IF NOT EXISTS wind_lock (date_ro TEXT, isp INTEGER, mw_fc REAL, ws_fc REAL, mw_last REAL, locked_at TEXT, PRIMARY KEY(date_ro, isp));`);
}

// ---- recording -------------------------------------------------------------------------------------------------
function storeObs(db, rows) {
  if (!rows.length) return 0;
  const ins = db.prepare('INSERT OR IGNORE INTO wind_obs(station, obs_ts, pulled_at, ws, gust, dir) VALUES (?,?,?,?,?,?)');
  const now = new Date().toISOString(); let n = 0;
  beginImmediate(db);
  try { for (const r of rows) if (r.ws != null && r.obs_ts) n += ins.run(r.station, r.obs_ts, now, r.ws, r.gust, r.dir).changes; db.exec('COMMIT'); }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  return n;
}
// seconds-cadence sources: the PWS set (each its own request) + the METAR trio (one request, 30-min data)
async function pollFast(db) {
  const rows = [];
  await Promise.all(PWS.map(async (p) => {
    const j = await getJson(`https://api.weather.com/v2/pws/observations/current?stationId=${p.id}&format=json&units=m&apiKey=${WU_KEY}`);
    const o = j && j.observations && j.observations[0]; if (!o || !o.obsTimeUtc) return;
    const ws = o.metric ? num(o.metric.windSpeed) : null;
    rows.push({ station: p.id, obs_ts: new Date(o.obsTimeUtc).toISOString(), ws: ws == null ? null : ws / 3.6, gust: o.metric && num(o.metric.windGust) != null ? num(o.metric.windGust) / 3.6 : null, dir: num(o.winddir) });
  }));
  const m = await getJson(`https://aviationweather.gov/api/data/metar?ids=${METAR.join(',')}&format=json`);
  if (Array.isArray(m)) for (const o of m) { const ws = num(o.wspd); if (ws == null || !o.reportTime) continue; rows.push({ station: o.icaoId, obs_ts: new Date(o.reportTime).toISOString(), ws: ws * 0.5144, gust: num(o.wgst) != null ? num(o.wgst) * 0.5144 : null, dir: num(o.wdir) }); }
  return storeObs(db, rows);
}
// hourly ANM network (m/s at 10 m, the official Corugea/Medgidia masts) + the hub-height NWP run (every 15 min)
let _slowAt = { anm: 0, fc: 0 };
async function pollSlow(db) {
  let n = 0;
  if (Date.now() - _slowAt.anm > 5 * 60000) {
    _slowAt.anm = Date.now();
    const j = await getJson('https://www.meteoromania.ro/wp-json/meteoapi/v2/starea-vremii', 12000);
    if (j && j.features && j.date) {
      const ts = new Date(j.date).toISOString(); const rows = [];
      for (const f of j.features) { const p = f.properties || {}; if (!ANM.includes(p.nume)) continue; const mm = /([\d.]+)\s*m\/s/.exec(p.vant || ''); if (!mm) continue; rows.push({ station: 'ANM:' + p.nume, obs_ts: ts, ws: +mm[1], gust: null, dir: null }); }
      n += storeObs(db, rows);
    }
  }
  if (Date.now() - _slowAt.fc > 15 * 60000) {
    _slowAt.fc = Date.now();
    const names = Object.keys(SITES);
    const j = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${names.map((k) => SITES[k][0]).join(',')}&longitude=${names.map((k) => SITES[k][1]).join(',')}&hourly=wind_speed_120m&models=icon_eu&past_days=1&forecast_days=3&wind_speed_unit=ms&timezone=UTC`, 15000);
    const arr = Array.isArray(j) ? j : (j && j.hourly ? [j] : []);
    if (arr.length === names.length) {
      const run = new Date().toISOString().slice(0, 16); const ins = db.prepare('INSERT OR IGNORE INTO wind_fc(run_at, ts_utc, site, ws) VALUES (?,?,?,?)');
      beginImmediate(db);
      try { arr.forEach((o, i) => { const h = o.hourly || {}; (h.time || []).forEach((t, k) => { const v = h.wind_speed_120m && h.wind_speed_120m[k]; if (v != null) ins.run(run, t + ':00Z', names[i], v); }); }); db.exec('COMMIT'); n++; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} }
      try { db.prepare("DELETE FROM wind_fc WHERE run_at < ?").run(new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 16)); } catch {}
    }
  }
  return n;
}
// per-interval station averages for completed intervals (idempotent; re-finalizes recent intervals for late obs),
// plus one 'COMPOSITE' row per interval = mean of the belt stations that reported (n = station count) — the single
// number that is the interval's recorded wind speed history.
function backfillIntervals(db, sinceHours = 36) {
  const since = new Date(Date.now() - sinceHours * 3600e3).toISOString();
  const rows = db.prepare('SELECT station, obs_ts, ws FROM wind_obs WHERE obs_ts >= ? AND ws IS NOT NULL').all(since);
  const acc = new Map();
  for (const r of rows) { const ri = roDateIsp(new Date(r.obs_ts)); const k = `${ri.date}|${ri.isp}|${r.station}`; const a = acc.get(k) || { s: 0, n: 0 }; a.s += r.ws; a.n++; acc.set(k, a); }
  const now = roDateIsp(new Date());
  const up = db.prepare('INSERT INTO wind_interval(date_ro, isp, station, avg_ws, n) VALUES (?,?,?,?,?) ON CONFLICT(date_ro, isp, station) DO UPDATE SET avg_ws=excluded.avg_ws, n=excluded.n');
  const comp = new Map();
  let n = 0; beginImmediate(db);
  try {
    for (const [k, a] of acc) {
      const [d, isp, st] = k.split('|'); if (d === now.date && +isp >= now.isp) continue;
      const avg = a.s / a.n; up.run(d, +isp, st, +avg.toFixed(2), a.n); n++;
      if (COMPOSITE.has(st)) { const ck = d + '|' + isp; const c = comp.get(ck) || []; c.push(avg); comp.set(ck, c); }
    }
    for (const [ck, v] of comp) { const [d, isp] = ck.split('|'); up.run(d, +isp, 'COMPOSITE', +mean(v).toFixed(2), v.length); }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  return n;
}

// ---- reading ---------------------------------------------------------------------------------------------------
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const label = (id) => { const p = PWS.find((x) => x.id === id); return p ? p.name : id.replace('ANM:', ''); };
function latest(db, maxAgeMin = 45) {
  const out = [];
  for (const r of db.prepare('SELECT station, MAX(obs_ts) t FROM wind_obs GROUP BY station').all()) {
    const o = db.prepare('SELECT ws, gust, dir FROM wind_obs WHERE station=? AND obs_ts=?').get(r.station, r.t); if (!o) continue;
    const age = (Date.now() - new Date(r.t).getTime()) / 60000; if (age > (r.station.startsWith('ANM:') ? 90 : maxAgeMin)) continue;
    out.push({ id: r.station, name: label(r.station), ws: o.ws, gust: o.gust, dir: o.dir, age: +age.toFixed(1), comp: COMPOSITE.has(r.station) });
  }
  return out.sort((a, b) => (b.comp - a.comp) || a.id.localeCompare(b.id));
}
const composite = (st) => mean(st.filter((s) => s.comp && s.ws != null).map((s) => s.ws));
// composite speed as it was ~N minutes ago (for the onset test)
function compositeAgo(db, minutesAgo) {
  const to = new Date(Date.now() - minutesAgo * 60000).toISOString(), from = new Date(Date.now() - (minutesAgo + 30) * 60000).toISOString();
  const v = db.prepare('SELECT station, AVG(ws) w FROM wind_obs WHERE obs_ts BETWEEN ? AND ? AND ws IS NOT NULL GROUP BY station').all(from, to).filter((r) => COMPOSITE.has(r.station)).map((r) => r.w);
  return mean(v);
}
// national fleet output (EOLIAN MW) — latest live reading and per-interval averages, from sen_live
function fleet(db, date) {
  // date_ro-filtered so both hit ix_senlive_di (unfiltered ORDER BY pulled_at scanned the whole ~1M-row table, ~110 ms each)
  const today = roDateIsp(new Date()).date;
  const live = db.prepare('SELECT wind, pulled_at FROM sen_live WHERE date_ro=? AND wind IS NOT NULL ORDER BY pulled_at DESC LIMIT 1').get(today);
  const ago = db.prepare('SELECT AVG(wind) w FROM sen_live WHERE date_ro=? AND wind IS NOT NULL AND pulled_at BETWEEN ? AND ?').get(today, new Date(Date.now() - 12 * 60000).toISOString(), new Date(Date.now() - 8 * 60000).toISOString());
  const per = new Map(db.prepare('SELECT isp, AVG(wind) w, COUNT(*) n FROM sen_live WHERE date_ro=? AND wind IS NOT NULL GROUP BY isp').all(date).map((r) => [r.isp, { mw: r.w, n: r.n }]));
  return { liveMw: live ? live.wind : null, liveAt: live ? live.pulled_at : null, trend10: live && ago && ago.w != null ? live.wind - ago.w : null, per };
}
// ENTSO-E intraday wind forecast per isp for the date (cur, falling back to day-ahead)
function entsoe(db, date) {
  const m = new Map();
  for (const r of db.prepare("SELECT isp, series, value FROM series WHERE date_ro=? AND series IN ('ws_fc_cur_wind_onshore','ws_fc_da_wind_onshore') AND value IS NOT NULL").all(date)) {
    const o = m.get(r.isp) || {}; o[r.series] = r.value; m.set(r.isp, o);
  }
  const out = new Map(); for (const [isp, o] of m) out.set(isp, o.ws_fc_cur_wind_onshore ?? o.ws_fc_da_wind_onshore);
  return out;
}
// forward MW = ENTSO-E(isp) + (last realized − ENTSO-E(last)) · DECAY^(isp − last). `last` = latest interval with a
// fleet reading (the live one when it has ≥3 samples, else the previous completed one).
function mwForecast(db, date, nowInfo, F = fleet(db, date)) {
  const E = entsoe(db, date);
  let lastIsp = null, lastMw = null;
  if (nowInfo.date === date) { for (let k = nowInfo.isp; k >= 1 && lastIsp === null; k--) { const p = F.per.get(k); if (p && (k < nowInfo.isp || p.n >= 3)) { lastIsp = k; lastMw = p.mw; } } }
  const out = new Map(); if (lastIsp === null || !E.has(lastIsp)) return { fc: out, lastIsp, lastMw, F };
  const err = lastMw - E.get(lastIsp);
  for (const [isp, e] of E) if (isp > lastIsp) out.set(isp, Math.max(0, e + err * Math.pow(DECAY, isp - lastIsp)));
  return { fc: out, lastIsp, lastMw, F };
}
// forward hub-height speed (ICON-EU 120 m, 5-site mean, latest run, hourly → linear to the 15-min stamp)
function wsForecast(db) {
  const run = db.prepare('SELECT MAX(run_at) r FROM wind_fc').get(); if (!run || !run.r) return () => null;
  const rows = db.prepare('SELECT ts_utc, AVG(ws) w FROM wind_fc WHERE run_at=? GROUP BY ts_utc ORDER BY ts_utc').all(run.r);
  const t = rows.map((r) => new Date(r.ts_utc).getTime()), v = rows.map((r) => r.w);
  return (ms) => { if (!t.length || ms < t[0] || ms > t[t.length - 1]) return null; let i = 0; while (i < t.length - 1 && t[i + 1] < ms) i++; if (i >= t.length - 1) return v[i]; const f = (ms - t[i]) / (t[i + 1] - t[i]); return v[i] + f * (v[i + 1] - v[i]); };
}
// "wind starting": belt composite ≥3 m/s and up ≥1.5 m/s vs 3 h ago while the fleet is still low (onset test: 1–4 h lead)
function onset(db, st, liveMw) {
  const now = composite(st), ago = compositeAgo(db, 180);
  if (now == null || ago == null) return null;
  const rising = now >= 3 && now - ago >= 1.5;
  return { now: +now.toFixed(1), ago: +ago.toFixed(1), flag: rising && (liveMw == null || liveMw < 500) };
}

// everything the Predict page / live API need for one date
function pageData(db, date, nowInfo) {
  const st = latest(db); const comp = composite(st);
  const { fc, lastIsp, lastMw, F } = mwForecast(db, date, nowInfo, fleet(db, date));
  const wsF = wsForecast(db);
  // isp → recorded interval wind speed: the stored COMPOSITE row (history), else the mean of the belt stations present
  const iv = new Map(), ivComp = new Map();
  for (const r of db.prepare('SELECT isp, station, avg_ws FROM wind_interval WHERE date_ro=?').all(date)) {
    if (r.station === 'COMPOSITE') { ivComp.set(r.isp, r.avg_ws); continue; }
    if (!COMPOSITE.has(r.station)) continue; const a = iv.get(r.isp) || []; a.push(r.avg_ws); iv.set(r.isp, a);
  }
  for (const [isp, a] of iv) if (!ivComp.has(isp)) ivComp.set(isp, mean(a));
  const lock = new Map(db.prepare('SELECT isp, mw_fc, ws_fc FROM wind_lock WHERE date_ro=?').all(date).map((r) => [r.isp, r]));
  return { stations: st, comp: comp == null ? null : +comp.toFixed(1), fleet: F, fc, lastIsp, lastMw, wsF, ivComp, lock, onset: nowInfo.date === date ? onset(db, st, F.liveMw) : null };
}
// freeze the forward forecast of the interval that just crossed the 75-min gate (lock-once; same discipline as prod_lock)
function lockDue(db, dayTimestamps) {
  const ni = roDateIsp(new Date()); const cur = dayTimestamps(ni.date).find((t) => t.isp === ni.isp); if (!cur) return;
  const gateMs = new Date(cur.ts).getTime() + 75 * 60000;
  const has = db.prepare('SELECT 1 FROM wind_lock WHERE date_ro=? AND isp=?'), ins = db.prepare('INSERT OR IGNORE INTO wind_lock(date_ro, isp, mw_fc, ws_fc, mw_last, locked_at) VALUES (?,?,?,?,?,?)');
  let P = null;
  for (const { isp, ts } of dayTimestamps(ni.date)) {
    const T = new Date(ts).getTime(); if (T >= gateMs || T < gateMs - 15 * 60000) continue; if (has.get(ni.date, isp)) continue;
    P = P || pageData(db, ni.date, ni); const mw = P.fc.get(isp); if (mw == null) continue;
    const ws = P.wsF(T); ins.run(ni.date, isp, +mw.toFixed(1), ws == null ? null : +ws.toFixed(2), P.lastMw == null ? null : +P.lastMw.toFixed(1), new Date().toISOString());
  }
}

module.exports = { ensureTables, pollFast, pollSlow, backfillIntervals, latest, composite, pageData, lockDue, PWS, METAR, ANM, DECAY };
