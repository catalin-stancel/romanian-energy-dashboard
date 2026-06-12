// Quick sanity report on market.db contents.
const { openDb } = require('./db');
const db = openDb();

const weather = db.prepare(`
  SELECT model, var, COUNT(*) n, ROUND(AVG(value), 1) avg
  FROM weather WHERE point = 'dobrogea_n' GROUP BY model, var ORDER BY model, var
`).all();
console.log('weather @ dobrogea_n:');
console.table(weather);

const sample = db.prepare(`
  SELECT ts_utc, value FROM weather
  WHERE point = 'dobrogea_n' AND var = 'wind_speed_100m' AND model = 'ecmwf_ifs025'
  ORDER BY ts_utc LIMIT 5
`).all();
console.log('ecmwf 100m wind sample:');
console.table(sample);

const series = db.prepare(`
  SELECT series, COUNT(*) n, MIN(date_ro) from_d, MAX(date_ro) to_d
  FROM series GROUP BY series ORDER BY series
`).all();
console.log(`series table: ${series.length} series`);
if (series.length) console.table(series);
