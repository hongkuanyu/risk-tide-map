/* global window, document */
(function (global) {
  'use strict';

  const config = global.RiskTideConfig;

  /* ---- 唯一色源：淡墨 -> 灰墨 -> 浓墨 -> 焦墨 -> 焦墨+朱砂 --------------
     色值来自 data/config.js -> ink.ramp，在 OKLab 空间做连续插值，因此颜色
     永远平滑变化，不存在 "if risk > xx 就换色" 的 Dashboard 色阶。 */
  function srgbToLinear(value) {
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(value) {
    return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  }
  function rgbToOklab(rgb) {
    const r = srgbToLinear(rgb[0] / 255);
    const g = srgbToLinear(rgb[1] / 255);
    const b = srgbToLinear(rgb[2] / 255);
    const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    const lRoot = Math.cbrt(l), mRoot = Math.cbrt(m), sRoot = Math.cbrt(s);
    return [
      0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
      1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
      0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot
    ];
  }
  function buildStops() {
    const ramp = (config && config.ink && config.ink.ramp) || [
      { at: 0.00, rgb: [148, 146, 140] },
      { at: 0.30, rgb: [104, 105, 100] },
      { at: 0.58, rgb: [62, 65, 63] },
      { at: 0.82, rgb: [32, 34, 33] },
      { at: 0.94, rgb: [26, 27, 26] },
      { at: 1.00, rgb: [122, 46, 38] }
    ];
    return ramp.map(function (stop) { return { at: stop.at, lab: rgbToOklab(stop.rgb) }; });
  }
  const STOPS = buildStops();

  /* 潮岸等值线（marching squares）：edge 0=上 1=右 2=下 3=左，
     角点 bit0=左上 1=右上 2=右下 3=左下 */
  const SEGMENTS = [
    [], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], [[3, 0], [1, 2]],
    [[0, 2]], [[3, 2]], [[2, 3]], [[0, 2]], [[0, 1], [2, 3]],
    [[1, 2]], [[1, 3]], [[0, 1]], [[0, 3]], []
  ];

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function smoothstep(edge0, edge1, value) {
    const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function hash01(value) {
    const x = Math.sin(value * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  /* risk(0..100) -> [r,g,b]，连续、无跳变。 */
  function riskColour(risk, out) {
    const t = clamp(risk / 100, 0, 1) * (STOPS.length - 1);
    const index = Math.min(STOPS.length - 2, Math.floor(t));
    const amount = t - index;
    const a = STOPS[index].lab, b = STOPS[index + 1].lab;
    const L = a[0] + (b[0] - a[0]) * amount;
    const A = a[1] + (b[1] - a[1]) * amount;
    const B = a[2] + (b[2] - a[2]) * amount;
    const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
    const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
    const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
    const red = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const green = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const blue = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
    out[0] = Math.round(clamp(linearToSrgb(red), 0, 1) * 255);
    out[1] = Math.round(clamp(linearToSrgb(green), 0, 1) * 255);
    out[2] = Math.round(clamp(linearToSrgb(blue), 0, 1) * 255);
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
      this.tide = (config && config.ink && config.ink.tide) || {};
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
      this.riskField = new Float32Array(this.fieldWidth * this.fieldHeight);
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
      const radius = this.tide.fieldRadius === undefined
        ? Math.max(18, Math.min(40, Math.min(this.width, this.height) * 0.05))
        : this.tide.fieldRadius;
      this.rows.forEach((row) => {
        const point = this.projectCity(row.city);
        row.x = point.x;
        row.y = point.y;
        row.sigma = radius;
      });
      this.projectDirty = false;
    }

    /* 风险升高快、回落慢：回落留下余墨，之后慢慢恢复。 */
    advanceRisk(dt) {
      let settling = false;
      this.rows.forEach(function (row) {
        const tau = row.risk >= row.displayRisk ? 2.2 : 4.5;
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
      const riskField = this.riskField;
      const colour = [0, 0, 0];
      const step = this.fieldStep;
      const time = this.reducedMotion ? 0 : this.elapsed;
      const tide = this.tide;
      const shoreAmp = tide.shoreAmplitude === undefined ? 0.035 : tide.shoreAmplitude;
      const shorePeriod = Math.max(8, tide.shorePeriod || 60);

      /* 第 1 遍：归一化墨场。每像素按附近城市的 Gaussian 核权重计算归一化
         风险，而不是叠加城市 blob —— 城市密集区不会仅因城市数量变黑，
         相邻城市自然融合成一片区域墨势。 */
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
            /* 潮岸：sigma 随风险轻微扩张（墨潮向外推进），并叠加极慢的
               涨落相位，肉眼第一眼静止、观察几秒才察觉。 */
            const shore = 1 + Math.sin(time * (Math.PI * 2) / shorePeriod + row.phase) * shoreAmp;
            const sigma = row.sigma * (0.82 + 0.36 * (row.displayRisk / 100)) * shore;
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
            riskField[gy * this.fieldWidth + gx] = 0;
            continue;
          }
          const risk = weightedRisk / totalWeight;
          riskField[gy * this.fieldWidth + gx] = risk;
          riskColour(risk, colour);
          const coverage = smoothstep(0.012, 0.32, Math.max(strongest, focusWeight * 1.18));
          const intensity = smoothstep(4, 72, risk);
          const fieldAlpha = tide.fieldAlpha === undefined ? 0.22 : tide.fieldAlpha;
          const alpha = Math.round((0.008 + fieldAlpha * intensity) * coverage * 255);
          pixels[offset] = colour[0];
          pixels[offset + 1] = colour[1];
          pixels[offset + 2] = colour[2];
          pixels[offset + 3] = alpha;
        }
      }
      this.fieldCtx.putImageData(this.image, 0, 0);
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.ctx.drawImage(this.field, 0, 0, this.width, this.height);

      /* 城市墨源：一滴落墨，中心浓、外围淡，只随风险缓慢变深、变大，
         不做呼吸 / 发光 / 圆形 marker。 */
      this.drawInkDots();
      /* 潮岸：沿风险等值线画一条克制的墨线，涨潮外扩、退潮内收。 */
      this.drawContours();
    }

    drawInkDots() {
      const ctx = this.ctx;
      const tide = this.tide;
      const r1 = tide.dotTier1 === undefined ? 13 : tide.dotTier1;
      const r2 = tide.dotTier2 === undefined ? 9 : tide.dotTier2;
      const colour = [0, 0, 0];
      for (let i = 0; i < this.rows.length; i += 1) {
        const row = this.rows[i];
        const tier = row.city.tier >= 1 ? r1 : r2;
        const radius = tier * (0.7 + 0.6 * (row.displayRisk / 100));
        riskColour(row.displayRisk, colour);
        const g = ctx.createRadialGradient(row.x, row.y, 0, row.x, row.y, radius);
        g.addColorStop(0, 'rgba(' + colour[0] + ',' + colour[1] + ',' + colour[2] + ',0.55)');
        g.addColorStop(0.55, 'rgba(' + colour[0] + ',' + colour[1] + ',' + colour[2] + ',0.22)');
        g.addColorStop(1, 'rgba(' + colour[0] + ',' + colour[1] + ',' + colour[2] + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(row.x, row.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawContours() {
      const ctx = this.ctx;
      const fw = this.fieldWidth, fh = this.fieldHeight;
      const step = this.fieldStep;
      const field = this.riskField;
      const threshold = this.tide.contourRisk === undefined ? 55 : this.tide.contourRisk;
      const colour = [0, 0, 0];
      riskColour(Math.min(100, threshold * 1.28), colour);
      ctx.strokeStyle = 'rgba(' + colour[0] + ',' + colour[1] + ',' + colour[2] + ','
        + (this.tide.contourAlpha === undefined ? 0.34 : this.tide.contourAlpha) + ')';
      ctx.lineWidth = 1.1;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let gy = 0; gy < fh - 1; gy += 1) {
        const y0 = gy * step;
        for (let gx = 0; gx < fw - 1; gx += 1) {
          const x0 = gx * step;
          const i00 = gy * fw + gx;
          const v00 = field[i00];
          const v10 = field[i00 + 1];
          const v01 = field[i00 + fw];
          const v11 = field[i00 + fw + 1];
          let code = 0;
          if (v00 >= threshold) code |= 1;
          if (v10 >= threshold) code |= 2;
          if (v11 >= threshold) code |= 4;
          if (v01 >= threshold) code |= 8;
          if (code === 0 || code === 15) continue;
          const segs = SEGMENTS[code];
          for (let s = 0; s < segs.length; s += 1) {
            const a = this.edgePoint(x0, y0, step, v00, v10, v01, v11, threshold, segs[s][0]);
            const b = this.edgePoint(x0, y0, step, v00, v10, v01, v11, threshold, segs[s][1]);
            ctx.moveTo(a[0], a[1]);
            ctx.lineTo(b[0], b[1]);
          }
        }
      }
      ctx.stroke();
    }

    edgePoint(x0, y0, step, v00, v10, v01, v11, t, edge) {
      const mix = function (va, vb) {
        const span = vb - va;
        return span === 0 ? 0.5 : clamp((t - va) / span, 0, 1);
      };
      switch (edge) {
        case 0: return [x0 + mix(v00, v10) * step, y0];
        case 1: return [x0 + step, y0 + mix(v10, v11) * step];
        case 2: return [x0 + mix(v01, v11) * step, y0 + step];
        default: return [x0, y0 + mix(v00, v01) * step];
      }
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
