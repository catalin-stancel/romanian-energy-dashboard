// Local web app for the trading tool: PZU bet entry, PI live view, performance.
//   node tool\server.js          -> http://localhost:8077
//
// Pages:
//   /pzu?date=YYYY-MM-DD   editable bet sheet per delivery day (default: tomorrow).
//                          Inputs lock at 10:00 EET on the day BEFORE delivery (Unlock button
//                          overrides). Past dates show the prediction as of decision time.
//   /pi?date=...           live intraday table (default: today)
//   /perf                  model + bet performance
// API: GET /api/pzu?date= | POST /api/bet {date,isp,qty} | POST /api/unlock {date} | POST /api/lock {date}
const http = require('http');
const fs = require('fs');
const path = require('path');
const { openDb, roDateIsp } = require('./db');

const PORT = process.env.PORT || 8077;
const db = openDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS user_bets (
    date_ro TEXT NOT NULL, isp INTEGER NOT NULL, qty REAL NOT NULL, updated_at TEXT NOT NULL,
    source TEXT DEFAULT 'manual',
    PRIMARY KEY (date_ro, isp)
  );
  CREATE TABLE IF NOT EXISTS user_bets_log (
    date_ro TEXT, isp INTEGER, qty REAL, saved_at TEXT
  );
  CREATE TABLE IF NOT EXISTS page_unlocks (
    date_ro TEXT PRIMARY KEY, unlocked INTEGER NOT NULL, updated_at TEXT
  );
`);
try { db.exec(`ALTER TABLE user_bets ADD COLUMN user TEXT`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE user_bets_log ADD COLUMN user TEXT`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE page_unlocks ADD COLUMN user TEXT`); } catch { /* exists */ }

// first-boot safety: the pages query these before the first predict job has created them
db.exec(`
  CREATE TABLE IF NOT EXISTS predictions (
    run_at TEXT NOT NULL, ts_utc TEXT NOT NULL, date_ro TEXT NOT NULL, isp INTEGER NOT NULL,
    horizon_min REAL NOT NULL, actionable INTEGER NOT NULL, prob_long REAL,
    price_p10 REAL, price_p50 REAL, price_p90 REAL, model_version TEXT,
    realized_imb REAL, realized_price REAL, imb_p50 REAL,
    PRIMARY KEY (run_at, ts_utc)
  );
  CREATE TABLE IF NOT EXISTS bets (
    run_at TEXT NOT NULL, ts_utc TEXT NOT NULL, date_ro TEXT NOT NULL, isp INTEGER NOT NULL,
    actionable INTEGER NOT NULL, dir TEXT NOT NULL, qty REAL NOT NULL, prob REAL,
    exp_price REAL, da_ref REAL, da_ref_est INTEGER, exp_edge REAL, exp_revenue REAL,
    model_version TEXT, realized_price REAL, realized_revenue REAL, tail_loss REAL, reason TEXT,
    PRIMARY KEY (run_at, ts_utc)
  );
  -- per-day covering indexes: the "latest run per ts_utc" subqueries (piLocked/betPred/anyPred/expTotal/acc)
  -- were full-scanning 200k+ rows; scoping them to date_ro makes each a ~few-hundred-row covering seek
  CREATE INDEX IF NOT EXISTS idx_pred_day ON predictions(date_ro, ts_utc, run_at, actionable);
  CREATE INDEX IF NOT EXISTS idx_bets_day ON bets(date_ro, ts_utc, run_at, actionable);
`);

function loadConfig() {
  const defaults = { eur_ron: 5.24, trade_window_cet: [7, 22], max_mwh_per_isp: 2.5, min_mwh_per_isp: 2.0, risk_aversion: 0.5 };
  // LOCAL: config lives in tool/ next to this file (cloud uses ../config.json)
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8').replace(/^﻿/, '')) }; }
  catch { return defaults; }
}

const pad = (n) => String(n).padStart(2, '0');
const ispLabel = (isp) => `${pad(Math.floor((isp - 1) / 4))}:${['00', '15', '30', '45'][(isp - 1) % 4]}`;
// market time (CET) of the ISP start; ISPs 1-4 fall on the previous CET evening
const cetLabel = (isp) => {
  let m = (isp - 1) * 15 - 60;
  const prev = m < 0;
  if (prev) m += 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}${prev ? '<small>−1d</small>' : ''}`;
};
const addDays = (dateStr, n) => new Date(new Date(dateStr + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const euDate = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const dayTitle = (d) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(d + 'T12:00:00Z').getUTCDay()] + ' ' + euDate(d);

// compact direction icon: green S = surplus, red D = deficit
const dirIcon = (surplus) => `<span class="ic ${surplus ? 'ic-s' : 'ic-d'}" title="${surplus ? 'Surplus' : 'Deficit'}">${surplus ? 'S' : 'D'}</span>`;

// The estimated imbalance price is recoverable from the balancing-energy data, which DAMAS publishes BEFORE
// the estimatedPrice: deficit (imb<0) → up-regulation volume-weighted price sumQupPup/sumQup; surplus (imb>0)
// → down-regulation price sumQdownPdn/sumQdn. Verified Δ≈0 vs the published price on every settled interval,
// so we can show the price the moment the balancing data lands, ahead of DAMAS; the official value overwrites it.
const earlyPrice = (imb, qUp, qDn, vUp, vDn) => {
  if (imb === null) return null; // need the direction; imb publishes with/before the price and skips placeholder future rows
  return imb > 0 ? (qDn ? vDn / qDn : null) : (qUp ? vUp / qUp : null);
};
const provPriceSpan = (v) => `<span style="opacity:.55;font-style:italic" title="computed from balancing energy (ΣQ·P ÷ ΣQ) — DAMAS has not published the official price yet">~${Math.round(v).toLocaleString('en-US')}</span>`;

// X-B Δ varies within an interval as the Real-X-B (SEN) side firms up; log_xb_pi.js records the live delta
// each minute into xb_delta_snap. Show the interval-AVERAGE of those recordings + a drift arrow (↑/↓ = the
// delta moved toward + / −). Falls back to the live single value (null here) for intervals with no recordings.
function xbDeltaAgg(date) {
  const m = new Map();
  try {
    const by = new Map();
    for (const r of db.prepare('SELECT isp, delta FROM xb_delta_snap WHERE date_ro=? ORDER BY pulled_at').all(date)) {
      if (!by.has(r.isp)) by.set(r.isp, []); by.get(r.isp).push(r.delta);
    }
    for (const [isp, a] of by) m.set(isp, { avg: a.reduce((s, v) => s + v, 0) / a.length, n: a.length, first: a[0], last: a[a.length - 1] });
  } catch { /* table not created yet */ }
  return m;
}
// Last intraday change to the NOTIFIED cross-border per interval = the most recent PI trade. xb_pi_snap stores only
// CHANGED frames (commercial = net export), so the last non-zero step in `commercial` is what the market just did:
// +Δ = net export rose → the market SOLD (more export); −Δ = net export fell → it BOUGHT (more import).
function xbPiChange(date) {
  const m = new Map();
  try {
    const rows = db.prepare('SELECT isp, commercial FROM xb_pi_snap WHERE date_ro=? AND commercial IS NOT NULL ORDER BY isp, pulled_at').all(date);
    const byIsp = new Map();
    for (const r of rows) { if (!byIsp.has(r.isp)) byIsp.set(r.isp, []); byIsp.get(r.isp).push(r.commercial); }
    for (const [isp, v] of byIsp) { let last = null; for (let i = 1; i < v.length; i++) { const d = v[i] - v[i - 1]; if (Math.abs(d) >= 1) last = d; } if (last !== null) m.set(isp, last); }
  } catch { /* table not created yet */ }
  return m;
}
// Romania weather per UTC hour: ensemble + spatial mean (ECMWF/ICON/GFS × 4 regions) from the `weather` forecast
// table. "real" ≈ the latest pull (analysis for past hours / current forecast ahead); "forecast" = the last pull
// made before the delivery day (D-1). Returns Map "YYYY-MM-DDTHH" → { cloud, windReal, windFc } (wind = 100m km/h).
function weatherForDate(date) {
  const out = new Map();
  try {
    // fast: latest-run ensemble mean from the materialized weather_hourly (was 3 full scans of the 2.4M-row raw table)
    const lo = date + 'T00:00:00Z', hi = addDays(date, 1) + 'T06:00:00Z';
    for (const r of db.prepare("SELECT ts_utc, var, value FROM weather_hourly WHERE var IN ('cloud_cover','wind_speed_100m') AND ts_utc>=? AND ts_utc<=?").all(lo, hi)) {
      const k = r.ts_utc.slice(0, 13); const e = out.get(k) || { cloud: null, windReal: null, windFc: null };
      if (r.var === 'cloud_cover') e.cloud = r.value; else e.windReal = r.value; out.set(k, e);
    }
  } catch { /* table not created yet */ }
  return out;
}
const skyIcon = (cloud) => (cloud == null ? '' : cloud < 20 ? '☀️' : cloud < 50 ? '🌤️' : cloud < 80 ? '⛅' : '☁️');
// weather AS IT WAS at a past UTC hour = the freshest reading we have for that hour (latest pull covering it, ensemble
// + spatial mean). For historical rows. Needs ix_weather_ts (added at startup) to be fast.
function wxAtHour(hourISO) {
  try {
    const rows = db.prepare("SELECT var, value v FROM weather_hourly WHERE ts_utc=? AND var IN ('cloud_cover','wind_speed_100m')").all(hourISO);
    if (!rows.length) return null;
    let cloud = null, wind = null;
    for (const r of rows) { if (r.var === 'cloud_cover') cloud = r.v; else if (r.var === 'wind_speed_100m') wind = r.v; }
    return { cloud, windReal: wind };
  } catch { return null; }
}
const wxCell = (wx) => {
  if (!wx || (wx.cloud == null && wx.windReal == null)) return '';
  const wr = wx.windReal != null ? Math.round(wx.windReal) : null;
  const wf = wx.windFc != null ? Math.round(wx.windFc) : null;
  const windTxt = wr != null ? `💨${wr}${wf != null && Math.abs(wf - wr) >= 2 ? ` <small style="opacity:.55">(${wf})</small>` : ''}` : (wf != null ? `💨${wf}` : '');
  const tip = `Romania ensemble mean — sky ${wx.cloud != null ? Math.round(wx.cloud) + '% cloud' : '?'} · wind 100m ${wr != null ? wr + ' km/h (latest run ≈ real)' : '?'}${wf != null ? `, ${wf} km/h forecast (D-1)` : ''}`;
  return `<span title="${tip}">${skyIcon(wx.cloud)} ${windTxt}</span>`;
};
// A historical reference row for the SAME interval on an earlier day (the −1d/−2d rows under an expanded interval, and
// under the trade row). Sourced from `series` (settled DAMAS) + sen_interval (real X-B avg); 18-col aligned; columns
// without clean history stay blank. `gate` → green grouping box (trade row); else neutral. data-pisp ties it to its parent.
function histRowHtml(d, isp, label, last, gate) {
  const f = (v) => (v === null || v === undefined ? '' : Math.round(v).toLocaleString('en-US'));
  const ar = (v) => (v === null || v === undefined ? '' : `${v >= 0 ? '↑' : '↓'}${Math.round(Math.abs(v))}`);
  const dl = (v) => (v === null || v === undefined ? '' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${Math.round(v)}</span>`);
  const need = ['damas_est_sys_imbalance', 'damas_est_price_pos', 'damas_notif_prod', 'damas_notif_cons', 'damas_cons_real',
    'damas_sx_rohu', 'damas_sx_robg', 'damas_sx_rors', 'damas_sx_roua', 'damas_sx_romd', 'damas_sx_huro', 'damas_sx_bgro', 'damas_sx_rsro', 'damas_sx_uaro', 'damas_sx_mdro',
    'gen_actual_solar', 'gen_actual_wind_onshore', 'gen_actual_hydro_reservoir', 'gen_actual_hydro_ror', 'gen_actual_nuclear', 'gen_actual_gas', 'gen_actual_hard_coal', 'gen_actual_lignite', 'gen_actual_biomass', 'gen_actual_B25'];
  const m = {};
  try { for (const r of db.prepare(`SELECT series, value FROM series WHERE date_ro=? AND isp=? AND series IN (${need.map(() => '?').join(',')})`).all(d, isp, ...need)) m[r.series] = r.value; } catch { /* ignore */ }
  let rxb = null; try { const r = db.prepare('SELECT avg_realxb FROM sen_interval WHERE date_ro=? AND isp=?').get(d, isp); if (r) rxb = r.avg_realxb; } catch { /* ignore */ }
  const imb = m['damas_est_sys_imbalance'] ?? null, price = m['damas_est_price_pos'] ?? null;
  const np = m['damas_notif_prod'] ?? null, nc = m['damas_notif_cons'] ?? null, rc = m['damas_cons_real'] ?? null;
  let nxb = null, any = false;
  for (const s of ['damas_sx_rohu', 'damas_sx_robg', 'damas_sx_rors', 'damas_sx_roua', 'damas_sx_romd']) if (m[s] != null) { nxb = (nxb || 0) + m[s]; any = true; }
  for (const s of ['damas_sx_huro', 'damas_sx_bgro', 'damas_sx_rsro', 'damas_sx_uaro', 'damas_sx_mdro']) if (m[s] != null) { nxb = (nxb || 0) - m[s]; any = true; }
  if (!any) nxb = null;
  const xbd = (rxb != null && nxb != null) ? rxb - nxb : null;
  // real production for that interval = sum of settled ENTSO-E generation by type; + the per-source split (.prodmix, follows the toggle)
  const ga = (k) => (m['gen_actual_' + k] ?? null);
  let rprod = null; for (const k of ['solar', 'wind_onshore', 'hydro_reservoir', 'hydro_ror', 'nuclear', 'gas', 'hard_coal', 'lignite', 'biomass', 'B25']) { const v = ga(k); if (v != null) rprod = (rprod || 0) + v; }
  const rso = ga('solar'), rwi = ga('wind_onshore'), rhy = (ga('hydro_reservoir') || 0) + (ga('hydro_ror') || 0), rnu = ga('nuclear');
  const rprodCell = rprod === null ? '' : f(rprod) + ` <span class="prodmix">| <span title="solar">☀️${Math.round(rso || 0)}</span><span title="wind">💨${Math.round(rwi || 0)}</span><span title="hydro">💧${Math.round(rhy)}</span><span title="nuclear">⚛️${Math.round(rnu || 0)}</span><span title="other (coal/gas/biomass)">🔥${Math.max(0, Math.round(rprod - (rso || 0) - (rwi || 0) - rhy - (rnu || 0)))}</span></span>`;
  // weather as it was at that interval's hour
  let wxTxt = ''; try { const t = dayTimestamps(d).find((x) => x.isp === isp); if (t) { const wx = wxAtHour(new Date(t.ts).toISOString().slice(0, 13) + ':00:00Z'); if (wx && (wx.cloud != null || wx.windReal != null)) wxTxt = `${skyIcon(wx.cloud)}${wx.windReal != null ? ' 💨' + Math.round(wx.windReal) : ''}`; } } catch { /* ignore */ }
  return `<tr class="histrow ${gate ? 'hg' : 'hx'}${last ? ' histrow-last' : ''}" data-pisp="${isp}"><td title="same interval, ${d}"><span class="histlbl">${label}</span></td><td><small>${cetLabel(isp)}</small></td>`
    + `<td>${imb !== null ? dirIcon(imb > 0) + ' ' + f(Math.abs(imb)) : ''}</td>`
    + `<td>${price !== null ? f(price) + ' <small class="cur">lei</small>' : ''}</td>`
    + `<td>${rprodCell}</td><td>${f(np)}</td><td>${wxTxt}</td><td></td>`
    + `<td>${f(rc)}</td><td>${f(nc)}</td><td></td>`
    + `<td>${rxb !== null ? ar(rxb) : ''}</td><td>${nxb !== null ? ar(nxb) : ''}</td><td></td><td></td><td></td>`
    + `<td>${xbd !== null ? dl(xbd) : ''}</td>`
    + `<td>${np !== null && nc !== null && nxb !== null ? dl(np - nc - nxb) : ''}</td></tr>`;
}
const xbDeltaCell = (agg, isp) => { // returns averaged-cell HTML, or null to let the caller fall back to the live value
  const a = agg && agg.get(isp);
  if (!a || a.n < 2) return null;
  const v = Math.round(a.avg), drift = a.last - a.first;
  const arr = Math.abs(drift) < 1 ? '' : (drift > 0 ? ' <span class="pos">↑</span>' : ' <span class="neg">↓</span>');
  return `<span title="interval-average of ${a.n} recorded X-B Δ snapshots (${Math.round(a.first)} → ${Math.round(a.last)} MW); arrow = drift over the interval"><span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v}</span>${arr}</span>`;
};

// column visibility picker; selection persists in localStorage per page
const colPicker = (key, mobileHidden, defaultHidden) => `
<div class="colwrap r1"><button type="button" onclick="document.getElementById('colpanel').classList.toggle('open')">Columns ▾</button>
<div id="colpanel" class="colpanel"></div></div>
<script>window.addEventListener('DOMContentLoaded',function(){
  var key=${JSON.stringify(key)};
  var table=document.querySelector('.content table');
  if(!table)return;
  var head=[].map.call(table.rows[0].cells,function(c){
    var clone=c.cloneNode(true);
    clone.querySelectorAll('.help').forEach(function(h){h.remove();}); // drop the ⓘ tooltip text — hidden, but textContent slurps it in and bloats the label
    clone.querySelectorAll('br').forEach(function(b){b.replaceWith(' ');}); // title<br>unit → "title unit"
    return clone.textContent.replace(/\\s+/g,' ').trim(); // NB: \\s — this is inside a template literal, so \s would de-escape to a literal "s" and eat every s in the labels
  });
  // default-hidden set: defaultHidden on every device + mobileHidden extras on phones (until the user picks own)
  var saved=localStorage.getItem(key);
  var dflt=${JSON.stringify(defaultHidden || [])}.concat(window.matchMedia('(max-width:760px)').matches?${JSON.stringify(mobileHidden || [])}:[]);
  var hidden=new Set(saved?JSON.parse(saved):dflt);
  function apply(){
    var n=table.rows[0]?table.rows[0].cells.length:0;
    for(var r=0;r<table.rows.length;r++){
      var row=table.rows[r];
      if(row.cells.length!==n)continue;
      for(var i=0;i<row.cells.length;i++)row.cells[i].style.display=hidden.has(i)?'none':'';
    }
  }
  window.__applyColHiding=apply; // single source of truth; partial-refresh pages call this after swapping rows
  var panel=document.getElementById('colpanel');
  head.forEach(function(h,i){
    var lab=document.createElement('label');
    lab.innerHTML='<input type="checkbox" '+(hidden.has(i)?'':'checked')+' data-i="'+i+'"> '+(h||('col '+(i+1)));
    panel.appendChild(lab);
  });
  panel.addEventListener('change',function(e){
    var i=+e.target.dataset.i;
    if(e.target.checked)hidden.delete(i);else hidden.add(i);
    localStorage.setItem(key,JSON.stringify(Array.from(hidden)));
    apply();
  });
  // Keep the panel inside the viewport. It is right-anchored to the "Columns" button, but that button sits near the
  // LEFT edge of the banner — so a wide 2-column panel hung ~200px off the left edge and its whole first column of
  // checkboxes was unreachable. Measure on open and slide it back in (phones keep the fixed left:8/right:8 CSS).
  function place(){
    panel.style.left='';panel.style.right='';panel.style.top='';     // reset to the CSS anchors, then measure
    var mob=window.matchMedia('(max-width:760px)').matches;
    var wrap=panel.parentNode.getBoundingClientRect();
    if(!mob){                                                        // phones: CSS already pins left/right to both edges
      var w=panel.offsetWidth,want=wrap.right-w;                     // where right-anchoring puts its left edge
      var left=Math.max(8,Math.min(want,window.innerWidth-8-w));     // clamp into the viewport
      if(Math.abs(left-want)>0.5){panel.style.right='auto';panel.style.left=(left-wrap.left)+'px';}
    }
    var r=panel.getBoundingClientRect();                             // vertical: phones' fixed top:auto can park it ABOVE the viewport
    if(r.top<8||r.bottom>window.innerHeight-8){
      var top=Math.max(8,Math.min(wrap.bottom+6,window.innerHeight-8-r.height));
      panel.style.top=(mob?top:top-wrap.top)+'px';                   // fixed → viewport coords; absolute → relative to .colwrap
    }
  }
  new MutationObserver(function(){if(panel.classList.contains('open'))place();}).observe(panel,{attributes:true,attributeFilter:['class']});
  window.addEventListener('resize',function(){if(panel.classList.contains('open'))place();});
  // close the panel when clicking/tapping anywhere outside it
  document.addEventListener('click',function(e){
    if(panel.classList.contains('open')&&!panel.contains(e.target)&&!e.target.closest('.colwrap'))
      panel.classList.remove('open');
  });
  apply();
});</script>`;

// UTC instant of a local (Europe/Bucharest) hour on dateStr (handles day rollover + DST)
function utcForLocalHour(dateStr, hour) {
  const base = new Date(dateStr + 'T00:00:00Z').getTime();
  for (const off of [3, 2]) {
    const cand = new Date(base + (hour - off) * 3600000);
    const r = roDateIsp(cand);
    if (r.date === dateStr && Math.floor(((r.isp - 1) * 15) / 60) === hour) return cand;
  }
  return new Date(base + (hour - 2) * 3600000);
}

// 96 UTC timestamps of a RO delivery day
function dayTimestamps(dateStr) {
  const start = utcForLocalHour(dateStr, 0);
  const out = [];
  for (let i = 0; i < 110; i++) {
    const d = new Date(start.getTime() + i * 900000);
    if (roDateIsp(d).date !== dateStr) break;
    out.push({ isp: i + 1, ts: d.toISOString().slice(0, 19) + '.000Z' });
  }
  return out;
}

const lockTimeFor = (deliveryDate) => utcForLocalHour(addDays(deliveryDate, -1), 11); // 10:00 CET = 11:00 EET
const isUnlocked = (date) => !!db.prepare('SELECT unlocked FROM page_unlocks WHERE date_ro=?').get(date)?.unlocked;
const isLocked = (date) => Date.now() >= lockTimeFor(date).getTime() && !isUnlocked(date);

const seriesAt = db.prepare('SELECT value FROM series WHERE series=? AND ts_utc=?');
const sv = (name, ts) => { const r = seriesAt.get(name, ts); return r ? r.value : null; };

function pzuData(date) {
  const cfg = loadConfig();
  const [h0, h1] = cfg.trade_window_cet;
  const ispFrom = (h0 + 1) * 4 + 1, ispTo = (h1 + 1) * 4 + 1; // +1 → include the wh1:00-starting row (e.g. 22:00)
  const lockAt = lockTimeFor(date).toISOString();
  const locked = isLocked(date);

  // prediction view: decision-time (<= lockAt) for locked/past days, latest otherwise
  const predRun = locked
    ? db.prepare('SELECT MAX(run_at) m FROM predictions WHERE run_at<=? AND date_ro=?').get(lockAt, date).m
    : db.prepare('SELECT MAX(run_at) m FROM predictions WHERE date_ro=?').get(date).m;
  const preds = predRun
    ? new Map(db.prepare('SELECT * FROM predictions WHERE run_at=? AND date_ro=?').all(predRun, date).map((r) => [r.isp, r]))
    : new Map();
  const betRun = locked
    ? db.prepare('SELECT MAX(run_at) m FROM bets WHERE run_at<=? AND date_ro=?').get(lockAt, date).m
    : db.prepare('SELECT MAX(run_at) m FROM bets WHERE date_ro=?').get(date).m;
  const advice = betRun
    ? new Map(db.prepare('SELECT * FROM bets WHERE run_at=? AND date_ro=?').all(betRun, date).map((r) => [r.isp, r]))
    : new Map();
  const userBets = new Map(db.prepare('SELECT isp, qty, source FROM user_bets WHERE date_ro=?').all(date).map((r) => [r.isp, r]));
  // xb_combo D-1 colour signal (SHADOW — live-scored, does NOT drive the position; staged rollout 2026-06-19)
  let combo = new Map();
  try { combo = new Map(db.prepare("SELECT isp, pred_surplus, p_surplus, model_correct, realized_imb FROM combo_pred WHERE kind='d1' AND date_ro=?").all(date).map((r) => [r.isp, r])); } catch { /* combo_pred not present yet */ }
  // external "RO Signal Override" desk positions (BUY/SELL/HOLD + Q per interval) — these REPLACE our model advice as the position
  let ext = new Map();
  try { ext = new Map(db.prepare('SELECT isp, sig, q FROM ext_signals WHERE date_ro=?').all(date).map((r) => [r.isp, r])); } catch { /* ext_signals not present yet */ }

  const cfgRon = cfg.eur_ron;
  const rows = dayTimestamps(date).map(({ isp, ts }) => {
    const p = preds.get(isp);
    const a = advice.get(isp);
    const pzuOfficial = sv('pzu_ron', ts); // OPCOM ROPEX_DAM_15min, RON
    const daEur = sv('da_price', ts);
    const pzuRon = pzuOfficial !== null ? pzuOfficial : (daEur !== null ? daEur * cfgRon : null);
    const imbPrice = sv('damas_est_price_pos', ts);
    const imb = sv('damas_est_sys_imbalance', ts);
    const ub = userBets.get(isp);
    const qty = ub?.qty ?? null;
    const betSource = ub?.source ?? null;
    const result = qty !== null && qty !== 0 && imbPrice !== null && pzuRon !== null
      ? qty * (imbPrice - pzuRon) : null;
    const es = ext.get(isp);
    return {
      isp, eet: ispLabel(isp), cet: cetLabel(isp),
      // desk covers all 24h → any interval with a desk signal is tradeable (night = BUY/HOLD only, enforced upstream)
      inWindow: es ? true : (isp >= ispFrom && isp <= ispTo),
      deskSig: es ? es.sig : null, deskQ: es != null ? es.q : null,
      probLong: p?.prob_long ?? null, imbP50: p?.imb_p50 ?? null, priceP50: p?.price_p50 ?? null,
      priceP10: p?.price_p10 ?? null, priceP90: p?.price_p90 ?? null,
      adviceQty: a ? (a.dir === 'surplus' ? a.qty : -a.qty) : null,
      adviceEdge: a?.exp_edge ?? null,
      adviceReason: a?.reason ?? null,
      adviceTail: a?.tail_loss ?? null,
      adviceResult: a && a.qty > 0 ? a.realized_revenue : null,
      predPrice: p?.price_p50 ?? a?.exp_price ?? null,
      comboSurplus: combo.get(isp) ? combo.get(isp).pred_surplus === 1 : null,
      comboP: combo.get(isp)?.p_surplus ?? null,
      comboSettled: combo.get(isp) ? combo.get(isp).realized_imb !== null : false,
      comboCorrect: combo.get(isp)?.model_correct ?? null,
      pzuRon, pzuConverted: pzuOfficial === null && pzuRon !== null, imbPrice, imb, qty, betSource, result,
    };
  });
  return { date, locked, unlocked: isUnlocked(date), lockAt, predRun, maxMwh: cfg.max_mwh_per_isp, rows };
}

const NAV = (active, date, refreshSec, extras) => `
<div class="banner">
  <h1><span class="highlight">GAN Trading</span></h1>
  ${extras || ''}
  ${date ? `<div class="datebar r1">
    <a href="/${active}?date=${addDays(date, -1)}">&larr;</a>
    <input type="date" value="${date}" onchange="location='/${active}?date='+this.value">
    <a href="/${active}?date=${addDays(date, 1)}">&rarr;</a>
  </div>` : ''}
  ${refreshSec ? `<div class="upd r2" title="time until the next balancing-data refresh (DAMAS pull, every ${Math.round(refreshSec.period / 60)} min)">
    <span id="updsec">⟳ ${refreshSec.left}s</span></div>
  <script>(function(){var left=${refreshSec.left};setInterval(function(){left--;
    var el=document.getElementById('updsec');
    if(left<=0){el.textContent='⟳ data…';if(left<=-3)location.reload();return;}
    el.textContent='⟳ '+left+'s';},1000);})();</script>` : ''}
  <div class="nav">
    <a class="${active === 'pzu' ? 'on' : ''}" href="/pzu">PZU positions</a>
    <a class="${active === 'pi' ? 'on' : ''}" href="/pi">PI live</a>
    <a class="${active === 'predict' ? 'on' : ''}" href="/predict">Predict</a>
    <a class="${active === 'pilearn' ? 'on' : ''}" href="/pilearn">PI learn</a>
    ${active === 'predict' ? '<a href="#" id="predtoggle" class="predtgl" title="show/hide the model sign predictions (kept off by default until traders are briefed)" onclick="togglePreds();return false">Predictions: OFF</a>' : ''}
    <a href="#" title="toggle dark/light theme" onclick="toggleTheme();return false">◐</a>
    <span class="userchip"><a href="/logout" title="sign out">⎋</a></span>
  </div>
  <button class="menubtn r1" type="button" onclick="document.getElementById('mainmenu').classList.toggle('open');event.stopPropagation()">⋮</button>
  <div class="bbreak"></div>
  <div id="mainmenu" class="menu">
    <a class="${active === 'pzu' ? 'on' : ''}" href="/pzu">PZU positions</a>
    <a class="${active === 'pi' ? 'on' : ''}" href="/pi">PI live</a>
    <a class="${active === 'predict' ? 'on' : ''}" href="/predict">Predict</a>
    <a class="${active === 'pilearn' ? 'on' : ''}" href="/pilearn">PI learn</a>
    <div class="menusep"></div>
    <a href="#" onclick="event.stopPropagation();var p=document.getElementById('colpanel');if(p)p.classList.toggle('open');document.getElementById('mainmenu').classList.remove('open');return false">Columns…</a>
    <a href="#" onclick="toggleTheme();return false">Theme: <span id="thlabel"></span></a>
    ${active === 'predict' ? '<a href="#" onclick="togglePreds();return false">Model predictions: <span id="predlbl2">OFF</span></a>' : ''}
    <div class="menusep"></div>
    <a href="/logout">Sign out</a>
  </div>
  <script>function toggleTheme(){
    var t=document.documentElement.dataset.theme==='dark'?'light':'dark';
    document.documentElement.dataset.theme=t;localStorage.setItem('theme',t);
    var l=document.getElementById('thlabel');if(l)l.textContent=t;
  }
  // model predictions show/hide (off by default; persisted per device in localStorage)
  function setPredLabel(){var on=!document.documentElement.classList.contains('preds-off');
    var b=document.getElementById('predtoggle');if(b){b.textContent='Predictions: '+(on?'ON':'OFF');b.classList.toggle('predon',on);}
    var m=document.getElementById('predlbl2');if(m)m.textContent=on?'ON':'OFF';}
  function togglePreds(){var off=document.documentElement.classList.toggle('preds-off');
    localStorage.setItem('showPreds',off?'0':'1');setPredLabel();}
  // show/hide the per-source generation split (Real prod header switch); persisted per device
  function toggleMix(){var off=document.documentElement.classList.toggle('mix-off');localStorage.setItem('showMix',off?'0':'1');}
  // show/hide the per-interval border capacity-used readout (Int header switch); default hidden
  function toggleXbu(){var on=document.documentElement.classList.toggle('xbu-on');localStorage.setItem('showXbu',on?'1':'0');}
  function toggleXbf(){var off=document.documentElement.classList.toggle('xbf-off');localStorage.setItem('showXbf',off?'0':'1');}
  // RES fcst column: weather icons (default) ⇄ RES generation forecast; persisted per device
  function setResLabel(){var h=document.getElementById('reshdr');if(h)h.innerHTML=document.documentElement.classList.contains('res-on')?'RES fcst<br><small>MW</small>':'Weather<br><small>100m km/h</small>';}
  function toggleRes(){var on=document.documentElement.classList.toggle('res-on');localStorage.setItem('showRes',on?'1':'0');setResLabel();}
  window.addEventListener('DOMContentLoaded',function(){
    var l=document.getElementById('thlabel');
    if(l)l.textContent=document.documentElement.dataset.theme;
    setPredLabel();setResLabel();
  });
  document.addEventListener('click',function(e){
    var m=document.getElementById('mainmenu');
    if(m&&!m.contains(e.target)&&!e.target.classList.contains('menubtn'))m.classList.remove('open');
  });
  // Chrome-style header on mobile: the nav row hides on scroll down, returns on scroll up;
  // the table header pins below whatever banner height is currently visible (--bh)
  window.addEventListener('DOMContentLoaded',function(){
    var banner=document.querySelector('.banner');
    if(!banner)return;
    function setBH(){document.documentElement.style.setProperty('--bh',banner.offsetHeight+'px')}
    setBH();window.addEventListener('resize',setBH);
    var lastY=window.scrollY;
    window.addEventListener('scroll',function(){
      if(!window.matchMedia('(max-width:760px)').matches)return;
      var y=window.scrollY;
      if(y>lastY+8&&y>70){banner.classList.add('hidenav');setBH();}
      else if(y<lastY-8){banner.classList.remove('hidenav');setBH();}
      lastY=y;
    },{passive:true});
  });</script>
  </div>`;

// YellowGrid Design System (data/design/colors_and_type.css) — brand yellow as accent over a
// themeable base. DARK is the default theme; html[data-theme='light'] restores the original
// light palette. The inline script runs before CSS paint so there is no theme flash.
const STYLE = `<script>document.documentElement.dataset.theme=localStorage.getItem('theme')||'dark';if((localStorage.getItem('showPreds')||'0')!=='1')document.documentElement.classList.add('preds-off');if((localStorage.getItem('showMix')||'0')!=='1')document.documentElement.classList.add('mix-off');if(localStorage.getItem('showRes')==='1')document.documentElement.classList.add('res-on');if(localStorage.getItem('showXbf')==='0')document.documentElement.classList.add('xbf-off');if(localStorage.getItem('showXbu')==='1')document.documentElement.classList.add('xbu-on')</script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;700&family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap');
:root{
  --yg-yellow:#FFF500;--yg-black:#121212;
  --font-display:'Nunito',system-ui,sans-serif;--font-body:'Inter',system-ui,sans-serif;
  --font-mono:'JetBrains Mono',ui-monospace,monospace;
  /* DARK (default) */
  --bg-page:#101010;--bg-surface:#181818;--bg-subtle:#212121;--bg-banner:rgba(14,14,14,0.92);
  --fg:#ececec;--fg-muted:#9b9b9b;
  --border-1:#2b2b2b;--border-2:#454545;
  --th-bg:#000000;
  --pos:#3ecf81;--neg:#ff6e62;--info:#6ea8ff;
  --tint-pos:rgba(31,158,87,0.14);--tint-neg:rgba(217,58,48,0.13);
  --tint-pos-strong:rgba(31,158,87,0.34);--tint-neg-strong:rgba(217,58,48,0.30);
  --tint-now:rgba(255,245,0,0.15);--auto-bg:rgba(255,245,0,0.16);
  --tp-pos-bg:rgba(31,158,87,0.22);--tp-neg-bg:rgba(217,58,48,0.22);
  --srp-bg:rgba(110,168,255,0.18);--dfc-bg:rgba(255,110,98,0.18);
  --ic-s:#1F9E57;--ic-d:#D93A30;
}
html[data-theme='light']{
  --bg-page:#ffffff;--bg-surface:#ffffff;--bg-subtle:#F6F6F6;--bg-banner:rgba(255,255,255,0.92);
  --fg:#121212;--fg-muted:#8A8A8A;
  --border-1:#ECECEC;--border-2:#A4A4A4;
  --th-bg:#121212;
  --pos:#1F9E57;--neg:#D93A30;--info:#2F6FE0;
  --tint-pos:#e9f7ee;--tint-neg:#fdeceb;
  --tint-pos-strong:#c4e8d0;--tint-neg-strong:#f5cbc6;
  --tint-now:#FFFCA8;--auto-bg:#FFF59E;
  --tp-pos-bg:#dff2e6;--tp-neg-bg:#fbe5e3;
  --srp-bg:#e3ecfb;--dfc-bg:#fbe5e3;
  --ic-s:#1F9E57;--ic-d:#D93A30;
}
body{font:13px/1.5 var(--font-body);margin:0;background:var(--bg-page);color:var(--fg);-webkit-font-smoothing:antialiased}
.banner{position:sticky;top:0;z-index:50;background:var(--bg-banner);backdrop-filter:blur(12px);
  border-bottom:1px solid var(--border-1);height:56px;padding:0 28px;display:flex;justify-content:space-between;align-items:center}
.banner h1{margin:0;font-family:var(--font-display);font-weight:700;font-size:20px;letter-spacing:-0.02em;color:var(--fg)}
.highlight{background:var(--yg-yellow);color:var(--yg-black);padding:1px 10px;border-radius:8px}
html[data-theme='light'] .highlight{background:none;color:var(--yg-black);border-radius:0;padding:0 0.18em 0 0.06em;
  background-image:linear-gradient(95deg,var(--yg-yellow) 0%,var(--yg-yellow) 35%,rgba(255,245,0,0.7) 65%,rgba(255,245,0,0.25) 88%,rgba(255,245,0,0) 100%);
  background-repeat:no-repeat;background-size:100% 60%;background-position:0 80%}
.nav{display:flex;align-items:center}
.nav a{font-family:var(--font-display);font-weight:500;color:var(--fg);text-decoration:none;margin-left:14px;
  font-size:14px;padding:8px 18px;border-radius:999px;transition:background 140ms cubic-bezier(0.16,1,0.3,1)}
.nav a:hover{background:var(--bg-subtle)}
.nav a.on{background:var(--yg-yellow);color:var(--yg-black);font-weight:700}
.menubtn{display:none;font:700 18px var(--font-display);background:var(--bg-subtle);color:var(--fg);border:1px solid var(--border-2);border-radius:999px;
  width:38px;height:38px;cursor:pointer;line-height:1;flex-shrink:0}
.menu{display:none;position:fixed;top:62px;right:12px;background:var(--bg-surface);border:1px solid var(--border-2);
  border-radius:14px;box-shadow:0 20px 48px -12px rgba(0,0,0,0.5);min-width:210px;z-index:80;padding:8px}
.menu.open{display:block}
.menu a{display:block;font-family:var(--font-display);font-weight:500;font-size:14px;color:var(--fg);
  text-decoration:none;padding:11px 16px;border-radius:8px}
.menu a:hover{background:var(--bg-subtle)}
.menu a.on{background:var(--yg-yellow);color:var(--yg-black);font-weight:700}
.menusep{height:1px;background:var(--border-1);margin:6px 8px}
.totalpill{font-family:var(--font-mono);font-weight:700;font-size:15px;padding:6px 16px;border-radius:999px}
.tp-pos{background:var(--tp-pos-bg);color:var(--pos)}
.tp-neg{background:var(--tp-neg-bg);color:var(--neg)}
.upd{display:flex;align-items:center}
#updsec{font:13px var(--font-mono);color:var(--fg);background:var(--bg-subtle);border:1px solid var(--border-1);
  border-radius:999px;padding:4px 12px;min-width:62px;text-align:center}
.content{padding:18px 28px 48px}
.datebar{display:flex;gap:8px;align-items:center}
.datebar a{font-family:var(--font-display);font-weight:700;background:var(--bg-subtle);color:var(--fg);text-decoration:none;
  border:1px solid var(--border-2);padding:5px 14px;border-radius:999px;font-size:13px}
.datebar a:hover{background:var(--border-1)}
.datebar input{font:12px var(--font-body);padding:5px 10px;border:1px solid var(--border-2);border-radius:10px;
  background:var(--bg-surface);color:var(--fg);color-scheme:dark}
html[data-theme='light'] .datebar input{color-scheme:light}
.datebar input:focus{outline:none;border-color:var(--yg-yellow);box-shadow:0 0 0 3px rgba(255,245,0,0.35)}
table{width:100%;border-collapse:separate;border-spacing:0;margin:10px 0 26px;background:var(--bg-surface);border:1px solid var(--border-2)}
td,th{border-right:1px solid var(--border-2);border-bottom:1px solid var(--border-1);padding:4px 10px;text-align:left;font-size:12px;font-variant-numeric:tabular-nums}
td:last-child,th:last-child{border-right:none}
th{position:sticky;top:56px;z-index:5;background:var(--th-bg);color:#fff;font-family:var(--font-display);
  font-weight:700;font-size:13px;letter-spacing:0.02em;padding:10px;border-color:var(--th-bg);
  border-bottom:2px solid var(--yg-yellow);white-space:nowrap}
tr:nth-child(even) td{background:var(--bg-subtle)}
.surplus{color:var(--info);font-weight:700}.deficit{color:var(--neg);font-weight:700}.mid{color:var(--fg-muted)}
.hold{color:var(--yg-black);background:var(--yg-yellow);padding:1px 6px;border-radius:6px;font-weight:600;cursor:help}
tr.now td{background:var(--tint-now) !important;border-top:2px solid var(--yg-yellow);border-bottom:2px solid var(--yg-yellow)}
html[data-theme='light'] tr.now td{border-color:var(--yg-black)}
tr.lastpos td{background:var(--tint-pos-strong) !important;border-top:2px solid var(--ic-s);border-bottom:2px solid var(--ic-s)}
tr.lastneg td{background:var(--tint-neg-strong) !important;border-top:2px solid var(--ic-d);border-bottom:2px solid var(--ic-d)}
.fc{color:var(--fg-muted);font-style:italic}
.fc-ok{color:var(--pos);font-style:italic}
.fc-bad{color:var(--neg);font-style:italic}
.pill2{font:12px var(--font-mono);background:var(--bg-subtle);border:1px solid var(--border-1);border-radius:999px;padding:5px 12px;color:var(--fg);white-space:nowrap}
.pill2 small{color:var(--fg-muted)}
.colwrap{display:flex;align-items:center;position:relative}
.colpanel{display:none;position:absolute;top:40px;right:0;background:var(--bg-surface);border:1px solid var(--border-2);
  border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.4);padding:10px 16px;z-index:60;columns:2;min-width:380px;
  max-width:calc(100vw - 16px);max-height:min(70vh,520px);overflow:auto}
.colpanel.open{display:block}
.colpanel label{display:block;font-size:12px;padding:3px 0;white-space:nowrap;cursor:pointer}
tr.winstart td{border-top:3px solid var(--fg-muted)}
tr.winend td{border-bottom:3px solid var(--fg-muted)}
/* intraday trade-gate state (75-min lead): left rail per row — grey=past, amber=locked, green=open to trade */
tr.t-past td:first-child{box-shadow:inset 3px 0 0 var(--border-2)}
tr.t-past:not(.lastpos):not(.lastneg) td{opacity:.5}
tr.t-locked td:first-child{box-shadow:inset 3px 0 0 #D9A441}
tr.t-locked td{background:rgba(217,164,65,.08)}
tr.t-open td:first-child{box-shadow:inset 3px 0 0 var(--ic-s)}
/* current TRADE interval (front of the gate, first still-tradeable) — the highlighted "trade now" row */
/* the current TRADE row + its 2 historical rows form one outlined 3-row block (green box: top on gate, sides on all 3, bottom on the −2d row) */
tr.gateopen td{background:var(--tint-pos-strong)!important;border-top:3px solid var(--ic-s);font-weight:600}
tr.gateopen td:first-child{border-left:3px solid var(--ic-s)}
tr.gateopen td:last-child{border-right:3px solid var(--ic-s)}
.tradearrow{color:var(--ic-s);font-weight:800}
.ivtimer{font:700 12px var(--font-mono);color:var(--fg);background:var(--bg-surface);padding:0 6px;border-radius:6px;white-space:nowrap;display:inline-block;min-width:4.2em;text-align:center;font-variant-numeric:tabular-nums}
.lockico{font-size:11px;filter:grayscale(.2)}
.cur{opacity:.45;font-weight:400;font-size:10px}
/* the LIVE current-state row (live Transelectrica export): twice as tall, with Real & Notif cross-border at 2× font */
tr.liverow td{padding-top:12px;padding-bottom:12px}
tr.liverow td[data-rxb],tr.liverow td.nxbcell{font-size:2em;font-weight:700;line-height:1}
tr.liverow td[data-rxb] small,tr.liverow td.nxbcell small{font-size:11px;font-weight:600}
/* historical reference sub-rows inside the trade block (same interval, prev 2 days) — dimmed + inside the green box */
tr.histrow td{font-size:12px;background:var(--bg-subtle);color:var(--fg-muted)}
/* hg = trade-row history (green box); hx = expand-icon history (neutral yellow box) */
tr.histrow.hg td:first-child{border-left:3px solid var(--ic-s)} tr.histrow.hg td:last-child{border-right:3px solid var(--ic-s)} tr.histrow.hg.histrow-last td{border-bottom:3px solid var(--ic-s)}
tr.histrow.hx td:first-child{border-left:3px solid var(--yg-yellow)} tr.histrow.hx td:last-child{border-right:3px solid var(--yg-yellow)} tr.histrow.hx.histrow-last td{border-bottom:3px solid var(--yg-yellow)}
/* the expanded parent row (non-trade) closes the top + sides of the yellow box */
tr.expanded:not(.gateopen) td{border-top:3px solid var(--yg-yellow)} tr.expanded:not(.gateopen) td:first-child{border-left:3px solid var(--yg-yellow)} tr.expanded:not(.gateopen) td:last-child{border-right:3px solid var(--yg-yellow)}
.histlbl{display:inline-block;background:var(--ic-s);color:#fff;font-size:10px;font-weight:700;padding:1px 7px;border-radius:6px}
tr.hx .histlbl{background:var(--yg-yellow);color:var(--yg-black)}
.fc-imb{font-style:italic;font-weight:600;font-size:12px;opacity:.9}.fc-imb small{font-weight:600;opacity:.7}
.fc-lock{font-weight:700;font-size:11px;opacity:.95;border:1px solid var(--border-2);border-radius:5px;padding:0 4px} /* locked = boxed, not italic */
.pfc-lock{font-weight:600;border:1px solid var(--border-2);border-radius:5px;padding:0 4px;opacity:.9} /* frozen prod forecast (independent of the predictions toggle) */
.fc-r{float:right;margin-left:6px} /* glued to the right of the Imbalance cell */
.pflag{cursor:help;font-size:12px;margin-left:3px;color:#e6a700} /* big PI repositioning on this interval */
.pflag-x{color:var(--ic-d);font-weight:700} /* repositioning AGAINST the current state (possible flip) */
.fc-s{color:var(--ic-s)} .fc-d{color:var(--ic-d)}
/* SCADA generation split, inline after the Real prod total (| separator) */
.prodmix{font-size:10px;font-weight:400;opacity:.85}
.prodmix span{margin-right:6px;white-space:nowrap}
html.mix-off .prodmix{display:none}
/* RES generation forecast (solar/wind MW) under the weather in the Weather column */
.resfc{font-size:10px;font-weight:400;opacity:.85;white-space:nowrap;margin-top:1px}
.rlbl{opacity:.45;font-weight:700;margin-right:1px}
/* RES fcst column toggle: default = weather icons (.wxw); switch ON = RES forecast (.wxr) */
.wxr{display:none}
html.res-on .wxw{display:none} html.res-on .wxr{display:inline}
html:not(.res-on) #resscore{display:none!important}
.restgl{cursor:pointer;display:inline-block;width:22px;height:12px;border-radius:7px;background:var(--border-2);position:relative;vertical-align:middle;margin-left:5px;transition:background .15s}
.restgl::after{content:'';position:absolute;top:1px;left:1px;width:10px;height:10px;border-radius:50%;background:#fff;transition:left .15s}
html.res-on .restgl{background:var(--ic-s)}
html.res-on .restgl::after{left:11px}
/* mini toggle switch in the Real prod header to show/hide the split */
.mixtgl{cursor:pointer;display:inline-block;width:22px;height:12px;border-radius:7px;background:var(--ic-s);position:relative;vertical-align:middle;margin-left:5px;transition:background .15s}
.mixtgl::after{content:'';position:absolute;top:1px;left:11px;width:10px;height:10px;border-radius:50%;background:#fff;transition:left .15s}
html.mix-off .mixtgl{background:var(--border-2)}
html.mix-off .mixtgl::after{left:1px}
.xbftgl{cursor:pointer;display:inline-block;width:22px;height:12px;border-radius:7px;background:var(--ic-s);position:relative;vertical-align:middle;margin-left:5px;transition:background .15s}
.xbftgl::after{content:'';position:absolute;top:1px;left:11px;width:10px;height:10px;border-radius:50%;background:#fff;transition:left .15s}
html.xbf-off .xbftgl{background:var(--border-2)}
html.xbf-off .xbftgl::after{left:1px}
html.xbf-off .xbf{display:none!important}
/* HU-border congestion row tints (before the xbt rules so the X-B gradient cells keep their own background):
   violet = import-congested (RO detached ABOVE the EU price), amber = export-congested (surplus trapped below). */
tr.huimp td{background-color:rgba(147,51,234,0.12)}
tr.huexp td{background-color:rgba(210,105,30,0.13)}
.xbutil{display:none;opacity:.7;font-size:10px;white-space:nowrap} /* per-row border capacity-used readout (H imp/exp · B imp/exp) — hidden by default, Int header switch */
html.xbu-on .xbutil{display:inline}
/* mini toggle switch in the Int header (same pattern as the Real prod mix switch, but default OFF) */
.xbutgl{cursor:pointer;display:inline-block;width:22px;height:12px;border-radius:7px;background:var(--border-2);position:relative;vertical-align:middle;margin-left:5px;transition:background .15s}
.xbutgl::after{content:'';position:absolute;top:1px;left:1px;width:10px;height:10px;border-radius:50%;background:#fff;transition:left .15s}
html.xbu-on .xbutgl{background:var(--ic-s)}
html.xbu-on .xbutgl::after{left:11px}
/* Real X-B gradient: green = less import than notified (surplus lean), red = more (deficit). The tint composites
   over a FIXED base (not the zebra stripe) so the column gradient FLOWS smoothly row to row. */
tr td.xbtS,tr td.xbtF{background-color:var(--bg-surface);background-image:linear-gradient(var(--xbt),var(--xbt))}
html.xbf-off tr td.xbtF{background-image:none;background-color:transparent} /* estimate hidden → tint off, zebra restored */
html.xbf-off tr:nth-child(even) td.xbtF{background-color:var(--bg-subtle)}
/* model predictions hidden by default (traders not yet briefed); header toggle flips html.preds-off */
html.preds-off .fc-imb,html.preds-off .fc-lock,html.preds-off .pflag,html.preds-off #pulsebar,html.preds-off #scorebar{display:none!important}
.predtgl{cursor:pointer} .predtgl.predon{color:var(--ic-s);font-weight:700}
.exp{cursor:pointer;display:inline-block;width:20px;height:20px;line-height:18px;text-align:center;font-size:12px;border:1px solid var(--border-2);border-radius:5px;color:var(--fg);background:var(--bg-subtle);user-select:none;margin-right:6px;vertical-align:middle}
.exp:hover{border-color:var(--yg-yellow);background:var(--yg-yellow);color:var(--yg-black)}
tr.expanded>td:first-child .exp,tr.gateopen>td:first-child .exp{border-color:var(--yg-yellow)}
.pi-i{cursor:pointer;opacity:.5;font-size:11px}.pi-i:hover{opacity:1}
.pimodal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:200;align-items:center;justify-content:center}
.pimodal.open{display:flex}
.pimbox{background:var(--bg-surface);border:1px solid var(--border-2);border-radius:12px;max-width:540px;width:92%;max-height:80vh;overflow:auto;padding:14px 16px;box-shadow:0 12px 40px rgba(0,0,0,.5)}
.pimhead{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px}
.pimx{cursor:pointer;opacity:.6;font-size:18px;line-height:1}.pimx:hover{opacity:1}
.pimbox table{width:100%;font-size:12px;border-collapse:collapse}
.pimbox th,.pimbox td{padding:4px 8px;text-align:left;border-bottom:1px solid var(--border-1)}
caption.gatecap{caption-side:top;text-align:left;padding:7px 4px;font-size:12px;color:var(--fg-muted)}
caption.gatecap b{color:var(--fg)} caption.gatecap .lk{color:#D9A441;font-weight:600} caption.gatecap .op{color:var(--ic-s);font-weight:600}
.pos{color:var(--pos);font-weight:600}.neg{color:var(--neg);font-weight:600}
tr.pnlpos td{background:var(--tint-pos)}tr.pnlneg td{background:var(--tint-neg)}
.money{font-family:var(--font-mono);font-weight:500;line-height:1}
.badge{display:inline-block;font-family:var(--font-display);font-weight:700;font-size:10px;letter-spacing:0.04em;
  padding:2px 9px;border-radius:999px;vertical-align:middle}
/* badge color follows the POSITION (blue = surplus, red = deficit); the text follows the
   page's market: PZU page shows the PZU action, PI page the balancing action */
.badge.srp{background:var(--srp-bg);color:var(--info)}
.badge.dfc{background:var(--dfc-bg);color:var(--neg)}
.badge.flip{cursor:pointer;user-select:none;min-width:34px;text-align:center}
.ic{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:999px;
  font:700 10px var(--font-display);color:#fff;vertical-align:middle;cursor:default}
.ic-s{background:var(--ic-s)}.ic-d{background:var(--ic-d)}
input.bet{width:64px;font:13px var(--font-mono);padding:3px 8px;border:1px solid var(--border-2);border-radius:10px;
  background:var(--bg-surface);color:var(--fg)}
input.bet:focus{outline:none;border-color:var(--yg-yellow);box-shadow:0 0 0 3px rgba(255,245,0,0.35)}
input.bet.auto{background:var(--auto-bg);border-color:var(--yg-yellow)}
input.bet:disabled{background:var(--bg-subtle);color:var(--fg-muted);border-color:var(--border-1)}
.lockbanner{background:var(--bg-subtle);border:1px solid var(--border-1);padding:12px 18px;margin:10px 0;border-radius:14px;font-size:12px}
button{font-family:var(--font-display);font-weight:700;font-size:12px;padding:7px 18px;cursor:pointer;
  background:var(--yg-yellow);color:var(--yg-black);border:none;border-radius:999px;transition:transform 140ms}
button:active{transform:scale(0.98)}
.meta{color:var(--fg-muted);font-size:11px;max-width:1100px}.dim td{opacity:0.5}
#status{font-size:11px;color:var(--pos);margin-left:10px;font-family:var(--font-mono)}
h2{margin:24px 0 6px;font-family:var(--font-display);font-weight:700;font-size:18px;letter-spacing:-0.01em;color:var(--fg)}
small{color:var(--fg-muted)}
.help{cursor:help;color:var(--fg-muted);font-weight:400;font-size:11px;position:relative;display:inline-block;outline:none}
.help .tip{display:none;position:absolute;top:17px;left:50%;transform:translateX(-50%);z-index:90;width:200px;
  background:var(--bg-surface);color:var(--fg);border:1px solid var(--border-2);border-radius:8px;padding:8px 11px;
  font:11px/1.45 var(--font-body);font-weight:400;text-align:left;letter-spacing:0;white-space:normal;
  box-shadow:0 8px 24px rgba(0,0,0,0.45)}
.help:hover .tip,.help.show .tip{display:block}
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.userchip{font:11px var(--font-mono);color:var(--fg-muted);margin-left:10px}
.userchip a{color:var(--fg-muted)}
.bbreak{display:none}
@media (max-width:760px){
  /* Chrome-style two-row header: row1 = columns/date/menu (hides on scroll down, returns
     on scroll up), row2 = money/exp/acc/timer (always pinned) */
  .banner{height:auto;flex-wrap:wrap;padding:6px 10px;gap:6px;row-gap:8px;overflow:visible}
  .banner h1{display:none}
  .nav{display:none}
  .r1,.colwrap{order:1}
  .bbreak{display:block;order:2;width:100%;height:0;margin:0}
  .r2{order:3}
  .menubtn{display:block;position:static;margin-left:auto;flex-shrink:0}
  .colwrap button{display:inline-block;font-size:12px;padding:6px 14px}
  .banner.hidenav .r1,.banner.hidenav .bbreak,.banner.hidenav .colwrap{display:none}
  .menu{top:calc(var(--bh,96px) + 4px)}
  .content{padding:8px 2px 40px}
  table{table-layout:auto;width:100%}
  td,th{padding:8px 5px;font-size:15px;white-space:nowrap}
  th{top:var(--bh,96px);font-size:11px;white-space:normal;padding:8px 5px}
  td small{font-size:11px}
  .ic{width:22px;height:22px;font-size:12px}
  .badge{font-size:11px;padding:3px 8px}
  input.bet{width:64px;padding:10px 6px;font-size:16px}
  .totalpill{font-size:14px;padding:6px 12px;flex-shrink:0}
  .pill2{font-size:11px;padding:4px 8px}
  .colpanel{position:fixed;top:auto;left:8px;right:8px;columns:2;min-width:0}
  h2{font-size:15px}
}
</style>`;

const dateBar = (page, date) => `<div class="datebar">
  <a href="/${page}?date=${addDays(date, -1)}">&larr; ${euDate(addDays(date, -1))}</a>
  <input type="date" value="${date}" onchange="location='/${page}?date='+this.value">
  <a href="/${page}?date=${addDays(date, 1)}">${euDate(addDays(date, 1))} &rarr;</a>
</div>`;

function pzuPage(date) {
  const d = pzuData(date);
  const fmt = (v, dec = 0) => (v === null || v === undefined ? '—' : (+v).toFixed(dec));
  const priceNum = (v, cls = '') => {
    const m = Math.abs(v);
    const size = Math.min(18, 12 + 2.2 * Math.log10(1 + m / 100));
    const weight = m < 300 ? 400 : m < 800 ? 600 : 700;
    return `<span class="money ${cls}" style="font-size:${size.toFixed(1)}px;font-weight:${weight}">${Math.round(v)}</span>`;
  };
  const dirCell = (p) => p === null ? '—'
    : `${dirIcon(p >= 0.5)} ${(Math.max(p, 1 - p) * 100).toFixed(0)}%`;
  let totalResult = 0, anyResult = false, totalModel = 0, anyModel = false;
  const rows = d.rows.map((r, i) => {
    if (r.result !== null) { totalResult += r.result; anyResult = true; }
    if (r.adviceResult !== null && r.adviceResult !== undefined) { totalModel += r.adviceResult; anyModel = true; }
    const won = r.result !== null ? r.result : (r.adviceResult ?? null);
    const priceClass = won !== null && won !== undefined ? (won >= 0 ? 'pnlpos' : 'pnlneg') : '';
    const wonCls = won === null || won === undefined ? '' : won >= 0 ? 'pos' : 'neg';
    const winClass = (r.inWindow && (i === 0 || !d.rows[i - 1].inWindow) ? ' winstart' : '')
      + (r.inWindow && (i === d.rows.length - 1 || !d.rows[i + 1].inWindow) ? ' winend' : '');
    return `<tr class="${r.inWindow ? priceClass : 'dim'}${winClass}">
    <td><b>${r.isp}</b></td><td>${r.cet}</td>
    <td>${dirCell(r.probLong)}</td>
    <td>${fmt(r.imbP50)} MWh</td>
    <td>${fmt(r.priceP50)}<br><small>${fmt(r.priceP10)} … ${fmt(r.priceP90)}</small></td>
    <td>${r.pzuRon !== null ? fmt(r.pzuRon) + (r.pzuConverted ? '<small>≈</small>' : '') : '<small>pending</small>'}</td>
    <td>${r.deskSig === null ? '<span class="mid">—</span>'
      : (r.deskSig === 'HOLD' || !r.deskQ)
        ? '<span class="hold">HOLD</span>'
        : `<span class="badge ${r.deskSig === 'BUY' ? 'srp' : 'dfc'}">${r.deskSig}</span> ${(+r.deskQ).toFixed(1)} MWh`}</td>
    <td>${r.comboSurplus === null ? '<span class="mid">—</span>'
      : `${dirIcon(r.comboSurplus)} <small>${(Math.max(r.comboP, 1 - r.comboP) * 100).toFixed(0)}%</small>${r.comboSettled ? (r.comboCorrect ? ' <span class="pos">✓</span>' : ' <span class="neg">✗</span>') : ''}`}</td>
    <td>${r.inWindow
      ? (() => {
        // PZU-side action: surplus position (+) = BUY on PZU; deficit (−) = SELL on PZU
        const srp = r.qty !== null ? r.qty > 0 : (r.adviceQty === null || r.adviceQty >= 0);
        return `<span class="badge ${srp ? 'srp' : 'dfc'} flip" id="bd${r.isp}" data-isp="${r.isp}" data-srp="${srp ? 1 : 0}" title="PZU action — click to flip">${srp ? 'BUY' : 'SELL'}</span>
         <input class="bet${r.betSource === 'auto' ? ' auto' : ''}" type="number" step="0.1" min="0" max="${d.maxMwh}" data-isp="${r.isp}" value="${r.qty !== null ? Math.abs(r.qty) : ''}" ${d.locked ? 'disabled' : ''} placeholder="0"> MWh${r.betSource === 'auto' ? ' <small title="model advice — type to override">auto</small>' : ''}`;
      })()
      : '<small>out of window</small>'}</td>
    <td>${r.imbPrice !== null && r.imbPrice !== undefined
      ? `${priceNum(r.imbPrice, wonCls)}${r.predPrice !== null ? ` <small class="${Math.abs(r.predPrice - r.imbPrice) <= Math.max(50, 0.25 * Math.abs(r.imbPrice)) ? 'fc-ok' : 'fc-bad'}">(${fmt(r.predPrice)})</small>` : ''}`
      : '—'}</td>
    <td>${r.adviceResult === null || r.adviceResult === undefined ? '' : `<span class="${r.adviceResult >= 0 ? 'pos' : 'neg'}">${fmt(r.adviceResult)} RON</span>`}</td>
    <td>${r.result === null ? '' : `<span class="${r.result >= 0 ? 'pos' : 'neg'}">${fmt(r.result)} RON</span>`}</td>
  </tr>`;
  }).join('\n');

  // header pills: realized day total (yours if you had positions, else the model's),
  // expected total at decision time, and prediction accuracy for the day
  const expTotal = db.prepare(`
    SELECT SUM(b.exp_revenue) s FROM bets b
    JOIN (SELECT ts_utc, MAX(run_at) mr FROM bets WHERE actionable=1 AND date_ro=? GROUP BY ts_utc) x
      ON x.ts_utc=b.ts_utc AND x.mr=b.run_at
    WHERE b.date_ro=? AND b.qty > 0`).get(date, date).s;
  let accHits = 0, accN = 0, winHits = 0, winN = 0;
  for (const r of d.rows) {
    if (r.probLong !== null && r.imb !== null && r.imb !== undefined) {
      accN++; if ((r.probLong >= 0.5) === (r.imb > 0)) accHits++;
    }
    if (r.adviceResult !== null && r.adviceResult !== undefined) {
      winN++; if (r.adviceResult >= 0) winHits++;
    }
  }
  const accPill = accN
    ? `<span class="pill2 r2" title="decision-time prediction direction accuracy"><small>acc</small> ${Math.round(accHits / accN * 100)}%</span>`
    : winN
      ? `<span class="pill2 r2" title="model position win rate (no stored predictions for this day)"><small>win</small> ${Math.round(winHits / winN * 100)}%</span>`
      : '';
  const dayTotal = anyResult ? totalResult : anyModel ? totalModel : null;
  const extras = `
    ${dayTotal !== null ? `<span class="totalpill r2 ${dayTotal >= 0 ? 'tp-pos' : 'tp-neg'}" title="${anyResult ? 'your realized day total' : 'model realized day total'}">${Math.round(dayTotal).toLocaleString('en-US')} RON</span>` : ''}
    <span class="pill2 r2" title="expected day total at decision time"><small>exp</small> ${expTotal !== null ? Math.round(expTotal).toLocaleString('en-US') : '—'}</span>
    ${accPill}
    ${colPicker('cols-pzu')}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#FFF500"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="GAN Trading"><link rel="apple-touch-icon" href="/icon-180.png"><title>PZU ${date}</title>${STYLE}</head><body>
${NAV('pzu', date, null, extras)}<div class="content">
<h2>PZU positions — ${dayTitle(date)} (delivery day)</h2>
<div class="lockbanner">${d.locked
    ? `🔒 Locked since 10:00 CET on ${euDate(addDays(date, -1))}. <button onclick="unlock()">Unlock</button>`
    : d.unlocked
      ? `⚠ Manually UNLOCKED — changes are being recorded after the deadline. <button onclick="lockAgain()">Lock again</button>`
      : `Editable until 10:00 CET on ${euDate(addDays(date, -1))} (then locked).`}
  <span id="status"></span></div>
<table><tr><th>Interval</th><th>CET</th><th>Prediction</th><th title="predicted imbalance, MWh">Imbalance</th><th title="predicted imbalance price, RON/MWh">Price</th><th title="PZU price, RON/MWh">PZU</th><th title="external RO Signal Override desk — BUY/SELL/HOLD + Q (MW). Night intervals are BUY/HOLD only. Replaces our old model advice as the position.">Desk (PZU)</th><th title="xb_combo day-ahead-commitment colour signal — SHADOW, live-scored, NOT driving the position yet">Combo<br><small>shadow</small></th><th title="MWh, PZU-side action">Your position</th><th title="realized imbalance price, RON/MWh">Realized</th><th title="RON">Model result</th><th title="RON">Result</th></tr>
${rows}
${anyResult || anyModel ? `<tr><td colspan="10" style="text-align:right"><b>Day total</b></td>
<td>${anyModel ? `<b class="${totalModel >= 0 ? 'pos' : 'neg'}">${Math.round(totalModel).toLocaleString('en-US')} RON</b>` : ''}</td>
<td>${anyResult ? `<b class="${totalResult >= 0 ? 'pos' : 'neg'}">${Math.round(totalResult).toLocaleString('en-US')} RON</b>` : ''}</td></tr>` : ''}
</table>
<script>
const DATE=${JSON.stringify(date)};
const LOCKED=${d.locked ? 'true' : 'false'};
async function saveBet(isp){
  const el=document.querySelector('input.bet[data-isp="'+isp+'"]');
  const bd=document.getElementById('bd'+isp);
  const abs=el.value===''?0:Math.abs(parseFloat(el.value));
  // badge shows the PZU action: BUY on PZU = surplus = positive qty
  const qty=bd.dataset.srp==='1'?abs:-abs;
  const r=await fetch('/api/bet',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({date:DATE,isp:+isp,qty})});
  const j=await r.json();
  document.getElementById('status').textContent=j.ok?('saved '+new Date().toLocaleTimeString()):('ERROR: '+j.error);
  el.style.background=j.ok?'':'#fdd';
}
document.querySelectorAll('input.bet').forEach(el=>{
  el.addEventListener('change',()=>saveBet(el.dataset.isp));
});
document.querySelectorAll('.badge.flip').forEach(bd=>{
  bd.addEventListener('click',()=>{
    if(LOCKED)return;
    const srp=bd.dataset.srp!=='1';
    bd.dataset.srp=srp?'1':'0';bd.className='badge flip '+(srp?'srp':'dfc');bd.textContent=srp?'BUY':'SELL';
    const el=document.querySelector('input.bet[data-isp="'+bd.dataset.isp+'"]');
    if(el&&el.value!=='')saveBet(bd.dataset.isp);
  });
});
async function unlock(){await fetch('/api/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date:DATE})});location.reload()}
async function lockAgain(){await fetch('/api/lock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date:DATE})});location.reload()}
</script>
</div></body></html>`;
}

function piPage(date) {
  const cfg = loadConfig();
  const lockAt = lockTimeFor(date).toISOString();
  // D-1 10:00 CET view — what the PZU decision was based on
  const d1Run = db.prepare('SELECT MAX(run_at) m FROM predictions WHERE run_at<=? AND date_ro=?').get(lockAt, date).m;
  const d1 = d1Run
    ? new Map(db.prepare('SELECT * FROM predictions WHERE run_at=? AND date_ro=?').all(d1Run, date).map((r) => [r.isp, r]))
    : new Map();
  // latest live view (only contains upcoming ISPs)
  const liveRun = db.prepare('SELECT MAX(run_at) m FROM predictions WHERE date_ro=?').get(date).m;
  const live = liveRun
    ? new Map(db.prepare('SELECT * FROM predictions WHERE run_at=? AND date_ro=?').all(liveRun, date).map((r) => [r.isp, r]))
    : new Map();
  // PI-locked view: last prediction issued >= 75 min before each ISP (the binding one)
  const piLocked = new Map(db.prepare(`
    SELECT p.isp, p.prob_long, p.price_p50, p.imb_p50 FROM predictions p
    JOIN (SELECT ts_utc, MAX(run_at) mr FROM predictions WHERE actionable=1 AND date_ro=? GROUP BY ts_utc) x
      ON x.ts_utc=p.ts_utc AND x.mr=p.run_at
    WHERE p.date_ro=?`).all(date, date).map((r) => [r.isp, r]));
  const userBets = new Map(db.prepare('SELECT isp, qty, source FROM user_bets WHERE date_ro=?').all(date).map((r) => [r.isp, r]));

  // country system data for the day: generation per source, flows per border (realized),
  // scheduled exchanges (commitments), DA net position
  const sysRows = db.prepare(`
    SELECT series, ts_utc, value FROM series
    WHERE date_ro=? AND (series LIKE 'gen_actual_%' OR series LIKE 'flow_%' OR series LIKE 'sched_%')
  `).all(date);
  const genMap = new Map(), flowMap = new Map(), schedMap = new Map();
  for (const r of sysRows) {
    if (r.series.startsWith('gen_actual_')) {
      if (!genMap.has(r.ts_utc)) genMap.set(r.ts_utc, {});
      genMap.get(r.ts_utc)[r.series.slice(11)] = r.value;
    } else {
      const m = r.series.startsWith('flow_') ? flowMap : schedMap;
      if (!m.has(r.ts_utc)) m.set(r.ts_utc, {});
      m.get(r.ts_utc)[r.series] = r.value;
    }
  }
  const SRC_LABEL = {
    hydro_reservoir: 'hidro lac', hydro_ror: 'hidro râu', hydro_pumped: 'pompaj',
    solar: 'solar', wind_onshore: 'eolian', nuclear: 'nuclear', gas: 'gaz',
    lignite: 'lignit', hard_coal: 'huilă', biomass: 'biomasă', B25: 'stocare', other: 'altele',
  };
  const xbNet = (m, ts, pfxIn, pfxOut) => {
    const v = m.get(ts);
    if (!v) return { net: null, parts: [] };
    let imp = 0, exp = 0;
    const parts = [];
    for (const cc of ['HU', 'BG', 'RS', 'UA', 'MD']) {
      const i = v[`${pfxIn}_${cc}_RO`], e = v[`${pfxOut}_RO_${cc}`];
      if (i !== undefined) imp += i;
      if (e !== undefined) exp += e;
      if (i !== undefined || e !== undefined) {
        const net = (e ?? 0) - (i ?? 0);
        parts.push(`${cc} ${net >= 0 ? '↑' : '↓'}${Math.round(Math.abs(net))}`);
      }
    }
    return { net: exp - imp, parts };
  };

  // decision-time predicted prices from the bets log (covers backtest history where the
  // predictions table has no rows)
  const betPred = new Map(db.prepare(`
    SELECT b.isp, b.exp_price FROM bets b
    JOIN (SELECT ts_utc, MAX(run_at) mr FROM bets WHERE actionable=1 AND date_ro=? AND run_at<=? GROUP BY ts_utc) x
      ON x.ts_utc=b.ts_utc AND x.mr=b.run_at
    WHERE b.date_ro=?`).all(date, lockAt, date).map((r) => [r.isp, r.exp_price]));
  // last-resort: latest estimate issued before the interval started, even inside the freeze
  // window (non-binding — shown with an asterisk)
  const anyPred = new Map(db.prepare(`
    SELECT p.isp, p.prob_long, p.imb_p50, p.price_p50 FROM predictions p
    JOIN (SELECT ts_utc, MAX(run_at) mr FROM predictions WHERE run_at < ts_utc AND date_ro=? GROUP BY ts_utc) x
      ON x.ts_utc=p.ts_utc AND x.mr=p.run_at
    WHERE p.date_ro=?`).all(date, date).map((r) => [r.isp, r]));

  const fmt = (v) => (v === null || v === undefined ? '—' : Math.round(v));
  // balancing price digits grow + embolden with magnitude: ~12px/400 at small, 18px/700 at extreme
  const priceNum = (v, cls = '') => {
    const m = Math.abs(v);
    const size = Math.min(18, 12 + 2.2 * Math.log10(1 + m / 100));
    const weight = m < 300 ? 400 : m < 800 ? 600 : 700;
    return `<span class="money ${cls}" style="font-size:${size.toFixed(1)}px;font-weight:${weight}">${Math.round(v)}</span>`;
  };
  const dirOnly = (p) => p === null || p === undefined ? '—'
    : dirIcon(p >= 0.5);
  const predCell = (r) => !r ? '—'
    : `${dirOnly(r.prob_long)} ${(Math.max(r.prob_long, 1 - r.prob_long) * 100).toFixed(0)}% <small>${fmt(r.price_p50)} RON</small>`;

  const [wh0, wh1] = cfg.trade_window_cet || [7, 22];
  const winFrom = (wh0 + 1) * 4 + 1, winTo = (wh1 + 1) * 4 + 1; // +1 → include the wh1:00-starting row (e.g. 22:00)
  const nowInfo = roDateIsp(new Date());
  const nowMs = Date.now();
  // preload every per-interval point-series for the day in ONE indexed query (was ~11 sv() PK
  // lookups × 96 rows ≈ 1000+ prepared-stmt hits per request) → svL() reads from this map
  const PT_SERIES = ['damas_est_sys_imbalance', 'damas_est_price_pos', 'pzu_ron', 'da_price', 'gen_fc_da', 'damas_consumption', 'load_actual', 'load_fc_da', 'net_pos_da'];
  const ptMap = new Map();
  for (const r of db.prepare(`SELECT series, ts_utc, value FROM series WHERE date_ro=? AND series IN (${PT_SERIES.map(() => '?').join(',')})`).all(date, ...PT_SERIES)) ptMap.set(r.series + '|' + r.ts_utc, r.value);
  const svL = (name, ts) => { const v = ptMap.get(name + '|' + ts); return v === undefined ? null : v; };
  // last interval already settled with real data (gets the green highlight)
  let lastRealIsp = null;
  for (const { isp, ts } of dayTimestamps(date)) {
    if (new Date(ts).getTime() + 900000 <= nowMs && svL('damas_est_sys_imbalance', ts) !== null) lastRealIsp = isp;
  }
  let cum = 0, settled = 0, committed = 0, hits = 0, judged = 0, lockHits = 0, lockJudged = 0;
  // external desk day-ahead PZU plan (BUY/SELL/HOLD + Q) — shown as a reference column
  let extPi = new Map();
  try { extPi = new Map(db.prepare('SELECT isp, sig, q FROM ext_signals WHERE date_ro=?').all(date).map((r) => [r.isp, r])); } catch { /* ext_signals not present yet */ }
  const body = dayTimestamps(date).map(({ isp, ts }) => {
    const tsMs = new Date(ts).getTime();
    const _es = extPi.get(isp);
    const deskC = _es ? (_es.sig === 'HOLD' || !_es.q ? '<span class="hold">HOLD</span>' : `<span class="badge ${_es.sig === 'BUY' ? 'srp' : 'dfc'}">${_es.sig}</span> ${(+_es.q).toFixed(1)}`) : '';
    const isCurrent = nowInfo.date === date && nowMs >= tsMs && nowMs < tsMs + 900000;
    const isPast = tsMs + 900000 <= nowMs;
    const p1 = d1.get(isp);
    const pl = live.get(isp) || piLocked.get(isp);
    const imb = svL('damas_est_sys_imbalance', ts);
    const imbPrice = svL('damas_est_price_pos', ts);
    const pzuOff = svL('pzu_ron', ts);
    const pzuRon = pzuOff !== null ? pzuOff : (svL('da_price', ts) !== null ? svL('da_price', ts) * cfg.eur_ron : null);
    const ub = userBets.get(isp);
    const qty = ub?.qty ?? null;
    if (qty) committed += Math.abs(qty);
    const pnl = qty && imbPrice !== null && pzuRon !== null ? qty * (imbPrice - pzuRon) : null;
    if (pnl !== null) { cum += pnl; settled++; }

    // Type / Qty / Price: realized for past intervals, predicted (italic) for current+future
    let typeC = '—', qtyC = '—', priceC = '—', isFc = false;
    if (isPast && imb !== null) {
      // prediction to compare against: binding (locked / D-1) first, else any pre-interval
      // estimate (starred), else the backtest's decision-time price
      let pred = piLocked.get(isp) || p1 || null;
      let nonBinding = false;
      if (!pred && anyPred.has(isp)) { pred = anyPred.get(isp); nonBinding = true; }
      const star = nonBinding ? '*' : '';
      // bracket colored by prediction accuracy: green = got it, red = missed
      const br = (v, ok) => ` <small class="${ok === null ? 'fc' : ok ? 'fc-ok' : 'fc-bad'}">(${v}${star})</small>`;

      const dirOk = pred ? (pred.prob_long >= 0.5) === (imb > 0) : null;
      typeC = `${dirIcon(imb > 0)}${pred ? br(pred.prob_long >= 0.5 ? 'S' : 'D', dirOk) : ''}`;
      const predQty = pred?.imb_p50 !== null && pred?.imb_p50 !== undefined ? Math.abs(pred.imb_p50) : null;
      const qtyOk = predQty !== null ? Math.abs(predQty - Math.abs(imb)) <= Math.max(20, 0.3 * Math.abs(imb)) : null;
      qtyC = `${Math.abs(imb).toFixed(0)}${predQty !== null ? br(predQty.toFixed(0), qtyOk) : ''}`;
      const predPrice = pred?.price_p50 ?? betPred.get(isp) ?? null;
      const priceOk = predPrice !== null && imbPrice !== null
        ? Math.abs(predPrice - imbPrice) <= Math.max(50, 0.25 * Math.abs(imbPrice)) : null;
      const wonCls = pnl === null ? '' : pnl >= 0 ? 'pos' : 'neg';
      priceC = imbPrice !== null
        ? `${priceNum(imbPrice, wonCls)}${predPrice !== null ? br(Math.round(predPrice), priceOk) : ''}`
        : '—';
    } else if (pl) {
      isFc = true;
      typeC = dirOnly(pl.prob_long);
      qtyC = pl.imb_p50 !== null && pl.imb_p50 !== undefined ? Math.abs(pl.imb_p50).toFixed(0) : '—';
      priceC = pl.price_p50 !== null ? String(Math.round(pl.price_p50)) : '—';
    }

    if (p1 && imb !== null && isPast) {
      // D-1 hit tracking feeds the banner stat only (columns removed per user)
      judged++; if ((p1.prob_long >= 0.5) === (imb > 0)) hits++;
    }
    const lk = piLocked.get(isp);
    if (lk && imb !== null && isPast) {
      lockJudged++; if ((lk.prob_long >= 0.5) === (imb > 0)) lockHits++;
    }

    // country system cells: realized for past intervals, forecast (italic) for the rest
    let prodC = '', prodTitle = '', consC = '', xbC = '', sysFc = !isPast;
    const gen = genMap.get(ts);
    if (isPast && gen) {
      const total = Object.values(gen).reduce((s, v) => s + v, 0);
      prodC = String(Math.round(total));
      prodTitle = Object.entries(gen).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${SRC_LABEL[k] || k}: ${Math.round(v)} MW`).join('\n');
    } else {
      const fc = svL('gen_fc_da', ts);
      if (fc !== null) { prodC = String(Math.round(fc)); prodTitle = 'DA generation forecast (total)'; }
    }
    if (isPast) {
      const dc = svL('damas_consumption', ts);
      const la = svL('load_actual', ts);
      consC = dc !== null ? String(Math.round(dc * 4)) : la !== null ? String(Math.round(la)) : '';
    } else {
      const lf = svL('load_fc_da', ts);
      if (lf !== null) consC = String(Math.round(lf));
    }
    {
      const arrow = (v) => `${v >= 0 ? '↑' : '↓'}${Math.round(Math.abs(v))}`;
      const xb = isPast ? xbNet(flowMap, ts, 'flow', 'flow') : xbNet(schedMap, ts, 'sched', 'sched');
      if (xb.net !== null) {
        let schedBr = '';
        if (isPast) {
          const sc = xbNet(schedMap, ts, 'sched', 'sched');
          if (sc.net !== null) schedBr = ` <small class="fc">(${arrow(sc.net)})</small>`;
        }
        xbC = `<span title="${(isPast ? 'physical flows (scheduled)' : 'scheduled') + ' — ' + xb.parts.join(' | ')}">${arrow(xb.net)}</span>${schedBr}`;
      }
    }
    const npda = svL('net_pos_da', ts);
    const pzuCommitC = npda !== null ? `${npda >= 0 ? '↑' : '↓'}${Math.round(Math.abs(npda))}` : '';
    const inWindow = isp >= winFrom && isp <= winTo;
    const priceClass = inWindow && pnl !== null ? (pnl >= 0 ? 'pnlpos' : 'pnlneg') : '';
    const lastClass = imbPrice !== null && imbPrice < 0 ? 'lastneg' : 'lastpos';
    const winClass = (isp === winFrom ? ' winstart' : '') + (isp === winTo ? ' winend' : '');
    return `<tr class="${isCurrent ? 'now' : isp === lastRealIsp ? lastClass : priceClass}${winClass}">
      <td><b>${isp}</b>${isCurrent ? ' ▶' : isp === lastRealIsp ? ' ●' : ''}</td><td>${cetLabel(isp)}</td>
      <td class="${isFc ? 'fc' : ''}">${typeC}</td>
      <td class="${isFc ? 'fc' : ''}">${qtyC}</td>
      <td class="${isFc ? 'fc' : ''}">${priceC}</td>
      <td class="${sysFc ? 'fc' : ''}"${prodTitle ? ` title="${prodTitle}"` : ''}>${prodC}</td>
      <td class="${sysFc ? 'fc' : ''}">${consC}</td>
      <td class="${sysFc ? 'fc' : ''}">${xbC}</td>
      <td>${deskC}</td>
      <td>${pzuCommitC}</td>
      <td>${qty ? `<span class="badge ${qty > 0 ? 'srp' : 'dfc'}">${qty > 0 ? 'SELL' : 'BUY'}</span> ${Math.abs(qty).toFixed(1)}${ub.source === 'auto' ? ' <small>auto</small>' : ''}` : ''}</td>
      <td>${pnl === null ? '' : `<span class="${pnl >= 0 ? 'pos' : 'neg'}">${fmt(pnl)}</span>`}</td>
    </tr>`;
  }).join('\n');

  // next backend data refresh: last DAMAS pull + 5 min cycle (+20s for the pull to finish)
  const lastPull = db.prepare(`SELECT MAX(finished) m FROM pull_log WHERE source='damas:estimatedImbalancePrices'`).get().m;
  let updLeft = 60;
  if (lastPull) {
    updLeft = Math.round((new Date(lastPull).getTime() + 320000 - Date.now()) / 1000);
    if (updLeft < 5) updLeft = 30; // pull overdue/in flight — check again shortly
  }
  // model's expected total for the day (locked positions' expected revenue)
  const expTotal = db.prepare(`
    SELECT SUM(b.exp_revenue) s FROM bets b
    JOIN (SELECT ts_utc, MAX(run_at) mr FROM bets WHERE actionable=1 AND date_ro=? GROUP BY ts_utc) x
      ON x.ts_utc=b.ts_utc AND x.mr=b.run_at
    WHERE b.date_ro=? AND b.qty > 0`).get(date, date).s;
  const extras = `
    <span class="totalpill r2 ${cum >= 0 ? 'tp-pos' : 'tp-neg'}" title="realized day P&L">${Math.round(cum).toLocaleString('en-US')} RON</span>
    <span class="pill2 r2" title="model's expected day total at decision time"><small>exp</small> ${expTotal !== null ? Math.round(expTotal).toLocaleString('en-US') : '—'}</span>
    <span class="pill2 r2" title="locked prediction direction accuracy today"><small>acc</small> ${lockJudged ? Math.round(lockHits / lockJudged * 100) + '%' : '—'}</span>
    ${colPicker('cols-pi', [0, 5, 6, 7, 8])}`; // phone default: CET, Type, Qty, Price, position, P&L
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#FFF500"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="GAN Trading"><link rel="apple-touch-icon" href="/icon-180.png"><title>PI ${date}</title>${STYLE}</head><body>
${NAV('pi', date, { left: updLeft, period: 300 }, extras)}<div class="content">
<table><tr><th>Interval</th><th>CET</th><th>Type</th><th title="system imbalance, MWh">Qty</th><th title="imbalance price, RON/MWh">Price</th><th title="country generation [MW]; hover a value for the per-source split">Prod</th><th title="consumption [MW]">Cons</th><th title="net cross-border [MW]: ↑ export, ↓ import">X-B</th><th title="external RO Signal Override desk — day-ahead PZU plan (BUY/SELL/HOLD + Q MW). Night = buy-only.">PZU plan</th><th title="DA-coupling net position committed yesterday on PZU [MW]: ↑ export, ↓ import">PZU D−1</th><th title="your position [MWh], balancing-side action">My position</th><th title="RON">P&amp;L</th></tr>
${body}</table></div>
<script>window.addEventListener('DOMContentLoaded',function(){
  var n=document.querySelector('tr.now')||document.querySelector('tr.lastpos,tr.lastneg');
  if(n)setTimeout(function(){n.scrollIntoView({block:'center'})},50);
});</script>
</body></html>`;
}

// ---- widget support: key auth (auto-generated on first boot) + compact day summary ----
const WIDGET_KEY = (() => {
  const f = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'widget.key'); // CLOUD: /data on Render
  try { return fs.readFileSync(f, 'utf8').trim(); }
  catch {
    const k = require('crypto').randomBytes(16).toString('hex');
    fs.writeFileSync(f, k);
    return k;
  }
})();

function widgetData() {
  const cfg = loadConfig();
  const today = roDateIsp(new Date()).date;
  const userBets = new Map(db.prepare('SELECT isp, qty FROM user_bets WHERE date_ro=?').all(today).map((r) => [r.isp, r.qty]));
  let pnl = 0, settled = 0;
  const intervals = [];
  for (const { isp, ts } of dayTimestamps(today)) {
    const imbPrice = sv('damas_est_price_pos', ts);
    const imb = sv('damas_est_sys_imbalance', ts);
    if (imbPrice !== null && imb !== null) {
      intervals.push({
        cet: cetLabel(isp).replace(/<[^>]+>/g, ''),
        dir: imb > 0 ? 'S' : 'D',
        qty: Math.round(Math.abs(imb)),
        price: Math.round(imbPrice),
      });
    }
    const qty = userBets.get(isp);
    if (qty && imbPrice !== null) {
      const pzu = sv('pzu_ron', ts) ?? (sv('da_price', ts) !== null ? sv('da_price', ts) * cfg.eur_ron : null);
      if (pzu !== null) { pnl += qty * (imbPrice - pzu); settled++; }
    }
  }
  const last3 = intervals.slice(-3).reverse(); // newest first
  const acc = db.prepare(`
    SELECT COUNT(*) n, SUM(CASE WHEN (p.prob_long>0.5)=(p.realized_imb>0) THEN 1 ELSE 0 END) h
    FROM predictions p
    JOIN (SELECT ts_utc, MAX(run_at) mr FROM predictions WHERE actionable=1 AND date_ro=? GROUP BY ts_utc) x
      ON x.ts_utc=p.ts_utc AND x.mr=p.run_at
    WHERE p.date_ro=? AND p.realized_imb IS NOT NULL`).get(today, today);
  return {
    date: today, pnl: Math.round(pnl), settled,
    acc: acc.n ? Math.round(acc.h / acc.n * 100) : null,
    last3, // newest first: [{cet, dir, qty, price}, ...]
    // kept for older widget scripts:
    lastCet: last3[0]?.cet ?? null, lastPrice: last3[0]?.price ?? null, lastDir: last3[0]?.dir ?? null,
    ts: new Date().toISOString(),
  };
}

// ---- shared DAMAS II API base (used by liveReport and the live page fetches) ----
// Pure live fetch (independent of the pull job), 55s server-side cache. Renders like the PI
// page: all 96 intervals chronological, current=yellow ▶, last-settled=green ●, window rails.
const DAMAS_BASE = 'https://newmarkets.transelectrica.ro/usy-durom-publicreportg01/00121002500000000000000000000100/';
// Node's fetch has NO timeout — transelectrica.ro intermittently stops responding to server-to-server requests
// (black-holes the connection), which would hang the awaiting page (/predict, /pilearn) FOREVER. Wrap every live
// fetch so a dead host ABORTS (→ the caller's .catch → cached/last-good data) instead of freezing the request.
// The body is read INSIDE the timer too, so a headers-then-stalled-body can't slip past.
async function fetchT(url, opts = {}, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } finally { clearTimeout(t); }
}
// Per-endpoint circuit breakers for the flaky live host: after a failure, skip that endpoint for a cooldown and
// serve last-good/cache immediately (→ /predict stays fast during an outage), then one request re-probes.
function makeBreaker(cooldownMs = 45000) { let until = 0; return { down: () => Date.now() < until, markDown: () => { until = Date.now() + cooldownMs; }, markUp: () => { until = 0; } }; }
const graficBrk = makeBreaker();   // liveSEN (SEN-grafic feed)
const filterBrk = makeBreaker();   // liveSenFilter (sen-filter homepage feed)
// generic single-report DAMAS fetch (15s cache) — shared by the Predict and PI-learn pages
const reportCache = {};
async function liveReport(cmd, date) {
  const key = cmd + '|' + date;
  const c = reportCache[key];
  if (c && Date.now() - c.at < 15000) return c.map; // 15s — near-realtime for the Predict page
  const from = new Date(new Date(date + 'T00:00:00Z').getTime() - 86400000).toISOString();
  const to = new Date(new Date(date + 'T00:00:00Z').getTime() + 86400000).toISOString();
  const u = new URL(DAMAS_BASE + 'publicReport/' + cmd);
  u.searchParams.set('timeInterval', JSON.stringify({ from, to }));
  const res = await fetchT(u, {}, 6000);
  const all = (res.ok ? JSON.parse(res.text).itemList : null) || [];
  const map = new Map();
  for (const it of all) { const ri = roDateIsp(new Date(it.timeInterval.from)); if (ri.date === date) map.set(ri.isp, it); }
  reportCache[key] = { at: Date.now(), map };
  return map;
}
const rnum = (v) => { const n = Number(v); return v !== null && v !== undefined && v !== 'N/A' && Number.isFinite(n) ? n : null; };

// ---- Transelectrica live SEN feed (real-time national prod/cons/balance + per-source) ----
// Hidden Liferay resource endpoint behind the "Stare SEN in timp real" page. Comma/pipe/semicolon
// delimited: rows split by '|', fields by ';' = time;Consum;AvgConsum;Productie;Sold;Coal;Hydro;
// Gas;Nuclear;Wind;Solar;Biomass. ~10-min cadence, fresh to the minute, date-range capable.
// Replaces ENTSO-E gen_actual (which lagged ~1h and arrived with incomplete plant types).
const senCache = {};
async function liveSEN(date, maxAge = 45000) {
  const c = senCache[date];
  // 45s default cache: SEN only updates ~10 min, and the host intermittently 404s server-to-server requests
  // (esp. from cloud egress) — refetching too often just invites failures. Reuse only a NON-EMPTY fresh cache.
  // The live current-interval Real-X-B endpoint passes a shorter maxAge (~20s) to track the current interval.
  if (c && c.map.size && Date.now() - c.at < maxAge) return c.map;
  if (graficBrk.down()) return c ? c.map : new Map(); // breaker open → last-good, don't hit the dead host
  const [y, mo, d] = date.split('-');
  const pre = '&_SENGrafic_WAR_SENGraficportlet_';
  const u = 'https://www.transelectrica.ro/widget/web/tel/sen-grafic?p_p_id=SENGrafic_WAR_SENGraficportlet&p_p_lifecycle=2&p_p_state=maximized&p_p_mode=view&p_p_cacheability=cacheLevelPage'
    + pre + 'random=' + Date.now()
    + pre + 'start_day=' + (+d) + pre + 'start_month=' + (+mo) + pre + 'start_year=' + y + pre + 'start_Hour=0' + pre + 'start_Minute=0'
    + pre + 'end_day=' + (+d) + pre + 'end_month=' + (+mo) + pre + 'end_year=' + y + pre + 'end_Hour=23' + pre + 'end_Minute=59';
  const HDRS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'Accept': '*/*', 'X-Requested-With': 'XMLHttpRequest' };
  // Retry the flaky SEN host; NEVER cache an empty result — fall back to last-good so Real columns don't blank.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetchT(u, { headers: HDRS }, 3500);
      if (r.ok) {
        const t = r.text;
        const map = new Map();
        for (const row of t.split('|')) {
          const f = row.split(';');
          if (f.length < 12) continue;
          const m = /(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})/.exec(f[0].trim());
          if (!m) continue;
          const isp = Math.floor((+m[4] * 60 + +m[5]) / 15) + 1; // RO-local minutes → ISP (last sample wins)
          map.set(isp, { cons: +f[1], prod: +f[3], sold: +f[4] });
        }
        if (map.size) { senCache[date] = { at: Date.now(), map }; graficBrk.markUp(); return map; }
      }
    } catch { /* fall through to retry */ }
    if (attempt < 2) await new Promise((res) => setTimeout(res, 500));
  }
  graficBrk.markDown(); // host unresponsive → open the breaker so the next loads skip it
  return c ? c.map : new Map(); // all attempts failed → last-good (stale) data, else empty
}

// ---- Transelectrica live homepage feed (sen-filter, ~10s) via shared tool/sen_filter.js. Caches 10s for the
// live UI and RECORDS every distinct snapshot (decoded core + full raw) to sen_live for prediction.
const senFilter = require('./sen_filter');
try { senFilter.ensureTable(db); } catch (e) { console.error('sen_live table:', e.message); }
// live sign predictor (P(surplus) per upcoming interval). Model trained on settled history, cached + retrained hourly.
const signModel = require('./sign_model');
const resModel = require('./res_model');
let signCache = { model: null, trainedAt: null, inlineAt: 0 };
let resCache = { model: null, trainedAt: null, inlineAt: 0 };
// Load a precomputed model from model_cache (written by tool/train_models.js, every ~30min) — NEVER train on the
// request/event-loop path when a fresh precompute exists. Fall back to inline train (hourly) only if the job is down.
function loadModel(name, cache, trainFn) {
  try {
    const r = db.prepare('SELECT json, trained_at FROM model_cache WHERE name=?').get(name);
    if (r && Date.now() - Date.parse(r.trained_at) < 5400000) { // fresh precompute (<90min)
      if (cache.trainedAt !== r.trained_at) { cache.model = JSON.parse(r.json); cache.trainedAt = r.trained_at; }
      return cache.model;
    }
  } catch { /* model_cache may not exist yet */ }
  if (!cache.model || Date.now() - cache.inlineAt > 3600000) { try { cache.model = trainFn(db); cache.inlineAt = Date.now(); cache.trainedAt = 'inline'; } catch (e) { console.error(name + '_model train:', e.message); } }
  return cache.model;
}
function getSignModel() { return loadModel('sign', signCache, signModel.train); }
function getResModel() { return loadModel('res', resCache, resModel.train); }
// Live regime anchors as of a publication-safe cutoff (= decision time for all upcoming intervals; matches training):
//   persist = freshest settled imbalance; fracsurp = surplus-fraction of the last FRAC_W settled; netting = export−import.
function liveRegime(cutoffMs) {
  const cut = new Date(cutoffMs).toISOString();
  const recent = db.prepare("SELECT value FROM series WHERE series='damas_est_sys_imbalance' AND value IS NOT NULL AND ts_utc<=? ORDER BY ts_utc DESC LIMIT ?").all(cut, signModel.FRAC_W);
  if (!recent.length) return null;
  const e = db.prepare("SELECT value FROM series WHERE series='damas_netting_export' AND value IS NOT NULL AND ts_utc<=? ORDER BY ts_utc DESC LIMIT 1").get(cut);
  const i = db.prepare("SELECT value FROM series WHERE series='damas_netting_import' AND value IS NOT NULL AND ts_utc<=? ORDER BY ts_utc DESC LIMIT 1").get(cut);
  return { persist: recent[0].value, fracsurp: recent.filter((r) => r.value > 0).length / recent.length, netting: e && i ? e.value - i.value : 0 };
}
// notif_bal for an upcoming interval = notif_prod − notif_cons − net_export_schedule (the "Notif bal" sign-model
// feature). Forward schedules keyed by (date_ro, isp); returns null if prod/cons or all cross-border legs are absent.
const _nbStmt = db.prepare("SELECT series, value FROM series WHERE date_ro=? AND isp=? AND series IN ('damas_notif_prod','damas_notif_cons','sched_RO_HU','sched_RO_BG','sched_RO_RS','sched_RO_UA','sched_RO_MD','sched_HU_RO','sched_BG_RO','sched_RS_RO','sched_UA_RO','sched_MD_RO')");
const _nbPi = db.prepare('SELECT commercial FROM xb_pi_snap WHERE date_ro=? AND isp=? AND commercial IS NOT NULL ORDER BY pulled_at DESC LIMIT 1');
function notifBalFor(date, isp) {
  const m = {}; try { for (const r of _nbStmt.all(date, isp)) m[r.series] = r.value; } catch { return null; }
  const P = m.damas_notif_prod, C = m.damas_notif_cons; if (P == null || C == null) return null;
  // net export: prefer the LIVE PI commercial (= the page's Notif X-B; moves intraday as trades land) so the forecast
  // tracks the cross-border PI; fall back to the day-ahead schedule (same final value) when no PI snapshot exists.
  let net = null; try { const pi = _nbPi.get(date, isp); if (pi && pi.commercial != null) net = pi.commercial; } catch { /* fall through */ }
  if (net == null) { let e = 0, i = 0, any = false; for (const b of ['HU', 'BG', 'RS', 'UA', 'MD']) { const ev = m['sched_RO_' + b], iv = m['sched_' + b + '_RO']; if (ev != null) { e += ev; any = true; } if (iv != null) { i += iv; any = true; } } if (!any) return null; net = e - i; }
  return P - C - net;
}
// Batched Notif bal for a WHOLE day in 2 queries (vs notifBalFor's 2 queries PER interval) — for the hot /api/predict_sign loop.
function notifBalMapFor(date) {
  const byIsp = {};
  try { for (const r of _nbStmt2.all(date)) (byIsp[r.isp] || (byIsp[r.isp] = {}))[r.series] = r.value; } catch { return new Map(); }
  const com = {}; try { for (const r of _nbPi2.all(date)) com[r.isp] = r.commercial; } catch { /* ignore */ } // last row per isp (asc) = latest commercial
  const out = new Map();
  for (const isp of Object.keys(byIsp)) {
    const s = byIsp[isp]; const P = s.damas_notif_prod, C = s.damas_notif_cons; if (P == null || C == null) continue;
    let net = com[isp];
    if (net == null) { let e = 0, i = 0, any = false; for (const b of ['HU', 'BG', 'RS', 'UA', 'MD']) { const ev = s['sched_RO_' + b], iv = s['sched_' + b + '_RO']; if (ev != null) { e += ev; any = true; } if (iv != null) { i += iv; any = true; } } if (!any) continue; net = e - i; }
    out.set(+isp, P - C - net);
  }
  return out;
}
const _nbStmt2 = db.prepare("SELECT isp, series, value FROM series WHERE date_ro=? AND series IN ('damas_notif_prod','damas_notif_cons','sched_RO_HU','sched_RO_BG','sched_RO_RS','sched_RO_UA','sched_RO_MD','sched_HU_RO','sched_BG_RO','sched_RS_RO','sched_UA_RO','sched_MD_RO')");
const _nbPi2 = db.prepare('SELECT isp, commercial FROM xb_pi_snap WHERE date_ro=? AND commercial IS NOT NULL ORDER BY isp, pulled_at');
// LOCK the forecast at gate-close: the CURRENT TRADEABLE interval (the gate row = start ≥ current-ISP-start + 75min)
// stays LIVE; once the gate advances past it (it becomes ISP+4, untradeable) its prediction freezes + is RECORDED
// (append-only, lock-once) so it shows vs the realized outcome + can be scored. The gate row is NEVER locked.
try { db.exec('CREATE TABLE IF NOT EXISTS sign_lock(date_ro TEXT, isp INTEGER, p REAL, sign TEXT, conf INTEGER, locked_at TEXT, PRIMARY KEY(date_ro,isp))'); } catch (e) { console.error('sign_lock table:', e.message); }
// PANIC / big-PI-move log: flag + RECORD upcoming tradeable intervals being repositioned hard, so we can finally
// VALIDATE the desk's "a big PI trade flips the state" intuition (so far unconfirmed: big moves mostly CONFIRM the
// state; flips n≈13, PI pointed the right way only ~38%). Observational only — no P adjustment until the log earns it.
const PANIC_MW = 200, PANIC_WIN_MIN = 60; // a "panic" = |net commercial repositioning in the last PANIC_WIN_MIN min| ≥ PANIC_MW (≈p90 of recent-60min bursts) — a SUDDEN block, not slow multi-hour drift
try { db.exec('CREATE TABLE IF NOT EXISTS panic_log(date_ro TEXT, isp INTEGER, first_at TEXT, pi_move REAL, pi_abs REAL, persist REAL, base_p REAL, pi_dir TEXT, persist_dir TEXT, opposes INTEGER, realized_dir TEXT, scored_at TEXT, PRIMARY KEY(date_ro,isp))'); } catch (e) { console.error('panic_log table:', e.message); }
function lockDueForecasts() {
  const model = getSignModel(); if (!model) return;
  const nowMs = Date.now(); const ni = roDateIsp(new Date());
  const curTs = dayTimestamps(ni.date).find((t) => t.isp === ni.isp); if (!curTs) return;
  const gateMs = new Date(curTs.ts).getTime() + 75 * signModel.MIN; // first TRADEABLE delivery start (= current-ISP start + 75min), matches the trade-gate
  const reg = liveRegime(nowMs - signModel.PUB_LAG * signModel.MIN); if (!reg) return; const persist = reg.persist;
  const has = db.prepare('SELECT 1 FROM sign_lock WHERE date_ro=? AND isp=?');
  const ins = db.prepare('INSERT OR IGNORE INTO sign_lock(date_ro,isp,p,sign,conf,locked_at) VALUES (?,?,?,?,?,?)');
  const piStmt = db.prepare('SELECT commercial FROM xb_pi_snap WHERE date_ro=? AND isp=? ORDER BY pulled_at');
  for (const { isp, ts } of dayTimestamps(ni.date)) {
    if (isp < signModel.WIN_FROM || isp > signModel.WIN_TO) continue;
    const Tms = new Date(ts).getTime();
    if (Tms >= gateMs || Tms < gateMs - 15 * signModel.MIN) continue; // lock ONLY the interval that JUST became untradeable (old gate row → ISP+4): gate−15min ≤ start < gate. The gate row (≥ gate) stays live.
    if (has.get(ni.date, isp)) continue;                 // lock once
    let pi_move = 0; try { const fr = piStmt.all(ni.date, isp); if (fr.length >= 2) pi_move = fr[fr.length - 1].commercial - fr[0].commercial; } catch { /* ignore */ }
    const lead = (Tms - nowMs) / signModel.MIN;
    const p = signModel.prob(model, persist, pi_move, reg.fracsurp, reg.netting, notifBalFor(ni.date, isp), isp, lead);
    ins.run(ni.date, isp, +p.toFixed(4), p >= 0.5 ? 'S' : 'D', Math.round(Math.max(p, 1 - p) * 100), new Date().toISOString());
  }
}
// net commercial repositioning on an interval within the last PANIC_WIN_MIN minutes (the "panic burst") — frames asc by pulled_at
function recentMove(frames, nowMs) { if (frames.length < 2) return 0; const last = frames[frames.length - 1].c; let ref = frames[0].c; for (const f of frames) { if (f.p <= nowMs - PANIC_WIN_MIN * 60000) ref = f.c; else break; } return last - ref; }
// Scan upcoming TRADEABLE intervals for a big RECENT PI burst; record the PEAK burst per interval (lock the realized
// outcome later in scorePanics). pi_dir = S if the burst is net export (export→surplus-leaning) else D; opposes = pi_dir
// disagrees with the persistence sign (the flip SETUP). Runs server-side so it logs whether or not a page is open.
function detectPanics() {
  const model = getSignModel(); if (!model) return;
  const nowMs = Date.now(); const ni = roDateIsp(new Date());
  const curTs = dayTimestamps(ni.date).find((t) => t.isp === ni.isp); if (!curTs) return;
  const gateMs = new Date(curTs.ts).getTime() + 75 * signModel.MIN;
  const reg = liveRegime(nowMs - signModel.PUB_LAG * signModel.MIN); if (!reg) return;
  const persistDir = reg.persist > 0 ? 'S' : 'D';
  const piStmt = db.prepare('SELECT pulled_at, commercial FROM xb_pi_snap WHERE date_ro=? AND isp=? ORDER BY pulled_at');
  const sel = db.prepare('SELECT pi_abs FROM panic_log WHERE date_ro=? AND isp=?');
  const ins = db.prepare('INSERT OR IGNORE INTO panic_log(date_ro,isp,first_at,pi_move,pi_abs,persist,base_p,pi_dir,persist_dir,opposes) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const upd = db.prepare('UPDATE panic_log SET pi_move=?,pi_abs=?,base_p=?,pi_dir=?,opposes=? WHERE date_ro=? AND isp=? AND realized_dir IS NULL');
  for (const { isp, ts } of dayTimestamps(ni.date)) {
    if (isp < signModel.WIN_FROM || isp > signModel.WIN_TO) continue;
    const Tms = new Date(ts).getTime(); if (Tms < gateMs) continue; // tradeable only
    let frames = []; try { frames = piStmt.all(ni.date, isp).map((f) => ({ p: Date.parse(f.pulled_at), c: f.commercial })); } catch { /* ignore */ }
    if (frames.length < 2) continue;
    const burst = recentMove(frames, nowMs); const pa = Math.abs(burst); if (pa < PANIC_MW) continue;
    const pi_move = frames[frames.length - 1].c - frames[0].c; // cumulative repositioning — feeds the model prob
    const lead = (Tms - nowMs) / signModel.MIN;
    const p = signModel.prob(model, reg.persist, pi_move, reg.fracsurp, reg.netting, notifBalFor(ni.date, isp), isp, lead);
    const piDir = burst > 0 ? 'S' : 'D'; const opposes = piDir !== persistDir ? 1 : 0;
    const ex = sel.get(ni.date, isp);
    if (!ex) ins.run(ni.date, isp, new Date().toISOString(), burst, pa, reg.persist, +p.toFixed(4), piDir, persistDir, opposes);
    else if (pa > ex.pi_abs) upd.run(burst, pa, +p.toFixed(4), piDir, opposes, ni.date, isp); // keep the PEAK burst
  }
}
// Lock the realized surplus/deficit outcome onto logged panic events once the interval settles → builds the scored
// dataset to test whether big PI moves predict flips (vs persistence) or merely confirm the state.
function scorePanics() {
  const rows = db.prepare('SELECT date_ro, isp FROM panic_log WHERE realized_dir IS NULL').all(); if (!rows.length) return;
  const set = db.prepare('UPDATE panic_log SET realized_dir=?, scored_at=? WHERE date_ro=? AND isp=?');
  for (const r of rows) {
    const t = dayTimestamps(r.date_ro).find((x) => x.isp === r.isp); if (!t) continue;
    const Tms = new Date(t.ts).getTime();
    const v = db.prepare("SELECT value FROM series WHERE series='damas_est_sys_imbalance' AND value IS NOT NULL AND ts_utc>=? AND ts_utc<? LIMIT 1").get(new Date(Tms).toISOString(), new Date(Tms + 60000).toISOString());
    if (v) set.run(v.value > 0 ? 'S' : 'D', new Date().toISOString(), r.date_ro, r.isp);
  }
}
setInterval(() => { try { lockDueForecasts(); detectPanics(); scorePanics(); } catch (e) { console.error('sign loop:', e.message); } }, 60000);
try { lockDueForecasts(); detectPanics(); scorePanics(); } catch (e) { /* ignore at startup */ }
// index for per-hour weather lookups (weather PK starts with `point`, so ts_utc filters were full scans ~230ms)
try { db.exec('CREATE INDEX IF NOT EXISTS ix_weather_ts ON weather(ts_utc)'); } catch (e) { /* table may not exist yet */ }
let senFilterCache = { at: 0, data: null };
async function liveSenFilter(maxAge = 10000) {
  if (senFilterCache.data && Date.now() - senFilterCache.at < maxAge) return senFilterCache.data;
  if (filterBrk.down()) return senFilterCache.data; // breaker open → last-good, don't hit the dead host
  const d = await senFilter.fetchSenFilter().catch(() => null);
  if (d) { filterBrk.markUp(); senFilterCache = { at: Date.now(), data: d }; try { senFilter.record(db, d, roDateIsp); } catch (e) { console.error('sen_live record:', e.message); } return d; }
  filterBrk.markDown();
  return senFilterCache.data;
}

// interval time-weighted average net export — delegates to the CANONICAL impl in sen_filter.js (single source
// of truth; the same function persists per-interval averages to sen_interval). Returns { avg: realxb-avg, n }.
function intervalTWA(date, isp) {
  const r = senFilter.intervalAvg(db, date, isp);
  return r ? { avg: r.avgRealxb, n: r.n } : { avg: null, n: 0 };
}

// Validated real-value nowcast model (tool/realmodel.json, fit by train_real.js). Optional — page
// degrades gracefully (no predictions) if absent.
const REALMODEL = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'realmodel.json'), 'utf8')); } catch { return null; } })();

// Validated PZU day-ahead price-curve model (tool/pzumodel.json, fit by train_pzu.js). Used for the
// revised /pzu page: forecast the price curve (for ranking + battery dispatch), NOT to tilt on imbalance
// (proven a coin-flip / net drag at D-1). See memory: pzu-bidding.
const PZUMODEL = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'pzumodel.json'), 'utf8')); } catch { return null; } })();

// Forecast the PZU price curve (RON/MWh) for `date` from day-ahead-known DB features + battery dispatch
// hint (charge cheapest quartile of the day, discharge most expensive). Returns {price:Map, battery:Map, bucketSpread}.
function pzuForecast(date) {
  const out = { price: new Map(), battery: new Map(), bucketSpread: PZUMODEL ? PZUMODEL.bucketSpread : null };
  if (!PZUMODEL) return out;
  const cfg = loadConfig(); const eurRon = cfg.eur_ron || PZUMODEL.eur_ron;
  const da = new Map(db.prepare("SELECT date_ro,isp,value FROM series WHERE series='da_price' AND date_ro>=? AND date_ro<=?")
    .all(addDays(date, -7), date).map((r) => [r.date_ro + '|' + r.isp, r.value]));
  const ser = (s) => new Map(db.prepare('SELECT isp,value FROM series WHERE series=? AND date_ro=?').all(s, date).map((r) => [r.isp, r.value]));
  const solF = ser('ws_fc_da_solar'), winF = ser('ws_fc_da_wind_onshore'), loadF = ser('load_fc_da');
  const { coef, mu, sd } = PZUMODEL; const K = coef.length;
  const dow = new Date(date + 'T12:00:00Z').getUTCDay(); const ma = 2 * Math.PI * (+date.slice(5, 7)) / 12;
  const vals = [];
  for (let isp = 1; isp <= 96; isp++) {
    const a = 2 * Math.PI * isp / 96;
    const lf = loadF.get(isp), sf = solF.get(isp), wf = winF.get(isp);
    const netload = (lf != null && sf != null && wf != null) ? lf - sf - wf : null;
    const lag24 = da.get(addDays(date, -1) + '|' + isp), lag168 = da.get(addDays(date, -7) + '|' + isp);
    let s = 0, n = 0; for (let j = 1; j <= 7; j++) { const v = da.get(addDays(date, -j) + '|' + isp); if (v != null) { s += v; n++; } }
    const avg7 = n ? s / n : null;
    const x = [1, Math.sin(a), Math.cos(a), Math.sin(2 * a), Math.cos(2 * a), (dow === 0 || dow === 6) ? 1 : 0,
      Math.sin(ma), Math.cos(ma), netload, lf ?? null, sf ?? null, wf ?? null, lag24 ?? null, lag168 ?? null, avg7];
    if (x[12] == null && x[13] == null && x[14] == null) continue; // no price history at all → can't forecast
    let z = 0; for (let j = 0; j < K; j++) { const xv = j === 0 ? 1 : (Number.isFinite(x[j]) ? (x[j] - mu[j]) / sd[j] : 0); z += coef[j] * xv; }
    const ron = z * eurRon; out.price.set(isp, ron); vals.push(ron);
  }
  if (vals.length >= 8) {
    const sorted = [...vals].sort((a, b) => a - b); const q = (p) => sorted[Math.floor(p * (sorted.length - 1))];
    const lo = q(0.25), hi = q(0.75);
    for (const [isp, v] of out.price) out.battery.set(isp, v <= lo ? 'charge' : v >= hi ? 'discharge' : null);
  }
  return out;
}

// Hourly deviation curve of SEN real prod vs notif prod — near-deterministic shape (midday −700 MW solar
// over-scheduling, evening/night +200..450; real>notif on ~100% of days in those hours). Used as a SECOND,
// information-diverse route for the forward Real-prod forecast: notif + curve[hour] + today's running anomaly.
// Blending it 50/50 with the schedule-consistent route cut MAE 143→114 MW at the 75-min lead (LODO-validated
// 2026-07-03, tool/_prod_curve_fc.js; error corr between routes only 0.32). Curve cached 10 min.
// v2 (2026-07-03, tool/_prod_fc_lab.js): SOLAR-AWARE curve — the deviation deepens ~beta≈−0.30 MW per MW of
// solar forecast above the hourly norm (consistent with real solar ≈ 0.70×forecast), and the anomaly uses our
// own ~1-min-fresh sen_live (no publication lag). LODO-validated: 113.7 → 105.7 MW MAE @75min.
const isWeDay = (d) => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w === 0 || w === 6; };
// hour('YYYY-MM-DDTHH') → forecast temperature (RO ensemble mean), for the curve models' AC-load term
let _wxTCache = { at: 0, m: new Map() };
function wxTempMap() {
  if (Date.now() - _wxTCache.at < 600000) return _wxTCache.m;
  const m = new Map();
  try { for (const r of db.prepare("SELECT ts_utc, value FROM weather_hourly WHERE var='temperature_2m'").all()) m.set(r.ts_utc.slice(0, 13), r.value); } catch { /* weather_hourly may be empty */ }
  _wxTCache = { at: Date.now(), m };
  return m;
}
// Build a day-type-aware curve model from {isp, dev, we, sol} rows: pooled hourly means, plus weekday/weekend
// EFFECTIVE curves (day-type cell used when it has ≥8 obs, else pooled fallback — sharpens as weekends accumulate).
// Motivated by the CONS curve check (2026-07-02): the weekend midday valley is ~2.4× the weekday one (−736 vs −302 @11h).
function buildCurveModel(rows) {
  const H = (isp) => Math.floor((((isp - 1) * 15 - 60 + 1440) % 1440) / 60);
  const acc = Array.from({ length: 24 }, () => ({ s: 0, n: 0, sol: 0, nsol: 0, sWd: 0, nWd: 0, sWe: 0, nWe: 0, tp: 0, ntp: 0 }));
  for (const r of rows) { const a = acc[H(r.isp)]; a.s += r.dev; a.n++; if (r.sol != null) { a.sol += r.sol; a.nsol++; } if (r.temp != null) { a.tp += r.temp; a.ntp++; } if (r.we) { a.sWe += r.dev; a.nWe++; } else { a.sWd += r.dev; a.nWd++; } }
  const c = new Array(24).fill(null), sm = new Array(24).fill(null), cWd = new Array(24).fill(null), cWe = new Array(24).fill(null), tm = new Array(24).fill(null);
  let ok = 0;
  for (let h = 0; h < 24; h++) {
    const a = acc[h]; if (a.n < 5) continue;
    c[h] = a.s / a.n; ok++;
    if (a.nsol >= 5) sm[h] = a.sol / a.nsol;
    if (a.ntp >= 5) tm[h] = a.tp / a.ntp;
    cWd[h] = a.nWd >= 8 ? a.sWd / a.nWd : c[h];
    cWe[h] = a.nWe >= 8 ? a.sWe / a.nWe : c[h];
  }
  if (ok < 20) return null;
  let sxy = 0, sxx = 0;
  for (const r of rows) { const h = H(r.isp); if (c[h] == null || sm[h] == null || r.sol == null) continue; const x = r.sol - sm[h], y = r.dev - c[h]; sxy += x * y; sxx += x * x; }
  const beta = sxx > 0 ? sxy / sxx : 0;
  // temperature beta on the residual AFTER the solar term (sequential — sunny↔hot are collinear; targets AC load,
  // cons anomaly ↔ temp anomaly r=0.19/+18 MW·°C measured 2026-07-03, tool/_wx_anom.js)
  let txy = 0, txx = 0;
  for (const r of rows) { const h = H(r.isp); if (c[h] == null || tm[h] == null || r.temp == null) continue; const y = r.dev - c[h] - (r.sol != null && sm[h] != null ? beta * (r.sol - sm[h]) : 0); const x = r.temp - tm[h]; txy += x * y; txx += x * x; }
  return { cWd, cWe, sm, beta, tm, betaT: txx > 0 ? txy / txx : 0 };
}
let _pdcCache = { at: 0, model: null };
function prodCurveModel() {
  if (Date.now() - _pdcCache.at < 600000) return _pdcCache.model;
  let model = null;
  try {
    const rows = db.prepare(`SELECT sl.date_ro d, sl.isp, sl.p, se.value nv, se.ts_utc ts, sf.value sol
      FROM (SELECT date_ro, isp, AVG(prod) p FROM sen_live WHERE prod IS NOT NULL GROUP BY date_ro, isp HAVING COUNT(*)>=3) sl
      JOIN series se ON se.series='damas_notif_prod' AND se.date_ro=sl.date_ro AND se.isp=sl.isp
      LEFT JOIN series sf ON sf.series='ws_fc_da_solar' AND sf.date_ro=sl.date_ro AND sf.isp=sl.isp`).all();
    const T = wxTempMap();
    model = buildCurveModel(rows.map((r) => ({ isp: r.isp, dev: r.p - r.nv, we: isWeDay(r.d), sol: r.sol, temp: T.get(r.ts.slice(0, 13)) ?? null })));
  } catch { /* sen_live may be empty */ }
  _pdcCache = { at: Date.now(), model };
  return model;
}
// expected deviation for an interval = curve interpolated at ISP resolution + beta·(solarFc − hourly-mean solarFc).
// INTERPOLATED between hour midpoints (cyclic) — the raw hourly curve stepped (e.g. +139 MW exactly at 13:00),
// which produced implausible jumps the trader's eye rightly rejected (2026-07-03); interpolation spreads the
// narrowing smoothly across the hour (LODO MAE 105.4 vs 105.8 stepped).
const _pdInterp = (arr, isp) => {
  const mins = (((isp - 1) * 15 - 60) + 1440) % 1440;
  let hf = mins / 60 - 0.5; if (hf < 0) hf += 24;
  const h0 = Math.floor(hf) % 24, h1 = (h0 + 1) % 24, w = hf - Math.floor(hf);
  if (arr[h0] == null || arr[h1] == null) return arr[Math.floor(mins / 60)];
  return arr[h0] * (1 - w) + arr[h1] * w;
};
const pdExpect = (m, isp, sol, we, temp) => { const c = _pdInterp(we ? m.cWe : m.cWd, isp); if (c == null) return null; const sm = _pdInterp(m.sm, isp); const tm = _pdInterp(m.tm, isp); return c + (sol != null && sm != null ? m.beta * (sol - sm) : 0) + (temp != null && tm != null ? m.betaT * (temp - tm) : 0); };
// today's running anomaly vs the (solar-aware) expected deviation, over the last 4 settled intervals (~1-min fresh).
// Returns { gap, slope, center }: gap = mean anomaly; slope = its OLS trend per 15-min step; center = mean history
// time in 15-min steps. On RAMP days a flat gap trails reality by ~7 intervals (2026-07-02: locks ran +250..300 low
// while real−notif climbed +350 in 2h — user caught it); a DAMPED trend extrapolation (λ=0.25, clamped ±300) fixes
// exactly that failure: LODO 108.3→106.7 overall, 123.9→119.6 on ramp intervals (tool/_prod_fc_lab2.js).
const PD_TREND_LAMBDA = 0.25, PD_TREND_CLAMP = 300, PD_STEP = 15 * 60000;
const PD_TREND_HMAX = 8;   // trend extrapolation horizon cap (~2h): validated at the 75-min lead; beyond it the
                           // midday slope leaked into EVENING rows (−285 MW at 20:45, user-caught 2026-07-02)
const XB_PHYS = 2900;      // physical cross-border capacity clip (virtual-MWh rule: schedule reaches ±5260 vs
                           // physical ±2950 — clip estimate INPUTS so virtual imports don't drag the prod/XB fcst)
function prodAnomGap(m) {
  try {
    const ni = roDateIsp(new Date());
    const rows = db.prepare(`SELECT sl.date_ro d, sl.isp, sl.p, se.value v, se.ts_utc ts, sf.value sol
      FROM (SELECT date_ro, isp, AVG(prod) p, COUNT(*) c FROM sen_live WHERE prod IS NOT NULL GROUP BY date_ro, isp HAVING c>=3) sl
      JOIN series se ON se.series='damas_notif_prod' AND se.date_ro=sl.date_ro AND se.isp=sl.isp
      LEFT JOIN series sf ON sf.series='ws_fc_da_solar' AND sf.date_ro=sl.date_ro AND sf.isp=sl.isp
      WHERE sl.date_ro<? OR (sl.date_ro=? AND sl.isp<?)
      ORDER BY sl.date_ro DESC, sl.isp DESC LIMIT 4`).all(ni.date, ni.date, ni.isp);
    if (rows.length < 4) return null;
    const T = wxTempMap();
    const pts = [];
    for (const r of rows) { const e = pdExpect(m, r.isp, r.sol, isWeDay(r.d), T.get(r.ts.slice(0, 13)) ?? null); if (e == null) return null; pts.push({ x: Date.parse(r.ts) / PD_STEP, v: r.p - r.v - e }); }
    const gap = pts.reduce((s, p) => s + p.v, 0) / pts.length;
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    let sxy = 0, sxx = 0; for (const p of pts) { sxy += (p.x - cx) * (p.v - gap); sxx += (p.x - cx) ** 2; }
    return { gap, slope: sxx > 0 ? sxy / sxx : 0, center: cx };
  } catch { return null; }
}
// gap projected to a target interval start (epoch ms): damped trend extrapolation, horizon-capped + clamped
const pdGapAt = (g, tsMs) => g.gap + Math.max(-PD_TREND_CLAMP, Math.min(PD_TREND_CLAMP, g.slope * Math.min(tsMs / PD_STEP - g.center, PD_TREND_HMAX) * PD_TREND_LAMBDA));
// CONSUMPTION, same user-spec architecture (2026-07-02): fixed Notif cons + hourly deviation curve (solar-aware —
// distributed PV depresses metered consumption) + intraday correction from REALISED consumption only.
// Cost vs the cons_fc anchor: ~equal @15min (96 vs 95), −8..−18 MW @45-75min (tool/_prod_fc_lab3.js) — accepted for symmetry.
let _cdcCache = { at: 0, model: null };
function consCurveModel() {
  if (Date.now() - _cdcCache.at < 600000) return _cdcCache.model;
  let model = null;
  try {
    const rows = db.prepare(`SELECT sl.date_ro d, sl.isp, sl.c cn, se.value nv, se.ts_utc ts, sf.value sol
      FROM (SELECT date_ro, isp, AVG(cons) c FROM sen_live WHERE cons IS NOT NULL GROUP BY date_ro, isp HAVING COUNT(*)>=3) sl
      JOIN series se ON se.series='damas_notif_cons' AND se.date_ro=sl.date_ro AND se.isp=sl.isp
      LEFT JOIN series sf ON sf.series='ws_fc_da_solar' AND sf.date_ro=sl.date_ro AND sf.isp=sl.isp`).all();
    const T = wxTempMap();
    model = buildCurveModel(rows.map((r) => ({ isp: r.isp, dev: r.cn - r.nv, we: isWeDay(r.d), sol: r.sol, temp: T.get(r.ts.slice(0, 13)) ?? null })));
  } catch { /* sen_live may be empty */ }
  _cdcCache = { at: Date.now(), model };
  return model;
}
function consAnomGap(m) {
  try {
    const ni = roDateIsp(new Date());
    const rows = db.prepare(`SELECT sl.date_ro d, sl.isp, sl.c cn, se.value v, se.ts_utc ts, sf.value sol
      FROM (SELECT date_ro, isp, AVG(cons) c, COUNT(*) n FROM sen_live WHERE cons IS NOT NULL GROUP BY date_ro, isp HAVING n>=3) sl
      JOIN series se ON se.series='damas_notif_cons' AND se.date_ro=sl.date_ro AND se.isp=sl.isp
      LEFT JOIN series sf ON sf.series='ws_fc_da_solar' AND sf.date_ro=sl.date_ro AND sf.isp=sl.isp
      WHERE sl.date_ro<? OR (sl.date_ro=? AND sl.isp<?)
      ORDER BY sl.date_ro DESC, sl.isp DESC LIMIT 4`).all(ni.date, ni.date, ni.isp);
    if (rows.length < 4) return null;
    const T = wxTempMap();
    const pts = [];
    for (const r of rows) { const e = pdExpect(m, r.isp, r.sol, isWeDay(r.d), T.get(r.ts.slice(0, 13)) ?? null); if (e == null) return null; pts.push({ x: Date.parse(r.ts) / PD_STEP, v: r.cn - r.v - e }); }
    const gap = pts.reduce((s, p) => s + p.v, 0) / pts.length;
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    let sxy = 0, sxx = 0; for (const p of pts) { sxy += (p.x - cx) * (p.v - gap); sxx += (p.x - cx) ** 2; }
    return { gap, slope: sxx > 0 ? sxy / sxx : 0, center: cx };
  } catch { return null; }
}

// ---- LOCK the production forecast at the trade gate (mirrors the sign predictor's lock discipline) ----
// The forward Real-prod forecast stays LIVE (baseline, refreshed every 15s) while an interval is still tradeable
// (start ≥ current-ISP-start + 75min). When the gate advances past it, the CURRENT blend freezes into prod_lock
// (lock-once, append-only) so settled rows show forecast-vs-actual on record and the accuracy is scoreable.
try { db.exec('CREATE TABLE IF NOT EXISTS prod_lock(date_ro TEXT, isp INTEGER, fcst REAL, sched REAL, curver REAL, locked_at TEXT, PRIMARY KEY(date_ro,isp))'); } catch (e) { console.error('prod_lock table:', e.message); }
try { db.exec('ALTER TABLE prod_lock ADD COLUMN xb REAL'); } catch { /* exists */ } // the Real X-B estimate (fcst − fcstCons) recorded at the same gate
try { db.exec('ALTER TABLE prod_lock ADD COLUMN cons REAL'); } catch { /* exists */ } // the Fcst cons recorded at the same gate
try { db.exec('ALTER TABLE prod_lock ADD COLUMN lean REAL'); } catch { /* exists */ } // the imbalance lean (xb − notifXB@lock)/4 [MWh] recorded at the same gate
// DB-only blend (same formulas the page renders; validated ~106 MW MAE @75min — see prodCurveModel)
function prodBlendAt(date, isp) {
  const m = prodCurveModel(); if (!m) return null;
  const one = (s) => { try { const r = db.prepare('SELECT value v FROM series WHERE series=? AND date_ro=? AND isp=?').get(s, date, isp); return r ? r.v : null; } catch { return null; } };
  let tsMs = null; try { const r = db.prepare("SELECT ts_utc FROM series WHERE series='damas_notif_prod' AND date_ro=? AND isp=?").get(date, isp); if (r) tsMs = Date.parse(r.ts_utc); } catch { /* ignore */ }
  const sol = one('ws_fc_da_solar');
  // CONS, user-spec architecture: fixed Notif cons + curve + realised-cons correction (fallback: DAMAS fc + gap)
  let fcstCons = null;
  const cm2 = consCurveModel();
  const tempT = tsMs !== null ? (wxTempMap().get(new Date(tsMs).toISOString().slice(0, 13)) ?? null) : null;
  if (cm2 && tsMs !== null) { const ncT = one('damas_notif_cons'); const g2 = consAnomGap(cm2); const e2 = ncT != null ? pdExpect(cm2, isp, sol, isWeDay(date), tempT) : null; if (ncT != null && g2 !== null && e2 !== null) fcstCons = ncT + e2 + pdGapAt(g2, tsMs); }
  if (fcstCons === null) {
    const cfT = one('damas_cons_fc');
    if (cfT != null) {
      try {
        const g = db.prepare(`SELECT AVG(rc.value*4 - cf.value) g, COUNT(*) n
          FROM (SELECT date_ro, isp, value FROM series WHERE series='damas_consumption' AND value IS NOT NULL ORDER BY date_ro DESC, isp DESC LIMIT 4) rc
          JOIN series cf ON cf.series='damas_cons_fc' AND cf.date_ro=rc.date_ro AND cf.isp=rc.isp`).get();
        if (g && g.n === 4) fcstCons = cfT + g.g;
      } catch { /* ignore */ }
    }
  }
  // sched leg (recorded for live comparison only — not the forecast)
  let rawNxb = null; try { const r = db.prepare('SELECT commercial FROM xb_pi_snap WHERE date_ro=? AND isp=? AND commercial IS NOT NULL ORDER BY pulled_at DESC LIMIT 1').get(date, isp); if (r) rawNxb = r.commercial; } catch { /* ignore */ }
  const nxb = rawNxb != null ? Math.max(-XB_PHYS, Math.min(XB_PHYS, rawNxb)) : null; // physical-capacity clip (same as the page)
  const sched = fcstCons != null && nxb != null ? fcstCons + nxb : null;
  // PROD, user-spec architecture: fixed Notif prod + curve + realised-prod correction
  let curver = null;
  const npT = one('damas_notif_prod');
  if (npT != null && tsMs !== null) {
    const gap = prodAnomGap(m); const e = pdExpect(m, isp, sol, isWeDay(date), tempT);
    if (gap !== null && e !== null) curver = npT + e + pdGapAt(gap, tsMs);
  }
  const fcst = curver ?? sched; // user-spec: curve route IS the forecast (sched = fallback only); both legs still recorded
  const xb = fcst !== null && fcstCons !== null ? fcst - fcstCons : null; // pure-physical Real X-B estimate (matches the page)
  const lean = xb !== null && rawNxb != null ? (xb - rawNxb) / 4 : null;  // imbalance lean [MWh] vs the notified paper at lock time
  return fcst === null ? null : { fcst, sched, curver, xb, cons: fcstCons, lean };
}
function lockDueProd() {
  const ni = roDateIsp(new Date());
  const curTs = dayTimestamps(ni.date).find((t) => t.isp === ni.isp); if (!curTs) return;
  const gateMs = new Date(curTs.ts).getTime() + 75 * signModel.MIN; // same gate as the sign lock
  const has = db.prepare('SELECT 1 FROM prod_lock WHERE date_ro=? AND isp=?');
  const ins = db.prepare('INSERT OR IGNORE INTO prod_lock(date_ro,isp,fcst,sched,curver,xb,cons,lean,locked_at) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const { isp, ts } of dayTimestamps(ni.date)) {
    const Tms = new Date(ts).getTime();
    if (Tms >= gateMs || Tms < gateMs - 15 * signModel.MIN) continue; // lock ONLY the interval that JUST crossed the gate
    if (has.get(ni.date, isp)) continue;                              // lock once
    const b = prodBlendAt(ni.date, isp); if (!b) continue;
    ins.run(ni.date, isp, +b.fcst.toFixed(1), b.sched === null ? null : +b.sched.toFixed(1), b.curver === null ? null : +b.curver.toFixed(1), b.xb === null ? null : +b.xb.toFixed(1), b.cons == null ? null : +b.cons.toFixed(1), b.lean == null ? null : +b.lean.toFixed(1), new Date().toISOString());
  }
}
setInterval(() => { try { lockDueProd(); } catch (e) { console.error('prod lock:', e.message); } }, 60000);
try { lockDueProd(); } catch { /* startup */ }

// HU-border empirical capacity envelope: rolling 60-day p99.5 of the total commercial exchange per direction.
// (The HU border is Core FLOW-BASED — no official per-border NTC exists; A61 is empty there by design. BG has
// official daily NTC via ntc_BG_RO/ntc_RO_BG.) Cached 10 min.
let _huEnvCache = { at: 0, env: null };
function huEnv() {
  if (Date.now() - _huEnvCache.at < 600000) return _huEnvCache.env;
  const q = (s) => { try { const v = db.prepare("SELECT value FROM series WHERE series=? AND date_ro>=date('now','-60 day') AND value IS NOT NULL ORDER BY value").all(s).map((r) => r.value); return v.length ? v[Math.floor(v.length * 0.995)] : null; } catch { return null; } };
  _huEnvCache = { at: Date.now(), env: { imp: q('sched_HU_RO'), exp: q('sched_RO_HU') } };
  return _huEnvCache.env;
}

// ---- Predict page: trader-facing real-vs-notified view (imbalance, prod, cons, cross-border) ----
async function predictPage(date) {
  const SEN = await liveSEN(date).catch(() => new Map());
  // per-interval SCADA generation mix (avg over the interval's sen_live readings) → the prod split on SETTLED rows
  const senMix = new Map();
  try { for (const r of db.prepare("SELECT isp, AVG(solar) so, AVG(wind) wi, AVG(hydro) hy, AVG(nuclear) nu FROM sen_live WHERE date_ro=? AND solar IS NOT NULL GROUP BY isp").all(date)) senMix.set(r.isp, { solar: r.so, wind: r.wi, hydro: r.hy, nuclear: r.nu }); } catch { /* sen_live may be absent */ }
  // FALLBACK for the realized "Real prod/cons/X-B" values. Those read the SEN-GRAFIC scrape (liveSEN), but that
  // endpoint goes dark for hours at a time (server-to-server black-hole) — and when it does, every Real cell fell
  // back to the italic forecast and the per-source split (which needs a realized prod) vanished entirely. We already
  // record the SAME telemetry 24/7 from the sen-filter feed into sen_live, so use its per-interval average for any
  // interval the scrape didn't return. Kept as a separate map so the liveSEN cache is never polluted.
  const senFb = new Map();
  try { for (const r of db.prepare("SELECT isp, AVG(prod) p, AVG(cons) c, AVG(sold) s FROM sen_live WHERE date_ro=? AND prod IS NOT NULL GROUP BY isp").all(date)) senFb.set(r.isp, { prod: r.p, cons: r.c, sold: r.s }); } catch { /* sen_live may be absent */ }
  const [P, E, G, C, X] = await Promise.all(
    ['estimatedImbalancePrices', 'estimatedPowerSystemImbalance', 'generationSchedules', 'dailyConsumptionOverview', 'scheduledExchanges']
      .map((c) => liveReport(c, date).catch(() => new Map())),
  );
  const cfg = loadConfig(); const [wh0, wh1] = cfg.trade_window_cet || [7, 22];
  const winFrom = (wh0 + 1) * 4 + 1, winTo = (wh1 + 1) * 4 + 1; // +1 → include the wh1:00-starting row (e.g. 22:00)
  const nowInfo = roDateIsp(new Date()); const nowMs = Date.now();
  // INTRADAY TRADE GATE (75-min lead, snapped to the current ISP boundary): an interval is tradeable only once its
  // delivery start is ≥75 min away. At 11:15 → open from 12:30; once 11:15 closes (11:30) → open from 12:45 (advances
  // each ISP). Per-row state by absolute time so it's date-general: past (before the current ISP) / locked (current ISP
  // through the gate) / open (≥ gate). gate = (start of current ISP) + 75 min = first tradeable delivery start.
  const LOCK_LEAD_MIN = 75;
  const curIspTs = dayTimestamps(nowInfo.date).find((t) => t.isp === nowInfo.isp);
  const curIspStartMs = curIspTs ? new Date(curIspTs.ts).getTime() : nowMs;
  const gateMs = curIspStartMs + LOCK_LEAD_MIN * 60000;
  const firstOpenIsp = nowInfo.isp + LOCK_LEAD_MIN / 15; // current ISP + 5
  const gateCet = firstOpenIsp <= 96 ? cetLabel(firstOpenIsp) : '00:00<small>+1d</small>';
  const gateCaption = nowInfo.date === date
    ? `<b>Trade gate</b> · ${LOCK_LEAD_MIN}-min lead — <span class="op">▶ trade window opens at ${gateCet}</span>, locks in <span class="ivtimer" data-end="${curIspStartMs + 900000}">–:––</span> · <span class="lk">🔒 nearer intervals locked</span> · <span style="opacity:.6">grey = delivered</span>`
    : (date < nowInfo.date ? '<b>Past day</b> — all intervals delivered' : '<b>Future day</b> — all intervals open to trade');
  const schedVal = (o) => { if (!o || typeof o !== 'object') return null; let v = rnum(o.commercial); if (v === null) { const da = rnum(o.dayAhead), id = rnum(o.intraday); if (da !== null || id !== null) v = (da ?? 0) + (id ?? 0); } return v; };
  const notifXB = (x) => { if (!x) return null; let net = 0, any = false; for (const p of ['hu', 'bg', 'rs', 'ua', 'md']) { const e = schedVal(x['ro' + p]), i = schedVal(x[p + 'ro']); if (e !== null) { net += e; any = true; } if (i !== null) { net -= i; any = true; } } return any ? net : null; };
  // net cross-border (export − import) using a SPECIFIC schedule component (dayAhead | intraday)
  const xbBy = (x, field) => { if (!x) return null; let net = 0, any = false; for (const p of ['hu', 'bg', 'rs', 'ua', 'md']) { const eo = x['ro' + p], io = x[p + 'ro']; const e = eo ? rnum(eo[field]) : null, i = io ? rnum(io[field]) : null; if (e !== null) { net += e; any = true; } if (i !== null) { net -= i; any = true; } } return any ? net : null; };
  const fmt = (v) => (v === null || v === undefined ? '' : Math.round(v).toLocaleString('en-US'));
  const dlt = (v) => (v === null ? '' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${Math.round(v)}</span>`);
  // forecast deviation cell (upcoming): forecast Real − Notif, shown italic to mark it's a forecast not a measured delta
  const dltF = (v, tip) => (v === null ? '' : `<span style="font-style:italic;opacity:.7" title="${tip}"><span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${Math.round(v)}</span></span>`);
  const arrow = (v) => (v === null ? '' : `${v >= 0 ? '↑' : '↓'}${Math.round(Math.abs(v))}`);
  // warmth heatmap on a cell by the interval-to-interval change magnitude: ~0 = no tint, ~100 = faint amber, ~400 = hot red.
  // Lets the trader spot steep ramps in the notified schedules at a glance. Returns an inline style attribute (or '').
  const warmth = (cur, prev) => {
    if (cur === null || prev === null) return '';
    const d = Math.abs(cur - prev);
    if (d < 40) return ''; // negligible change — leave plain
    const t = Math.min(1, (d - 40) / 410); // 40 MW → 0, 450+ MW → 1
    const h = Math.round(48 - 40 * t);      // hue: amber 48° (small) → red 8° (big)
    const a = (0.14 + 0.5 * t).toFixed(2);  // alpha grows with the change
    return ` style="background:hsla(${h},92%,52%,${a})"`; // NON-important so row highlights (now/gate/last-closed, all !important) still win
  };

  let lastRealIsp = null;
  for (const { isp, ts } of dayTimestamps(date)) { const r = P.get(isp), e2 = E.get(isp); if (new Date(ts).getTime() + 900000 <= nowMs && (rnum(r && r.estimatedSystemImbalance) !== null || rnum(e2 && e2.estimatedSystemImbalance) !== null)) lastRealIsp = isp; }
  const xbAgg = xbDeltaAgg(date); // recorded X-B Δ snapshots → interval-average + drift
  const xbChg = xbPiChange(date); // last intraday change to Notif cross-border per interval (the PI trade: sold/bought)
  let xbHist = new Set(); // intervals that have recorded PI-trade frames → show the ⓘ history popup icon
  try { for (const r of db.prepare('SELECT DISTINCT isp FROM xb_pi_snap WHERE date_ro=?').all(date)) xbHist.add(r.isp); } catch { /* table missing */ }
  const WX = weatherForDate(date); // Romania weather (cloud + 100m wind, real vs D-1 forecast) per UTC hour
  // per-interval RES generation forecast (ENTSO-E A69): prefer the intraday "current" run, fall back to day-ahead
  const resFc = new Map();
  try {
    const tmp = {};
    for (const r of db.prepare("SELECT isp, series, value FROM series WHERE date_ro=? AND series IN ('ws_fc_cur_solar','ws_fc_da_solar','ws_fc_cur_wind_onshore','ws_fc_da_wind_onshore')").all(date)) (tmp[r.isp] || (tmp[r.isp] = {}))[r.series] = r.value;
    for (const isp of Object.keys(tmp)) { const t = tmp[isp]; resFc.set(+isp, { solar: t.ws_fc_cur_solar != null ? t.ws_fc_cur_solar : (t.ws_fc_da_solar != null ? t.ws_fc_da_solar : null), wind: t.ws_fc_cur_wind_onshore != null ? t.ws_fc_cur_wind_onshore : (t.ws_fc_da_wind_onshore != null ? t.ws_fc_da_wind_onshore : null) }); }
  } catch { /* forecast series may be absent */ }
  // MY weather→RES forecast per UTC hour (challenger to ENTSO-E). The model gives the BASE curve (diurnal shape);
  // then an INTRADAY self-correction scales the whole curve by how today is actually running vs that base over the
  // elapsed hours (multiplicative → preserves shape, stays 0 at night). Exceptional day → the rest of the curve lifts.
  const myFc = new Map(); let solarScale = 1, windScale = 1;
  try {
    const resM = getResModel();
    if (resM) {
      // fast: pre-materialized latest-run ensemble mean (weather_hourly), already deduped → agg holds {s:mean,n:1}
      const agg = {}; for (const r of db.prepare("SELECT ts_utc, var, value FROM weather_hourly WHERE var IN ('shortwave_radiation','wind_speed_100m') AND ts_utc>=? AND ts_utc<?").all(addDays(date, -1) + 'T20:00:00Z', addDays(date, 1) + 'T04:00:00Z')) agg[r.var + '|' + r.ts_utc] = { s: r.value, n: 1 };
      const base = new Map();
      for (const ts of new Set(Object.keys(agg).map((k) => k.split('|')[1]))) { const rd = agg['shortwave_radiation|' + ts], wd = agg['wind_speed_100m|' + ts];
        base.set(ts.slice(0, 13), { solar: rd ? resModel.predictSolar(resM, rd.s / rd.n) : null, wind: wd ? resModel.predictWind(resM, wd.s / wd.n) : null }); }
      // intraday factor: today's realized (sen_live mix) vs base over ELAPSED daytime intervals (today only)
      if (date === nowInfo.date) {
        let aS = 0, bS = 0, aW = 0, bW = 0;
        for (const { isp, ts } of dayTimestamps(date)) {
          if (isp >= nowInfo.isp || isp < nowInfo.isp - 12) continue; // elapsed, last ~3h only (track the CURRENT regime, not the morning where the base is biased)
          const b = base.get(new Date(ts).toISOString().slice(0, 13)), act = senMix.get(isp); if (!b || !act) continue;
          if (b.solar != null && b.solar > 100 && act.solar != null) { aS += act.solar; bS += b.solar; }
          if (b.wind != null && b.wind > 50 && act.wind != null) { aW += act.wind; bW += b.wind; }
        }
        if (bS > 200) solarScale = Math.max(0.5, Math.min(2, aS / bS));
        if (bW > 100) windScale = Math.max(0.5, Math.min(2, aW / bW));
      }
      for (const [h, b] of base) myFc.set(h, { solar: b.solar != null ? b.solar * solarScale : null, wind: b.wind != null ? b.wind * windScale : null });
    }
  } catch { /* weather/model may be absent */ }
  // RES forecast cell: ENTSO-E (E) line + my weather-model (M) line, M coloured vs ENTSO-E (green=I expect more, red=less)
  const resCell = (e, m) => {
    const r0 = (v) => (v != null ? Math.round(v) : null);
    const eS = e ? r0(e.solar) : null, eW = e ? r0(e.wind) : null, mS = m ? r0(m.solar) : null, mW = m ? r0(m.wind) : null;
    if (eS == null && eW == null && mS == null && mW == null) return '';
    const col = (mv, ev) => (mv == null || ev == null ? '' : (mv > ev + 50 ? ' class="pos"' : mv < ev - 50 ? ' class="neg"' : ''));
    const arr = solarScale > 1.05 ? '↑' : solarScale < 0.95 ? '↓' : '';
    const mTip = `my weather-model forecast (MW): base curve × today's intraday factor (☀️×${solarScale.toFixed(2)}, 💨×${windScale.toFixed(2)}) measured from how today is running vs the base. Coloured vs ENTSO-E (green = I expect more, red = less).`;
    const eLine = (eS != null || eW != null) ? `<div class="resfc" title="ENTSO-E A69 forecast (MW)"><span class="rlbl">E</span>${eS != null ? ' ☀️' + eS : ''}${eW != null ? ' 💨' + eW : ''}</div>` : '';
    const mLine = (mS != null || mW != null) ? `<div class="resfc" title="${mTip}"><span class="rlbl">M${arr}</span>${mS != null ? ` <span${col(mS, eS)}>☀️${mS}</span>` : ''}${mW != null ? ` <span${col(mW, eW)}>💨${mW}</span>` : ''}</div>` : '';
    return eLine + mLine;
  };
  const signLock = new Map(); // locked (frozen-at-gate) sign forecast per interval — shown glued-right in the Imbalance cell
  try { for (const r of db.prepare('SELECT isp, p, sign, conf FROM sign_lock WHERE date_ro=?').all(date)) signLock.set(r.isp, r); } catch { /* table missing */ }
  // recorded per-interval SCADA time-weighted averages (sen_interval, finalized at interval end) — shown after a
  // "|" on PAST Real X-B cells: "<realized value> | <computed average>".
  senFilter.ensureIntervalTable(db);
  const savedAvg = new Map();
  try { for (const r of db.prepare('SELECT isp, avg_realxb FROM sen_interval WHERE date_ro=? AND avg_realxb IS NOT NULL').all(date)) savedAvg.set(r.isp, r.avg_realxb); } catch { /* table may be empty */ }
  // latest live "Sold schimb" reading — transelectrica shows the freshest sample even before the current ISP
  // is sampled (~10-min feed). Used for the current interval's Real X-B cell so it matches the homepage exactly.
  let latestSold = null;
  if (nowInfo.date === date) for (let k = nowInfo.isp; k >= Math.max(1, nowInfo.isp - 8); k--) { const s = SEN.get(k); if (s && Number.isFinite(s.sold)) { latestSold = s.sold; break; } }
  // live homepage feed (sen-filter, ~10s) — SOLD + PLAN, both from transelectrica (no DAMAS). Falls back to
  // the SENGrafic latest sample if the feed is momentarily down.
  const SF = nowInfo.date === date ? await liveSenFilter().catch(() => null) : null;
  const liveSold = SF && SF.sold !== null ? SF.sold : latestSold;
  const liveNotif = SF && SF.plan !== null ? -SF.plan : null; // Notif X-B (net export) = −PLAN
  const liveProd = SF && SF.prod != null ? SF.prod : null; // live Transelectrica SCADA national generation (for the live row)
  const liveCons = SF && SF.cons != null ? SF.cons : null; // live Transelectrica SCADA national consumption (for the live row)
  const liveSolar = SF ? SF.solar : null, liveWind = SF ? SF.wind : null, liveHydro = SF ? SF.hydro : null, liveNuclear = SF ? SF.nuclear : null; // live SCADA generation mix (for the live-row prod split)
  // the interval the live reading belongs to per its SCADA timestamp (lags the wall-clock interval by the feed
  // delay) — the live value/colour/avg go in THIS row, not the wall-clock current one, until the SCADA clock reaches it.
  const liveSi = SF && SF.ts ? senFilter.tsInterval(SF.ts) : null;
  const liveIsp = nowInfo.date === date ? (liveSi && liveSi.date === date ? liveSi.isp : nowInfo.isp) : -1;
  // interval average (net export, time-weighted) of the sen_live readings in the live (SCADA-time) interval
  let liveAvg = null, liveAvgN = 0;
  if (liveIsp > 0) { const tw = intervalTWA(date, liveIsp); liveAvg = tw.avg; liveAvgN = tw.n; }
  if (liveAvg === null && liveSold !== null) liveAvg = -liveSold; // seed with the live value so it never blanks

  // --- Nowcast prediction of real prod/cons for upcoming (not-yet-settled) intervals ---
  // pred = notified + phi[h]*recentDev, recentDev = mean(real-notified) over the last 3 settled
  // intervals. Self-corrects the SEN/DAMAS basis offset (re-centers on today's gap). See train_real.js.
  const obs = {};
  for (const { isp } of dayTimestamps(date)) {
    const s = SEN.get(isp), gg = G.get(isp); if (!s || !gg) continue;
    const np = rnum(gg.brpsProduction), nc = rnum(gg.brpsConsumption);
    obs[isp] = { prod: np !== null ? s.prod - np : null, cons: nc !== null ? s.cons - nc : null };
  }
  const recentDev = (which) => {
    if (lastRealIsp === null) return null;
    const v = [];
    for (let i = lastRealIsp; i > lastRealIsp - 6 && v.length < 3; i--) { const o = obs[i]; if (o && o[which] !== null && o[which] !== undefined) v.push(o[which]); }
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const rdev = { prod: REALMODEL ? recentDev('prod') : null, cons: REALMODEL ? recentDev('cons') : null };
  // Live cons nowcast gap: carry today's recent (real − DAMAS forecast) cons gap so the forward cons estimate
  // self-corrects to how the day is running (the DAMAS forecast itself only refreshes ~daily).
  const consDamasGap = (() => {
    if (lastRealIsp === null) return 0;
    const v = [];
    for (let i = lastRealIsp; i > lastRealIsp - 6 && v.length < 3; i--) {
      const s = SEN.get(i), cc = C.get(i); const f = cc ? rnum(cc.grossForecastConsumption) : null;
      if (s && f !== null) v.push(s.cons - f);
    }
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  })();
  const predReal = (which, isp, notif) => {
    if (!REALMODEL || notif === null || lastRealIsp === null || isp <= lastRealIsp || rdev[which] === null) return null;
    const m = REALMODEL[which]; const h = Math.min(isp - lastRealIsp, m.phi.length); const i = h - 1;
    const pt = notif + m.phi[i] * rdev[which];
    return { pt, lo: pt + m.p10[i], hi: pt + m.p90[i] };
  };
  const predCell = (pr) => (pr === null ? ''
    : `<span style="font-style:italic;opacity:.7" title="model nowcast · 80% CI ${fmt(pr.lo)}–${fmt(pr.hi)} MW">~${fmt(pr.pt)} <small>±${Math.round((pr.hi - pr.lo) / 2)}</small></span>`);
  // upcoming-cons predictor = LIVE nowcast: DAMAS day-ahead forecast + today's carried (real − forecast) gap.
  // VALIDATED 2026-07-03 (949 intervals, 75-min lead, tool/_predict_real4.js): ~130 MW MAE (~2%) — beat every
  // alternative tried (notif+gap 223, blends 141); K window 2/4/8 indifferent. Same sweep for prod below.
  const fcstPredCell = (v) => (v === null ? ''
    : `<span style="font-style:italic;opacity:.7" title="forecast consumption = Notif cons (fixed D-1 plan, keeps its planned steps) + the hourly deviation curve (solar-aware) + an intraday correction from realised consumption only (trend-projected) · ~96 MW MAE at 15-min lead, ~145 at 75-min">~${fmt(v)}</span>`);
  // upcoming Real prod = 50/50 blend of two information-diverse routes: schedule-consistent (Fcst cons + commercial
  // net X-B) + curve-anchored (Notif prod + solar-aware deviation curve + today's anomaly). 143→106 MW MAE (see prodCurveModel).
  const fcstProdCell = (v) => (v === null ? ''
    : `<span style="font-style:italic;opacity:.7" title="forecast generation = Notif prod (fixed D-1 plan, keeps its planned steps) + the day/evening deviation curve (solar-aware) + an intraday correction from realised production only (trend-projected) · ~93 MW MAE at 15-min lead, ~130 at 75-min">~${fmt(v)}</span>`);
  // live-row generation split from the SCADA feed: solar / wind / hydro / nuclear / other (coal+gas+biomass)
  const prodMix = (prod, so, wi, hy, nu) => { if (prod == null) return '';
    const o = Math.max(0, Math.round(prod - (so || 0) - (wi || 0) - (hy || 0) - (nu || 0)));
    const s = (ic, v, t) => `<span title="${t}">${ic}${Math.round(v || 0)}</span>`;
    return ` <span class="prodmix">| ${s('☀️', so, 'solar')}${s('💨', wi, 'wind')}${s('💧', hy, 'hydro')}${s('⚛️', nu, 'nuclear')}<span title="other (coal/gas/biomass)">🔥${o}</span></span>`; };
  // upcoming Real X-B = pure physical identity (Fcst prod − Fcst cons), ~110 MW MAE — kept physical on purpose
  const fcstXBCell = (v) => (v === null ? ''
    : `<span class="xbf" style="font-style:italic;opacity:.75" title="Real cross-border estimate = Fcst prod − Fcst cons (pure physical identity, ~110 MW MAE at the 75-min lead). Compare with the Notif cross border next to it — the GAP between them is the expected imbalance lean. Updates live with the prod/cons nowcasts. ↑ = export, ↓ = import.">${arrow(v)}</span>`);

  // Forward imbalance is NOT forecast — it depends on how the market plays out intraday; persistence and
  // features add no usable forward skill (2yr walk-forward, tool/xb_phase1.js). Imbalance column is settled-only.

  const COLS = [
    { h: 'Imbalance', u: 'MWh', help: 'Estimated system imbalance. SETTLED intervals: the published value — S = surplus / system long → low or negative price, D = deficit / system short → high price. UPCOMING intervals (~italic, user-spec 2026-07-03): the PHYSICAL-IDENTITY lean = (Fcst Real X-B − Notif X-B)/4 [MWh] — how far predicted physics sits from the notified paper; updates live with the prod/cons forecasts. Hidden together with the X-B estimate toggle. (The old S/D% sign forecast is hidden from display but keeps recording in the background for a future accuracy comparison against this lean.)' },
    { h: 'Price', u: 'RON', help: 'Estimated imbalance price for the interval [RON/MWh].' },
    { h: 'Real prod', u: 'MW', mix: true, help: 'Live national generation from Transelectrica’s SEN feed (~10-min cadence, fresh to the minute, all plant types included). Upcoming intervals (~italic) show a 50/50 BLEND of two routes: schedule-consistent (Fcst cons + the cross-border schedule) and curve-anchored (Notif prod + the hourly real−notif deviation curve — midday −700 MW solar over-scheduling, evening/night +200..450 — + today’s running anomaly). Formula (user-spec 2026-07-02): FIXED Notif prod (the D-1 plan — its planned increases/decreases carry through 1:1) + the day/evening deviation curve (solar-aware: deviation deepens ~0.30 MW per MW of solar forecast above the hourly norm; interpolated smoothly) + an intraday correction from REALISED production only (last-4-interval anomaly, trend-projected ≤2h, reading our ~1-min-fresh SEN recorder). No consumption/schedule leg in the level. ~93 MW MAE at 15-min lead, ~130 at 75-min. Covers today + tomorrow.' },
    { h: 'Notif prod', u: 'MW', help: 'Notified (scheduled) generation, the BRP plan published a day ahead. The 💧 marker flags a scheduled START/STOP in the DISPATCHABLE plan (Notif prod − solar/wind D-1 forecast, step ≥150 MW) — most likely hydro dispatching on the price curve (validated: hydro delivers such steps in 59% of cases; e.g. 2026-07-02 15:00 plan +529 → hydro +406). NOTE: notified production sits on a different basis than SEN metered, so read Prod Δ as a TREND; the live Real-prod nowcast corrects today’s gap.' },
    { h: 'Weather', u: '100m km/h', res: true, help: 'DEFAULT: Romania weather — sky icon (cloud) + 💨 wind speed at 100m (km/h), ensemble mean across 4 RO regions. Flip the switch to show the RES generation FORECAST instead (MW): E = ENTSO-E A69; M = my weather-model (intraday-adjusted, coloured vs E — green = I expect more, red = less). ☀️ solar / 💨 wind. Toggle is per-device, default off.' },
    { h: 'Prod Δ', u: 'MW', help: 'Real − Notified production (carries a basis offset — watch its movement). Rising = generation gaining on plan → pushes the system LONG (surplus, lower price). Upcoming (italic) = forecast deviation = Fcst prod − Notif prod.' },
    { h: 'Real cons', u: 'MW', help: 'Live national consumption from Transelectrica’s SEN feed (~10-min cadence, fresh to the minute), plus the forecast recorded at the 75-min gate in brackets (green = within 150 MW). Upcoming intervals (~italic), user-spec formula (2026-07-02) mirroring Fcst prod: FIXED Notif cons (the D-1 plan — its steps carry through) + the hourly deviation curve (solar-aware: distributed PV depresses metered consumption) + an intraday correction from REALISED consumption only (last-4 anomaly, trend-projected ≤2h). ~96 MW MAE at 15-min lead, ~145 at 75-min. Covers today + tomorrow.' },
    { h: 'Notif cons', u: 'MW', help: 'Notified (scheduled) consumption — the BRP demand plan, frozen D-1 ~22:45 RO. Kept for reference and for the Notif bal plan-balance, but less accurate than the live Real-cons nowcast.' },
    { h: 'Cons Δ', u: 'MW', help: 'Real − Notified consumption (may carry a basis offset — read the movement). Rising = demand gaining on plan → pushes the system SHORT (deficit, higher price). Upcoming (italic) = forecast deviation = Fcst cons − Notif cons.' },
    { h: 'Real Cross border', u: 'MW', xbf: true, help: 'Settled: live net system balance (production − consumption) from SEN, plus the estimate recorded at the 75-min gate in brackets (green = within 150 MW) so the accuracy is checkable. ↑ = net export, ↓ = net import. Upcoming (italic): the PURE PHYSICAL estimate = Fcst prod − Fcst cons (~110 MW MAE at the 75-min lead, validated 2026-07-02). Kept physical deliberately so the GAP between this and the Notif cross border column IS the expected imbalance lean (a blended version scored 91 MW but diluted that signal). Updates live with the prod/cons nowcasts. Use the switch to show/hide the estimate + its record.' },
    { h: 'Notif Cross border', u: 'MW', help: 'Notified (commercial) cross-border — the FULL netted rollup. ↑ = export, ↓ = import. Updates intraday as PI border trades clear. Identity (holds exactly): Notif X-B = X-B D-1 + X-B PI + X-B LT.' },
    { h: 'Cross border D-1', u: 'MW', help: 'Day-ahead component of the notified cross-border schedule (fixed at the day-ahead auction). ↑ = export, ↓ = import.' },
    { h: 'Cross border PI', u: 'MW', help: 'Intraday (PI) component of the notified cross-border — the revision from intraday border trades. Compare with X-B D-1 to see how much the intraday market shifted the position; big values = heavy intraday repositioning. ↑ = export, ↓ = import.' },
    { h: 'Cross border LT', u: 'MW', help: 'Long-term component of the notified cross-border (yearly + monthly capacity rights, nominated ahead of the day-ahead auction). Slowly varying — usually a steady net import on RO’s borders. This is the leg that makes Notif X-B ≠ D-1 + PI: Notif X-B = X-B D-1 + X-B PI + X-B LT. ↑ = export, ↓ = import.' },
    { h: 'Cross border Δ', u: 'MW', help: 'Realized imbalance = Real X-B − Notif X-B, shown for SETTLED intervals only (+ = surplus / more export than scheduled → softer price; − = deficit → firmer). Blank forward on purpose: a 14-day backtest showed forecasting it from prod/cons is ~2× WORSE than just trusting the schedule (worst at the sunset ramp), i.e. the forward imbalance is not forecastable this way. For the forward imbalance read, use the Imbalance column (DAMAS persistence, ~78% next-interval, ~2h).' },
    { h: 'Notif bal', u: 'MW', help: 'Notified plan balance = Notif prod − Notif cons − Notif X-B (net export). If the notified plan closes, this ≈ grid losses (small positive, ~+50–150 MW). Large or negative = the notified plan does not balance, or a basis offset between the prod/cons and exchange figures. NB: prod/cons are frozen D-1 but Notif X-B updates intraday, so this drifts as intraday border trades happen.' },
  ];
  const head = COLS.map((c) => `<th>${c.res ? '<span id="reshdr">' + c.h + '<br><small>' + c.u + '</small></span>' : c.h + '<br><small>' + c.u + '</small>'} <span class="help" tabindex="0">ⓘ<span class="tip">${c.help}</span></span>${c.mix ? '<span class="mixtgl" onclick="toggleMix()" title="show/hide the per-source generation split (solar/wind/hydro/nuclear/other)"></span>' : ''}${c.res ? '<span class="restgl" onclick="toggleRes()" title="toggle: weather icons ⇄ RES generation forecast (ENTSO-E vs my model)"></span>' : ''}${c.xbf ? '<span class="xbftgl" onclick="toggleXbf()" title="show/hide the forward Real X-B estimate (Fcst prod − Fcst cons) and its recorded-at-gate accuracy brackets"></span>' : ''}</th>`).join('');

  // user-spec forecast models: fixed notif + deviation curves + realised-only intraday correction (prod & cons)
  const pdModel = prodCurveModel();
  const pdGap = pdModel ? prodAnomGap(pdModel) : null;
  const cdModel = consCurveModel();
  const cdGap = cdModel ? consAnomGap(cdModel) : null;
  const isWeView = isWeDay(date); // day-type of the viewed date (weekend curves differ, esp. consumption midday)
  const pdTemp = wxTempMap(); // hour → forecast temperature (the curve models' AC-load term)
  let pdSolar = new Map(); // D-1 solar forecast per isp (curve beta basis + the dispatchable-plan derivation)
  try { pdSolar = new Map(db.prepare("SELECT isp, value FROM series WHERE series='ws_fc_da_solar' AND date_ro=? AND value IS NOT NULL").all(date).map((r) => [r.isp, r.value])); } catch { /* ignore */ }
  let pdWind = new Map(); // D-1 wind forecast per isp (dispatchable-plan derivation)
  try { pdWind = new Map(db.prepare("SELECT isp, value FROM series WHERE series='ws_fc_da_wind_onshore' AND date_ro=? AND value IS NOT NULL").all(date).map((r) => [r.isp, r.value])); } catch { /* ignore */ }
  // border capacity utilization: numerator = total commercial exchange (sched_*), denominator = official NTC
  // for BG / rolling 60-day max for HU (flow-based). NTC is hourly → per-isp lookup falls back within the hour.
  const utilM = (() => { const g = (s) => new Map(db.prepare("SELECT isp, value FROM series WHERE series=? AND date_ro=? AND value IS NOT NULL").all(s, date).map((r) => [r.isp, r.value]));
    return { hi: g('sched_HU_RO'), he: g('sched_RO_HU'), bi: g('sched_BG_RO'), be: g('sched_RO_BG'), ni: g('ntc_BG_RO'), ne: g('ntc_RO_BG'), jmi: g('jao_max_HU_RO'), jme: g('jao_max_RO_HU') }; })();
  const huEnvV = huEnv(); // fallback only, when the JAO official max is absent for the date
  const hourVal = (m, isp) => { for (let k = 0; k <= 3; k++) { if (m.has(isp - k)) return m.get(isp - k); } return null; };
  const utilPct = (num, den) => (num != null && den != null && den > 0 ? Math.round(num / den * 100) : null);
  // HU denominators = OFFICIAL flow-based max bilateral exchange (JAO Core maxExchanges, hourly); BG = official NTC (A61)
  const utilAt = (isp) => ({
    hi: utilPct(utilM.hi.get(isp), hourVal(utilM.jmi, isp) ?? (huEnvV && huEnvV.imp)),
    he: utilPct(utilM.he.get(isp), hourVal(utilM.jme, isp) ?? (huEnvV && huEnvV.exp)),
    bi: utilPct(utilM.bi.get(isp), hourVal(utilM.ni, isp)), be: utilPct(utilM.be.get(isp), hourVal(utilM.ne, isp)),
  });
  // per-interval HU-border congestion state from the RO−HU DA spread (row tints; ±5 EUR threshold)
  const huSpread = new Map();
  try {
    const huP = new Map(db.prepare("SELECT isp, value FROM series WHERE series='da_price_hu' AND date_ro=? AND value IS NOT NULL").all(date).map((r) => [r.isp, r.value]));
    for (const r of db.prepare("SELECT isp, value FROM series WHERE series='da_price' AND date_ro=? AND value IS NOT NULL").all(date)) {
      const hv = huP.get(r.isp); if (hv == null) continue;
      const sp = r.value - hv;
      if (sp >= 5) huSpread.set(r.isp, { cls: 'huimp', sp }); else if (sp <= -5) huSpread.set(r.isp, { cls: 'huexp', sp });
    }
  } catch { /* series may be absent */ }
  // production + Real X-B forecasts LOCKED at the trade gate (prod_lock; mirrors the sign predictor's lock discipline)
  let prodLock = new Map();
  try { prodLock = new Map(db.prepare('SELECT isp, fcst, xb, cons, lean FROM prod_lock WHERE date_ro=?').all(date).map((r) => [r.isp, { fcst: r.fcst, xb: r.xb, cons: r.cons, lean: r.lean }])); } catch { /* table may be absent */ }
  const body = dayTimestamps(date).map(({ isp, ts }) => {
    const tsMs = new Date(ts).getTime();
    const isCurrent = nowInfo.date === date && nowMs >= tsMs && nowMs < tsMs + 900000;
    const isLive = isp === liveIsp; // the interval the live Transelectrica reading belongs to (by SCADA time)
    const p = P.get(isp), g = G.get(isp), c = C.get(isp), x = X.get(isp), e = E.get(isp);
    // imbalance: prices report first, else the estimatedPowerSystemImbalance report — SAME value (bit-identical
    // on overlap, verified 2026-07-07) but published ~2 intervals earlier; without the fallback the State/Imbalance
    // columns stall whenever the prices report lags (user-reported).
    const imb = (p ? rnum(p.estimatedSystemImbalance) : null) ?? (e ? rnum(e.estimatedSystemImbalance) : null);
    const price = p ? rnum(p.estimatedPricePositiveImbalance) : null;
    // price not yet published by DAMAS → compute it from the early-publishing balancing-energy data
    const epImb = (price !== null || !p) ? null : earlyPrice(imb, rnum(p.sumQup), rnum(p.sumQdn), rnum(p.sumQupPup), rnum(p.sumQdownPdn));
    const sen = SEN.get(isp) || senFb.get(isp); // scrape first, recorded sen_live telemetry when it's dark
    const realProd = sen ? sen.prod : null;
    const notifProd = g ? rnum(g.brpsProduction) : null;
    const realCons = sen ? sen.cons : null;
    // the live (current) row shows the freshest Transelectrica SCADA prod/cons; settled rows use the SEN interval value
    const dispProd = (isLive && liveProd !== null) ? liveProd : realProd;
    const dispCons = (isLive && liveCons !== null) ? liveCons : realCons;
    // generation mix for the prod split: live SCADA on the live row, per-interval sen_live average on settled rows
    const mx = isLive ? (liveProd !== null ? { solar: liveSolar, wind: liveWind, hydro: liveHydro, nuclear: liveNuclear } : null) : senMix.get(isp);
    const notifCons = g ? rnum(g.brpsConsumption) : null;
    const fcstConsBase = c ? rnum(c.grossForecastConsumption) : null; // DAMAS day-ahead forecast
    // USER-SPEC (2026-07-02): Fcst cons = fixed Notif cons + hourly deviation curve + realised-cons correction
    // (mirrors Fcst prod exactly); DAMAS forecast + gap kept only as the fallback when the curve model is absent.
    const rowTemp = pdTemp.get(new Date(ts).toISOString().slice(0, 13)) ?? null;
    const cdExp = cdModel && notifCons !== null && cdGap !== null ? pdExpect(cdModel, isp, pdSolar.has(isp) ? pdSolar.get(isp) : null, isWeView, rowTemp) : null;
    const fcstCons = cdExp !== null ? notifCons + cdExp + pdGapAt(cdGap, tsMs)
      : (fcstConsBase !== null ? fcstConsBase + consDamasGap : null);
    const rxb = sen ? -sen.sold : null, nxb = notifXB(x); // SEN sold = cons−prod; −sold = net export
    // previous interval's notified values, for the warmth (interval-to-interval change) heatmap on the notif columns
    const gPrev = G.get(isp - 1);
    const prevNotifProd = gPrev ? rnum(gPrev.brpsProduction) : null;
    const prevNotifCons = gPrev ? rnum(gPrev.brpsConsumption) : null;
    const prevNxb = notifXB(X.get(isp - 1));
    // Forward Real X-B = the live commercial schedule (best predictor of real net flow, ~91 MW MAE = the irreducible imbalance).
    // Backtest (14d): an independent prod/cons-derived X-B Δ was ~2× WORSE than this baseline (173 vs 91 MW; 3.5× at the
    // evening ramp), so the forward imbalance is NOT forecastable from prod/cons → X-B Δ is SETTLED-ONLY (realized imbalance);
    // forward imbalance is read from the Imbalance column (DAMAS persistence). Real prod fwd is schedule-consistent (prod−cons=commercial).
    // estimate input: commercial schedule clipped to physical capacity (virtual evening imports reached −3.3 GW
    // vs an all-time realized max of −2.9 — they'd drag the prod/XB estimates beyond anything ever real)
    const nxbEst = nxb !== null ? Math.max(-XB_PHYS, Math.min(XB_PHYS, nxb)) : null;
    const fcstProdSched = fcstCons !== null && nxbEst !== null ? fcstCons + nxbEst : null; // route 1: schedule-consistent
    // USER-SPEC ARCHITECTURE (2026-07-02): Fcst prod = fixed Notif prod (respects its planned steps) + the
    // day/evening deviation curves (solar-aware, interpolated) + an intraday correction from REALISED production
    // only (K=4 anomaly + damped trend). The cons+schedule leg was REMOVED from the level (it injected hour-boundary
    // jumps and levels detached from the plan); measured cost vs the 40/60 blend ≈ 15-25 MW MAE (93 vs 78 @15min,
    // 130 vs 105 @75min — tool/_prod_fc_lab3.js). Both legs still recorded in prod_lock for live comparison.
    const pdExp = pdModel && notifProd !== null && pdGap !== null ? pdExpect(pdModel, isp, pdSolar.has(isp) ? pdSolar.get(isp) : null, isWeView, rowTemp) : null;
    const fcstProdCurve = pdExp !== null ? notifProd + pdExp + pdGapAt(pdGap, tsMs) : null;
    // ⚡ derived hydro start/stop marker: step ≥150 MW in the DISPATCHABLE plan (Notif prod − solar/wind D-1 fcst).
    // Validated 2026-07-03 (tool/_hydro_starts.js, n=110): hydro delivers ≥30% of such steps, right sign, in 59% of
    // cases (naive notif steps only 23% — solar ramps polluted them). Archetype: 2026-07-02 15:00 disp +529 → hydro +406.
    const dispV = notifProd !== null && pdSolar.has(isp) && pdWind.has(isp) ? notifProd - pdSolar.get(isp) - pdWind.get(isp) : null;
    const dispP = prevNotifProd !== null && pdSolar.has(isp - 1) && pdWind.has(isp - 1) ? prevNotifProd - pdSolar.get(isp - 1) - pdWind.get(isp - 1) : null;
    const dispStep = dispV !== null && dispP !== null ? dispV - dispP : null;
    const hydroMark = dispStep !== null && Math.abs(dispStep) >= 150
      ? ` <span style="white-space:nowrap" title="scheduled ${dispStep > 0 ? 'START' : 'STOP'} in the dispatchable plan (Notif prod − solar/wind D-1 forecast): ${dispStep > 0 ? '+' : ''}${Math.round(dispStep)} MW — most likely hydro (delivers such steps in 59% of validated cases; e.g. 2026-07-02 15:00: plan +529 → hydro +406)">💧<small class="${dispStep > 0 ? 'pos' : 'neg'}">${dispStep > 0 ? '+' : ''}${Math.round(dispStep)}</small></span>`
      : '';
    const fcstProd = fcstProdCurve ?? fcstProdSched; // curve architecture; schedule leg only as a fallback when the curve is unavailable
    // forward Real X-B = the PURE PHYSICAL identity: Fcst prod − Fcst cons (user 2026-07-02: keep it physical so
    // the gap vs the Notif X-B column IS the expected imbalance lean, undiluted). Validated ~110 MW MAE @75min
    // (schedule alone 104, blend 91 — tool/_xb_est_check.js); semantic consistency chosen over the 19 MW.
    const fcstXB = fcstProd !== null && fcstCons !== null ? fcstProd - fcstCons : null;
    // Real X-B gradient tint (user 2026-07-03): green = LESS import than notified (surplus lean), red = MORE
    // (deficit lean); opacity ∝ |gap| (full at ~500 MW, dead zone <20). Settled rows use the realized gap (.xbtS),
    // forward rows the estimate's gap (.xbtF — hides with the X-B toggle). Live row keeps its own coloring.
    const xbTdAttr = (() => {
      if (isLive) return liveAvg !== null && nxb !== null && liveAvg !== nxb ? ` style="background:${liveAvg > nxb ? 'var(--tint-pos-strong)' : 'var(--tint-neg-strong)'}!important"` : '';
      const xr2 = savedAvg.has(isp) ? savedAvg.get(isp) : rxb;
      const base = xr2 !== null ? xr2 : fcstXB;
      if (base === null || nxb === null) return '';
      const gap = base - nxb;
      if (Math.abs(gap) < 20) return '';
      return ` class="${xr2 !== null ? 'xbtS' : 'xbtF'}" style="--xbt:rgba(${gap > 0 ? '31,158,87' : '217,58,48'},${Math.min(0.5, Math.abs(gap) / 500 * 0.5).toFixed(2)})" title="${xr2 !== null ? 'realized' : 'estimated'} vs notified: ${gap > 0 ? 'LESS import / more export than the paper (surplus lean)' : 'MORE import / less export than the paper (deficit lean)'} by ${Math.round(Math.abs(gap))} MW"`;
    })();
    const xbDeltaVal = rxb !== null && nxb !== null ? rxb - nxb : null; // realized imbalance only; null (blank) forward
    // realized surplus/deficit from the SCADA time-weighted interval AVERAGE (vs notif) — verified more accurate than
    // the SENGrafic snapshot (MAE 81 vs 94 MW, S/D call +4..8pt, vs ENTSO-E settled flows). Preferred when available.
    const xbDeltaAvg = savedAvg.has(isp) && nxb !== null ? savedAvg.get(isp) - nxb : null;
    // LIVE current interval: Cross border Δ = real-time interval average − Notif cross border (the tracker refreshes it every 8s).
    const xbDeltaLive = isLive && liveAvg !== null && nxb !== null ? liveAvg - nxb : null;
    // colour the just-closed interval by its IMBALANCE (matches the Imbalance S/D column): surplus (imb>0) = green, deficit (imb<0) = red
    const lastClass = imb !== null && imb < 0 ? 'lastneg' : 'lastpos';
    const winClass = (isp === winFrom ? ' winstart' : '') + (isp === winTo ? ' winend' : '');
    // intraday trade-gate state for this interval (see gate setup above)
    const tState = tsMs < curIspStartMs ? 'past' : (tsMs < gateMs ? 'locked' : 'open');
    const gateBoundary = nowInfo.date === date && tsMs >= gateMs && tsMs - 900000 < gateMs; // first tradeable interval today
    // Real prod cell: forecast stays LIVE for every upcoming interval right up to the live one (user 2026-07-03:
    // an updating forecast is better trading info than a frozen one). prod_lock still snapshots at the 75-min gate
    // in the background purely for SCORING — settled rows show real + that recorded forecast (green/red bracket).
    const plv = prodLock.get(isp);
    const prodCellC = dispProd !== null
      ? fmt(dispProd) + (plv != null && plv.fcst != null ? ` <small class="${Math.abs(dispProd - plv.fcst) <= 150 ? 'fc-ok' : 'fc-bad'}" title="production forecast as recorded at the 75-min gate, vs realized (green = within 150 MW)">(${fmt(plv.fcst)})</small>` : '')
      : fcstProdCell(fcstProd);
    const _row = `<tr class="${isCurrent ? 'now' : isp === lastRealIsp ? lastClass : ''}${winClass} t-${tState}${gateBoundary ? ' gateopen' : ''}${isLive ? ' liverow' : ''}${huSpread.has(isp) ? ' ' + huSpread.get(isp).cls : ''}">
      <td><span class="exp" data-isp="${isp}" title="expand — show this interval on the previous 2 days">▸</span> <b>${isp}</b>${gateBoundary ? ' <span class="tradearrow" title="current trade interval — the soonest interval still open to trade">▶</span>' : isCurrent ? ' <span title="current interval, in delivery now">🕐</span>' : isp === lastRealIsp ? ' ●' : ''}${tState === 'locked' ? ' <span class="lockico" title="locked for trading — within the 75-min gate">🔒</span>' : ''}${huSpread.has(isp) ? (() => {
        const hs = huSpread.get(isp), u = utilAt(isp);
        const pct = hs.cls === 'huimp' ? u.hi : u.he;
        const tip = `HU border ${hs.cls === 'huimp' ? `IMPORT-congested — RO detached ${Math.round(hs.sp)} EUR/MWh ABOVE the EU price (scarcity)` : `EXPORT-congested — surplus trapped, RO ${Math.round(-hs.sp)} EUR/MWh BELOW the EU price`}${pct != null ? ` · ${hs.cls === 'huimp' ? 'import' : 'export'} capacity used ${pct}% (vs the official flow-based max (JAO))` : ''}`;
        return ` <span title="${tip}">${hs.cls === 'huimp' ? '🔌' : '🚧'}${pct != null ? `<small>${pct}%</small>` : ''}</span>`;
      })() : ''}${(() => {
        // per-row border capacity readout (user 2026-07-07): H imp/exp · B imp/exp, every interval
        const u = utilAt(isp);
        if (u.hi == null && u.he == null && u.bi == null && u.be == null) return '';
        const f = (v) => (v == null ? '–' : `<span${v >= 90 ? ' style="color:var(--neg,#d93a30);font-weight:700"' : v >= 75 ? ' style="color:#d2691e;font-weight:600"' : ''}>${v}</span>`);
        return ` <small class="xbutil" title="border capacity used this interval — H = Hungary import/export (vs the OFFICIAL flow-based max bilateral exchange, JAO Core, hourly), B = Bulgaria import/export (vs official NTC). Amber ≥75%, red ≥90%. Readings >100% = the commercial paper exceeds the official net max (netted/virtual schedules — the physical flow cannot).">H${f(u.hi)}/${f(u.he)} B${f(u.bi)}/${f(u.be)}</small>`;
      })()}</td><td style="white-space:nowrap">${cetLabel(isp)}${gateBoundary ? ` <span class="ivtimer" data-end="${curIspStartMs + 900000}" title="time until this interval locks (trading closes) and the gate advances to the next">–:––</span>` : ''}</td>
      <td>${imb !== null ? `<span>${dirIcon(imb > 0) + ' ' + fmt(Math.abs(imb))}</span>` + (plv != null && plv.lean != null ? ` <small class="xbf ${Math.sign(plv.lean) === Math.sign(imb) ? 'fc-ok' : 'fc-bad'}" title="imbalance lean as recorded at the 75-min gate, vs realized (green = sign matched)">(${plv.lean > 0 ? 'S' : 'D'} ${fmt(Math.abs(plv.lean))})</small>` : '') : (() => {
        // forward imbalance value = the PHYSICAL-IDENTITY lean (user-spec 2026-07-03): (Fcst Real X-B − Notif X-B)/4 MWh.
        // Honest caveat baked into the tooltip: at the 75-min lead this lean's SIGN is ~coin-flip (52% validated,
        // corr 0.12 vs realized) — it's a MAGNITUDE/pressure read; the calibrated sign call stays the S/D% badge.
        if (fcstXB === null || nxb === null) return '';
        const lean = (fcstXB - nxb) / 4;
        return `<span class="xbf" style="font-style:italic;opacity:.7" title="expected imbalance lean = (Fcst Real X-B − Notif X-B)/4 [MWh] — how far predicted physics sits from the paper. Updates live with the prod/cons forecasts.">${dirIcon(lean > 0)} ~${fmt(Math.abs(lean))}</span>`;
      })()}</td>${'' /* sign-model S/D% display HIDDEN (user 2026-07-03): the physical lean is THE shown forecast now.
        The sign model keeps RUNNING + RECORDING in the background (lockDueForecasts → sign_lock, /api/predict_sign,
        pulse) — FUTURE TASK: compare sign-model vs physical-lean accuracy on the accumulated locked records. */}
      <td>${price !== null ? fmt(price) + ' <small class="cur">lei</small>' : (epImb !== null ? provPriceSpan(epImb) + ' <small class="cur">lei</small>' : '')}</td>
      <td data-rprod="${isp}">${prodCellC}${dispProd !== null && mx ? prodMix(dispProd, mx.solar, mx.wind, mx.hydro, mx.nuclear) : ''}</td><td${warmth(notifProd, prevNotifProd)}>${fmt(notifProd)}${notifProd !== null && prevNotifProd !== null ? ` <small class="${notifProd - prevNotifProd >= 0 ? 'pos' : 'neg'}" title="change from the previous interval">${notifProd - prevNotifProd >= 0 ? '+' : ''}${Math.round(notifProd - prevNotifProd)}</small>` : ''}${hydroMark}</td><td class="wx"><span class="wxw">${wxCell(WX.get(new Date(ts).toISOString().slice(0, 13)))}</span><span class="wxr">${resCell(resFc.get(isp), myFc.get(new Date(ts).toISOString().slice(0, 13)))}</span></td><td>${dispProd !== null && notifProd !== null ? dlt(dispProd - notifProd) : ''}</td>
      <td data-rcons="${isp}">${dispCons !== null ? fmt(dispCons) + (plv != null && plv.cons != null ? ` <small class="${Math.abs(dispCons - plv.cons) <= 150 ? 'fc-ok' : 'fc-bad'}" title="consumption forecast as recorded at the 75-min gate, vs realized (green = within 150 MW)">(${fmt(plv.cons)})</small>` : '') : fcstPredCell(fcstCons)}</td><td${warmth(notifCons, prevNotifCons)}>${fmt(notifCons)}${notifCons !== null && prevNotifCons !== null ? ` <small class="${notifCons - prevNotifCons >= 0 ? 'pos' : 'neg'}" title="change from the previous interval">${notifCons - prevNotifCons >= 0 ? '+' : ''}${Math.round(notifCons - prevNotifCons)}</small>` : ''}</td><td>${dispCons !== null && notifCons !== null ? dlt(dispCons - notifCons) : ''}</td>
      <td data-rxb="${isp}"${xbTdAttr}>${isLive ? ((liveSold !== null ? arrow(-liveSold) : '<small>…</small>') + (liveAvg !== null ? ` <span style="font-size:11px;font-weight:600" title="interval average of ${liveAvgN} polled readings">| ${arrow(liveAvg)}</span>` : '')) : (() => { const xr = savedAvg.has(isp) ? savedAvg.get(isp) : rxb; if (xr === null) return fcstXBCell(fcstXB); return arrow(xr) + (plv && plv.xb != null ? ` <small class="xbf ${Math.abs(xr - plv.xb) <= 150 ? 'fc-ok' : 'fc-bad'}" title="Real X-B estimate as recorded at the 75-min gate, vs realized (green = within 150 MW)">(${arrow(plv.xb)})</small>` : ''); })()}</td><td class="nxbcell" data-isp="${isp}" data-v="${nxb === null ? '' : Math.round(nxb)}"${warmth(nxb, prevNxb)}><span class="nxbval">${arrow(nxb)}</span>${xbChg.has(isp) ? ` <small class="${xbChg.get(isp) >= 0 ? 'pos' : 'neg'}" title="last intraday change to the notified cross-border (a PI trade): the market ${xbChg.get(isp) >= 0 ? 'SOLD — net export rose' : 'BOUGHT — net export fell'} by ${Math.abs(Math.round(xbChg.get(isp)))} MW">· ${xbChg.get(isp) >= 0 ? 'sold' : 'bought'} ${Math.abs(Math.round(xbChg.get(isp)))}</small>` : ''}${xbHist.has(isp) ? ` <span class="pi-i" data-isp="${isp}" title="show this interval's full PI-trade history">ⓘ</span>` : ''}</td><td>${arrow(xbBy(x, 'dayAhead'))}</td><td>${arrow(xbBy(x, 'intraday'))}</td><td>${arrow(xbBy(x, 'longTerm'))}</td><td data-xbd="${isp}">${isLive ? (xbDeltaLive !== null ? `<span title="live: interval average − Notif cross border">${dlt(xbDeltaLive)}</span>` : '') : (xbDeltaAvg !== null ? `<span title="real − notif from the SCADA time-weighted interval average (more accurate than the snapshot, verified vs ENTSO-E settled flows)">${dlt(xbDeltaAvg)}</span>` : (xbDeltaCell(xbAgg, isp) || (xbDeltaVal === null ? '' : dlt(xbDeltaVal))))}</td>
      <td>${dlt(notifProd !== null && notifCons !== null && nxb !== null ? notifProd - notifCons - nxb : null)}</td>
    </tr>`;
    // the CURRENT TRADE row (gate = first tradeable, ~75 min ahead) is a 3-deep block: row 1 = today (above, as is),
    // then the SAME interval on the previous 2 days for trade context.
    return _row;
  }).join('\n');

  // 🔌 HU-link congestion meter — EXACT: coupled markets equalize prices unless the border binds, so any hourly
  // RO−HU DA spread ⟺ congestion. + = import-congested (scarcity, RO detaches ABOVE the EU price);
  // − = export-congested (surplus trapped, RO detaches BELOW — midday crash risk for the solar position).
  const huBar = (() => {
    try {
      const roP = db.prepare("SELECT isp, value FROM series WHERE series='da_price' AND date_ro=? AND value IS NOT NULL").all(date);
      const huP = new Map(db.prepare("SELECT isp, value FROM series WHERE series='da_price_hu' AND date_ro=? AND value IS NOT NULL").all(date).map((r) => [r.isp, r.value]));
      if (!roP.length || !huP.size) return '';
      const byH = {};
      for (const r of roP) { const hv = huP.get(r.isp); if (hv == null) continue; const h = Math.floor((((r.isp - 1) * 15 - 60) + 1440) % 1440 / 60); (byH[h] = byH[h] || []).push(r.value - hv); }
      const hours = Object.keys(byH).map(Number).sort((a, b) => a - b);
      if (!hours.length) return '';
      const segs = [];
      let cur = null;
      for (const h of hours) {
        const sp = byH[h].reduce((a, b) => a + b, 0) / byH[h].length;
        const st = sp >= 5 ? 'imp' : sp <= -5 ? 'exp' : 'open';
        if (cur && cur.st === st && h === cur.to + 1) { cur.to = h; if (Math.abs(sp) > Math.abs(cur.peak)) cur.peak = sp; }
        else { cur = { st, from: h, to: h, peak: sp }; segs.push(cur); }
      }
      const cong = segs.filter((s) => s.st !== 'open');
      const lbl = (s) => `${String(s.from).padStart(2, '0')}–${String(s.to + 1).padStart(2, '0')}h <b style="color:${s.st === 'imp' ? 'var(--neg,#d93a30)' : '#d2691e'}">${s.st === 'imp' ? 'IMPORT-congested — RO detached ABOVE the EU price' : 'EXPORT-congested — surplus trapped, RO below the EU price'}</b> <small>(peak ${s.peak >= 0 ? '+' : ''}${Math.round(s.peak)} EUR/MWh)</small>`;
      const body = cong.length ? cong.map(lbl).join(' &nbsp;·&nbsp; ') : '<b class="pos">OPEN all day</b> — RO coupled to the EU price (spread ~0 every hour)';
      // capacity utilization day peaks per border+direction (BG vs official NTC; HU vs its 60-day commercial max)
      const peaks = { hi: 0, he: 0, bi: 0, be: 0 };
      for (const isp of new Set([...utilM.hi.keys(), ...utilM.he.keys(), ...utilM.bi.keys(), ...utilM.be.keys()])) {
        const u = utilAt(isp);
        for (const k of ['hi', 'he', 'bi', 'be']) if (u[k] != null && u[k] > peaks[k]) peaks[k] = u[k];
      }
      const utilLine = (peaks.hi || peaks.bi) ? `<br><small style="color:var(--fg-muted)">capacity used, day peak — HU: import ${peaks.hi}% · export ${peaks.he}% <i>(vs official JAO flow-based max)</i> &nbsp;|&nbsp; BG: import ${peaks.bi}% · export ${peaks.be}% <i>(vs official NTC)</i></small>` : '';
      return `<div id="hubar" style="margin:0 0 8px;font-size:12px;padding:6px 11px;border-radius:8px;background:var(--bg-subtle);border:1px solid var(--border-2)"><b>🔌 HU link</b> <span class="help" tabindex="0">ⓘ<span class="tip">The exact congestion meter for Romania’s only border to the Central-European market. Coupled markets equalize prices unless the border is FULL — so any hourly RO−HU day-ahead spread means the HU border was binding. + spread = import-congested (scarcity: RO detaches ABOVE the EU price, expensive evenings). − spread = export-congested (surplus trapped: RO detaches BELOW, midday price-crash risk). Known for the whole day at ~13:00 D-1. Detached intervals are tinted in the table: VIOLET rows = import-congested, AMBER rows = export-congested; the 🔌/🚧 icons carry the capacity-used %.</span></span> ${body}${utilLine}</div>`;
    } catch { return ''; }
  })();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#FFF500"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="GAN Trading"><link rel="apple-touch-icon" href="/icon-180.png"><title>Predict ${date}</title>${STYLE}</head><body>
${NAV('predict', date, null, colPicker('cols-predict', [], [7, 10, 13, 15, 17]))}<div class="content">
<div style="margin:4px 0 8px;font-size:12px;color:var(--fg-muted)"><span id="rtdot" style="color:#1a9e57">●</span> live — updated <span id="rtstamp">just now</span> <small>· auto-refresh 15s</small></div>
${huBar}<div id="pulsebar" style="margin:0 0 8px;font-size:12px;padding:6px 11px;border-radius:8px;background:var(--bg-subtle);border:1px solid var(--border-2);display:none"></div>
<div id="scorebar" style="margin:0 0 8px;font-size:12px;padding:6px 11px;border-radius:8px;background:var(--bg-subtle);border:1px solid var(--border-2);display:none"></div>
<div id="resscore" style="margin:0 0 8px;font-size:12px;padding:6px 11px;border-radius:8px;background:var(--bg-subtle);border:1px solid var(--border-2);display:none"></div>
<table><caption class="gatecap">${gateCaption}</caption><tr><th>Int<span class="xbutgl" onclick="toggleXbu()" title="show/hide the per-interval border capacity used — H = Hungary imp/exp (vs JAO flow-based max), B = Bulgaria imp/exp (vs official NTC)"></span></th><th>CET</th>${head}</tr>
${body}</table></div>
<script>document.addEventListener('click',function(ev){var h=ev.target.closest('.help');
  document.querySelectorAll('.help.show').forEach(function(x){if(x!==h)x.classList.remove('show')});
  if(h){h.classList.toggle('show');ev.preventDefault();}});</script>
<script>(function(){
  // Near-realtime partial refresh: re-fetch this page, swap ONLY the table body in place (no full
  // reload → no flash, scroll kept), and re-apply the colPicker column hiding to the fresh cells.
  var POLL=15000;
  function dot(c){var d=document.getElementById('rtdot');if(d)d.style.color=c;}
  function tick(){
    fetch(location.href,{cache:'no-store',headers:{'X-Requested-With':'rt'}})
      .then(function(r){if(!r.ok)throw 0;return r.text();})
      .then(function(html){
        var doc=new DOMParser().parseFromString(html,'text/html');
        var fresh=doc.querySelector('.content table'), cur=document.querySelector('.content table');
        if(fresh&&cur){
          // capture old Notif cross-border values so we can FLASH any cell whose value changed (a PI trade cleared)
          var oldNxb={}; cur.querySelectorAll('.nxbcell').forEach(function(c){oldNxb[c.dataset.isp]=c.dataset.v;});
          cur.innerHTML=fresh.innerHTML;
          if(window.__applyColHiding)window.__applyColHiding();
          if(window.__reexpand)window.__reexpand(); // re-insert any user-expanded interval history (lost on table swap)
          if(window.__paintForecast)window.__paintForecast(); // re-fill the upcoming-interval sign forecasts
          cur.querySelectorAll('.nxbcell').forEach(function(c){
            var o=oldNxb[c.dataset.isp];
            if(o!==undefined && o!=='' && o!==c.dataset.v && c.animate){ // value changed (PI trade) → bold 3-pulse blink
              var sold=(+c.dataset.v)-(+o)>=0; // net export rose = SOLD (green) ; fell = BOUGHT (red)
              var col=sold?'rgba(31,158,87,0.95)':'rgba(217,58,48,0.95)';
              c.animate([{backgroundColor:col},{backgroundColor:'rgba(0,0,0,0)'},{backgroundColor:col},{backgroundColor:'rgba(0,0,0,0)'},{backgroundColor:col},{backgroundColor:'rgba(0,0,0,0)'}],{duration:3300,easing:'linear'}); // ~3 visible pulses over 3.3s
            }
          });
        }
        var el=document.getElementById('rtstamp');if(el)el.textContent=new Date().toLocaleTimeString();
        dot('#1a9e57');
      })
      .catch(function(){dot('#d2691e');})
      .finally(function(){setTimeout(tick,POLL);}); // self-paced: next poll 15s AFTER this one finishes
  }
  setTimeout(tick,POLL);
})();</script>
<script>(function(){
  // LIVE current-interval Real X-B tracker (Transelectrica Sold). Updates ONLY the current interval's Real X-B
  // cell on a fast (8s) cadence so a change is caught quickly; past intervals stay frozen at their last-taken
  // value (the 15s full refresh renders them from the feed's last sample). On rollover the live value moves to
  // the new current interval and the prior cell keeps the value as last taken.
  var DATE=${JSON.stringify(date)}, last=null;
  function ar(v){return v>=0?('↑'+Math.round(v)):('↓'+Math.round(-v));}
  function tick(){
    fetch('/api/realxb_now?date='+DATE,{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
      if(j.soldIsp==null||j.realxb==null)return;
      if(last!==null&&last!==j.soldIsp){var o=document.querySelector('td[data-rxb="'+last+'"] .rxblive');if(o)o.remove();var or=document.querySelector('td[data-rxb="'+last+'"]');if(or&&or.parentElement)or.parentElement.classList.remove('liverow');} // freeze prior interval (keep its value + colour), drop its big-row treatment
      var c=document.querySelector('td[data-rxb="'+j.soldIsp+'"]');
      if(c&&c.parentElement)c.parentElement.classList.add('liverow'); // big-row treatment follows the live interval between refreshes
      // Notif X-B SINGLE SOURCE OF TRUTH = the DISPLAYED value (DAMAS netted rollup, refreshed by the 15s full reload,
      // which is actually the FRESHER feed — 15s vs xb_pi_snap's ~60s). Do NOT overwrite it here from notifPi: the two
      // feeds differ per-poll, so rewriting made the current interval's Notif X-B flicker between them and spuriously
      // flash every cycle. Colour/Δ use the displayed value; notifPi/notifxb are only a fallback if the cell is blank.
      var nc=document.querySelector('td.nxbcell[data-isp="'+j.soldIsp+'"]');
      var notif=(nc&&nc.dataset.v!=='')?+nc.dataset.v:(j.notifPi!=null?j.notifPi:j.notifxb);
      if(c){
        c.title='Sold schimb (Transelectrica)='+Math.round(j.sold)+' MW (minus=export→↑, plus=import→↓) · Notif X-B='+(notif!=null?Math.round(notif):'?')+' MW · '+new Date().toLocaleTimeString();
        var brx=keepBr(c);
        c.innerHTML=ar(j.realxb)+(j.avg!=null?' <span style="font-size:11px;font-weight:600" title="interval average of '+j.navg+' polled readings">| '+ar(j.avg)+'</span>':'')+brx;
        if(notif!=null&&j.avg!=null){c.style.removeProperty('background');if(j.avg!==notif)c.style.setProperty('background',j.avg>notif?'var(--tint-pos-strong)':'var(--tint-neg-strong)','important');} // colour by the interval AVERAGE vs live Notif (matches the live Δ sign)
        if(c.animate)c.animate([{opacity:1},{opacity:.62},{opacity:1}],{duration:600,easing:'ease-in-out'}); // gentle blink on each refresh
      }
      // live Real prod / Real cons for the current interval = freshest Transelectrica SCADA reading.
      // keepBr: PRESERVE the recorded-at-gate forecast bracket (small.fc-ok/.fc-bad) — overwriting without it
      // made the brackets flicker against the 15s full refresh (user-reported 2026-07-03).
      function keepBr(el){var b=el&&el.querySelector('small.fc-ok,small.fc-bad');return b?' '+b.outerHTML:'';}
      function mixHtml(j){if(j.prod==null)return '';var o=Math.max(0,Math.round(j.prod-(j.solar||0)-(j.wind||0)-(j.hydro||0)-(j.nuclear||0)));function s(ic,v,t){return '<span title="'+t+'">'+ic+Math.round(v||0)+'</span>';}return ' <span class="prodmix">| '+s('☀️',j.solar,'solar')+s('💨',j.wind,'wind')+s('💧',j.hydro,'hydro')+s('⚛️',j.nuclear,'nuclear')+'<span title="other (coal/gas/biomass)">🔥'+o+'</span></span>';}
      var pc=document.querySelector('td[data-rprod="'+j.soldIsp+'"]'); if(pc&&j.prod!=null){var brp=keepBr(pc);pc.innerHTML=Math.round(j.prod).toLocaleString('en-US')+brp+mixHtml(j);if(pc.animate)pc.animate([{opacity:1},{opacity:.62},{opacity:1}],{duration:600,easing:'ease-in-out'});}
      var cc=document.querySelector('td[data-rcons="'+j.soldIsp+'"]'); if(cc&&j.cons!=null){var brc=keepBr(cc);cc.innerHTML=Math.round(j.cons).toLocaleString('en-US')+brc;if(cc.animate)cc.animate([{opacity:1},{opacity:.62},{opacity:1}],{duration:600,easing:'ease-in-out'});}
      // Cross border Δ (live) for the current interval = interval-AVERAGE real X-B (right of the |) − LIVE Notif cross border
      var dc=document.querySelector('td[data-xbd="'+j.soldIsp+'"]');
      if(dc&&j.avg!=null&&notif!=null){var d=Math.round(j.avg-notif);dc.innerHTML='<span class="'+(d>=0?'pos':'neg')+'" title="live: interval AVERAGE real X-B (right of the |) − live Notif cross border">'+(d>=0?'+':'')+d+'</span>';if(dc.animate)dc.animate([{opacity:1},{opacity:.62},{opacity:1}],{duration:600,easing:'ease-in-out'});}
      last=j.soldIsp;
    }).catch(function(){}).finally(function(){setTimeout(tick,8000);});
  }
  setTimeout(tick,1200);
})();</script>
<script>(function(){
  // Live MM:SS countdown on every .ivtimer (the current trade interval's row + the caption): time until the current
  // ISP closes — at 0 that trade interval locks and the gate advances. Re-queried each tick so it survives the 15s refresh.
  function fmt(ms){ms=Math.max(0,ms);var s=Math.floor(ms/1000);return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2);}
  function tick(){var now=Date.now();document.querySelectorAll('.ivtimer').forEach(function(el){var end=+el.dataset.end;if(end)el.textContent=fmt(end-now);});}
  setInterval(tick,1000);tick();
})();</script>
<script>(function(){
  // per-row expand caret: lazily fetch + insert this interval's 2 historical rows (prev day, 2 days ago). Cached so it
  // re-applies after the 15s refresh (which swaps the table). The trade row's history is server-rendered (green box).
  var DATE=${JSON.stringify(date)}, cache={};
  function insert(isp){
    var c=document.querySelector('.exp[data-isp="'+isp+'"]'); if(!c)return; var row=c.closest('tr');
    document.querySelectorAll('tr.histrow[data-pisp="'+isp+'"]').forEach(function(r){r.remove();}); // avoid dupes
    row.insertAdjacentHTML('afterend', cache[isp]); row.classList.add('expanded'); c.textContent='▾';
    if(window.__applyColHiding)window.__applyColHiding();
  }
  function collapse(isp){
    document.querySelectorAll('tr.histrow[data-pisp="'+isp+'"]').forEach(function(r){r.remove();});
    var c=document.querySelector('.exp[data-isp="'+isp+'"]'); if(c){c.textContent='▸';var r=c.closest('tr');if(r)r.classList.remove('expanded');}
    delete cache[isp];
  }
  document.addEventListener('click',function(e){
    var c=e.target.closest&&e.target.closest('.exp'); if(!c)return;
    var isp=c.dataset.isp;
    if(document.querySelector('tr.histrow[data-pisp="'+isp+'"]')){ collapse(isp); return; } // already open → close
    if(cache[isp]){ insert(isp); return; }
    var row=c.closest('tr'); var g=(row&&row.classList.contains('gateopen'))?'&gate=1':'';
    fetch('/api/histrows?date='+DATE+'&isp='+isp+g,{cache:'no-store'}).then(function(r){return r.text();}).then(function(html){ cache[isp]=html; insert(isp); }).catch(function(){});
  });
  window.__reexpand=function(){ Object.keys(cache).forEach(insert); }; // called after each refresh
})();</script>
<script>(function(){
  // LIVE SIGN FORECAST: fill upcoming Imbalance cells with predicted S/D + confidence%, refreshed every 10s
  // (and right after the 15s table swap). Fuses persistence + time-of-day + PI order-flow (see sign_model.js).
  var DATE=${JSON.stringify(date)};
  function paint(){
    fetch('/api/predict_sign?date='+DATE,{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
      var by={}; (j.rows||[]).forEach(function(r){by[r.isp]=r;});
      document.querySelectorAll('.fc-imb').forEach(function(el){
        var r=by[el.dataset.fc];
        if(!r)return; // left the tradeable set (crossed the gate) → keep its last value; the 15s refresh renders it LOCKED
        el.className='fc-imb fc-r '+(r.sign==='S'?'fc-s':'fc-d');
        var pf=r.panic?(' <span class="pflag'+(r.panic.opposes?' pflag-x':'')+'" title="big PI repositioning ~'+r.panic.abs+' MW → '+(r.panic.dir==='S'?'export / surplus-leaning':'import / deficit-leaning')+(r.panic.opposes?' — AGAINST the current state (possible flip; logged for validation, not yet acted on)':' — confirms the current state')+'">⚠</span>'):'';
        el.innerHTML=r.sign+' <small>'+r.conf+'%</small>'+pf;
        el.title='forecast '+(r.sign==='S'?'surplus':'deficit')+' · '+r.conf+'% confidence (persistence + time-of-day + PI order-flow; updates as trades land)';
      });
    }).catch(function(){});
  }
  window.__paintForecast=paint;
  setInterval(paint,10000); setTimeout(paint,1500);
})();</script>
<script>(function(){
  function lbl(s){return s==='S'?'surplus':s==='D'?'deficit':'balanced';}
  function paint(){
    fetch('/api/pulse',{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
      var el=document.getElementById('pulsebar'); if(!el)return; if(!j.ok){el.style.display='none';return;}
      el.style.display='block';
      var col=j.scadaSign==='S'?'#1a9e57':j.scadaSign==='D'?'#d83a3a':'var(--fg-muted)';
      var devTxt=Math.abs(j.dev)+' MW '+(j.dev>0?'over':'under')+' plan';
      var trend=''; if(j.trend!=null&&j.scadaSign){var deepening=(j.trend>0)===(j.dev>0);trend=' · '+(Math.abs(j.trend)<15?'steady':(deepening?'deepening':'easing'));}
      var anchorTxt=j.anchorSign?('last settled '+lbl(j.anchorSign)+' '+Math.abs(j.anchor)+' ('+j.anchorAgeMin+'m ago)'):'no recent settled value';
      var turn=j.turn?' · <b style="color:#c8860a">⚠ disagrees with last settled — possible turn to '+lbl(j.scadaSign)+'</b>':'';
      el.innerHTML='<b>⚡ Live pulse</b> <small style="color:var(--fg-muted)">('+j.ageS+'s ago, SCADA)</small> · <b style="color:'+col+'">'+lbl(j.scadaSign).toUpperCase()+'</b> lean <small style="color:var(--fg-muted)">('+devTxt+trend+')</small> · <small style="color:var(--fg-muted)">'+anchorTxt+'</small>'+turn;
    }).catch(function(){});
  }
  setInterval(paint,10000); setTimeout(paint,1000);
})();</script>
<script>(function(){
  // SELF-CHECK scorecard: how the model's LOCKED forecasts did vs realized TODAY + the trailing miss streak.
  // Surfaces when the model is off-trend so forward calls get discounted (the forward probs already re-update each close).
  var DATE=${JSON.stringify(date)};
  function paintScore(){
    fetch('/api/sign_score?date='+DATE,{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
      var el=document.getElementById('scorebar'); if(!el)return; if(!j.n){el.style.display='none';return;}
      el.style.display='block';
      var seq=(j.last||[]).map(function(s){return '<span title="isp '+s.isp+': predicted '+s.pred+' '+s.conf+'%, actual '+s.act+'" style="color:'+(s.ok?'#1a9e57':'#d83a3a')+';font-weight:700">'+(s.ok?'✓':'✗')+'</span>';}).join(' ');
      var warn=j.streak>=3?' · <b style="color:#d83a3a">⚠ off-trend — '+j.streak+' straight misses; forward calls less reliable</b>':(j.streak===2?' · <b style="color:#c8860a">⚠ 2 misses in a row</b>':'');
      el.innerHTML='<b>🧭 Model today</b> · <b>'+j.hit+'/'+j.n+'</b> <small style="color:var(--fg-muted)">('+j.pct+'%)</small> · <small style="color:var(--fg-muted)">recent</small> '+seq+warn;
    }).catch(function(){});
  }
  setInterval(paintScore,15000); setTimeout(paintScore,1200);
})();</script>
<script>(function(){
  // RES forecast SCORECARD: running MAE of my base model (M) vs ENTSO-E (E) against actual generation. Lower = better.
  var DATE=${JSON.stringify(date)};
  function w(o,lbl){ if(!o)return ''; var win=o.me<o.entso; var lose=o.me>o.entso;
    return lbl+' me <b style="color:'+(win?'#1a9e57':lose?'#d83a3a':'inherit')+'">'+o.me+'</b> vs E '+o.entso+' <small style="color:var(--fg-muted)">MAE</small>'; }
  function paintRes(){
    fetch('/api/res_score?date='+DATE,{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
      var el=document.getElementById('resscore'); if(!el)return; if(!j.ok||(!j.solar&&!j.wind)){el.style.display='none';return;}
      el.style.display='block';
      var parts=[]; if(j.solar)parts.push(w(j.solar,'☀️')); if(j.wind)parts.push(w(j.wind,'💨'));
      var td=[]; if(j.todaySolar)td.push(w(j.todaySolar,'☀️')); if(j.todayWind)td.push(w(j.todayWind,'💨'));
      el.innerHTML='<b>🎯 RES fcst accuracy</b> <small style="color:var(--fg-muted)">('+j.days+'d, lower MAE wins)</small> · '+parts.join(' · ')+(td.length?' <small style="color:var(--fg-muted)">| today</small> '+td.join(' · '):'');
    }).catch(function(){});
  }
  setInterval(paintRes,60000); setTimeout(paintRes,1500);
})();</script>
<div id="pimodal" class="pimodal"><div class="pimbox"><div class="pimhead"><b id="pimtitle"></b><span class="pimx" title="close">✕</span></div><div id="pimbody"></div></div></div>
<script>(function(){
  // ⓘ on a Notif cross-border cell → popup with that interval's full PI-trade history (every recorded change).
  var DATE=${JSON.stringify(date)}, modal=document.getElementById('pimodal');
  function close(){modal.classList.remove('open');}
  modal.addEventListener('click',function(e){if(e.target===modal||e.target.classList.contains('pimx'))close();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')close();});
  document.addEventListener('click',function(e){
    var i=e.target.closest&&e.target.closest('.pi-i'); if(!i)return;
    var isp=i.dataset.isp;
    document.getElementById('pimtitle').textContent='Loading…'; document.getElementById('pimbody').innerHTML=''; modal.classList.add('open');
    fetch('/api/xbpi?date='+DATE+'&isp='+isp,{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
      document.getElementById('pimtitle').textContent='PI trades · interval '+j.isp+' ('+j.cet+' CET)'+(j.realized!=null?' · realized '+Math.round(j.realized)+' MWh '+(j.realized>0?'S':'D'):'');
      if(!j.frames||!j.frames.length){document.getElementById('pimbody').innerHTML='<div style="opacity:.6;padding:8px">No PI trades recorded for this interval.</div>';return;}
      var rows=j.frames.map(function(f){return '<tr><td>'+f.time+'</td><td>'+(f.commercial>=0?'↑':'↓')+Math.round(Math.abs(f.commercial))+'</td><td class="'+(f.deltaC>=0?'pos':'neg')+'">'+(f.deltaC==null?'·':(f.deltaC>=0?'+':'')+Math.round(f.deltaC))+'</td><td class="'+(f.action.indexOf('sold')===0?'pos':f.action?'neg':'')+'">'+f.action+'</td></tr>';}).join('');
      document.getElementById('pimbody').innerHTML='<table><tr><th>Time (CET)</th><th>Notif X-B</th><th>Δ</th><th>Market</th></tr>'+rows+'</table><div style="opacity:.55;font-size:11px;margin-top:8px">Each row = a recorded change to the notified cross-border (an intraday PI trade). sold = net export rose, bought = net export fell.</div>';
    }).catch(function(){document.getElementById('pimbody').innerHTML='<div style="opacity:.6;padding:8px">Could not load history.</div>';});
  });
})();</script>
</body></html>`;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

function readForm(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b))));
  });
}

// ---- auth: named users from USERS env ("ana:pw1,ion:pw2"), HMAC-signed session cookie ----
const crypto = require('crypto');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const USERS = new Map((process.env.USERS || 'admin:admin')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => { const i = s.indexOf(':'); return [s.slice(0, i), s.slice(i + 1)]; }));
// LOCAL: no login wall unless USERS is explicitly set (cloud always sets it). Local dev = trusted.
const AUTH_ON = !!process.env.USERS;

const signSession = (user) => {
  const payload = `${user}|${Date.now() + 30 * 86400000}`;
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64url') + '.' + mac;
};
const verifySession = (token) => {
  try {
    const [b, mac] = String(token).split('.');
    const payload = Buffer.from(b, 'base64url').toString();
    const expect = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
    const [user, exp] = payload.split('|');
    return Date.now() < Number(exp) && USERS.has(user) ? user : null;
  } catch { return null; }
};
const cookieUser = (req) => {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  return m ? verifySession(m[1]) : null;
};

const loginPage = (err) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#FFF500"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="GAN Trading"><link rel="apple-touch-icon" href="/icon-180.png">${STYLE}<title>Sign in</title></head><body>
<div class="banner"><h1><span class="highlight">GAN Trading</span></h1></div>
<div class="content" style="max-width:360px;margin:60px auto">
<h2>Sign in</h2>${err ? '<p class="neg">Wrong user or password.</p>' : ''}
<form method="post" action="/login" style="display:flex;flex-direction:column;gap:12px">
<input name="user" placeholder="user" autocomplete="username" style="font:inherit;padding:10px 14px;border:1px solid var(--border-2);border-radius:10px">
<input name="pass" type="password" placeholder="password" autocomplete="current-password" style="font:inherit;padding:10px 14px;border:1px solid var(--border-2);border-radius:10px">
<button type="submit" style="padding:12px">Sign in</button>
</form></div></body></html>`;

async function piLearnPage(date, frameTs) {
  date = date || roDateIsp(new Date()).date;
  const today = roDateIsp(new Date()).date;
  const nowMs = Date.now(); const nowInfo = roDateIsp(new Date());
  const [P, X] = await Promise.all([liveReport('estimatedImbalancePrices', date).catch(() => new Map()), liveReport('scheduledExchanges', date).catch(() => new Map())]);
  const SEN = await liveSEN(date).catch(() => new Map());
  const xbAgg = xbDeltaAgg(date); // recorded X-B Δ snapshots → interval-average + drift
  const bd = ['hu', 'bg', 'rs', 'ua', 'md'];
  const netComm = (x) => { if (!x) return null; let n = 0, any = false; for (const p of bd) { const eo = x['ro' + p], io = x[p + 'ro']; const e = eo ? rnum(eo.commercial) : null, i = io ? rnum(io.commercial) : null; if (e !== null) { n += e; any = true; } if (i !== null) { n -= i; any = true; } } return any ? n : null; };
  const arrow = (v) => (v === null ? '' : `${v >= 0 ? '↑' : '↓'}${Math.round(Math.abs(v))}`);
  const dlt = (v) => (v === null ? '' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${Math.round(v)}</span>`);
  let lastRealIsp = null;
  for (const { isp, ts } of dayTimestamps(date)) { const r = P.get(isp); if (new Date(ts).getTime() + 900000 <= nowMs && r && rnum(r.estimatedSystemImbalance) !== null) lastRealIsp = isp; }
  // LEFT: slim Predict-style table — clickable rows; current (now) + last-settled highlighted like PI live
  const leftRows = dayTimestamps(date).map(({ isp, ts }) => {
    const p = P.get(isp), x = X.get(isp), sen = SEN.get(isp);
    const imb = p ? rnum(p.estimatedSystemImbalance) : null;
    const price = p ? rnum(p.estimatedPricePositiveImbalance) : null;
    const epImb = (price !== null || !p) ? null : earlyPrice(imb, rnum(p.sumQup), rnum(p.sumQdn), rnum(p.sumQupPup), rnum(p.sumQdownPdn));
    const nxb = netComm(x);
    const rxb = sen ? -sen.sold : null;
    const xbd = rxb !== null && nxb !== null ? rxb - nxb : null;
    const tsMs = new Date(ts).getTime();
    const isCurrent = nowInfo.date === date && nowMs >= tsMs && nowMs < tsMs + 900000;
    const lastClass = price !== null && price < 0 ? 'lastneg' : 'lastpos';
    const cls = ((isCurrent ? 'now' : isp === lastRealIsp ? lastClass : '') + (ts === frameTs ? ' rowsel' : '')).trim();
    return `<tr class="${cls}" onclick="location='/pilearn?date=${date}&frame=${encodeURIComponent(ts)}'">
      <td><b>${isp}</b>${isCurrent ? ' ▶' : isp === lastRealIsp ? ' ●' : ''}</td><td>${cetLabel(isp)}</td>
      <td>${imb !== null ? dirIcon(imb > 0) : ''}</td>
      <td>${imb !== null ? Math.round(Math.abs(imb)) : ''}</td>
      <td>${price !== null ? Math.round(price) : (epImb !== null ? provPriceSpan(epImb) : '')}</td>
      <td>${arrow(nxb)}</td><td>${xbDeltaCell(xbAgg, isp) || dlt(xbd)}</td></tr>`;
  }).join('');
  // RIGHT: frame trajectory for the selected interval
  let frameHtml = '<div style="color:var(--fg-muted);font-size:13px;padding:8px">Click an interval on the left to see its X-B PI frames.</div>';
  if (frameTs) {
    let frames = [], realized = null;
    try { frames = db.prepare('SELECT pulled_at, d1, pi, lt, commercial FROM xb_pi_snap WHERE ts_utc=? ORDER BY pulled_at').all(frameTs); } catch {}
    try { const rr = db.prepare("SELECT value FROM series WHERE series='damas_est_sys_imbalance' AND ts_utc=?").get(frameTs); realized = rr ? rr.value : null; } catch {}
    // grid state at each frame's pull time: system imbalance + net commercial X-B of the interval being delivered then
    const imbMap = new Map(), sxNet = new Map();
    if (frames.length) {
      const fromIso = new Date(new Date(frames[0].pulled_at).getTime() - 3600000).toISOString();
      try { for (const r of db.prepare("SELECT ts_utc, value FROM series WHERE series='damas_est_sys_imbalance' AND ts_utc >= ?").all(fromIso)) imbMap.set(r.ts_utc, r.value); } catch {}
      try { const EXP = new Set(['damas_sx_rohu', 'damas_sx_robg', 'damas_sx_rors', 'damas_sx_roua', 'damas_sx_romd']); for (const r of db.prepare("SELECT ts_utc, series, value FROM series WHERE series LIKE 'damas_sx_%' AND ts_utc >= ?").all(fromIso)) sxNet.set(r.ts_utc, (sxNet.get(r.ts_utc) || 0) + (EXP.has(r.series) ? r.value : -r.value)); } catch {}
    }
    const gridTs = (pms) => new Date(Math.floor(pms / 900000) * 900000).toISOString().slice(0, 19) + '.000Z';
    const imbSorted = [...imbMap.entries()].map(([k, v]) => [Date.parse(k), v]).sort((a, b) => a[0] - b[0]);
    const sxSorted = [...sxNet.entries()].map(([k, v]) => [Date.parse(k), v]).sort((a, b) => a[0] - b[0]);
    const latestLE = (arr, t) => { let r = null; for (const e of arr) { if (e[0] <= t) r = e[1]; else break; } return r; }; // freshest value as-known at t (handles settlement lag)
    const cetClock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); // real pull time in CET
    let pPi = null;
    const fr = frames.map((f) => {
      const dpi = pPi == null ? '' : (f.pi - pPi >= 0 ? '+' : '') + Math.round(f.pi - pPi); pPi = f.pi;
      const T = new Date(f.pulled_at).getTime(), tg = gridTs(T);
      const gi = imbMap.has(tg) ? imbMap.get(tg) : latestLE(imbSorted, T);
      const gx = sxNet.has(tg) ? sxNet.get(tg) : latestLE(sxSorted, T);
      const ri = roDateIsp(new Date(f.pulled_at));
      return `<tr><td>${ri.isp}</td><td>${cetClock(f.pulled_at)}</td><td>${Math.round(f.d1)}</td><td><b>${Math.round(f.pi)}</b></td><td class="${dpi && +dpi >= 0 ? 'pos' : 'neg'}">${dpi}</td><td>${gi != null ? dirIcon(gi > 0) + ' ' + Math.round(Math.abs(gi)) : '—'}</td><td>${gx != null ? arrow(gx) : '—'}</td></tr>`;
    }).join('');
    frameHtml = `<h4 style="margin:0 0 6px">Interval ${frameTs.slice(0, 16).replace('T', ' ')}Z &middot; ${frames.length} frames${realized != null ? ` &middot; realized ${Math.round(realized)} MWh (${realized > 0 ? 'S' : 'D'})` : ' &middot; not settled'}</h4>
<table><tr><th>Int</th><th>CET</th><th>D-1</th><th>PI</th><th>ΔPI</th><th title="system imbalance of the interval being delivered when this PI change was recorded">Grid</th><th title="net commercial cross-border at that moment (↑ export, ↓ import)">X-B</th></tr>${fr || '<tr><td colspan="7" style="color:var(--fg-muted)">no frames yet</td></tr>'}</table>`;
  }
  // --- learning scoreboard (read-only): combo live (paper) score + pi_learn online learner. NEVER drives positions. ---
  let learnBanner = '';
  {
    let comboTxt = 'combo intraday (paper): warming up', plTxt = '';
    try {
      const ci = db.prepare("SELECT COUNT(*) n, AVG(model_correct)*100 acc, AVG(persist_correct)*100 pacc, SUM(pnl_ron) pnl, SUM(ABS(qty)) mwh FROM combo_pred WHERE kind='intraday' AND realized_imb IS NOT NULL").get();
      const pend = db.prepare("SELECT COUNT(*) n FROM combo_pred WHERE kind='intraday' AND realized_imb IS NULL").get();
      if (ci && ci.n) comboTxt = `combo intraday (paper): <b>${ci.acc.toFixed(1)}%</b> vs persist ${ci.pacc !== null ? ci.pacc.toFixed(1) : '—'}% · n=${ci.n}${ci.mwh ? ` · ${(ci.pnl / ci.mwh).toFixed(0)} RON/MWh` : ''}`;
      else if (pend && pend.n) comboTxt = `combo intraday (paper): warming up · ${pend.n} frozen, awaiting settlement`;
    } catch { /* combo_pred not present yet */ }
    try {
      const pl = db.prepare('SELECT n, model_ok, persist_ok FROM pi_learn_state').get();
      if (pl && pl.n) plTxt = ` &nbsp;·&nbsp; pi_learn online: <b>${(pl.model_ok / pl.n * 100).toFixed(1)}%</b> vs persist ${(pl.persist_ok / pl.n * 100).toFixed(1)}% · n=${pl.n}`;
    } catch { /* pi_learn_state not present yet */ }
    learnBanner = `<div style="margin:0 0 10px;padding:7px 11px;background:rgba(255,245,0,.08);border:1px solid rgba(128,128,128,.3);border-radius:6px;font-size:12px">📈 Learning signals — ${comboTxt}${plTxt}<span style="color:var(--fg-muted);margin-left:8px">· read-only, validating forward — not driving positions</span></div>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>PI learn</title>${STYLE}<style>.pl2{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}.pl-left{flex:0 0 auto}.pl-left tr{cursor:pointer}.pl-left tbody tr:hover td,.pl-left tr:hover td{background:rgba(255,245,0,.12)}.rowsel td{background:rgba(255,245,0,.28)!important}.pl-right{flex:1 1 340px;position:sticky;top:8px}</style></head><body>
${NAV('pilearn', date)}<div class="content">
${learnBanner}
<div class="pl2">
  <div class="pl-left"><table><tr><th>Int</th><th>CET</th><th>Type</th><th>Imb<br><small>MWh</small></th><th>Price<br><small>RON</small></th><th>Notif X-B<br><small>MW</small></th><th>X-B Δ<br><small>MW</small></th></tr>${leftRows}</table></div>
  <div class="pl-right">${frameHtml}</div>
</div></div>
<script>var s=document.querySelector('.rowsel')||document.querySelector('tr.now')||document.querySelector('tr.lastpos,tr.lastneg');if(s)s.scrollIntoView({block:'center'});</script>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const today = roDateIsp(new Date()).date;
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
    const json = (o) => send(200, 'application/json', JSON.stringify(o));

    // unauthenticated routes
    if (url.pathname === '/health') return json({ ok: true, ts: new Date().toISOString() });
    if (url.pathname === '/api/widget') {
      // key-authenticated summary for iOS lock/home-screen widgets (Scriptable can't do cookies)
      if (url.searchParams.get('key') !== WIDGET_KEY) return send(401, 'application/json', '{"error":"bad key"}');
      return json(widgetData());
    }
    if (url.pathname === '/manifest.json') {
      return send(200, 'application/manifest+json', JSON.stringify({
        name: 'GAN Trading', short_name: 'GAN', start_url: '/pi', display: 'standalone',
        background_color: '#FFFFFF', theme_color: '#FFF500',
        icons: [
          { src: '/icon-180.png', sizes: '180x180', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      }));
    }
    if (url.pathname === '/icon-180.png' || url.pathname === '/icon-512.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(fs.readFileSync(path.join(__dirname, 'assets', url.pathname.slice(1))));
    }
    if (url.pathname === '/login') {
      if (req.method === 'POST') {
        const { user, pass } = await readForm(req);
        if (USERS.get(user) === pass && pass) {
          res.writeHead(302, {
            'Set-Cookie': `sid=${signSession(user)}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${process.env.RENDER ? '; Secure' : ''}`,
            Location: '/pi',
          });
          return res.end();
        }
        return send(401, 'text/html', loginPage(true));
      }
      return send(200, 'text/html', loginPage(false));
    }
    if (url.pathname === '/logout') {
      res.writeHead(302, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0', Location: '/login' });
      return res.end();
    }

    // everything else requires a session (unless AUTH_ON is off — local dev)
    const user = cookieUser(req);
    if (!user) {
      if (url.pathname.startsWith('/api/')) return send(401, 'application/json', '{"error":"unauthenticated"}');
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    req.user = user || 'local';

    if (req.method === 'POST' && url.pathname === '/api/bet') {
      const { date, isp, qty } = await readBody(req);
      const cfg = loadConfig();
      const [h0, h1] = cfg.trade_window_cet;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isInteger(isp)) return json({ ok: false, error: 'bad input' });
      if (isLocked(date)) return json({ ok: false, error: 'locked (use Unlock first)' });
      if (isp < (h0 + 1) * 4 + 1 || isp > (h1 + 1) * 4 + 1) return json({ ok: false, error: 'outside trading window' });
      if (!Number.isFinite(qty) || Math.abs(qty) > cfg.max_mwh_per_isp) return json({ ok: false, error: `|qty| must be <= ${cfg.max_mwh_per_isp}` });
      const now = new Date().toISOString();
      db.prepare(`INSERT OR REPLACE INTO user_bets (date_ro, isp, qty, updated_at, source, user) VALUES (?,?,?,?,'manual',?)`).run(date, isp, qty, now, req.user);
      db.prepare('INSERT INTO user_bets_log (date_ro, isp, qty, saved_at, user) VALUES (?,?,?,?,?)').run(date, isp, qty, now, req.user);
      return json({ ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/unlock') {
      const { date } = await readBody(req);
      db.prepare('INSERT OR REPLACE INTO page_unlocks (date_ro, unlocked, updated_at, user) VALUES (?,1,?,?)').run(date, new Date().toISOString(), req.user);
      return json({ ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/lock') {
      const { date } = await readBody(req);
      db.prepare('INSERT OR REPLACE INTO page_unlocks (date_ro, unlocked, updated_at, user) VALUES (?,0,?,?)').run(date, new Date().toISOString(), req.user);
      return json({ ok: true });
    }
    if (url.pathname === '/api/realxb_now') {
      // Live Transelectrica "Sold" for the CURRENT interval only → Real X-B (= −sold), plus the interval's
      // Notif X-B so the client can colour the cell (green = Real over Notif = surplus; red = under = deficit).
      // 20s SEN cache (track closely without hammering the flaky host); scheduledExchanges via liveReport (15s).
      const qd = url.searchParams.get('date') || today;
      const ni = roDateIsp(new Date());
      const isp = ni.date === qd ? ni.isp : null;
      // Live from transelectrica's homepage feed (sen-filter, ~10s): SOLD (exchange balance, neg=export) and
      // PLAN (scheduled exchange). Notif X-B (net export) = −PLAN. All transelectrica, no DAMAS.
      const sf = await liveSenFilter().catch(() => null);
      const sold = sf ? sf.sold : null;
      const notifxb = sf && sf.plan !== null ? -sf.plan : null;
      // place the value in the interval its SCADA timestamp belongs to — lags the wall-clock interval by the feed
      // delay (~1 min), so early in a new interval it stays in the PREVIOUS row until the SCADA clock reaches it.
      const si = sf && sf.ts ? senFilter.tsInterval(sf.ts) : null;
      const soldIsp = (isp && si && si.date === qd) ? si.isp : isp; // null when not viewing today
      let avg = null, navg = 0;
      if (soldIsp) { const tw = intervalTWA(qd, soldIsp); avg = tw.avg; navg = tw.n; } // time-weighted by SCADA timestamps
      if (avg === null && sold !== null) avg = -sold; // seed with the live value so the average never blanks
      // live Notif X-B (DAMAS/PI commercial net export, freshest snapshot) so the client can refresh notif + Δ each poll
      let notifPi = null; if (soldIsp) { try { const r = db.prepare('SELECT commercial FROM xb_pi_snap WHERE date_ro=? AND isp=? AND commercial IS NOT NULL ORDER BY pulled_at DESC LIMIT 1').get(qd, soldIsp); if (r) notifPi = r.commercial; } catch { /* table may be absent */ } }
      return json({ isp, soldIsp, sold, realxb: sold !== null ? -sold : null, notifxb, notifPi, prod: sf ? sf.prod : null, cons: sf ? sf.cons : null, solar: sf ? sf.solar : null, wind: sf ? sf.wind : null, hydro: sf ? sf.hydro : null, nuclear: sf ? sf.nuclear : null, avg, navg, plan: sf ? sf.plan : null, ts: sf && sf.ts ? sf.ts : new Date().toISOString() });
    }
    if (url.pathname === '/api/pulse') {
      // LIVE system-state nowcast from the freshest SCADA (sen_live table → no extra source load): dev = sold − plan
      // (physical exchange vs plan) reads the settled imbalance at ~0.54 / 80% sign — import OVER plan → DEFICIT lean.
      // ~1-min fresh. Plus the latest settled imbalance as the anchor + a TURN flag when the live read disagrees with it.
      // Situational awareness + early-flip detection, NOT a 75-min forecast edge (validated: persistence still wins the anchor).
      // guard: drop rows whose ts_ms disagrees with our own record clock by >1 day — the feed occasionally flips
      // its date format (D/M/YY vs YY/M/DD) and one misparsed FUTURE row would freeze this endpoint forever.
      const recent = db.prepare("SELECT ts_ms, pulled_at, sold, plan FROM sen_live WHERE sold IS NOT NULL AND plan IS NOT NULL AND ts_ms IS NOT NULL AND ABS(ts_ms - (strftime('%s',pulled_at)*1000 + 10800000)) < 86400000 ORDER BY ts_ms DESC LIMIT 30").all();
      if (!recent.length) return json({ ok: false });
      const cur = recent[0], dev = cur.sold - cur.plan;       // ts_ms carries a +3h local-as-UTC offset (relative diffs ok); age uses pulled_at (true UTC)
      const older = recent.find((r) => r.ts_ms <= cur.ts_ms - 10 * 60000);
      const trend = older ? dev - (older.sold - older.plan) : null;       // rising dev = deficit deepening
      const im = db.prepare("SELECT ts_utc, value FROM series WHERE series='damas_est_sys_imbalance' AND value IS NOT NULL ORDER BY ts_utc DESC LIMIT 1").get();
      const anchor = im ? im.value : null;
      const scadaSign = Math.abs(dev) < 25 ? '' : (dev > 0 ? 'D' : 'S');   // dev>0 = importing over plan = deficit lean
      const anchorSign = anchor == null || Math.abs(anchor) < 10 ? '' : (anchor > 0 ? 'S' : 'D');
      return json({ ok: true, ageS: Math.max(0, Math.round((Date.now() - Date.parse(cur.pulled_at)) / 1000)), dev: Math.round(dev), trend: trend == null ? null : Math.round(trend), scadaSign, anchor: anchor == null ? null : Math.round(anchor), anchorSign, anchorAgeMin: im ? Math.round((Date.now() - Date.parse(im.ts_utc)) / 60000) : null, turn: !!(scadaSign && anchorSign && scadaSign !== anchorSign) });
    }
    if (url.pathname === '/api/xbpi') {
      // Full intraday history of the notified cross-border for one interval (the PI trades): every recorded frame
      // with its step Δ (sold = net export rose, bought = fell). Powers the ⓘ popup on the Notif cross border cell.
      const qd = url.searchParams.get('date') || today;
      const isp = +url.searchParams.get('isp');
      let frames = [];
      try { frames = db.prepare('SELECT pulled_at, ts_utc, d1, pi, lt, commercial FROM xb_pi_snap WHERE date_ro=? AND isp=? ORDER BY pulled_at').all(qd, isp); } catch { /* table missing */ }
      const cetClock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false });
      let prev = null;
      const out = frames.map((f) => { const deltaC = prev == null ? null : f.commercial - prev; prev = f.commercial; return { time: cetClock(f.pulled_at), commercial: f.commercial, pi: f.pi, deltaC, action: deltaC == null || Math.abs(deltaC) < 1 ? '' : (deltaC > 0 ? 'sold ' + Math.round(deltaC) : 'bought ' + Math.round(-deltaC)) }; });
      let realized = null;
      if (frames.length) { try { const r = db.prepare("SELECT value FROM series WHERE series='damas_est_sys_imbalance' AND ts_utc=?").get(frames[0].ts_utc); realized = r ? r.value : null; } catch { /* ignore */ } }
      let mm = (isp - 1) * 15 - 60; if (mm < 0) mm += 1440;
      return json({ isp, cet: `${pad(Math.floor(mm / 60))}:${pad(mm % 60)}`, frames: out, realized });
    }
    if (url.pathname === '/api/sign_score') {
      // today's locked-forecast scorecard: each settled interval's locked prediction vs the realized sign, the
      // running hit-rate, and the trailing MISS STREAK (the model "checking itself" — surfaces when it's off-trend
      // today so the forward calls can be discounted). Read-only; the forward probabilities already update each close.
      const qd = url.searchParams.get('date') || today;
      const locks = db.prepare('SELECT isp, sign, conf FROM sign_lock WHERE date_ro=? ORDER BY isp').all(qd);
      const imbStmt = db.prepare("SELECT value FROM series WHERE series='damas_est_sys_imbalance' AND date_ro=? AND isp=?");
      const rows = []; let hit = 0;
      for (const l of locks) { const im = imbStmt.get(qd, l.isp); if (!im || im.value == null) continue; const act = im.value > 0 ? 'S' : 'D'; const ok = act === l.sign; if (ok) hit++; rows.push({ isp: l.isp, pred: l.sign, conf: l.conf, act, ok }); }
      let streak = 0; for (let k = rows.length - 1; k >= 0; k--) { if (!rows[k].ok) streak++; else break; }
      return json({ n: rows.length, hit, pct: rows.length ? Math.round(hit / rows.length * 100) : null, streak, last: rows.slice(-6) });
    }
    if (url.pathname === '/api/res_score') {
      // E-vs-M-vs-actual RES scorecard: running MAE of ENTSO-E (E) and MY BASE model (M, no intraday peeking) against
      // gen_actual solar/wind, over the last RES_DAYS + today. Fair forecast-quality comparison (both pure forecasts).
      const resM = getResModel(); if (!resM) return json({ ok: false });
      const qd = url.searchParams.get('date') || today; const RES_DAYS = 4;
      const from = addDays(qd, -RES_DAYS) + 'T00:00:00Z', to = addDays(qd, 1) + 'T00:00:00Z';
      // fast: pre-materialized latest-run ensemble mean (weather_hourly), already deduped → agg holds {s:mean,n:1}
      const agg = {}; for (const r of db.prepare("SELECT ts_utc, var, value FROM weather_hourly WHERE var IN ('shortwave_radiation','wind_speed_100m') AND ts_utc>=? AND ts_utc<?").all(from, to)) agg[r.var + '|' + r.ts_utc] = { s: r.value, n: 1 };
      const hg = (series) => { const m = {}; for (const r of db.prepare('SELECT ts_utc,value FROM series WHERE series=? AND ts_utc>=? AND ts_utc<? AND value IS NOT NULL').all(series, from, to)) { const h = r.ts_utc.slice(0, 13); (m[h] || (m[h] = { s: 0, n: 0 })).s += r.value; m[h].n++; } const o = {}; for (const h in m) o[h] = m[h].s / m[h].n; return o; };
      const aS = hg('gen_actual_solar'), aW = hg('gen_actual_wind_onshore'), eS = hg('ws_fc_cur_solar'), eW = hg('ws_fc_cur_wind_onshore');
      const acc = { sol: { m: 0, e: 0, n: 0 }, win: { m: 0, e: 0, n: 0 }, tSol: { m: 0, e: 0, n: 0 }, tWin: { m: 0, e: 0, n: 0 } };
      for (const h in aS) { const rd = agg['shortwave_radiation|' + h + ':00:00Z']; if (!rd) continue; const mv = resModel.predictSolar(resM, rd.s / rd.n), a = aS[h], e = eS[h]; if (a == null || e == null || mv == null) continue; const td = h.slice(0, 10) === qd; acc.sol.m += Math.abs(mv - a); acc.sol.e += Math.abs(e - a); acc.sol.n++; if (td) { acc.tSol.m += Math.abs(mv - a); acc.tSol.e += Math.abs(e - a); acc.tSol.n++; } }
      for (const h in aW) { const wd = agg['wind_speed_100m|' + h + ':00:00Z']; if (!wd) continue; const mv = resModel.predictWind(resM, wd.s / wd.n), a = aW[h], e = eW[h]; if (a == null || e == null || mv == null) continue; const td = h.slice(0, 10) === qd; acc.win.m += Math.abs(mv - a); acc.win.e += Math.abs(e - a); acc.win.n++; if (td) { acc.tWin.m += Math.abs(mv - a); acc.tWin.e += Math.abs(e - a); acc.tWin.n++; } }
      const mae = (o) => (o.n ? { me: Math.round(o.m / o.n), entso: Math.round(o.e / o.n), n: o.n } : null);
      return json({ ok: true, days: RES_DAYS, solar: mae(acc.sol), wind: mae(acc.win), todaySolar: mae(acc.tSol), todayWind: mae(acc.tWin) });
    }
    if (url.pathname === '/api/predict_sign') {
      // live forecast of the surplus/deficit SIGN + confidence for each UPCOMING interval. Fuses persistence
      // (last settled imbalance) + time-of-day + the PI order-flow on that interval. Refreshes as new PI trades land.
      const qd = url.searchParams.get('date') || today;
      const model = getSignModel();
      const out = [];
      if (model) {
        const nowMs = Date.now();
        const ni = roDateIsp(new Date()); const curTs = dayTimestamps(ni.date).find((t) => t.isp === ni.isp);
        const gateMs = (curTs ? new Date(curTs.ts).getTime() : nowMs) + 75 * signModel.MIN; // first TRADEABLE start (current-ISP start + 75min)
        const reg = liveRegime(nowMs - signModel.PUB_LAG * signModel.MIN);
        const persist = reg ? reg.persist : null;
        if (persist !== null) {
          // batch: all PI frames + all Notif bal for the day up front (was 3 queries PER interval → a few total)
          const framesByIsp = new Map();
          try { for (const r of db.prepare('SELECT isp, pulled_at, commercial FROM xb_pi_snap WHERE date_ro=? ORDER BY isp, pulled_at').all(qd)) (framesByIsp.get(r.isp) || framesByIsp.set(r.isp, []).get(r.isp)).push({ p: Date.parse(r.pulled_at), c: r.commercial }); } catch { /* ignore */ }
          const nbMap = notifBalMapFor(qd);
          for (const { isp, ts } of dayTimestamps(qd)) {
            if (isp < signModel.WIN_FROM || isp > signModel.WIN_TO) continue;
            const Tms = new Date(ts).getTime(); const lead = (Tms - nowMs) / signModel.MIN;
            if (Tms < gateMs) continue;                     // TRADEABLE only (start ≥ gate = current ISP+5, incl. the current tradeable/gate row which stays LIVE); untradeable show their LOCKED forecast
            const frames = framesByIsp.get(isp) || [];
            const pi_move = frames.length >= 2 ? frames[frames.length - 1].c - frames[0].c : 0; // cumulative → model
            const burst = recentMove(frames, nowMs); const pa = Math.abs(burst); // recent burst → panic flag
            const p = signModel.prob(model, persist, pi_move, reg.fracsurp, reg.netting, nbMap.has(isp) ? nbMap.get(isp) : null, isp, lead);
            out.push({ isp, p: +p.toFixed(3), conf: Math.round(Math.max(p, 1 - p) * 100), sign: p >= 0.5 ? 'S' : 'D', panic: pa >= PANIC_MW ? { abs: Math.round(pa), dir: burst > 0 ? 'S' : 'D', opposes: (burst > 0 ? 'S' : 'D') !== (persist > 0 ? 'S' : 'D') } : null });
          }
        }
      }
      return json({ n: out.length, rows: out });
    }
    if (url.pathname === '/api/panics') {
      // logged big-PI-repositioning events for a day + the accumulating validation: when realized sign FLIPPED vs
      // persistence, how often did the PI move point the right way? (the desk's "panic flips the state" test)
      const qd = url.searchParams.get('date') || today;
      const rows = db.prepare('SELECT isp, pi_move, pi_abs, base_p, pi_dir, persist_dir, opposes, realized_dir FROM panic_log WHERE date_ro=? ORDER BY isp').all(qd);
      const scored = db.prepare('SELECT pi_dir, persist_dir, realized_dir FROM panic_log WHERE realized_dir IS NOT NULL').all();
      let flips = 0, piRightOnFlip = 0, confirms = 0, piOverall = 0;
      for (const s of scored) { if (s.pi_dir === s.realized_dir) piOverall++; if (s.realized_dir !== s.persist_dir) { flips++; if (s.pi_dir === s.realized_dir) piRightOnFlip++; } else confirms++; }
      return json({ date: qd, threshold_mw: PANIC_MW, rows, summary: { scored: scored.length, flips, pi_right_on_flip: piRightOnFlip, confirms, pi_overall_right: piOverall } });
    }
    if (url.pathname === '/api/histrows') {
      // the 2 historical rows (same interval, prev day + 2 days ago) for the per-row expand caret on the Predict page
      const qd = url.searchParams.get('date') || today;
      const isp = +url.searchParams.get('isp');
      const gate = url.searchParams.get('gate') === '1'; // gateopen row → keep the green trade-box styling on expand
      return send(200, 'text/html', histRowHtml(addDays(qd, -1), isp, '−1d', false, gate) + histRowHtml(addDays(qd, -2), isp, '−2d', true, gate));
    }
    if (url.pathname === '/api/pzu') return json(pzuData(url.searchParams.get('date') || addDays(today, 1)));
    if (url.pathname === '/pzu' || url.pathname === '/') return send(200, 'text/html', pzuPage(url.searchParams.get('date') || addDays(today, 1)));
    if (url.pathname === '/pi') return send(200, 'text/html', piPage(url.searchParams.get('date') || today));
    if (url.pathname === '/predict') return send(200, 'text/html', await predictPage(url.searchParams.get('date') || today));
    if (url.pathname === '/pilearn') return send(200, 'text/html', await piLearnPage(url.searchParams.get('date') || today, url.searchParams.get('frame')));
    send(404, 'text/plain', 'not found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('error: ' + e.message);
  }
});

const LISTEN_PORT = Number(process.env.PORT || PORT);
server.listen(LISTEN_PORT, '0.0.0.0', () => console.log(`trading UI listening on :${LISTEN_PORT}`));

if (process.env.ENABLE_JOBS === '1') {
  require('./scheduler').start();
} else {
  console.log('[jobs] disabled (set ENABLE_JOBS=1 to run data pulls + predictions in-process)');
}
