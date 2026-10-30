'use strict';
// Pull a full, resumable copy of a remote market.db through the /api/dbdump endpoint into a local SQLite file.
//   node pull_render_db.js <base-url> <widget-key> <out.db> [table ...]
// e.g. node pull_render_db.js https://gan-trading.onrender.com KEY D:\claude\trading\render_market.db
// Re-run to resume: progress per table is kept in <out.db>.__pull_state. Indexes are created at the end.
const { DatabaseSync } = require('node:sqlite');
const zlib = require('node:zlib');

const [base, key, out, ...only] = process.argv.slice(2);
if (!base || !key || !out) { console.error('usage: node pull_render_db.js <base-url> <widget-key> <out.db> [table ...]'); process.exit(2); }
const LIMIT = Number(process.env.DUMP_LIMIT || 20000);

async function getJson(u) { const r = await fetch(u); if (!r.ok) throw new Error(u.replace(key, '***') + ' → ' + r.status); return r.json(); }
async function getChunk(table, after) {
  const u = `${base}/api/dbdump?key=${key}&table=${encodeURIComponent(table)}&after=${after}&limit=${LIMIT}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      // undici already inflates Content-Encoding: gzip; a raw gzip body means it did not
      const text = buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
      const rows = text ? text.split('\n').map((l) => JSON.parse(l)) : [];
      return { rows, last: Number(r.headers.get('x-last-rowid') || (rows.length ? rows[rows.length - 1].__rowid : after)) };
    } catch (e) { if (attempt >= 6) throw e; console.warn(`  retry ${attempt} (${e.message})`); await new Promise((f) => setTimeout(f, 3000 * attempt)); }
  }
}

(async () => {
  const schema = await getJson(`${base}/api/dbdump?key=${key}&schema=1`);
  const db = new DatabaseSync(out);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; CREATE TABLE IF NOT EXISTS __pull_state (tbl TEXT PRIMARY KEY, last_rowid INTEGER, done INTEGER DEFAULT 0, rows INTEGER DEFAULT 0)');
  const tables = schema.tables.filter((t) => !only.length || only.includes(t.name));
  for (const t of tables) db.exec(t.sql.replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS '));
  const getSt = db.prepare('SELECT last_rowid, done, rows FROM __pull_state WHERE tbl=?'), setSt = db.prepare('INSERT OR REPLACE INTO __pull_state(tbl, last_rowid, done, rows) VALUES (?,?,?,?)');
  for (const t of tables) {
    const st = getSt.get(t.name) || { last_rowid: 0, done: 0, rows: 0 };
    if (st.done) { console.log(`${t.name}: done (${st.rows} rows)`); continue; }
    const cols = db.prepare(`PRAGMA table_info("${t.name}")`).all().map((c) => c.name);
    const ins = db.prepare(`INSERT OR REPLACE INTO "${t.name}" (rowid, ${cols.map((c) => `"${c}"`).join(',')}) VALUES (?${',?'.repeat(cols.length)})`);
    let after = st.last_rowid, n = st.rows; const t0 = Date.now();
    process.stdout.write(`${t.name}: ${t.n} rows on the server, resuming after rowid ${after}\n`);
    for (;;) {
      const { rows, last } = await getChunk(t.name, after);
      if (!rows.length) break;
      db.exec('BEGIN');
      for (const r of rows) ins.run(r.__rowid, ...cols.map((c) => (r[c] === undefined ? null : r[c])));
      db.exec('COMMIT');
      n += rows.length; after = last; setSt.run(t.name, after, 0, n);
      if (n % (LIMIT * 10) < LIMIT) process.stdout.write(`  ${t.name}: ${n}/${t.n} (${Math.round(n / ((Date.now() - t0) / 1000))} rows/s)\n`);
      if (rows.length < LIMIT) break;
    }
    setSt.run(t.name, after, 1, n); console.log(`${t.name}: complete, ${n} rows`);
  }
  console.log('creating indexes…');
  for (const ix of schema.indexes) { if (!tables.some((t) => t.name === ix.tbl_name)) continue; try { db.exec(ix.sql.replace(/^CREATE (UNIQUE )?INDEX\s+/i, 'CREATE $1INDEX IF NOT EXISTS ')); } catch (e) { console.warn(`index ${ix.name}: ${e.message}`); } }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log('done →', out);
})().catch((e) => { console.error(e); process.exit(1); });
