// GAN Trading — iPhone widget (Scriptable app, https://scriptable.app)
// Today's P&L + the last three settled intervals (direction, quantity MWh, price RON/MWh).
// Works as: lock screen (rectangular accessory) and home screen (small/medium) widget.
const URL_ = 'https://gan-trading.onrender.com/api/widget?key=PASTE_KEY_HERE';

const d = await new Request(URL_).loadJSON();
const pnlTxt = (d.pnl >= 0 ? '+' : '') + d.pnl.toLocaleString('en-US') + ' RON';
const GREEN = new Color('#1F9E57'), RED = new Color('#D93A30'),
  YELLOW = new Color('#FFF500'), BLACK = new Color('#121212'), GRAY = new Color('#9b9b9b');
const rows = d.last3 || [];
const line = (r) => `${r.cet}  ${r.dir} ${r.qty} MWh  ${r.price} RON`;

const w = new ListWidget();

if (config.widgetFamily && config.widgetFamily.startsWith('accessory')) {
  // lock screen — P&L + three compact interval rows
  const t1 = w.addText(pnlTxt + (d.acc !== null ? `  ·  acc ${d.acc}%` : ''));
  t1.font = Font.boldSystemFont(12);
  for (const r of rows) {
    const t = w.addText(line(r));
    t.font = Font.regularMonospacedSystemFont(9);
  }
} else {
  // home screen — branded card
  w.backgroundColor = BLACK;
  const head = w.addText('GAN Trading');
  head.font = Font.boldSystemFont(11);
  head.textColor = YELLOW;
  w.addSpacer(4);
  const p = w.addText(pnlTxt);
  p.font = Font.boldSystemFont(24);
  p.textColor = d.pnl >= 0 ? GREEN : RED;
  w.addSpacer(6);
  rows.forEach((r, i) => {
    const t = w.addText(line(r));
    t.font = Font.regularMonospacedSystemFont(12);
    t.textColor = i === 0 ? Color.white() : GRAY;
    if (r.dir === 'D') t.textColor = i === 0 ? new Color('#ff6e62') : new Color('#a05550');
  });
  w.addSpacer();
  const ts = w.addText(`acc ${d.acc !== null ? d.acc + '%' : '—'} · ${d.settled} settled · ${d.ts.slice(11, 16)} UTC`);
  ts.font = Font.systemFont(9);
  ts.textColor = GRAY;
}
w.url = 'https://gan-trading.onrender.com/pi';
w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);

if (config.runsInWidget) Script.setWidget(w);
else await w.presentMedium();
Script.complete();
