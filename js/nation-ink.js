/* global window, document */
(function (global) {
  'use strict';

  const config = global.RiskTideConfig;
  const stops = ['#f2ede2', '#aaa79f', '#4b4a45', '#181a19'].map(function (hex) {
    const rgb = [
      parseInt(hex.slice(1, 3), 16) / 255,
      parseInt(hex.slice(3, 5), 16) / 255,
      parseInt(hex.slice(5, 7), 16) / 255
    ].map(function (value) {
      return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    const l = 0.4122214708 * rgb[0] + 0.5363325363 * rgb[1] + 0.0514459929 * rgb[2];
    const m = 0.2119034982 * rgb[0] + 0.6806995451 * rgb[1] + 0.1073969566 * rgb[2];
    const s = 0.0883024619 * rgb[0] + 0.2817188376 * rgb[1] + 0.6299787005 * rgb[2];
    const lRoot = Math.cbrt(l), mRoot = Math.cbrt(m), sRoot = Math.cbrt(s);
    return [
      0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
      1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
      0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot
    ];
  });

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function smoothstep(edge0, edge1, value) {
    const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function hash01(value) {
    const x = Math.sin(value * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }
  function riskColour(risk, out) {
    const t = clamp(risk / 100, 0, 1) * (stops.length - 1);
    const index = Math.min(stops.length - 2, Math.floor(t));
    const amount = t - index;
    const a = stops[index], b = stops[index + 1];
    const L = a[0] + (b[0] - a[0]) * amount;
    const A = a[1] + (b[1] - a[1]) * amount;
    const B = a[2] + (b[2] - a[2]) * amount;
    const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
    const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
    const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
    const red = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const green = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const blue = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
    const cinnabar = smoothstep(95, 100, risk) * 0.075;
    out[0] = Math.round(clamp(red <= 0.0031308 ? red * 12.92 : 1.055 * Math.pow(red, 1 / 2.4) - 0.055, 0, 1) * 255 * (1 - cinnabar) + 145 * cinnabar);
    out[1] = Math.round(clamp(green <= 0.0031308 ? green * 12.92 : 1.055 * Math.pow(green, 1 / 2.4) - 0.055, 0, 1) * 255 * (1 - cinnabar) + 42 * cinnabar);
    out[2] = Math.round(clamp(blue <= 0.0031308 ? blue * 12.92 : 1.055 * Math.pow(blue, 1 / 2.4) - 0.055, 0, 1) * 255 * (1 - cinnabar) + 36 * cinnabar);
  }

  class NationInk {
    constructor(canvas, mapController) {
      this.canvas = canvas;
      this.ctx = canvas && canvas.getContext
        ? canvas.getContext('2d', { alpha: true, desynchronized: true }) : null;
      this.map = mapController;
      this.rows = [];
      this.selectedCityId = null;
      this.width = 1;
      this.height = 1;
      this.dpr = 1;
      this.elapsed = 0;
      this.lastTime = 0;
      this.running = false;
      this.visible = !document.hidden;
      this.projectDirty = true;
      this.reducedMotion = !!(global.matchMedia
        && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
      this.boundFrame = this.frame.bind(this);
      this.resize();
      this.observeResize();
    }

    observeResize() {
      if (!global.ResizeObserver || !this.canvas || this.resizeObserver) return;
      this.resizeObserver = new global.ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas.parentNode || this.canvas);
    }

    resize() {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      this.width = Math.max(1, rect.width || 600);
      this.height = Math.max(1, rect.height || 400);
      this.dpr = Math.min(global.devicePixelRatio || 1, 2);
      this.canvas.width = Math.round(this.width * this.dpr);
      this.canvas.height = Math.round(this.height * this.dpr);
      if (this.ctx) this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.projectDirty = true;
      this.prepareField();
      this.requestFrame();
    }

    prepareField() {
      const step = Math.max(4, Math.ceil(Math.max(this.width, this.height) / 140));
      this.fieldWidth = Math.ceil(this.width / step);
      this.fieldHeight = Math.ceil(this.height / step);
      this.fieldStep = step;
      this.field = document.createElement('canvas');
      this.field.width = this.fieldWidth;
      this.field.height = this.fieldHeight;
      this.fieldCtx = this.field.getContext('2d', { alpha: true });
      this.image = this.fieldCtx.createImageData(this.fieldWidth, this.fieldHeight);
    }

    setData(rows) {
      const previous = new Map(this.rows.map(function (row) { return [row.city.id, row]; }));
      const next = (rows || []).filter(function (row) {
        return row && row.city && Number.isFinite(Number(row.risk));
      }).map(function (row) {
        const old = previous.get(row.city.id);
        return {
          city: row.city,
          risk: clamp(Number(row.risk), 0, 100),
          displayRisk: old ? old.displayRisk : clamp(Number(row.risk), 0, 100),
          x: old ? old.x : 0,
          y: old ? old.y : 0,
          phase: old ? old.phase : hash01(row.city.id.length * 17 + Number(row.city.coordinate[0]) * 31) * Math.PI * 2,
          sigma: 0
        };
      });
      if (next.length !== this.rows.length || next.some((row) => !previous.has(row.city.id))) {
        this.projectDirty = true;
      }
      this.rows = next;
      this.requestFrame();
    }

    projectCity(city) {
      const ink = (config.nation && config.nation.ink) || {};
      if (ink.projection !== 'flat' && this.map && typeof this.map.getScreenPath === 'function') {
        const point = this.map.getScreenPath([city.coordinate])[0];
        if (point && Number.isFinite(point.x) && Number.isFinite(point.y)
            && point.x > -this.width * 0.5 && point.x < this.width * 1.5
            && point.y > -this.height * 0.5 && point.y < this.height * 1.5) return point;
      }
      const bounds = ink.bounds || [73, 18, 136, 54];
      const pad = ink.pad === undefined ? 0.06 : ink.pad;
      const x = (city.coordinate[0] - bounds[0]) / (bounds[2] - bounds[0]);
      const y = 1 - (city.coordinate[1] - bounds[1]) / (bounds[3] - bounds[1]);
      return {
        x: this.width * (pad + clamp(x, 0, 1) * (1 - 2 * pad)),
        y: this.height * (pad + clamp(y, 0, 1) * (1 - 2 * pad))
      };
    }

    projectRows() {
      if (!this.projectDirty) return;
      const radius = Math.max(26, Math.min(58, Math.min(this.width, this.height) * 0.075));
      this.rows.forEach((row) => {
        const point = this.projectCity(row.city);
        row.x = point.x;
        row.y = point.y;
        row.sigma = radius;
      });
      this.projectDirty = false;
    }

    advanceRisk(dt) {
      let settling = false;
      this.rows.forEach(function (row) {
        const tau = row.risk >= row.displayRisk ? 1.6 : 3.2;
        row.displayRisk += (row.risk - row.displayRisk) * (1 - Math.exp(-dt / tau));
        if (Math.abs(row.risk - row.displayRisk) > 0.08) settling = true;
      });
      return settling;
    }

    setSelected(cityId) {
      if (this.selectedCityId === cityId) return;
      this.selectedCityId = cityId || null;
      this.requestFrame();
    }

    draw() {
      if (!this.ctx || !this.rows.length) return;
      this.projectRows();
      const pixels = this.image.data;
      const colour = [0, 0, 0];
      const step = this.fieldStep;
      const time = this.reducedMotion ? 0 : this.elapsed;
      for (let gy = 0; gy < this.fieldHeight; gy += 1) {
        const py = (gy + 0.5) * step;
        for (let gx = 0; gx < this.fieldWidth; gx += 1) {
          const px = (gx + 0.5) * step;
          let weightedRisk = 0;
          let totalWeight = 0;
          let strongest = 0;
          let focusWeight = 0;
          for (let i = 0; i < this.rows.length; i += 1) {
            const row = this.rows[i];
            const shore = this.reducedMotion ? 1 : 1 + Math.sin(time * 0.12 + row.phase) * 0.012;
            const sigma = row.sigma * shore;
            const dx = px - row.x;
            const dy = py - row.y;
            const distance = (dx * dx + dy * dy) / (2 * sigma * sigma);
            if (distance > 5.5) continue;
            const weight = Math.exp(-distance);
            weightedRisk += weight * row.displayRisk;
            totalWeight += weight;
            if (weight > strongest) strongest = weight;
            if (row.city.id === this.selectedCityId) focusWeight = weight;
          }
          const offset = (gy * this.fieldWidth + gx) * 4;
          if (totalWeight < 0.025) {
            pixels[offset + 3] = 0;
            continue;
          }
          const risk = weightedRisk / totalWeight;
          riskColour(risk, colour);
          const coverage = smoothstep(0.012, 0.32, Math.max(strongest, focusWeight * 1.18));
          const alpha = Math.round((0.006 + smoothstep(12, 100, risk) * 0.15) * coverage * 255);
          pixels[offset] = colour[0];
          pixels[offset + 1] = colour[1];
          pixels[offset + 2] = colour[2];
          pixels[offset + 3] = alpha;
        }
      }
      this.fieldCtx.putImageData(this.image, 0, 0);
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.ctx.drawImage(this.field, 0, 0, this.width, this.height);
    }

    setVisible(visible) {
      this.visible = !!visible;
      this.lastTime = 0;
      if (this.visible) this.requestFrame();
    }

    requestFrame() {
      global.clearTimeout(this.frameTimer);
      if (this.running && this.visible && !this.framePending) {
        this.framePending = true;
        global.requestAnimationFrame(this.boundFrame);
      }
    }

    start() {
      if (this.running || !this.ctx) return;
      this.running = true;
      this.requestFrame();
    }

    stop() {
      this.running = false;
      this.framePending = false;
      global.clearTimeout(this.frameTimer);
    }

    getMetrics() {
      return { cities: this.rows.length, field: this.fieldWidth + '×' + this.fieldHeight };
    }

    frame(timestamp) {
      this.framePending = false;
      if (!this.running || !this.visible) return;
      const dt = this.lastTime ? Math.min((timestamp - this.lastTime) / 1000, 0.05) : 0.016;
      this.lastTime = timestamp;
      this.elapsed += this.reducedMotion ? 0 : dt;
      const settling = this.advanceRisk(dt);
      this.draw();
      if (settling || !this.reducedMotion) {
        this.frameTimer = global.setTimeout(() => this.requestFrame(), settling ? 48 : 140);
      }
    }
  }

  NationInk.riskColour = riskColour;
  global.RiskTideNationInk = NationInk;
})(window);
