'use strict';
/* 对比改造前后：高德路径下的页面错误与"无几何"表现（需要网络）。 */
const { Browser, openPage, sleep } = require('./cdp');
const EXE = process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE_URL || 'http://localhost:8123';
const LABEL = process.env.LABEL || 'after';

async function main() {
  const browser = await Browser.launch({ executablePath: EXE });
  const page = await openPage(browser, { width: 1280, height: 900, dsf: 1 });
  await page.goto(BASE + '/?route=1&amap=1', 9000);
  await sleep(6000);
  const state = await page.evaluate(`(() => {
    const m = window.RiskTideApp && window.RiskTideApp.map;
    const f = window.RiskTideApp && window.RiskTideApp.inkFlow;
    return {
      controller: m ? m.constructor.name : null,
      ready: m && m.getReady ? m.getReady() : null,
      lastPlanError: (m && m.lastPlanError) || '',
      taxiCoords: (window.routes.taxi.coordinates || []).length,
      ink: f && f.getState ? f.getState() : (f ? { kind: 'n/a', points: f.points.length } : null),
      status: document.getElementById('status-line').textContent
    };
  })()`);
  await page.evaluate(`document.getElementById('mode-bus').click()`);
  await sleep(2500);
  const bus = await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    return { ink: f && f.getState ? f.getState() : null,
      badge: document.getElementById('route-authenticity')
        ? document.getElementById('route-authenticity').textContent : '(none)',
      warning: document.getElementById('route-warning').textContent };
  })()`);
  const errors = page.errors.slice(0, 12);
  console.log(JSON.stringify({ label: LABEL, state, bus, errors }, null, 2));
  await browser.proc.kill();
  process.exit(0);
}
main().catch((e) => { console.error('FAILED', e && e.message); process.exit(1); });