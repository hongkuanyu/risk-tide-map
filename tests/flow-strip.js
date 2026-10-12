'use strict';
/* 流动对照：同一段墨线，隔几秒各拍一张，拼成一条"流动条"看光斑是否在走。
   用法：BASE_URL=http://localhost:8123 node tests/flow-strip.js */
const { Browser, openPage, sleep } = require('./cdp');
const path = require('path');

const EXE = process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE_URL || 'http://localhost:8123';
const OUT = path.join(__dirname, '..', '.shots');

async function main() {
  const browser = await Browser.launch({ executablePath: EXE });
  const page = await openPage(browser, { width: 1280, height: 900, dsf: 1 });
  /* headless 下必须把标签页置前，否则 document.hidden = true，流动不跑 */
  await browser.send('Page.bringToFront', {}, page.sessionId);
  await page.goto(BASE + '/?route=1&osm=1', 3600);
  await page.evaluate(`document.getElementById('mode-taxi').click()`);
  await sleep(1500);
  await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    f.setVisible(true);            /* headless 后台标签页 document.hidden=true，这里强制可见 */
    f.reducedMotion = false; f.progress = 1; f.elapsed = 0; f.lastTime = 0; f.start();
    ['route-tip', 'route-authenticity', 'status-line', 'map-legend'].forEach(function (id) {
      const el = document.getElementById(id); if (el) el.style.visibility = 'hidden';
    });
    return 'ok';
  })()`);
  await sleep(2600);
  const frames = [];
  for (let i = 0; i < 3; i += 1) {
    const file = path.join(OUT, 'flow-frame-' + i + '.png');
    await page.screenshot(file);
    frames.push(file);
    await sleep(2600);
  }
  const info = await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    return { elapsed: Math.round(f.elapsed * 10) / 10, points: f.points.length,
      visible: f.visible, hidden: document.hidden, running: f.running };
  })()`);
  console.log(JSON.stringify({ frames: frames.length, info: info }, null, 2));
  browser.proc.kill();
  process.exit(0);
}
main().catch((e) => { console.error('FLOW STRIP FAILED', e && e.message); process.exit(1); });