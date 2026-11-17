'use strict';
// COMMON HYDRO CHANGE marker for the Predict time column (user 2026-11-17: "a small indicator next to time to show
// what is a common hydro change").
// Research on the stored feed, 19 Jun - 17 Nov 2026 (146 days, 11,833 intervals; step = hydro level in minutes 5-10 of
// the interval minus the same window of the previous interval, so a ramp across the boundary counts once):
//   79% of intervals move less than 50 MW; a step of 100 MW or more happens 9 times a day, 32% of hour boundaries
//   against 4% of the other quarter boundaries. Hydro repeats the same clock times: up 05:00-07:00 and 15:00-17:00 CET,
//   down 08:00-10:00 and 21:00-00:00 CET (the hours shift with the season, so the profile is rolling).
//   Rule: same day type (weekday / weekend), last 14 weekdays or 8 weekend days with data, a step of 100 MW or more in
//   one direction on at least half of them. Walk-forward (each day scored on the days before it): 711 markers, 5.6 a day;
//   hydro then moved 100 MW or more that way 66% of the time (80% when the share is 70% or more), 50 MW or more 83%.
//   Today's day-ahead dispatchable plan decides the rest: plan shows the step -> 71%; plan flat -> 27% (50% on the 70%
//   slots, and 83% for a move of 50 MW or more); plan opposite -> 15%, the plan wins.
//   Half of all steps of 150 MW or more fall outside these slots: the marker covers the routine, not the surprises.
// Read-only, computed once per viewed date from history strictly before it, cached in memory.

const TH = 100;        // MW: a step counts from here
const SHARE = 0.5;     // marker from this share of the look-back days
const STRONG = 0.7;
const N_WD = 14, N_WE = 8, MIN_DAYS = 5, LOOKBACK_DAYS = 45;
const isWe = (d) => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w === 0 || w === 6; };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };

// pure: levels Map(q -> MW) with q = quarter index of the Romanian wall clock (ts_ms / 900000), plan Map('date|isp' -> MW)
function buildProfile(levels, plan, date) {
  const dayQ0 = Math.floor(Date.parse(date + 'T00:00:00Z') / 900000);
  const we = isWe(date);
  const days = []; // look-back days of the same type, most recent first
  for (let k = 1; k <= LOOKBACK_DAYS; k++) { const d = new Date(Date.parse(date + 'T00:00:00Z') - k * 864e5).toISOString().slice(0, 10); if (isWe(d) === we) days.push({ d, q0: dayQ0 - k * 96 }); }
  const need = we ? N_WE : N_WD;
  const out = new Map();
  for (let isp = 1; isp <= 96; isp++) {
    const hs = [];
    for (const { d, q0 } of days) {
      if (hs.length >= need) break;
      const a = levels.get(q0 + isp - 1), b = levels.get(q0 + isp - 2);
      if (a == null || b == null) continue;
      const pa = plan.get(d + '|' + isp), pb = isp > 1 ? plan.get(d + '|' + (isp - 1)) : plan.get(new Date(Date.parse(d + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10) + '|96');
      hs.push({ step: a - b, plan: pa != null && pb != null ? pa - pb : null });
    }
    if (hs.length < MIN_DAYS) continue;
    const up = hs.filter((o) => o.step >= TH), dn = hs.filter((o) => o.step <= -TH);
    const dir = up.length / hs.length >= SHARE ? 1 : dn.length / hs.length >= SHARE ? -1 : 0;
    if (!dir) continue;
    const hit = dir > 0 ? up : dn, wp = hit.filter((o) => o.plan != null);
    out.set(isp, { dir, k: hit.length, n: hs.length, share: hit.length / hs.length, strong: hit.length / hs.length >= STRONG, med: Math.round(med(hit.map((o) => o.step))), planK: wp.filter((o) => o.plan * dir >= 50).length, planN: wp.length, we });
  }
  return out;
}

let cache = { date: null, at: 0, m: new Map() };
function profile(db, date) {
  if (cache.date === date && Date.now() - cache.at < 6 * 3600000) return cache.m;
  let m = new Map();
  try {
    const t1 = Date.parse(date + 'T00:00:00Z'), t0 = t1 - (LOOKBACK_DAYS + 1) * 864e5;
    const levels = new Map();
    // minutes 5-10 of each interval on the feed clock; rows whose feed time disagrees with our own clock by over a day are dropped
    for (const r of db.prepare("SELECT ts_ms/900000 q, AVG(hydro) h, COUNT(*) n FROM sen_live WHERE ts_ms >= ? AND ts_ms < ? AND hydro IS NOT NULL AND (ts_ms/60000)%15 BETWEEN 5 AND 10 AND ABS(ts_ms - (strftime('%s',pulled_at)*1000 + 10800000)) < 86400000 GROUP BY q").all(t0, t1)) if (r.n >= 2) levels.set(r.q, r.h);
    const d0 = new Date(t0).toISOString().slice(0, 10);
    const S = (name) => new Map(db.prepare('SELECT date_ro d, isp, value v FROM series WHERE series=? AND date_ro>=? AND date_ro<? AND value IS NOT NULL').all(name, d0, date).map((r) => [r.d + '|' + r.isp, r.v]));
    const np = S('damas_notif_prod'), so = S('ws_fc_da_solar'), wi = S('ws_fc_da_wind_onshore');
    const plan = new Map(); for (const [k, v] of np) if (so.has(k) && wi.has(k)) plan.set(k, v - so.get(k) - wi.get(k));
    m = buildProfile(levels, plan, date);
  } catch { /* history unavailable: no markers */ }
  cache = { date, at: Date.now(), m };
  return m;
}

// HTML for the time cell. planStep = today's dispatchable-plan step for this interval (Notif prod - solar/wind D-1), or null.
function mark(p, planStep) {
  if (!p) return '';
  const agrees = planStep != null && planStep * p.dir >= 50, opposite = planStep != null && planStep * p.dir <= -50;
  if (opposite) return ''; // the plan steps the other way and hydro follows the plan (15% of such markers held)
  const word = p.dir > 0 ? 'rises' : 'falls', sgn = p.med > 0 ? '+' : '';
  const planTxt = planStep == null ? 'Today’s plan step is not available.'
    : agrees ? `Today’s day-ahead plan shows it too (${planStep > 0 ? '+' : ''}${Math.round(planStep)} MW): hydro follows 7 times in 10${p.strong ? ', 8 in 10 on a slot this regular' : ''}.`
      : `Today’s day-ahead plan is flat here (${planStep > 0 ? '+' : ''}${Math.round(planStep)} MW): without the plan the full step came 1 time in 4${p.strong ? ' (1 in 2 on a slot this regular)' : ''}; a smaller move of 50 MW or more came ${p.strong ? '8 times in 10' : 'about half the time'}.`;
  const tip = `Common hydro change: hydro ${word} at this time on ${p.k} of the last ${p.n} ${p.we ? 'weekend days' : 'weekdays'}, typically ${sgn}${p.med} MW.${p.planN ? ` The day-ahead plan showed it on ${p.planK} of those ${p.planN} days.` : ''} ${planTxt}`;
  return ` <small class="hyc${p.strong ? '' : ' hycw'}${agrees || planStep == null ? '' : ' hycq'}" title="${tip}">${p.dir > 0 ? '▲' : '▼'}${Math.abs(p.med)}${agrees || planStep == null ? '' : '?'}</small>`;
}

module.exports = { profile, mark, buildProfile };
