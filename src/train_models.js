// Precompute the servable models OUT of the web process, so the server never blocks the event loop training.
// Trains sign_model + res_model, stores their (tiny) JSON in model_cache; the server LOADS these (fast) instead of
// training inline. Also truncates the WAL while here (P4 hygiene). Scheduled every ~30 min via scheduler.js.
//   node src/train_models.js
const { openDb } = require('./db');
const sign = require('./sign_model');
const res = require('./res_model');
const db = openDb();
db.exec('CREATE TABLE IF NOT EXISTS model_cache(name TEXT PRIMARY KEY, json TEXT, trained_at TEXT)');
const up = db.prepare('INSERT INTO model_cache(name,json,trained_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET json=excluded.json, trained_at=excluded.trained_at');
const now = new Date().toISOString();
const t = (name, fn) => { const s = Date.now(); try { const m = fn(); up.run(name, JSON.stringify(m), now); console.log(`${name}: trained + cached in ${Date.now() - s}ms`); } catch (e) { console.error(`${name} train failed:`, e.message); } };
t('sign', () => sign.train(db));
t('res', () => res.train(db));
try { db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); console.log('wal_checkpoint(TRUNCATE) done'); } catch (e) { console.error('checkpoint:', e.message); }
