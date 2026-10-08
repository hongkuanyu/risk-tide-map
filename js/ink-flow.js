/* global window, document */
(function (global) {
  'use strict';

  const config = global.RiskTideConfig;
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function smoothstep(edge0, edge1, value) {
    const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* 唯一色源：淡墨 -> 灰墨 -> 浓墨 -> 焦墨 -> 焦墨+朱砂（OKLab 连续插值）。 */
  function inkColour(risk) {
    const rgb = [0, 0, 0];
    const renderer = global.RiskTideNationInk;
    if (renderer && typeof renderer.riskColour === 'function') {
      renderer.riskColour(risk, rgb);
    } else {
      rgb[0] = 43; rgb[1] = 43; rgb[2] = 40;
    }
    return { r: rgb[0], g: rgb[1], b: rgb[2], str: 'rgb(' + rgb.join(',') + ')' };
  }

  /* 点到线段的距离（屏幕坐标），供 hover 命中检测。 */
  function pointSegmentDistance(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq ? ((px - a.x) * dx + (py - a.y) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + dx * t, cy = a.y + dy * t;
    return Math.hypot(px - cx, py - cy);
  }

  class InkFlow {
    constructor(canvas, mapController) {
      this.canvas = canvas;
      this.ctx = canvas && canvas.getContext
        ? canvas.getContext('2d', { alpha: true, desynchronized: true }) : null;
      this.map = mapController;
      this.width = 1;
      this.height = 1;
      this.dpr = 1;
      this.route = null;
      this.points = [];
      this.displayRisk = new Float32Array(0);
      this.riskTarget = 0;
      this.routeDirty = true;
      this.progress = 0;
      this.running = false;
      this.visible = !document.hidden;
      this.reducedMotion = !!(global.matchMedia
        && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
      this.elapsed = 0;
      this.lastTime = 0;
      this.hover = 0;
      this.hoverTarget = 0;
      this.frameTimer = 0;
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
      this.dpr = Math.min(global.devicePixelRatio || 1, this.reducedMotion ? 1.5 : 2);
      this.canvas.width = Math.round(this.width * this.dpr);
      this.canvas.height = Math.round(this.height * this.dpr);
      if (this.ctx) this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.routeDirty = true;
      this.requestFrame();
    }

    getRouteCoordinates() {
      if (this.route && this.route.coordinates && this.route.coordinates.length >= 2) return this.route.coordinates;
      const endpoints = config.endpoints || {};
      return endpoints.campus && endpoints.station
        ? [endpoints.campus.coordinate, endpoints.station.coordinate] : null;
    }

    setRoute(route) {
      this.route = route || null;
      this.routeDirty = true;
      this.progress = this.reducedMotion ? 1 : 0;
      this.requestFrame();
      return this;
    }

    setRisk(risk) {
      this.riskTarget = clamp(Number(risk) || 0, 0, 100);
      this.requestFrame();
      return this;
    }

    /* 指针贴近墨线时轻微增强，不做发光 / 放大 / 弹窗。 */
    setHover(strength) {
      this.hoverTarget = clamp(Number(strength) || 0, 0, 1);
      this.requestFrame();
      return this;
    }

    rebuild() {
      this.routeDirty = false;
      this.points = [];
      const coordinates = this.getRouteCoordinates();
      if (!coordinates || coordinates.length < 2 || !this.map
          || typeof this.map.getScreenPath !== 'function') return;
      const projected = this.map.getScreenPath(coordinates, this.route && this.route.coordinateSystem)
        .filter(function (point) { return point && Number.isFinite(point.x) && Number.isFinite(point.y); });
      if (projected.length < 2) return;
      const forward = [projected[0]];
      for (let i = 1; i < projected.length; i += 1) {
        const start = projected[i - 1];
        const end = projected[i];
        const distance = Math.hypot(end.x - start.x, end.y - start.y);
        const count = Math.max(1, Math.ceil(distance / 5));
        for (let j = 1; j <= count; j += 1) {
          const t = j / count;
          forward.push({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
        }
      }
      /* 终点 -> 起点：墨从目的地向出发地渗开 */
      this.points = [];
      for (let i = forward.length - 1; i >= 0; i -= 1) this.points.push(forward[i]);
      /* 与 points 平行的逐点风险采样：新路线直接落在当前目标风险 */
      const n = this.points.length;
      this.displayRisk = new Float32Array(n);
      for (let i = 0; i < n; i += 1) this.displayRisk[i] = this.riskTarget;
    }

    /* 风险沿墨线传播：墨头（终点，index 0）先响应，墨尾（起点）滞后。
       升高像新墨滴进入旧墨；回落更慢，留下余墨。 */
    advanceRisk(dt) {
      const n = this.points.length;
      if (!n) return false;
      const route = (config.ink && config.ink.route) || {};
      const propagate = route.propagate || {};
      const rise = propagate.rise === undefined ? 1.6 : propagate.rise;
      const fall = propagate.fall === undefined ? 3.4 : propagate.fall;
      const rising = this.riskTarget >= this.displayRisk[0];
      const spread = rising ? rise : fall;
      const nMinus = Math.max(1, n - 1);
      let settling = false;
      for (let i = 0; i < n; i += 1) {
        const tau = 0.32 + spread * (i / nMinus);
        const next = this.displayRisk[i] + (this.riskTarget - this.displayRisk[i]) * (1 - Math.exp(-dt / tau));
        this.displayRisk[i] = next;
        if (Math.abs(this.riskTarget - next) > 0.08) settling = true;
      }
      return settling;
    }

    /* 一层湿墨笔触：墨头饱满、墨尾渐淡，宽度 / 浓淡随风险沿墨线变化。
       sharp=0 为柔软墨晕，sharp=1 为稳定墨骨。逐段绘制以获得沿线的
       颜色渐变（风险传播），而非整条线同时换色。 */
    drawRibbon(limit, baseWidth, baseAlpha, sharp) {
      const ctx = this.ctx;
      const points = this.points;
      if (points.length < 2 || limit < 1) return;
      const route = (config.ink && config.ink.route) || {};
      const riskCfg = route.risk || {};
      const flow = route.flow || {};
      const sh = sharp === undefined ? 0.5 : sharp;
      const fadeStart = 0.15 + sh * 0.55;
      const minFrac = 0.12 + sh * 0.16;
      const time = this.reducedMotion ? 0 : this.elapsed;
      const flowAmp = flow.amplitude === undefined ? 0.03 : flow.amplitude;
      const flowPeriod = Math.max(8, flow.period || 26);
      const wMin = riskCfg.width && riskCfg.width.min !== undefined ? riskCfg.width.min : 0.8;
      const wMax = riskCfg.width && riskCfg.width.max !== undefined ? riskCfg.width.max : 1.3;
      const aMin = riskCfg.alpha && riskCfg.alpha.min !== undefined ? riskCfg.alpha.min : 0.72;
      const aMax = riskCfg.alpha && riskCfg.alpha.max !== undefined ? riskCfg.alpha.max : 1.12;

      /* 可见段：墨正在渗开的部分 */
      const endIndex = Math.min(points.length - 1, Math.max(1, Math.floor(limit)));
      const tEnd = limit - Math.floor(limit);
      const vis = [];
      for (let i = 0; i <= endIndex; i += 1) {
        vis.push({ x: points[i].x, y: points[i].y, risk: this.displayRisk[i] });
      }
      if (endIndex < points.length - 1 && tEnd > 0) {
        const a = points[endIndex], b = points[endIndex + 1];
        vis.push({
          x: a.x + (b.x - a.x) * tEnd,
          y: a.y + (b.y - a.y) * tEnd,
          risk: this.displayRisk[endIndex] + (this.displayRisk[endIndex + 1] - this.displayRisk[endIndex]) * tEnd
        });
      }
      const n = vis.length;
      if (n < 2) return;

      /* 边缘 / 浓淡：低频、确定的水墨变化，非随机，无粒子 */
      const left = new Array(n);
      const right = new Array(n);
      const alpha = new Array(n);
      for (let i = 0; i < n; i += 1) {
        const before = vis[Math.max(0, i - 1)];
        const after = vis[Math.min(n - 1, i + 1)];
        const dx = after.x - before.x;
        const dy = after.y - before.y;
        const len = Math.hypot(dx, dy) || 1;
        const t = i / Math.max(1, n - 1);
        const tailFade = 1 - smoothstep(fadeStart, 1, t);
        const taper = minFrac + (1 - minFrac) * tailFade;
        const edge = 1 + Math.sin(t * 17 + 0.7) * 0.055 + Math.sin(t * 5.2 + 1.8) * 0.035;
        const breathe = 1 + Math.sin(time * (Math.PI * 2) / flowPeriod + t * 6.1) * flowAmp;
        const rn = vis[i].risk / 100;
        const widthFactor = wMin + (wMax - wMin) * rn;
        const alphaFactor = aMin + (aMax - aMin) * rn;
        const half = baseWidth * taper * edge * breathe * widthFactor * 0.5;
        const nx = -dy / len, ny = dx / len;
        left[i] = { x: vis[i].x + nx * half, y: vis[i].y + ny * half };
        right[i] = { x: vis[i].x - nx * half, y: vis[i].y - ny * half };
        alpha[i] = clamp(baseAlpha * alphaFactor, 0, 1);
      }

      for (let i = 0; i < n - 1; i += 1) {
        const mid = (vis[i].risk + vis[i + 1].risk) * 0.5;
        const ink = inkColour(mid);
        ctx.globalAlpha = (alpha[i] + alpha[i + 1]) * 0.5;
        ctx.fillStyle = ink.str;
        ctx.beginPath();
        ctx.moveTo(left[i].x, left[i].y);
        ctx.lineTo(left[i + 1].x, left[i + 1].y);
        ctx.lineTo(right[i + 1].x, right[i + 1].y);
        ctx.lineTo(right[i].x, right[i].y);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    /* 墨头：生长中的湿墨，稍浓、略湿，压在纸上向四周轻微渗开，不发光。 */
    drawHead(progress) {
      if (progress >= 1 || this.points.length < 2) return;
      const index = Math.min(this.points.length - 2, Math.floor(progress * (this.points.length - 1)));
      const t = progress * (this.points.length - 1) - index;
      const a = this.points[index], b = this.points[index + 1];
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const risk = this.displayRisk[index] + (this.displayRisk[index + 1] - this.displayRisk[index]) * t;
      const ink = inkColour(risk);
      const cfg = (config.ink && config.ink.route && config.ink.route.head) || {};
      const radius = cfg.radius === undefined ? 3.4 : cfg.radius;
      const alpha = cfg.alpha === undefined ? 0.92 : cfg.alpha;
      const ctx = this.ctx;
      const halo = ctx.createRadialGradient(x, y, 0, x, y, radius * 3.4);
      halo.addColorStop(0, 'rgba(' + ink.r + ',' + ink.g + ',' + ink.b + ',' + (alpha * 0.30).toFixed(3) + ')');
      halo.addColorStop(0.6, 'rgba(' + ink.r + ',' + ink.g + ',' + ink.b + ',' + (alpha * 0.12).toFixed(3) + ')');
      halo.addColorStop(1, 'rgba(' + ink.r + ',' + ink.g + ',' + ink.b + ',0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, radius * 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = ink.str;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    draw() {
      if (!this.ctx) return;
      if (this.routeDirty) this.rebuild();
      this.ctx.clearRect(0, 0, this.width, this.height);
      if (this.points.length < 2) return;
      const limit = (this.points.length - 1) * this.progress;
      const route = (config.ink && config.ink.route) || {};
      const halo = route.halo || { width: 15, alpha: 0.10 };
      const body = route.body || { width: 6.4, alpha: 0.32 };
      const bone = route.bone || { width: 1.7, alpha: 0.90 };
      /* hover：只轻微增强墨骨与整体对比，不发光、不放大 */
      const hoverBoost = 1 + this.hover * 0.18;
      /* 第一层 墨晕：吸墨氛围，最宽、最低透明 */
      this.drawRibbon(limit, halo.width, halo.alpha, 0);
      /* 第二层 墨肉：主要视觉层，宽度 / 浓淡变化 */
      this.drawRibbon(limit, body.width, body.alpha, 0.55);
      /* 第三层 墨骨：细、稳定、深 */
      this.drawRibbon(limit, bone.width, clamp(bone.alpha * hoverBoost, 0, 1), 1);
      /* 墨头：只在生长过程中出现，写完后静置 */
      if (this.progress < 1) this.drawHead(this.progress);
    }

    frame(timestamp) {
      this.framePending = false;
      if (!this.running || !this.visible) return;
      const dt = this.lastTime ? Math.min((timestamp - this.lastTime) / 1000, 0.05) : 0.016;
      this.lastTime = timestamp;
      this.elapsed += this.reducedMotion ? 0 : dt;
      this.hover += (this.hoverTarget - this.hover) * (1 - Math.exp(-dt / 0.35));
      const settling = this.advanceRisk(dt);
      if (!this.reducedMotion && this.progress < 1) {
        const grow = (config.ink && config.ink.route && config.ink.route.growSeconds) || 5.2;
        this.progress = Math.min(1, this.progress + dt / grow);
      }
      this.draw();
      if (this.points.length < 2) return;  /* 尚无路线：不空转 */
      const active = !this.reducedMotion && (this.progress < 1 || settling
        || Math.abs(this.hoverTarget - this.hover) > 0.01);
      if (active) {
        this.requestFrame();
      } else if (!this.reducedMotion) {
        /* 稳定态仍有极轻微流动，低频重绘，几乎不占 CPU */
        global.clearTimeout(this.frameTimer);
        this.frameTimer = global.setTimeout(() => this.requestFrame(), 240);
      }
    }

    setVisible(visible) {
      this.visible = !!visible;
      this.lastTime = 0;
      if (!this.visible) {
        global.clearTimeout(this.frameTimer);
      } else {
        this.requestFrame();
      }
    }

    requestFrame() {
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

    /* 点到墨线的最短距离，返回 0..1 hover 强度。 */
    hoverAt(x, y) {
      if (this.points.length < 2) return 0;
      let best = Infinity;
      for (let i = 0; i < this.points.length - 1; i += 1) {
        const d = pointSegmentDistance(x, y, this.points[i], this.points[i + 1]);
        if (d < best) best = d;
      }
      const radius = 14;
      return best < radius ? 1 - best / radius : 0;
    }

    getMetrics() {
      return { backend: '连续墨线', points: this.points.length, written: Math.round(this.progress * 100) };
    }
  }

  global.RiskTideInkFlow = InkFlow;
})(window);
