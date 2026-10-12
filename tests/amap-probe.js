'use strict';
/* 高德（线上真实底图 + 真实路线规划）路径的浏览器检查。
   需要网络：node tests/amap-probe.js（沙箱内无网络时需提权运行）。 */

const { Browser, openPage, sleep } = require('./cdp');
const path = require('path');

const EXE = process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE_URL || 'http://localhost:8123';
const OUT = path.join(__dirname, '..', '.shots');

async function main() {
  const browser = await Browser.launch({ executablePath: EXE });
  const page = await openPage(browser, { width: 1280, height: 900, dsf: 1 });
  const report = {};
  await page.goto(BASE + '/?route=1&amap=1', 6000);
  report.amapScriptLoaded = await page.evaluate(`!!window.AMap`);
  /* 等高德脚本 + 路线规划落地 */
  for (let i = 0; i < 40; i += 1) {
    const ok = await page.evaluate(`(() => {
      const m = window.RiskTideApp && window.RiskTideApp.map;
      return !!(m && (m.getReady && m.getReady()));
    })()`);
    if (ok) break;
    await sleep(500);
  }
  await sleep(3000);
  report.controller = await page.evaluate(`window.RiskTideApp.map.constructor.name`);
  report.ready = await page.evaluate(`(() => { const m = window.RiskTideApp.map;
    return { ready: m.ready, fallback: !!m.fallback, fallbackMap: !!m.fallbackMap,
      supportsPlanning: typeof m.supportsPlanning === 'function' ? m.supportsPlanning() : null,
      lastPlanError: m.lastPlanError || '' }; })()`);
  report.routes = await page.evaluate(`({
    taxi: (window.routes.taxi.coordinates || []).length,
    taxiSource: window.routes.taxi.source || '',
    bus: (window.routes.bus.coordinates || []).length,
    busSource: window.routes.bus.source || ''
  })`);
  report.ink = await page.evaluate(`(() => { const f = window.RiskTideApp.inkFlow;
    return f ? f.getState() : null; })()`);
  report.status = await page.evaluate(`document.getElementById('status-line').textContent`);
  report.badge = await page.evaluate(`(() => { const el = document.getElementById('route-authenticity');
    return { hidden: el.hidden, text: el.textContent }; })()`);
  await page.screenshot(path.join(OUT, 'amap-01-taxi.png'));

  report.misalign = await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow, map = window.RiskTideApp.map;
    if (!f || f.points.length < 2) return null;
    const coords = f.getRouteCoordinates();
    if (!coords) return null;
    const p = map.getScreenPath(coords, f.route && f.route.coordinateSystem);
    const a = p[p.length - 1], b = f.points[0];
    return Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 100) / 100;
  })()`);

  /* 拖动 + 滚轮缩放时的同步 */
  const c = await page.evaluate(`(() => { const r = document.getElementById('map-shell').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const drag = [];
  await page.mouse('mousePressed', c.x, c.y, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse('mouseMoved', c.x - i * 18, c.y - i * 6, { button: 'left', buttons: 1 });
    await sleep(70);
    drag.push(await page.evaluate(`(() => {
      const f = window.RiskTideApp.inkFlow, map = window.RiskTideApp.map;
      if (!f || f.points.length < 2) return null;
      const coords = f.getRouteCoordinates();
      if (!coords) return null;
      const p = map.getScreenPath(coords, f.route && f.route.coordinateSystem);
      const a = p[p.length - 1], b = f.points[0];
      return Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 100) / 100;
    })()`));
  }
  await page.mouse('mouseReleased', c.x - 180, c.y - 60, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(400);
  report.drag = { samples: drag, max: Math.max.apply(null, drag.filter((v) => v !== null)) };
  report.afterDrag = await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow, map = window.RiskTideApp.map;
    const coords = f.getRouteCoordinates();
    if (!coords || f.points.length < 2) return null;
    const p = map.getScreenPath(coords, f.route && f.route.coordinateSystem);
    const a = p[p.length - 1], b = f.points[0];
    return Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 100) / 100;
  })()`);

  const z = await page.evaluate(`(() => { const r = document.getElementById('map-shell').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.3 }; })()`);
  const zooms = [];
  for (let i = 0; i < 4; i += 1) {
    await page.browser.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: z.x, y: z.y, deltaX: 0, deltaY: -140, button: 'none', buttons: 0
    }, page.sessionId);
    await sleep(160);
    zooms.push(await page.evaluate(`(() => {
      const f = window.RiskTideApp.inkFlow, map = window.RiskTideApp.map;
      const coords = f.getRouteCoordinates();
      if (!coords || f.points.length < 2) return null;
      const p = map.getScreenPath(coords, f.route && f.route.coordinateSystem);
      const a = p[p.length - 1], b = f.points[0];
      return Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 100) / 100;
    })()`));
  }
  report.zoom = { samples: zooms, max: Math.max.apply(null, zooms.filter((v) => v !== null)) };
  await sleep(500);
  await page.screenshot(path.join(OUT, 'amap-02-after-zoom.png'));

  /* 悬停读数 */
  const mid = await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    if (!f || f.points.length < 2) return null;
    const p = f.points[Math.floor(f.points.length * 0.5)];
    const r = document.getElementById('silk-canvas').getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  })()`);
  if (mid) { await page.mouse('mouseMoved', mid.x, mid.y); }
  await sleep(400);
  report.tip = await page.evaluate(`(() => { const el = document.getElementById('route-tip');
    return { visible: el.classList.contains('is-visible'), text: el.textContent.replace(/\\s+/g, ' ').trim() }; })()`);

  /* 切到公交：高德 Transfer 有真实几何时应为 road，否则应为带徽标的 preview */
  await page.evaluate(`document.getElementById('mode-bus').click()`);
  await sleep(2500);
  report.bus = await page.evaluate(`(() => { const f = window.RiskTideApp.inkFlow;
    return { state: f.getState(), coords: (window.routes.bus.coordinates || []).length,
      badge: document.getElementById('route-authenticity').textContent,
      badgeHidden: document.getElementById('route-authenticity').hidden,
      warning: document.getElementById('route-warning').textContent }; })()`);
  await page.screenshot(path.join(OUT, 'amap-03-bus.png'));

  report.errors = page.errors.slice(0, 10);
  console.log(JSON.stringify(report, null, 2));
  await browser.proc.kill();
  process.exit(0);
}
main().catch((e) => { console.error('AMAP PROBE FAILED', e && e.message); process.exit(1); });