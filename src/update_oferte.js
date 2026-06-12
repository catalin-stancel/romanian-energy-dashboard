// Daily refresh of the balancing offers: download OferteCentralizare.xlsx from the
// Transelectrica Google Drive link, then re-parse it into market.db (offers table).
// Handles the Drive "can't scan for viruses" interstitial automatically.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE_ID = '1SMp--PkGbTtNn98F-LG_QqmK6KHpoXik';
const OUT = path.join(__dirname, '..', 'data', 'oferte', 'OferteCentralizare.xlsx');

async function download() {
  let url = `https://drive.usercontent.google.com/download?id=${FILE_ID}&export=download&confirm=t`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf[0] === 0x50 && buf[1] === 0x4b) return buf; // PK -> xlsx (zip)
    // interstitial HTML: extract the confirm form parameters and retry
    const html = buf.toString('utf8');
    const uuid = /name="uuid" value="([^"]+)"/.exec(html)?.[1];
    if (!uuid) throw new Error(`unexpected response (${r.status}, ${buf.length} bytes): ${html.slice(0, 200)}`);
    url = `https://drive.usercontent.google.com/download?id=${FILE_ID}&export=download&confirm=t&uuid=${uuid}`;
  }
  throw new Error('still got HTML after confirm retry');
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const buf = await download();
  fs.writeFileSync(OUT, buf);
  console.log(`downloaded ${(buf.length / 1e6).toFixed(1)} MB -> ${OUT}`);
  execFileSync(process.execPath, ['--max-old-space-size=6144', path.join(__dirname, 'pull_oferte.js'), OUT], {
    stdio: 'inherit',
  });
})().catch((e) => { console.error(e); process.exit(1); });
