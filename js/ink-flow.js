/* global window, document */
(function (global) {
  'use strict';

  const config = global.RiskTideConfig;
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function smoothstep(edge0, edge1, value) {
    const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* ---- OKLab 感知色彩空间：风险色连续插值 + 同色相明暗 -------------------
     RGB 直接线性插值会经过灰绿脏色，所以所有风险色阶都在 OKLab 中插值。 */
  function srgbToLinear(c) {
    c = clamp(c / 255, 0, 1);
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(c) {
    const out = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(clamp(out * 255, 0, 255));
  }
  function rgbToOklab(rgb) {
    const r = srgbToLinear(rgb[0]);
    const g = srgbToLinear(rgb[1]);
    const b = srgbToLinear(rgb[2]);
    const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    const l_ = Math.cbrt(l);
    const m_ = Math.cbrt(m);
    const s_ = Math.cbrt(s);
    return [
      0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    ];
  }
  function oklabToRgb(lab) {
    const l_ = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
    const m_ = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
    const s_ = lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2];
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
  }
  function rgbStr(rgb) { return 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')'; }
  /* 同色相提亮 / 压暗：amount ∈ [-1,1]。正数向白提亮、负数同色相压暗。 */
  function oklabLiftLab(lab, amount) {
    const k = clamp(amount, -1, 1);
    let l2;
    let cscale;
    if (k >= 0) {
      l2 = lab[0] + (1 - lab[0]) * k;
      cscale = 1 - 0.25 * k;
    } else {
      l2 = lab[0] * (1 + k);
      cscale = 1 + 0.12 * k;
    }
    return [clamp(l2, 0, 1), lab[1] * cscale, lab[2] * cscale];
  }
  function oklabLift(rgb, amount) { return oklabToRgb(oklabLiftLab(rgbToOklab(rgb), amount)); }

  /* 沿色阶平滑插值（OKLab + smoothstep，coreRamp 唯一色源） */
  function rampRgb(ramp, risk) {
    if (!ramp || !ramp.length) return [0, 0, 0];
    const t = clamp((Number(risk) || 0) / 100, 0, 1);
    let a = ramp[0];
    let b = ramp[ramp.length - 1];
    for (let i = 1; i < ramp.length; i += 1) {
      if (t <= ramp[i].at) { a = ramp[i - 1]; b = ramp[i]; break; }
    }
    const span = (b.at - a.at) || 1;
    const k = smoothstep(0, 1, clamp((t - a.at) / span, 0, 1));
    const A = rgbToOklab(a.rgb);
    const B = rgbToOklab(b.rgb);
    return oklabToRgb([A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k]);
  }

  /* 芯光通道色（保留旧名）：当前显示风险下的统一主题色 */
  function coreColour(risk) {
    return rgbStr(rampRgb((config.ink && config.ink.coreRamp) || null, risk));
  }

  /* ---- 几何常量 -------------------------------------------------------- */
  const MIN_SEGMENT_PX = 0.6;
  const MIN_STEP_PX = 2.2;
  const MAX_STEP_PX = 5;
  const MAX_POINTS = 560;
  const MAX_STEP_RELAXED = 12;
  const HIT_RADIUS_PX = 18;
  const MITER_MAX = 1.45;
  const SHARP_TURN_RAD = Math.PI * 2 / 3;
  const PHYSICS_DT_CAP = 0.5;
  const WRITE_DT_CAP = 1.0;
  const HOVER_EPS = 0.004;

  function smoothPolyline(points, weight) {
    if (points.length < 3) return;
    const w = clamp(weight === undefined ? 0.25 : weight, 0, 0.35);
    if (w <= 1e-4) return;
    const mid = 1 - 2 * w;
    const src = points.map(function (point) { return { x: point.x, y: point.y }; });
    for (let i = 1; i < points.length - 1; i += 1) {
      points[i].x = src[i - 1].x * w + src[i].x * mid + src[i + 1].x * w;
      points[i].y = src[i - 1].y * w + src[i].y * mid + src[i + 1].y * w;
    }
  }

  /* 路线真实性：road = 真实道路几何；preview = 只有起终点示意；failed = 规划失败。 */
  function normaliseStatus(route, status) {
    if (status && status.kind) return { kind: status.kind, reason: status.reason || '' };
    if (route && route.failed) return { kind: 'failed', reason: route.reason || '路线规划失败' };
    if (route && Array.isArray(route.coordinates) && route.coordinates.length >= 2 && !route.preview) {
      return { kind: 'road', reason: '' };
    }
    return { kind: 'preview', reason: '' };
  }
  class InkFlow {
    constructor(canvas, mapController) {
      this.canvas = canvas;
      this.ctx = canvas && canvas.getContext
        ? canvas.getContext('2d', { alpha: true, desynchronized: true }) : null;
      this.glowCanvas = document.getElementById('ink-glow-canvas');
      this.glowCtx = this.glowCanvas && this.glowCanvas.getContext
        ? this.glowCanvas.getContext('2d', { alpha: true, desynchronized: true }) : null;
      this.map = mapController;
      this.width = 1;
      this.height = 1;
      this.dpr = 1;
      this.route = null;
      this.kind = 'empty';
      this.reason = '';
      this.points = [];
      this.displayRisk = 0;          // 单值：整条主线每个时刻使用统一风险主题色
      this.riskTarget = 0;
      this.routeDirty = true;
      this.progress = 0;
      this.bodyProgress = 0;
      this.depositProgress = 0;
      this.totalLength = 0;
      this.degenerate = false;
      this.running = false;
      this.visible = !document.hidden;
      this.reducedMotion = !!(global.matchMedia
        && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
      this.elapsed = 0;
      this.lastTime = 0;
      this.writeElapsed = 0;
      this.hover = 0;
      this.hoverTarget = 0;
      this.pulses = [];
      this.pulseHeads = [];
      this.wavePhases = [0.0, 0.41, 0.73];
      this.fadeIn = 1;
      this.frameTimer = 0;
      this._colourLut = null;
      this.boundFrame = this.frame.bind(this);
      this.boundRequest = this.requestFrame.bind(this);
      this.resize();
      this.observeResize();
    }

    observeResize() {
      if (!global.ResizeObserver || !this.canvas || this.resizeObserver) return;
      this.resizeObserver = new global.ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas.parentNode || this.canvas);
    }

    targetDpr() {
      return Math.min(global.devicePixelRatio || 1, this.reducedMotion ? 1.5 : 2);
    }

    resize() {
      if (!this.canvas) return;
      const self = this;
      const rect = this.canvas.getBoundingClientRect();
      this.width = Math.max(1, rect.width || 600);
      this.height = Math.max(1, rect.height || 400);
      this.dpr = this.targetDpr();
      const sizeCanvas = function (target, ctx) {
        if (!target || !ctx) return;
        target.width = Math.round(self.width * self.dpr);
        target.height = Math.round(self.height * self.dpr);
        ctx.setTransform(self.dpr, 0, 0, self.dpr, 0, 0);
      };
      sizeCanvas(this.canvas, this.ctx);
      sizeCanvas(this.glowCanvas, this.glowCtx);
      this.routeDirty = true;
      this.requestFrame();
    }

    maybeResizeForDpr() {
      if (!this.canvas) return false;
      if (Math.abs(this.targetDpr() - this.dpr) < 1e-3) return false;
      this.resize();
      return true;
    }

    getRouteCoordinates() {
      const route = this.route;
      return route && Array.isArray(route.coordinates) && route.coordinates.length >= 2
        ? route.coordinates : null;
    }

    /* 无真实道路几何时的示意几何：只连起终点，绝不用真实流光笔触表现。 */
    getHintCoordinates() {
      const live = this.map && typeof this.map.getEndpoints === 'function'
        ? this.map.getEndpoints() : null;
      const fallback = config.endpoints || {};
      const endpoints = live || fallback;
      const campus = (endpoints && endpoints.campus) || fallback.campus;
      const station = (endpoints && endpoints.station) || fallback.station;
      if (!campus || !station || !campus.coordinate || !station.coordinate) return null;
      return [campus.coordinate, station.coordinate];
    }

    setRoute(route, status) {
      const previous = this.route;
      const previousKind = this.kind;
      this.route = route || null;
      const info = normaliseStatus(this.route, status);
      const changed = info.kind !== previousKind || this.route !== previous;
      this.kind = info.kind;
      this.reason = info.reason || '';
      this.routeDirty = true;
      this.progress = (this.reducedMotion || this.kind !== 'road') ? 1 : 0;
      this.bodyProgress = this.progress;
      this.depositProgress = this.progress;
      this.writeElapsed = 0;
      this.hover = 0;
      this.hoverTarget = 0;
      this.pulses = [];
      this.pulseHeads = [];
      this.wavePhases = [0.0, 0.41, 0.73];
      this.displayRisk = this.riskTarget;   // 新路线直接落到当前目标风险
      this._colourLut = null;
      this.fadeIn = this.reducedMotion ? 1 : 0;
      if (changed) this.elapsed = 0;
      this.requestFrame();
      return this;
    }

    setRisk(risk) {
      this.riskTarget = clamp(Number(risk) || 0, 0, 100);
      this.requestFrame();
      return this;
    }

    setHover(strength) {
      this.hoverTarget = clamp(Number(strength) || 0, 0, 1);
      this.requestFrame();
      return this;
    }

    hitTest(x, y) {
      const points = this.points;
      if (points.length < 2) return null;
      let best = Infinity;
      let bestIndex = 0;
      let bestX = 0;
      let bestY = 0;
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq ? ((x - a.x) * dx + (y - a.y) * dy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const cx = a.x + dx * t, cy = a.y + dy * t;
        const distance = Math.hypot(x - cx, y - cy);
        if (distance < best) { best = distance; bestIndex = i; bestX = cx; bestY = cy; }
      }
      if (best > HIT_RADIUS_PX) return null;
      const seg = points[bestIndex];
      const next = points[Math.min(points.length - 1, bestIndex + 1)];
      let dx = next.x - seg.x, dy = next.y - seg.y;
      const len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len;
      if ((x - bestX) * nx + (y - bestY) * ny < 0) { nx = -nx; ny = -ny; }
      return {
        strength: 1 - best / HIT_RADIUS_PX,
        distance: best,
        index: bestIndex,
        x: bestX,
        y: bestY,
        nx: nx,
        ny: ny
      };
    }

    hoverAt(x, y) {
      const hit = this.hitTest(x, y);
      return hit ? hit.strength : 0;
    }

    midpointAt(fraction) {
      const points = this.points;
      if (points.length < 2) return null;
      const t = clamp(fraction === undefined ? 0.5 : fraction, 0, 1);
      const index = Math.min(points.length - 2, Math.floor(t * (points.length - 1)));
      const local = t * (points.length - 1) - index;
      const a = points[index], b = points[index + 1];
      return { x: a.x + (b.x - a.x) * local, y: a.y + (b.y - a.y) * local };
    }

    rebuild() {
      this.routeDirty = false;
      this.points = [];
      this.degenerate = true;
      const coordinates = this.kind === 'road' ? this.getRouteCoordinates() : this.getHintCoordinates();
      if (!coordinates || coordinates.length < 2 || !this.map
          || typeof this.map.getScreenPath !== 'function') {
        return;
      }
      const system = this.kind === 'road'
        ? (this.route && this.route.coordinateSystem) : 'WGS84';
      const projected = this.map.getScreenPath(coordinates, system)
        .filter(function (point) { return point && Number.isFinite(point.x) && Number.isFinite(point.y); });
      if (projected.length < 2) return;

      const dense = [projected[0]];
      let total = 0;
      for (let i = 1; i < projected.length; i += 1) {
        const start = dense[dense.length - 1];
        const end = projected[i];
        const distance = Math.hypot(end.x - start.x, end.y - start.y);
        if (distance < MIN_SEGMENT_PX) continue;
        dense.push(end);
        total += distance;
      }
      if (dense.length < 2 || total < MIN_SEGMENT_PX) return;
      this.totalLength = total;

      let step = clamp(total / MAX_POINTS, MIN_STEP_PX, MAX_STEP_PX);
      if (total / step > MAX_POINTS) step = Math.min(MAX_STEP_RELAXED, total / MAX_POINTS);
      const forward = [{ x: dense[0].x, y: dense[0].y }];
      let travelled = 0;
      let nextAt = step;
      for (let i = 1; i < dense.length; i += 1) {
        const start = dense[i - 1];
        const end = dense[i];
        const segment = Math.hypot(end.x - start.x, end.y - start.y);
        if (segment < 1e-9) continue;
        const segmentEnd = travelled + segment;
        while (nextAt <= segmentEnd) {
          const t = (nextAt - travelled) / segment;
          forward.push({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
          nextAt += step;
        }
        travelled = segmentEnd;
      }
      const tail = dense[dense.length - 1];
      const lastOut = forward[forward.length - 1];
      if (Math.hypot(tail.x - lastOut.x, tail.y - lastOut.y) > MIN_SEGMENT_PX) {
        forward.push({ x: tail.x, y: tail.y });
      }
      const smoothWeight = 0.22 * Math.min(1, MAX_STEP_PX / step);
      smoothPolyline(forward, smoothWeight);
      smoothPolyline(forward, smoothWeight);
      /* 终点 -> 起点：流光从目的地向出发地单向推进 */
      this.points = [];
      for (let i = forward.length - 1; i >= 0; i -= 1) this.points.push(forward[i]);

      const n = this.points.length;
      const raw = new Float32Array(n);
      for (let i = 1; i < n - 1; i += 1) {
        const a = this.points[i - 1];
        const b = this.points[i];
        const c = this.points[i + 1];
        const v1x = b.x - a.x, v1y = b.y - a.y;
        const v2x = c.x - b.x, v2y = c.y - b.y;
        const l1 = Math.hypot(v1x, v1y) || 1;
        const l2 = Math.hypot(v2x, v2y) || 1;
        const dot = clamp((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1);
        raw[i] = Math.acos(dot) / Math.PI;
      }
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        let sum = 0;
        let count = 0;
        for (let k = -3; k <= 3; k += 1) {
          const j = i + k;
          if (j < 0 || j >= n) continue;
          sum += raw[j];
          count += 1;
        }
        curve[i] = sum / Math.max(1, count);
      }
      this.curve = curve;
      this.degenerate = false;
    }
    /* 风险色平滑：displayRisk 以指数平滑追上 targetRisk（约 0.35–0.55s 时间常数），
       每帧都更新颜色，而不是只在滑杆 input 事件里算一次。 */
    advanceRisk(dt) {
      if (this.reducedMotion) { this.displayRisk = this.riskTarget; return false; }
      const route = (config.ink && config.ink.route) || {};
      const propagate = route.propagate || {};
      const rising = this.riskTarget >= this.displayRisk;
      const tau = clamp((rising ? propagate.rise : propagate.fall) || 0.4, 0.02, 3);
      this.displayRisk += (this.riskTarget - this.displayRisk) * (1 - Math.exp(-dt / tau));
      return Math.abs(this.riskTarget - this.displayRisk) > 0.08;
    }

    bodyTaper(t) {
      const body = (config.ink && config.ink.route && config.ink.route.body) || {};
      const fadeStart = body.fadeStart === undefined ? 0.62 : body.fadeStart;
      const floor = body.taperFloor === undefined ? 0.42 : body.taperFloor;
      return floor + (1 - floor) * (1 - smoothstep(fadeStart, 1, t));
    }

    bodyWidth() {
      const body = (config.ink && config.ink.route && config.ink.route.body) || {};
      return body.width === undefined ? 11 : body.width;
    }

    /* 出现动画时长：低风险约 7s、高风险约 4.6s，随 displayRisk 连续插值 */
    growDuration() {
      const grow = (config.ink && config.ink.route && config.ink.route.grow) || {};
      const low = grow.lowRisk === undefined ? 7.0 : grow.lowRisk;
      const high = grow.highRisk === undefined ? 4.6 : grow.highRisk;
      return low + (high - low) * clamp(this.displayRisk / 100, 0, 1);
    }

    /* 潮汐波峰能量：沿线位置 t（0=终点，1=起点）叠加若干推进波峰的亮度/宽度包络。
       每个波峰前端集中、后端缓慢衰减，单向推进（终点 → 起点）。 */
    flowPeriod(risk01) {
      const wave = (config.ink && config.ink.route && config.ink.route.wave) || {};
      const period = wave.period || { safe: 24, critical: 15, danger: 8 };
      const t = clamp(risk01 === undefined ? 0 : risk01, 0, 1);
      if (t <= 0.70) {
        return (period.safe === undefined ? 24 : period.safe)
          + ((period.critical === undefined ? 15 : period.critical) - (period.safe === undefined ? 24 : period.safe))
            * smoothstep(0, 0.70, t);
      }
      return (period.critical === undefined ? 15 : period.critical)
        + ((period.danger === undefined ? 8 : period.danger) - (period.critical === undefined ? 15 : period.critical))
          * smoothstep(0.70, 1.0, t);
    }

    waveSpeed() {
      return 1 / Math.max(1, this.flowPeriod(this.displayRisk / 100));
    }

    /* 每个波峰有自己的低频节奏 + 次级慢速调制，错相追赶、聚合、舒展；速度恒正 */
    peakSpeed(k) {
      const wave = (config.ink && config.ink.route && config.ink.route.wave) || {};
      const rhythm = wave.rhythm || { amp: 0.10, freq: 0.07 };
      const drift = wave.drift || { amp: 0.035, freq: 0.023 };
      const base = this.waveSpeed();
      const t = this.reducedMotion ? 0 : this.elapsed;
      const low = 1 + (rhythm.amp === undefined ? 0.10 : rhythm.amp)
        * Math.sin(t * (Math.PI * 2) * (rhythm.freq === undefined ? 0.07 : rhythm.freq) + k * 2.4);
      const slow = 1 + (drift.amp === undefined ? 0.035 : drift.amp)
        * Math.sin(t * (Math.PI * 2) * (drift.freq === undefined ? 0.023 : drift.freq) + k * 1.7);
      return base * low * slow;
    }

    advanceWaves(dt) {
      if (this.reducedMotion || dt <= 0) return;
      const wave = (config.ink && config.ink.route && config.ink.route.wave) || {};
      const count = clamp(Math.round(wave.count === undefined ? 3 : wave.count), 0, 8);
      if (!this.wavePhases || this.wavePhases.length < count) {
        this.wavePhases = [0.0, 0.41, 0.73, 0.17, 0.58, 0.88, 0.31, 0.74].slice(0, count);
      }
      for (let k = 0; k < count; k += 1) {
        this.wavePhases[k] = (this.wavePhases[k] + this.peakSpeed(k) * dt) % 1;
        if (this.wavePhases[k] < 0) this.wavePhases[k] += 1;
      }
    }

    waveEnergy(t) {
      const wave = (config.ink && config.ink.route && config.ink.route.wave) || {};
      const count = clamp(Math.round(wave.count === undefined ? 3 : wave.count), 0, 8);
      if (!count || this.reducedMotion) return 0;
      if (!this.wavePhases) this.wavePhases = [0.0, 0.41, 0.73];
      const headSharp = Math.max(0.008, wave.headSharp === undefined ? 0.04 : wave.headSharp);
      const tailLong = Math.max(0.02, wave.tailLong === undefined ? 0.32 : wave.tailLong);
      let e = 0;
      for (let k = 0; k < count; k += 1) {
        const head = this.wavePhases[k] || 0;
        let d = t - head;
        if (d > 0.5) d -= 1;
        if (d < -0.5) d += 1;
        const front = d >= 0 ? 1 - smoothstep(0, headSharp, d) : 1;
        const back = d <= 0 ? Math.exp(d / tailLong) : 1;
        e = Math.max(e, front * back);
      }
      return e;
    }

    /* 同色相明暗（波峰亮度 + 缓慢呼吸），正数提亮、负数压暗 */
    bodyLift(t, curve, shadeLift) {
      const route = (config.ink && config.ink.route) || {};
      const wave = route.wave || {};
      const base = shadeLift === undefined ? 0 : shadeLift;
      const w = this.waveEnergy(t);
      const c = curve === undefined ? 0 : curve;
      const corner = wave.corner || { compress: 0.15, brighten: 0.30 };
      const cornerBrighten = (corner.brighten === undefined ? 0.30 : corner.brighten) * c * w;
      const breath = Math.sin(t * 6.283 - this.elapsed * (Math.PI * 2) / 11) * 0.05;
      return clamp(base + (wave.brightness === undefined ? 0.16 : wave.brightness) * w + breath + cornerBrighten, -0.65, 0.95);
    }

    /* 每帧构建一次同色相明暗查找表：主体颜色全程统一，只有亮度随波峰/呼吸变化 */
    buildColourLut() {
      const base = rampRgb(config.ink && config.ink.coreRamp, this.displayRisk);
      const lab = rgbToOklab(base);
      const lut = this._colourLut || new Array(65);
      for (let i = 0; i < 65; i += 1) {
        const lift = -0.6 + (i / 64) * 1.55;
        lut[i] = rgbStr(oklabToRgb(oklabLiftLab(lab, lift)));
      }
      this._colourLut = lut;
    }

    colourAt(t, curve, shadeLift) {
      if (!this._colourLut) this.buildColourLut();
      const lift = this.bodyLift(t, curve, shadeLift);
      const idx = clamp(Math.round((lift + 0.6) / 1.55 * 64), 0, 64);
      return this._colourLut[idx];
    }

    layerScale(i, total, phase, undulate) {
      const route = (config.ink && config.ink.route) || {};
      const flow = route.flow || {};
      const flowAmp = flow.amplitude === undefined ? 0.05 : flow.amplitude;
      const flowPeriod = Math.max(8, flow.period || 17);
      const time = this.reducedMotion ? 0 : this.elapsed;
      const t = i / Math.max(1, total - 1);
      const ph = phase === undefined ? 0 : phase;
      const und = undulate === undefined ? 0 : undulate;
      return {
        t: t,
        taper: this.bodyTaper(t),
        pressure: Math.max(0.75, 1
          + Math.sin(t * 2.6 + ph) * und
          + Math.sin(t * 5.9 + ph * 2.3) * und * 0.35),
        edge: 1
          + Math.sin(t * 7.3 + 1.8) * 0.026
          + Math.sin(t * 17.9 + 0.7) * 0.018
          + Math.sin(t * 41.3 + 2.4) * 0.010,
        breathe: 1 + Math.sin(t * 6.1 - time * (Math.PI * 2) / flowPeriod) * flowAmp
      };
    }

    /* 通用描线通道（发光层）：describe(scale, risk01, i) 返回 { offset, width, alpha, color } */
    tracePass(limit, describe, channel, context, phase, undulate, fixedColour) {
      const ctx = context || this.ctx;
      if (!ctx) return;
      const points = this.points;
      const total = points.length;
      if (total < 2 || limit < 1) return;
      const risk01 = clamp(this.displayRisk / 100, 0, 1);
      let fallback = fixedColour || null;
      if (!fallback) {
        if (channel === 'highlight') {
          fallback = rgbStr(oklabLift(rampRgb(config.ink && config.ink.coreRamp, risk01 * 100), 0.35));
        } else if (channel === 'vein') {
          const core = ((config.ink && config.ink.route) || {}).core || {};
          const lift = core.veinLighten === undefined ? 0.24 : core.veinLighten;
          fallback = rgbStr(oklabLift(rampRgb(config.ink && config.ink.coreRamp, risk01 * 100), lift));
        } else {
          fallback = rgbStr(rampRgb(config.ink && config.ink.coreRamp, risk01 * 100));
        }
      }

      const endIndex = Math.min(total - 1, Math.max(1, Math.floor(limit)));
      const tEnd = limit - Math.floor(limit);
      const vis = [];
      for (let i = 0; i <= endIndex; i += 1) {
        vis.push({ x: points[i].x, y: points[i].y });
      }
      if (endIndex < total - 1 && tEnd > 0) {
        const a = points[endIndex], b = points[endIndex + 1];
        vis.push({ x: a.x + (b.x - a.x) * tEnd, y: a.y + (b.y - a.y) * tEnd });
      }
      const n = vis.length;
      if (n < 2) return;

      const left = new Array(n);
      const right = new Array(n);
      const alpha = new Array(n);
      const fixed = new Array(n);
      let prevNx = 0;
      let prevNy = 1;
      let hasPrev = false;
      for (let i = 0; i < n; i += 1) {
        const before = vis[Math.max(0, i - 1)];
        const after = vis[Math.min(n - 1, i + 1)];
        const dx = after.x - before.x;
        const dy = after.y - before.y;
        const len = Math.hypot(dx, dy);
        let nx;
        let ny;
        if (len < 1e-6) {
          nx = hasPrev ? prevNx : 0;
          ny = hasPrev ? prevNy : 1;
        } else {
          nx = -dy / len;
          ny = dx / len;
        }
        prevNx = nx;
        prevNy = ny;
        hasPrev = true;
        const scale = this.layerScale(i, total, phase, undulate);
        const spec = describe(scale, risk01, i) || { offset: 0, width: 0, alpha: 0 };
        const half = Math.max(0, spec.width) * 0.5;
        left[i] = { x: vis[i].x + nx * (spec.offset + half), y: vis[i].y + ny * (spec.offset + half) };
        right[i] = { x: vis[i].x + nx * (spec.offset - half), y: vis[i].y + ny * (spec.offset - half) };
        alpha[i] = clamp(spec.alpha * this.fadeIn, 0, 1);
        fixed[i] = spec.color || null;
      }

      for (let i = 0; i < n - 1; i += 1) {
        let colour;
        if (fixed[i] || fixed[i + 1]) colour = fixed[i] || fixed[i + 1];
        else colour = fallback;
        ctx.globalAlpha = (alpha[i] + alpha[i + 1]) * 0.5;
        ctx.fillStyle = colour;
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

    /* 一笔三染：浅墨先行（最宽最浅）、主墨浸润（居中）、浓墨沉积（最窄最深）。
       三层同路径、同心，limit 互有相位差，远看仍是一条完整墨线。 */
    drawBody() {
      const route = (config.ink && config.ink.route) || {};
      const wash = route.wash || {};
      const body = route.body || {};
      const deposit = route.deposit || {};
      const n = Math.max(1, this.points.length - 1);
      const mobile = this.width < 620;
      const washW = mobile ? (wash.widthMobile === undefined ? 13 : wash.widthMobile) : (wash.width === undefined ? 18 : wash.width);
      const bodyW = mobile ? (body.widthMobile === undefined ? 8 : body.widthMobile) : (body.width === undefined ? 11 : body.width);
      const depW = mobile ? (deposit.widthMobile === undefined ? 3 : deposit.widthMobile) : (deposit.width === undefined ? 4 : deposit.width);
      if (this.progress > 0.001) {
        this.drawRibbon(this.progress * n, { width: washW, alpha: wash.alpha === undefined ? 0.20 : wash.alpha,
          shadeLift: wash.shadeLift === undefined ? 0.34 : wash.shadeLift, soft: wash.soft === undefined ? 0.10 : wash.soft,
          undulate: 0.05, phase: 0.0 });
      }
      if (this.bodyProgress > 0.001) {
        this.drawRibbon(this.bodyProgress * n, { width: bodyW, alpha: body.alpha === undefined ? 0.72 : body.alpha,
          shadeLift: body.shadeLift === undefined ? 0 : body.shadeLift, soft: body.soft === undefined ? 0.06 : body.soft,
          undulate: 0.04, phase: 1.3 });
      }
      if (this.depositProgress > 0.001) {
        this.drawRibbon(this.depositProgress * n, { width: depW, alpha: deposit.alpha === undefined ? 0.92 : deposit.alpha,
          shadeLift: deposit.shadeLift === undefined ? -0.24 : deposit.shadeLift, soft: deposit.soft === undefined ? 0.05 : deposit.soft,
          undulate: 0.03, phase: 2.6 });
      }
    }

    /* 一层纯色主体：宽度 = 基准 × 收笔走向 × 运笔轻重 × 边缘毛糙 × 风险倍率 × 波峰加宽。 */
    drawRibbon(limit, spec) {
      const ctx = this.ctx;
      const points = this.points;
      const total = points.length;
      if (!spec || total < 2 || limit < 1 || !spec.width) return;
      const route = (config.ink && config.ink.route) || {};
      const body = route.body || {};
      const wave = route.wave || {};
      const riskCfg = route.risk || {};
      const ph = spec.phase === undefined ? 0 : spec.phase;
      const und = spec.undulate === undefined ? 0 : spec.undulate;
      const shadeLift = spec.shadeLift === undefined ? 0 : spec.shadeLift;
      const soft = spec.soft === undefined ? 0.06 : spec.soft;
      const rn = clamp(this.displayRisk / 100, 0, 1);
      const wMin = riskCfg.width && riskCfg.width.min !== undefined ? riskCfg.width.min : 0.94;
      const wMax = riskCfg.width && riskCfg.width.max !== undefined ? riskCfg.width.max : 1.14;
      const aMin = riskCfg.alpha && riskCfg.alpha.min !== undefined ? riskCfg.alpha.min : 0.92;
      const aMax = riskCfg.alpha && riskCfg.alpha.max !== undefined ? riskCfg.alpha.max : 1.0;
      const widthRisk = wMin + (wMax - wMin) * rn;
      const alphaRisk = aMin + (aMax - aMin) * rn;
      const waveBoost = wave.widthBoost === undefined ? 0.10 : wave.widthBoost;
      const alphaBoost = wave.alphaBoost === undefined ? 0.08 : wave.alphaBoost;

      const endIndex = Math.min(total - 1, Math.max(1, Math.floor(limit)));
      const tEnd = limit - Math.floor(limit);
      const vis = [];
      for (let i = 0; i <= endIndex; i += 1) {
        vis.push({ x: points[i].x, y: points[i].y });
      }
      if (endIndex < total - 1 && tEnd > 0) {
        const a = points[endIndex], b = points[endIndex + 1];
        vis.push({ x: a.x + (b.x - a.x) * tEnd, y: a.y + (b.y - a.y) * tEnd });
      }
      const n = vis.length;
      if (n < 2) return;

      const seg = new Array(Math.max(1, n - 1));
      for (let i = 0; i < n - 1; i += 1) {
        let dx = vis[i + 1].x - vis[i].x;
        let dy = vis[i + 1].y - vis[i].y;
        let len = Math.hypot(dx, dy);
        if (len < 1e-6) {
          const prev = seg[i - 1];
          if (prev) { seg[i] = { nx: prev.nx, ny: prev.ny, tx: prev.tx, ty: prev.ty, len: prev.len }; continue; }
          dx = 1; dy = 0; len = 1;
        }
        seg[i] = { nx: -dy / len, ny: dx / len, tx: dx / len, ty: dy / len, len: len };
      }

      const left = new Array(n);
      const right = new Array(n);
      const alpha = new Array(n);
      const colour = new Array(n);
      let startHalf = 0;
      let startAlpha = 0;
      let startColour = 'transparent';
      for (let i = 0; i < n; i += 1) {
        const iPrev = Math.max(0, i - 1);
        const iNext = Math.min(n - 2, i);
        const a = seg[iPrev];
        const b = seg[iNext];
        const dot = clamp(a.tx * b.tx + a.ty * b.ty, -1, 1);
        const turn = Math.acos(dot);
        let nx = a.nx + b.nx;
        let ny = a.ny + b.ny;
        const bisectorLength = Math.hypot(nx, ny);
        let miter;
        if (bisectorLength < 1e-4) {
          nx = b.nx; ny = b.ny; miter = 1;
        } else {
          nx /= bisectorLength; ny /= bisectorLength;
          const cosHalf = Math.max(0.30, nx * b.nx + ny * b.ny);
          miter = Math.min(MITER_MAX, 1 / cosHalf);
        }
        const t = i / Math.max(1, total - 1);
        const taper = this.bodyTaper(t);
        const pressure = Math.max(0.75, 1
          + Math.sin(t * 2.6 + ph) * und
          + Math.sin(t * 5.9 + ph * 2.3) * und * 0.35);
        const edge = 1
          + Math.sin(t * 7.3 + 1.8) * 0.026
          + Math.sin(t * 17.9 + 0.7) * 0.018
          + Math.sin(t * 41.3 + 2.4) * 0.010;
        const c = this.curveAt(i);
        const w = this.waveEnergy(t);
        const tipT = Math.min(1, limit / Math.max(1, total - 1));
        const headFade = soft <= 0 ? 1 : (0.35 + 0.65 * clamp(smoothstep(0, soft, Math.max(0, tipT - t)), 0, 1));
        const waveCorner = wave.corner || { compress: 0.15, brighten: 0.30 };
        const waveCompress = (waveCorner.compress === undefined ? 0.15 : waveCorner.compress) * c;
        const waveW = 1 + waveBoost * w * (1 - waveCompress);
        let half = spec.width * taper * pressure * edge * widthRisk * waveW * 0.5 * miter;
        if (turn > SHARP_TURN_RAD) {
          const minLen = Math.min(a.len, b.len);
          const foldLimit = Math.max(1.2, 1.2 * minLen / Math.tan(Math.min(turn, Math.PI * 0.92) * 0.5));
          if (half > foldLimit) half = foldLimit;
        }
        if (half < 0) half = 0;
        left[i] = { x: vis[i].x + nx * half, y: vis[i].y + ny * half };
        right[i] = { x: vis[i].x + nx * -half, y: vis[i].y + ny * -half };
        alpha[i] = clamp(spec.alpha * alphaRisk * (1 + alphaBoost * w) * this.fadeIn * headFade, 0, 1);
        colour[i] = this.colourAt(t, c, shadeLift);
        if (i === 0) { startHalf = half; startAlpha = alpha[0]; startColour = colour[0]; }
      }

      for (let i = 0; i < n - 1; i += 1) {
        ctx.globalAlpha = (alpha[i] + alpha[i + 1]) * 0.5;
        ctx.fillStyle = colour[i];
        ctx.beginPath();
        ctx.moveTo(left[i].x, left[i].y);
        ctx.lineTo(left[i + 1].x, left[i + 1].y);
        ctx.lineTo(right[i + 1].x, right[i + 1].y);
        ctx.lineTo(right[i].x, right[i].y);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      /* 起笔处补圆头 */
      if (spec.cap !== false && startHalf > 0.45 && n > 1) {
        ctx.globalAlpha = startAlpha;
        ctx.fillStyle = startColour;
        ctx.beginPath();
        ctx.arc(vis[0].x, vis[0].y, startHalf, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    curveAt(i) {
      if (!this.curve || !this.curve.length) return 0;
      const raw = this.curve[Math.max(0, Math.min(this.curve.length - 1, i))] || 0;
      return clamp(raw / 0.35, 0, 1);
    }

    /* 中央流光：同色柔光 + 连续光芯 + 光流丝 + 推进高光（screen 混合） */
    /* 已按新水墨契约移除 screen 发光层：三层墨线全部用 normal 混合，
       避免白色光芯 / bloom / 荧光描边。保留方法名供回退与静态校验。 */
    drawCore() { /* no-op：发光层已禁用 */ }

    drawPulses() { /* no-op：终点脉冲已随发光层移除 */ }
    drawHead() { /* no-op：笔头由浅墨层的柔和前缘替代 */ }
    drawPreview() {
      const ctx = this.ctx;
      const points = this.points;
      if (!ctx || points.length < 2) return;
      const failed = this.kind === 'failed';
      const ink = { r: failed ? 108 : 92, g: failed ? 116 : 110, b: failed ? 120 : 118 };
      const alpha = failed ? 0.34 : 0.46;
      ctx.save();
      ctx.setLineDash([6, 7]);
      ctx.lineWidth = 1.4;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(' + ink.r + ',' + ink.g + ',' + ink.b + ',' + alpha + ')';
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(' + ink.r + ',' + ink.g + ',' + ink.b + ',' + (alpha + 0.22) + ')';
      for (let i = 0; i < 2; i += 1) {
        const point = i === 0 ? points[0] : points[points.length - 1];
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3.2, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    draw() {
      if (!this.ctx) return;
      if (this.routeDirty) this.rebuild();
      this.ctx.clearRect(0, 0, this.width, this.height);
      if (this.glowCtx) this.glowCtx.clearRect(0, 0, this.width, this.height);
      if (this.points.length < 2) return;
      if (this.kind !== 'road') { this.drawPreview(); return; }
      this.buildColourLut();
      this.drawBody();
    }

    frame(timestamp) {
      this.framePending = false;
      if (!this.running || !this.visible) return;
      if (this.maybeResizeForDpr()) return;
      const raw = this.lastTime ? (timestamp - this.lastTime) / 1000 : 0;
      this.lastTime = timestamp;
      const dt = clamp(raw, 0, PHYSICS_DT_CAP);
      const writeDt = clamp(raw, 0, WRITE_DT_CAP);
      this.elapsed += this.reducedMotion ? 0 : dt;
      if (this.fadeIn < 1) this.fadeIn = Math.min(1, this.fadeIn + dt / 0.35);
      this.hover += (this.hoverTarget - this.hover) * (1 - Math.exp(-dt / 0.35));
      if (Math.abs(this.hoverTarget - this.hover) < HOVER_EPS) this.hover = this.hoverTarget;
      this.advanceRisk(dt);
      this.advanceWaves(dt);
      if (!this.reducedMotion && this.kind === 'road' && this.progress < 1) {
        const grow = this.growDuration();
        const step = writeDt / Math.max(0.5, grow);
        this.progress = Math.min(1, this.progress + step);
        const g = (config.ink && config.ink.route && config.ink.route.grow) || {};
        const bodyOffset = g.bodyOffset === undefined ? 0.05 : g.bodyOffset;
        const depositOffset = g.depositOffset === undefined ? 0.13 : g.depositOffset;
        this.bodyProgress = Math.min(1, Math.max(0, (this.progress - bodyOffset) / Math.max(1e-3, 1 - bodyOffset)));
        this.depositProgress = Math.min(1, Math.max(0, (this.progress - depositOffset) / Math.max(1e-3, 1 - depositOffset)));
      }
      this.draw();
      /* 真实路线持续流动：潮汐波峰/光流丝/推进高光永远在动，保持满帧。 */
      if (this.kind === 'road' && !this.reducedMotion) this.requestFrame();
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

    getState() {
      return {
        kind: this.kind,
        reason: this.reason,
        points: this.points.length,
        progress: this.progress,
        lengthPx: Math.round(this.totalLength),
        degenerate: this.degenerate,
        reducedMotion: this.reducedMotion
      };
    }

    getMetrics() {
      return {
        backend: '纯色流光',
        kind: this.kind,
        points: this.points.length,
        written: Math.round(this.progress * 100)
      };
    }
  }

  global.RiskTideInkFlow = InkFlow;
})(window);
