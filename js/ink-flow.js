/* global window, document */
(function (global) {
  'use strict';

  const config = global.RiskTideConfig;
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function riskColour(risk) {
    const rgb = [0, 0, 0];
    const renderer = global.RiskTideNationInk;
    if (renderer && typeof renderer.riskColour === 'function') {
      renderer.riskColour(risk, rgb);
    } else {
      rgb[0] = 43; rgb[1] = 43; rgb[2] = 40;
    }
    return 'rgb(' + rgb.join(',') + ')';
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

    drawRibbon(limit, baseWidth, alpha, colour) {
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
      const left = [], right = [];
      for (let i = 0; i < visible.length; i += 1) {
        const before = visible[Math.max(0, i - 1)];
        const after = visible[Math.min(visible.length - 1, i + 1)];
        const dx = after.x - before.x;
        const dy = after.y - before.y;
        const length = Math.hypot(dx, dy) || 1;
        const t = i / Math.max(1, visible.length - 1);
        const taper = 0.18 + 0.82 * Math.pow(Math.sin(Math.PI * t), 0.42);
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
    }

    drawHead(progress, colour) {
      if (progress >= 1 || this.points.length < 2) return;
      const index = Math.min(this.points.length - 2, Math.floor(progress * (this.points.length - 1)));
      const t = progress * (this.points.length - 1) - index;
      const a = this.points[index], b = this.points[index + 1];
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const nx = -Math.sin(angle), ny = Math.cos(angle);
      const tail = 11;
      const halfWidth = 1.9;
      this.ctx.beginPath();
      this.ctx.moveTo(x + Math.cos(angle) * 3, y + Math.sin(angle) * 3);
      this.ctx.lineTo(x - Math.cos(angle) * tail + nx * halfWidth, y - Math.sin(angle) * tail + ny * halfWidth);
      this.ctx.lineTo(x - Math.cos(angle) * tail - nx * halfWidth, y - Math.sin(angle) * tail - ny * halfWidth);
      this.ctx.closePath();
      this.ctx.globalAlpha = 0.78;
      this.ctx.fillStyle = colour;
      this.ctx.fill();
    }

    draw() {
      if (!this.ctx) return;
      if (this.routeDirty) this.rebuild();
      this.ctx.clearRect(0, 0, this.width, this.height);
      if (this.points.length < 2) return;
      const colour = riskColour(this.risk);
      const limit = (this.points.length - 1) * this.progress;
      this.drawRibbon(limit, 8.5, 0.11, colour);
      this.drawRibbon(limit, 4.8, 0.27, colour);
      this.drawRibbon(limit, 1.25, 0.9, colour);
      this.drawHead(this.progress, colour);
    }

    frame(timestamp) {
      this.framePending = false;
      if (!this.running || !this.visible) return;
      const dt = this.lastTime ? Math.min((timestamp - this.lastTime) / 1000, 0.05) : 0.016;
      this.lastTime = timestamp;
      const tau = this.riskTarget >= this.risk ? 1.4 : 2.8;
      this.risk += (this.riskTarget - this.risk) * (1 - Math.exp(-dt / tau));
      if (!this.reducedMotion) this.progress = Math.min(1, this.progress + dt / 4.2);
      this.draw();
      if (this.progress < 1 || Math.abs(this.riskTarget - this.risk) > 0.05) this.requestFrame();
    }

    getMetrics() {
      return { backend: '连续墨线', points: this.points.length, written: Math.round(this.progress * 100) };
    }
  }

  global.RiskTideInkFlow = InkFlow;
})(window);
