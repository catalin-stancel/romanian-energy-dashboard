// Live satellite CLOUD field for the map overlay (and the Phase-2 per-region cloud input).
// Source: Open-Meteo satellite radiation (EUMETSAT-derived GHI, near-real-time). Per grid point:
//   cloud = clamp(1 − GHI_satellite / clear-sky_GHI, 0..1)   (0 = clear, 1 = overcast)
// Sampled on a ~0.4° grid clipped to Romania, server-cached ≤15 min so Open-Meteo is hit rarely.
const fs = require('fs');
const { csFactor } = require('./solar_now');
const STEP = 0.4;
const BBOX = { latMin: 43.6, latMax: 48.3, lonMin: 20.2, lonMax: 29.8 };

let borders = null;
function pip(lon, lat, rings) { let inside = false; for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]; if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside; } return inside; }
function inRO(lon, lat) { if (!borders) { try { borders = JSON.parse(fs.readFileSync(__dirname + '/ro_borders.json', 'utf8')); } catch { borders = []; } } for (const f of borders) if (pip(lon, lat, f.rings)) return true; return false; }
function samplePoints() { const p = []; for (let la = BBOX.latMin; la <= BBOX.latMax; la += STEP) for (let lo = BBOX.lonMin; lo <= BBOX.lonMax; lo += STEP) if (inRO(lo, la)) p.push({ lat: +la.toFixed(3), lon: +lo.toFixed(3) }); return p; }

let cache = { at: 0, data: null };
async function getClouds() {
  if (cache.data && Date.now() - cache.at < 15 * 60000) return cache.data;
  const pts = samplePoints();
  const out = []; let obsTs = null;
  for (let i = 0; i < pts.length; i += 100) {
    const ch = pts.slice(i, i + 100);
    const url = 'https://satellite-api.open-meteo.com/v1/archive?latitude=' + ch.map((p) => p.lat).join(',') + '&longitude=' + ch.map((p) => p.lon).join(',') + '&hourly=shortwave_radiation&models=satellite_radiation_seamless&past_days=1&forecast_days=1&timezone=UTC';
    let arr;
    try { const j = await (await fetch(url)).json(); arr = Array.isArray(j) ? j : [j]; } catch { continue; }
    const nowMs = Date.now();
    arr.forEach((loc, k) => {
      const p = ch[k]; if (!loc || !loc.hourly) return;
      const t = loc.hourly.time, v = loc.hourly.shortwave_radiation; let idx = -1;
      for (let m = 0; m < t.length; m++) if (Date.parse(t[m] + ':00Z') <= nowMs && v[m] != null) idx = m; // latest observed hour ≤ now
      if (idx < 0) return;
      const cs = csFactor(p.lat, p.lon, new Date(t[idx] + ':00Z')) * 1000;
      if (cs < 40) return; // night — no cloud value
      out.push({ lat: p.lat, lon: p.lon, cloud: +Math.max(0, Math.min(1, 1 - v[idx] / cs)).toFixed(2) });
      obsTs = t[idx];
    });
  }
  cache = { at: Date.now(), data: { step: STEP, obs: obsTs, n: out.length, points: out } };
  return cache.data;
}
// Live Meteosat RGB image (natural-enhanced) for the photo overlay. EUMETSAT public WMS, EPSG:4326, RO bbox — so it
// aligns with the map's lon/lat projection. Requested at the map's stretched aspect (10°lon×5°lat → 680:470). Cached ≤10 min.
let photoCache = { at: 0, buf: null };
async function getCloudPhoto() {
  if (photoCache.buf && Date.now() - photoCache.at < 10 * 60000) return photoCache.buf;
  const W = 900, H = Math.round(900 * 470 / 680);
  const url = 'https://view.eumetsat.int/geoserver/wms?service=WMS&version=1.3.0&request=GetMap&layers=msg_fes:rgb_naturalenhncd&styles=&crs=EPSG:4326&bbox=43.5,20,48.5,30&width=' + W + '&height=' + H + '&format=image/png&transparent=true';
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('wms ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  photoCache = { at: Date.now(), buf };
  return buf;
}
module.exports = { getClouds, getCloudPhoto, STEP };
