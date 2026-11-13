'use strict';
// BATTERY SALE (user 2026-11-12): "after 3 successful charges and no discharges you start selling 0.2 or 0.3 and when time comes you
// honor the sale or not depending if surplus is maintained".
//   PLACE   : while the live interval is a CHARGE (so: under scheduled mFRR down) and the stock holds >= 3 successful charges with no
//             discharge since, sell on PI for the TRADE interval (first still tradeable, 75 min ahead = live + 5). One sale per trade
//             interval, placed once (the first minute the condition holds) and never withdrawn. Size 0.2 MWh on a stock of 3-4
//             charges, 0.3 MWh from 5. Open (undelivered) sales never exceed the stock: every sale is backed by a charge.
//   STOCK   : successful charges counted backwards from the live interval over the last 12 hours, stopping at the first DISCHARGE
//             call or HONOURED sale (both empty the count). A charge is successful when its interval settled below PZU; an interval
//             whose price is not published yet counts provisionally (it was under mFRR down, 88% settle in surplus). HOLD intervals
//             neither add nor reset.
//   DELIVER : when the trade interval becomes the live one - surplus maintained (live read of the Battery column: score <= -1, or a
//             pre-activation deviation >= +40 MW) -> RIDE: do not discharge, the short settles at the surplus price and the stock is
//             kept. Flat or deficit -> HONOUR: discharge the sold quantity, no short imbalance at a deficit price.
//   PRICE   : min sell price = max(0.5 x PZU of the trade interval, cost of the stored energy) where cost = (charge basis + network)
//             / efficiency from battery_action (no configuration). Applied by hand until PI prices are integrated.
// Replay 1 Sep - 12 Nov 2026 on settled data (scratchpad sale_replay2.js; PI proxied by PZU, which flatters): 930 sales, 87% won,
// 58% ridden / 42% honoured; ride +716 RON/MWh avg (85% won), honour +572 RON/MWh avg (90% won); +172k RON at PZU, +71k RON at the
// min sell price; the ride/honour switch beats always-ride (+83k) and always-honour (+128k). Worst ride -1,566 RON (an overshoot).
// Writes only from the 60-s logger, never from a request handler.
const { roDateIsp } = require('./db');
const batteryAction = require('./battery_action');

const MIN_CHARGES = 3, BIG_STOCK = 5, SIZE_S = 0.2, SIZE_L = 0.3, TRADE_AHEAD = 5, SELL_FLOOR = 0.5, LOOKBACK = 48;
const r0 = (v) => Math.round(v);

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS bat_sale (
    date_ro TEXT NOT NULL, isp INTEGER NOT NULL, ts_utc TEXT NOT NULL, placed_at TEXT NOT NULL, placed_date TEXT, placed_isp INTEGER,
    size REAL, stock INTEGER, stock_prov INTEGER, pzu REAL, cost REAL, limit_price REAL, reasons TEXT,
    delivery TEXT, delivery_at TEXT, delivery_reasons TEXT,
    PRIMARY KEY (date_ro, isp)
  ); CREATE INDEX IF NOT EXISTS ix_bat_sale_ts ON bat_sale(ts_utc);`);
}

const startMs = (dayTimestamps, date, isp) => { const row = dayTimestamps(date)[isp - 1]; return row ? new Date(row.ts).getTime() : null; };

// Successful charges in stock as seen from the live interval (date, isp); the live interval itself is not counted (not finished).
function stock(db, dayTimestamps, date, isp) {
  const out = { n: 0, prov: 0, failed: 0, stop: null };
  const t0 = startMs(dayTimestamps, date, isp); if (t0 == null) return out;
  const dates = [...new Set([date, roDateIsp(new Date(t0 - LOOKBACK * 900000)).date])];
  const ph = dates.map(() => '?').join(',');
  const act = new Map(), price = new Map(), pzu = new Map(), hon = new Set();
  try {
    for (const r of db.prepare(`SELECT b.date_ro d, b.isp, b.action FROM bat_action b JOIN (SELECT date_ro, isp, MAX(at) at FROM bat_action WHERE target='cur' AND date_ro IN (${ph}) GROUP BY date_ro, isp) l ON l.date_ro=b.date_ro AND l.isp=b.isp AND l.at=b.at WHERE b.target='cur'`).all(...dates)) act.set(r.d + '|' + r.isp, r.action);
    for (const r of db.prepare(`SELECT p.date_ro d, p.isp, p.value FROM series p LEFT JOIN series u ON u.series='damas_qup' AND u.date_ro=p.date_ro AND u.isp=p.isp LEFT JOIN series q ON q.series='damas_qdn' AND q.date_ro=p.date_ro AND q.isp=p.isp WHERE p.series='damas_est_price_pos' AND p.date_ro IN (${ph}) AND NOT (COALESCE(u.value,1)=0 AND COALESCE(q.value,1)=0)`).all(...dates)) price.set(r.d + '|' + r.isp, r.value);
    for (const r of db.prepare(`SELECT date_ro d, isp, value FROM series WHERE series='pzu_ron' AND date_ro IN (${ph})`).all(...dates)) pzu.set(r.d + '|' + r.isp, r.value);
  } catch { return out; }
  try { for (const r of db.prepare(`SELECT date_ro d, isp FROM bat_sale WHERE delivery='HONOUR' AND date_ro IN (${ph})`).all(...dates)) hon.add(r.d + '|' + r.isp); } catch { /* no sales yet */ }
  for (let k = 1; k <= LOOKBACK; k++) {
    const di = roDateIsp(new Date(t0 - k * 900000)), key = di.date + '|' + di.isp, a = act.get(key);
    if (hon.has(key)) { out.stop = `honoured sale at ${di.date} isp ${di.isp}`; break; }
    if (a === 'DISCHARGE') { out.stop = `discharge at ${di.date} isp ${di.isp}`; break; }
    if (a !== 'CHARGE') continue;
    const p = price.get(key), z = pzu.get(key);
    if (p == null || z == null) { out.n++; out.prov++; } else if (p < z) out.n++; else out.failed++;
  }
  return out;
}

// HONOUR or RIDE from the live Battery decision of the delivery interval (same sign read as the PI move honour marker).
function delivery(d, forNext) {
  const dv = d.dev, when = forNext ? 'next interval' : 'this interval';
  const sign = d.score >= 1 ? 'deficit' : d.score <= -1 ? 'surplus' : dv != null && dv <= -40 ? 'deficit' : dv != null && dv >= 40 ? 'surplus' : 'flat';
  const read = `live read ${when}: ${sign}${dv != null ? ' (' + (dv >= 0 ? '+' : '') + r0(dv) + ' MW pre-activation)' : ''}, battery score ${d.score >= 0 ? '+' : ''}${d.score}${d.mDn > 0 ? ', mFRR down ' + r0(d.mDn) + ' MW scheduled' : ', no mFRR down scheduled'}`;
  if (sign === 'surplus') return { delivery: 'RIDE', sign, reasons: `RIDE: surplus maintained - do not discharge, the short settles at the surplus price and the stock is kept · ${read}` };
  return { delivery: 'HONOUR', sign, reasons: `HONOUR: surplus not maintained (${sign}) - discharge the sold quantity so there is no short imbalance at a deficit price · ${read}` };
}

// 60-s logger step, called right after batteryAction.logDue with the decisions it logged (pd.cur / pd.next).
function logDue(db, dayTimestamps, date, pd) {
  if (!pd || !pd.cur) return null;
  const cur = pd.cur, at = new Date().toISOString().slice(0, 16) + 'Z', res = { placed: null, delivery: null };
  const t0 = startMs(dayTimestamps, date, cur.isp); if (t0 == null) return null;
  const writes = [];
  // DELIVER: the sale whose trade interval is now live
  const due = db.prepare('SELECT size FROM bat_sale WHERE date_ro=? AND isp=?').get(date, cur.isp);
  if (due) {
    const dl = delivery(cur.d, false); res.delivery = { isp: cur.isp, ...dl };
    writes.push(() => db.prepare('UPDATE bat_sale SET delivery=?, delivery_at=?, delivery_reasons=? WHERE date_ro=? AND isp=?').run(dl.delivery, at, dl.reasons, date, cur.isp));
  }
  // PLACE: sell for the trade interval while charging on a stock of >= 3 successful charges
  if (cur.d.action === 'CHARGE') {
    const tgMs = t0 + TRADE_AHEAD * 900000, tg = roDateIsp(new Date(tgMs));
    const has = db.prepare('SELECT 1 FROM bat_sale WHERE date_ro=? AND isp=?').get(tg.date, tg.isp);
    if (!has) {
      const st = stock(db, dayTimestamps, date, cur.isp);
      const open = db.prepare('SELECT COUNT(*) n FROM bat_sale WHERE ts_utc>?').get(new Date(t0).toISOString()).n; // trade interval still ahead of the live one
      if (st.n >= MIN_CHARGES && open < st.n) {
        const pz = db.prepare("SELECT value FROM series WHERE date_ro=? AND isp=? AND series='pzu_ron'").get(tg.date, tg.isp);
        const pzu = pz ? pz.value : null, basis = cur.f.econ ? cur.f.econ.basis : null;
        const cost = basis == null ? null : (basis + batteryAction.NET_T) / batteryAction.ETA;
        const limit = pzu == null ? cost : Math.max(SELL_FLOOR * pzu, cost == null ? 0 : cost);
        const size = st.n >= BIG_STOCK ? SIZE_L : SIZE_S;
        const why = `SELL ${size} MWh on PI for the trade interval (75 min ahead): charging under ${r0(cur.d.mDn || 0)} MW mFRR down, stock ${st.n} successful charge${st.n === 1 ? '' : 's'}${st.prov ? ' (' + st.prov + ' not yet settled)' : ''} with no discharge since${st.stop ? ' the ' + st.stop : ''}, ${open} open sale${open === 1 ? '' : 's'} · size ${SIZE_S} on a stock of ${MIN_CHARGES}-${BIG_STOCK - 1}, ${SIZE_L} from ${BIG_STOCK} · min sell price ${limit == null ? 'n/a' : r0(limit)} = max(${SELL_FLOOR} x PZU ${pzu == null ? 'n/a' : r0(pzu)}, stored-energy cost ${cost == null ? 'n/a' : r0(cost)} = (charge basis ${basis == null ? 'n/a' : r0(basis)} + ${batteryAction.NET_T} network) / ${batteryAction.ETA})`;
        res.placed = { date: tg.date, isp: tg.isp, size, stock: st.n };
        writes.push(() => db.prepare('INSERT OR IGNORE INTO bat_sale(date_ro, isp, ts_utc, placed_at, placed_date, placed_isp, size, stock, stock_prov, pzu, cost, limit_price, reasons) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(tg.date, tg.isp, new Date(tgMs).toISOString(), at, date, cur.isp, size, st.n, st.prov, pzu, cost, limit, why));
      }
    }
  }
  if (writes.length) { db.exec('BEGIN IMMEDIATE'); try { for (const w of writes) w(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
  return res;
}

// Page data for one date: the sales by trade interval + the live stock (read-only).
function pageData(db, dayTimestamps, date, nowInfo, liveIsp) {
  const out = { log: new Map(), stock: null, MIN_CHARGES, BIG_STOCK, SIZE_S, SIZE_L };
  try { for (const r of db.prepare('SELECT * FROM bat_sale WHERE date_ro=?').all(date)) out.log.set(r.isp, r); } catch { /* table missing */ }
  if (nowInfo && nowInfo.date === date && liveIsp > 0) { try { out.stock = stock(db, dayTimestamps, date, liveIsp); } catch { /* ignore */ } }
  return out;
}

// Settled result. RIDE: RON/MWh kept vs the min sell price (limit - settled price; + = the short paid less than the sale earned even
// at the worst acceptable price). HONOUR: right when the settled price was above the stored-energy cost (riding would have cost more).
function score(row, price) {
  if (!row || price == null) return null;
  if (row.delivery === 'RIDE') return row.limit_price == null ? null : { kind: 'RIDE', delta: row.limit_price - price, ok: row.limit_price - price >= 0 };
  if (row.delivery === 'HONOUR') return row.cost == null ? null : { kind: 'HONOUR', delta: price - row.cost, ok: price >= row.cost };
  return null;
}

module.exports = { ensureTable, stock, delivery, logDue, pageData, score, MIN_CHARGES, BIG_STOCK, SIZE_S, SIZE_L, TRADE_AHEAD, SELL_FLOOR };
