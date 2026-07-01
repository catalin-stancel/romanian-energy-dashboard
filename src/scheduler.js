// In-process job scheduler — replaces Windows Task Scheduler for the Render deployment.
// Jobs run as child processes (memory isolation, a crashing job never takes the web server
// down); an overlap guard skips a tick while the previous run is still going.
const { spawn } = require('child_process');
const path = require('path');

const JOBS = [
  { name: 'damas', script: 'pull_damas.js', args: ['update'], everyMin: 5 },
  { name: 'entsoe', script: 'pull_entsoe.js', args: ['update'], everyMin: 15 },
  { name: 'opcom', script: 'pull_opcom.js', args: ['update'], everyMin: 30 },
  { name: 'weather', script: 'pull_weather.js', args: [], everyMin: 60 },
  { name: 'predict', script: 'predict.js', args: [], everyMin: 15 },
  { name: 'score', script: 'score_predictions.js', args: [], everyMin: 60 },
  // combo: live (paper) scoring of the xb_combo colour model — additive, writes only combo_pred, never positions.
  { name: 'combo', script: 'combo_score.js', args: [], everyMin: 15 },
  { name: 'xb_pi', script: 'log_xb_pi.js', args: [], everyMin: 1 },
  { name: 'pi_learn', script: 'pi_learn.js', args: [], everyMin: 15 },
  // precompute sign+res models into model_cache (off the request path) + truncate WAL — every 30 min
  { name: 'train_models', script: 'train_models.js', args: [], everyMin: 30 },
  // daily / weekly (UTC clock)
  { name: 'oferte', script: 'update_oferte.js', args: [], dailyUtc: '03:30', nodeArgs: ['--max-old-space-size=1536'] },
  { name: 'train', script: 'train.js', args: [], weeklyUtc: { dow: 0, hour: 4 }, nodeArgs: ['--max-old-space-size=2048'] },
];

const running = new Set();

function runJob(job) {
  if (running.has(job.name)) {
    console.log(`[jobs] ${job.name}: previous run still active, skipping tick`);
    return;
  }
  running.add(job.name);
  const t0 = Date.now();
  const child = spawn(
    process.execPath,
    [...(job.nodeArgs || []), path.join(__dirname, job.script), ...job.args],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
  );
  let tail = '';
  const keepTail = (d) => { tail = (tail + d.toString()).slice(-2000); };
  child.stdout.on('data', keepTail);
  child.stderr.on('data', keepTail);
  child.on('exit', (code) => {
    running.delete(job.name);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (code === 0) console.log(`[jobs] ${job.name}: ok in ${secs}s — ${tail.trim().split('\n').pop() || ''}`);
    else console.error(`[jobs] ${job.name}: EXIT ${code} after ${secs}s\n${tail.trim()}`);
  });
}

function start() {
  const disabled = new Set((process.env.JOBS_DISABLED || '').split(',').map((s) => s.trim()).filter(Boolean));
  for (const job of JOBS) {
    if (disabled.has(job.name)) { console.log(`[jobs] ${job.name}: disabled via JOBS_DISABLED`); continue; }
    if (job.everyMin) {
      setTimeout(() => { runJob(job); setInterval(() => runJob(job), job.everyMin * 60000); },
        Math.random() * 30000); // stagger first runs
    } else {
      // check every minute whether the daily/weekly slot just arrived
      let lastKey = '';
      setInterval(() => {
        const now = new Date();
        const hh = String(now.getUTCHours()).padStart(2, '0');
        const mm = String(now.getUTCMinutes()).padStart(2, '0');
        let due = false, key = now.toISOString().slice(0, 10);
        if (job.dailyUtc) due = `${hh}:${mm}` === job.dailyUtc;
        if (job.weeklyUtc) due = now.getUTCDay() === job.weeklyUtc.dow && Number(hh) === job.weeklyUtc.hour && mm === '00';
        if (due && lastKey !== key) { lastKey = key; runJob(job); }
      }, 60000);
    }
  }
  console.log(`[jobs] scheduler started (${JOBS.length} jobs)`);
}

module.exports = { start };
