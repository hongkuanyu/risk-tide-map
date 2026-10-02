/* global window, document */
/*
 * Risk Tide V6 - InkFlowRenderer.
 *
 * The route is not drawn as lines and nothing travels along it. Instead the
 * ink *body* is a persistent density field that is advected every frame:
 *
 *   velocity field (built from the route)  ->  semi-Lagrangian advection
 *   ->  diffusion  ->  decay  ->  injection at the source
 *
 * Each frame transports the previous frame's ink forward, so the medium has
 * fluid memory: stretching, shearing, curling at bends and merging are all
 * consequences of the transport rather than of drawing strokes.
 *
 * Two density fields (a cool one and a warmer one) are advected together and
 * injected with different profiles, so pigment migrates inside the stream and
 * the colour is never uniform.
 *
 * It consumes only the existing route points and risk score.
 */
(function (global) {
  'use strict';

  const config = global.RiskTideConfig;

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(e0, e1, x) {
    const span = e1 - e0;
    if (span === 0) return x < e0 ? 0 : 1;
    const t = clamp((x - e0) / span, 0, 1);
    return t * t * (3 - 2 * t);
  }
  function hash01(n) {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  function rampColor(stops, t, out) {
    const x = clamp(t, 0, 1);
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let i = 1; i < stops.length; i += 1) {
      if (x <= stops[i].at) { a = stops[i - 1]; b = stops[i]; break; }
    }
    const span = (b.at - a.at) || 1;
    const local = smoothstep(0, 1, clamp((x - a.at) / span, 0, 1));
    out[0] = Math.round(lerp(a.rgb[0], b.rgb[0], local));
    out[1] = Math.round(lerp(a.rgb[1], b.rgb[1], local));
    out[2] = Math.round(lerp(a.rgb[2], b.rgb[2], local));
    return out;
  }

  /* Catmull-Rom resample: the field follows a smooth centreline, not the raw
     polyline. */
  function resample(points, spacing) {
    const out = [];
    if (!points || points.length < 2) return out;
    if (points.length === 2) return [points[0], points[1]];
    const last = points.length - 1;
    for (let i = 0; i < last; i += 1) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(last, i + 2)];
      const seg = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
      const steps = Math.max(1, Math.round(seg / spacing));
      for (let s = 0; s < steps; s += 1) {
        const t = s / steps;
        const t2 = t * t;
        const t3 = t2 * t;
        out.push({
          x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
        });
      }
    }
    out.push(points[last]);
    return out;
  }

  class InkFlow {
    constructor(canvas, mapController) {
      const cfg = (config && config.inkFlow) || {};
      this.config = cfg;
      this.canvas = canvas;
      this.ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
      this.map = mapController;
      this.width = 1;
      this.height = 1;
      this.dpr = 1;
      this.cell = 8;
      this.cols = 1;
      this.rows = 1;

      this.route = null;
      this.routeDirty = true;
      this.running = false;
      this.visible = !document.hidden;
      this.lastTime = 0;
      this.elapsed = 0;

      this.risk = 0;
      this.riskTarget = 0;
      this.colour = [0, 124, 108];
      this.colourFrom = [0, 124, 108];

      this.off = document.createElement('canvas');
      this.offCtx = this.off.getContext('2d');
      this.imageData = null;

      this.boundFrame = this.frame.bind(this);
      this.resize();
      this.observeResize();
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
      this.width = w;
      this.height = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      if (this.ctx && this.ctx.setTransform) this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const mobile = (global.innerWidth || 960) <= 760;
      const target = (this.config.grid && (mobile ? this.config.grid.mobile : this.config.grid.desktop)) || 168;
      let cell = Math.max(3, Math.round(Math.max(w, h) / target));
      // hard budget: the CPU solver must not exceed ~150k cells per frame
      while ((Math.ceil(w / cell) + 2) * (Math.ceil(h / cell) + 2) > 150000) cell += 1;
      const cols = Math.ceil(w / cell) + 2;
      const rows = Math.ceil(h / cell) + 2;
      if (cols === this.cols && rows === this.rows && cell === this.cell) return;
      this.cell = cell;
      this.cols = cols;
      this.rows = rows;
      const n = cols * rows;
      this.cool = new Float32Array(n);
      this.warm = new Float32Array(n);
      this.coolNext = new Float32Array(n);
      this.warmNext = new Float32Array(n);
      this.vx = new Float32Array(n);
      this.vy = new Float32Array(n);
      this.core = new Float32Array(n);
      this.source = new Float32Array(n);
      this.imageData = this.offCtx.createImageData(cols, rows);
      this.off.width = cols;
      this.off.height = rows;
      this.routeDirty = true;
    }

    /* Adaptive quality: if the solver is eating the frame budget, coarsen
       the simulation grid; when it is comfortable again, refine it. */
    adaptQuality(dt) {
      const ms = dt * 1000;
      this.frameAvg = this.frameAvg ? this.frameAvg + (ms - this.frameAvg) * 0.05 : ms;
      this.adaptTimer = (this.adaptTimer || 0) + dt;
      if (this.adaptTimer < 2.5) return;
      this.adaptTimer = 0;
      const before = this.cell;
      if (this.frameAvg > 24 && this.cell < 14) this.cell += 1;
      else if (this.frameAvg < 14 && this.cell > 3) this.cell -= 1;
      if (this.cell !== before) {
        this.cols = 0; this.rows = 0;
        this.resize();
      }
    }

    setRoute(route) { this.route = route || null; this.routeDirty = true; return this; }

    setRisk(risk) {
      const v = clamp(Number(risk) || 0, 0, 100);
      if (v !== this.riskTarget) {
        this.colourFrom = this.colour.slice();
        this.riskTarget = v;
      }
      return this;
    }

    getRouteCoordinates() {
      const route = this.route;
      if (route && route.coordinates && route.coordinates.length >= 2) return route.coordinates;
      const e = config.endpoints || {};
      if (e.campus && e.station) return [e.campus.coordinate, e.station.coordinate];
      return null;
    }

    /* Build the velocity field: every cell near the route knows which way the
       ink should be carried, and how fast. Cells further from the centre move
       slower (viscous shear), and bends add a rotational component so the
       stream curls through corners. */
    rebuild() {
      if (!this.map) return;
      const coords = this.getRouteCoordinates();
      if (!coords || coords.length < 2) { this.routeDirty = false; return; }
      let projected;
      if (typeof this.map.getScreenPath === 'function') {
        projected = this.map.getScreenPath(coords, this.route && this.route.coordinateSystem);
      } else {
        projected = [];
      }
      const clean = projected.filter(function (p) { return p && Number.isFinite(p.x) && Number.isFinite(p.y); });
      if (clean.length < 2) { this.routeDirty = false; return; }

      const pts = resample(clean, 4);
      const n = pts.length;
      const tx = new Float32Array(n);
      const ty = new Float32Array(n);
      const curv = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        const a = pts[Math.max(0, i - 1)];
        const b = pts[Math.min(n - 1, i + 1)];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        tx[i] = dx / len;
        ty[i] = dy / len;
      }
      for (let i = 1; i < n - 1; i += 1) {
        curv[i] = (tx[i - 1] * ty[i + 1]) - (ty[i - 1] * tx[i + 1]);
      }

      // coarse spatial hash so the nearest-sample search stays cheap
      const bucket = Math.max(8, this.cell * 2);
      const buckets = new Map();
      for (let i = 0; i < n; i += 1) {
        const key = (Math.floor(pts[i].x / bucket)) + ':' + (Math.floor(pts[i].y / bucket));
        let list = buckets.get(key);
        if (!list) { list = []; buckets.set(key, list); }
        list.push(i);
      }

      const cfg = this.config;
      const radius = (cfg.influence && cfg.influence.radius) || 30;
      const coreR = (cfg.influence && cfg.influence.coreRadius) || 11;
      const speed = cfg.speed || 46;
      const shear = cfg.edgeShear === undefined ? 0.35 : cfg.edgeShear;
      const swirl = cfg.curveSwirl === undefined ? 0.55 : cfg.curveSwirl;
      const r2 = radius * radius;
      this.vx.fill(0); this.vy.fill(0); this.core.fill(0); this.source.fill(0);

      for (let gy = 0; gy < this.rows; gy += 1) {
        for (let gx = 0; gx < this.cols; gx += 1) {
          const idx = gy * this.cols + gx;
          const px = gx * this.cell;
          const py = gy * this.cell;
          const bx = Math.floor(px / bucket);
          const by = Math.floor(py / bucket);
          let best = -1;
          let bestD2 = r2;
          for (let oy = -1; oy <= 1; oy += 1) {
            for (let ox = -1; ox <= 1; ox += 1) {
              const list = buckets.get((bx + ox) + ':' + (by + oy));
              if (!list) continue;
              for (let k = 0; k < list.length; k += 1) {
                const i = list[k];
                const dx = pts[i].x - px;
                const dy = pts[i].y - py;
                const d2 = dx * dx + dy * dy;
                if (d2 < bestD2) { bestD2 = d2; best = i; }
              }
            }
          }
          if (best < 0) continue;
          const d = Math.sqrt(bestD2);
          const fall = smoothstep(radius, coreR, d);   // 1 at the core, 0 at the rim
          if (fall <= 0.001) continue;
          this.core[idx] = fall;
          const local = shear + (1 - shear) * fall;    // edges lag behind
          const lateral = Math.max(-1, Math.min(1, (d / radius) * 2 - 1));
          // rotational term at bends: opposite sides move opposite ways
          const rot = swirl * curv[best] * 8 * lateral;
          const nx = -ty[best];
          const ny = tx[best];
          /* flow runs from the destination back to the origin, so the
             tangent is negated (the route array is origin -> destination) */
          this.vx[idx] = (-tx[best] * local + nx * rot) * speed;
          this.vy[idx] = (-ty[best] * local + ny * rot) * speed;
        }
      }

      /* Injection profile: full strength at the head of the route, a trickle
         along the rest so the stream never dries out completely. */
      for (let i = 0; i < n; i += 1) {
        const along = i / (n - 1);
        /* inject at the far end: 'along' is measured from the origin, so the
           destination is along = 1 */
        const w = 1 - smoothstep(0, 0.22, 1 - along);
        const gx = Math.round(pts[i].x / this.cell);
        const gy = Math.round(pts[i].y / this.cell);
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            const cx = gx + ox;
            const cy = gy + oy;
            if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) continue;
            const idx = cy * this.cols + cx;
            const dd = Math.hypot(cx * this.cell - pts[i].x, cy * this.cell - pts[i].y);
            const g = dd < 1.5 ? 1 : 0.4;
            const add = w * g + 0.05;              // 起点满注 + 沿途少量补墨
            if (add > this.source[idx]) this.source[idx] = add;
          }
        }
      }

      // pre-warm: run the transport for a while so the stream already spans the
      // route when the page settles
      const steps = cfg.prewarmSteps === undefined ? 150 : cfg.prewarmSteps;
      for (let s = 0; s < steps; s += 1) this.step(1 / 60, true);
      this.routeDirty = false;
    }

    /* One transport step: advect the previous frame's body, let it diffuse,
       let it dry, then inject fresh pigment at the source. */
    step(dt, warmPhase) {
      const cols = this.cols;
      const rows = this.rows;
      const cell = this.cell;
      const cfg = this.config;
      const diffuse = cfg.diffusion === undefined ? 0.16 : cfg.diffusion;
      const decay = cfg.decay === undefined ? 0.985 : cfg.decay;
      const inject = cfg.injection === undefined ? 0.55 : cfg.injection;
      const warmBias = cfg.warmBias === undefined ? 0.24 : cfg.warmBias;
      const cool = this.cool;
      const warm = this.warm;
      const cn = this.coolNext;
      const wn = this.warmNext;

      for (let gy = 0; gy < rows; gy += 1) {
        for (let gx = 0; gx < cols; gx += 1) {
          const idx = gy * cols + gx;
          let c = cool[idx];
          let w = warm[idx];
          const vx = this.vx[idx];
          const vy = this.vy[idx];
          if (vx !== 0 || vy !== 0) {
            // back-trace: where did this ink come from?
            const sx = gx * cell - vx * dt;
            const sy = gy * cell - vy * dt;
            const fx = sx / cell;
            const fy = sy / cell;
            const x0 = Math.floor(fx);
            const y0 = Math.floor(fy);
            if (x0 >= 0 && y0 >= 0 && x0 < cols - 1 && y0 < rows - 1) {
              const ax = fx - x0;
              const ay = fy - y0;
              const i00 = y0 * cols + x0;
              const i10 = i00 + 1;
              const i20 = i00 + cols;
              const i30 = i20 + 1;
              const w00 = (1 - ax) * (1 - ay);
              const w10 = ax * (1 - ay);
              const w01 = (1 - ax) * ay;
              const w11 = ax * ay;
              c = cool[i00] * w00 + cool[i10] * w10 + cool[i20] * w01 + cool[i30] * w11;
              w = warm[i00] * w00 + warm[i10] * w10 + warm[i20] * w01 + warm[i30] * w11;
            }
          }
          c *= decay;
          w *= decay;
          if (inject > 0) {
            const s = this.source[idx];
            if (s > 0) {
              // the warmer pigment enters a little downstream and stronger
              c += s * inject * dt * 26;
              w += s * inject * dt * 26 * warmBias * (1 + 0.5 * Math.sin(this.elapsed * 0.7 + gx * 0.05));
            }
          }
          cn[idx] = c;
          wn[idx] = w;
        }
      }

      // diffusion: a light 4-neighbour blur so the body spreads like wet ink
      if (diffuse > 0) {
        for (let gy = 0; gy < rows; gy += 1) {
          for (let gx = 0; gx < cols; gx += 1) {
            const idx = gy * cols + gx;
            const c = cn[idx];
            const w = wn[idx];
            const cl = gx > 0 ? cn[idx - 1] : c;
            const cr = gx < cols - 1 ? cn[idx + 1] : c;
            const cu = gy > 0 ? cn[idx - cols] : c;
            const cd = gy < rows - 1 ? cn[idx + cols] : c;
            const wl = gx > 0 ? wn[idx - 1] : w;
            const wr = gx < cols - 1 ? wn[idx + 1] : w;
            const wu = gy > 0 ? wn[idx - cols] : w;
            const wd = gy < rows - 1 ? wn[idx + cols] : w;
            cool[idx] = c + ((cl + cr + cu + cd) * 0.25 - c) * diffuse;
            warm[idx] = w + ((wl + wr + wu + wd) * 0.25 - w) * diffuse;
          }
        }
      } else {
        cool.set(cn);
        warm.set(wn);
      }
      if (!warmPhase) this.elapsed += dt;
    }

    update(dt) {
      if (this.routeDirty) this.rebuild();
      const easeMs = Math.max(60, this.config.colourEaseMs || 280);
      const t = clamp((dt * 1000) / easeMs, 0, 1);
      const stops = (config.silk && config.silk.riskRamp) || null;
      const target = stops ? rampColor(stops, this.riskTarget / 100, [0, 0, 0]) : [0, 124, 108];
      this.colour[0] = Math.round(lerp(this.colour[0], target[0], t));
      this.colour[1] = Math.round(lerp(this.colour[1], target[1], t));
      this.colour[2] = Math.round(lerp(this.colour[2], target[2], t));
      this.risk = lerp(this.risk, this.riskTarget, Math.min(1, dt * 4.5));
      this.step(dt, false);
      this.adaptQuality(dt);
    }

    render() {
      const ctx = this.ctx;
      if (!ctx || !this.imageData) return;
      const data = this.imageData.data;
      const cols = this.cols;
      const rows = this.rows;
      const cool = this.cool;
      const warm = this.warm;
      const cr = this.colour[0];
      const cg = this.colour[1];
      const cb = this.colour[2];
      // warmer pigment the stream picks up as it runs
      const wr = Math.round(lerp(cr, 196, 0.34));
      const wg = Math.round(lerp(cg, 150, 0.34));
      const wb = Math.round(lerp(cb, 60, 0.34));
      for (let i = 0; i < cols * rows; i += 1) {
        const c = cool[i];
        const w = warm[i];
        const total = c + w;
        const p = i * 4;
        if (total < 0.012) { data[p + 3] = 0; continue; }
        const mix = c / (total + 1e-6);
        data[p] = Math.round(lerp(wr, cr, mix));
        data[p + 1] = Math.round(lerp(wg, cg, mix));
        data[p + 2] = Math.round(lerp(wb, cb, mix));
        // density -> alpha, softly compressed so the core stays readable
        /* 浓度 -> 不透明度用对比曲线：核心迅速变实，边缘迅速变淡，
           这样墨体有"重量"，而不是一团均匀的雾。 */
        data[p + 3] = Math.round(255 * clamp(Math.pow(Math.min(1.15, total), 1.9) * 1.15, 0, 0.90));
      }
      this.offCtx.putImageData(this.imageData, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.off, 0, 0, cols, rows, 0, 0, cols * this.cell, rows * this.cell);
    }

    setVisible(v) { this.visible = !!v; this.lastTime = 0; }

    start() {
      if (this.running || !this.ctx) return;
      this.running = true;
      this.visible = !document.hidden;
      this.lastTime = 0;
      global.requestAnimationFrame(this.boundFrame);
    }

    stop() { this.running = false; }

    getMetrics() {
      let wet = 0;
      for (let i = 0; i < this.cool.length; i += 1) {
        if (this.cool[i] + this.warm[i] > 0.05) wet += 1;
      }
      return { cells: this.cols * this.rows, wet: wet, grid: this.cols + 'x' + this.rows,
        cell: this.cell, fps: Math.round(1000 / Math.max(1, this.frameAvg || 16.7)),
        frameMs: Number((this.frameAvg || 16.7).toFixed(1)), risk: Math.round(this.risk) };
    }

    frame(timestamp) {
      if (!this.running) return;
      const dt = this.lastTime ? Math.min((timestamp - this.lastTime) / 1000, 0.032) : 0.016;
      this.lastTime = timestamp;
      try {
        if (this.visible) {
          this.update(dt);
          this.render();
        }
      } catch (error) {
        if (global.console && console.warn) {
          console.warn('墨流帧已跳过：' + (error && error.message ? error.message : error));
        }
      }
      global.requestAnimationFrame(this.boundFrame);
    }
  }

  InkFlow.rampColor = rampColor;
  InkFlow.resample = resample;
  global.RiskTideInkFlow = InkFlow;
})(window);