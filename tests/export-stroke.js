'use strict';
/* 导出"浓墨流光"墨线素材（规范 §8）：
   - 透明背景 PNG：安全 / 临界 / 危险 三态各一张
   - 深灰黑底预览：同样三态，用于检验与地图/深底的对比度
   - 横向长幅构图，两端留余量；不画纸张、道路、文字、图标
   用法：BASE_URL=http://localhost:8123 node tests/export-stroke.js  */

const { Browser, openPage, sleep } = require('./cdp');
const fs = require('fs');
const path = require('path');

const EXE = process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE_URL || 'http://localhost:8123';
const OUT = process.env.OUT_DIR || path.join(__dirname, '..', '.shots', 'ink-assets');
const W = Number(process.env.OUT_W || 2048);
const H = Number(process.env.OUT_H || 420);

/* 三种风险状态：直接用 slider 把时间条件压到对应风险 */
const STATES = [
  { name: 'safe', slider: '120', label: '安全 #68DFED' },
  { name: 'critical', slider: '102', label: '临界 #EABB6C' },
  { name: 'danger', slider: '60', label: '危险 #E66A5A' }
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await Browser.launch({ executablePath: EXE });
  const page = await openPage(browser, { width: 1400, height: 900, dsf: 1 });
  await browser.send('Page.bringToFront', {}, page.sessionId);
  await page.goto(BASE + '/?route=1&osm=1', 3800);

  /* 造一条"横向长幅"的路线：用 canvas 直接喂入一条波浪折线（只影响素材，不动仓库数据） */
  await page.evaluate(`(() => {
    const f = window.RiskTideApp.inkFlow;
    window.__assets = [];
    /* 用一个离屏画布把墨线单独画出来：透明底，横向长幅 */
    const stage = document.createElement('canvas');
    stage.id = 'asset-stage';
    stage.width = ${W};
    stage.height = ${H};
    document.body.appendChild(stage);
    /* 提供一条横向波浪线（横向长幅、两端留余量、曲率自然） */
    const pts = [];
    const n = 220;
    for (let i = 0; i < n; i += 1) {
      const t = i / (n - 1);
      const x = 90 + t * (${W} - 180);
      /* 复合、互不成整数倍的曲率：避免"机械正弦波"，但仍是连续一笔 */
      const y = ${H} / 2
        + Math.sin(t * Math.PI * 0.83 + 2.6) * ${H} * 0.050
        + Math.sin(t * Math.PI * 1.70 + 0.4) * ${H} * 0.150
        + Math.sin(t * Math.PI * 3.31 + 1.9) * ${H} * 0.065
        + Math.sin(t * Math.PI * 6.13 + 0.7) * ${H} * 0.028;
      pts.push({ x: x, y: y });
    }
    window.__assetPath = pts;
    return pts.length;
  })()`);

  /* 素材是"放大版材质研究"：把各层宽度整体放大（比例不变），
     否则 2048px 画布上的 17.5px 墨线看起来太细，不符合"浓重"要求。 */
  const SCALE = Number(process.env.INK_SCALE || 3);
  /* 浅纸/中灰深底预览（素材本身仍是透明底） */
  const BACKINGS = [
    { name: 'paper', color: [239, 233, 218] },
    { name: 'mid', color: [43, 51, 59] },
    { name: 'dark', color: [20, 24, 27] }
  ];
  await page.evaluate(`(() => {
    const r = window.RiskTideConfig.ink.route;
    const k = ${SCALE};
    if (r.halo) r.halo.width *= k;
    (r.passes || []).forEach(function (p) { p.width *= k; });
    if (r.bone) r.bone.width *= k;
    if (r.bristle) r.bristle.width *= k;
    if (r.core && r.core.highlight) r.core.highlight.width *= k;
    if (r.head) r.head.radius *= k;
    return 'ok';
  })()`);

  for (const state of STATES) {
    await page.evaluate(`(() => {
      const slider = document.getElementById('departure-slider');
      slider.value = '${state.slider}';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(900);
    /* 用渲染器把这条波浪线画到透明离屏画布上 */
    const dataUrl = await page.evaluate(`(() => {
      const f = window.RiskTideApp.inkFlow;
      const stage = document.getElementById('asset-stage');
      const target = stage.getContext('2d');
      /* 借用渲染器：把它的 points/displayRisk 换成素材线，画到 stage 上 */
      const saved = { points: f.points, ctx: f.ctx, canvas: f.canvas, width: f.width, height: f.height,
        dpr: f.dpr, glowCtx: f.glowCtx, glowCanvas: f.glowCanvas, kind: f.kind, progress: f.progress };
      const glow = document.createElement('canvas');
      glow.width = stage.width;
      glow.height = stage.height;
      window.__assetGlow = glow;   /* 预览合成必须用当前这一态的发光层 */
      f.ctx = target;
      f.canvas = stage;
      f.width = stage.width;
      f.height = stage.height;
      f.dpr = 1;
      f.glowCtx = glow.getContext('2d');
      f.glowCanvas = glow;
      f.kind = 'road';
      f.progress = 1;
      f.points = window.__assetPath.map((p) => ({ x: p.x, y: p.y }));
      f.displayRisk = new Float32Array(f.points.length).fill(f.riskTarget);
      f.draw();
      /* 合成：墨层（multiply 语义按普通叠加近似）+ 发光层（screen） */
      /* 透明底素材 = 墨层 + 发光层（screen），不铺任何背景 */
      const out = document.createElement('canvas');
      out.width = stage.width;
      out.height = stage.height;
      const octx = out.getContext('2d');
      octx.drawImage(stage, 0, 0);
      octx.globalCompositeOperation = 'screen';
      octx.drawImage(glow, 0, 0);
      octx.globalCompositeOperation = 'source-over';

      /* 复原渲染器状态 */
      f.points = saved.points; f.ctx = saved.ctx; f.canvas = saved.canvas;
      f.width = saved.width; f.height = saved.height; f.dpr = saved.dpr;
      f.glowCtx = saved.glowCtx; f.glowCanvas = saved.glowCanvas;
      f.kind = saved.kind; f.progress = saved.progress;
      f.routeDirty = true;
      f.draw();
      return out.toDataURL('image/png');
    })()`);
    const buf = Buffer.from(String(dataUrl).split(',')[1], 'base64');
    fs.writeFileSync(path.join(OUT, 'ink-stroke-' + state.name + '.png'), buf);
    console.log('写出 ' + state.name + ' → ' + path.join(OUT, 'ink-stroke-' + state.name + '.png') +
      '  (' + state.label + ' · 透明底)');
    /* 预览：分别铺在浅纸 / 中灰 / 深黑底上，用于检验对比度 */
    const previews = await page.evaluate(`(() => {
      const stage = document.getElementById('asset-stage');
      const out = {};
      const backings = ${JSON.stringify(BACKINGS)};
      backings.forEach(function (b) {
        const cv = document.createElement('canvas');
        cv.width = stage.width;
        cv.height = stage.height;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = 'rgb(' + b.color.join(',') + ')';
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(stage, 0, 0);
        const glow = window.__assetGlow;
        if (glow) { ctx.globalCompositeOperation = 'screen'; ctx.drawImage(glow, 0, 0); ctx.globalCompositeOperation = 'source-over'; }
        out[b.name] = cv.toDataURL('image/png');
      });
      return out;
    })()`);
    Object.keys(previews).forEach(function (key) {
      const data = String(previews[key]).split(',')[1];
      fs.writeFileSync(path.join(OUT, 'preview-' + key + '-' + state.name + '.png'),
        Buffer.from(data, 'base64'));
    });
  }
  console.log(JSON.stringify({ out: OUT, size: W + 'x' + H, states: STATES.map((s) => s.name) }, null, 2));
  browser.proc.kill();
  process.exit(0);
}
main().catch((e) => { console.error('EXPORT FAILED', e && e.message); process.exit(1); });