'use strict';
// OUTAGE-FILE WATCHER (user 2026-11-16: "add a listener on the Transelectrica file and react on new entries there").
// Transelectrica, Producție page, point 5: "7productie5.xls" = units over 100 MW withdrawn or tripped, one sheet per day, served
// from Google Drive. Every 3 minutes the server asks for the file's Last-Modified header (no download); when it changes the file
// is downloaded, parsed and compared with the entries already seen (table outage_entry). Reactions go through trip_alarm:
//   new ACCIDENTAL entry still running            -> red banner   (level trip)
//   new accidental entry already over, a new planned entry that is running or starts within 24 h, or an accidental entry whose
//   end was pushed later by an hour or more       -> amber banner (level warn)
// The first run only records what is there. Measured on 2026-11-16: the Brazi trip of 02:13 was in the file version stamped
// 08:00 Romanian time, so the file confirms and names a trip hours later — the live-feed rule in trip_alarm.js stays the fast
// detector, this one adds the unit name, the reason, the expected return time and outages the feed cannot show in advance.
// The Drive id can change: if the file name served is no longer 7productie5.xls the id is looked up again on the page.
const XLSX = require('xlsx');
const tripAlarm = require('./trip_alarm');

const PAGE = 'https://www.transelectrica.ro/ro/web/tel/productie';
const FILE_NAME = '7productie5.xls';
const DEFAULT_ID = '1MboTufcvew_DLWY4JhEWld-9frvN1n0J';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
const POLL_MS = 180000, MAX_ALARMS = 4;
const st = { id: DEFAULT_ID, lastModified: null, lastChecked: null, lastParsed: null, lastError: null, entries: 0, running: false };

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS outage_entry (
    key TEXT PRIMARY KEY, first_seen TEXT, last_seen TEXT, sheet TEXT, plant TEXT, unit TEXT, tech TEXT, area TEXT, mw REAL,
    sched_from TEXT, sched_to TEXT, real_from TEXT, real_to TEXT, type TEXT, reason TEXT
  );
  CREATE TABLE IF NOT EXISTS outage_file_log (modified TEXT PRIMARY KEY, seen_at TEXT, entries INTEGER, new_entries INTEGER, changed INTEGER);`);
  try { const r = db.prepare('SELECT modified FROM outage_file_log ORDER BY seen_at DESC LIMIT 1').get(); if (r) st.lastModified = r.modified; } catch { /* empty */ }
}

const driveUrl = (id) => `https://drive.usercontent.google.com/download?id=${id}&export=download`;
async function head(id) {
  const r = await fetch(driveUrl(id), { method: 'HEAD', headers: UA, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HEAD ' + r.status);
  const cd = r.headers.get('content-disposition') || '';
  return { modified: r.headers.get('last-modified'), name: (cd.match(/filename="?([^";]+)"?/) || [])[1] || null };
}
async function findId() { // look the Drive link up again on the Producție page (the one that serves 7productie5.xls)
  const r = await fetch(PAGE, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('page ' + r.status);
  const ids = [...new Set([...(await r.text()).matchAll(/drive\.google\.com\/uc\?export=download(?:&amp;|&)id=([A-Za-z0-9_-]+)/g)].map((m) => m[1]))];
  for (const id of ids) { try { const h = await head(id); if (h.name === FILE_NAME) return id; } catch { /* next */ } }
  throw new Error('no link on the page serves ' + FILE_NAME);
}
async function download(id) {
  const r = await fetch(driveUrl(id), { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('GET ' + r.status);
  const b = Buffer.from(await r.arrayBuffer());
  if (b.length < 20000 || b.length > 20e6) throw new Error('unexpected size ' + b.length);
  return b;
}

// "16.11.2026 02:13 - 16.11.2026 04:00" -> ['2026-11-16T02:13', '2026-11-16T04:00'] (Romanian local time, kept naive)
function interval(s) {
  const m = [...String(s || '').matchAll(/(\d{2})\.(\d{2})\.(\d{4})\D{0,3}(\d{1,2}):(\d{2})/g)].map((x) => `${x[3]}-${x[2]}-${x[1]}T${x[4].padStart(2, '0')}:${x[5]}`);
  return [m[0] || null, m[1] || null];
}
function parse(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const out = new Map();
  for (const name of wb.SheetNames) {
    if (/program/i.test(name)) continue; // start-up programme sheets
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true });
    const hi = rows.findIndex((r) => r.some((c) => /Nume Centrala/i.test(String(c))));
    if (hi < 0) continue;
    const H = rows[hi].map((c) => String(c).trim());
    const col = (re) => H.findIndex((c) => re.test(c));
    const c = { plant: col(/Nume Centrala/i), unit: col(/Denumire unitate/i), tech: col(/Tip tehnologie/i), area: col(/Localizare/i), mw: col(/Putere Instalata/i),
      sched: col(/Interval programat/i), real: col(/Interval realizat/i), type: col(/Tip retragere/i), reason: col(/Motivul/i) };
    if (c.plant < 0 || c.sched < 0) continue;
    for (const r of rows.slice(hi + 1)) {
      const plant = String(r[c.plant] || '').trim(), [from, to] = interval(r[c.sched]);
      if (!plant || /Power plant name/i.test(plant) || !from) continue;
      const [rf, rt] = c.real >= 0 ? interval(r[c.real]) : [null, null];
      const e = { sheet: name, plant, unit: String(r[c.unit] || '').trim(), tech: String(r[c.tech] || '').trim(), area: String(r[c.area] || '').trim(), mw: Number(r[c.mw]) || null,
        sched_from: from, sched_to: to, real_from: rf, real_to: rt, type: String(r[c.type] || '').trim(), reason: String(r[c.reason] || '').trim().replace(/\s+/g, ' ') };
      e.key = `${e.plant}|${e.unit}|${e.sched_from}`;
      out.set(e.key, e); // later sheets overwrite: the newest day carries the latest end times
    }
  }
  return [...out.values()];
}

const accidental = (e) => /^acc/i.test(e.type);
const roNowNaive = () => new Date(new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Bucharest' }).replace(' ', 'T') + 'Z').getTime();
const ms = (s) => (s ? Date.parse(s + ':00Z') : null);
const hm = (s) => (s ? `${s.slice(8, 10)}.${s.slice(5, 7)} ${s.slice(11, 16)}` : '?');
const SRC = (tech) => (/uran/i.test(tech) ? 'nuclear' : /carbun/i.test(tech) ? 'coal' : /gaz/i.test(tech) ? 'gasx' : null);

// Compare a parsed file with the stored entries; returns what to store and what to announce. Pure (no I/O) so it can be tested.
function diff(entries, known, nowNaive, seeded) {
  const res = { insert: [], update: [], alarms: [] };
  for (const e of entries) {
    const k = known.get(e.key);
    const from = ms(e.real_from || e.sched_from), end = ms(e.real_to || e.sched_to), over = e.real_to ? ms(e.real_to) <= nowNaive : end != null && end <= nowNaive;
    const what = `${e.plant} ${e.unit}${e.mw ? ' (' + Math.round(e.mw) + ' MW' + (e.tech ? ', ' + e.tech : '') + ')' : ''}`;
    const span = `${hm(e.real_from || e.sched_from)} → ${e.real_to ? hm(e.real_to) + ' (ended)' : hm(e.sched_to) + ' (scheduled)'}`;
    if (!k) {
      res.insert.push(e);
      if (!seeded) continue; // first run: record only
      if (accidental(e)) {
        if (nowNaive - from > 36 * 3600000) continue; // an old row appearing late is not news
        const fa = tripAlarm.findFeedAlarm(SRC(e.tech), from, 25 * 60000);
        res.alarms.push({ level: over ? 'warn' : 'trip', title: over ? `Outage listed · ${e.plant} ${e.unit}` : `OUTAGE LISTED · ${e.plant} ${e.unit}${e.mw ? ' −' + Math.round(e.mw) + ' MW' : ''}`,
          text: `Transelectrica lists an accidental outage: ${what} · ${span} · reason: ${e.reason || 'not given'}${fa ? ' · matches the live-feed alarm at ' + new Date(fa.feed_ms).toISOString().slice(11, 16) : ''}` });
      } else if (!over && from - nowNaive < 24 * 3600000) {
        res.alarms.push({ level: 'warn', title: `Planned outage listed · ${e.plant} ${e.unit}`, text: `Transelectrica lists a planned withdrawal: ${what} · ${span} · reason: ${e.reason || 'not given'}` });
      }
    } else if (k.sched_to !== e.sched_to || (k.real_to || null) !== (e.real_to || null) || (k.real_from || null) !== (e.real_from || null) || k.reason !== e.reason) {
      res.update.push(e);
      const later = ms(e.sched_to) != null && ms(k.sched_to) != null && ms(e.sched_to) - ms(k.sched_to) >= 3600000;
      if (seeded && accidental(e) && later && !e.real_to && ms(e.sched_to) > nowNaive) {
        res.alarms.push({ level: 'warn', title: `Outage extended · ${e.plant} ${e.unit}`, text: `Transelectrica moved the return of ${what} from ${hm(k.sched_to)} to ${hm(e.sched_to)} · reason: ${e.reason || 'not given'}` });
      }
    }
  }
  return res;
}

// One poll. Network + parse are async / outside any request handler; the write is one BEGIN IMMEDIATE transaction.
async function poll(db) {
  if (st.running) return null; st.running = true;
  try {
    let h;
    try { h = await head(st.id); if (h.name && h.name !== FILE_NAME) throw new Error('link now serves ' + h.name); }
    catch (e) { st.id = await findId(); h = await head(st.id); }
    st.lastChecked = new Date().toISOString(); st.lastError = null;
    if (!h.modified || h.modified === st.lastModified) return { changed: false };
    const entries = parse(await download(st.id));
    if (!entries.length) throw new Error('no entries parsed');
    const known = new Map(db.prepare('SELECT * FROM outage_entry').all().map((r) => [r.key, r]));
    const d = diff(entries, known, roNowNaive(), known.size > 0);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const ins = db.prepare('INSERT OR REPLACE INTO outage_entry(key, first_seen, last_seen, sheet, plant, unit, tech, area, mw, sched_from, sched_to, real_from, real_to, type, reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const e of d.insert) ins.run(e.key, now, now, e.sheet, e.plant, e.unit, e.tech, e.area, e.mw, e.sched_from, e.sched_to, e.real_from, e.real_to, e.type, e.reason);
      for (const e of d.update) ins.run(e.key, known.get(e.key).first_seen, now, e.sheet, e.plant, e.unit, e.tech, e.area, e.mw, e.sched_from, e.sched_to, e.real_from, e.real_to, e.type, e.reason);
      db.prepare('INSERT OR REPLACE INTO outage_file_log(modified, seen_at, entries, new_entries, changed) VALUES (?,?,?,?,?)').run(h.modified, now, entries.length, d.insert.length, d.update.length);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    for (const a of d.alarms.slice(0, MAX_ALARMS)) tripAlarm.raiseExternal(db, a);
    st.lastModified = h.modified; st.lastParsed = now; st.entries = entries.length;
    return { changed: true, modified: h.modified, entries: entries.length, added: d.insert.length, updated: d.update.length, alarms: d.alarms.length, seeded: known.size > 0 };
  } catch (e) { st.lastError = e.message; throw e; } finally { st.running = false; }
}

// read-only status for the API: file state + the accidental outages still running
function status(db) {
  const out = { file: FILE_NAME, lastModified: st.lastModified, lastChecked: st.lastChecked, lastError: st.lastError, running: [] };
  try {
    const now = roNowNaive();
    out.running = db.prepare("SELECT plant, unit, tech, mw, sched_from, sched_to, real_to, type, reason FROM outage_entry WHERE type LIKE 'Acc%' ORDER BY sched_from DESC LIMIT 40").all()
      .filter((e) => !e.real_to && ms(e.sched_to) != null && ms(e.sched_to) > now && ms(e.sched_from) <= now);
  } catch { /* table missing */ }
  return out;
}

module.exports = { ensureTable, poll, status, parse, diff, interval, POLL_MS, FILE_NAME };
