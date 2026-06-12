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

const PORT = 8077;
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
`);

function loadConfig() {
  const defaults = { eur_ron: 5.24, trade_window_cet: [7, 22], max_mwh_per_isp: 2.5, min_mwh_per_isp: 2.0, risk_aversion: 0.5 };
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

// column visibility picker; selection persists in localStorage per page
const colPicker = (key, mobileHidden) => `
<div class="colwrap r1"><button type="button" onclick="document.getElementById('colpanel').classList.toggle('open')">Columns ▾</button>
<div id="colpanel" class="colpanel"></div></div>
<script>window.addEventListener('DOMContentLoaded',function(){
  var key=${JSON.stringify(key)};
  var table=document.querySelector('.content table');
  if(!table)return;
  var head=[].map.call(table.rows[0].cells,function(c){return c.textContent.trim()});
  // device default: phones start with a slim column set until the user picks their own
  var saved=localStorage.getItem(key);
  var hidden=new Set(saved?JSON.parse(saved)
    :(window.matchMedia('(max-width:760px)').matches?${JSON.stringify(mobileHidden || [])}:[]));
  function apply(){
    for(var r=0;r<table.rows.length;r++){
      var row=table.rows[r];
      if(row.cells.length!==head.length)continue;
      for(var i=0;i<row.cells.length;i++)row.cells[i].style.display=hidden.has(i)?'none':'';
    }
  }
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
  const ispFrom = (h0 + 1) * 4 + 1, ispTo = (h1 + 1) * 4;
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
    return {
      isp, eet: ispLabel(isp), cet: cetLabel(isp),
      inWindow: isp >= ispFrom && isp <= ispTo,
      probLong: p?.prob_long ?? null, imbP50: p?.imb_p50 ?? null, priceP50: p?.price_p50 ?? null,
      priceP10: p?.price_p10 ?? null, priceP90: p?.price_p90 ?? null,
      adviceQty: a ? (a.dir === 'surplus' ? a.qty : -a.qty) : null,
      adviceEdge: a?.exp_edge ?? null,
      adviceReason: a?.reason ?? null,
      adviceTail: a?.tail_loss ?? null,
      adviceResult: a && a.qty > 0 ? a.realized_revenue : null,
      predPrice: p?.price_p50 ?? a?.exp_price ?? null,
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
    <a class="${active === 'perf' ? 'on' : ''}" href="/perf">Performance</a><span class="userchip"><a href="/logout" title="sign out">⎋</a></span>
  </div>
  <button class="menubtn r1" type="button" onclick="document.getElementById('mainmenu').classList.toggle('open');event.stopPropagation()">⋮</button>
  <div class="bbreak"></div>
  <div id="mainmenu" class="menu">
    <a class="${active === 'pzu' ? 'on' : ''}" href="/pzu">PZU positions</a>
    <a class="${active === 'pi' ? 'on' : ''}" href="/pi">PI live</a>
    <a class="${active === 'perf' ? 'on' : ''}" href="/perf">Performance</a>
    <div class="menusep"></div>
    <a href="#" onclick="var p=document.getElementById('colpanel');if(p)p.classList.toggle('open');document.getElementById('mainmenu').classList.remove('open');return false">Columns…</a>
    <div class="menusep"></div>
    <a href="/logout">Sign out</a>
  </div>
  <script>document.addEventListener('click',function(e){
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

// YellowGrid Design System (data/design/colors_and_type.css) — white 50 / yellow 20 / black 15 / gray 15;
// Nunito (Circular Std substitute) for headings/UI, Inter body, JetBrains Mono for readouts.
const STYLE = `<style>
@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;700&family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap');
:root{
  --yg-yellow:#FFF500;--yg-black:#121212;--yg-gray:#F6F6F6;
  --yg-gray-600:#8A8A8A;--yg-gray-400:#A4A4A4;--yg-gray-200:#ECECEC;
  --yg-yellow-highlight:#FFF59E;--yg-yellow-tint:#FFFCA8;
  --yg-success:#1F9E57;--yg-info:#2F6FE0;--yg-danger:#D93A30;
  --font-display:'Nunito',system-ui,sans-serif;--font-body:'Inter',system-ui,sans-serif;
  --font-mono:'JetBrains Mono',ui-monospace,monospace;
}
body{font:13px/1.5 var(--font-body);margin:0;background:#fff;color:var(--yg-black);-webkit-font-smoothing:antialiased}
.banner{position:sticky;top:0;z-index:50;background:rgba(255,255,255,0.92);backdrop-filter:blur(12px);
  border-bottom:1px solid var(--yg-gray-200);height:56px;padding:0 28px;display:flex;justify-content:space-between;align-items:center}
.banner h1{margin:0;font-family:var(--font-display);font-weight:700;font-size:20px;letter-spacing:-0.02em;color:var(--yg-black)}
.highlight{background-image:linear-gradient(95deg,var(--yg-yellow) 0%,var(--yg-yellow) 35%,rgba(255,245,0,0.7) 65%,rgba(255,245,0,0.25) 88%,rgba(255,245,0,0) 100%);
  background-repeat:no-repeat;background-size:100% 60%;background-position:0 80%;padding:0 0.18em 0 0.06em}
.nav{display:flex;align-items:center}
.nav a{font-family:var(--font-display);font-weight:500;color:var(--yg-black);text-decoration:none;margin-left:14px;
  font-size:14px;padding:8px 18px;border-radius:999px;transition:background 140ms cubic-bezier(0.16,1,0.3,1)}
.nav a:hover{background:var(--yg-gray)}
.nav a.on{background:var(--yg-yellow);color:var(--yg-black);font-weight:700}
.menubtn{display:none;font:700 18px var(--font-display);background:var(--yg-black);color:#fff;border:none;border-radius:999px;
  width:38px;height:38px;cursor:pointer;line-height:1;flex-shrink:0}
.menu{display:none;position:fixed;top:62px;right:12px;background:#fff;border:1px solid var(--yg-gray-400);
  border-radius:14px;box-shadow:0 20px 48px -12px rgba(18,18,18,0.2);min-width:210px;z-index:80;padding:8px}
.menu.open{display:block}
.menu a{display:block;font-family:var(--font-display);font-weight:500;font-size:14px;color:var(--yg-black);
  text-decoration:none;padding:11px 16px;border-radius:8px}
.menu a:hover{background:var(--yg-gray)}
.menu a.on{background:var(--yg-yellow);font-weight:700}
.menusep{height:1px;background:var(--yg-gray-200);margin:6px 8px}
.totalpill{font-family:var(--font-mono);font-weight:700;font-size:15px;padding:6px 16px;border-radius:999px}
.tp-pos{background:#dff2e6;color:var(--yg-success)}
.tp-neg{background:#fbe5e3;color:var(--yg-danger)}
.upd{display:flex;align-items:center}
#updsec{font:13px var(--font-mono);color:var(--yg-black);background:var(--yg-gray);border:1px solid var(--yg-gray-200);
  border-radius:999px;padding:4px 12px;min-width:62px;text-align:center}
.content{padding:18px 28px 48px}
.datebar{display:flex;gap:8px;align-items:center}
.datebar a{font-family:var(--font-display);font-weight:700;background:var(--yg-black);color:#fff;text-decoration:none;
  padding:5px 14px;border-radius:999px;font-size:13px}
.datebar a:hover{background:#2b2b2b}
.datebar input{font:12px var(--font-body);padding:5px 10px;border:1px solid var(--yg-gray-400);border-radius:10px}
.datebar input:focus{outline:none;border-color:var(--yg-yellow);box-shadow:0 0 0 3px rgba(255,245,0,0.35)}
table{width:100%;border-collapse:separate;border-spacing:0;margin:10px 0 26px;background:#fff;border:1px solid var(--yg-gray-400)}
td,th{border-right:1px solid var(--yg-gray-400);border-bottom:1px solid var(--yg-gray-200);padding:4px 10px;text-align:left;font-size:12px;font-variant-numeric:tabular-nums}
td:last-child,th:last-child{border-right:none}
th{position:sticky;top:56px;z-index:5;background:var(--yg-black);color:#fff;font-family:var(--font-display);
  font-weight:700;font-size:13px;letter-spacing:0.02em;padding:10px;border-color:var(--yg-black);
  border-bottom:2px solid var(--yg-yellow);white-space:nowrap}
tr:nth-child(even) td{background:var(--yg-gray)}
.surplus{color:var(--yg-info);font-weight:700}.deficit{color:var(--yg-danger);font-weight:700}.mid{color:var(--yg-gray-600)}
.hold{color:var(--yg-black);background:var(--yg-yellow-highlight);padding:1px 6px;border-radius:6px;font-weight:600;cursor:help}
tr.now td{background:var(--yg-yellow-tint) !important;border-top:2px solid var(--yg-black);border-bottom:2px solid var(--yg-black)}
tr.lastpos td{background:#c4e8d0 !important;border-top:2px solid var(--yg-success);border-bottom:2px solid var(--yg-success)}
tr.lastneg td{background:#f5cbc6 !important;border-top:2px solid var(--yg-danger);border-bottom:2px solid var(--yg-danger)}
.fc{color:var(--yg-gray-600);font-style:italic}
.fc-ok{color:var(--yg-success);font-style:italic}
.fc-bad{color:var(--yg-danger);font-style:italic}
.pill2{font:12px var(--font-mono);background:var(--yg-gray);border:1px solid var(--yg-gray-200);border-radius:999px;padding:5px 12px;color:var(--yg-black);white-space:nowrap}
.pill2 small{color:var(--yg-gray-600)}
.colwrap{display:flex;align-items:center;position:relative}
.colpanel{display:none;position:absolute;top:40px;right:0;background:#fff;border:1px solid var(--yg-gray-400);
  border-radius:10px;box-shadow:0 8px 24px rgba(18,18,18,0.12);padding:10px 16px;z-index:60;columns:2;min-width:380px}
.colpanel.open{display:block}
.colpanel label{display:block;font-size:12px;padding:3px 0;white-space:nowrap;cursor:pointer}
tr.winstart td{border-top:3px solid var(--yg-gray-600)}
tr.winend td{border-bottom:3px solid var(--yg-gray-600)}
.pos{color:var(--yg-success);font-weight:600}.neg{color:var(--yg-danger);font-weight:600}
tr.pnlpos td{background:#e9f7ee}tr.pnlneg td{background:#fdeceb}
.money{font-family:var(--font-mono);font-weight:500;line-height:1}
.badge{display:inline-block;font-family:var(--font-display);font-weight:700;font-size:10px;letter-spacing:0.04em;
  padding:2px 9px;border-radius:999px;vertical-align:middle}
/* badge color follows the POSITION (blue = surplus, red = deficit); the text follows the
   page's market: PZU page shows the PZU action, PI page the balancing action */
.badge.srp{background:#e3ecfb;color:var(--yg-info)}
.badge.dfc{background:#fbe5e3;color:var(--yg-danger)}
.badge.flip{cursor:pointer;user-select:none;min-width:34px;text-align:center}
.ic{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:999px;
  font:700 10px var(--font-display);color:#fff;vertical-align:middle;cursor:default}
.ic-s{background:var(--yg-success)}.ic-d{background:var(--yg-danger)}
input.bet{width:64px;font:13px var(--font-mono);padding:3px 8px;border:1px solid var(--yg-gray-400);border-radius:10px}
input.bet:focus{outline:none;border-color:var(--yg-yellow);box-shadow:0 0 0 3px rgba(255,245,0,0.35)}
input.bet.auto{background:var(--yg-yellow-highlight);border-color:var(--yg-yellow)}
input.bet:disabled{background:var(--yg-gray-200);color:var(--yg-gray-600);border-color:var(--yg-gray-200)}
.lockbanner{background:var(--yg-gray);border:1px solid var(--yg-gray-200);padding:12px 18px;margin:10px 0;border-radius:14px;font-size:12px}
button{font-family:var(--font-display);font-weight:700;font-size:12px;padding:7px 18px;cursor:pointer;
  background:var(--yg-yellow);color:var(--yg-black);border:none;border-radius:999px;transition:transform 140ms}
button:active{transform:scale(0.98)}
.meta{color:var(--yg-gray-600);font-size:11px;max-width:1100px}.dim td{opacity:0.5}
#status{font-size:11px;color:var(--yg-success);margin-left:10px;font-family:var(--font-mono)}
h2{margin:24px 0 6px;font-family:var(--font-display);font-weight:700;font-size:18px;letter-spacing:-0.01em;color:var(--yg-black)}
small{color:var(--yg-gray-600)}
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.userchip{font:11px var(--font-mono);color:var(--yg-gray-600);margin-left:10px}
.userchip a{color:var(--yg-gray-600)}
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
    <td>${r.adviceQty === null ? '<span class="mid">—</span>'
      : r.adviceQty === 0
        ? (r.adviceReason === 'costly if wrong'
          ? `<span class="hold" title="EV ${fmt(r.adviceEdge)} RON/MWh, but a wrong call risks ~${fmt(r.adviceTail)} RON/MWh">HOLD — costly if wrong</span>`
          : '<span class="mid">— low EV</span>')
        : `<span class="badge ${r.adviceQty > 0 ? 'srp' : 'dfc'}">${r.adviceQty > 0 ? 'BUY' : 'SELL'}</span> ${Math.abs(r.adviceQty).toFixed(1)} MWh <small>EV ${fmt(r.adviceEdge)} RON/MWh</small>`}</td>
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
    JOIN (SELECT ts_utc, MAX(run_at) mr FROM bets WHERE actionable=1 GROUP BY ts_utc) x
      ON x.ts_utc=b.ts_utc AND x.mr=b.run_at
    WHERE b.date_ro=? AND b.qty > 0`).get(date).s;
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
<table><tr><th>Interval</th><th>CET</th><th>Prediction</th><th title="predicted imbalance, MWh">Imbalance</th><th title="predicted imbalance price, RON/MWh">Price</th><th title="PZU price, RON/MWh">PZU</th><th title="MWh, PZU-side action">Advice</th><th title="MWh, PZU-side action">Your position</th><th title="realized imbalance price, RON/MWh">Realized</th><th title="RON">Model result</th><th title="RON">Result</th></tr>
${rows}
${anyResult || anyModel ? `<tr><td colspan="9" style="text-align:right"><b>Day total</b></td>
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
    JOIN (SELECT ts_utc, MAX(run_at) mr FROM predictions WHERE actionable=1 GROUP BY ts_utc) x
      ON x.ts_utc=p.ts_utc AND x.mr=p.run_at
    WHERE p.date_ro=?`).all(date).map((r) => [r.isp, r]));
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
    JOIN (SELECT ts_utc, MAX(run_at) mr FROM bets WHERE actionable=1 AND run_at<=? GROUP BY ts_utc) x
      ON x.ts_utc=b.ts_utc AND x.mr=b.run_at
    WHERE b.date_ro=?`).all(lockAt, date).map((r) => [r.isp, r.exp_price]));
  // last-resort: latest estimate issued before the interval started, even inside the freeze
  // window (non-binding — shown with an asterisk)
  const anyPred = new Map(db.prepare(`
    SELECT p.isp, p.prob_long, p.imb_p50, p.price_p50 FROM predictions p
    JOIN (SELECT ts_utc, MAX(run_at) mr FROM predictions WHERE run_at < ts_utc GROUP BY ts_utc) x
      ON x.ts_utc=p.ts_utc AND x.mr=p.run_at
    WHERE p.date_ro=?`).all(date).map((r) => [r.isp, r]));

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
  const winFrom = (wh0 + 1) * 4 + 1, winTo = (wh1 + 1) * 4;
  const nowInfo = roDateIsp(new Date());
  const nowMs = Date.now();
  // last interval already settled with real data (gets the green highlight)
  let lastRealIsp = null;
  for (const { isp, ts } of dayTimestamps(date)) {
    if (new Date(ts).getTime() + 900000 <= nowMs && sv('damas_est_sys_imbalance', ts) !== null) lastRealIsp = isp;
  }
  let cum = 0, settled = 0, committed = 0, hits = 0, judged = 0, lockHits = 0, lockJudged = 0;
  const body = dayTimestamps(date).map(({ isp, ts }) => {
    const tsMs = new Date(ts).getTime();
    const isCurrent = nowInfo.date === date && nowMs >= tsMs && nowMs < tsMs + 900000;
    const isPast = tsMs + 900000 <= nowMs;
    const p1 = d1.get(isp);
    const pl = live.get(isp) || piLocked.get(isp);
    const imb = sv('damas_est_sys_imbalance', ts);
    const imbPrice = sv('damas_est_price_pos', ts);
    const pzuOff = sv('pzu_ron', ts);
    const pzuRon = pzuOff !== null ? pzuOff : (sv('da_price', ts) !== null ? sv('da_price', ts) * cfg.eur_ron : null);
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
      const fc = sv('gen_fc_da', ts);
      if (fc !== null) { prodC = String(Math.round(fc)); prodTitle = 'DA generation forecast (total)'; }
    }
    if (isPast) {
      const dc = sv('damas_consumption', ts);
      const la = sv('load_actual', ts);
      consC = dc !== null ? String(Math.round(dc * 4)) : la !== null ? String(Math.round(la)) : '';
    } else {
      const lf = sv('load_fc_da', ts);
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
    const npda = sv('net_pos_da', ts);
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
    JOIN (SELECT ts_utc, MAX(run_at) mr FROM bets WHERE actionable=1 GROUP BY ts_utc) x
      ON x.ts_utc=b.ts_utc AND x.mr=b.run_at
    WHERE b.date_ro=? AND b.qty > 0`).get(date).s;
  const extras = `
    <span class="totalpill r2 ${cum >= 0 ? 'tp-pos' : 'tp-neg'}" title="realized day P&L">${Math.round(cum).toLocaleString('en-US')} RON</span>
    <span class="pill2 r2" title="model's expected day total at decision time"><small>exp</small> ${expTotal !== null ? Math.round(expTotal).toLocaleString('en-US') : '—'}</span>
    <span class="pill2 r2" title="locked prediction direction accuracy today"><small>acc</small> ${lockJudged ? Math.round(lockHits / lockJudged * 100) + '%' : '—'}</span>
    ${colPicker('cols-pi', [0, 5, 6, 7, 8])}`; // phone default: CET, Type, Qty, Price, position, P&L
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#FFF500"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="GAN Trading"><link rel="apple-touch-icon" href="/icon-180.png"><title>PI ${date}</title>${STYLE}</head><body>
${NAV('pi', date, { left: updLeft, period: 300 }, extras)}<div class="content">
<table><tr><th>Interval</th><th>CET</th><th>Type</th><th title="system imbalance, MWh">Qty</th><th title="imbalance price, RON/MWh">Price</th><th title="country generation [MW]; hover a value for the per-source split">Prod</th><th title="consumption [MW]">Cons</th><th title="net cross-border [MW]: ↑ export, ↓ import">X-B</th><th title="DA-coupling net position committed yesterday on PZU [MW]: ↑ export, ↓ import">PZU D−1</th><th title="your position [MWh], balancing-side action">My position</th><th title="RON">P&amp;L</th></tr>
${body}</table></div>
<script>window.addEventListener('DOMContentLoaded',function(){
  var n=document.querySelector('tr.now')||document.querySelector('tr.lastpos,tr.lastneg');
  if(n)setTimeout(function(){n.scrollIntoView({block:'center'})},50);
});</script>
</body></html>`;
}

function perfPage() {
  const week = db.prepare(`
    SELECT date_ro, COUNT(*) n,
      AVG(CASE WHEN (prob_long>0.5)=(realized_imb>0) THEN 1.0 ELSE 0 END) acc,
      AVG(ABS(price_p50-realized_price)) mae
    FROM predictions p
    JOIN (SELECT ts_utc, MAX(run_at) mr FROM predictions WHERE actionable=1 GROUP BY ts_utc) x
      ON x.ts_utc=p.ts_utc AND x.mr=p.run_at
    WHERE realized_imb IS NOT NULL GROUP BY date_ro ORDER BY date_ro DESC LIMIT 14`).all();
  const userDays = db.prepare(`
    SELECT ub.date_ro, SUM(ub.qty) mwh, COUNT(*) n
    FROM user_bets ub WHERE ub.qty != 0 GROUP BY ub.date_ro ORDER BY ub.date_ro DESC LIMIT 14`).all();
  const model = JSON.parse(fs.readFileSync(path.join(__dirname, 'model.json'), 'utf8'));
  const fmtPct = (v) => (v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#FFF500"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="GAN Trading"><link rel="apple-touch-icon" href="/icon-180.png"><title>Performance</title>${STYLE}</head><body>
${NAV('perf', '')}<div class="content">
<h2>Model — ${model.version} (trained ${model.trainedAt?.slice(0, 10)})</h2>
<p class="meta">Holdout: short ${fmtPct(model.eval?.short?.accuracy)} (conf+big ${fmtPct(model.eval?.short?.confidentBigAcc)}) · long ${fmtPct(model.eval?.long?.accuracy)} (conf+big ${fmtPct(model.eval?.long?.confidentBigAcc)})</p>
<h2>Locked predictions by day</h2>
<table><tr><th>Date</th><th>Scored intervals</th><th>Sign accuracy</th><th>Price MAE [RON/MWh]</th></tr>
${week.map((r) => `<tr><td>${euDate(r.date_ro)}</td><td>${r.n}</td><td>${fmtPct(r.acc)}</td><td>${r.mae !== null ? Math.round(r.mae) : '—'}</td></tr>`).join('')}</table>
<h2>Your positions by day</h2>
<table><tr><th>Date</th><th>Intervals</th><th>Net volume [MWh]</th><th>Open PZU page</th></tr>
${userDays.map((r) => `<tr><td>${euDate(r.date_ro)}</td><td>${r.n}</td><td>${r.mwh.toFixed(1)}</td><td><a href="/pzu?date=${r.date_ro}">view</a></td></tr>`).join('') || '<tr><td colspan="4">none yet</td></tr>'}</table>
</div></body></html>`;
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
<input name="user" placeholder="user" autocomplete="username" style="font:inherit;padding:10px 14px;border:1px solid var(--yg-gray-400);border-radius:10px">
<input name="pass" type="password" placeholder="password" autocomplete="current-password" style="font:inherit;padding:10px 14px;border:1px solid var(--yg-gray-400);border-radius:10px">
<button type="submit" style="padding:12px">Sign in</button>
</form></div></body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const today = roDateIsp(new Date()).date;
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
    const json = (o) => send(200, 'application/json', JSON.stringify(o));

    // unauthenticated routes
    if (url.pathname === '/health') return json({ ok: true, ts: new Date().toISOString() });
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

    // everything else requires a session
    const user = cookieUser(req);
    if (!user) {
      if (url.pathname.startsWith('/api/')) return send(401, 'application/json', '{"error":"unauthenticated"}');
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    req.user = user;

    if (req.method === 'POST' && url.pathname === '/api/bet') {
      const { date, isp, qty } = await readBody(req);
      const cfg = loadConfig();
      const [h0, h1] = cfg.trade_window_cet;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isInteger(isp)) return json({ ok: false, error: 'bad input' });
      if (isLocked(date)) return json({ ok: false, error: 'locked (use Unlock first)' });
      if (isp < (h0 + 1) * 4 + 1 || isp > (h1 + 1) * 4) return json({ ok: false, error: 'outside trading window' });
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
    if (url.pathname === '/api/pzu') return json(pzuData(url.searchParams.get('date') || addDays(today, 1)));
    if (url.pathname === '/pzu' || url.pathname === '/') return send(200, 'text/html', pzuPage(url.searchParams.get('date') || addDays(today, 1)));
    if (url.pathname === '/pi') return send(200, 'text/html', piPage(url.searchParams.get('date') || today));
    if (url.pathname === '/perf') return send(200, 'text/html', perfPage());
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
