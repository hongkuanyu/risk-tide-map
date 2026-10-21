'use strict';
/* 线上（GitHub Pages 正式域名）只读体检。
   目的：① 确认高德在域名白名单下真的能规划出道路几何；② 记录线上当前版本在
   "无真实路线"情况下的实际表现（作为改造前证据）；③ 记录线上已有的控制台错误。
   用法：node tests/deployed-probe.js   （需要外网） */

const { Browser, openPage, sleep } = require('./cdp');
const fs = require('fs');
const path = require('path');

const EXE = process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SITE = process.env.SITE || 'https://hongkuanyu.github.io/risk-tide-map';
const OUT = path.join(__dirname, '..', '.shots');

const INK_STATS = `(() => {
  const cv = document.getElementById('silk-canvas');
  if (!cv) return null;
  const ctx = cv.getContext('2d');
  const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let count = 0, max = 0;
  for (let i = 3; i < img.length; i += 4) {
    const a = img[i];
    if (a > max) max = a;
    if (a >= 8) count += 1;
  }
  return { count: count, maxAlpha: max };
})()`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await Browser.launch({ executablePath: EXE });
  const page = await openPage(browser, { width: 1280, height: 900, dsf: 1 });
  const report = {};

  await page.goto(SITE + '/?route=1', 7000);
  await sleep(9000);
  report.boot = await page.evaluate(`(() => {
    const app = window.RiskTideApp || {};
    const map = app.map || {};
    const f = app.inkFlow;
    return {
      amapLoaded: !!window.AMap,
      controller: map.constructor ? map.constructor.name : null,
      ready: map.getReady ? map.getReady() : null,
      fallback: !!map.fallback,
      mode: app.ui ? app.ui.getState().mode : null,
      taxiCoords: (window.routes.taxi.coordinates || []).length,
      taxiSource: window.routes.taxi.source || '',
      taxiMinutes: window.routes.taxi.durationMinutes,
      busCoords: (window.routes.bus.coordinates || []).length,
      ink: f ? (f.getState ? f.getState() : { kind: 'n/a', points: f.points.length }) : null,
      status: document.getElementById('status-line').textContent,
      warning: document.getElementById('route-warning').textContent,
      hasTip: !!document.getElementById('route-tip'),
      hasBadge: !!document.getElementById('route-authenticity'),
      legend: document.querySelector('.map-legend').textContent.replace(/\\s+/g, ' ').trim(),
      assetVersion: (document.querySelector('script[src*="app.js"]') || {}).getAttribute
        ? document.querySelector('script[src*="app.js"]').getAttribute('src') : ''
    };
  })()`);
  report.realInk = await page.evaluate(INK_STATS);
  await page.screenshot(path.join(OUT, 'deployed-01-route.png'));

  /* 无真实道路几何的交通方式（公交）在当前线上版本里的表现 */
  await page.evaluate(`document.getElementById('mode-bus').click()`);
  await sleep(3000);
  report.bus = await page.evaluate(`(() => {
    const app = window.RiskTideApp || {};
    const f = app.inkFlow;
    return {
      busCoords: (window.routes.bus.coordinates || []).length,
      ink: f ? (f.getState ? f.getState() : { kind: 'n/a', points: f.points.length }) : null,
      status: document.getElementById('status-line').textContent,
      warning: document.getElementById('route-warning').textContent,
      badge: document.getElementById('route-authenticity')
        ? { hidden: document.getElementById('route-authenticity').hidden,
            text: document.getElementById('route-authenticity').textContent }
        : '(未实现)'
    };
  })()`);
  report.busInk = await page.evaluate(INK_STATS);
  await page.screenshot(path.join(OUT, 'deployed-02-bus.png'));

  report.errors = page.errors.slice(0, 12);
  console.log(JSON.stringify(report, null, 2));
  await browser.proc.kill();
  process.exit(0);
}
main().catch((e) => { console.error('DEPLOYED PROBE FAILED', e && e.message); process.exit(1); });