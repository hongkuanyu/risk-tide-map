'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const requiredFiles = [
  'index.html',
  'styles.css',
  'data/config.js',
  'data/routes.js',
  'data/cities.js',
  'js/risk.js',
  'js/app.js',
  'js/map.js',
  'js/amap-map.js',
  'js/ink-flow.js',
  'js/route-tip.js',
  'js/nation-risk.js',
  'js/nation-ink.js'
];

requiredFiles.forEach((relative) => {
  const file = path.join(root, relative);
  assert.ok(fs.existsSync(file), `missing required file: ${relative}`);
  if (relative.endsWith('.js')) {
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: relative });
  }
});

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
['map-shell', 'nation-canvas', 'silk-canvas', 'origin-input', 'dest-input', 'hero-latest',
  'route-tip', 'route-authenticity', 'ink-glow-canvas']
  .forEach((id) => assert.ok(html.includes(`id="${id}"`), `missing #${id}`));
assert.ok(html.includes('tabindex="0"'), 'map shell must stay keyboard focusable');
assert.ok(html.includes('非实时路况'), 'the legend must explain what the ink colour means');
assert.ok(html.includes('class="brand-mark"'), 'brand mark is missing');
assert.ok(html.includes('data-view="nation"') && html.includes('data-view="route"'), 'view navigation is incomplete');
assert.ok(!html.includes('particle-canvas') && !html.includes('particles.js'), 'legacy particle renderer is still wired');
assert.ok(!fs.existsSync(path.join(root, 'js/particles.js')), 'legacy particle renderer was not removed');

const sandbox = { console, Math, Date, setTimeout, clearTimeout };
sandbox.window = sandbox;
vm.createContext(sandbox);
['data/config.js', 'js/risk.js', 'data/cities.js', 'js/nation-risk.js', 'js/nation-ink.js', 'js/ink-flow.js'].forEach((relative) => {
  vm.runInContext(fs.readFileSync(path.join(root, relative), 'utf8'), sandbox, { filename: relative });
});

const high = sandbox.RiskTideRisk.calculate({
  trainTime: '18:00', departureTime: '16:50', routeMinutes: 4,
  stationMinutes: 60, safeBufferMinutes: 60
});
assert.strictEqual(high.bufferMinutes, 6, 'buffer formula changed');
assert.strictEqual(Math.round(high.risk), 90, 'risk formula changed');

const cities = sandbox.RiskTideCities.list;
assert.strictEqual(cities.length, 43, 'nationwide city set changed unexpectedly');
const rows = sandbox.RiskTideNationRisk.computeAll(cities, [120.4660492, 31.5834765], {
  trainTime: '18:00', departureTime: '10:00', stationMinutes: 60,
  safeBufferMinutes: 60, mode: 'rail'
});
assert.strictEqual(rows.length, 43, 'nationwide risk result incomplete');
for (let i = 1; i < rows.length; i += 1) {
  assert.ok(rows[i - 1].risk >= rows[i].risk, 'nationwide rows are not risk-sorted');
}

const inkFlow = fs.readFileSync(path.join(root, 'js/ink-flow.js'), 'utf8');
assert.ok(inkFlow.includes('drawRibbon') && inkFlow.includes('drawHead'), 'layered route ink renderer is missing');
assert.ok(inkFlow.includes('for (let i = forward.length - 1; i >= 0; i -= 1)'), 'route stroke no longer writes END -> START');
assert.ok(!inkFlow.includes('.reverse('), 'route geometry should be traversed without mutating it');
assert.ok(!inkFlow.includes('Math.random('), 'route renderer must not use frame-random variation');

const config = fs.readFileSync(path.join(root, 'data/config.js'), 'utf8');
assert.ok(config.includes('enabled: true') && config.includes('defaultWindowMinutes: 480'), 'nationwide view is not the default');
/* 单程墨线必须区分"真实道路几何"和"仅起终点示意" */
assert.ok(!inkFlow.includes("return endpoints.campus && endpoints.station"),
  'ink-flow must not fall back to a start/end straight line as if it were a road route');
assert.ok(inkFlow.includes('getHintCoordinates'), 'ink-flow needs a separate hint geometry');
assert.ok(inkFlow.includes("kind: 'preview'") || inkFlow.includes("'preview'"),
  'ink-flow must know the preview state');
assert.ok(inkFlow.includes('WRITE_DT_CAP'), 'write animation must use a wall-clock budget, not raw frames');
assert.ok(inkFlow.includes('hitTest'), 'ink-flow must expose hit testing for hover / tap / keyboard');
assert.ok(inkFlow.includes('coreColour') && inkFlow.includes('drawCore'),
  'the luminous core channel (risk-driven) is missing from the route ink');
assert.ok(inkFlow.includes('glowCtx'), 'the additive glow layer must be drawn on its own canvas');
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
assert.ok(app.includes('planSeq') && app.includes('guardFor'), 'route planning needs a request guard');
assert.ok(app.includes('supportsPlanning()'), 'planning capability must be checked before treating a plan as failed');
assert.ok(app.includes('requestInkFrame()'), 'map movement must request a redraw of the ink line');
assert.ok(app.includes('updateRouteNotice'), 'route authenticity notice is missing');

const amapMap = fs.readFileSync(path.join(root, 'js/amap-map.js'), 'utf8');
assert.ok(amapMap.includes("'mapmove'") && amapMap.includes("'zoomchange'"),
  'AMap needs continuous movement events so the ink line keeps up while panning / zooming');
assert.ok(amapMap.includes('routePaddingMobile') && amapMap.includes('routePaddingDesktop'),
  'AMap route fitting must use responsive padding');
assert.ok(fs.readFileSync(path.join(root, 'js/nation-ink.js'), 'utf8').includes('weightedRisk / totalWeight'),
  'nationwide field is not normalized by local influence');
/* 色阶语义：从淡墨到朱砂，越往上越暗、且末端偏红（朱砂暗渗），
   但红是"暗红"——末端的亮度必须仍然明显低于淡墨端。 */
const pale = [0, 0, 0], dark = [0, 0, 0];
sandbox.RiskTideNationInk.riskColour(0, pale);
sandbox.RiskTideNationInk.riskColour(100, dark);
const luminance = (rgb) => rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
assert.ok(luminance(pale) > luminance(dark) + 40,
  'ink palette must get clearly darker toward the risky end');
assert.ok(pale[1] > dark[1],
  'ink palette must lose green toward the risky end (ink, not a green ramp)');
assert.ok((dark[0] - dark[2]) > (pale[0] - pale[2]) + 40,
  'the risky end must carry the 朱砂 red shift');

console.log('Risk Tide verification passed: resources, formulas, 43-city model, normalized ink field, particle-free END -> START stroke.');
