'use strict';
/* 墨线笔重测量：同一段几何，量出三层笔触的实际像素宽度与墨迹总量。
   用法：BASE_URL=http://localhost:8123 LABEL=thick node tests/ink-weight.js */
const { Browser, openPage, sleep } = require('./cdp');
const path = require('path');

const EXE = process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE_URL || 'http://localhost:8123';
const LABEL = process.env.LABEL || 'label';
const OUT = path.join(__dirname, '..', '.shots');

async function main() {
  const browser = await Browser.launch({ executablePath: EXE });
  const page = await openPage(browser, { width: 1280, height: 900, dsf: 1 });
  await page.goto(BASE + '/?route=1&osm=1', 3600);
  await page.evaluate(`(() => { const f = window.RiskTideApp.inkFlow; f.reducedMotion = true; return 'ok'; })()`);
  await page.evaluate(`document.getElementById('mode-taxi').click()`);
  await sleep(1200);
  /* PRESET=bold|mid|ink：同一份代码里对比三种笔触取向（只在页面内改配置，不动文件） */
  if (process.env.PRESET) {
    await page.evaluate(`(() => {
      const r = window.RiskTideConfig.ink.route;
      const preset = ${JSON.stringify(process.env.PRESET)};
      if (preset === 'bold') {
        r.core.width = 2.4; r.core.alpha = 0.90; r.core.bloom = 16; r.core.bloomAlpha = 0.30;
        r.passes.forEach(function (p) { p.alpha *= 1.15; p.shade *= 0.80; });
      } else if (preset === 'ink') {
        r.core.enabled = false; r.bristle.strands = 0;
        r.passes.forEach(function (p) { p.alpha *= 1.10; p.shade *= 0.85; });
      }
      const f = window.RiskTideApp.inkFlow;
      const route = window.RiskTideApp.ui.getActiveRoute(window.RiskTideApp.ui.getState());
      f.setRoute(route, { kind: 'road' });
      f.draw();
      return 'ok';
    })()`);
    await sleep(700);
  }
  /* RISK_HIGH=1：把计划出发时间压紧，用同一段几何看高风险下的笔色（芯光转暖） */
  /* RISK_HIGH=1 → 危险（赤）；RISK_HIGH=mid → 临界（金） */
  if (process.env.RISK_HIGH === '1' || process.env.RISK_HIGH === 'mid') {
    await page.evaluate(`(() => {
      const slider = document.getElementById('departure-slider');
      slider.value = ${process.env.RISK_HIGH === 'mid' ? '91' : '60'};
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(900);
  }
  const data = await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    const cv = document.getElementById('silk-canvas');
    const rect = cv.getBoundingClientRect();
    const dpr = cv.width / rect.width;
    const ctx = cv.getContext('2d');
    const img = ctx.getImageData(0, 0, cv.width, cv.height);
    const alphaAt = function (x, y) {
      if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return 0;
      return img.data[(y * cv.width + x) * 4 + 3];
    };
    const scan = function (index, threshold) {
      const pts = f.points;
      const i = Math.max(1, Math.min(pts.length - 2, Math.round(index * (pts.length - 1))));
      const a = pts[i - 1], b = pts[i + 1];
      let dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      let width = 0;
      for (let s = -40; s <= 40; s += 0.5) {
        const x = Math.round((pts[i].x + nx * s) * dpr);
        const y = Math.round((pts[i].y + ny * s) * dpr);
        if (alphaAt(x, y) >= threshold) width += 0.5;
      }
      return Math.round(width * dpr * 10) / 10;   /* 换算回 CSS 像素 */
    };
    let count = 0, sum = 0, max = 0;
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i];
      if (a > max) max = a;
      if (a >= 8) { count += 1; sum += a; }
    }
    const at = function (frac) {
      return { soft: scan(frac, 8), body: scan(frac, 60), bone: scan(frac, 150) };
    };
    return {
      kind: f.kind,
      points: f.points.length,
      inkPixels: count,
      meanAlpha: Math.round(sum / Math.max(1, count) * 10) / 10,
      maxAlpha: max,
      head: at(0.15), mid: at(0.5), tail: at(0.85)
    };
  })()`);
  await page.screenshot(path.join(OUT, label_shot(LABEL)));
  data.label = LABEL;
  data.base = BASE;
  console.log(JSON.stringify(data, null, 2));
  browser.proc.kill();
  process.exit(0);
}
function label_shot(label) { return 'ink-weight-' + label + '.png'; }
main().catch((e) => { console.error('INK WEIGHT FAILED', e && e.message); process.exit(1); });