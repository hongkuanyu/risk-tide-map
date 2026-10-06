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
['map-shell', 'nation-canvas', 'silk-canvas', 'origin-input', 'dest-input', 'hero-latest', 'nation-insight']
  .forEach((id) => assert.ok(html.includes(`id="${id}"`), `missing #${id}`));

const sandbox = { console, Math, Date, setTimeout, clearTimeout };
sandbox.window = sandbox;
vm.createContext(sandbox);
['js/risk.js', 'data/cities.js', 'js/nation-risk.js'].forEach((relative) => {
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
assert.ok(inkFlow.includes('this.vx[idx] = (-tx[best]'), 'ink velocity no longer runs END -> START');
assert.ok(inkFlow.includes('destination is along = 1'), 'pigment source is no longer documented at destination');
assert.ok(!inkFlow.includes('.reverse('), 'business route geometry must not be reversed');

const config = fs.readFileSync(path.join(root, 'data/config.js'), 'utf8');
assert.ok(config.includes('flowHead: { enabled: true'), 'flow head is disabled');
assert.ok(config.includes('[82, 116, 113]') && config.includes('[151, 58, 43]'), 'mineral risk palette is incomplete');

console.log('Risk Tide verification passed: resources, formulas, 43-city model, mineral palette, END -> START flow.');
