// Parse Transelectrica's OferteCentralizare.xlsx (all balancing-market offers, one sheet per day)
// into market.db table `offers`. The file is ~180 MB so we parse sheet XML directly (no xlsx lib).
//
//   node --max-old-space-size=6144 tool\pull_oferte.js data\oferte\OferteCentralizare.xlsx
//
// Sheet layout (verified 2026-06-11): header block rows 1-7, column headers row 8, data row 9+.
// Columns: A DATE (excel serial) | B MTU "00:00 - 00:15" | C INTERVAL 1..96 (EET) | D BSP |
//          E PRODUCT aFRR/mFRR/RR | F DIRECTION up/down | G BID ID | H TECH GROUP | I-L links |
//          M DIVISIBILITY | N MIN MW | O MAX MW | P PRICE [currency/MWh] | Q CURRENCY | R ACTIVATION TYPE
const AdmZip = require('adm-zip');
const { openDb } = require('./db');

function parseSharedStrings(xml) {
  const out = [];
  const re = /<si>(.*?)<\/si>/gs;
  let m;
  while ((m = re.exec(xml))) {
    // an <si> may contain one <t> or multiple rich-text runs; strip all tags
    out.push(
      m[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
    );
  }
  return out;
}

function* rows(sheetXml) {
  const rowRe = /<row [^>]*r="(\d+)"[^>]*>(.*?)<\/row>/gs;
  const cellRe = /<c\s+([^>]*?)\/?>(?:<v>([^<]*)<\/v>)?(?:<\/c>)?/g;
  let m;
  while ((m = rowRe.exec(sheetXml))) {
    const rowNum = Number(m[1]);
    if (rowNum < 9) continue;
    const cells = {};
    let c;
    cellRe.lastIndex = 0;
    while ((c = cellRe.exec(m[2]))) {
      const attrs = c[1];
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      if (!ref) continue;
      const isStr = /t="s"/.test(attrs);
      cells[ref] = { v: c[2], s: isStr };
    }
    yield cells;
  }
}

function main() {
  const file = process.argv[2] || 'data/oferte/OferteCentralizare.xlsx';
  const zip = new AdmZip(file);

  console.log('parsing sharedStrings...');
  const SS = parseSharedStrings(zip.readAsText('xl/sharedStrings.xml'));
  console.log(`${SS.length} shared strings`);

  // sheet name -> xml path via workbook + rels
  const wb = zip.readAsText('xl/workbook.xml');
  const rels = zip.readAsText('xl/_rels/workbook.xml.rels');
  const relMap = Object.fromEntries(
    [...rels.matchAll(/Id="(rId\d+)"[^>]*Target="(worksheets\/[^"]+)"/g)].map((r) => [r[1], 'xl/' + r[2]]),
  );
  const sheets = [...wb.matchAll(/<sheet name="([^"]+)"[^>]*r:id="(rId\d+)"/g)]
    .map((s) => ({ name: s[1], path: relMap[s[2]] }))
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.name) && s.path);
  console.log(`${sheets.length} day sheets`);

  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS offers (
      date_ro TEXT NOT NULL,
      mtu INTEGER NOT NULL,          -- 15-min interval of the EET day, 1..96
      bid_id TEXT NOT NULL,
      bsp TEXT,
      product TEXT,                  -- aFRR / mFRR / RR
      direction TEXT,                -- up / down
      divisibility TEXT,
      pmin REAL, pmax REAL,          -- offered band [MW]
      price REAL,                    -- RON/MWh
      activation TEXT,               -- standard / scheduled / direct
      PRIMARY KEY (date_ro, mtu, bid_id)
    );
    CREATE INDEX IF NOT EXISTS idx_offers_lookup ON offers (date_ro, mtu, product, direction);
  `);
  const ins = db.prepare(`INSERT OR REPLACE INTO offers VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  const val = (cell) => (cell ? (cell.s ? SS[Number(cell.v)] : cell.v) : null);
  const num = (cell) => { const n = Number(cell?.v); return Number.isFinite(n) ? n : null; };

  let grand = 0;
  for (const sheet of sheets) {
    const xml = zip.readAsText(sheet.path);
    let n = 0;
    db.exec('BEGIN');
    db.prepare('DELETE FROM offers WHERE date_ro = ?').run(sheet.name);
    for (const cells of rows(xml)) {
      const mtu = num(cells.C);
      const bidId = val(cells.G);
      if (!mtu || !bidId) continue;
      ins.run(
        sheet.name, mtu, bidId, val(cells.D), val(cells.E), val(cells.F),
        val(cells.M), num(cells.N), num(cells.O), num(cells.P), val(cells.R),
      );
      n++;
    }
    db.exec('COMMIT');
    grand += n;
    console.log(`${sheet.name}: ${n} offers`);
  }
  db.prepare('INSERT INTO pull_log VALUES (?,?,?,?,?,?)')
    .run('oferte', file, new Date().toISOString(), new Date().toISOString(), grand, null);
  console.log(`total: ${grand} offer rows`);
}

main();
