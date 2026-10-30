// Pull multi-model weather forecasts from Open-Meteo into market.db (table: weather).
// Keyless API. NOTE: free tier is non-commercial — license or switch to DWD ICON open data for production.
//
//   node tool\pull_weather.js          (pull current forecast run, all points/models)
//
// Every pull is stored with pulled_at so run-to-run forecast revisions can be computed later.
const { beginImmediate, openDb, logPull } = require('./db');

const POINTS = {
  // Dobrogea wind belt (most of RO's ~3 GW wind)
  dobrogea_n: { lat: 44.75, lon: 28.65 },
  dobrogea_s: { lat: 44.35, lon: 28.40 },
  // load + solar proxies
  bucharest: { lat: 44.43, lon: 26.10 },
  oltenia: { lat: 44.32, lon: 23.80 },
};
const MODELS = ['ecmwf_ifs025', 'icon_seamless', 'gfs_seamless'];
const VARS = ['wind_speed_100m', 'wind_direction_100m', 'temperature_2m', 'shortwave_radiation', 'cloud_cover', 'precipitation'];

async function main() {
  const db = openDb();
  const stmt = db.prepare('INSERT OR IGNORE INTO weather (point, model, var, ts_utc, pulled_at, value) VALUES (?,?,?,?,?,?)');
  const pulledAt = new Date().toISOString().slice(0, 16) + 'Z';
  let total = 0;
  for (const [name, { lat, lon }] of Object.entries(POINTS)) {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', lat);
    url.searchParams.set('longitude', lon);
    url.searchParams.set('hourly', VARS.join(','));
    url.searchParams.set('models', MODELS.join(','));
    url.searchParams.set('past_days', '1');
    url.searchParams.set('forecast_days', '3');
    url.searchParams.set('timezone', 'UTC');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo ${res.status} for ${name}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const hourly = data.hourly;
    const times = hourly.time; // ISO, UTC
    beginImmediate(db);
    for (const model of MODELS) {
      for (const v of VARS) {
        const series = hourly[`${v}_${model}`] ?? (MODELS.length === 1 ? hourly[v] : undefined);
        if (!series) continue;
        for (let i = 0; i < times.length; i++) {
          if (series[i] === null || series[i] === undefined) continue;
          stmt.run(name, model, v, times[i] + ':00Z', pulledAt, series[i]); // Open-Meteo gives "YYYY-MM-DDTHH:MM"
          total++;
        }
      }
    }
    db.exec('COMMIT');
    console.log(`${name}: ok`);
  }
  logPull(db, 'open-meteo', Object.keys(POINTS).join(','), pulledAt, new Date().toISOString(), total, null);
  console.log(`stored ${total} weather points (pulled_at=${pulledAt})`);
  // refresh the fast per-hour ensemble-mean table (weather_hourly) for this run — the app reads THIS, not the 2.4M-row raw table
  db.exec('CREATE TABLE IF NOT EXISTS weather_hourly(ts_utc TEXT, var TEXT, value REAL, pulled_at TEXT, PRIMARY KEY(ts_utc,var))');
  const nh = db.prepare('INSERT OR REPLACE INTO weather_hourly(ts_utc,var,value,pulled_at) SELECT ts_utc, var, AVG(value), pulled_at FROM weather WHERE pulled_at=? GROUP BY ts_utc, var').run(pulledAt);
  console.log(`weather_hourly refreshed: ${nh.changes} (ts,var) rows from this run`);
  // RETENTION (2026-10-30): raw runs older than WEATHER_KEEP_DAYS (default 90) go; weather_hourly keeps the latest-run mean for
  // every hour forever, which is what the pages and the RES model read. One bounded batch per hourly run (20k rows > the ~6k/h
  // inflow) so the delete never holds the lock long or grows the WAL on the nearly full Render disk. The one-off backlog was
  // pruned by hand (5.7M rows) the same day. Freed pages are reused, the file does not shrink (no VACUUM on a 2 GB container).
  const keepDays = Number(process.env.WEATHER_KEEP_DAYS || 90);
  if (keepDays > 0) {
    const cut = new Date(Date.now() - keepDays * 86400000).toISOString().slice(0, 16) + 'Z';
    const del = db.prepare('DELETE FROM weather WHERE rowid IN (SELECT rowid FROM weather WHERE pulled_at < ? LIMIT 20000)');
    let deleted = 0;
    for (let i = 0; i < 5; i++) { // up to 5 short batches per run: a backlog drains at ~100k rows/h, steady state is one batch
      beginImmediate(db); const n = del.run(cut).changes; db.exec('COMMIT');
      deleted += n; if (n < 20000) break;
    }
    if (deleted) console.log(`retention: deleted ${deleted} raw weather rows pulled before ${cut}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
