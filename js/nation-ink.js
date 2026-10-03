/* global window, document */
/*
 * 全国墨迹渲染器
 *
 * 每座城市一团墨；墨的"大小 + 浓度"由风险决定（墨即风险）。
 *   - 半径与不透明度都随风险单调上升，同样的风险值给出同样的视觉强度
 *   - 边缘由多组正弦叠加成不规则形状，不是标准圆形渐变 / heatmap blob
 *   - 每座城市有独立的相位与周期，动画互不同步；整体极慢
 *   - 朱砂只在最高区间出现（颜色由 config.silk.riskRamp 决定，最高约 8%）
 *   - prefers-reduced-motion 时冻结动画，只保留静态墨迹
 */
(function (global) {
  'use strict';
  const config = global.RiskTideConfig;

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(e0, e1, x) {
    const s = e1 - e0;
    if (s === 0) return x < e0 ? 0 : 1;
    const t = clamp((x - e0) / s, 0, 1);
    return t * t * (3 - 2 * t);
  }
  function hash01(seed) {
    const s = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }
  function rampColor(stops, t, out) {
    const x = clamp(t, 0, 1);
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 1; i < stops.length; i++) if (x <= stops[i].at) { a = stops[i - 1]; b = stops[i]; break; }
    const s = (b.at - a.at) || 1;
    const k = smoothstep(0, 1, clamp((x - a.at) / s, 0, 1));
    out[0] = a.rgb[0] + (b.rgb[0] - a.rgb[0]) * k;
    out[1] = a.rgb[1] + (b.rgb[1] - a.rgb[1]) * k;
    out[2] = a.rgb[2] + (b.rgb[2] - a.rgb[2]) * k;
    return out;
  }

  class NationInk {
    constructor(canvas, mapController) {
      this.canvas = canvas;
      this.ctx = canvas && canvas.getContext ? canvas.getContext('2d', { alpha: true, desynchronized: true }) : null;
      this.map = mapController;
      this.rows = [];
      this.width = 1; this.height = 1; this.dpr = 1;
      this.running = false; this.visible = !document.hidden;
      this.lastTime = 0; this.elapsed = 0;
      this.profile = { reducedMotion: !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches) };
      this.boundFrame = this.frame.bind(this);
      this.resize();
      this.observeResize();
      this.initDebug();
    }

    observeResize() {
      if (!global.ResizeObserver || !this.canvas || this.resizeObserver) return;
      const self = this;
      this.resizeObserver = new global.ResizeObserver(function () { self.resize(); });
      this.resizeObserver.observe(this.canvas.parentNode || this.canvas);
    }

    resize() {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, rect.width || 600);
      const h = Math.max(1, rect.height || 400);
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      this.width = w; this.height = h; this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      if (this.ctx && this.ctx.setTransform) this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /* rows 来自 js/nation-risk.js：{city, risk, distanceKm, travelMinutes} */
    setData(rows) { this.rows = (rows || []).filter(function (r) { return r && r.city && r.risk !== null; }); }

    /* 把经纬度投影到画布（复用地图控制器，和路线渲染器同一套投影） */
    /* 等距圆柱投影：把中国范围直接映射进画布。
       用途有二：地图控制器给不出合理坐标时兜底（例如降级底图只覆盖无锡），
       以及本地无法使用高德时的可验证路径。 */
    flatProject(coord) {
      const ink = (config.nation && config.nation.ink) || {};
      const b = ink.bounds || [73, 18, 136, 54];
      const pad = ink.pad === undefined ? 0.06 : ink.pad;
      const x = (coord[0] - b[0]) / (b[2] - b[0]);
      const y = 1 - (coord[1] - b[1]) / (b[3] - b[1]);
      return {
        x: this.width * (pad + clamp(x, 0, 1) * (1 - 2 * pad)),
        y: this.height * (pad + clamp(y, 0, 1) * (1 - 2 * pad))
      };
    }

    projectCity(city) {
      const ink = (config.nation && config.nation.ink) || {};
      if (ink.projection !== 'flat' && this.map && typeof this.map.getScreenPath === 'function') {
        const p = this.map.getScreenPath([city.coordinate])[0];
        /* 只有落在画布附近才采信地图投影；否则退到等距投影，
           避免降级底图把城市投到画布外几十万像素处。 */
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)
            && p.x > -this.width * 0.5 && p.x < this.width * 1.5
            && p.y > -this.height * 0.5 && p.y < this.height * 1.5) {
          return p;
        }
      }
      return this.flatProject(city.coordinate);
    }

    radiusFor(risk, tier, viewScale) {
      const cfg = (config.nation && config.nation.ink) || {};
      const rMin = cfg.radiusMin === undefined ? 5 : cfg.radiusMin;
      const rMax = cfg.radiusMax === undefined ? 44 : cfg.radiusMax;
      const t = clamp(risk / 100, 0, 1);
      /* 低风险时面积很小，风险上升才明显铺开（平方让"淹没感"来得晚一点） */
      const base = lerp(rMin, rMax, Math.pow(t, 1.35));
      const tierGain = tier === 1 ? 1.18 : 1;
      return base * tierGain * (viewScale || 1);
    }

    alphaFor(risk) {
      const cfg = (config.nation && config.nation.ink) || {};
      const aMin = cfg.alphaMin === undefined ? 0.10 : cfg.alphaMin;
      const aMax = cfg.alphaMax === undefined ? 0.78 : cfg.alphaMax;
      return lerp(aMin, aMax, Math.pow(clamp(risk / 100, 0, 1), 1.25));
    }

    /* 不规则边缘：每座城市有自己的相位与频率，绝不与邻城同步 */
    blotPath(cx, cy, radius, seed, time) {
      const ctx = this.ctx;
      const steps = this.profile.reducedMotion ? 30 : 34;
      const wob = 0.16;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const n1 = Math.sin(a * 3 + seed * 6.3 + time * 0.09);
        const n2 = Math.sin(a * 5 - seed * 4.1 + time * 0.061);
        const n3 = Math.sin(a * 8 + seed * 9.7 - time * 0.037);
        const r = radius * (1 + wob * (n1 * 0.5 + n2 * 0.32 + n3 * 0.18));
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }

    draw() {
      const ctx = this.ctx;
      if (!ctx) return;
      ctx.clearRect(0, 0, this.width, this.height);
      if (!this.rows.length) return;
      const stops = (config.silk && config.silk.riskRamp) || null;
      const col = [0, 0, 0];
      const ink = (config.nation && config.nation.ink) || {};
      const viewScale = ink.viewScale === undefined ? 1 : ink.viewScale;
      let painted = 0;
      for (let i = 0; i < this.rows.length; i++) {
        const row = this.rows[i];
        const p = this.projectCity(row.city);
        if (!p) continue;
        /* 画布外的城市直接跳过 —— 全国缩放下这是主要的省时手段 */
        const radius = this.radiusFor(row.risk, row.city.tier, viewScale);
        if (p.x < -radius * 2 || p.y < -radius * 2 || p.x > this.width + radius * 2 || p.y > this.height + radius * 2) continue;
        const alpha = this.alphaFor(row.risk);
        if (alpha < 0.012) continue;
        rampColor(stops, row.risk / 100, col);
        const r = Math.round(col[0]), g = Math.round(col[1]), b = Math.round(col[2]);
        const seed = hash01(i + row.city.id.length * 3.7);
        const time = this.profile.reducedMotion ? 0 : this.elapsed;
        ctx.save();
        /* 墨晕：更大更淡的一层，边缘软，不是 glow */
        ctx.globalAlpha = alpha * 0.30;
        ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
        this.blotPath(p.x, p.y, radius * 1.42, seed + 0.7, time * 0.7);
        ctx.fill();
        /* 墨体本体 */
        ctx.globalAlpha = alpha;
        this.blotPath(p.x, p.y, radius, seed, time);
        ctx.fill();
        /* 焦墨核心：风险很高时中心再加一点点浓度，形成"淹没"的重心 */
        if (row.risk > 55) {
          ctx.globalAlpha = alpha * smoothstep(55, 100, row.risk) * 0.55;
          this.blotPath(p.x, p.y, radius * 0.5, seed + 1.9, time * 1.2);
          ctx.fill();
        }
        ctx.restore();
        painted += 1;
      }
      this.painted = painted;
      this.refreshDebug();
    }

    /* ?debug=1 时把渲染指标写在页面上，便于线上无法注入脚本时截图定案 */
    initDebug() {
      if (!/[?&]debug=1/.test(global.location ? global.location.search : '')) return;
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:9999;background:rgba(12,18,20,.84);color:#cfe8e4;font:11px/1.5 ui-monospace,Menlo,monospace;padding:8px 10px;border-radius:8px;pointer-events:none;white-space:pre';
      document.body.appendChild(el);
      this.debugEl = el;
    }

    refreshDebug() {
      if (!this.debugEl) return;
      let inside = 0, skipped = 0;
      const self = this;
      this.rows.forEach(function (row) {
        const pt = self.projectCity(row.city);
        if (!pt) { skipped += 1; return; }
        const rr = self.radiusFor(row.risk, row.city.tier, 1);
        if (pt.x < -rr * 2 || pt.y < -rr * 2 || pt.x > self.width + rr * 2 || pt.y > self.height + rr * 2) skipped += 1;
        else inside += 1;
      });
      this.debugEl.textContent = 'nation-ink'
        + '\ncities   ' + this.rows.length
        + '\nonCanvas ' + inside + '  skipped ' + skipped
        + '\npainted  ' + (this.painted || 0)
        + '\ncanvas   ' + Math.round(this.width) + 'x' + Math.round(this.height) + '  dpr ' + this.dpr
        + '\nreduced  ' + this.profile.reducedMotion;
    }

    setVisible(v) { this.visible = !!v; this.lastTime = 0; }
    start() {
      if (this.running || !this.ctx) return;
      this.running = true;
      global.requestAnimationFrame(this.boundFrame);
    }
    stop() { this.running = false; }
    getMetrics() {
      return { cities: this.rows.length, painted: this.painted || 0, reducedMotion: this.profile.reducedMotion };
    }
    frame(ts) {
      if (!this.running) return;
      const dt = this.lastTime ? Math.min((ts - this.lastTime) / 1000, 0.032) : 0.016;
      this.lastTime = ts;
      try {
        if (this.visible) {
          this.elapsed += this.profile.reducedMotion ? 0 : dt;
          this.draw();
        }
      } catch (e) {
        if (global.console && console.warn) console.warn('nation-ink frame skipped: ' + (e && e.message ? e.message : e));
      }
      global.requestAnimationFrame(this.boundFrame);
    }
  }

  NationInk.rampColor = rampColor;
  global.RiskTideNationInk = NationInk;
})(window);