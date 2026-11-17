'use strict';
// ALERT MARKERS in the Predict time column (user 2026-11-17: "add the alert on the intervals it runs, so if there is a planned
// outage to show it like the hydro alert on the time column"). Read-only; three sources, all already stored:
//   1. outage_entry (Transelectrica outage list, units over 100 MW; outage_watch.js): the intervals an outage covers.
//      First interval: stop sign + MW out; intervals in between: faint stop sign; first interval after the return: tick + MW back.
//      Window = real start/end when the list gives them, the scheduled ones otherwise. An outage of 24 hours or more is marked at
//      its start and at its return only — the faint sign would sit on every row for days and say nothing about any one of them.
//   2. Mintia running: the plant's feed field averaged 30 MW or more in the interval (sen_live raw MINT) -> M + MW.
//   3. Live-feed trip alarms (trip_alarm, sources nuclear / coal / gas / Mintia unloading) on the interval they were raised.
// Outage times in the list are Romanian wall time; tooltips give CET.

const isoMin = (ms) => new Date(ms).toISOString().slice(0, 16);
const naive = (s) => (s ? Date.parse(s.length === 16 ? s + ':00Z' : s + 'Z') : NaN);
const hm = (ms) => new Date(ms - 3600000).toISOString().slice(11, 16); // Romanian wall clock -> CET
const dm = (ms) => { const d = new Date(ms - 3600000); return String(d.getUTCDate()).padStart(2, '0') + '.' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LONG_MS = 24 * 3600000; // an outage this long is marked at its start and return only
const SRC = { nuclear: 'Nuclear', coal: 'Coal', gasx: 'Gas', mint: 'Mintia' };

// pure: outage rows + per-interval Mintia MW + alarm rows -> Map isp -> { out: [...], back: [...], mint, alarms: [...] }
function build(date, outages, mint, alarms) {
  const day0 = Date.parse(date + 'T00:00:00Z'), day1 = day0 + 86400000, Q = 900000;
  const m = new Map(); const at = (isp) => m.get(isp) || m.set(isp, { out: [], back: [], mint: null, alarms: [] }).get(isp);
  for (const o of outages) {
    const from = naive(o.real_from || o.sched_from); let to = naive(o.real_to || o.sched_to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (to % Q === Q - 60000) to += 60000; // the list writes the end of a day as 23:59
    if (to <= from) continue;
    const acc = /^acc/i.test(o.type || '');
    const e = { name: `${o.plant}${o.unit ? ' ' + String(o.unit).replace(/s+/g, ' ') : ''}`, mw: o.mw, acc, from, to, real: !!o.real_from, ended: !!o.real_to, reason: o.reason };
    const short = to - from < LONG_MS;
    const i0 = Math.floor((from - day0) / Q) + 1, i1 = Math.ceil((to - day0) / Q); // first and last interval it touches (may fall outside the day)
    if (i0 >= 1 && i0 <= 96) at(i0).out.push({ ...e, start: true });
    if (short) for (let k = Math.max(1, i0 + 1); k <= Math.min(96, i1); k++) at(k).out.push({ ...e, start: false });
    if (i1 + 1 >= 1 && i1 + 1 <= 96) at(i1 + 1).back.push(e);
  }
  // the list carries a long outage as back-to-back entries (one ends 23:59, the next starts 00:00): not a return and a new stop
  for (const x of m.values()) { const cont = new Set(x.back.map((e) => e.name).filter((n) => x.out.some((e) => e.start && e.name === n))); if (cont.size) { x.back = x.back.filter((e) => !cont.has(e.name)); x.out = x.out.filter((e) => !(e.start && cont.has(e.name))); } }
  for (const [isp, v] of mint) if (v >= 30) at(isp).mint = { mw: v, start: !(mint.get(isp - 1) >= 30) };
  for (const a of alarms) if (a.isp >= 1 && a.isp <= 96) at(a.isp).alarms.push(a);
  return m;
}

const cache = new Map(); // date -> { at, m }
function marks(db, date, isToday) {
  const c = cache.get(date); if (c && Date.now() - c.at < (isToday ? 60000 : 600000)) return c.m;
  let outages = [], alarms = []; const mint = new Map();
  const d0 = isoMin(Date.parse(date + 'T00:00:00Z') - 86400000), d1 = isoMin(Date.parse(date + 'T00:00:00Z') + 86400000);
  try { outages = db.prepare('SELECT plant, unit, mw, sched_from, sched_to, real_from, real_to, type, reason FROM outage_entry WHERE COALESCE(real_from, sched_from) < ? AND COALESCE(real_to, sched_to) >= ?').all(d1, d0); } catch { /* table missing */ }
  try { for (const r of db.prepare("SELECT isp, AVG(CAST(json_extract(raw, '$.MINT') AS REAL)) v FROM sen_live WHERE date_ro=? AND raw IS NOT NULL GROUP BY isp").all(date)) if (r.v != null) mint.set(r.isp, r.v); } catch { /* no raw column */ }
  try { alarms = db.prepare("SELECT isp, source, level, drop_mw, from_mw, to_mw, feed_ms FROM trip_alarm WHERE date_ro=? AND source IN ('nuclear','coal','gasx','mint')").all(date); } catch { /* table missing */ }
  const m = build(date, outages, mint, alarms);
  if (cache.size > 12) cache.clear();
  cache.set(date, { at: Date.now(), m }); return m;
}

function html(x) {
  if (!x) return '';
  let s = '';
  const tipOut = (e) => `${e.name}, ${Math.round(e.mw)} MW, ${e.acc ? 'accidental' : 'planned'} outage ${dm(e.from)} ${hm(e.from)} – ${dm(e.to)} ${hm(e.to)} CET (${e.ended ? 'actual' : e.real ? 'started; end as scheduled' : 'as scheduled'})${e.reason ? ': ' + e.reason : ''}`;
  if (x.out.length) {
    const starts = x.out.filter((e) => e.start), acc = x.out.some((e) => e.acc);
    const mw = Math.round((starts.length ? starts : x.out).reduce((t, e) => t + (e.mw || 0), 0));
    s += ` <small class="outm${acc ? ' outacc' : ''}${starts.length ? '' : ' outrun'}" title="${esc((starts.length ? 'OUTAGE STARTS: ' : 'Outage running: ') + x.out.map(tipOut).join(' | ') + '. Source: Transelectrica outage list (units over 100 MW).')}">⛔${starts.length ? '−' + mw : ''}</small>`;
  }
  if (x.back.length) s += ` <small class="outm outback" title="${esc('BACK FROM OUTAGE: ' + x.back.map(tipOut).join(' | ') + '. The unit is available again; whether it produces depends on its schedule.')}">✔+${Math.round(x.back.reduce((t, e) => t + (e.mw || 0), 0))}</small>`;
  if (x.mint) s += ` <small class="mintm" title="${esc(`Mintia ${x.mint.start ? 'STARTED in this interval' : 'running'}: ${Math.round(x.mint.mw)} MW average (live feed). Test runs were not in the day-ahead plan: at 250 MW or more the system was in surplus in 87% of intervals. Once the unit is commercial and in the plan this no longer holds.`)}">Ⓜ${Math.round(x.mint.mw)}</small>`;
  for (const a of x.alarms) s += ` <small class="tripm${a.level === 'trip' ? ' tripred' : ''}" title="${esc(`${a.level === 'trip' ? 'UNIT TRIP' : 'Unloading'} alarm: ${SRC[a.source] || a.source} ${Math.round(a.from_mw)} → ${Math.round(a.to_mw)} MW${a.feed_ms ? ' at ' + hm(a.feed_ms) + ' CET' : ''} (live feed)`)}">⚠${Math.round(Math.abs(a.drop_mw || 0))}</small>`;
  return s;
}

module.exports = { marks, html, build };
