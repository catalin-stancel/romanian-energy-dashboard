'use strict';
// UNIT-TRIP ALARM (user 2026-11-16: "an alarm for when an accident happens — the best indicator of high prices").
// Watches the live Transelectrica feed (sen-filter, ~10 s) for a SUDDEN loss of dispatchable generation:
//   nuclear, coal, gas (without Mintia): the fleet output falls by >= 200 MW within 3 minutes and the next reading confirms it
//   Mintia: >= 150 MW within 5 minutes (its stops are controlled but run ahead of its plan field) -> warning level
// A scheduled ramp is slower than that; a trip is a step. Hydro, wind, solar and batteries are excluded: they move this fast all day.
// Backtest on the stored feed, 1 Jul - 16 Nov 2026 (scratchpad trip_bt.js), nuclear/coal/gas rule: 10 alarms; in 7 the price went
// above 2,500 RON within the next four intervals (base rate of any interval: 6%), in 8 a deficit over 50 MW followed; median peak
// price 3,536. Known trips caught: Brazi 22/23 Oct, 3 Nov and 16 Nov (-281 MW in one minute at 02:13), Rovinari 5 on 15 Nov
// (-284 MW), Turceni/Rovinari 1 Sep and 29 Oct, Cernavoda stops 19 and 22 Aug. Mintia rule: 9 warnings, deficits after 7.
// The dispatcher's mFRR up arrives about one interval after the trip; the price peak follows 2-4 intervals later.
// MINTIA START (user 2026-11-17: "build a live alert when mintia starts"): the plant's feed field read 10 MW or less for at least
// 3 minutes, then 30 MW or more on two readings in a row -> info level (blue banner, 4 beeps). Replay 1 Oct - 17 Nov: 15 alarms for the
// 15 starts with an unbroken log, each 17-97 s after the first reading at 30 MW or more, no false start (5 Nov began inside a log gap); in November the unit then passed 100 MW 1-5 minutes after the start and 250 MW after 7-18.
// Detection runs on a 20-s server timer (never in a request handler); the page polls /api/trip_alarm.

const RULES = [
  { key: 'nuclear', label: 'Nuclear', X: 200, W: 180, level: 'trip' },
  { key: 'coal', label: 'Coal', X: 200, W: 180, level: 'trip' },
  { key: 'gasx', label: 'Gas', X: 200, W: 180, level: 'trip' },
  { key: 'mint', label: 'Mintia', X: 150, W: 300, level: 'warn' },
];
const CONFIRM = 0.7;            // the next reading must still be down by 70% of the threshold
const COOLDOWN_MS = 45 * 60000; // one alarm per source per 45 minutes
const ACTIVE_MS = 90 * 60000;   // an alarm stays on screen for 90 minutes unless the output recovers
const RECOVER = 0.3;            // cleared when the output is back within 30% of the drop
const KEEP_MS = 12 * 60000;     // reading buffer
const STATS = 'Jul–Nov 2026: 10 drops of this kind, 7 followed by a price above 2,500 RON within the hour (any interval: 6%), 8 by a deficit over 50 MW. mFRR up usually arrives one interval later.';
const START_ON = 30, START_OFF = 10, START_QUIET_MS = 180000; // Mintia start: off level, on level, how long it must have been off
const STATS_START = 'November 2026 starts: 100 MW within 1–5 minutes, 250 MW within 7–18 minutes when the run goes that far. Test runs were not in the day-ahead plan: at 250 MW or more the system was in surplus in 87% of intervals, average price 612 RON against 1,941 otherwise. Turbine 1 was announced to go commercial in the week of 16 Nov; once its runs are in the day-ahead plan a start no longer means un-notified surplus.';
const STATS_MINT = 'Mintia unloads ahead of its plan field: 9 such drops since October, a deficit followed in 7.';
const OUTAGE_URL = 'https://www.transelectrica.ro/ro/web/tel/productie';

const buf = [];           // { ts, nuclear, coal, gasx, mint, mintPlan, sold, plan, storage }
const pending = {};       // key -> { pre, preTs, ts }
const mintState = { on: null, since: 0, lastOff: 0 }; // Mintia on/off as read from the feed (unknown after a restart: no start alarm until it has been seen off)
const lastRaised = {};    // key -> feed ts of the last alarm
let alarms = [];          // newest first; rows as stored
let seq = 0;

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS trip_alarm (
    id INTEGER PRIMARY KEY AUTOINCREMENT, raised_at TEXT NOT NULL, feed_ms INTEGER, date_ro TEXT, isp INTEGER,
    source TEXT, level TEXT, drop_mw REAL, from_mw REAL, to_mw REAL, window_s INTEGER,
    gap_mw REAL, storage_mw REAL, hint TEXT, cleared_at TEXT, cleared_why TEXT
  ); CREATE INDEX IF NOT EXISTS ix_trip_alarm_ms ON trip_alarm(feed_ms);`);
  try { db.exec('ALTER TABLE trip_alarm ADD COLUMN title TEXT'); } catch { /* exists */ } // title of an alarm raised by the outage-file watcher
}

// alarms of the last 24 h back into memory after a restart (so the banner survives and the cooldown holds)
function load(db) {
  try {
    alarms = db.prepare('SELECT * FROM trip_alarm WHERE raised_at >= ? ORDER BY id DESC').all(new Date(Date.now() - 24 * 3600000).toISOString());
    for (const a of alarms) if (a.feed_ms && (!lastRaised[a.source] || a.feed_ms > lastRaised[a.source])) lastRaised[a.source] = a.feed_ms;
  } catch { alarms = []; }
}

const r0 = (v) => Math.round(v);
function hint(key, drop, rd) {
  const d = Math.abs(drop);
  if (key === 'nuclear') return d >= 500 ? 'a Cernavodă unit stopping (about 700 MW each)' : 'a Cernavodă power reduction';
  if (key === 'coal') return d >= 420 ? 'two lignite units, or one large one with auxiliaries' : 'one lignite unit (Rovinari, Turceni or Ișalnița: 250–330 MW each)';
  if (key === 'gasx') return d >= 500 ? 'the Brazi plant (860 MW) or two of its blocks' : d >= 240 ? 'one Brazi block (gas or steam turbine, about 290–310 MW)' : 'a gas unit (Iernut 200 MW, București combined cycle 186 MW)';
  if (key === 'mint') return `Mintia unloading${rd && rd.mintPlan != null ? ' while its plan field still reads ' + r0(rd.mintPlan) + ' MW' : ''}`;
  return '';
}

// one live reading -> { raised: [...], cleared: [...] }. sf = sen_filter reading { ts, nuclear, coal, gas, sold, plan, storage, raw }.
// opts.tsMs lets a replay pass the feed time directly; opts.at = wall clock for the stored timestamps.
function feed(db, sf, roDateIsp, naiveMs, opts) {
  const out = { raised: [], cleared: [] };
  if (!sf) return out;
  const o = opts || {};
  const ts = o.tsMs != null ? o.tsMs : (sf.ts && naiveMs ? naiveMs(sf.ts) : Date.now());
  if (!Number.isFinite(ts)) return out;
  if (buf.length && ts <= buf[buf.length - 1].ts) return out; // feed not advanced
  const num = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
  const mint = sf.raw && sf.raw.MINT !== undefined ? Math.max(0, num(sf.raw.MINT) || 0) : 0;
  const rd = { ts, nuclear: num(sf.nuclear), coal: num(sf.coal), gasx: num(sf.gas) == null ? null : num(sf.gas) - mint, mint,
    mintPlan: sf.raw && sf.raw.MINT15 !== undefined ? num(sf.raw.MINT15) : null, sold: num(sf.sold), plan: num(sf.plan), storage: num(sf.storage) };
  // feed glitch: every thermal source reads zero at once
  const glitch = rd.coal != null && rd.gasx != null && rd.coal <= 0 && rd.gasx <= 0;
  const prev = buf.slice();
  buf.push(rd); while (buf.length && ts - buf[0].ts > KEEP_MS) buf.shift();
  const now = o.at ? new Date(o.at) : new Date();
  const writes = [];
  if (!glitch) for (const R of RULES) {
    const v = rd[R.key]; if (v == null) continue;
    const p = pending[R.key];
    if (p) {
      delete pending[R.key];
      if (ts - p.ts <= 180000 && v <= p.pre - CONFIRM * R.X) {
        const to = Math.min(v, p.low), drop = to - p.pre;
        const di = roDateIsp ? roDateIsp(o.wallMs != null ? new Date(o.wallMs) : now) : { date: null, isp: null };
        const a = { id: null, raised_at: now.toISOString(), feed_ms: p.ts, date_ro: di.date, isp: di.isp, source: R.key, level: R.level, drop_mw: drop, from_mw: p.pre, to_mw: to,
          window_s: Math.round((p.ts - p.preTs) / 1000), gap_mw: rd.plan != null && rd.sold != null ? rd.plan - rd.sold : null, storage_mw: rd.storage, hint: hint(R.key, drop, rd), cleared_at: null, cleared_why: null };
        lastRaised[R.key] = p.ts; alarms.unshift(a); out.raised.push(a);
        writes.push(() => { const r = db.prepare('INSERT INTO trip_alarm(raised_at, feed_ms, date_ro, isp, source, level, drop_mw, from_mw, to_mw, window_s, gap_mw, storage_mw, hint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(a.raised_at, a.feed_ms, a.date_ro, a.isp, a.source, a.level, a.drop_mw, a.from_mw, a.to_mw, a.window_s, a.gap_mw, a.storage_mw, a.hint); a.id = Number(r.lastInsertRowid); });
        continue;
      }
    }
    if (lastRaised[R.key] && ts - lastRaised[R.key] < COOLDOWN_MS) continue;
    let pre = -Infinity, preTs = null;
    for (const b of prev) { if (ts - b.ts > R.W * 1000 || b[R.key] == null) continue; if (b[R.key] > pre) { pre = b[R.key]; preTs = b.ts; } }
    if (preTs != null && v - pre <= -R.X && !(v <= 0 && R.key !== 'nuclear' && R.key !== 'mint')) pending[R.key] = { pre, preTs, ts, low: v };
  }
  // Mintia start: off for the whole look-back (at least 3 minutes of readings), now on, confirmed by the next reading
  if (!glitch && rd.mint != null) {
    const p = pending.mint_start;
    if (p) {
      delete pending.mint_start;
      if (ts - p.ts <= 180000 && rd.mint >= START_ON) {
        const di = roDateIsp ? roDateIsp(o.wallMs != null ? new Date(o.wallMs) : now) : { date: null, isp: null };
        const a = { id: null, raised_at: now.toISOString(), feed_ms: p.ts, date_ro: di.date, isp: di.isp, source: 'mint_start', level: 'info', drop_mw: rd.mint, from_mw: 0, to_mw: rd.mint,
          window_s: Math.round((ts - p.offTs) / 1000), gap_mw: rd.plan != null && rd.sold != null ? rd.plan - rd.sold : null, storage_mw: rd.storage, hint: 'start', cleared_at: null, cleared_why: null };
        lastRaised.mint_start = p.ts; alarms.unshift(a); out.raised.push(a);
        writes.push(() => { const r = db.prepare('INSERT INTO trip_alarm(raised_at, feed_ms, date_ro, isp, source, level, drop_mw, from_mw, to_mw, window_s, gap_mw, storage_mw, hint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(a.raised_at, a.feed_ms, a.date_ro, a.isp, a.source, a.level, a.drop_mw, a.from_mw, a.to_mw, a.window_s, a.gap_mw, a.storage_mw, a.hint); a.id = Number(r.lastInsertRowid); });
      }
    } else if (rd.mint >= START_ON && mintState.on === false && ts - mintState.since >= START_QUIET_MS && ts - mintState.lastOff <= KEEP_MS
      && !(lastRaised.mint_start && ts - lastRaised.mint_start < COOLDOWN_MS)) pending.mint_start = { ts, offTs: mintState.lastOff };
    // state: on from 30 MW, off at 10 MW or less; readings in between keep the state (a slow ramp passes through them)
    if (rd.mint >= START_ON) { if (mintState.on !== true) { mintState.on = true; mintState.since = ts; } }
    else if (rd.mint <= START_OFF) { if (mintState.on !== false) { mintState.on = false; mintState.since = ts; } mintState.lastOff = ts; }
  }
  // clear: recovered, or expired
  for (const a of alarms) {
    if (a.cleared_at) continue;
    const isFile = a.source === 'file';
    const v = isFile ? null : rd[a.source];
    if (a.source === 'mint_start') { // cleared when the unit is off again, or after 90 minutes
      const off = rd.mint != null && rd.mint <= START_OFF, exp = a.feed_ms != null && ts - a.feed_ms > ACTIVE_MS;
      if (off || exp) { a.cleared_at = now.toISOString(); a.cleared_why = off ? 'Mintia back at 0 MW' : 'expired after 90 minutes'; out.cleared.push(a);
        writes.push(() => { if (a.id != null) db.prepare('UPDATE trip_alarm SET cleared_at=?, cleared_why=? WHERE id=?').run(a.cleared_at, a.cleared_why, a.id); }); }
      continue;
    }
    const rec = !isFile && v != null && v >= a.from_mw - RECOVER * Math.abs(a.drop_mw);
    const old = isFile ? now.getTime() - new Date(a.raised_at).getTime() > ACTIVE_MS : a.feed_ms != null && ts - a.feed_ms > ACTIVE_MS;
    if (rec || old) { a.cleared_at = now.toISOString(); a.cleared_why = rec ? `output back at ${r0(v)} MW` : 'expired after 90 minutes'; out.cleared.push(a);
      writes.push(() => { if (a.id != null) db.prepare('UPDATE trip_alarm SET cleared_at=?, cleared_why=? WHERE id=?').run(a.cleared_at, a.cleared_why, a.id); }); }
  }
  if (writes.length && db) { db.exec('BEGIN IMMEDIATE'); try { for (const w of writes) w(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
  if (alarms.length > 60) alarms.length = 60;
  if (out.raised.length || out.cleared.length) seq++;
  return out;
}

// Alarm raised by another module (outage_watch.js): { level: 'trip' | 'warn', title, text }. Shown in the same banner.
function raiseExternal(db, x) {
  const now = new Date();
  const a = { id: null, raised_at: now.toISOString(), feed_ms: null, date_ro: null, isp: null, source: 'file', level: x.level === 'trip' ? 'trip' : 'warn', drop_mw: null, from_mw: null, to_mw: null,
    window_s: null, gap_mw: null, storage_mw: null, hint: x.text, title: x.title, cleared_at: null, cleared_why: null };
  alarms.unshift(a); seq++;
  if (db) { db.exec('BEGIN IMMEDIATE'); try { const r = db.prepare('INSERT INTO trip_alarm(raised_at, source, level, hint, title) VALUES (?,?,?,?,?)').run(a.raised_at, a.source, a.level, a.hint, a.title); a.id = Number(r.lastInsertRowid); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
  return a;
}
// the live-feed alarm of a source nearest to a time (naive Romanian ms), for cross-referencing a file entry
function findFeedAlarm(source, naiveMs, tolMs) {
  if (!source || naiveMs == null) return null;
  let best = null;
  for (const a of alarms) { if (a.source !== source || a.feed_ms == null) continue; const d = Math.abs(a.feed_ms - naiveMs); if (d <= tolMs && (!best || d < Math.abs(best.feed_ms - naiveMs))) best = a; }
  return best;
}
const STATS_FILE = 'From the Transelectrica outage list (7productie5.xls, units over 100 MW). The list is updated a few times a day, so it names and confirms a trip after the live feed has shown it.';

const describe = (a) => {
  if (a.source === 'file') return { id: a.id, level: a.level, source: 'Outage list', at: '', raised_at: a.raised_at, cleared_at: a.cleared_at, cleared_why: a.cleared_why, title: a.title || 'Outage list', text: a.hint || '', stats: STATS_FILE, url: OUTAGE_URL };
  const R = RULES.find((x) => x.key === a.source) || { label: a.source };
  const t = a.feed_ms != null ? new Date(a.feed_ms).toISOString().slice(11, 16) : '';
  if (a.source === 'mint_start') { const tc = a.feed_ms != null ? new Date(a.feed_ms - 3600000).toISOString().slice(11, 16) : '';
    return { id: a.id, level: 'info', source: 'Mintia', at: t, raised_at: a.raised_at, cleared_at: a.cleared_at, cleared_why: a.cleared_why, title: 'MINTIA START · ' + r0(a.to_mw) + ' MW and rising',
      text: 'Mintia came on at ' + tc + ' CET: 0 → ' + r0(a.to_mw) + ' MW' + (a.gap_mw != null ? ' · border gap ' + (a.gap_mw >= 0 ? '+' : '−') + r0(Math.abs(a.gap_mw)) + ' MW' : '') + (a.storage_mw != null ? ' · batteries ' + r0(a.storage_mw) + ' MW' : ''), stats: STATS_START, url: OUTAGE_URL }; }
  return { id: a.id, level: a.level, source: R.label, at: t, raised_at: a.raised_at, cleared_at: a.cleared_at, cleared_why: a.cleared_why,
    title: a.level === 'trip' ? `UNIT TRIP · ${R.label} −${r0(-a.drop_mw)} MW` : `${R.label} unloading · −${r0(-a.drop_mw)} MW`,
    text: `${R.label} fell ${r0(a.from_mw)} → ${r0(a.to_mw)} MW in ${a.window_s < 90 ? a.window_s + ' s' : Math.round(a.window_s / 60) + ' min'} at ${t} (feed time) · likely ${a.hint}${a.gap_mw != null ? ' · border gap ' + (a.gap_mw >= 0 ? '+' : '−') + r0(Math.abs(a.gap_mw)) + ' MW' : ''}${a.storage_mw != null ? ' · batteries ' + r0(a.storage_mw) + ' MW' : ''}`,
    stats: a.level === 'trip' ? STATS : STATS_MINT, url: OUTAGE_URL };
};
// read-only snapshot for the API (memory only)
function state() {
  return { seq, at: new Date().toISOString(), active: alarms.filter((a) => !a.cleared_at).map(describe), recent: alarms.filter((a) => a.cleared_at).slice(0, 8).map(describe),
    rules: RULES.map((r) => ({ source: r.label, mw: r.X, seconds: r.W, level: r.level })) };
}
function reset() { mintState.on = null; mintState.since = 0; mintState.lastOff = 0; buf.length = 0; alarms = []; seq = 0; for (const k of Object.keys(pending)) delete pending[k]; for (const k of Object.keys(lastRaised)) delete lastRaised[k]; }

// Banner + sound for every page (injected through NAV). Plain string: no template placeholders.
const clientHtml = [
  '<style>#tripbar{position:sticky;top:0;z-index:9999}#tripbar .trip{display:flex;gap:12px;align-items:flex-start;padding:10px 14px;font:600 14px/1.35 system-ui,Segoe UI,Arial,sans-serif;color:#fff;background:#b3121b;border-bottom:2px solid #ff6b61;animation:tripblink 1.2s steps(2,start) 8}',
  '#tripbar .trip.warn{background:#8a5a00;border-bottom-color:#ffc14d}#tripbar .trip.info{background:#0b5fa5;border-bottom-color:#6cc0ff}#tripbar .trip b{font-size:16px;white-space:nowrap}#tripbar .trip small{display:block;font-weight:500;opacity:.9;margin-top:2px}#tripbar .trip a{color:#fff;text-decoration:underline}',
  '#tripbar .trip button{margin-left:auto;background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.5);border-radius:6px;padding:4px 10px;font:600 13px system-ui;cursor:pointer}',
  '#tripbell{position:fixed;right:10px;bottom:10px;z-index:9998;background:rgba(40,40,40,.85);color:#fff;border:1px solid #777;border-radius:16px;padding:5px 10px;font:600 12px system-ui;cursor:pointer;opacity:.75}#tripbell.on{border-color:#2fd27a;color:#2fd27a}',
  '@keyframes tripblink{0%{filter:brightness(1.35)}50%{filter:brightness(1)}}</style>',
  '<div id="tripbar"></div><button id="tripbell" type="button" title="Unit-trip alarm: sound and desktop notification when nuclear, coal or gas output falls by 200 MW within 3 minutes (Mintia: 150 MW in 5 minutes), and when Mintia starts (0 to 30 MW or more). Click to switch the sound on or off; the browser needs one click per device before it may play it."></button>',
  '<script>(function(){',
  'var bar=document.getElementById("tripbar"),bell=document.getElementById("tripbell"),ctx=null,seen={},first=true,baseTitle=document.title,flash=null;',
  'function on(){try{return localStorage.getItem("tripSound")!=="off";}catch(e){return true;}}',
  'function dismissed(){try{return JSON.parse(localStorage.getItem("tripDismissed")||"{}");}catch(e){return {};}}',
  'function paintBell(){bell.textContent=(on()?"\\uD83D\\uDD14 trip alarm on":"\\uD83D\\uDD15 trip alarm muted");bell.className=on()?"on":"";}',
  'function beep(n){if(!on())return;try{ctx=ctx||new (window.AudioContext||window.webkitAudioContext)();if(ctx.state==="suspended")ctx.resume();var t=ctx.currentTime;for(var i=0;i<n;i++){var o=ctx.createOscillator(),g=ctx.createGain();o.type="square";o.frequency.value=i%2?660:880;g.gain.setValueAtTime(0.0001,t+i*0.35);g.gain.exponentialRampToValueAtTime(0.25,t+i*0.35+0.02);g.gain.exponentialRampToValueAtTime(0.0001,t+i*0.35+0.3);o.connect(g);g.connect(ctx.destination);o.start(t+i*0.35);o.stop(t+i*0.35+0.32);}}catch(e){}}',
  'bell.onclick=function(){var was=on();try{localStorage.setItem("tripSound",was?"off":"on");}catch(e){}paintBell();if(!was){beep(2);if(window.Notification&&Notification.permission==="default")Notification.requestPermission();}};',
  'function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}',
  'function render(j){var dis=dismissed(),html="",fresh=[];(j.active||[]).forEach(function(a){var k=a.raised_at;if(dis[k])return;if(!seen[k]){seen[k]=1;if(!first||Date.now()-new Date(a.raised_at).getTime()<180000)fresh.push(a);}',
  'html+="<div class=\\"trip"+(a.level==="warn"?" warn":a.level==="info"?" info":"")+"\\"><b>\\u26A0 "+esc(a.title)+"</b><span>"+esc(a.text)+"<small>"+esc(a.stats)+" <a href=\\""+esc(a.url)+"\\" target=\\"_blank\\" rel=\\"noopener\\">Transelectrica outage list (point 5)</a></small></span><button type=\\"button\\" data-k=\\""+esc(k)+"\\">dismiss</button></div>";});',
  'bar.innerHTML=html;Array.prototype.forEach.call(bar.querySelectorAll("button"),function(b){b.onclick=function(){var d=dismissed();d[b.getAttribute("data-k")]=1;try{localStorage.setItem("tripDismissed",JSON.stringify(d));}catch(e){}b.parentNode.remove();stopFlash();};});',
  'if(fresh.length){beep(fresh[0].level==="warn"?3:fresh[0].level==="info"?4:8);if(window.Notification&&Notification.permission==="granted"){try{new Notification(fresh[0].title,{body:fresh[0].text,requireInteraction:true});}catch(e){}}startFlash(fresh[0].title);}if(!html)stopFlash();first=false;}',
  'function startFlash(t){stopFlash();var s=0;flash=setInterval(function(){document.title=(s++%2)?baseTitle:"\\u26A0 "+t;},1000);}function stopFlash(){if(flash){clearInterval(flash);flash=null;document.title=baseTitle;}}',
  'function tick(){fetch("/api/trip_alarm",{cache:"no-store"}).then(function(r){return r.ok?r.json():null;}).then(function(j){if(j)render(j);}).catch(function(){});}',
  'window.__tripRender=render;paintBell();tick();setInterval(tick,15000);',
  '})();</script>',
].join('\n');

module.exports = { ensureTable, load, feed, state, reset, raiseExternal, findFeedAlarm, clientHtml, RULES, STATS };
