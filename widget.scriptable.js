// GAN Trading — iPhone widget (Scriptable app, https://scriptable.app)
// Shows today's P&L, prediction accuracy and the latest settled interval.
// Works as: lock screen (rectangular accessory) and home screen (small/medium) widget.
//
// Setup: install Scriptable → new script → paste this → set URL below →
//  Home screen: long-press → add widget → Scriptable → pick this script
//  Lock screen: customize lock screen → add widget → Scriptable → pick this script
const URL_ = 'https://gan-trading.onrender.com/api/widget?key=PASTE_KEY_HERE';

const d = await new Request(URL_).loadJSON();
const pnlTxt = (d.pnl >= 0 ? '+' : '') + d.pnl.toLocaleString('en-US') + ' RON';
const GREEN = new Color('#1F9E57'), RED = new Color('#D93A30'),
  YELLOW = new Color('#FFF500'), BLACK = new Color('#121212'), GRAY = new Color('#9b9b9b');

const w = new ListWidget();

if (config.widgetFamily && config.widgetFamily.startsWith('accessory')) {
  // lock screen — compact
  w.addSpacer(2);
  const t1 = w.addText(pnlTxt);
  t1.font = Font.boldSystemFont(16);
  const t2 = w.addText(
    (d.lastCet ? `${d.lastCet} ${d.lastDir ?? ''} ${d.lastPrice ?? ''}` : 'no data') +
    (d.acc !== null ? ` · acc ${d.acc}%` : ''),
  );
  t2.font = Font.systemFont(11);
} else {
  // home screen — branded
  w.backgroundColor = BLACK;
  const head = w.addText('GAN Trading');
  head.font = Font.boldSystemFont(11);
  head.textColor = YELLOW;
  w.addSpacer(6);
  const p = w.addText(pnlTxt);
  p.font = Font.boldSystemFont(26);
  p.textColor = d.pnl >= 0 ? GREEN : RED;
  w.addSpacer(4);
  if (d.lastCet) {
    const l = w.addText(`${d.lastCet} · ${d.lastDir === 'S' ? 'Surplus' : 'Deficit'} · ${d.lastPrice} RON`);
    l.font = Font.systemFont(12);
    l.textColor = Color.white();
  }
  const a = w.addText(`acc ${d.acc !== null ? d.acc + '%' : '—'} · ${d.settled} settled`);
  a.font = Font.systemFont(11);
  a.textColor = GRAY;
  w.addSpacer();
  const ts = w.addText('as of ' + d.ts.slice(11, 16) + ' UTC');
  ts.font = Font.systemFont(9);
  ts.textColor = GRAY;
}
w.url = 'https://gan-trading.onrender.com/pi'; // tap opens the app
w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);

if (config.runsInWidget) Script.setWidget(w);
else await w.presentMedium();
Script.complete();
