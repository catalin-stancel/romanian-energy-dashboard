// Weather→RES-generation model (a challenger to ENTSO-E's A69 forecast). Fit on the weather↔gen_actual overlap:
//   solar ≈ slope · shortwave_radiation     (through origin: 0 radiation → 0 PV)
//   wind  ≈ cubic(wind_speed_100m)           (least-squares, clipped to [0, cap])
// Weather inputs = ensemble mean (4 RO points × models), latest run per hour — same read for fit (past) and forecast (future).
// In-sample MAE (2026-06, ~19-day overlap): solar 246 vs ENTSO-E 250; wind 136 vs 128 — competitive. Refit hourly.
function hourlyWeather(db, varName) {
  const rows = db.prepare('SELECT ts_utc, pulled_at, value FROM weather WHERE var=? AND value IS NOT NULL').all(varName);
  const latest = new Map(); for (const r of rows) { const e = latest.get(r.ts_utc); if (!e || r.pulled_at > e) latest.set(r.ts_utc, r.pulled_at); }
  const agg = new Map(); for (const r of rows) { if (r.pulled_at !== latest.get(r.ts_utc)) continue; const h = r.ts_utc.slice(0, 13); const e = agg.get(h) || { s: 0, n: 0 }; e.s += r.value; e.n++; agg.set(h, e); }
  const m = new Map(); for (const [h, e] of agg) m.set(h, e.s / e.n); return m;
}
function hourlyGen(db, series) {
  const rows = db.prepare('SELECT ts_utc, value FROM series WHERE series=? AND value IS NOT NULL').all(series);
  const m = new Map(); for (const r of rows) { const h = r.ts_utc.slice(0, 13); const e = m.get(h) || { s: 0, n: 0 }; e.s += r.value; e.n++; m.set(h, e); }
  const o = new Map(); for (const [h, e] of m) o.set(h, e.s / e.n); return o;
}
function lsqFit(X, Y) { const d = X[0].length; const A = Array.from({ length: d }, () => new Array(d).fill(0)); const b = new Array(d).fill(0); for (let r = 0; r < X.length; r++) for (let i = 0; i < d; i++) { b[i] += X[r][i] * Y[r]; for (let j = 0; j < d; j++) A[i][j] += X[r][i] * X[r][j]; } return solve(A, b); }
function solve(A, b) { const n = A.length; for (let i = 0; i < n; i++) { let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k; [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]]; for (let k = i + 1; k < n; k++) { const f = A[k][i] / A[i][i]; for (let j = i; j < n; j++) A[k][j] -= f * A[i][j]; b[k] -= f * b[i]; } } const x = new Array(n).fill(0); for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j]; x[i] = s / A[i][i]; } return x; }

function train(db) {
  const rad = hourlyWeather(db, 'shortwave_radiation'), ws = hourlyWeather(db, 'wind_speed_100m');
  const solA = hourlyGen(db, 'gen_actual_solar'), winA = hourlyGen(db, 'gen_actual_wind_onshore');
  // solar: least-squares LINEAR+intercept (a + b·r) fit on the RECENT window only — recent days run hotter than the
  // 19-day mean (capacity/seasonal drift), so a recent fit tracks current output better. Night-clamped (rad<10 → 0).
  const SOLAR_DAYS = 14;
  const maxDate = [...rad.keys()].reduce((a, b) => (b > a ? b : a), '').slice(0, 10);
  const cutoff = maxDate ? new Date(Date.parse(maxDate + 'T00:00:00Z') - SOLAR_DAYS * 86400000).toISOString().slice(0, 10) : '0000';
  const SX = [], SY = []; let nS = 0;
  for (const [h, r] of rad) { if (h.slice(0, 10) < cutoff) continue; const g = solA.get(h); if (g == null) continue; SX.push([1, r]); SY.push(g); nS++; }
  const solarCoef = nS >= 8 ? lsqFit(SX, SY) : [0, 0];
  const X = [], Y = []; let winCap = 0;
  for (const [h, w] of ws) { const g = winA.get(h); if (g == null) continue; X.push([1, w, w * w, w * w * w]); Y.push(g); if (g > winCap) winCap = g; }
  const AT = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], bt = [0, 0, 0, 0];
  for (let r = 0; r < X.length; r++) for (let i = 0; i < 4; i++) { bt[i] += X[r][i] * Y[r]; for (let j = 0; j < 4; j++) AT[i][j] += X[r][i] * X[r][j]; }
  const windCoef = X.length >= 8 ? solve(AT, bt) : [0, 0, 0, 0];
  if (nS < 20 && X.length < 20) throw new Error(`res_model: thin overlap (solar n=${nS}, wind n=${X.length})`);
  return { solarCoef, windCoef, winCap: winCap * 1.15, nSolar: nS, nWind: X.length, trainedAt: Date.now() };
}
const predictSolar = (m, rad) => { if (rad == null) return null; if (rad < 10) return 0; const c = m.solarCoef; return Math.max(0, c[0] + c[1] * rad); };
const predictWind = (m, ws) => { if (ws == null) return null; const c = m.windCoef; const v = c[0] + c[1] * ws + c[2] * ws * ws + c[3] * ws * ws * ws; return Math.max(0, Math.min(m.winCap || 4000, v)); };

module.exports = { train, predictSolar, predictWind, hourlyWeather };
