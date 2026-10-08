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
['map-shell', 'nation-canvas', 'silk-canvas', 'origin-input', 'dest-input', 'hero-latest']
  .forEach((id) => assert.ok(html.includes(`id="${id}"`), `missing #${id}`));
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
assert.ok(fs.readFileSync(path.join(root, 'js/nation-ink.js'), 'utf8').includes('weightedRisk / totalWeight'),
  'nationwide field is not normalized by local influence');
const pale = [0, 0, 0], dark = [0, 0, 0];
sandbox.RiskTideNationInk.riskColour(0, pale);
sandbox.RiskTideNationInk.riskColour(100, dark);
assert.ok(pale[0] > dark[0] && pale[1] > dark[1], 'continuous ink palette endpoints are incorrect');

console.log('Risk Tide verification passed: resources, formulas, 43-city model, normalized ink field, particle-free END -> START stroke.');
