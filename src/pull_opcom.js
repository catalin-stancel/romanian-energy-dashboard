// Pull official OPCOM PZU prices (ROPEX_DAM_15min, RON/MWh) into market.db as series 'pzu_ron'.
//
//   node tool\pull_opcom.js backfill 2026-02-01 2026-06-13
//   node tool\pull_opcom.js update          (today + tomorrow; schedule every 30 min)
//   node tool\pull_opcom.js aligncheck      (compare EET vs CET interval alignment vs ENTSO-E)
//
// Source: https://www.opcom.ro/grafice-ip-raportPIP-si-volumTranzactionat/ro (Laravel form,
// CSRF token + session cookie, POST trading_for=DD/MM/YYYY). Interval alignment: see aligncheck —
// verified 2026-06-11: OPCOM intervals are CET-day based (interval 1 starts 00:00 CET = 01:00 EET),
// i.e. OPCOM interval i maps to our EET ISP i+4, with i=93..96 spilling into the next EET day.
const { openDb, makeUpserter, roDateIsp } = require('./db');

const URL_ = 'https://www.opcom.ro/grafice-ip-raportPIP-si-volumTranzactionat/ro';
const UA = { 'User-Agent': 'Mozilla/5.0' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSession() {
  const r = await fetch(URL_, { headers: UA });
  const html = await r.text();
  const cookies = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const token = /name="_token" value="([^"]+)"/.exec(html)?.[1];
  if (!token) throw new Error('no CSRF token');
  return { cookies, token };
}

function parsePrices(html) {
  const seg = html.slice(html.indexOf('id="rez15min"'), html.indexOf('id="rez30min"'));
  const out = new Map();
  for (const m of seg.matchAll(/<tr>\s*<td[^>]*>Romania<\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(-?[\d.,]+)<\/td>/g)) {
    const isp = Number(m[1]);
    const price = Number(m[2].replace(/\./g, '').replace(',', '.'));
    if (Number.isFinite(price)) out.set(isp, price);
  }
  return out;
}

async function fetchDay(session, dateStr) {
  const [y, mo, d] = dateStr.split('-');
  const body = new URLSearchParams({
    _token: session.token, trading_for: `${d}/${mo}/${y}`, action: 'trading_for', limba: 'ro', buton: 'Refresh',
  });
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: session.cookies },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`OPCOM ${r.status}`);
  return parsePrices(await r.text());
}

// UTC ts of OPCOM (CET-day) interval start: 00:00 CET on dateStr + (i-1)*15min.
// 00:00 CET = 01:00 EET, and EET midnight is found DST-safely via roDateIsp.
function eetMidnightUtc(dateStr) {
  const base = new Date(dateStr + 'T00:00:00Z').getTime();
  for (const off of [3, 2]) {
    const cand = new Date(base - off * 3600000);
    if (roDateIsp(cand).date === dateStr && roDateIsp(cand).isp === 1) return cand.getTime();
  }
  return base - 2 * 3600000;
}
function tsForOpcomInterval(dateStr, i) {
  const t = eetMidnightUtc(dateStr) + 3600000 + (i - 1) * 900000; // +1h: CET day starts at 01:00 EET
  return new Date(t).toISOString().slice(0, 19) + '.000Z';
}

async function main() {
  const [mode, a1, a2] = process.argv.slice(2);
  const db = openDb();
  const session = await getSession();

  if (mode === 'aligncheck') {
    const day = a1 || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const prices = await fetchDay(session, day);
    const daEur = new Map(db.prepare(`SELECT isp, value FROM series WHERE series='da_price' AND date_ro=?`).all(day).map((r) => [r.isp, r.value]));
    let dEet = 0, dCet = 0, n = 0;
    for (const [isp, ron] of prices) {
      const eet = daEur.get(isp), cet = daEur.get(isp + 4); // CET day start = EET isp 5
      if (eet === undefined || cet === undefined) continue;
      dEet += Math.abs(ron / Math.max(1, eet) - 5);
      dCet += Math.abs(ron / Math.max(1, cet) - 5);
      n++;
    }
    console.log(`${day}: n=${n} | mean |ratio-5| if EET-aligned: ${(dEet / n).toFixed(3)} | if CET-aligned (shift+4): ${(dCet / n).toFixed(3)}`);
    console.log('lower = correct alignment (ratio should be a stable FX rate ~5.0)');
    return;
  }

  let dates = [];
  if (mode === 'backfill') {
    for (let t = new Date(a1 + 'T12:00:00Z'); t <= new Date(a2 + 'T12:00:00Z'); t = new Date(t.getTime() + 86400000)) {
      dates.push(t.toISOString().slice(0, 10));
    }
  } else if (mode === 'update') {
    const today = roDateIsp(new Date()).date;
    dates = [today, new Date(new Date(today).getTime() + 86400000).toISOString().slice(0, 10)];
  } else {
    console.error('Usage: pull_opcom.js backfill <from> <to> | update | aligncheck [date]');
    process.exit(1);
  }

  const upsert = makeUpserter(db);
  let total = 0;
  for (const day of dates) {
    try {
      const prices = await fetchDay(session, day);
      db.exec('BEGIN');
      for (const [i, ron] of prices) {
        upsert('pzu_ron', tsForOpcomInterval(day, i), ron);
        total++;
      }
      db.exec('COMMIT');
      console.log(`${day}: ${prices.size} prices`);
    } catch (e) {
      console.warn(`${day}: FAILED ${e.message.slice(0, 120)}`);
    }
    await sleep(700);
  }
  db.prepare('INSERT INTO pull_log VALUES (?,?,?,?,?,?)')
    .run('opcom:pzu_ron', `${mode} ${dates[0]}..${dates[dates.length - 1]}`, new Date().toISOString(), new Date().toISOString(), total, null);
  console.log(`total ${total} points`);
}

main().catch((e) => { console.error(e); process.exit(1); });
