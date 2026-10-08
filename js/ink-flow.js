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
      this.routeDirty = true;
      this.risk = 0;
      this.riskTarget = 0;
      this.progress = 0;
      this.running = false;
      this.visible = !document.hidden;
      this.reducedMotion = !!(global.matchMedia
        && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
      this.lastTime = 0;
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
    }

    setVisible(visible) {
      this.visible = !!visible;
      this.lastTime = 0;
      if (this.visible) this.requestFrame();
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
    }

    /* 一层湿墨笔触：头部饱满、尾部渐淡，边缘有轻微的宽度 / 浓淡变化，
       sharp=0 为柔软墨晕，sharp=1 为稳定墨骨。 */
    drawRibbon(limit, baseWidth, alpha, colour, sharp) {
      const ctx = this.ctx;
      const points = this.points;
      if (points.length < 2 || limit < 1) return;
      const endIndex = Math.min(points.length - 1, Math.max(1, Math.floor(limit)));
      const tEnd = limit - Math.floor(limit);
      const visible = points.slice(0, endIndex + 1);
      if (endIndex < points.length - 1 && tEnd > 0) {
        const a = points[endIndex], b = points[endIndex + 1];
        visible.push({ x: a.x + (b.x - a.x) * tEnd, y: a.y + (b.y - a.y) * tEnd });
      }
      if (visible.length < 2) return;
      const sh = sharp === undefined ? 0.5 : sharp;
      const fadeStart = 0.15 + sh * 0.55;
      const minFrac = 0.12 + sh * 0.16;
      const left = [], right = [];
      for (let i = 0; i < visible.length; i += 1) {
        const before = visible[Math.max(0, i - 1)];
        const after = visible[Math.min(visible.length - 1, i + 1)];
        const dx = after.x - before.x;
        const dy = after.y - before.y;
        const length = Math.hypot(dx, dy) || 1;
        const t = i / Math.max(1, visible.length - 1);
        const tailFade = 1 - smoothstep(fadeStart, 1, t);
        const taper = minFrac + (1 - minFrac) * tailFade;
        const edge = 1 + Math.sin(t * 17 + 0.7) * 0.055 + Math.sin(t * 5.2 + 1.8) * 0.035;
        const half = baseWidth * taper * edge * 0.5;
        const nx = -dy / length, ny = dx / length;
        left.push({ x: visible[i].x + nx * half, y: visible[i].y + ny * half });
        right.push({ x: visible[i].x - nx * half, y: visible[i].y - ny * half });
      }
      ctx.beginPath();
      ctx.moveTo(left[0].x, left[0].y);
      for (let i = 1; i < left.length; i += 1) ctx.lineTo(left[i].x, left[i].y);
      for (let i = right.length - 1; i >= 0; i -= 1) ctx.lineTo(right[i].x, right[i].y);
      ctx.closePath();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    /* 墨头：生长中的湿墨，稍浓、略湿，压在纸上向四周轻微渗开，不发光。 */
    drawHead(progress, ink) {
      if (progress >= 1 || this.points.length < 2) return;
      const index = Math.min(this.points.length - 2, Math.floor(progress * (this.points.length - 1)));
      const t = progress * (this.points.length - 1) - index;
      const a = this.points[index], b = this.points[index + 1];
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
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
      const ink = inkColour(this.risk);
      const limit = (this.points.length - 1) * this.progress;
      const route = (config.ink && config.ink.route) || {};
      const halo = route.halo || { width: 15, alpha: 0.10 };
      const body = route.body || { width: 6.4, alpha: 0.32 };
      const bone = route.bone || { width: 1.7, alpha: 0.90 };
      /* 第一层 墨晕：湿墨扩散 */
      this.drawRibbon(limit, halo.width, halo.alpha, ink.str, 0);
      /* 第二层 墨肉：宽度 / 浓淡变化 */
      this.drawRibbon(limit, body.width, body.alpha, ink.str, 0.55);
      /* 第三层 墨骨：细、稳定、深 */
      this.drawRibbon(limit, bone.width, bone.alpha, ink.str, 1);
      /* 墨头：只在生长过程中出现，写完后静置 */
      if (this.progress < 1) this.drawHead(this.progress, ink);
    }

    frame(timestamp) {
      this.framePending = false;
      if (!this.running || !this.visible) return;
      const dt = this.lastTime ? Math.min((timestamp - this.lastTime) / 1000, 0.05) : 0.016;
      this.lastTime = timestamp;
      const tau = this.riskTarget >= this.risk ? 1.4 : 2.8;
      this.risk += (this.riskTarget - this.risk) * (1 - Math.exp(-dt / tau));
      if (!this.reducedMotion) {
        const grow = (config.ink && config.ink.route && config.ink.route.growSeconds) || 5.2;
        this.progress = Math.min(1, this.progress + dt / grow);
      }
      this.draw();
      if (this.progress < 1 || Math.abs(this.riskTarget - this.risk) > 0.05) this.requestFrame();
    }

    getMetrics() {
      return { backend: '连续墨线', points: this.points.length, written: Math.round(this.progress * 100) };
    }
  }

  global.RiskTideInkFlow = InkFlow;
})(window);
