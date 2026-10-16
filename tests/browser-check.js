'use strict';
/* 单程墨线 浏览器回归测试（真实 Edge/Chrome + CDP，不依赖 npm 包）。
   运行：node tests/browser-check.js            全部场景
        node tests/browser-check.js pan hover  只跑指定场景

   覆盖：路线真实性、地图同步、悬停 / 点击 / 触摸 / 键盘、笔触宽度稳定性、
   低帧率动画时长、reduced-motion、规划失败与乱序响应、异常几何、全国模式回归。 */

const { Browser, openPage, sleep } = require('./cdp');
const fs = require('fs');
const path = require('path');

const EXE = process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE_URL || 'http://localhost:8123';
const SHOT_DIR = process.env.SHOT_DIR || path.join(__dirname, '..', '.shots');
const only = process.argv.slice(2);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : detail });
}
/* 环境不满足（例如本机无法访问高德）时明确记为"跳过"，不算通过。 */
function skip(name, reason) {
  results.push({ name, pass: true, skipped: true, detail: '跳过：' + reason });
}
function approx(value, target, tolerance) { return Math.abs(value - target) <= tolerance; }

/* ---------- 页面内小工具（注入到被测页面） ---------- */
const HELPERS_A = `
window.__t = {
  canvas: function () { return document.getElementById('silk-canvas'); },
  pixels: function () {
    const cv = this.canvas();
    const ctx = cv.getContext('2d');
    return { data: ctx.getImageData(0, 0, cv.width, cv.height), w: cv.width, h: cv.height,
      dpr: cv.width / cv.getBoundingClientRect().width };
  },
  inkStats: function (threshold) {
    const p = this.pixels();
    let count = 0, max = 0, sum = 0;
    for (let i = 3; i < p.data.data.length; i += 4) {
      const a = p.data.data[i];
      if (a > max) max = a;
      if (a >= (threshold === undefined ? 8 : threshold)) { count += 1; sum += a; }
    }
    return { count: count, maxAlpha: max, pixels: p.w * p.h,
      meanAlpha: Math.round(sum / Math.max(1, count) * 10) / 10 };
  },
`;const HELPERS_B = `
  /* 固定路线位置上，垂直于墨线扫描得到墨迹宽度（像素） */
  widthAt: function (index, threshold) {
    const f = window.RiskTideApp.inkFlow;
    const cv = this.canvas();
    const rect = cv.getBoundingClientRect();
    const dpr = cv.width / rect.width;
    f.routeDirty = false;
    f.draw();
    const pts = f.points;
    const i = Math.max(1, Math.min(pts.length - 2, index));
    const a = pts[i - 1], b = pts[i + 1];
    let dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const img = this.pixels();
    let width = 0;
    for (let s = -34; s <= 34; s += 0.5) {
      const x = Math.round((pts[i].x + nx * s) * dpr);
      const y = Math.round((pts[i].y + ny * s) * dpr);
      if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
      if (img.data.data[(y * img.w + x) * 4 + 3] >= (threshold === undefined ? 8 : threshold)) width += 0.5;
    }
    return width;
  },
`;const HELPERS_C = `
  /* 墨迹是否越出笔触包络（尖刺 / 自交检查）：最远墨点距中轴线的距离 */
  inkEnvelope: function (threshold) {
    const f = window.RiskTideApp.inkFlow;
    const pts = f.points;
    if (pts.length < 2) return { ok: false, reason: 'no points' };
    const img = this.pixels();
    const dpr = img.dpr;
    const cell = 24;
    const grid = new Map();
    const key = function (cx, cy) { return cx + ':' + cy; };
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i], b = pts[i + 1];
      const minX = Math.floor(Math.min(a.x, b.x) / cell) - 1;
      const maxX = Math.floor(Math.max(a.x, b.x) / cell) + 1;
      const minY = Math.floor(Math.min(a.y, b.y) / cell) - 1;
      const maxY = Math.floor(Math.max(a.y, b.y) / cell) + 1;
      for (let cx = minX; cx <= maxX; cx += 1) {
        for (let cy = minY; cy <= maxY; cy += 1) {
          const k = key(cx, cy);
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(i);
        }
      }
    }
    let worst = 0, orphan = 0;
    const step = 2;
    for (let y = 0; y < img.h; y += step) {
      for (let x = 0; x < img.w; x += step) {
        if (img.data.data[(y * img.w + x) * 4 + 3] < (threshold === undefined ? 40 : threshold)) continue;
        const px = x / dpr, py = y / dpr;
        const list = grid.get(key(Math.floor(px / cell), Math.floor(py / cell)));
        if (!list) { orphan += 1; continue; }
        let best = Infinity;
        for (let n = 0; n < list.length; n += 1) {
          const i = list[n];
          const a = pts[i], b = pts[i + 1];
          const dx = b.x - a.x, dy = b.y - a.y;
          const lenSq = dx * dx + dy * dy;
          let t = lenSq ? ((px - a.x) * dx + (py - a.y) * dy) / lenSq : 0;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
          if (d < best) best = d;
        }
        if (best > worst) worst = best;
      }
    }
    return { ok: true, worst: Math.round(worst * 10) / 10, orphan: orphan };
  },
`;const HELPERS_D = `
  misalign: function () {
    const f = window.RiskTideApp.inkFlow, map = window.RiskTideApp.map;
    if (!f || f.points.length < 2) return null;
    const coords = f.getRouteCoordinates();
    if (!coords || coords.length < 2) return null;
    const p = map.getScreenPath(coords, f.route && f.route.coordinateSystem);
    const a = p[p.length - 1], b = f.points[0];
    if (!a || !b) return null;
    return Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 100) / 100;
  },
  hooks: function () {
    const f = window.RiskTideApp.inkFlow;
    if (window.__hooked) return 'already';
    window.__hooked = true;
    window.__t.h = { draws: 0, rebuilds: 0 };
    const od = f.draw.bind(f), orb = f.rebuild.bind(f);
    f.draw = function () { window.__t.h.draws += 1; return od(); };
    f.rebuild = function () { window.__t.h.rebuilds += 1; return orb(); };
    return 'ok';
  },
  shellPoint: function (fx, fy) {
    const r = document.getElementById('map-shell').getBoundingClientRect();
    return { x: r.left + r.width * fx, y: r.top + r.height * fy };
  },
  routePoint: function (fraction) {
    const f = window.RiskTideApp.inkFlow;
    const p = f.points[Math.floor(f.points.length * (fraction === undefined ? 0.5 : fraction))];
    const r = document.getElementById('silk-canvas').getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  },
`;const HELPERS_F = `
  /* 画布层指纹：真正画出来的墨迹（不是内部状态）——包围盒中心/尺寸、像素量、平均色 */
  inkFingerprint: function (step) {
    const img = this.pixels();
    const s = step === undefined ? 2 : step;
    let count = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    let sumR = 0, sumG = 0, sumB = 0;
    for (let y = 0; y < img.h; y += s) {
      for (let x = 0; x < img.w; x += s) {
        const i = (y * img.w + x) * 4;
        if (img.data.data[i + 3] < 8) continue;
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        sumR += img.data.data[i];
        sumG += img.data.data[i + 1];
        sumB += img.data.data[i + 2];
      }
    }
    if (!count) return { count: 0 };
    const dpr = img.dpr;
    return {
      count: count,
      cx: Math.round((minX + maxX) / 2 / dpr),
      cy: Math.round((minY + maxY) / 2 / dpr),
      w: Math.round((maxX - minX) / dpr),
      h: Math.round((maxY - minY) / dpr),
      l: Math.round(minX / dpr), r: Math.round(maxX / dpr),
      t: Math.round(minY / dpr), b: Math.round(maxY / dpr),
      rgb: [Math.round(sumR / count), Math.round(sumG / count), Math.round(sumB / count)]
    };
  },
  /* 当前墨线中轴线的包围盒（CSS 像素），用于判断"画出来的墨迹是否就是当前几何" */
  centerBox: function () {
    const f = window.RiskTideApp.inkFlow;
    const pts = f.points;
    if (pts.length < 2) return null;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    pts.forEach(function (p) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    return { cx: Math.round((minX + maxX) / 2), cy: Math.round((minY + maxY) / 2),
      w: Math.round(maxX - minX), h: Math.round(maxY - minY), points: pts.length,
      l: Math.round(minX), r: Math.round(maxX), t: Math.round(minY), b: Math.round(maxY) };
  },
  /* 芯光层（screen 混合的独立画布）：非真实路线不允许发光 */
  glowStats: function (threshold) {
    const cv = document.getElementById('ink-glow-canvas');
    if (!cv) return { exists: false };
    const min = threshold === undefined ? 8 : threshold;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let count = 0, max = 0, sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a > max) max = a;
      if (a >= min) { count += 1; sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; }
    }
    return { exists: true, count: count, maxAlpha: max,
      rgb: count ? [Math.round(sr / count), Math.round(sg / count), Math.round(sb / count)] : null,
      ratio: Math.round(cv.width / cv.getBoundingClientRect().width * 100) / 100 };
  },
  /* 冷白高光的位置：把亮段质心投影到当前中轴线上，得到沿线位置 t（0=终点，1=起点）。
     高光"移动"不能用像素计数测（数量恒定），必须测位置。 */
  brightTrack: function (threshold) {
    const cv = document.getElementById('ink-glow-canvas');
    if (!cv) return { count: 0, t: null };
    const min = threshold === undefined ? 210 : threshold;
    const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    const w = cv.width, h = cv.height, d = img.data;
    let count = 0, sx = 0, sy = 0;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        if (d[(y * w + x) * 4 + 3] >= min) { count += 1; sx += x; sy += y; }
      }
    }
    if (!count) return { count: 0, t: null };
    const dpr = w / cv.getBoundingClientRect().width;
    const cx = sx / count / dpr;
    const cy = sy / count / dpr;
    const pts = window.RiskTideApp.inkFlow.points;
    let best = Infinity, bestIndex = 0;
    for (let i = 0; i < pts.length; i += 1) {
      const dist = Math.hypot(pts[i].x - cx, pts[i].y - cy);
      if (dist < best) { best = dist; bestIndex = i; }
    }
    return { count: count, t: Math.round(bestIndex / Math.max(1, pts.length - 1) * 1000) / 1000 };
  },
  /* 把浮层/徽标等 DOM 覆盖物藏掉，避免污染画布指纹 */
  hideOverlays: function () {
    ['route-tip', 'route-authenticity', 'status-line'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.style.visibility = 'hidden';
    });
    return 'ok';
  },
`;

const HELPERS_E = `
  tip: function () {
    const el = document.getElementById('route-tip');
    const shell = document.getElementById('map-shell').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
      visible: el.classList.contains('is-visible') && r.width > 0 && r.height > 0,
      aria: el.getAttribute('aria-hidden'),
      text: el.textContent.replace(/\\s+/g, ' ').trim(),
      rows: Array.prototype.map.call(el.querySelectorAll('.route-tip-rows dt'),
        function (n) { return n.textContent; }),
      inside: r.left >= shell.left - 1 && r.top >= shell.top - 1
        && r.right <= shell.right + 1 && r.bottom <= shell.bottom + 1,
      rect: { left: Math.round(r.left), top: Math.round(r.top) },
      shell: { left: Math.round(shell.left), top: Math.round(shell.top),
        right: Math.round(shell.right), bottom: Math.round(shell.bottom) }
    };
  },
  badge: function () {
    const el = document.getElementById('route-authenticity');
    return { hidden: el.hidden, text: el.textContent.trim(), kind: el.dataset.kind || '' };
  },
  flowState: function () {
    const f = window.RiskTideApp.inkFlow;
    return f ? f.getState() : null;
  },
  routes: function () {
    return {
      taxi: (window.routes.taxi.coordinates || []).length,
      taxiSource: window.routes.taxi.source || '',
      bus: (window.routes.bus.coordinates || []).length,
      routeMinutes: window.RiskTideApp.ui.getState().routeMinutes
    };
  },
  setMode: function (mode) { document.getElementById('mode-' + mode).click(); }
};
`;

/* 顺序即拼接顺序：E 的结尾负责关闭 window.__t 对象，必须放最后 */
const HELPERS = HELPERS_A + HELPERS_B + HELPERS_C + HELPERS_D + HELPERS_F + HELPERS_E;
async function newPage(browser, opts) {
  const page = await openPage(browser, opts);
  const originalGoto = page.goto.bind(page);
  page.gotoRoute = async function (url, wait) {
    await originalGoto(url, wait);
    await page.evaluate(HELPERS);
    return page;
  };
  return page;
}

function summary() {
  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log('================ 结果 ================');
  results.forEach((r) => {
    const tag = r.skipped ? ' SKIP ' : (r.pass ? ' PASS ' : ' FAIL ');
    console.log(tag + r.name + (r.detail ? '  :: ' + r.detail : ''));
  });
  const skipped = results.filter((r) => r.skipped).length;
  console.log('-------------------------------------');
  console.log(results.length + ' 项检查，' + failed.length + ' 项失败，' + skipped + ' 项跳过');
  return failed.length;
}

async function scenarioRealVsHint(page) {
  await page.gotoRoute(BASE + '/?route=1&osm=1', 3200);
  const boot = await page.evaluate(`(() => ({
    mode: window.RiskTideApp.ui.getState().mode,
    state: window.__t.flowState(),
    badge: window.__t.badge(),
    legend: document.querySelector('.map-legend').textContent.replace(/\\s+/g, ' ').trim()
  }))()`);
  check('真实路线：网约车几何被判定为真实道路', boot.state && boot.state.kind === 'road',
    JSON.stringify(boot.state));
  check('真实路线：墨线采样点足够（>40）', boot.state && boot.state.points > 40, boot.state && boot.state.points);
  const deviation = await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow, map = window.RiskTideApp.map;
    const coords = f.getRouteCoordinates();
    const p = map.getScreenPath(coords, f.route.coordinateSystem);
    const a = p[0], b = p[p.length - 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let max = 0;
    p.forEach(function (q) {
      const d = Math.abs((b.x - a.x) * (a.y - q.y) - (a.x - q.x) * (b.y - a.y)) / len;
      if (d > max) max = d;
    });
    return Math.round(max * 10) / 10;
  })()`);
  check('真实路线：几何不是直线（屏幕最大偏离 > 20px）', deviation > 20, deviation + 'px');
  check('真实路线：真实性徽标隐藏', boot.badge.hidden === true, JSON.stringify(boot.badge));
  /* 投影自洽：控制器算出的屏幕坐标，必须落在底图自己摆放的 marker 锚点上。
     这才是独立于墨线自身的"绝对位置"检查（misalign 只能查是否过期）。 */
  const anchor = await page.evaluate(`(() => {
    const map = window.RiskTideApp.map;
    const shell = document.getElementById('map-shell').getBoundingClientRect();
    const eps = map.getEndpoints();
    const out = {};
    [['campus', 'campus'], ['station', 'station']].forEach(function (pair) {
      const p = map.getScreenPath([eps[pair[0]].coordinate], 'WGS84')[0];
      const el = document.querySelector('.' + pair[1] + '-marker');
      if (!el || !p) { out[pair[1]] = null; return; }
      const r = el.getBoundingClientRect();
      if (r.width === 0) { out[pair[1]] = null; return; }
      out[pair[1]] = {
        dx: Math.round((p.x - (r.left + r.width / 2 - shell.left)) * 100) / 100,
        dy: Math.round((p.y - (r.bottom - shell.top)) * 100) / 100
      };
    });
    return out;
  })()`);
  check('真实路线：起终点投影与底图 marker 重合（≤3px）',
    anchor.campus && anchor.station && Math.abs(anchor.campus.dx) <= 3
      && Math.abs(anchor.campus.dy) <= 3 && Math.abs(anchor.station.dx) <= 3
      && Math.abs(anchor.station.dy) <= 3, JSON.stringify(anchor));
  check('图例说明墨色 = 全程时间余量（非实时路况）',
    boot.legend.indexOf('全程时间余量') >= 0 && boot.legend.indexOf('非实时路况') >= 0, boot.legend);
  const realInk = await page.evaluate(`window.__t.inkStats(8)`);
  const realGlow = await page.evaluate(`window.__t.glowStats()`);
  check('真实路线：芯光层有发光像素（screen 混合的独立画布）',
    realGlow.exists && realGlow.count > 200 && realGlow.maxAlpha > 60, JSON.stringify(realGlow));
  const realWidth = await page.evaluate(`window.__t.widthAt(Math.floor(window.RiskTideApp.inkFlow.points.length * 0.2), 8)`);
  await page.evaluate(`window.__t.setMode('bus')`);
  await sleep(900);
  const bus = await page.evaluate(`(() => ({
    state: window.__t.flowState(),
    badge: window.__t.badge(),
    coords: window.RiskTideApp.inkFlow.getRouteCoordinates(),
    status: document.getElementById('status-line').textContent
  }))()`);
  const hintInk = await page.evaluate(`window.__t.inkStats(8)`);
  const hintGlow = await page.evaluate(`window.__t.glowStats()`);
  check('无几何路线：芯光层完全不发光（示意线不许有发光核心）',
    hintGlow.exists && hintGlow.count === 0, JSON.stringify(hintGlow));
  const busWidth = await page.evaluate(`window.__t.widthAt(Math.floor(window.RiskTideApp.inkFlow.points.length * 0.5), 8)`);
  check('无几何路线：不再判定为真实道路', bus.state && bus.state.kind === 'preview', JSON.stringify(bus.state));
  check('无几何路线：渲染器拿不到"真实几何"', bus.coords === null, String(bus.coords));
  check('无几何路线：徽标明确标注非真实道路',
    bus.badge.hidden === false && bus.badge.text.indexOf('非真实道路路线') >= 0, JSON.stringify(bus.badge));
  check('无几何路线：只有一根细虚线，没有水墨笔触宽度（< 5px；真实路线 > 8px）',
    busWidth < 5 && realWidth > 8, 'hint=' + busWidth + 'px real=' + realWidth + 'px');
  check('无几何路线：墨迹像素量低于真实路线的 60%', hintInk.count < realInk.count * 0.6,
    'hint=' + hintInk.count + ' real=' + realInk.count);
  await page.screenshot(path.join(SHOT_DIR, 'after-03-no-geometry.png'));
  return { realInk, hintInk };
}
async function scenarioMapSync(page) {
  await page.gotoRoute(BASE + '/?route=1&osm=1', 3200);
  await page.evaluate(`window.__t.setMode('taxi')`);
  await sleep(1600);
  await page.setReducedMotion(false);
  await page.evaluate(`(() => { window.RiskTideApp.inkFlow.reducedMotion = false;
    window.RiskTideApp.inkFlow.hover = 0; window.RiskTideApp.inkFlow.hoverTarget = 0;
    window.__t.hooks();
    window.__t.h = { draws: 0, rebuilds: 0 };
    return 'ok'; })()`);

  const c = await page.evaluate(`window.__t.shellPoint(0.5, 0.5)`);
  await page.mouse('mousePressed', c.x, c.y, { button: 'left', buttons: 1, clickCount: 1 });
  const drag = [];
  for (let i = 1; i <= 12; i += 1) {
    await page.mouse('mouseMoved', c.x - i * 16, c.y - i * 5, { button: 'left', buttons: 1 });
    await sleep(60);
    drag.push(await page.evaluate(`window.__t.misalign()`));
  }
  await page.mouse('mouseReleased', c.x - 192, c.y - 60, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(150);
  const dragMax = Math.max.apply(null, drag.filter((v) => v !== null));
  const dragHooks = await page.evaluate(`window.__t.h`);
  check('拖动地图：墨线与底图最大错位 < 2px', dragMax < 2, 'max=' + dragMax + 'px');
  check('拖动地图：确实按帧重投影（rebuild ≥ 8）', dragHooks.rebuilds >= 8, JSON.stringify(dragHooks));
  check('拖动地图：每帧重投影（rebuild ≥ 8 / 12 步）', dragHooks.rebuilds >= 8, JSON.stringify(dragHooks));

  const z = await page.evaluate(`window.__t.shellPoint(0.5, 0.25)`);
  await page.mouse('mouseMoved', z.x, z.y);
  await page.evaluate(`(() => { window.RiskTideApp.inkFlow.hover = 0; window.RiskTideApp.inkFlow.hoverTarget = 0;
    window.__t.h = { draws: 0, rebuilds: 0 }; return 'ok'; })()`);
  const zoom = [];
  for (let i = 0; i < 4; i += 1) {
    await page.browser.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: z.x, y: z.y, deltaX: 0, deltaY: -140, button: 'none', buttons: 0
    }, page.sessionId);
    await sleep(120);
    zoom.push(await page.evaluate(`window.__t.misalign()`));
  }
  const zoomHooks = await page.evaluate(`window.__t.h`);
  const zoomMax = Math.max.apply(null, zoom.filter((v) => v !== null));
  /* 动画进行中最多落后一帧（缩放动画本身就要跑完才停），停下来必须完全对齐 */
  check('滚轮缩放（指针不动）：动画中墨线最多落后一帧（≤ 4px）', zoomMax < 4, 'max=' + zoomMax + 'px');
  await sleep(600);
  const zoomSettled = await page.evaluate(`window.__t.misalign()`);
  check('滚轮缩放：动画结束后完全对齐（< 1px）', zoomSettled !== null && zoomSettled < 1,
    'settled=' + zoomSettled + 'px');
  check('滚轮缩放：确实请求了重绘（rebuild ≥ 4）', zoomHooks.rebuilds >= 4, JSON.stringify(zoomHooks));

  const c2 = await page.evaluate(`window.__t.shellPoint(0.5, 0.5)`);
  await page.mouse('mousePressed', c2.x, c2.y, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse('mouseMoved', c2.x - i * 45, c2.y, { button: 'left', buttons: 1 });
    await sleep(14);
  }
  await page.mouse('mouseReleased', c2.x - 360, c2.y, { button: 'left', buttons: 0, clickCount: 1 });
  await page.evaluate(`(() => { window.__t.h = { draws: 0, rebuilds: 0 }; return 'ok'; })()`);
  const inertia = [];
  for (let i = 0; i < 8; i += 1) { await sleep(80); inertia.push(await page.evaluate(`window.__t.misalign()`)); }
  const inertiaMax = Math.max.apply(null, inertia.filter((v) => v !== null));
  const inertiaHooks = await page.evaluate(`window.__t.h`);
  /* 惯性滑动时墨线最多落后一帧（甩动速度下约 1-4px）；改前这里是 100px 级别的掉队 */
  check('惯性滑动：墨线跟随（最大错位 < 8px，即 ≤2 帧的投影延迟；停下后另行断言 0 错位）', inertiaMax < 8,
    'max=' + inertiaMax + 'px');
  check('惯性滑动：持续重绘而非停在待机（rebuild ≥ 3）', inertiaHooks.rebuilds >= 3, JSON.stringify(inertiaHooks));

  await sleep(700);
  /* 新契约：真实路线持续流动（潮汐波峰永远在动）。headless 页面可能被当作后台页，
     先置前并强制可见，保证测的是渲染本身而不是后台节流。 */
  await page.browser.send('Page.bringToFront', {}, page.sessionId);
  await page.evaluate(`(() => { window.RiskTideApp.inkFlow.hover = 0; window.RiskTideApp.inkFlow.hoverTarget = 0;
    window.RiskTideApp.inkFlow.setVisible(true);
    window.__t.h = { draws: 0, rebuilds: 0 }; return 'ok'; })()`);
  await sleep(1500);
  const idle = await page.evaluate(`window.__t.h`);
  /* 静止态持续满帧流动：光流与潮汐波峰不停止，但不做无谓的重新投影。 */
  check('静止后：流光持续重绘（1.5s 内 ≥ 30 帧）', idle.draws >= 30, JSON.stringify(idle));
  check('静止后：不因静止而重新投影（rebuild = 0）', idle.rebuilds === 0, JSON.stringify(idle));
  return { dragMax, zoomMax, inertiaMax, idle };
}
async function scenarioHoverClickKeyboard(page) {
  await page.gotoRoute(BASE + '/?route=1&osm=1', 3200);
  await page.evaluate(`window.__t.setMode('taxi')`);
  await sleep(1800);
  const mid = await page.evaluate(`window.__t.routePoint(0.5)`);
  await page.mouse('mouseMoved', mid.x, mid.y);
  await sleep(400);
  const tip = await page.evaluate(`window.__t.tip()`);
  check('悬停：浮层出现', tip.visible, JSON.stringify(tip.rect));
  check('悬停：浮层不超出地图范围', tip.inside, JSON.stringify({ rect: tip.rect, shell: tip.shell }));
  const wanted = ['交通方式', '预计行程', '计划出发', '安全预留', '剩余余量', '风险等级'];
  const missing = wanted.filter((w) => tip.rows.indexOf(w) < 0);
  check('悬停：六项读数齐全（交通方式/预计行程/计划出发/安全预留/剩余余量/风险等级）',
    missing.length === 0, 'missing=' + missing.join(','));
  check('悬停：浮层说明墨色不是路段实时拥堵', tip.text.indexOf('不是路段实时拥堵') >= 0, tip.text);
  const statusText = await page.evaluate(`document.getElementById('status-line').textContent`);
  check('悬停：状态行同步一句话读数（含余量）', statusText.indexOf('余量') >= 0, statusText);
  await page.screenshot(path.join(SHOT_DIR, 'after-05-hover-tip.png'));

  await page.mouse('mouseMoved', tip.shell.left + 8, tip.shell.bottom - 8);
  await sleep(300);
  const away = await page.evaluate(`window.__t.tip()`);
  check('悬停：离开墨线后浮层收起', !away.visible, JSON.stringify(away));

  await page.mouse('mouseMoved', mid.x, mid.y);
  await sleep(200);
  await page.mouse('mousePressed', mid.x, mid.y, { button: 'left', buttons: 1, clickCount: 1 });
  await page.mouse('mouseReleased', mid.x, mid.y, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(300);
  const pinned = await page.evaluate(`window.__t.tip()`);
  await page.mouse('mouseMoved', tip.shell.left + 8, tip.shell.top + 8);
  await sleep(300);
  const stillPinned = await page.evaluate(`window.__t.tip()`);
  check('点击：浮层钉住（移开指针仍在）', pinned.visible && stillPinned.visible,
    JSON.stringify({ pinned: pinned.visible, afterMove: stillPinned.visible }));
  await page.mouse('mousePressed', tip.shell.left + 10, tip.shell.bottom - 10, { button: 'left', buttons: 1, clickCount: 1 });
  await page.mouse('mouseReleased', tip.shell.left + 10, tip.shell.bottom - 10, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(250);
  const cleared = await page.evaluate(`window.__t.tip()`);
  check('点击空白：浮层收起', !cleared.visible, JSON.stringify(cleared));

  await page.evaluate(`document.getElementById('map-shell').focus()`);
  const press = async function (key, code, vk) {
    await page.browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk }, page.sessionId);
    await page.browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }, page.sessionId);
  };
  await press('Enter', 'Enter', 13);
  await sleep(300);
  const kb = await page.evaluate(`window.__t.tip()`);
  check('键盘：Enter 打开浮层', kb.visible, JSON.stringify(kb.rect));
  await press('ArrowRight', 'ArrowRight', 39);
  await sleep(250);
  const moved = await page.evaluate(`window.__t.tip()`);
  check('键盘：方向键沿墨线移动浮层',
    moved.visible && (moved.rect.left !== kb.rect.left || moved.rect.top !== kb.rect.top),
    JSON.stringify({ before: kb.rect, after: moved.rect }));
  await press('Escape', 'Escape', 27);
  await sleep(250);
  const escaped = await page.evaluate(`window.__t.tip()`);
  check('键盘：Escape 收起浮层', !escaped.visible, JSON.stringify(escaped));
  check('浮层带 role=tooltip 且 aria-hidden 会复位',
    await page.evaluate(`document.getElementById('route-tip').getAttribute('role') === 'tooltip'
      && document.getElementById('route-tip').getAttribute('aria-hidden') === 'true'`));
  return { tip, kb };
}
async function scenarioTouch(page) {
  await page.setViewport(390, 780, 3, true, true);
  await page.gotoRoute(BASE + '/?route=1&osm=1', 3600);
  await page.evaluate(`window.__t.setMode('taxi')`);
  await sleep(2000);
  const mid = await page.evaluate(`window.__t.routePoint(0.5)`);
  await page.touch('touchStart', mid.x, mid.y);
  await sleep(60);
  await page.touch('touchEnd', mid.x, mid.y);
  await sleep(400);
  const tip = await page.evaluate(`window.__t.tip()`);
  check('移动端：点按墨线出现浮层', tip.visible, JSON.stringify(tip.rect));
  check('移动端：浮层未超出地图范围', tip.inside, JSON.stringify({ rect: tip.rect, shell: tip.shell }));
  check('移动端：浮层仍给出六项读数',
    tip.rows.length >= 6, JSON.stringify(tip.rows));
  await page.screenshot(path.join(SHOT_DIR, 'after-06-mobile-tap.png'));
  return tip;
}

async function scenarioWidthStability(page) {
  await page.gotoRoute(BASE + '/?route=1&osm=1', 3200);
  await page.evaluate(`window.__t.setMode('taxi')`);
  await sleep(1500);
  const data = await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    const wasRunning = f.running;
    f.stop();
    f.reducedMotion = true;
    f.hover = 0; f.hoverTarget = 0;
    const idx = Math.max(4, Math.floor(f.points.length * 0.45));
    const out = { idx: idx, N: f.points.length, soft: {} };
    [0.6, 0.75, 0.9, 1].forEach(function (p) {
      f.progress = p;
      out.soft['p' + p] = window.__t.widthAt(idx, 8);
    });
    if (wasRunning) { f.reducedMotion = false; f.start(); }
    return out;
  })()`);
  const soft = Object.keys(data.soft).map((k) => data.soft[k]);
  const spread = (Math.max.apply(null, soft) - Math.min.apply(null, soft)) / Math.max(1, Math.max.apply(null, soft));
  check('已落定的位置：墨迹宽度不随整条线继续生长而反复变化（变化 ≤ 15%）', spread <= 0.15,
    'soft=' + JSON.stringify(data.soft) + ' spread=' + Math.round(spread * 100) + '%');
  check('宽度稳定性：测量到有效墨迹', Math.max.apply(null, soft) > 2, JSON.stringify(data.soft));
  return data;
}

async function scenarioFrameRate(page) {
  await page.gotoRoute(BASE + '/?route=1&osm=1', 3200);
  await page.evaluate(`window.__t.setMode('taxi')`);
  await sleep(1200);
  await page.setReducedMotion(false);
  const drive = (stepMs) => `(() => {
    const f = window.RiskTideApp.inkFlow;
    f.reducedMotion = false;
    const origRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = function () { return 0; };
    const route = window.RiskTideApp.ui.getActiveRoute(window.RiskTideApp.ui.getState());
    f.setRoute(route, { kind: 'road' });
    f.running = true; f.visible = true; f.lastTime = 0;
    let t = 4000, frames = 0;
    f.frame(t);
    while (f.progress < 1 && frames < 5000) { frames += 1; t += ${stepMs}; f.frame(t); }
    window.requestAnimationFrame = origRaf;
    f.stop();
    return { stepMs: ${stepMs}, frames: frames,
      seconds: Math.round(frames * ${stepMs} / 10) / 100,
      grow: window.RiskTideConfig.ink.route.growSeconds };
  })()`;
  const at60 = await page.evaluate(drive(16.7));
  const at10 = await page.evaluate(drive(100));
  const at4 = await page.evaluate(drive(250));
  check('写线时长按真实时间：60fps 下 ≈ growSeconds', approx(at60.seconds, at60.grow, at60.grow * 0.12),
    JSON.stringify(at60));
  check('写线时长按真实时间：10fps 下仍 ≈ growSeconds', approx(at10.seconds, at10.grow, at10.grow * 0.12),
    JSON.stringify(at10));
  check('写线时长按真实时间：4fps 下仍 ≈ growSeconds', approx(at4.seconds, at4.grow, at4.grow * 0.12),
    JSON.stringify(at4));
  const monotonic = await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    f.reducedMotion = false;
    const origRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = function () { return 0; };
    const route = window.RiskTideApp.ui.getActiveRoute(window.RiskTideApp.ui.getState());
    f.setRoute(route, { kind: 'road' });
    f.running = true; f.visible = true; f.lastTime = 0;
    let t = 9000, prev = 0, ok = true, jump = 0;
    f.frame(t);
    for (let i = 0; i < 200; i += 1) {
      t += 120;
      f.frame(t);
      if (f.progress < prev - 1e-6) ok = false;
      jump = Math.max(jump, f.progress - prev);
      prev = f.progress;
    }
    window.requestAnimationFrame = origRaf;
    f.stop();
    return { monotonic: ok, maxFrameJump: Math.round(jump * 1000) / 1000 };
  })()`);
  check('低帧率：进度单调递增且单帧跳变 ≤ 0.25', monotonic.monotonic && monotonic.maxFrameJump <= 0.25,
    JSON.stringify(monotonic));
  await page.evaluate(`window.RiskTideApp.inkFlow.start()`);
  return { at60, at10, at4, monotonic };
}
async function scenarioReducedMotion(browser) {
  const page = await newPage(browser, { width: 1280, height: 900, dsf: 1 });
  await page.setReducedMotion(true);
  await page.gotoRoute(BASE + '/?route=1&osm=1', 3600);
  await page.evaluate(`window.__t.setMode('taxi')`);
  await sleep(1200);
  const state = await page.evaluate(`window.__t.flowState()`);
  check('prefers-reduced-motion：不播放写线动画（progress = 1）', state && state.progress === 1,
    JSON.stringify(state));
  check('prefers-reduced-motion：仍绘制完整墨线', state && state.points > 40, JSON.stringify(state));
  const c = await page.evaluate(`window.__t.shellPoint(0.5, 0.5)`);
  await page.mouse('mousePressed', c.x, c.y, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse('mouseMoved', c.x - i * 20, c.y - i * 6, { button: 'left', buttons: 1 });
    await sleep(50);
  }
  await page.mouse('mouseReleased', c.x - 200, c.y - 60, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(300);
  const after = await page.evaluate(`window.__t.misalign()`);
  const state2 = await page.evaluate(`window.__t.flowState()`);
  check('prefers-reduced-motion：拖动后墨线仍与底图对齐（会按需重绘）',
    after !== null && after < 2, 'after=' + after);
  check('prefers-reduced-motion：progress 不跳变', state2 && state2.progress === 1);
  /* 减少动态模式：不做浸染动画，但墨色必须直接落到新风险（不能停在半途） */
  const beforeRisk = await page.evaluate(`(() => ({
    ink: window.__t.inkFingerprint(2),
    risk: Math.round(window.RiskTideApp.result().risk)
  }))()`);
  await page.evaluate(`(() => {
    const slider = document.getElementById('departure-slider');
    slider.value = '60';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(800);
  const afterRisk = await page.evaluate(`(() => ({
    ink: window.__t.inkFingerprint(2),
    risk: Math.round(window.RiskTideApp.result().risk)
  }))()`);
  const delta = Math.abs(beforeRisk.ink.rgb[0] - afterRisk.ink.rgb[0])
    + Math.abs(beforeRisk.ink.rgb[1] - afterRisk.ink.rgb[1])
    + Math.abs(beforeRisk.ink.rgb[2] - afterRisk.ink.rgb[2]);
  check('prefers-reduced-motion：改时间条件后墨色落到新风险色（不做动画但不卡在半途）',
    afterRisk.risk > beforeRisk.risk && delta > 10,
    JSON.stringify({ risk: [beforeRisk.risk, afterRisk.risk], rgb: [beforeRisk.ink.rgb, afterRisk.ink.rgb] }));
  await page.screenshot(path.join(SHOT_DIR, 'after-07-reduced-motion.png'));
  return { after };
}

async function scenarioPlanningFailures(page) {
  await page.gotoRoute(BASE + '/?route=1&osm=1', 3200);
  await page.evaluate(`window.__t.setMode('taxi')`);
  await sleep(1500);

  /* --- 先看"起终点没动、规划失败"：内置演示几何仍对应当前起终点，可以留着，
         但必须说明它不是本次规划结果 --- */
  await page.evaluate(`(() => {
    const map = window.RiskTideApp.map;
    map.supportsPlanning = function () { return true; };
    map.replanRoutes = function () {
      map.lastPlanError = '模拟：规划服务不可用';
      return Promise.resolve(null);
    };
    return 'ok';
  })()`);
  await page.evaluate(`window.RiskTideSearch.onSelect('origin',
    { id: 'campus', name: '无锡学院校门口', shortName: '无锡学院',
      coordinate: JSON.parse(JSON.stringify(window.RiskTideConfig.endpoints.campus.coordinate)) })`);
  await sleep(700);
  const kept = await page.evaluate(`(() => ({
    state: window.__t.flowState(),
    badge: window.__t.badge(),
    routes: window.__t.routes(),
    status: document.getElementById('status-line').textContent
  }))()`);
  check('规划失败（起终点未变）：内置演示几何仍在，且标注为"非本次规划结果"',
    kept.routes.taxi > 2 && kept.badge.kind === 'demo'
      && kept.badge.text.indexOf('内置演示几何') >= 0,
    JSON.stringify({ routes: kept.routes, badge: kept.badge }));
  check('规划失败（起终点未变）：状态行仍说明规划失败原因',
    kept.status.indexOf('规划失败') >= 0 && kept.status.indexOf('模拟：规划服务不可用') >= 0,
    kept.status);

  await page.gotoRoute(BASE + '/?route=1&osm=1', 3200);
  await page.evaluate(`window.__t.setMode('taxi')`);
  await sleep(1500);
  await page.evaluate(`(() => {
    const map = window.RiskTideApp.map;
    map.supportsPlanning = function () { return true; };
    map.replanRoutes = function () {
      map.lastPlanError = '模拟：高德路线规划失败(INVALID_USER_KEY)';
      return Promise.resolve(null);
    };
    return 'ok';
  })()`);
  await page.evaluate(`window.RiskTideSearch.onSelect('origin',
    { id: 'campus', name: '模拟起点', shortName: '模拟起点', coordinate: [120.47, 31.58] })`);
  await sleep(700);
  const failed = await page.evaluate(`(() => ({
    state: window.__t.flowState(),
    badge: window.__t.badge(),
    routes: window.__t.routes(),
    status: document.getElementById('status-line').textContent,
    warning: document.getElementById('route-warning').textContent,
    ink: window.__t.inkStats(110)
  }))()`);
  check('规划失败：墨线状态为 failed', failed.state && failed.state.kind === 'failed',
    JSON.stringify(failed.state));
  check('规划失败：明确显示失败原因', failed.status.indexOf('模拟：高德路线规划失败') >= 0, failed.status);
  check('规划失败：徽标说明未展示旧路线',
    failed.badge.hidden === false && failed.badge.text.indexOf('未展示旧路线') >= 0,
    JSON.stringify(failed.badge));
  check('规划失败：不保留旧道路几何', failed.routes.taxi === 0, JSON.stringify(failed.routes));
  check('规划失败：不沿用旧行程时间', failed.routes.routeMinutes === null, JSON.stringify(failed.routes));
  const variantStale = await page.evaluate(`(() => {
    const route = window.routes.taxi;
    if (!route.variants || !route.variants.length) return 0;
    return route.variants.filter(function (variant) {
      return Number(variant.durationMinutes) > 0 || (variant.coordinates || []).length > 0;
    }).length;
  })()`);
  check('规划失败：内置方案的时长 / 几何也一并失效（不残留 variant 数据）', variantStale === 0,
    'stale variants=' + variantStale);
  const failedWidth = await page.evaluate(
    `window.__t.widthAt(Math.floor(window.RiskTideApp.inkFlow.points.length * 0.5), 8)`);
  check('规划失败：画面上只剩细虚线（无水墨笔触宽度）', failedWidth < 5, failedWidth + 'px');
  check('规划失败：面板给出错误级告警', failed.warning.indexOf('规划失败') >= 0, failed.warning);
  await page.screenshot(path.join(SHOT_DIR, 'after-08-plan-failed.png'));

  await page.evaluate(`(() => {
    const map = window.RiskTideApp.map;
    let n = 0;
    map.replanRoutes = function (guard) {
      n += 1;
      const id = n;
      const delay = id === 1 ? 800 : 60;
      const coords = id === 1
        ? [[120.40, 31.60], [120.4005, 31.6005], [120.401, 31.601]]
        : [[120.50, 31.50], [120.5005, 31.4905], [120.501, 31.481]];
      return new Promise(function (resolve) {
        setTimeout(function () {
          if (guard && !guard()) { resolve(null); return; }
          const route = { id: 'taxi', label: '网约车', source: 'test-plan-' + id,
            coordinates: coords, durationMinutes: 10 + id, verified: true, coordinateSystem: 'WGS84' };
          window.routes.taxi = route;
          map.lastPlanError = '';
          if (typeof map.onRoutesReady === 'function') map.onRoutesReady({ taxi: route });
          resolve({ taxi: route });
        }, delay);
      });
    };
    return 'ok';
  })()`);
  await page.evaluate(`window.RiskTideSearch.onSelect('origin',
    { id: 'campus', name: 'A', shortName: 'A', coordinate: [120.44, 31.58] })`);
  await sleep(40);
  await page.evaluate(`window.RiskTideSearch.onSelect('origin',
    { id: 'campus', name: 'B', shortName: 'B', coordinate: [120.46, 31.575] })`);
  await sleep(1500);
  const ordered = await page.evaluate(`(() => ({
    inkSource: (window.RiskTideApp.inkFlow.route && window.RiskTideApp.inkFlow.route.source) || '',
    routeSource: window.routes.taxi.source,
    state: window.__t.flowState()
  }))()`);
  check('乱序响应：晚到的旧规划结果被丢弃（保留最新路线）',
    ordered.inkSource === 'test-plan-2' && ordered.routeSource === 'test-plan-2', JSON.stringify(ordered));
  check('乱序响应：新路线几何已绘制', ordered.state && ordered.state.kind === 'road' && ordered.state.points > 4,
    JSON.stringify(ordered.state));
  return { failed, ordered };
}
async function scenarioGeometry(page) {
  await page.gotoRoute(BASE + '/?route=1&osm=1', 3200);
  await page.evaluate(`window.__t.setMode('taxi')`);
  await sleep(1200);
  const out = await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    const map = window.RiskTideApp.map;
    const center = map.getEndpoints().campus.coordinate;
    const degenerate = [];
    const push = function (dx, dy) { degenerate.push([center[0] + dx, center[1] + dy]); };
    push(0, 0); push(0, 0); push(0.0000001, 0.0000001);
    push(0.004, 0); push(0.008, 0.001); push(0.012, 0.002);
    push(0.008, 0.001); push(0.004, 0.0002); push(0.0002, 0);
    push(0.002, 0.004); push(0.0025, 0.0045); push(0.002, 0.004);
    push(0.02, 0.02);
    const reports = {};
    const probe = function (name, coords) {
      f.stop();
      f.reducedMotion = true;
      f.setRoute({ id: 'taxi', label: '网约车', source: 'geometry-' + name,
        coordinates: coords, verified: false, coordinateSystem: 'WGS84' }, { kind: 'road' });
      f.draw();
      const env = window.__t.inkEnvelope(40);
      const bad = f.points.some(function (p) { return !Number.isFinite(p.x) || !Number.isFinite(p.y); });
      reports[name] = { points: f.points.length, degenerate: f.degenerate, env: env, nonFinite: bad };
    };
    probe('hairpin', degenerate);
    probe('two-points', [center, [center[0] + 0.004, center[1] + 0.003]]);
    probe('identical', [center, center.slice()]);
    probe('single', [center]);
    probe('short', [[center[0], center[1]], [center[0] + 0.00001, center[1] + 0.00001]]);
    f.reducedMotion = false;
    f.start();
    return reports;
  })()`);
  const hairpin = out.hairpin;
  /* 包络上限 = 最外层墨体半宽 × 最大压力/呼吸/边缘修饰 + 飞白外扩（≈46px）。
     尖刺/自交会远大于这个数，所以这里照样能抓住几何瑕疵。 */
  check('异常几何（折返 / 重复点 / 极短段）：无尖刺，墨迹不出包络（≤ 46px）',
    hairpin.env.ok && hairpin.env.worst <= 46, JSON.stringify(hairpin.env));
  check('异常几何：坐标全部有限', !hairpin.nonFinite, JSON.stringify({ bad: hairpin.nonFinite }));
  check('异常几何：折返处仍生成稳定笔触', hairpin.points >= 2 && hairpin.points < 4000,
    String(hairpin.points));
  check('异常几何：两点路线可正常绘制',
    out['two-points'].points >= 2 && !out['two-points'].nonFinite, JSON.stringify(out['two-points']));
  check('异常几何：起终点重合不画线也不报错',
    out.identical.degenerate === true && out.identical.points === 0,
    JSON.stringify({ points: out.identical.points, degenerate: out.identical.degenerate }));
  check('异常几何：单点路线不报错', out.single.points === 0, JSON.stringify(out.single));
  await page.evaluate(`window.__t.setMode('bus')`);
  await sleep(500);
  await page.evaluate(`window.__t.setMode('taxi')`);
  await sleep(1500);
  const alive = await page.evaluate(`(() => { const f = window.RiskTideApp.inkFlow;
    return { kind: f.kind, points: f.points.length }; })()`);
  check('异常几何注入后：真实路线可以重新绘制', alive.kind === 'road' && alive.points > 40,
    JSON.stringify(alive));
  return out;
}

async function scenarioDpr(browser) {
  const page = await newPage(browser, { width: 1280, height: 900, dsf: 2 });
  await page.gotoRoute(BASE + '/?route=1&osm=1', 3600);
  await page.evaluate(`window.__t.setMode('taxi')`);
  await sleep(1800);
  const hd = await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    const cv = document.getElementById('silk-canvas');
    const r = cv.getBoundingClientRect();
    return { dpr: window.devicePixelRatio, flowDpr: f.dpr,
      ratio: Math.round(cv.width / r.width * 100) / 100, misalign: window.__t.misalign() };
  })()`);
  const dprCap = hd.flowDpr;
  check('高 DPR：画布后备尺寸 = CSS 尺寸 × DPR 上限',
    approx(hd.ratio, dprCap, 0.02) && dprCap >= 1.5, JSON.stringify(hd));
  check('高 DPR：墨线与底图对齐', hd.misalign !== null && hd.misalign < 2, 'misalign=' + hd.misalign);
  const glowDpr = await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    const cv = document.getElementById('ink-glow-canvas');
    const r = cv.getBoundingClientRect();
    return { ratio: Math.round(cv.width / r.width * 100) / 100, cap: f.dpr };
  })()`);
  check('高 DPR：芯光层与墨层分辨率一致',
    Math.abs(glowDpr.ratio - glowDpr.cap) < 0.02, JSON.stringify(glowDpr));
  await page.screenshot(path.join(SHOT_DIR, 'after-09-dpr2.png'));

  await page.setViewport(1280, 900, 1, false, false);
  await page.evaluate(`(() => { const f = window.RiskTideApp.inkFlow;
    f.routeDirty = true; if (f.requestFrame) f.requestFrame(); return 'ok'; })()`);
  await sleep(500);
  const after = await page.evaluate(`(() => {
    const cv = document.getElementById('silk-canvas');
    const r = cv.getBoundingClientRect();
    return { ratio: Math.round(cv.width / r.width * 100) / 100, misalign: window.__t.misalign() };
  })()`);
  check('DPR 变化后：主动重建画布并保持对齐',
    after.ratio <= 1.001 && after.misalign !== null && after.misalign < 2, JSON.stringify(after));
  return { hd, after };
}
/* ---------------- 高德（生产）渲染路径 -------------------------------------
   Key 有域名白名单，本机拿不到高德的规划结果，所以这条路测的是**渲染路径**：
   注入真实道路几何（WGS84，由控制器转 GCJ02），验证高德投影 / 连续移动事件 /
   浮层 / 失败态在真实高德底图上都成立。需要外网；没有外网时明确标记跳过。 */
async function scenarioAmap(browser) {
  const page = await newPage(browser, { width: 1280, height: 900, dsf: 1 });
  await page.gotoRoute(BASE + '/?route=1&amap=1', 4000);
  await sleep(1500);
  const loaded = await page.evaluate(`!!window.AMap`);
  if (!loaded) {
    skip('高德路径：全部检查', '本机无法访问 webapi.amap.com（离线或沙箱无外网）');
    return null;
  }
  for (let i = 0; i < 40; i += 1) {
    const ok = await page.evaluate(`(() => { const m = window.RiskTideApp.map;
      return !!(m && m.ready); })()`);
    if (ok) break;
    await sleep(500);
  }
  const boot = await page.evaluate(`(() => { const m = window.RiskTideApp.map;
    return { controller: m.constructor.name, ready: !!m.ready, fallback: !!m.fallback,
      supportsPlanning: typeof m.supportsPlanning === 'function' ? m.supportsPlanning() : null }; })()`);
  check('高德路径：使用高德控制器且底图就绪',
    boot.controller === 'RiskTideAmapMap' && boot.ready && !boot.fallback, JSON.stringify(boot));

  /* 注入真实道路几何（WGS84 → 控制器内部转 GCJ02），让高德渲染路径画出真实墨线 */
  const injected = await page.evaluate(`(() => {
    const app = window.RiskTideApp, map = app.map, ui = app.ui;
    const base = map.getEndpoints().campus.coordinate;
    const coords = [];
    for (let i = 0; i <= 44; i += 1) {
      coords.push([
        base[0] + i * 0.00042 + Math.sin(i / 3.5) * 0.00055,
        base[1] + i * 0.00034 + Math.cos(i / 4) * 0.00042
      ]);
    }
    const route = { id: 'taxi', label: '网约车', source: 'amap-path-test',
      coordinates: coords, coordinateSystem: 'WGS84', durationMinutes: 12,
      verified: false, variants: [] };
    window.routes.taxi = route;
    ui.state.mode = 'taxi';
    ui.state.variantId = null;
    ui.state.routeMinutes = 12;
    ui.update();
    map.setRoute(route);
    return map.getScreenPath(coords, 'WGS84').filter(function (p) {
      return p && Number.isFinite(p.x);
    }).length;
  })()`);
  await sleep(900);
  const ink = await page.evaluate(`window.RiskTideApp.inkFlow.getState()`);
  check('高德路径：真实几何判定为 road 并完成投影（WGS84→GCJ02）',
    ink && ink.kind === 'road' && ink.points > 40 && injected > 40,
    JSON.stringify({ ink: ink, projected: injected }));

  /* 独立检查：控制器坐标 → GCJ02 → 高德投影，是否落在高德自己摆放的 marker 上 */
  const anchor = await page.evaluate(`(() => {
    const map = window.RiskTideApp.map;
    const shell = document.getElementById('map-shell').getBoundingClientRect();
    const eps = map.getEndpoints();
    const p = map.getScreenPath([eps.station.coordinate], 'WGS84')[0];
    const el = document.querySelector('.station-marker');
    if (!p || !el) return null;
    const r = el.getBoundingClientRect();
    return { dx: Math.round((p.x - (r.left + r.width / 2 - shell.left)) * 100) / 100,
      dy: Math.round((p.y - (r.bottom - shell.top)) * 100) / 100 };
  })()`);
  check('高德路径：WGS84→GCJ02 投影与高德 marker 重合（≤3px）',
    anchor && Math.abs(anchor.dx) <= 3 && Math.abs(anchor.dy) <= 3, JSON.stringify(anchor));

  /* 拖动：高德只给 movestart/mapmove/moveend，靠新增的连续事件跟随 */
  const misalignExpr = `(() => {
    const f = window.RiskTideApp.inkFlow, map = window.RiskTideApp.map;
    const coords = f.getRouteCoordinates();
    if (!coords || f.points.length < 2) return null;
    const p = map.getScreenPath(coords, f.route && f.route.coordinateSystem);
    const a = p[p.length - 1], b = f.points[0];
    return (a && b) ? Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 100) / 100 : null;
  })()`;
  const c = await page.evaluate(`window.__t.shellPoint(0.5, 0.5)`);
  const drag = [];
  await page.mouse('mousePressed', c.x, c.y, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse('mouseMoved', c.x - i * 16, c.y - i * 5, { button: 'left', buttons: 1 });
    await sleep(70);
    drag.push(await page.evaluate(misalignExpr));
  }
  await page.mouse('mouseReleased', c.x - 160, c.y - 50, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(500);
  const dragSettled = await page.evaluate(misalignExpr);
  const dragMax = Math.max.apply(null, drag.filter((v) => v !== null));
  check('高德路径：拖动中墨线跟随（≤ 4px，一帧以内）', dragMax < 4, 'max=' + dragMax + 'px');
  check('高德路径：拖动结束后完全对齐（< 1px）', dragSettled !== null && dragSettled < 1,
    'settled=' + dragSettled);

  const z = await page.evaluate(`window.__t.shellPoint(0.5, 0.3)`);
  const zooms = [];
  for (let i = 0; i < 3; i += 1) {
    await page.browser.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: z.x, y: z.y, deltaX: 0, deltaY: -160, button: 'none', buttons: 0
    }, page.sessionId);
    await sleep(200);
    zooms.push(await page.evaluate(misalignExpr));
  }
  await sleep(700);
  const zoomSettled = await page.evaluate(misalignExpr);
  const zoomMax = Math.max.apply(null, zooms.filter((v) => v !== null));
  check('高德路径：缩放中墨线跟随（≤ 4px）', zoomMax < 4, 'max=' + zoomMax + 'px');
  check('高德路径：缩放结束后完全对齐（< 1px）', zoomSettled !== null && zoomSettled < 1,
    'settled=' + zoomSettled);

  /* 悬停浮层 */
  const mid = await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    if (!f || f.points.length < 2) return null;
    const p = f.points[Math.floor(f.points.length * 0.5)];
    const r = document.getElementById('silk-canvas').getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  })()`);
  if (mid) {
    await page.mouse('mouseMoved', mid.x, mid.y);
    await sleep(450);
  }
  const tip = await page.evaluate(`window.__t.tip()`);
  check('高德路径：悬停浮层给出六项读数且不越界',
    tip.visible && tip.inside && tip.rows.length >= 6, JSON.stringify({ rows: tip.rows, inside: tip.inside }));

  /* 规划失败（本机是常态：Key 域名白名单）→ 必须不显示旧路线 */
  await page.evaluate(`(() => {
    const map = window.RiskTideApp.map;
    map.supportsPlanning = function () { return true; };
    map.lastPlanError = '模拟：高德规划服务不可用';
    map.replanRoutes = function () { return Promise.resolve(null); };
    window.RiskTideSearch.onSelect('origin',
      { id: 'campus', name: 'X', shortName: 'X', coordinate: [120.5, 31.6] });
    return 'ok';
  })()`);
  await sleep(800);
  const failed = await page.evaluate(`(() => ({
    ink: window.RiskTideApp.inkFlow.getState(),
    badge: window.__t.badge(),
    status: document.getElementById('status-line').textContent,
    coords: (window.routes.taxi.coordinates || []).length
  }))()`);
  check('高德路径：规划失败后不显示旧路线',
    failed.coords === 0 && failed.ink.kind === 'failed' && failed.badge.kind === 'failed',
    JSON.stringify({ coords: failed.coords, kind: failed.ink.kind, badge: failed.badge.kind }));
  await page.screenshot(path.join(SHOT_DIR, 'amap-04-real-ink.png'));
  return boot;
}

/* ---------------- 路线一变，墨线必须跟着变（画布层取证） ------------------
   每一步都用【画布上真实画出来的墨迹】的指纹（包围盒中心/尺寸 + 像素量 + 平均色）
   和【当前中轴线】比对，确保不是"内部状态变了、画面没变"。 */
async function scenarioRouteChange(page) {
  await page.gotoRoute(BASE + '/?route=1&osm=1', 3400);
  await page.evaluate(`window.__t.hideOverlays()`);
  /* 关掉写线动画，让每次切换立即成型，把焦点放在"有没有换几何"上 */
  await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    f.reducedMotion = true;
    return 'ok';
  })()`);
  await page.evaluate(`window.__t.setMode('taxi')`);
  await sleep(900);

  const snap = async function (label) {
    await sleep(320);
    const data = await page.evaluate(`(() => ({
      ink: window.__t.inkFingerprint(2),
      center: window.__t.centerBox(),
      state: window.RiskTideApp.inkFlow.getState(),
      source: (window.RiskTideApp.inkFlow.route && window.RiskTideApp.inkFlow.route.source) || '',
      variant: window.RiskTideApp.ui.getState().variantId,
      risk: Math.round(window.RiskTideApp.result() ? window.RiskTideApp.result().risk : -1)
    }))()`);
    data.label = label;
    return data;
  };
  const near = function (a, b, tolerance) {
    return a && b && Math.abs(a.cx - b.cx) <= tolerance && Math.abs(a.cy - b.cy) <= tolerance;
  };
  /* 墨迹是否画在当前几何上：必须覆盖中轴线，且不得甩出笔触宽度之外。
     比"包围盒中心距离"稳健——粗笔触（有收笔、有鼓瘪）的包围盒天然是不对称的。 */
  const onGeometry = function (ink, center, slack) {
    if (!ink || !center || !ink.count || !center.points) return false;
    const pad = slack === undefined ? 26 : slack;
    return ink.l <= center.l + 2 && ink.r >= center.r - 2
      && ink.t <= center.t + 2 && ink.b >= center.b - 2
      && ink.l >= center.l - pad && ink.r <= center.r + pad
      && ink.t >= center.t - pad && ink.b <= center.b + pad;
  };
  const colourDelta = function (a, b) {
    if (!a || !b || !a.rgb || !b.rgb) return 0;
    return Math.abs(a.rgb[0] - b.rgb[0]) + Math.abs(a.rgb[1] - b.rgb[1]) + Math.abs(a.rgb[2] - b.rgb[2]);
  };

  const base = await snap('起始：网约车 osrm-fast');
  check('切换前：画出来的墨迹就是当前几何（中心偏差 ≤8px）',
    base.ink.count > 200 && onGeometry(base.ink, base.center, 30),
    JSON.stringify({ ink: base.ink, center: base.center }));
  check('切换前：风险色为低风险淡墨', base.risk >= 0 && base.risk < 30, 'risk=' + base.risk);

  /* ① 同一种交通方式内换方案（几何来自不同数据源，形状不同） */
  const variants = await page.evaluate(`window.RiskTideApp.ui.routeMap.taxi.variants.map(function (v) { return v.id; })`);
  check('网约车提供多个方案可供切换', variants.length >= 2, JSON.stringify(variants));
  const variantSteps = [];
  for (let i = 1; i < variants.length; i += 1) {
    await page.evaluate(`(() => {
      const ui = window.RiskTideApp.ui;
      ui.selectVariant(${JSON.stringify(variants[i])});
      return 'ok';
    })()`);
    const shot = await snap('方案 ' + variants[i]);
    variantSteps.push(shot);
    check('换方案（' + variants[i] + '）：画布墨迹随之改变',
      shot.ink.count > 200 && (Math.abs(shot.ink.cx - base.ink.cx) > 3
        || Math.abs(shot.ink.cy - base.ink.cy) > 3 || Math.abs(shot.ink.count - base.ink.count) > 40),
      JSON.stringify({ before: { cx: base.ink.cx, cy: base.ink.cy, count: base.ink.count },
        after: { cx: shot.ink.cx, cy: shot.ink.cy, count: shot.ink.count },
        variant: shot.variant, source: shot.source }));
    check('换方案（' + variants[i] + '）：画出来的墨迹与新几何一致（≤8px）',
      onGeometry(shot.ink, shot.center, 30), JSON.stringify({ ink: shot.ink, center: shot.center }));
  }
  /* 回到第一个方案，确认能切回来 */
  await page.evaluate(`window.RiskTideApp.ui.selectVariant(${JSON.stringify(variants[0])})`);
  const back = await snap('回到 ' + variants[0]);
  check('切回第一个方案：墨迹回到原来的位置（与起始中心差 ≤8px）',
    back.ink.count > 200 && near(back.ink, base.ink, 8),
    JSON.stringify({ start: base.ink, back: back.ink }));

  /* ② 换交通方式：真实道路 → 无几何示意 → 真实道路 */
  await page.evaluate(`window.__t.setMode('bus')`);
  const bus = await snap('公交（无几何）');
  check('切到无几何方式：墨线不再是水墨实笔（像素量骤降、无墨骨宽度）',
    bus.state.kind === 'preview' && bus.ink.count > 0 && bus.ink.count < base.ink.count * 0.5,
    JSON.stringify({ kind: bus.state.kind, count: bus.ink.count, base: base.ink.count }));
  check('切到无几何方式：画出来的是起终点示意（与起终点连线中心一致 ≤8px）',
    onGeometry(bus.ink, bus.center, 12), JSON.stringify({ ink: bus.ink, center: bus.center }));

  await page.evaluate(`window.__t.setMode('taxi')`);
  const taxiAgain = await snap('切回网约车');
  check('切回真实路线：水墨实笔恢复且位置正确',
    taxiAgain.state.kind === 'road' && onGeometry(taxiAgain.ink, taxiAgain.center, 30),
    JSON.stringify({ kind: taxiAgain.state.kind, ink: taxiAgain.ink, center: taxiAgain.center }));

  /* ③ 起终点变化 → 规划返回另一条路（异步链路） */
  await page.evaluate(`(() => {
    const app = window.RiskTideApp, map = app.map;
    map.supportsPlanning = function () { return true; };
    map.replanRoutes = function (guard) {
      const eps = map.getEndpoints();
      const o = eps.campus.coordinate;
      const coords = [];
      for (let i = 0; i <= 40; i += 1) {
        coords.push([o[0] + i * 0.00030 + Math.sin(i / 4) * 0.0004,
          o[1] + 0.010 + i * 0.00026 + Math.cos(i / 3) * 0.0003]);
      }
      const route = { id: 'taxi', label: '网约车', source: 'routechange-plan',
        coordinates: coords, coordinateSystem: 'WGS84', durationMinutes: 15,
        verified: false, variants: [] };
      return new Promise(function (resolve) {
        setTimeout(function () {
          if (guard && !guard()) { resolve(null); return; }
          window.routes.taxi = route;
          map.setRoute(route);
          if (typeof map.onRoutesReady === 'function') map.onRoutesReady({ taxi: route });
          resolve({ taxi: route });
        }, 120);
      });
    };
    return 'ok';
  })()`);
  await page.evaluate(`window.RiskTideSearch.onSelect('origin',
    { id: 'campus', name: '换起点', shortName: '换起点', coordinate: [120.48, 31.58] })`);
  await sleep(900);
  const moved = await snap('换起终点 + 新规划');
  check('换起终点并规划成功：墨线画到了新路线上（中心位移 > 30px 且与几何一致 ≤8px）',
    moved.state.kind === 'road'
      && Math.hypot(moved.ink.cx - taxiAgain.ink.cx, moved.ink.cy - taxiAgain.ink.cy) > 30
      && onGeometry(moved.ink, moved.center, 30),
    JSON.stringify({ before: taxiAgain.ink, after: moved.ink, center: moved.center }));

  /* ④ 只改时间条件（风险）：几何必须纹丝不动、墨色必须跟着变深。
     注意这一条只能在"行程时间有效"的状态下测——没有有效路线时间时风险本就无效，
     墨线保持淡墨是正确行为，不是 bug。 */
  await page.screenshot(path.join(SHOT_DIR, 'routechange-same-geometry-safe.png'));
  const sliderBefore = await page.evaluate(`(() => ({
    rgb: window.__t.inkFingerprint(2).rgb,
    risk: window.RiskTideApp.result() ? window.RiskTideApp.result().risk : null,
    routeMinutes: window.RiskTideApp.ui.getState().routeMinutes
  }))()`);
  await page.evaluate(`(() => {
    const slider = document.getElementById('departure-slider');
    slider.value = '60';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(700);
  const risky = await snap('高风险');
  const colourDeltaAfter = Math.abs(risky.ink.rgb[0] - sliderBefore.rgb[0])
    + Math.abs(risky.ink.rgb[1] - sliderBefore.rgb[1])
    + Math.abs(risky.ink.rgb[2] - sliderBefore.rgb[2]);
  /* 几何稳定性看**中轴线**（风险会合法地把笔触加粗，所以墨迹包围盒允许变大，
     但中轴线与落笔位置必须一动不动）。 */
  check('只改时间条件：中轴线完全不动（几何未重画，中心/尺寸变化 ≤2px）',
    risky.center.points === moved.center.points
      && Math.abs(risky.center.cx - moved.center.cx) <= 2
      && Math.abs(risky.center.cy - moved.center.cy) <= 2
      && Math.abs(risky.center.w - moved.center.w) <= 2
      && Math.abs(risky.center.h - moved.center.h) <= 2,
    JSON.stringify({ before: moved.center, after: risky.center }));
  check('只改时间条件：墨迹位置不变（风险只加粗、不挪位；容差按笔宽）',
    Math.abs(risky.ink.cx - moved.ink.cx) <= 6 && Math.abs(risky.ink.cy - moved.ink.cy) <= 6
      && risky.ink.w >= moved.ink.w - 2,
    JSON.stringify({ before: moved.ink, after: risky.ink }));
  check('只改时间条件：墨色随风险连续变化（青蓝→金→赤，行程时间有效时）',
    sliderBefore.routeMinutes > 0 && risky.risk > 70 && colourDeltaAfter > 10,
    JSON.stringify({ routeMinutes: sliderBefore.routeMinutes, risk: [sliderBefore.risk, risky.risk],
      rgb: [sliderBefore.rgb, risky.ink.rgb] }));
  await page.screenshot(path.join(SHOT_DIR, 'routechange-same-geometry-risky.png'));

  /* ⑤ 规划失败：旧路线的墨迹不得留在画布上 */
  await page.evaluate(`(() => {
    const map = window.RiskTideApp.map;
    map.lastPlanError = '模拟：规划服务中断';
    map.replanRoutes = function () { return Promise.resolve(null); };
    window.RiskTideSearch.onSelect('origin',
      { id: 'campus', name: '失败起点', shortName: '失败起点', coordinate: [120.42, 31.62] });
    return 'ok';
  })()`);
  await sleep(900);
  const broken = await snap('规划失败');
  check('规划失败：画布上不再有旧路线的墨迹（与旧几何中心相隔 > 30px，且落在起终点示意上）',
    broken.state.kind === 'failed'
      && Math.hypot(broken.ink.cx - risky.ink.cx, broken.ink.cy - risky.ink.cy) > 30
      && onGeometry(broken.ink, broken.center, 30),
    JSON.stringify({ old: risky.ink, now: broken.ink, center: broken.center }));
  return { base: base, variants: variantSteps, bus: bus, moved: moved, risky: risky, broken: broken };
}

/* ---------------- 静止态的"墨在流动" ---------------------------------------
   要求：墨体宽度/墨迹量随时间缓缓变化（肉眼可见的流动），
   但中轴线绝不动（是流动不是抖动）；prefers-reduced-motion 下完全静止。 */
async function scenarioFlow(page) {
  await page.gotoRoute(BASE + '/?route=1&osm=1', 3400);
  await page.evaluate(`window.__t.setMode('taxi')`);
  await sleep(1400);
  /* 写线结束后再看静止态：等动画走完 */
  /* headless 下新建的标签页可能是后台页（document.hidden = true），
     不置前/不强制可见的话动画根本不会跑 —— 这里两件都做，保证测的是渲染本身。 */
  await page.browser.send('Page.bringToFront', {}, page.sessionId);
  /* 确定性方向断言：把流动高光临时收成 1 段、速度调成 0.1/s，
     这样它在采样区间内不会回绕，位置 t 必须单调递增（终点 → 起点）。 */
  await page.evaluate(`(() => {
    const core = window.RiskTideConfig.ink.route.core;
    core.veinAlpha = 0.12;          // 临时压暗主脉：这样"亮像素"只可能是高光
    core.filament.count = 0;
    const cfg = core.highlight;
    cfg.count = 1;
    cfg.speed = 0.1;
    cfg.speedRisk = 0;
    return 'ok';
  })()`);
  await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    f.setVisible(true);
    f.reducedMotion = false;
    f.progress = 1;
    f.elapsed = 0;
    f.lastTime = 0;
    f.start();
    return 'ok';
  })()`);
  await sleep(2500);

  const sample = async function () {
    return page.evaluate(`(() => {
      const f = window.RiskTideApp.inkFlow;
      const idx = Math.max(4, Math.floor(f.points.length * 0.45));
      const soft = window.__t.widthAt(idx, 8);
      const stats = window.__t.inkStats(8);
      const glow = window.__t.glowStats(8);          // 主光脉 + 柔光：应当持续存在
      const bright = window.__t.brightTrack(150);    // 冷白高光（主脉已压暗，150 只圈到高光）
      const box = window.__t.centerBox();
      const cv = document.getElementById('silk-canvas');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const p = f.points[idx];
      const px = Math.round(p.x * (cv.width / cv.getBoundingClientRect().width));
      const py = Math.round(p.y * (cv.height / cv.getBoundingClientRect().height));
      const oi = (py * cv.width + px) * 4;
      const bodyRgb = [d[oi], d[oi + 1], d[oi + 2]];
      return { soft: soft, pixels: stats.count, meanAlpha: stats.meanAlpha, glow: glow.count, bright: bright.count, brightT: bright.t,
        bodyRgb: bodyRgb,
        box: [box.l, box.t, box.r, box.b], elapsed: Math.round(f.elapsed * 10) / 10 };
    })()`);
  };
  const samples = [];
  for (let i = 0; i < 4; i += 1) {
    samples.push(await sample());
    await sleep(1100);
  }
  const widths = samples.map((s) => s.soft);
  const pixels = samples.map((s) => s.pixels);
  const spread = (Math.max.apply(null, widths) - Math.min.apply(null, widths)) / Math.max(1, Math.max.apply(null, widths));
  const pixelSpread = (Math.max.apply(null, pixels) - Math.min.apply(null, pixels)) / Math.max(1, Math.max.apply(null, pixels));
  const sameBox = samples.every((s) => s.box.join(',') === samples[0].box.join(','));

  /* 真正会流动的是两样东西：① 光在笔画里游走（柔光像素量涨落）② 墨体轮廓的缓慢鼓动。
     飞白的横向偏移不随呼吸变化，所以"像素量"只小幅波动，光斑才是主要观感。 */
  const glows = samples.map((s) => s.glow);
  const brights = samples.map((s) => s.bright);
  const glowSpread = (Math.max.apply(null, glows) - Math.min.apply(null, glows)) / Math.max(1, Math.max.apply(null, glows));
  const brightSpread = (Math.max.apply(null, brights) - Math.min.apply(null, brights)) / Math.max(1, Math.max.apply(null, brights));
  /* 规范要求：主光脉"持续存在"（总量基本恒定），只有冷白高光沿笔画单向推进。 */
  check('静止态流动：主光脉持续存在（柔光像素量基本恒定，波动 ≤ 12%）', glowSpread <= 0.12 && glows[0] > 500,
    'glow=' + JSON.stringify(glows) + ' spread=' + Math.round(glowSpread * 100) + '%');
  const brightTs = samples.map((s) => s.brightT);
  const tracked = brightTs.every((t) => t !== null) ? brightTs : null;
  check('静止态流动：冷白高光单向推进（亮段位置 t 递增、总位移 > 0.05）',
    tracked && tracked[tracked.length - 1] - tracked[0] > 0.05
      && tracked.every((t, i) => i === 0 || t >= tracked[i - 1] - 0.002),
    'brightT=' + JSON.stringify(brightTs) + ' count=' + JSON.stringify(brights));
  /* 新契约：主体"轮廓稳定、同色相明暗呼吸"——像素量基本不变，变化体现在平均亮度（RGB）上。 */
  const alphas = samples.map((s) => s.meanAlpha);
  const alphaSpread = (Math.max.apply(null, alphas) - Math.min.apply(null, alphas)) / Math.max(1, Math.max.apply(null, alphas));
  check('静止态流动：轮廓稳定（墨迹像素量波动 ≤ 2%）', pixelSpread <= 0.02,
    'pixels=' + JSON.stringify(pixels) + ' spread=' + Math.round(pixelSpread * 100) + '%');
  const bodyRgbs = samples.map((s) => s.bodyRgb);
  const bodySums = bodyRgbs.map((rgb) => (rgb ? rgb[0] + rgb[1] + rgb[2] : 0));
  const bodySpread = (Math.max.apply(null, bodySums) - Math.min.apply(null, bodySums)) / Math.max(1, Math.max.apply(null, bodySums));
  check('静止态流动：同色相明暗在缓慢呼吸（平均亮度波动 ≥ 0.4%）', bodySpread >= 0.004,
    'bodyRGB=' + JSON.stringify(bodyRgbs) + ' spread=' + Math.round(bodySpread * 1000) / 10 + '%');
  check('静止态流动：幅度克制（宽度变化 ≤ 25%，不是闪烁）', spread <= 0.25,
    'spread=' + Math.round(spread * 100) + '%');
  check('静止态流动：中轴线纹丝不动（是流动不是抖动）', sameBox,
    JSON.stringify(samples.map((s) => s.box)));
  check('静止态流动：时间确实在推进（elapsed 递增）',
    samples[3].elapsed > samples[0].elapsed, JSON.stringify(samples.map((s) => s.elapsed)));
  await page.screenshot(path.join(SHOT_DIR, 'flow-settled.png'));

  /* prefers-reduced-motion：画面必须完全静止 */
  await page.setReducedMotion(true);
  await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    f.reducedMotion = true;
    f.elapsed = 0;
    f.lastTime = 0;
    f.draw();
    return 'ok';
  })()`);
  const still1 = await sample();
  await sleep(1300);
  const still2 = await sample();
  check('静止态流动：prefers-reduced-motion 下完全静止（两次采样一致）',
    still1.soft === still2.soft && still1.pixels === still2.pixels,
    JSON.stringify({ a: still1.soft, b: still2.soft, pa: still1.pixels, pb: still2.pixels }));
  return { samples, spread, pixelSpread, glowSpread, alphaSpread };
}

async function scenarioNation(browser) {
  const page = await newPage(browser, { width: 1280, height: 900, dsf: 1 });
  await page.gotoRoute(BASE + '/', 4000);
  const nation = await page.evaluate(`(() => {
    const app = window.RiskTideApp;
    const cv = document.getElementById('nation-canvas');
    const ctx = cv.getContext('2d');
    const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let ink = 0;
    for (let i = 3; i < img.length; i += 4) if (img[i] >= 8) ink += 1;
    return {
      inkFlow: !!app.inkFlow,
      nationInk: !!app.nationInk,
      cities: app.nationInk ? app.nationInk.getMetrics().cities : 0,
      rows: app.nationInk ? app.nationInk.rows.length : 0,
      inkPixels: ink,
      legend: document.querySelector('.map-legend').textContent.replace(/\\s+/g, ' ').trim(),
      badgeHidden: document.getElementById('route-authenticity').hidden,
      tipVisible: document.getElementById('route-tip').classList.contains('is-visible'),
      metrics: document.getElementById('metrics').textContent,
      view: (document.querySelector('.view-nav [aria-current="page"]') || {}).textContent || ''
    };
  })()`);
  check('全国模式：仍用全国墨场渲染器（未启用单程墨线）',
    nation.nationInk && !nation.inkFlow,
    JSON.stringify({ nationInk: nation.nationInk, inkFlow: nation.inkFlow }));
  check('全国模式：43 座城市数据完整', nation.cities === 43 && nation.rows === 43, String(nation.cities));
  check('全国模式：墨场确实绘制（画布上有墨迹）', nation.inkPixels > 2000, 'inkPixels=' + nation.inkPixels);
  check('全国模式：图例仍是宽裕 / 紧迫',
    nation.legend.indexOf('宽裕') >= 0 && nation.legend.indexOf('紧迫') >= 0, nation.legend);
  check('全国模式：真实性徽标与墨线浮层都不出现',
    nation.badgeHidden === true && nation.tipVisible === false, JSON.stringify(nation));
  check('全国模式：默认选中"全国潮汐"', nation.view.indexOf('全国') >= 0, nation.view);
  check('全国模式：页脚指标为全国墨场', nation.metrics.indexOf('全国墨场') >= 0, nation.metrics);
  await page.screenshot(path.join(SHOT_DIR, 'after-10-nation.png'));
  return nation;
}

/* ---------------- 屏幕矩阵：常见桌面 / 窄屏手机 / 高 DPR -------------------
   每个视口都独立加载一次，检查画布分辨率、投影对齐、浮层与徽标不越界、无横向溢出。 */
async function scenarioViewports(browser) {
  const matrix = [
    { name: '1920×1080 · DPR1', w: 1920, h: 1080, dsf: 1, mobile: false, touch: false },
    { name: '1366×768 · DPR1.25', w: 1366, h: 768, dsf: 1.25, mobile: false, touch: false },
    { name: '768×1024 · DPR2（平板）', w: 768, h: 1024, dsf: 2, mobile: false, touch: true },
    { name: '390×844 · DPR3（手机）', w: 390, h: 844, dsf: 3, mobile: true, touch: true },
    { name: '320×568 · DPR2（窄屏）', w: 320, h: 568, dsf: 2, mobile: true, touch: true }
  ];
  for (let i = 0; i < matrix.length; i += 1) {
    const view = matrix[i];
    const page = await newPage(browser, {
      width: view.w, height: view.h, dsf: view.dsf, mobile: view.mobile, touch: view.touch
    });
    await page.gotoRoute(BASE + '/?route=1&osm=1', 3400);
    await page.evaluate(`window.__t.setMode('taxi')`);
    await sleep(1400);
    const state = await page.evaluate(`(() => {
      const f = window.RiskTideApp.inkFlow;
      const cv = document.getElementById('silk-canvas');
      const rect = cv.getBoundingClientRect();
      const shell = document.getElementById('map-shell').getBoundingClientRect();
      return {
        kind: f.getState().kind,
        points: f.getState().points,
        ratio: Math.round(cv.width / rect.width * 100) / 100,
        dprCap: f.dpr,
        misalign: window.__t.misalign(),
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
        canvasInShell: Math.abs(rect.left - shell.left) < 1.5 && Math.abs(rect.top - shell.top) < 1.5
          && Math.abs(rect.right - shell.right) < 1.5 && Math.abs(rect.bottom - shell.bottom) < 1.5
      };
    })()`);
    check('视口 ' + view.name + '：真实墨线绘制且与底图对齐',
      state.kind === 'road' && state.points > 40 && state.misalign !== null && state.misalign < 2,
      JSON.stringify(state));
    check('视口 ' + view.name + '：画布覆盖地图区域且分辨率匹配 DPR 上限',
      state.canvasInShell && Math.abs(state.ratio - state.dprCap) < 0.02,
      JSON.stringify({ ratio: state.ratio, cap: state.dprCap, inShell: state.canvasInShell }));
    check('视口 ' + view.name + '：没有横向溢出', state.overflowX <= 1, 'overflowX=' + state.overflowX);
    const anchors = await page.evaluate(`(() => {
      const map = window.RiskTideApp.map;
      const shell = document.getElementById('map-shell').getBoundingClientRect();
      const eps = map.getEndpoints();
      const out = {};
      ['campus', 'station'].forEach(function (role) {
        const el = document.querySelector('.' + role + '-marker');
        const p = map.getScreenPath([eps[role].coordinate], 'WGS84')[0];
        if (!el || !p) { out[role] = null; return; }
        const r = el.getBoundingClientRect();
        out[role] = { dx: Math.round((p.x - (r.left + r.width / 2 - shell.left)) * 10) / 10,
          dy: Math.round((p.y - (r.bottom - shell.top)) * 10) / 10 };
      });
      return out;
    })()`);
    check('视口 ' + view.name + '：起终点 marker 与真实坐标重合（≤3px）',
      anchors.campus && anchors.station && Math.abs(anchors.campus.dy) <= 3
        && Math.abs(anchors.station.dy) <= 3, JSON.stringify(anchors));

    /* 浮层 + 徽标在窄屏上的边界 */
    const mid = await page.evaluate(`window.__t.routePoint(0.5)`);
    if (view.touch) {
      await page.touch('touchStart', mid.x, mid.y);
      await sleep(60);
      await page.touch('touchEnd', mid.x, mid.y);
    } else {
      await page.mouse('mouseMoved', mid.x, mid.y);
    }
    await sleep(420);
    const tip = await page.evaluate(`window.__t.tip()`);
    await page.evaluate(`window.__t.setMode('bus')`);
    await sleep(700);
    const badge = await page.evaluate(`(() => {
      const el = document.getElementById('route-authenticity');
      const shell = document.getElementById('map-shell').getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { hidden: el.hidden, text: el.textContent.slice(0, 40),
        inside: r.left >= shell.left - 1 && r.right <= shell.right + 1
          && r.top >= shell.top - 1 && r.bottom <= shell.bottom + 1 };
    })()`);
    check('视口 ' + view.name + '：浮层出现且不超出地图',
      tip.visible && tip.inside, JSON.stringify({ rows: tip.rows.length, rect: tip.rect }));
    check('视口 ' + view.name + '：真实性徽标在地图内且文案明确',
      badge.hidden === false && badge.inside && badge.text.indexOf('非真实道路路线') >= 0,
      JSON.stringify(badge));
    await page.screenshot(path.join(SHOT_DIR, 'viewport-' + view.w + 'x' + view.h + '.png'));
  }
}

/* ---------------- 极长路线压力 -------------------------------------------- */
async function scenarioLongRoute(page) {
  await page.gotoRoute(BASE + '/?route=1&osm=1', 3200);
  await page.evaluate(`window.__t.setMode('taxi')`);
  await sleep(1200);
  const out = await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    const base = window.RiskTideApp.map.getEndpoints().campus.coordinate;
    /* 2000+ 点、带锯齿与折返的长路线：验证点数上限、重采样与单帧重建耗时 */
    const coords = [];
    for (let i = 0; i < 2200; i += 1) {
      const t = i / 2200;
      coords.push([
        base[0] + t * 0.34 + Math.sin(i / 3) * 0.00012,
        base[1] + t * 0.22 + Math.cos(i / 5) * 0.00018
      ]);
    }
    const route = { id: 'taxi', label: '网约车', source: 'long-route-test',
      coordinates: coords, coordinateSystem: 'WGS84', durationMinutes: 40,
      verified: false, variants: [] };
    f.stop();
    f.reducedMotion = true;
    f.setRoute(route, { kind: 'road' });
    f.routeDirty = true;
    const t0 = performance.now();
    f.rebuild();
    const rebuildMs = performance.now() - t0;
    f.draw();
    const t1 = performance.now();
    f.draw();
    const drawMs = performance.now() - t1;
    /* 保真度：原始几何上的每个顶点到"重采样后的折线"的最大距离（削角量） */
    const out = f.points.slice().reverse();
    const distToOut = function (px, py) {
      let best = Infinity;
      for (let i = 0; i < out.length - 1; i += 1) {
        const a = out[i], b = out[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq ? ((px - a.x) * dx + (py - a.y) * dy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
        if (d < best) best = d;
      }
      return best;
    };
    const projected = window.RiskTideApp.map.getScreenPath(coords, 'WGS84');
    let cut = 0;
    projected.forEach(function (q) {
      if (!q || !Number.isFinite(q.x)) return;
      const d = distToOut(q.x, q.y);
      if (d > cut) cut = d;
    });
    const stats = { points: f.points.length, rebuildMs: Math.round(rebuildMs * 10) / 10,
      drawMs: Math.round(drawMs * 10) / 10, lengthPx: Math.round(f.totalLength),
      cornerCutPx: Math.round(cut * 100) / 100,
      nonFinite: f.points.some(function (p) { return !Number.isFinite(p.x) || !Number.isFinite(p.y); }) };
    f.reducedMotion = false;
    f.start();
    return stats;
  })()`);
  /* 上限 560 + 终点补点；关键是被"抽密"到上限附近，而不是原样照收 2000+ 点 */
  check('长路线：采样点被限制在上限内（≤ 564）', out.points <= 564 && out.points > 40,
    JSON.stringify(out));
  check('长路线：单次重投影在预算内（≤ 120ms）', out.rebuildMs <= 120, out.rebuildMs + 'ms');
  check('长路线：单次绘制在预算内（≤ 60ms）', out.drawMs <= 60, out.drawMs + 'ms');
  check('长路线：坐标有限且几何长度合理',
    !out.nonFinite && out.lengthPx > 100, JSON.stringify(out));
  check('长路线：重采样不削角（原始顶点偏离输出折线 ≤ 3px）', out.cornerCutPx <= 3,
    out.cornerCutPx + 'px');
  return out;
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  console.log('单程墨线浏览器回归检查 · ' + BASE + ' · 截图输出 ' + SHOT_DIR);
  const browser = await Browser.launch({ executablePath: EXE });
  console.log('浏览器已启动，开始跑场景…');
  const errors = [];
  const collect = (page) => {
    page.errors.splice(0, page.errors.length).forEach((e) => {
      if (e.indexOf('404') >= 0 || e.indexOf('Failed to load resource') >= 0) return;
      errors.push(e);
    });
  };
  try {
    const page = await newPage(browser, { width: 1280, height: 900, dsf: 1 });
    const scenarios = {
      real: async () => scenarioRealVsHint(page),
      pan: async () => scenarioMapSync(page),
      hover: async () => scenarioHoverClickKeyboard(page),
      width: async () => scenarioWidthStability(page),
      fps: async () => scenarioFrameRate(page),
      planning: async () => scenarioPlanningFailures(page),
      geometry: async () => scenarioGeometry(page),
      longroute: async () => scenarioLongRoute(page),
      routechange: async () => scenarioRouteChange(page),
      flow: async () => scenarioFlow(page)
    };
    for (const key of Object.keys(scenarios)) {
      if (only.length && only.indexOf(key) < 0) continue;
      console.log('· 场景 ' + key);
      try {
        await scenarios[key]();
      } catch (error) {
        check('场景 ' + key + ' 执行', false, error.message);
      }
      collect(page);
    }
    if (!only.length || only.indexOf('touch') >= 0) {
      const touchPage = await newPage(browser, { width: 390, height: 780, dsf: 3 });
      try { await scenarioTouch(touchPage); } catch (e) { check('场景 touch 执行', false, e.message); }
      collect(touchPage);
    }
    if (!only.length || only.indexOf('reduced') >= 0) {
      try { await scenarioReducedMotion(browser); } catch (e) { check('场景 reduced 执行', false, e.message); }
    }
    if (!only.length || only.indexOf('dpr') >= 0) {
      try { await scenarioDpr(browser); } catch (e) { check('场景 dpr 执行', false, e.message); }
    }
    if (!only.length || only.indexOf('nation') >= 0) {
      try { await scenarioNation(browser); } catch (e) { check('场景 nation 执行', false, e.message); }
    }
    if (!only.length || only.indexOf('amap') >= 0) {
      try { await scenarioAmap(browser); } catch (e) { check('场景 amap 执行', false, e.message); }
    }
    if (!only.length || only.indexOf('viewports') >= 0) {
      try { await scenarioViewports(browser); } catch (e) { check('场景 viewports 执行', false, e.message); }
    }
  } finally {
    try { browser.proc.kill(); } catch (e) { /* ignore */ }
  }
  check('全流程无未捕获的页面脚本错误', errors.length === 0, errors.slice(0, 4).join(' | '));
  const failed = summary();
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error('SUITE CRASHED', error); process.exit(2); });
