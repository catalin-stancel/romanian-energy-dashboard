// Minimal ENTSO-E Transparency Platform REST client + document parser.
// Docs: https://documenter.getpostman.com/view/7009892/2s93JtP3F6
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const BASE = 'https://web-api.tp.entsoe.eu/api';

function getToken() {
  if (process.env.ENTSOE_TOKEN) return process.env.ENTSOE_TOKEN;
  const cfgPath = path.join(__dirname, '..', 'config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^﻿/, ''));
    if (cfg.entsoe_token) return cfg.entsoe_token;
  }
  return null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => ['TimeSeries', 'Period', 'Point', 'imbalance_Price'].includes(name),
});

function fmtPeriod(d) {
  // yyyyMMddHHmm in UTC
  return d.toISOString().slice(0, 16).replace(/[-:T]/g, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns an array of XML document strings (some responses, e.g. A85/A86, arrive as ZIP archives),
// or null for "no matching data".
async function apiGet(params, token) {
  const AdmZip = require('adm-zip');
  const url = new URL(BASE);
  url.searchParams.set('securityToken', token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.ok) {
      if (buf[0] === 0x50 && buf[1] === 0x4b) { // 'PK' → ZIP of XML documents
        return new AdmZip(buf).getEntries().map((e) => e.getData().toString('utf8'));
      }
      return [buf.toString('utf8')];
    }
    const text = buf.toString('utf8');
    // "No matching data" comes back as 400 with an Acknowledgement document
    if (res.status === 400 && text.includes('Acknowledgement_MarketDocument')) return null;
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(attempt * 5000);
      continue;
    }
    throw new Error(`ENTSO-E ${res.status} for ${params.documentType}: ${text.slice(0, 300)}`);
  }
}

const PSR_TYPES = {
  B01: 'biomass', B02: 'lignite', B03: 'coal_gas', B04: 'gas', B05: 'hard_coal',
  B06: 'oil', B09: 'geothermal', B10: 'hydro_pumped', B11: 'hydro_reservoir',
  B12: 'hydro_ror', B14: 'nuclear', B15: 'other_renewable', B16: 'solar',
  B17: 'waste', B18: 'wind_offshore', B19: 'wind_onshore', B20: 'other',
};
const DIRECTIONS = { A01: 'up', A02: 'down' };
const IMB_CATEGORIES = { A04: 'excedent', A05: 'deficit' };

function resolutionMinutes(res) {
  const m = /PT(\d+)M/.exec(res);
  if (m) return Number(m[1]);
  if (res === 'PT1H' || res === 'P1H') return 60;
  return null;
}

// Parse any ENTSO-E market document into rows: { suffix, ts (Date, 15-min start), value }.
// Hourly (or coarser sub-hourly) points are expanded to 15-min rows so all series join uniformly.
function parseDocument(xml) {
  const doc = parser.parse(xml);
  const rootKey = Object.keys(doc).find((k) => k.endsWith('MarketDocument'));
  if (!rootKey || rootKey === 'Acknowledgement_MarketDocument') return [];
  const rows = [];
  for (const ts of doc[rootKey].TimeSeries || []) {
    const parts = [];
    const psr = ts['MktPSRType']?.psrType || ts['mktPSRType']?.psrType;
    if (psr) parts.push(PSR_TYPES[psr] || psr);
    const dir = ts['flowDirection.direction'];
    if (dir) parts.push(DIRECTIONS[dir] || dir);
    // A65 actual vs A75: consumption series for a psrType carry outBiddingZone — mark as such
    if (psr && ts['outBiddingZone_Domain.mRID']) parts.push('consumption');
    const baseSuffix = parts.length ? '_' + parts.join('_') : '';

    for (const period of ts.Period || []) {
      const start = new Date(period.timeInterval.start);
      const stepMin = resolutionMinutes(String(period.resolution));
      if (!stepMin) continue;
      const points = period.Point || [];
      const curveA03 = ts.curveType === 'A03';
      const lastPos = points.length ? Number(points[points.length - 1].position) : 0;
      let pi = 0;
      let current = null;
      for (let pos = 1; pos <= lastPos; pos++) {
        if (pi < points.length && Number(points[pi].position) === pos) current = points[pi++];
        else if (!curveA03) continue; // gap only legal for A03 (value persists)
        if (!current) continue;
        const t0 = new Date(start.getTime() + (pos - 1) * stepMin * 60000);
        const emit = (suffix, value) => {
          if (value === undefined || value === null || value === '') return;
          for (let off = 0; off < stepMin; off += 15) {
            rows.push({ suffix, ts: new Date(t0.getTime() + off * 60000), value: Number(value) });
          }
        };
        if (current['imbalance_Price'] || current['imbalance_Price.amount'] !== undefined) {
          const prices = current['imbalance_Price']
            ? current['imbalance_Price']
            : [{ amount: current['imbalance_Price.amount'], category: current['imbalance_Price.category'] }];
          for (const p of prices) {
            const cat = p.category ? '_' + (IMB_CATEGORIES[p.category] || p.category) : '';
            emit(baseSuffix + cat, p.amount ?? p['imbalance_Price.amount']);
          }
        } else {
          emit(baseSuffix, current.quantity ?? current['price.amount'] ?? current['activation_Price.amount']);
        }
      }
    }
  }
  return rows;
}

module.exports = { getToken, apiGet, parseDocument, fmtPeriod, sleep };
