// 0–2 h SOLAR FORECAST — "smart persistence": take the live measured/inferred solar (which already embeds the CURRENT
// cloud state), assume that cloud state persists, and evolve ONLY the deterministic clear-sky geometry forward. Backtested
// (solar_fc_backtest.js, Jul 2026) as the winner: −55%/−56% RMSE vs naive persistence at +1h/+2h (−68%/−77% on the sunset
// ramp), and BETTER than feeding a satellite/NWP cloud forecast (summer cloud is persistent → cloud forecasts add noise).
// forecast(t+h) = solar_now × Σ(cap·clearsky(t+h)) / Σ(cap·clearsky(now)), computed per channel (utility & prosumer).
const { csFactor } = require('./solar_now');

// validated smart-persistence RMSE on the metered fleet (MW), by horizon (min) — from solar_fc_backtest.js, all-daytime.
const RMSE = { 15: 60, 30: 90, 45: 125, 60: 159, 90: 220, 120: 280 };
function band(mins) { const k = [15, 30, 45, 60, 90, 120]; let lo = 15; for (const x of k) if (x <= mins) lo = x; return RMSE[lo] || 280; }

function solarForecast(nowRes, cells, horizons, nowDate) {
  if (!nowRes || !nowRes.ok || !nowRes.daylight) return { ok: false };
  const now = nowDate || new Date();
  const csSums = (mins) => { const d = new Date(now.getTime() + mins * 60000); let u = 0, p = 0; for (const c of cells) { const f = csFactor(c.lat, c.lon, d); u += (c.solar_util || 0) * f; p += (c.solar_pros || 0) * f; } return { u, p }; };
  const base = csSums(0);
  const utilNow = nowRes.utility, prosNow = nowRes.prosumer;
  const steps = horizons.map((h) => {
    const s = csSums(h);
    const utility = base.u > 0 ? utilNow * s.u / base.u : 0;
    const prosumer = base.p > 0 ? prosNow * s.p / base.p : 0;
    const total = utility + prosumer;
    return { mins: h, at: new Date(now.getTime() + h * 60000).toISOString(), utility: Math.round(utility), prosumer: Math.round(prosumer), total: Math.round(total), rmse: band(h) };
  });
  return { ok: true, method: 'clear-sky persistence', base: { utility: utilNow, prosumer: prosNow, total: utilNow + prosNow }, horizons: steps };
}
module.exports = { solarForecast };
