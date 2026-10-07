// Gap-fill sen_live from Transelectrica's SEN-grafic widget (serves ~10-min SCADA history for any date):
//   node import_sen_history.js 2026-09-28 2026-10-01
// Only intervals (date, isp) with NO recorded rows are filled, so live recordings are never mixed with imports.
// Column order verified 2026-10-07 against our own recording (per-isp MAE ≤ 35 MW on every field):
//   f1 cons, f2 planned cons, f3 prod, f4 sold, f5 coal, f6 gas, f7 hydro, f8 nuclear, f9 wind, f10 solar, f11 biomass
const { openDb } = require('./db'); const senFilter = require('./sen_filter');
const [from, to] = process.argv.slice(2); if (!from) { console.error('usage: import_sen_history.js <from> [to]'); process.exit(1); }
const days = []; for (let t = Date.parse(from + 'T12:00:00Z'); t <= Date.parse((to || from) + 'T12:00:00Z'); t += 86400e3) days.push(new Date(t).toISOString().slice(0, 10));
const num = (v) => { const n = Number(v); return v !== '' && Number.isFinite(n) ? n : null; };
(async () => {
  const db = openDb(); senFilter.ensureTable(db); senFilter.ensureIntervalTable(db);
  const ins = db.prepare('INSERT OR IGNORE INTO sen_live (pulled_at, ts_feed, date_ro, isp, ts_ms, sold, plan, prod, cons, coal, gas, nuclear, hydro, wind, solar, biomass, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  let total = 0;
  for (const d of days) {
    const [Y, M, D] = d.split('-').map(Number); const pre = '&_SENGrafic_WAR_SENGraficportlet_';
    const u = 'https://www.transelectrica.ro/widget/web/tel/sen-grafic?p_p_id=SENGrafic_WAR_SENGraficportlet&p_p_lifecycle=2&p_p_state=maximized&p_p_mode=view&p_p_cacheability=cacheLevelPage' + pre + 'random=' + Date.now() + pre + 'start_day=' + D + pre + 'start_month=' + M + pre + 'start_year=' + Y + pre + 'start_Hour=0' + pre + 'start_Minute=0' + pre + 'end_day=' + D + pre + 'end_month=' + M + pre + 'end_year=' + Y + pre + 'end_Hour=23' + pre + 'end_Minute=59';
    let txt; try { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(30000) }); txt = r.ok ? await r.text() : ''; } catch (e) { console.warn(d + ': fetch failed ' + e.message); continue; }
    const have = new Set(db.prepare('SELECT DISTINCT isp FROM sen_live WHERE date_ro=?').all(d).map((r) => r.isp));
    const rows = txt.split('|').map((r) => r.split(';')).filter((f) => f.length >= 12);
    const imported = new Date().toISOString(); let n = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const f of rows) {
        const m = /(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):?(\d{2})?/.exec(f[0].trim()); if (!m) continue;
        const h = +m[4], mi = +m[5], s = +(m[6] || 0); const isp = Math.floor((h * 60 + mi) / 15) + 1; if (have.has(isp)) continue;
        const tsMs = Date.UTC(Y, M - 1, D, h, mi, s); const tsFeed = `${String(Y).slice(2)}/${M}/${D} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        const v = f.map(num);
        n += ins.run(imported, tsFeed, d, isp, tsMs, v[4], null, v[3], v[1], v[5], v[6], v[8], v[7], v[9], v[10], v[11], JSON.stringify({ source: 'sen-grafic import', fields: f.slice(0, 12) })).changes;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    total += n; console.log(`${d}: ${rows.length} widget rows, ${have.size} isps already recorded, +${n} imported`);
  }
  const ni = senFilter.backfillIntervals(db, { maxNew: 2000 });
  console.log(`total +${total} rows · sen_interval +${ni}`);
})().catch((e) => { console.error(e); process.exit(1); });
