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

      const sampled = resampleSpline(clean, 4.5);
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

      this.path = { x: x, y: y, nx: nx, ny: ny, dist: dist, total: total, count: count };
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
        const wave = Math.sin(t * Math.PI * 2 * strand.waveFreq + strand.wavePhase) * amplitude;
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
      return { strands: this.strands.length, runners: (this.config.runner || {}).count || 3, risk: Math.round(this.risk) };
    }

    update(dt) {
      this.elapsed += dt;
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
        const headDist = ((this.elapsed * speed + seed) % 1) * path.total;

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
          const alpha = lerp(alphaRange[0], alphaRange[1], Math.pow(ramp, 1.45));
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