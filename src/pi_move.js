// PI MOVE column (2026-11-02): a 0.25 MWh position taken on the market, NOT with the battery.
// Rule (user's model): in the FINAL 5 MINUTES of interval t the mFRR activation of t is already visible in DAMAS
// (activatedBalancingEnergyOverview). If mFRR up > 200 MW → BUY 0.25 MWh for t+1 on PI and stay long: the imbalance settles at
// the deficit price. If mFRR down > 200 MW → SELL 0.25 MWh for t+1 and stay short: the short settles at the surplus price.
// No network charges, no round-trip loss, no state of charge involved — it only needs the settled price to beat the PI price.
// Replay 1 Sep–2 Nov 2026 (PI price proxied by PZU, DAMAS gaps excluded): 658 calls, 89–93% wins, +105k RON on 0.25 MWh
// (avg +160 RON/call); once mFRR-up has been >200 MW for one interval it continues 91% of the time. The PZU proxy flatters
// the BUY side (PI rises in a deficit streak) — swap in real PI prices when they are integrated.
// The DAMAS puller runs every 5 min, which can miss the 5-minute window, so the logger fetches the report DIRECTLY every minute
// once the window opens (5 small requests per interval). Never from a request handler: the page reads the memo + the log.
const { roDateIsp } = require('./db');

const BASE = 'https://newmarkets.transelectrica.ro/usy-durom-publicreportg01/00121002500000000000000000000100/publicReport/';
const THR = 200;      // MW of mFRR activation in the interval (DAMAS publishes MWh per 15 min → ×4)
const SIZE = 0.25;    // MWh per interval
const WINDOW_MIN = 10; // decision window opens at minute 10 of the interval (final 5 minutes)
// PI PRICE LIMITS (user 2026-11-02, applied by hand until PI prices are integrated): BUY only if PI ≤ 1.25× PZU — the deficit price in
// these intervals settles at a median 1.40× PZU, so 1.5× would lose (37% win); SELL only if PI ≥ 0.5× PZU — surplus settles at a
// median −0.15× PZU, 92% win at that floor.
const BUY_CAP = 1.25, SELL_FLOOR = 0.5;
const piLimit = (action, pzu) => pzu == null ? null : action === 'BUY' ? BUY_CAP * pzu : action === 'SELL' ? SELL_FLOOR * pzu : null;

function ensureTable(db) {
  db.exec('CREATE TABLE IF NOT EXISTS pi_move(date_ro TEXT NOT NULL, isp INTEGER NOT NULL, at TEXT NOT NULL, action TEXT NOT NULL, mfrr_up REAL, mfrr_dn REAL, afrr_up REAL, afrr_dn REAL, pzu REAL, reasons TEXT, PRIMARY KEY(date_ro, isp, at))');
}

const r0 = (v) => Math.round(v);
// Decision from the mFRR activation (MW) of the interval that is ending.
function decide(mU, mD) {
  const why = [];
  if (mU == null && mD == null) return { action: 'HOLD', reasons: ['no activation data for the ending interval yet'] };
  if (mU > THR && mU >= mD) { why.push(`mFRR up ${r0(mU)} MW activated in the ending interval (> ${THR} MW) → BUY ${SIZE} MWh on PI for the trade interval (75 min ahead), stay long: settles at the deficit price`); return { action: 'BUY', reasons: why }; }
  if (mD > THR) { why.push(`mFRR down ${r0(mD)} MW activated in the ending interval (> ${THR} MW) → SELL ${SIZE} MWh on PI for the trade interval (75 min ahead), stay short: settles at the surplus price`); return { action: 'SELL', reasons: why }; }
  why.push(`mFRR up ${r0(mU || 0)} / down ${r0(mD || 0)} MW in the ending interval — under ${THR} MW, no position`);
  return { action: 'HOLD', reasons: why };
}

// memo of the latest direct fetch: { date, isp, mU, mD, aU, aD, at }
let live = null;
async function fetchLive(date, isp, tsIso) {
  const from = new Date(tsIso), to = new Date(from.getTime() + 900000);
  const url = new URL(BASE + 'activatedBalancingEnergyOverview');
  url.searchParams.set('timeInterval', JSON.stringify({ from: from.toISOString(), to: to.toISOString() }));
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`DAMAS activatedBalancingEnergyOverview ${r.status}`);
  const items = (await r.json()).itemList || [];
  const it = items.find((x) => x.timeInterval && x.timeInterval.from && new Date(x.timeInterval.from).getTime() === from.getTime()) || items[0];
  const num = (v) => { const n = Number(v); return v !== null && v !== undefined && Number.isFinite(n) ? n : null; };
  const mU = it ? num(it.mFRR_Up) : null, mD = it ? num(it.mFRR_Down) : null, aU = it ? num(it.aFRR_Up) : null, aD = it ? num(it.aFRR_Down) : null;
  live = { date, isp, mU: mU == null ? null : 4 * mU, mD: mD == null ? null : 4 * mD, aU: aU == null ? null : 4 * aU, aD: aD == null ? null : 4 * aD, at: Date.now() };
  return live;
}

// Target of the decision made during (date, isp): the TRADE interval = the first one still tradeable on PI (per-contract gate
// closure = delivery start − 1h → start ≥ current start + 75 min = current + 5), the page's highlighted "trade now" row. The
// position cannot be placed on t+1 (its contract closed an hour ago). Replay Sep–Nov at this lag: 654 calls, 74–80% won,
// +65k RON on 0.25 MWh (vs +105k if t+1 were tradeable); the sign still holds 77–80% of the time 75 min later.
const TRADE_AHEAD = 5;
function target(dayTimestamps, date, isp) {
  const row = dayTimestamps(date)[isp - 1]; if (!row) return null;
  const start = new Date(row.ts).getTime();
  const t = roDateIsp(new Date(start + TRADE_AHEAD * 900000));
  return { ...t, startMs: start, minIn: Math.floor((Date.now() - start) / 60000) };
}

// 60-s logger (NOT from a request handler). In the final 5 minutes of the running interval: fetch its mFRR activation, decide
// for the trade interval (75 min ahead), log it (one row per minute, the last one is the record).
async function logDue(db, dayTimestamps) {
  const ni = roDateIsp(new Date());
  const tg = target(dayTimestamps, ni.date, ni.isp); if (!tg || tg.minIn < WINDOW_MIN) return null;
  const row = dayTimestamps(ni.date)[ni.isp - 1];
  const lv = await fetchLive(ni.date, ni.isp, row.ts);
  const d = decide(lv.mU, lv.mD);
  const pz = db.prepare("SELECT value FROM series WHERE date_ro=? AND isp=? AND series='pzu_ron'").get(tg.date, tg.isp);
  const at = new Date().toISOString().slice(0, 16) + 'Z';
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR REPLACE INTO pi_move(date_ro, isp, at, action, mfrr_up, mfrr_dn, afrr_up, afrr_dn, pzu, reasons) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(tg.date, tg.isp, at, d.action, lv.mU, lv.mD, lv.aU, lv.aD, pz ? pz.value : null, d.reasons.join(' | '));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { target: tg, action: d.action };
}

// Page data for one date: last logged decision per interval + the live window state.
function pageData(db, date, dayTimestamps) {
  const out = { log: new Map(), window: null, THR, SIZE, WINDOW_MIN };
  try { for (const r of db.prepare('SELECT isp, at, action, mfrr_up, mfrr_dn, pzu, reasons FROM pi_move WHERE date_ro=? ORDER BY at').all(date)) out.log.set(r.isp, r); } catch { /* table missing */ }
  const ni = roDateIsp(new Date());
  const tg = target(dayTimestamps, ni.date, ni.isp);
  if (tg) out.window = { date: ni.date, isp: ni.isp, minIn: tg.minIn, open: tg.minIn >= WINDOW_MIN, trade: { date: tg.date, isp: tg.isp }, live: live && live.date === ni.date && live.isp === ni.isp ? live : null };
  return out;
}

// Settled result of a logged position: + = money made. price = settled imbalance price, pzu = the PI proxy recorded at decision time.
function pnl(action, price, pzu) {
  if (price == null || pzu == null) return null;
  if (action === 'BUY') return SIZE * (price - pzu);
  if (action === 'SELL') return SIZE * (pzu - price);
  return null;
}

module.exports = { ensureTable, decide, logDue, pageData, pnl, piLimit, THR, SIZE, WINDOW_MIN, BUY_CAP, SELL_FLOOR, TRADE_AHEAD };
