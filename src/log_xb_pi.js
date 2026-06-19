// X-B PI trajectory logger (append-only). Every run, snapshot the NET cross-border position by timeframe
// (dayAhead / intraday(PI) / longTerm / commercial) for every UPCOMING delivery interval, keyed by pull time.
// Purpose: capture how intraday (PI) trading moves a delivery interval's position through the day, so we can
// later test whether that belief-updating (the PI evolution) LEADS the realized imbalance.
//   node tool/log_xb_pi.js     (schedule every ~10 min)
const { openDb, roDateIsp } = require('./db');
const BASE = 'https://newmarkets.transelectrica.ro/usy-durom-publicreportg01/00121002500000000000000000000100/';
const num = (v) => { const n = Number(v); return v !== null && v !== undefined && v !== 'N/A' && Number.isFinite(n) ? n : null; };
const EXPB = ['rohu', 'robg', 'rors', 'roua', 'romd'], IMPB = ['huro', 'bgro', 'rsro', 'uaro', 'mdro'];

(async () => {
  const db = openDb();
  db.exec('CREATE TABLE IF NOT EXISTS xb_pi_snap(pulled_at TEXT, ts_utc TEXT, date_ro TEXT, isp INTEGER, d1 REAL, pi REAL, lt REAL, commercial REAL)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_xbsnap ON xb_pi_snap(ts_utc, pulled_at)');
  const todayUtc = new Date().toISOString().slice(0, 10);
  const from = new Date(todayUtc + 'T00:00:00Z').toISOString();
  const to = new Date(new Date(todayUtc + 'T00:00:00Z').getTime() + 2 * 86400000).toISOString(); // today + tomorrow
  const u = new URL(BASE + 'publicReport/scheduledExchanges');
  u.searchParams.set('timeInterval', JSON.stringify({ from, to }));
  const items = (await (await fetch(u)).json()).itemList || [];
  const pulledAt = new Date().toISOString();
  const nowMs = Date.now();
  const netTf = (item, tf) => { let s = 0, any = false; for (const b of EXPB) { const o = item[b]; const v = o ? num(o[tf]) : null; if (v !== null) { s += v; any = true; } } for (const b of IMPB) { const o = item[b]; const v = o ? num(o[tf]) : null; if (v !== null) { s -= v; any = true; } } return any ? s : null; };
  const snap = db.prepare('INSERT INTO xb_pi_snap VALUES (?,?,?,?,?,?,?,?)');
  // DEDUP: only append a frame when the net position CHANGED since this interval's last frame, so we can poll
  // every 60s (catch the heavy last-5-min trading) while storing only real belief-moves — flat intervals cost 0.
  const lastMap = new Map();
  for (const r of db.prepare('SELECT ts_utc, pi, commercial, MAX(pulled_at) mp FROM xb_pi_snap WHERE ts_utc > ? GROUP BY ts_utc').all(new Date(nowMs).toISOString())) lastMap.set(r.ts_utc, r);
  let n = 0;
  db.exec('BEGIN');
  for (const item of items) {
    const ts = item.timeInterval && item.timeInterval.from;
    if (!ts || new Date(ts).getTime() <= nowMs) continue; // only pre-delivery (upcoming) intervals
    const cm = netTf(item, 'commercial');
    if (cm === null) continue;
    const pi = netTf(item, 'intraday');
    const prev = lastMap.get(ts);
    if (prev && Math.abs(cm - prev.commercial) < 0.5 && Math.abs((pi ?? 0) - (prev.pi ?? 0)) < 0.5) continue; // unchanged → skip
    const ri = roDateIsp(new Date(ts));
    snap.run(pulledAt, ts, ri.date, ri.isp, netTf(item, 'dayAhead'), pi, netTf(item, 'longTerm'), cm);
    n++;
  }
  db.exec('COMMIT');
  console.log(`xb_pi_snap +${n} changed rows @ ${pulledAt}`);

  // --- SEN (real prod/cons/sold), fetched once and shared by the X-B Δ + live_log captures below ---
  const sen = new Map(); // isp -> {prod, cons, sold} for today (RO); Real X-B = −sold
  try {
    const riNow = roDateIsp(new Date());
    const pre = '&_SENGrafic_WAR_SENGraficportlet_';
    const [yy, mm, dd] = riNow.date.split('-');
    const su = 'https://www.transelectrica.ro/widget/web/tel/sen-grafic?p_p_id=SENGrafic_WAR_SENGraficportlet&p_p_lifecycle=2&p_p_state=maximized&p_p_mode=view&p_p_cacheability=cacheLevelPage'
      + pre + 'random=' + Date.now()
      + pre + 'start_day=' + (+dd) + pre + 'start_month=' + (+mm) + pre + 'start_year=' + yy + pre + 'start_Hour=0' + pre + 'start_Minute=0'
      + pre + 'end_day=' + (+dd) + pre + 'end_month=' + (+mm) + pre + 'end_year=' + yy + pre + 'end_Hour=23' + pre + 'end_Minute=59';
    const sr = await fetch(su, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*', 'X-Requested-With': 'XMLHttpRequest' } });
    if (sr.ok) {
      const tx = await sr.text();
      for (const row of tx.split('|')) { const f = row.split(';'); if (f.length < 12) continue; const t = /(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})/.exec(f[0].trim()); if (!t) continue; const isp = Math.floor((+t[4] * 60 + +t[5]) / 15) + 1; sen.set(isp, { prod: +f[3], cons: +f[1], sold: +f[4] }); }
    }
  } catch (e) { console.error('SEN fetch failed:', e.message); }

  // --- X-B Δ trajectory (REALIZED side): Real X-B − Notif X-B for current + recently-delivered intervals,
  // so the UI shows an interval-AVERAGE + drift arrow (the SEN side keeps firming after the PI gate closes).
  db.exec('CREATE TABLE IF NOT EXISTS xb_delta_snap(pulled_at TEXT, ts_utc TEXT, date_ro TEXT, isp INTEGER, real_xb REAL, notif_xb REAL, delta REAL)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_xbdelta ON xb_delta_snap(ts_utc, pulled_at)');
  try {
    if (sen.size) {
      const lastD = new Map();
      for (const r of db.prepare('SELECT ts_utc, delta, MAX(pulled_at) m FROM xb_delta_snap WHERE ts_utc>? GROUP BY ts_utc').all(new Date(nowMs - 3 * 3600000).toISOString())) lastD.set(r.ts_utc, r.delta);
      const insD = db.prepare('INSERT INTO xb_delta_snap VALUES (?,?,?,?,?,?,?)');
      let dN = 0; db.exec('BEGIN');
      for (const item of items) {
        const ts = item.timeInterval && item.timeInterval.from; if (!ts) continue;
        const tms = new Date(ts).getTime();
        if (tms > nowMs || tms < nowMs - 3 * 3600000) continue; // current + last ~3h of delivered intervals
        const r2 = roDateIsp(new Date(ts)); const se = sen.get(r2.isp); const s = se ? se.sold : undefined; if (s === undefined || !Number.isFinite(s)) continue;
        const notif = netTf(item, 'commercial'); if (notif === null) continue;
        const real = -s, delta = real - notif;
        const prev = lastD.get(ts);
        if (prev !== undefined && Math.abs(delta - prev) < 1) continue; // unchanged → skip (dedup)
        insD.run(pulledAt, ts, r2.date, r2.isp, real, notif, delta); dN++;
      }
      db.exec('COMMIT');
      console.log(`xb_delta_snap +${dN} changed rows`);
    } else { console.log('xb_delta_snap: SEN unavailable, skipped'); }
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} console.error('xb_delta record failed:', e.message); }

  // --- FULL live-value trajectory: append EVERY changed value each 60s (no granularity lost between the 5-min
  // canonical pulls) for the fast-revising values — imbalance, est prices, balancing qty/value, SEN — into live_log.
  db.exec('CREATE TABLE IF NOT EXISTS live_log(pulled_at TEXT, ts_utc TEXT, date_ro TEXT, isp INTEGER, series TEXT, value REAL)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_livelog ON live_log(series, ts_utc, pulled_at)');
  try {
    const winFrom = Date.parse(from); // start of today (UTC). NOTE: query the day-aligned window (from/to) — a narrow window returns sparse items missing the imbalance/ISP fields.
    const lastLL = new Map();
    for (const r of db.prepare('SELECT series, ts_utc, value, MAX(pulled_at) m FROM live_log WHERE ts_utc >= ? GROUP BY series, ts_utc').all(from)) lastLL.set(r.series + '|' + r.ts_utc, r.value);
    const ll = db.prepare('INSERT INTO live_log VALUES (?,?,?,?,?,?)');
    const append = (series, ts, ri, v) => { if (v === null || !Number.isFinite(v)) return 0; const k = series + '|' + ts; const prev = lastLL.get(k); if (prev !== undefined && Math.abs(v - prev) < 0.01) return 0; lastLL.set(k, v); ll.run(pulledAt, ts, ri.date, ri.isp, series, v); return 1; };
    const FIELD = { estimatedSystemImbalance: 'damas_est_sys_imbalance', estimatedPricePositiveImbalance: 'damas_est_price_pos', estimatedPriceNegativeImbalance: 'damas_est_price_neg', sumQup: 'damas_qup', sumQdn: 'damas_qdn', sumQupPup: 'damas_qup_value', sumQdownPdn: 'damas_qdn_value' };
    const eu = new URL(BASE + 'publicReport/estimatedImbalancePrices');
    eu.searchParams.set('timeInterval', JSON.stringify({ from, to }));
    const eItems = (await (await fetch(eu)).json()).itemList || [];
    let llN = 0; db.exec('BEGIN');
    for (const it of eItems) {
      const ts = it.timeInterval && it.timeInterval.from; if (!ts) continue;
      const tms = new Date(ts).getTime(); if (tms > nowMs || tms < winFrom) continue; // delivered/current only
      const ri = roDateIsp(new Date(ts));
      for (const [f, series] of Object.entries(FIELD)) llN += append(series, ts, ri, num(it[f]));
      const se = sen.get(ri.isp); if (se) { llN += append('sen_prod', ts, ri, se.prod); llN += append('sen_cons', ts, ri, se.cons); llN += append('sen_sold', ts, ri, se.sold); }
    }
    db.exec('COMMIT');
    console.log(`live_log +${llN} changed values`);
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} console.error('live_log record failed:', e.message); }

  // --- sen-filter homepage SCADA snapshots (24/7 capture for prediction): poll ~5x at 10s within this run,
  // recording each DISTINCT snapshot (deduped by SCADA timestamp) to sen_live. Decode/schema in sen_filter.js. ---
  try {
    const senFilter = require('./sen_filter');
    senFilter.ensureTable(db);
    let sn = 0;
    for (let i = 0; i < 5; i++) {
      try { const d = await senFilter.fetchSenFilter(); if (d && senFilter.record(db, d, roDateIsp)) sn++; } catch { /* transient */ }
      if (i < 4) await new Promise((r) => setTimeout(r, 10000));
    }
    console.log(`sen_live +${sn} snapshots`);
  } catch (e) { console.error('sen_filter capture failed:', e.message); }
})().catch((e) => { console.error(e); process.exit(1); });
