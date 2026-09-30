/* global window, document */
/*
 * Risk Tide V4 - silk wet-ink route renderer.
 *
 * Draws the route as 12-24 semi-transparent ink strands instead of a solid
 * navigation polyline: a wide wet diffusion, the main colour bundle, moving
 * highlight hairs and a few ink runners. The map stays visible through it.
 *
 * Rules honoured from the brief:
 *   - consumes the existing route points + risk score, never recomputes them
 *   - continuous multi-stop risk colour (青碧 -> 金 -> 朱砂) with temporal easing
 *   - Catmull-Rom smoothing, precomputed tangents / normals / cumulative length
 *   - dash-driven forward flow, long tails, slow width breathing, no jitter
 *   - devicePixelRatio <= 2, rAF, dt capped, honours prefers-reduced-motion
 */
(function (global) {
  'use strict';

  const config = global.RiskTideConfig;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function smoothstep(edge0, edge1, x) {
    const span = edge1 - edge0;
    if (span === 0) return x < edge0 ? 0 : 1;
    const t = clamp((x - edge0) / span, 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* Deterministic 0..1 noise so a rebuild never reshuffles the silk. */
  function hash01(n) {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  function rangeAt(range, t) {
    if (!range || !range.length) return t;
    if (range.length === 1) return range[0];
    return lerp(range[0], range[1], t);
  }

  /* Multi-stop ramp with smoothstep easing between stops - a continuous
     gradient, never an if/else colour jump. */
  function rampColor(stops, t, out) {
    if (!stops || !stops.length) return out;
    const x = clamp(t, 0, 1);
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let i = 1; i < stops.length; i += 1) {
      if (x <= stops[i].at) { a = stops[i - 1]; b = stops[i]; break; }
    }
    const span = (b.at - a.at) || 1;
    const local = smoothstep(0, 1, clamp((x - a.at) / span, 0, 1));
    out.r = Math.round(lerp(a.rgb[0], b.rgb[0], local));
    out.g = Math.round(lerp(a.rgb[1], b.rgb[1], local));
    out.b = Math.round(lerp(a.rgb[2], b.rgb[2], local));
    return out;
  }

  function detectProfile(silkConfig) {
    const width = global.innerWidth || document.documentElement.clientWidth || 960;
    const mobile = width <= 760 || /Mobi|Android|iPhone|iPad/i.test(global.navigator.userAgent);
    const cores = global.navigator.hardwareConcurrency || 4;
    const memory = global.navigator.deviceMemory || 4;
    const reducedMotion = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const low = cores <= 4 || memory <= 4;
    const budget = silkConfig.strands || {};
    let strands = mobile ? (budget.mobile || 12) : (budget.desktop || 18);
    if (low) strands = Math.round(strands * 0.75);
    const dprCap = silkConfig.dpr || {};
    return {
      mobile: mobile,
      low: low,
      reducedMotion: reducedMotion,
      strands: Math.max(6, strands),
      dprCap: mobile ? (dprCap.mobile || 1.75) : (dprCap.desktop || 2),
      baseWidth: mobile ? (silkConfig.baseWidth && silkConfig.baseWidth.mobile) || [9, 12]
                            : (silkConfig.baseWidth && silkConfig.baseWidth.desktop) || [11, 15]
    };
  }

  /* Catmull-Rom resample of the projected polyline: turns the raw polyline
     into a smooth spline without changing where the route actually goes. */
  function resampleSpline(points, spacing) {
    const out = [];
    if (!points || points.length < 2) return out;
    if (points.length === 2) {
      const dx = points[1].x - points[0].x;
      const dy = points[1].y - points[0].y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const steps = Math.max(1, Math.round(len / spacing));
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        out.push({ x: points[0].x + dx * t, y: points[0].y + dy * t });
      }
      return out;
    }
    const last = points.length - 1;
    for (let i = 0; i < last; i += 1) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(last, i + 2)];
      const segLength = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
      const steps = Math.max(1, Math.round(segLength / spacing));
      for (let s = 0; s < steps; s += 1) {
        const t = s / steps;
        const t2 = t * t;
        const t3 = t2 * t;
        out.push({
          x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t
            + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
            + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t
            + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
            + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
        });
      }
    }
    out.push({ x: points[last].x, y: points[last].y });
    return out;
  }

  class SilkRoute {
    constructor(canvas, mapController) {
      const cfg = (config && config.silk) || {};
      this.config = cfg;
      this.canvas = canvas;
      this.ctx = canvas && canvas.getContext
        ? canvas.getContext('2d', { alpha: true, desynchronized: true })
        : null;
      this.map = mapController;
      this.profile = detectProfile(cfg);
      this.width = 1;
      this.height = 1;
      this.dpr = 1;

      this.route = null;
      this.path = null;          // { x, y, nx, ny, dist, total, count }
      this.routeDirty = true;
      this.running = false;
      this.visible = !document.hidden;
      this.lastTime = 0;
      this.elapsed = 0;
      this.flowPhase = 0;

      this.risk = 0;
      this.riskTarget = 0;
      this.colour = { r: 0, g: 124, b: 108 };
      this.colourFrom = { r: 0, g: 124, b: 108 };
      this.colourTo = { r: 0, g: 124, b: 108 };
      this.colourT = 1;

      this.strands = [];
      this.buildStrands();

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

    /* Strand descriptors are stable for the session: layer, lateral offset,
       width, alpha, speed, dash pattern and a small pigment tint. */
    buildStrands() {
      const cfg = this.config;
      const share = cfg.layerShare || { wet: 0.28, main: 0.46, highlight: 0.2, runner: 0.06 };
      const total = this.profile.strands;
      const counts = {
        wet: Math.max(1, Math.round(total * share.wet)),
        runner: Math.max(1, Math.round(total * share.runner)),
        highlight: Math.max(1, Math.round(total * share.highlight))
      };
      counts.main = Math.max(1, total - counts.wet - counts.runner - counts.highlight);

      const dashCfg = cfg.dash || {};
      const sequence = [];
      ['wet', 'main', 'highlight', 'runner'].forEach(function (layer) {
        for (let i = 0; i < counts[layer]; i += 1) sequence.push(layer);
      });

      this.strands = sequence.map(function (layer, i) {
        const r1 = hash01(i * 3.17 + 1.7);
        const r2 = hash01(i * 7.31 + 5.1);
        const r3 = hash01(i * 2.71 + 9.3);
        const r4 = hash01(i * 5.53 + 3.3);
        // centre-weighted lateral offset: dense middle, soft edge
        const signed = r1 * 2 - 1;
        const shaped = Math.sign(signed) * Math.pow(Math.abs(signed), 1 / (cfg.centreBias || 1.35));
        const broken = r4 < (dashCfg.brokenShare === undefined ? 0.45 : dashCfg.brokenShare);
        let dash = null;
        if (layer === 'runner') {
          // one long comet per lap: a bright head with a tail
          const tail = 26 + r2 * 44;
          dash = [tail * 0.32, Math.max(120, tail)];
        } else if (layer === 'highlight' || broken) {
          const run = lerp(dashCfg.minRun || 26, dashCfg.maxRun || 120, r2);
          const gap = lerp(dashCfg.minGap || 3, dashCfg.maxGap || 26, r3);
          dash = [run, gap];
        }
        return {
          layer: layer,
          offset: shaped,
          width: lerp((cfg.strandWidth && cfg.strandWidth[0]) || 0.9,
                      (cfg.strandWidth && cfg.strandWidth[1]) || 2.4, r2),
          alpha: 0.2,
          speed: rangeAt(cfg.speed, r3),
          breathePeriod: rangeAt(cfg.breathePeriod, r1),
          breathePhase: r4 * Math.PI * 2,
          waveFreq: rangeAt(cfg.waveFreq, r2),
          wavePhase: r1 * Math.PI * 2,
          dash: dash,
          dashOffsetSeed: r2 * 1000,
          tint: (r3 * 2 - 1),          // -1 cool pigment .. +1 warm pigment
          swayPhase: r2 * Math.PI * 2
        };
      }).sort(function (a, b) { return a.layer === 'wet' ? -1 : 0; });
    }

    resize() {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const cssWidth = Math.max(1, rect.width || (this.canvas.parentNode ? this.canvas.parentNode.clientWidth : 1));
      const cssHeight = Math.max(1, rect.height || (this.canvas.parentNode ? this.canvas.parentNode.clientHeight : 1));
      const dpr = Math.min(global.devicePixelRatio || 1, this.profile.dprCap);
      this.width = cssWidth;
      this.height = cssHeight;
      this.dpr = dpr;
      const pxW = Math.round(cssWidth * dpr);
      const pxH = Math.round(cssHeight * dpr);
      if (this.canvas.width === pxW && this.canvas.height === pxH) return;
      this.canvas.width = pxW;
      this.canvas.height = pxH;
      if (this.ctx && this.ctx.setTransform) this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.routeDirty = true;
    }

    getRouteCoordinates() {
      const route = this.route;
      if (route && route.coordinates && route.coordinates.length >= 2) return route.coordinates;
      const endpoints = config.endpoints || {};
      if (endpoints.campus && endpoints.station) {
        return [endpoints.campus.coordinate, endpoints.station.coordinate];
      }
      return null;
    }

    setRoute(route) {
      this.route = route || null;
      this.routeDirty = true;
      return this;
    }

    setRisk(risk) {
      const value = clamp(Number(risk) || 0, 0, 100);
      if (value !== this.riskTarget) {
        this.colourFrom = { r: this.colour.r, g: this.colour.g, b: this.colour.b };
        this.colourTo = rampColor(this.config.riskRamp, value / 100, { r: 0, g: 0, b: 0 });
        this.colourT = 0;
        this.riskTarget = value;
      }
      return this;
    }

    rebuild() {
      if (!this.map) return;
      const coordinates = this.getRouteCoordinates();
      if (!coordinates || coordinates.length < 2) {
        this.path = null;
        this.routeDirty = false;
        return;
      }
      let projected;
      if (typeof this.map.getScreenPath === 'function') {
        projected = this.map.getScreenPath(coordinates, this.route && this.route.coordinateSystem);
      } else if (typeof this.map.project === 'function') {
        projected = coordinates.map(function (c) { return this.map.project(c); }, this);
      } else {
        projected = [];
      }
      const clean = projected.filter(function (p) {
        return p && Number.isFinite(p.x) && Number.isFinite(p.y);
      });
      if (clean.length < 2) {
        this.path = null;
        this.routeDirty = false;
        return;
      }

      const sampled = resampleSpline(clean, 3.6);
      const count = sampled.length;
      const x = new Float32Array(count);
      const y = new Float32Array(count);
      const nx = new Float32Array(count);
      const ny = new Float32Array(count);
      const dist = new Float32Array(count);
      for (let i = 0; i < count; i += 1) {
        x[i] = sampled[i].x;
        y[i] = sampled[i].y;
      }
      let total = 0;
      for (let i = 0; i < count; i += 1) {
        if (i > 0) total += Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
        dist[i] = total;
        const prev = Math.max(0, i - 1);
        const next = Math.min(count - 1, i + 1);
        let tx = x[next] - x[prev];
        let ty = y[next] - y[prev];
        const length = Math.hypot(tx, ty) || 1;
        tx /= length;
        ty /= length;
        nx[i] = -ty;
        ny[i] = tx;
      }
      if (total < 8) { this.path = null; this.routeDirty = false; return; }

      /* Curvature per sample: a brush slows and pools ink where the line
         turns, so the renderer needs to know where the turns are. */
      const curv = new Float32Array(count);
      for (let i = 1; i < count - 1; i += 1) {
        const ax = x[i] - x[i - 1];
        const ay = y[i] - y[i - 1];
        const bx = x[i + 1] - x[i];
        const by = y[i + 1] - y[i];
        const la = Math.hypot(ax, ay) || 1;
        const lb = Math.hypot(bx, by) || 1;
        curv[i] = Math.abs((ax * by - ay * bx) / (la * lb));
      }

      const poolCfg = (this.config.brush && this.config.brush.pool) || {};
      const minCurv = poolCfg.minCurvature === undefined ? 0.5 : poolCfg.minCurvature;
      const maxPools = poolCfg.max === undefined ? 14 : poolCfg.max;
      const pools = [];
      let lastPX = 1e9;
      let lastPY = 1e9;
      for (let i = 1; i < count - 1; i += 1) {
        if (curv[i] < minCurv) continue;
        if (Math.hypot(x[i] - lastPX, y[i] - lastPY) < 44) continue;
        pools.push({ x: x[i], y: y[i], k: Math.min(1, curv[i]) });
        lastPX = x[i];
        lastPY = y[i];
        if (pools.length >= maxPools) break;
      }

      this.path = { x: x, y: y, nx: nx, ny: ny, dist: dist, total: total, count: count, curv: curv, pools: pools };
      this.routeDirty = false;
    }

    /* Build one strand's polyline in screen space, cached until the path,
       the canvas size or the strand layout changes. */
    buildStrandPath(strand) {
      const path = this.path;
      const cfg = this.config;
      const baseWidth = rangeAt(this.profile.baseWidth, hash01(strand.dashOffsetSeed));
      const amplitude = baseWidth * 0.5 * (cfg.waveAmp === undefined ? 0.42 : cfg.waveAmp);
      const envelope = cfg.envelope === undefined ? 0.22 : cfg.envelope;
      const points = new Path2D();
      for (let i = 0; i < path.count; i += 1) {
        const t = path.dist[i] / path.total;
        // strands gather at origin and destination, breathe in between
        const gather = smoothstep(0, envelope, t) * smoothstep(1, 1 - envelope, t);
        /* Two incommensurate waves make the bundle silhouette irregular along
           its length - the thing that stops a stroke reading as a vector line. */
        const wave = Math.sin(t * Math.PI * 2 * strand.waveFreq + strand.wavePhase) * amplitude
          + Math.sin(t * Math.PI * 2 * strand.waveFreq * 2.37 + strand.wavePhase * 1.7 + strand.tint)
            * amplitude * 0.32;
        const off = (strand.offset * baseWidth + wave) * gather;
        const px = path.x[i] + path.nx[i] * off;
        const py = path.y[i] + path.ny[i] * off;
        if (i === 0) points.moveTo(px, py);
        else points.lineTo(px, py);
      }
      strand.path = points;
      strand.cachedWidth = baseWidth;
    }

    invalidateStrands() {
      for (let i = 0; i < this.strands.length; i += 1) this.strands[i].path = null;
    }

    setVisible(visible) {
      this.visible = !!visible;
      this.lastTime = 0;
    }

    start() {
      if (this.running || !this.ctx) return;
      this.running = true;
      this.visible = !document.hidden;
      this.lastTime = 0;
      global.requestAnimationFrame(this.boundFrame);
    }

    stop() {
      this.running = false;
    }

    getMetrics() {
      return { strands: this.strands.length, brush: !!(this.config.brush && this.config.brush.enabled), pools: (this.path && this.path.pools) ? this.path.pools.length : 0, risk: Math.round(this.risk) };
    }

    update(dt) {
      /* Light temporal smoothing on dt: a single slow frame would otherwise
         advance the brush in a visible step. Kept gentle so the loop never
         drifts noticeably from real time. */
      this.smoothDt = this.smoothDt ? this.smoothDt + (dt - this.smoothDt) * 0.25 : dt;
      this.elapsed += this.smoothDt;
      const cfg = this.config;
      const speedScale = this.profile.reducedMotion ? (cfg.reducedMotionScale || 0.32) : 1;
      const riskGain = cfg.riskSpeedGain === undefined ? 0.38 : cfg.riskSpeedGain;
      const flow = (cfg.flowSpeed || 34) * (1 + (this.risk / 100) * riskGain) * speedScale;
      this.flowPhase += flow * dt;

      // risk -> colour, temporal easing (~280ms) so ink bleeds, never jumps
      const easeMs = Math.max(60, cfg.colourEaseMs || 280);
      this.colourT = Math.min(1, this.colourT + (dt * 1000) / easeMs);
      const e = smoothstep(0, 1, this.colourT);
      this.colour.r = Math.round(lerp(this.colourFrom.r, this.colourTo.r, e));
      this.colour.g = Math.round(lerp(this.colourFrom.g, this.colourTo.g, e));
      this.colour.b = Math.round(lerp(this.colourFrom.b, this.colourTo.b, e));
      this.risk = lerp(this.risk, this.riskTarget, Math.min(1, dt * 4.5));
    }

    /* Pigment tint: the bundle stays in the risk hue family but individual
       strands lean slightly cool (石青) or warm (赭石). */
    strandColour(tint, alpha) {
      const c = this.colour;
      const r = clamp(c.r + tint * 16 + (tint > 0 ? 12 : 0), 0, 255);
      const g = clamp(c.g + tint * 4, 0, 255);
      const b = clamp(c.b + (tint < 0 ? 18 : -10), 0, 255);
      return 'rgba(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ',' + alpha.toFixed(3) + ')';
    }

    draw() {
      const ctx = this.ctx;
      if (!ctx) return;
      ctx.clearRect(0, 0, this.width, this.height);
      if (!this.path) return;

      const cfg = this.config;
      this.drawInkPools(ctx);
      const pulseCfg = cfg.pulse || {};
      const pulse = (pulseCfg.minAlphaGain || 0.05)
        + (this.risk / 100) * (pulseCfg.riskGain || 0.1);
      const breatheCfg = cfg.breathe || [0.9, 1.1];
      const highlights = [];

      for (let i = 0; i < this.strands.length; i += 1) {
        const strand = this.strands[i];
        if (!strand.path) this.buildStrandPath(strand);
        if (!strand.path) continue;

        const layer = strand.layer;
        const alphaRange = (cfg.alpha && cfg.alpha[layer]) || [0.2, 0.3];
        const breathe = 1 + Math.sin(this.elapsed * (Math.PI * 2) / strand.breathePeriod + strand.breathePhase)
          * ((breatheCfg[1] - breatheCfg[0]) / 2);
        const pulseWave = 1 + Math.sin(this.elapsed * Math.PI * 2 * (pulseCfg.freq || 0.42) + i) * pulse;

        let alpha = lerp(alphaRange[0], alphaRange[1], hash01(i * 4.7 + 2.2));
        if (layer === 'wet') alpha *= 0.85;
        alpha = clamp(alpha * breathe * pulseWave, 0, 0.6);

        let width;
        if (layer === 'wet') width = strand.cachedWidth * 1.55;
        else if (layer === 'runner') width = strand.width * 1.05;
        else width = strand.width;
        width *= breathe;

        ctx.save();
        /* The canvas element itself is multiplied onto the map (see
           .silk-canvas in styles.css), so strands compose normally here and
           overlapping strands build density the way wet ink does. */
        ctx.globalCompositeOperation = 'source-over';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = width;
        ctx.strokeStyle = this.strandColour(strand.tint, alpha);

        // slow whole-strand sway keeps the silk alive without rebuilding paths
        const swayAmp = this.profile.reducedMotion ? 0.6 : 1.6;
        ctx.translate(
          Math.sin(this.elapsed * 0.31 + strand.swayPhase) * swayAmp,
          Math.cos(this.elapsed * 0.24 + strand.swayPhase) * swayAmp * 0.7
        );

        if (strand.dash) {
          ctx.setLineDash(strand.dash);
          ctx.lineDashOffset = -(this.flowPhase * strand.speed + strand.dashOffsetSeed);
        }
        ctx.stroke(strand.path);
        ctx.restore();

        if (layer === 'highlight' || layer === 'runner') highlights.push(strand);
      }

      // Layer D: flowing ink units with long tapering tails
      this.drawRunners(ctx);

      // V5: the travelling brush - the source of the motion now
      this.drawBrushPass(ctx);

      // 甲: rare cinnabar pulse at extreme risk - low frequency, restrained
      const cp = cfg.cinnabarPulse;
      if (cp && this.risk >= (cp.riskThreshold || 86)) {
        const period = Math.max(1.5, cp.period || 6.5);
        const phase = (this.elapsed % period) / period;
        const window01 = cp.width || 0.16;
        if (phase < window01) {
          const k = Math.sin((phase / window01) * Math.PI);
          ctx.save();
          ctx.globalCompositeOperation = 'source-over';
          ctx.lineCap = 'round';
          ctx.lineWidth = (this.strands[0] ? this.strands[0].cachedWidth : 9) * 1.7;
          ctx.strokeStyle = 'rgba(181,25,25,' + ((cp.alpha || 0.2) * k).toFixed(3) + ')';
          ctx.stroke(this.pathAsPath());
          ctx.restore();
        }
      }
    }

    /* Binary search the precomputed cumulative length table. */
    indexAtDistance(distance) {
      const dist = this.path.dist;
      let lo = 0;
      let hi = dist.length - 1;
      if (distance <= dist[0]) return 0;
      if (distance >= dist[hi]) return hi;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (dist[mid] <= distance) lo = mid; else hi = mid;
      }
      return lo;
    }

    /* Layer D: a flowing ink unit with a long tapering tail. Drawn as
       sub-segments whose width and alpha ramp from tail to head, so it reads
       as a sliver of liquid pigment sliding along the route - never a dot. */
    drawRunners(ctx) {
      const path = this.path;
      const cfg = (this.config && this.config.runner) || {};
      if (!path) return;
      const count = Math.max(1, cfg.count || 3);
      const segments = Math.max(5, cfg.segments || 14);
      const alphaRange = cfg.alpha || [0.05, 0.42];
      const speeds = cfg.headSpeed || [0.55, 0.95];
      const tails = cfg.tailLength || [58, 118];
      const headWidth = cfg.headWidth || 2.2;
      const motion = this.profile.reducedMotion ? (this.config.reducedMotionScale || 0.32) : 1;

      for (let r = 0; r < count; r += 1) {
        const seed = hash01(r * 5.77 + 11.3);
        const speed = rangeAt(speeds, seed) * motion;
        const tailPx = rangeAt(tails, hash01(r * 3.1 + 2.2));
        const phase = (this.elapsed * speed + seed) % 1;
        const eased = clamp(phase + 0.035 * Math.sin(phase * Math.PI * 2), 0, 1);
        const headDist = eased * path.total;
        const env = smoothstep(0, 0.07, phase) * smoothstep(1, 0.93, phase);
        if (env < 0.03) continue;

        for (let s = 0; s < segments; s += 1) {
          const t0 = s / segments;
          const t1 = (s + 1) / segments;
          const d0 = headDist - tailPx * (1 - t0);
          const d1 = headDist - tailPx * (1 - t1);
          if (d1 <= 0) continue;
          const i0 = this.indexAtDistance(Math.max(0, d0));
          const i1 = this.indexAtDistance(Math.max(0, d1));
          const ramp = (t0 + t1) / 2;
          const width = Math.max(0.35, headWidth * Math.pow(ramp, 0.72));
          const alpha = lerp(alphaRange[0], alphaRange[1], smoothstep(0, 1, ramp)) * env;
          if (alpha < 0.012) continue;
          ctx.save();
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.lineWidth = width;
          ctx.strokeStyle = this.strandColour(0, alpha);
          ctx.beginPath();
          ctx.moveTo(path.x[i0], path.y[i0]);
          for (let i = i0 + 1; i <= i1; i += 1) ctx.lineTo(path.x[i], path.y[i]);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    /* Ink pooling at the turns: a soft dark blot where a real brush would
       have slowed down and let the pigment collect. Static, drawn under the
       strokes so it reads as soaked paper. */
    drawInkPools(ctx) {
      const path = this.path;
      const cfg = (this.config && this.config.brush && this.config.brush.pool) || {};
      if (!path || !path.pools || !path.pools.length) return;
      const baseR = cfg.radius || 8;
      const baseA = cfg.alpha === undefined ? 0.18 : cfg.alpha;
      for (let i = 0; i < path.pools.length; i += 1) {
        const pool = path.pools[i];
        const radius = baseR * (0.75 + pool.k * 0.85);
        const alpha = baseA * (0.45 + pool.k * 0.55);
        const grad = ctx.createRadialGradient(pool.x, pool.y, 0, pool.x, pool.y, radius);
        grad.addColorStop(0, this.strandColour(0, alpha));
        grad.addColorStop(1, this.strandColour(0, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(pool.x, pool.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    /* The brush itself: a pointed tip that leads, loaded with ink. */
    drawBrushTip(ctx, x, y, tx, ty, env) {
      const tip = (this.config.brush && this.config.brush.tip) || {};
      const length = tip.length || 30;
      const width = tip.width || 5.4;
      const alpha = (tip.alpha === undefined ? 0.52 : tip.alpha) * (env === undefined ? 1 : env);
      const bristles = Math.max(0, tip.bristles === undefined ? 4 : tip.bristles);
      const nx = -ty;
      const ny = tx;
      const bxc = x - tx * length * 0.5;
      const byc = y - ty * length * 0.5;
      const fxc = x + tx * length * 0.5;
      const fyc = y + ty * length * 0.5;

      // body of the loaded tip: broad at the heel, coming to a point
      ctx.fillStyle = this.strandColour(0, alpha);
      ctx.beginPath();
      ctx.moveTo(bxc + nx * width * 0.5, byc + ny * width * 0.5);
      ctx.quadraticCurveTo(x + nx * width * 0.22, y + ny * width * 0.22, fxc, fyc);
      ctx.quadraticCurveTo(x - nx * width * 0.22, y - ny * width * 0.22, bxc - nx * width * 0.5, byc - ny * width * 0.5);
      ctx.closePath();
      ctx.fill();

      // bristle separation near the heel (kept very subtle)
      if (bristles > 1) {
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(0.35, width * 0.10);
        ctx.strokeStyle = this.strandColour(0, alpha * 0.32);
        for (let i = 0; i < bristles; i += 1) {
          const f = (i / (bristles - 1)) - 0.5;
          ctx.beginPath();
          ctx.moveTo(bxc + nx * width * 0.42 * f, byc + ny * width * 0.42 * f);
          ctx.lineTo(x + nx * width * 0.10 * f, y + ny * width * 0.10 * f);
          ctx.stroke();
        }
      }
    }

    /* The wet pass: a window of fresh ink trailing the tip, drawn over the
       settled bundle. Nothing is emitted or destroyed - the whole animation
       is one brush travelling the line and re-wetting it. */
    drawBrushPass(ctx) {
      const cfg = this.config.brush || {};
      const path = this.path;
      if (!cfg.enabled || !path) return;
      const motion = this.profile.reducedMotion ? (this.config.reducedMotionScale || 0.32) : 1;
      const speed = (cfg.speed || 0.085) * motion;
      const phase = (this.elapsed * speed) % 1;
      /* A hand does not travel at a constant rate: it eases out of the start
         and settles into the end of the stroke. */
      const eased = clamp(phase + 0.04 * Math.sin(phase * Math.PI * 2), 0, 1);
      const headDist = eased * path.total;
      /* Fade the brush in at the start and out at the end so the loop restart
         never pops - the tip lifts and is re-inked off the paper. */
      const env = smoothstep(0, 0.055, phase) * smoothstep(1, 0.945, phase);
      if (env < 0.02) return;
      const windowLen = cfg.windowLength || 170;
      const passes = Math.max(1, cfg.passes || 5);
      const segments = 12;
      const alphaGain = cfg.headAlphaGain === undefined ? 0.55 : cfg.headAlphaGain;
      const widthGain = cfg.headWidthGain === undefined ? 0.30 : cfg.headWidthGain;
      const baseWidth = rangeAt(this.profile.baseWidth, 0.5);
      const gap = cfg.dryGap || {};
      const run = Math.max(6, windowLen / 6);
      const gapLen = ((gap.min || 2) + (gap.max || 15)) * 0.5;

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([run, gapLen]);
      ctx.lineDashOffset = -headDist;   // 飞白 travels with the brush
      for (let p = 0; p < passes; p += 1) {
        const lateral = passes > 1
          ? ((p / (passes - 1)) - 0.5) * baseWidth * 0.66
          : 0;
        for (let s = 0; s < segments; s += 1) {
          const t0 = s / segments;
          const t1 = (s + 1) / segments;
          const d0 = headDist - windowLen * (1 - t0);
          const d1 = headDist - windowLen * (1 - t1);
          if (d1 <= 0) continue;
          const i0 = this.indexAtDistance(Math.max(0, d0));
          const i1 = this.indexAtDistance(Math.max(0, d1));
          const ramp = (t0 + t1) / 2;
          const wet = smoothstep(0, 1, ramp);     // wettest right at the tip
          const alpha = alphaGain * wet * 0.46 * env;
          if (alpha < 0.012) continue;
          const nx0 = path.nx[i0];
          const ny0 = path.ny[i0];
          ctx.strokeStyle = this.strandColour(0, Math.min(0.72, alpha));
          ctx.lineWidth = Math.max(0.5, (baseWidth / passes) * 1.45 * (1 + widthGain * wet));
          ctx.beginPath();
          ctx.moveTo(path.x[i0] + nx0 * lateral, path.y[i0] + ny0 * lateral);
          for (let i = i0 + 1; i <= i1; i += 1) {
            ctx.lineTo(path.x[i] + path.nx[i] * lateral, path.y[i] + path.ny[i] * lateral);
          }
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      ctx.restore();

      // the tip leads the wet window
      const hi = this.indexAtDistance(headDist);
      const tx = path.ny[hi];
      const ty = -path.nx[hi];
      const halo = cfg.halo;
      if (halo && env > 0.05) {
        const hx = path.x[hi];
        const hy = path.y[hi];
        const radius = halo.radius || 26;
        const grad = ctx.createRadialGradient(hx, hy, 0, hx, hy, radius);
        grad.addColorStop(0, this.strandColour(0, (halo.alpha === undefined ? 0.2 : halo.alpha) * env));
        grad.addColorStop(1, this.strandColour(0, 0));
        ctx.save();
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(hx, hy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      if (env > 0.05) this.drawBrushTip(ctx, path.x[hi], path.y[hi], tx, ty, env);
    }

    pathAsPath() {
      const path = this.path;
      const points = new Path2D();
      for (let i = 0; i < path.count; i += 1) {
        if (i === 0) points.moveTo(path.x[i], path.y[i]);
        else points.lineTo(path.x[i], path.y[i]);
      }
      return points;
    }

    frame(timestamp) {
      if (!this.running) return;
      const dt = this.lastTime ? Math.min((timestamp - this.lastTime) / 1000, 0.032) : 0.016;
      this.lastTime = timestamp;
      try {
        if (this.routeDirty) { this.rebuild(); this.invalidateStrands(); }
        if (this.visible && this.path) {
          this.update(dt);
          this.draw();
        }
      } catch (error) {
        if (global.console && console.warn) {
          console.warn('丝绸路线帧已跳过：' + (error && error.message ? error.message : error));
        }
      }
      global.requestAnimationFrame(this.boundFrame);
    }
  }

  SilkRoute.rampColor = rampColor;
  SilkRoute.resampleSpline = resampleSpline;
  global.RiskTideSilkRoute = SilkRoute;
  global.RiskTideSilkSpec = { rampColor: rampColor, resampleSpline: resampleSpline };
})(window);