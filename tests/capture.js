'use strict';
/* 截图对照脚本：同一套操作在任意版本上跑一遍，产出可对比的截图。
   用法：BASE_URL=http://localhost:8124 PREFIX=before node tests/capture.js */

const { Browser, openPage, sleep } = require('./cdp');
const fs = require('fs');
const path = require('path');

const EXE = process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE_URL || 'http://localhost:8123';
const PREFIX = process.env.PREFIX || 'shot';
const OUT = process.env.SHOT_DIR || path.join(__dirname, '..', '.shots');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await Browser.launch({ executablePath: EXE });
  const page = await openPage(browser, { width: 1280, height: 900, dsf: 1 });
  const shot = (name) => page.screenshot(path.join(OUT, PREFIX + '-' + name + '.png'));

  await page.goto(BASE + '/?route=1&osm=1', 3800);
  await shot('01-desktop-initial');
  await page.evaluate(`document.getElementById('mode-taxi').click()`);
  await sleep(2600);
  await shot('02-desktop-taxi');
  const mid = await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    const p = f.points[Math.floor(f.points.length * 0.5)];
    const r = document.getElementById('silk-canvas').getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  })()`);
  await page.mouse('mouseMoved', mid.x, mid.y);
  await sleep(500);
  await shot('03-desktop-hover');
  await page.evaluate(`document.getElementById('mode-bus').click()`);
  await sleep(1600);
  await shot('04-desktop-no-geometry');
  await browser.proc.kill();
  console.log('captured ' + PREFIX + ' -> ' + OUT);
  process.exit(0);
}
main().catch((e) => { console.error('CAPTURE FAILED', e); process.exit(1); });