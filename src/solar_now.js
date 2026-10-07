// REAL-TIME solar nowcast (Phase 1). Total solar = utility (MEASURED, SEN "FOTO", ~1-min) + prosumer (INFERRED).
// The metered utility fleet is a live national pyranometer:
//   Kt (cloud index) = FOTO / clear-sky utility ceiling
//   prosumer_now = FOTO × (prosumer clear-sky-weighted capacity) / (utility clear-sky-weighted capacity)
// → the performance-ratio and the absolute cloud level CANCEL in the prosumer estimate (robust). v1 uses ONE national
// Kt (same sky nationwide); per-region cloud from weather is Phase 2. Clear-sky = Haurwitz(solar elevation), exact.
const PR = 0.92;         // effective clear-sky multiplier — CALIBRATED 2026-07-28 vs FOTO history (slope of satellite-predicted
                         // vs measured, R²≈0.82 over Jul 13-27; backtest_solar.js). Drives the ceiling/Kt DISPLAY + the satellite
                         // cross-check; CANCELS out of the FOTO-anchored prosumer/total estimate.
const UTIL_FULL = 3145;  // ANRE total metered utility solar that SEN FOTO represents (the geocoded map is a ~2.3 GW subset)

// clear-sky GHI fraction (0..~0.95) at a point/time — solar elevation (approx, no equation-of-time) → Haurwitz
function csFactor(lat, lon, d) {
  const n = Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
  const decl = 0.409105 * Math.sin(2 * Math.PI * (284 + n) / 365);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const H = ((h + lon / 15) - 12) * 15 * Math.PI / 180;
  const la = lat * Math.PI / 180;
  const sinElev = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(H);
  if (sinElev <= 0.01) return 0;
  return 1098 * sinElev * Math.exp(-0.057 / sinElev) / 1000;
}

// nearest cloud-field point → local clear-sky index kt = 1 − cloud (0=overcast … 1=clear). null if no field.
function localKt(lat, lon, pts) {
  if (!pts || !pts.length) return null;
  let bi = -1, bd = 1e9;
  for (let i = 0; i < pts.length; i++) { const dx = lat - pts[i].lat, dy = lon - pts[i].lon, d = dx * dx + dy * dy; if (d < bd) { bd = d; bi = i; } }
  return Math.max(0, Math.min(1, 1 - pts[bi].cloud));
}

// Real-time total-solar nowcast. Utility is MEASURED (FOTO). Prosumer is inferred by scaling FOTO by the prosumer/utility
// clear-sky-capacity ratio — now weighted by each cell's LOCAL satellite cloud (kt) so a front over the west vs a clear
// south is captured (v1 used one national sky). PR & the absolute cloud level cancel; the surviving term is the RELATIVE
// south-vs-west cloud pattern, anchored to live FOTO. Falls back to the flat (clear-sky-only) ratio when no cloud field.
// cloudField = the /api/clouds payload {points:[{lat,lon,cloud}], obs} (pass null to force flat).
function solarNow(db, cells, cloudField) {
  let foto = null;
  try { foto = db.prepare('SELECT solar, pulled_at FROM sen_live WHERE solar IS NOT NULL ORDER BY ts_ms DESC LIMIT 1').get(); } catch { /* no table */ }
  if (!foto) return { ok: false };
  const now = new Date();
  const pts = (cloudField && cloudField.points) || [];
  const haveClouds = pts.length > 0;
  let utilCs = 0, prosCs = 0, placedUtil = 0, utilCsKt = 0, prosCsKt = 0;
  for (const c of cells) {
    const cs = csFactor(c.lat, c.lon, now); const u = c.solar_util || 0, p = c.solar_pros || 0;
    utilCs += u * cs; prosCs += p * cs; placedUtil += u;
    if (haveClouds) { const k = localKt(c.lat, c.lon, pts); const kk = k == null ? 1 : k; utilCsKt += u * cs * kk; prosCsKt += p * cs * kk; }
  }
  const scale = placedUtil > 0 ? UTIL_FULL / placedUtil : 1;
  const utilCsFull = utilCs * scale, utilCsKtFull = utilCsKt * scale; // scale placed subset → full metered fleet
  const utilCeiling = utilCsFull * PR, prosCeiling = prosCs * PR;
  const daylight = utilCs > 0.5;
  const kt = daylight && utilCeiling > 5 ? +(foto.solar / utilCeiling).toFixed(2) : null; // MEASURED national kt (FOTO/ceiling)
  // prosumer: FOTO-anchored; spatial cloud-weighted ratio (falls back to flat clear-sky ratio without a cloud field)
  // divide by the FULL-fleet clear-sky sum (FOTO = full 3145 MW fleet output, not just the placed subset)
  const prosumerFlat = daylight && utilCsFull > 0 ? foto.solar * prosCs / utilCsFull : 0;
  const prosumerSpatial = haveClouds && daylight && utilCsKtFull > 0 ? foto.solar * prosCsKt / utilCsKtFull : prosumerFlat;
  // live satellite cross-check (independent of FOTO): satellite-predicted utility vs measured FOTO → agreement (0..1)
  const ktSatUtil = haveClouds && utilCs > 0 ? +(utilCsKt / utilCs).toFixed(2) : null; // sat mean kt over utility (south)
  const ktSatPros = haveClouds && prosCs > 0 ? +(prosCsKt / prosCs).toFixed(2) : null; // sat mean kt over prosumer (BUC+west)
  const satPredUtil = haveClouds ? Math.round(PR * utilCsKtFull) : null;
  const satAgree = satPredUtil != null && foto.solar > 50 ? +(Math.min(satPredUtil, foto.solar) / Math.max(satPredUtil, foto.solar)).toFixed(2) : null;
  const ageS = Math.max(0, Math.round((Date.now() - Date.parse(foto.pulled_at)) / 1000));
  return {
    ok: true, ageS, daylight, haveClouds, obs: (cloudField && cloudField.obs) || null,
    utility: Math.round(foto.solar), prosumer: Math.round(prosumerSpatial), total: Math.round(foto.solar + prosumerSpatial),
    prosumerFlat: Math.round(prosumerFlat), spatialDelta: Math.round(prosumerSpatial - prosumerFlat), // cloud-reweighting effect (MW)
    utilityCeiling: Math.round(utilCeiling), prosumerCeiling: Math.round(prosCeiling), totalCeiling: Math.round(utilCeiling + prosCeiling),
    kt, ktSatUtil, ktSatPros, satPredUtil, satAgree,
  };
}
module.exports = { solarNow, csFactor };
