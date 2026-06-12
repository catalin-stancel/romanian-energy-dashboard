// GAN Trading — iPhone widget (Scriptable app, https://scriptable.app)
// High-contrast tuning for iOS Liquid Glass: heavy fonts, bright colors, shrink-to-fit.
// Today's P&L + the latest settled intervals (direction, quantity MWh, price RON/MWh).
// Lock screen (rectangular accessory): P&L + 2 rows. Home screen (small/medium): P&L + 3 rows.
const URL_ = 'https://gan-trading.onrender.com/api/widget?key=PASTE_KEY_HERE';

const d = await new Request(URL_).loadJSON();
const pnlTxt = (d.pnl >= 0 ? '+' : '') + d.pnl.toLocaleString('en-US') + ' RON';
const GREEN = new Color('#4ADE80'), RED = new Color('#FF5247'),
  YELLOW = new Color('#FFF500'), BLACK = new Color('#0A0A0A'), DIM = new Color('#C9C9C9');
const rows = d.last3 || [];
const line = (r) => `${r.cet} ${r.dir} ${r.qty} MWh ${r.price} RON`;

const w = new ListWidget();

if (config.widgetFamily && config.widgetFamily.startsWith('accessory')) {
  // lock screen — heavy weights punch through the glass blur; 2 larger rows beat 3 tiny ones
  const t1 = w.addText(pnlTxt);
  t1.font = Font.heavySystemFont(16);
  t1.lineLimit = 1; t1.minimumScaleFactor = 0.7;
  for (const r of rows.slice(0, 2)) {
    const t = w.addText(line(r));
    t.font = Font.boldMonospacedSystemFont(11);
    t.lineLimit = 1; t.minimumScaleFactor = 0.7;
  }
} else {
  // home screen — near-black card, bright money colors
  w.backgroundColor = BLACK;
  const head = w.addText('GAN TRADING');
  head.font = Font.heavySystemFont(12); head.textColor = YELLOW;
  w.addSpacer(4);
  const p = w.addText(pnlTxt);
  p.font = Font.heavySystemFont(30);
  p.textColor = d.pnl >= 0 ? GREEN : RED;
  p.lineLimit = 1; p.minimumScaleFactor = 0.6;
  w.addSpacer(8);
  rows.forEach((r, i) => {
    const t = w.addText(line(r));
    t.font = Font.boldMonospacedSystemFont(14);
    t.textColor = r.dir === 'D' ? RED : (i === 0 ? Color.white() : DIM);
    t.lineLimit = 1; t.minimumScaleFactor = 0.7;
  });
  w.addSpacer();
  const ts = w.addText(`acc ${d.acc !== null ? d.acc + '%' : '—'} · ${d.ts.slice(11, 16)} UTC`);
  ts.font = Font.boldSystemFont(11); ts.textColor = DIM;
}
w.url = 'https://gan-trading.onrender.com/pi';
w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);

if (config.runsInWidget) Script.setWidget(w);
else await w.presentMedium();
Script.complete();
