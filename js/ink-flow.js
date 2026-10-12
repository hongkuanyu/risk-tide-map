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
  function inkColour(risk, shade) {
    const rgb = [0, 0, 0];
    const renderer = global.RiskTideNationInk;
    if (renderer && typeof renderer.riskColour === 'function') {
      renderer.riskColour(risk, rgb);
    } else {
      rgb[0] = 43; rgb[1] = 43; rgb[2] = 40;
    }
    /* shade < 1 = 这一层更沉（墨体压深，芯光才亮得出来）；色相仍随风险走 */
    const k = shade === undefined ? 1 : clamp(shade, 0, 1);
    if (k >= 0.999) return { r: rgb[0], g: rgb[1], b: rgb[2], str: 'rgb(' + rgb.join(',') + ')' };
    const out = [Math.round(rgb[0] * k), Math.round(rgb[1] * k), Math.round(rgb[2] * k)];
    return { r: out[0], g: out[1], b: out[2], str: 'rgb(' + out.join(',') + ')' };
  }

  /* 芯光通道：同一色阶的极简线性插值（色值本身来自 config.ink.coreRamp）。
     墨体负责"是什么"，芯光负责"有多紧"——低风险冷银、临近迟到转暖白、超出转焦红。 */
  function coreColour(risk) {
    const ramp = (config.ink && config.ink.coreRamp) || null;
    if (!ramp || !ramp.length) {
      const base = inkColour(risk);
      return { r: base.r, g: base.g, b: base.b, str: base.str };
    }
    const t = clamp((Number(risk) || 0) / 100, 0, 1);
    let a = ramp[0];
    let b = ramp[ramp.length - 1];
    for (let i = 1; i < ramp.length; i += 1) {
      if (t <= ramp[i].at) { a = ramp[i - 1]; b = ramp[i]; break; }
    }
    const span = (b.at - a.at) || 1;
    const k = smoothstep(0, 1, clamp((t - a.at) / span, 0, 1));
    const rgb = [
      Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * k),
      Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * k),
      Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * k)
    ];
    return { r: rgb[0], g: rgb[1], b: rgb[2], str: 'rgb(' + rgb.join(',') + ')' };
  }

  /* hover 时只轻微增强墨脊，不做发光 / 放大 */
  function hoverBoostValue(hover) { return 1 + (Number(hover) || 0) * 0.18; }

  /* 点到线段的距离（屏幕坐标），供 hover / 点击命中检测。 */
  function pointSegmentDistance(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq ? ((px - a.x) * dx + (py - a.y) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + dx * t, cy = a.y + dy * t;
    return Math.hypot(px - cx, py - cy);
  }

  /* ---- 几何常量 -------------------------------------------------------- */
  const MIN_SEGMENT_PX = 0.6;      // 重复坐标 / 极短路径段的合并阈值
  const MIN_STEP_PX = 2.2;         // 采样下限：急弯处也能得到稳定的切线
  const MAX_STEP_PX = 5;           // 采样上限：保留水墨笔触的连贯
  const MAX_POINTS = 560;          // 单条墨线采样点上限（拖动时每帧重投影的开销上限）
  const MAX_STEP_RELAXED = 12;     // 触到上限时允许放粗的步长上限（保证不出现明显削角）
  const HIT_RADIUS_PX = 18;        // 悬停 / 点击命中半径
  const IDLE_REFRESH_MS = 110;     // 静止后的低频重绘：墨要活着，但不做满帧动画
  const MITER_MAX = 1.45;          // 接缝斜接上限：粗笔触在急转弯处不许长出尖喙
  const SHARP_TURN_RAD = Math.PI * 2 / 3;  // 超过 120° 视为折返，额外收窄
  const PHYSICS_DT_CAP = 0.5;      // 风险传播 / 悬停插值的单帧上限（秒）
  const WRITE_DT_CAP = 1.0;        // 写线时钟的单帧上限（秒）
  const HOVER_EPS = 0.004;         // 悬停强度收敛阈值：收敛后停止逐帧重绘

  /* 轻度平滑（只动内部点）：压掉折返 / 急转弯造成的切线抖动。
     权重随采样步长自适应——步长越粗，权重越小，不会把真实转角磨圆。 */
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
      /* 芯光单独画在一层 screen 混合的画布上：墨层是 multiply，只能把底图压暗，
         想"发光"必须另起一层，否则亮芯只会变成一道浅灰。 */
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
      this.displayRisk = new Float32Array(0);
      this.riskTarget = 0;
      this.routeDirty = true;
      this.progress = 0;
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
      this.frameTimer = 0;
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

    /* 设备像素比上限：DPR 越高不代表线越细，只要画布足够清晰即可。 */
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

    /* DPR 变化（跨屏拖动 / 浏览器缩放）不会触发 window resize，这里主动校验。 */
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

    /* 无真实道路几何时的示意几何：只连起终点，绝不用真实水墨笔触表现。 */
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

    /* status: { kind: 'road' | 'preview' | 'failed', reason } —— 由 app 层判定。 */
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
      this.writeElapsed = 0;
      /* 新路线不再沿用上一条线的悬停状态与墨头，避免新旧混淆 */
      this.hover = 0;
      this.hoverTarget = 0;
      if (changed) this.elapsed = 0;
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

    /* 悬停 / 点击命中：返回最近的落点，供浮层定位。 */
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
      /* 法线朝向指针所在的一侧，浮层据此把锚点推离墨线，不压住笔画 */
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

    /* 兼容旧调用：返回 0..1 的悬停强度。 */
    hoverAt(x, y) {
      const hit = this.hitTest(x, y);
      return hit ? hit.strength : 0;
    }

    /* 墨线中点（键盘交互 / 无指针时的浮层锚点）。 */
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
        this.displayRisk = new Float32Array(0);
        return;
      }
      const system = this.kind === 'road'
        ? (this.route && this.route.coordinateSystem) : 'WGS84';
      const projected = this.map.getScreenPath(coordinates, system)
        .filter(function (point) { return point && Number.isFinite(point.x) && Number.isFinite(point.y); });
      if (projected.length < 2) {
        this.displayRisk = new Float32Array(0);
        return;
      }

      /* 去重：重复坐标与极短路径段会污染切线，进而在笔触上产生尖刺。 */
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
      if (dense.length < 2 || total < MIN_SEGMENT_PX) {
        this.displayRisk = new Float32Array(0);
        return;
      }
      this.totalLength = total;

      /* 等距弧长重采样：步长随总长自适应，既补稀（原始点太疏）也抽密（供应商
         几何过密），任意输入下的采样点数都被 MAX_POINTS 兜住。这对拖动时
         每帧重投影的开销很关键，也让法线/笔触在疏密不均的数据上同样稳定。 */
      let step = clamp(total / MAX_POINTS, MIN_STEP_PX, MAX_STEP_PX);
      /* 超长路线：宁可放粗步长也要守住点数上限，但放粗不超过 MAX_STEP_RELAXED */
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
      /* 真实终点必须落在序列里，否则墨头收不到终点 */
      const tail = dense[dense.length - 1];
      const lastOut = forward[forward.length - 1];
      if (Math.hypot(tail.x - lastOut.x, tail.y - lastOut.y) > MIN_SEGMENT_PX) {
        forward.push({ x: tail.x, y: tail.y });
      }
      /* 两遍轻平滑：粗笔触在转弯处要像毛笔转锋那样圆过去，而不是折出尖角 */
      const smoothWeight = 0.22 * Math.min(1, MAX_STEP_PX / step);
      smoothPolyline(forward, smoothWeight);
      smoothPolyline(forward, smoothWeight);
      /* 终点 -> 起点：墨从目的地向出发地渗开 */
      this.points = [];
      for (let i = forward.length - 1; i >= 0; i -= 1) this.points.push(forward[i]);
      /* 与 points 平行的逐点风险采样：新路线直接落在当前目标风险 */
      const n = this.points.length;
      this.displayRisk = new Float32Array(n);
      for (let i = 0; i < n; i += 1) this.displayRisk[i] = this.riskTarget;
      this.degenerate = false;
    }

    /* 风险沿墨线传播：墨头（终点，index 0）先响应，墨尾（起点）滞后。
       升高像新墨滴进入旧墨；回落更慢，留下余墨。 */
    advanceRisk(dt) {
      const n = this.points.length;
      if (!n) return false;
      /* prefers-reduced-motion：不做沿墨线的浸染动画，直接落到目标风险。
         否则每帧只走 ~5%，而这一模式又不会连续续帧，颜色会永远停在半途。 */
      if (this.reducedMotion) {
        for (let i = 0; i < n; i += 1) this.displayRisk[i] = this.riskTarget;
        return false;
      }
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

    /* ── 湿墨笔触 ─────────────────────────────────────────────────────────
       一层墨：宽度 = 基准 × 收笔走向 × 压力起伏 × 边缘毛糙 × 风险倍率。
       phase / undulate 让每层宽度的起伏互不同相，叠起来才像"墨从边上渗进来"，
       而不是一条等宽的带子。逐段填色，沿线的颜色渐变来自 displayRisk。 */
    /* 起笔 / 收笔走向（各层共用，改一处即全变） */
    fadeStartFor(sharp) {
      return 0.62 + sharp * 0.20;
    }

    /* 收笔处最细能到多细：保留一定笔肉，末段才收成笔锋而不是断线 */
    tailFloorFor(sharp) {
      return 0.30 + sharp * 0.14;
    }

    /* 逐点尺度（taper / edge / breathe）：飞白与芯光靠它与墨体对齐 */
    layerScale(sharp, i, total, phase, undulate) {
      const route = (config.ink && config.ink.route) || {};
      const flow = route.flow || {};
      const flowAmp = flow.amplitude === undefined ? 0.03 : flow.amplitude;
      const flowPeriod = Math.max(8, flow.period || 26);
      const time = this.reducedMotion ? 0 : this.elapsed;
      const t = i / Math.max(1, total - 1);
      const floor = this.tailFloorFor(sharp);
      const tailFade = 1 - smoothstep(this.fadeStartFor(sharp), 1, t);
      const ph = phase === undefined ? 0 : phase;
      const und = undulate === undefined ? 0 : undulate;
      return {
        t: t,
        taper: floor + (1 - floor) * tailFade,
        /* 运笔轻重：低频鼓瘪为主、高频抖动为辅（各层相位可错开） */
        pressure: Math.max(0.35, 1 + Math.sin(t * 3.4 + ph) * und + Math.sin(t * 9.1 + ph * 1.7) * und * 0.35),
        edge: 1 + Math.sin(t * 17 + 0.7) * 0.05 + Math.sin(t * 5.2 + 1.8) * 0.035,
        breathe: 1 + Math.sin(time * (Math.PI * 2) / flowPeriod + t * 6.1) * flowAmp
      };
    }

    /* 通用描线通道：describe(scale, risk01, i) 返回 { offset, width, alpha, shade }，
       飞白细毛与芯光都沿同一条中轴线铺开；sharp 决定它的收笔走向。 */
    tracePass(limit, describe, channel, context, sharp, phase, undulate) {
      const ctx = context || this.ctx;
      if (!ctx) return;
      const points = this.points;
      const total = points.length;
      if (total < 2 || limit < 1) return;
      const endIndex = Math.min(total - 1, Math.max(1, Math.floor(limit)));
      const tEnd = limit - Math.floor(limit);
      const vis = [];
      for (let i = 0; i <= endIndex; i += 1) {
        vis.push({ x: points[i].x, y: points[i].y, risk: this.displayRisk[i] });
      }
      if (endIndex < total - 1 && tEnd > 0) {
        const a = points[endIndex], b = points[endIndex + 1];
        vis.push({
          x: a.x + (b.x - a.x) * tEnd,
          y: a.y + (b.y - a.y) * tEnd,
          risk: this.displayRisk[endIndex] + (this.displayRisk[endIndex + 1] - this.displayRisk[endIndex]) * tEnd
        });
      }
      const n = vis.length;
      if (n < 2) return;

      const left = new Array(n);
      const right = new Array(n);
      const alpha = new Array(n);
      const risk = new Array(n);
      let shade = 1;
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
        const scale = this.layerScale(sharp === undefined ? 0.5 : sharp, i, total, phase, undulate);
        const spec = describe(scale, vis[i].risk / 100, i) || { offset: 0, width: 0, alpha: 0 };
        if (spec.shade !== undefined) shade = spec.shade;
        const half = Math.max(0, spec.width) * 0.5;
        left[i] = { x: vis[i].x + nx * (spec.offset + half), y: vis[i].y + ny * (spec.offset + half) };
        right[i] = { x: vis[i].x + nx * (spec.offset - half), y: vis[i].y + ny * (spec.offset - half) };
        alpha[i] = clamp(spec.alpha, 0, 1);
        risk[i] = vis[i].risk;
      }

      for (let i = 0; i < n - 1; i += 1) {
        const mid = (risk[i] + risk[i + 1]) * 0.5;
        const colour = channel === 'core' ? coreColour(mid) : inkColour(mid, shade);
        ctx.globalAlpha = (alpha[i] + alpha[i + 1]) * 0.5;
        ctx.fillStyle = colour.str;
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

    drawRibbon(limit, baseWidth, baseAlpha, sharp, shade, phase, undulate) {
      const ctx = this.ctx;
      const points = this.points;
      const total = points.length;
      if (total < 2 || limit < 1) return;
      const route = (config.ink && config.ink.route) || {};
      const riskCfg = route.risk || {};
      const flow = route.flow || {};
      const sh = sharp === undefined ? 0.5 : sharp;
      const ph = phase === undefined ? 0 : phase;
      const und = undulate === undefined ? 0 : undulate;
      const fadeStart = this.fadeStartFor(sh);
      const minFrac = this.tailFloorFor(sh);
      const time = this.reducedMotion ? 0 : this.elapsed;
      const flowAmp = flow.amplitude === undefined ? 0.03 : flow.amplitude;
      const flowPeriod = Math.max(8, flow.period || 26);
      const wMin = riskCfg.width && riskCfg.width.min !== undefined ? riskCfg.width.min : 0.85;
      const wMax = riskCfg.width && riskCfg.width.max !== undefined ? riskCfg.width.max : 1.25;
      const aMin = riskCfg.alpha && riskCfg.alpha.min !== undefined ? riskCfg.alpha.min : 0.78;
      const aMax = riskCfg.alpha && riskCfg.alpha.max !== undefined ? riskCfg.alpha.max : 1.08;

      const endIndex = Math.min(total - 1, Math.max(1, Math.floor(limit)));
      const tEnd = limit - Math.floor(limit);
      const vis = [];
      for (let i = 0; i <= endIndex; i += 1) {
        vis.push({ x: points[i].x, y: points[i].y, risk: this.displayRisk[i] });
      }
      if (endIndex < total - 1 && tEnd > 0) {
        const a = points[endIndex], b = points[endIndex + 1];
        vis.push({
          x: a.x + (b.x - a.x) * tEnd,
          y: a.y + (b.y - a.y) * tEnd,
          risk: this.displayRisk[endIndex] + (this.displayRisk[endIndex + 1] - this.displayRisk[endIndex]) * tEnd
        });
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
      let startHalf = 0;
      let startAlpha = 0;
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
        /* t 以整条路线为基准：已画好的位置宽度保持稳定 */
        const t = i / Math.max(1, total - 1);
        const tailFade = 1 - smoothstep(fadeStart, 1, t);
        const taper = minFrac + (1 - minFrac) * tailFade;
        /* 压力起伏：低频"运笔轻重" + 高频"笔毛抖动"，各层相位不同 */
        const pressure = Math.max(0.35,
          1 + Math.sin(t * 3.4 + ph) * und + Math.sin(t * 9.1 + ph * 1.7) * und * 0.35);
        /* 边缘毛糙：低/中/高三层，都是确定相位——粗笔触的长直段也不会变成等宽直线 */
        const edge = 1
          + Math.sin(t * 5.2 + 1.8) * 0.055
          + Math.sin(t * 13.7 + 0.7) * 0.045
          + Math.sin(t * 31.3 + 2.4) * 0.028;
        const breathe = 1 + Math.sin(time * (Math.PI * 2) / flowPeriod + t * 6.1) * flowAmp;
        const rn = vis[i].risk / 100;
        const widthFactor = wMin + (wMax - wMin) * rn;
        const alphaFactor = aMin + (aMax - aMin) * rn;
        /* 起笔顿笔：墨头那几笔略重，避免从头就是一个平口 */
        const press = 1 + 0.16 * (1 - smoothstep(0, 0.07, t));
        let half = baseWidth * taper * pressure * press * edge * breathe * widthFactor * 0.5 * miter;
        if (turn > SHARP_TURN_RAD) {
          const minLen = Math.min(a.len, b.len);
          const foldLimit = Math.max(1.2, 1.2 * minLen / Math.tan(Math.min(turn, Math.PI * 0.92) * 0.5));
          if (half > foldLimit) half = foldLimit;
        }
        if (half < 0) half = 0;
        if (i === 0) { startHalf = half; startAlpha = clamp(baseAlpha * alphaFactor, 0, 1); }
        left[i] = { x: vis[i].x + nx * half, y: vis[i].y + ny * half };
        right[i] = { x: vis[i].x - nx * half, y: vis[i].y - ny * half };
        alpha[i] = clamp(baseAlpha * alphaFactor, 0, 1);
      }

      for (let i = 0; i < n - 1; i += 1) {
        const mid = (vis[i].risk + vis[i + 1].risk) * 0.5;
        const ink = inkColour(mid, shade);
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
      /* 起笔处补圆头（各层同一位置、同一半径），墨迹的起点才是"落笔"而不是平口 */
      if (startHalf > 0.45 && n > 1) {
        ctx.globalAlpha = startAlpha;
        ctx.fillStyle = inkColour(vis[0].risk, shade).str;
        ctx.beginPath();
        ctx.arc(vis[0].x, vis[0].y, startHalf, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    /* 墨体：墨晕 → 外墨 → 中墨 → 内墨 → 墨脊，逐层收窄压深；
       每层独立的起伏相位，边界才会彼此错开，叠出层次而不是色块。 */
    drawInkMass(limit) {
      const route = (config.ink && config.ink.route) || {};
      const halo = route.halo || {};
      if (halo.width) {
        this.drawRibbon(limit, halo.width, halo.alpha === undefined ? 0.08 : halo.alpha, 0,
          halo.shade === undefined ? 1 : halo.shade,
          halo.phase === undefined ? 0.9 : halo.phase,
          halo.undulate === undefined ? 0.12 : halo.undulate);
      }
      const passes = route.passes || [];
      for (let i = 0; i < passes.length; i += 1) {
        const pass = passes[i];
        if (!pass || !pass.width) continue;
        this.drawRibbon(limit, pass.width,
          pass.alpha === undefined ? 0.26 : pass.alpha,
          pass.sharp === undefined ? 0.4 : pass.sharp,
          pass.shade === undefined ? 1 : pass.shade,
          pass.phase === undefined ? i * 1.7 : pass.phase,
          pass.undulate === undefined ? 0.14 : pass.undulate);
      }
      this.drawBristles(limit);
    }

    /* 飞白：贴着最外层墨体的边，断断续续伸出几根干笔细毛。
       每根毛只在某一小段纸上出现（两头淡出），并有疏密节律——不是从头到尾的平行线。 */
    drawBristles(limit) {
      const route = (config.ink && config.ink.route) || {};
      const cfg = route.bristle;
      if (!cfg || !cfg.strands) return;
      const passes = route.passes || [];
      let outerWidth = 0;
      for (let i = 0; i < passes.length; i += 1) {
        if (passes[i] && passes[i].width > outerWidth) outerWidth = passes[i].width;
      }
      if (!outerWidth) return;
      const scatter = cfg.scatter === undefined ? 0.5 : cfg.scatter;
      const tailKeep = cfg.tailKeep === undefined ? 0.4 : cfg.tailKeep;
      const count = Math.max(0, Math.round(cfg.strands));
      const perSide = Math.max(1, Math.ceil(count / 2));
      const outerHalf = outerWidth * 0.5;
      for (let k = 0; k < count; k += 1) {
        const side = k % 2 === 0 ? 1 : -1;
        const rank = Math.floor(k / 2) + 1;
        const reach = cfg.inner + (cfg.outer - cfg.inner) * (rank / perSide);
        const outer = rank / perSide;
        const phase = k * 2.3 + 0.7;
        const startAt = (k * 37 % 100) / 100 * scatter;
        const endAt = Math.min(1, Math.max(startAt + 0.25, 1 - (k * 53 % 100) / 100 * (1 - tailKeep)));
        this.tracePass(limit, function (scale, risk01) {
          const t = scale.t;
          const life = smoothstep(startAt, startAt + 0.10, t) * (1 - smoothstep(endAt - 0.14, endAt, t));
          if (life <= 0.002) return { offset: 0, width: 0, alpha: 0 };
          /* 两道断续门：细毛沿路"出—没—出"，而不是一条通到底的平行划痕 */
          const gate = (0.25 + 0.75 * smoothstep(-0.35, 0.45, Math.sin(t * 12.7 + phase * 2.1)))
            * (0.30 + 0.70 * smoothstep(-0.20, 0.40, Math.sin(t * 17.3 + phase * 3.7)));
          const wiggle = 1 + Math.sin(t * 21 + phase) * 0.24 + Math.sin(t * 6.1 + phase * 0.7) * 0.14;
          return {
            offset: side * outerHalf * reach * scale.taper * scale.pressure * scale.breathe * scale.edge * wiggle,
            width: cfg.width * (0.6 + 0.7 * (1 - outer)) * (0.85 + 0.3 * risk01),
            alpha: cfg.alpha * (0.45 + 0.55 * (1 - outer)) * gate * life * (0.8 + 0.35 * scale.breathe),
            shade: cfg.shade === undefined ? 1 : cfg.shade
          };
        }, 'ink', null, 0.5, cfg.phase, cfg.undulate);
      }
    }

    /* 芯光：墨体里的一道光。
       - 只在中段出现，两端自然淡出（不是被切断的灯管）；
       - 柔光宽而弱、亮芯细而亮，且沿长度有明暗节律（光在墨里游走）；
       - 颜色随风险：宽裕冷银青 → 时间收窄近白 → 注意暖金 → 可能迟到焦红。 */
    drawCore(limit) {
      const route = (config.ink && config.ink.route) || {};
      const cfg = route.core;
      if (!cfg || cfg.enabled === false || !this.glowCtx) return;
      const bloomWidth = cfg.bloom === undefined ? 15 : cfg.bloom;
      const bloomAlpha = cfg.bloomAlpha === undefined ? 0.26 : cfg.bloomAlpha;
      const coreWidth = cfg.width === undefined ? 1.5 : cfg.width;
      const coreAlpha = cfg.alpha === undefined ? 0.92 : cfg.alpha;
      const hold = cfg.hold === undefined ? 0.17 : cfg.hold;
      /* 流动：光的相位随时间平移（drift = 每秒相位），观感是光在笔画里游走，
         而不是原地明灭；prefers-reduced-motion 时 drift = 0，画面完全静止。 */
      const drift = this.reducedMotion ? 0 : this.elapsed * (cfg.drift === undefined ? 0.55 : cfg.drift);
      const envelope = function (t) {
        return smoothstep(0, hold, t) * (1 - smoothstep(1 - hold, 1, t));
      };
      /* 外柔光 */
      this.tracePass(limit, function (scale, risk01) {
        const env = envelope(scale.t);
        if (env <= 0.002) return { offset: 0, width: 0, alpha: 0 };
        const swell = 1 + Math.sin(scale.t * 4.7 + 0.4 + drift * 0.6) * 0.30
          + Math.sin(scale.t * 11.1 - drift * 0.9) * 0.18;
        return {
          offset: Math.sin(scale.t * 7.9) * bloomWidth * 0.05,
          width: bloomWidth * env * swell * (0.7 + 0.3 * scale.taper) * (0.55 + 0.45 * scale.pressure),
          alpha: bloomAlpha * env * (0.25 + 0.75 * risk01) * (0.35 + 0.65 * scale.pressure)
            * (0.55 + 0.45 * smoothstep(-0.4, 0.5, Math.sin(scale.t * 6.3 + 0.8)))
        };
      }, 'core', this.glowCtx, 0.9, cfg.phase, cfg.undulate);
      /* 亮芯 */
      this.tracePass(limit, function (scale, risk01) {
        const env = envelope(scale.t);
        if (env <= 0.002) return { offset: 0, width: 0, alpha: 0 };
        const pulse = 0.20 + 0.80 * smoothstep(-0.55, 0.55,
          Math.sin(scale.t * 6.4 + 1.1 - drift));
        return {
          offset: 0,
          width: coreWidth * env * (0.75 + 0.25 * scale.taper) * (0.85 + 0.3 * scale.pressure),
          alpha: clamp(coreAlpha * env * pulse * (0.30 + 0.70 * risk01) * (0.4 + 0.6 * scale.pressure), 0, 1)
        };
      }, 'core', this.glowCtx, 0.9, cfg.phase, cfg.undulate);
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

    /* 非真实道路路线：一条克制的虚线示意，明确区别于水墨实笔。
       规划失败时更淡，并保留起终点墨点，让"这里只有两个点"一眼可读。 */
    drawPreview() {
      const ctx = this.ctx;
      const points = this.points;
      if (!ctx || points.length < 2) return;
      const failed = this.kind === 'failed';
      const ink = inkColour(failed ? 24 : this.riskTarget);
      const alpha = failed ? 0.30 : 0.42;
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
      const limit = (this.points.length - 1) * this.progress;
      const route = (config.ink && config.ink.route) || {};
      const bone = route.bone || {};
      /* 墨体（含墨晕与飞白）→ 墨脊 → 芯光；hover 只轻微增强墨脊 */
      this.drawInkMass(limit);
      if (bone.width) {
        this.drawRibbon(limit, bone.width, clamp((bone.alpha === undefined ? 0.85 : bone.alpha) * hoverBoostValue(this.hover), 0, 1),
          1, bone.shade, bone.phase === undefined ? 1.2 : bone.phase,
          bone.undulate === undefined ? 0.08 : bone.undulate);
      }
      this.drawCore(limit);
      /* 墨头：只在生长过程中出现，写完后静置 */
      if (this.progress < 1) this.drawHead(this.progress);
    }

    frame(timestamp) {
      this.framePending = false;
      if (!this.running || !this.visible) return;
      if (this.maybeResizeForDpr()) return;   /* 尺寸重建后由下一次帧完成绘制 */
      /* dt 只用于物理量积分；写线进度用独立的、上限更宽的时钟，
         这样低帧率设备上墨线仍在设定时长附近写完，而不是按帧数慢慢爬。 */
      const raw = this.lastTime ? (timestamp - this.lastTime) / 1000 : 0;
      this.lastTime = timestamp;
      const dt = clamp(raw, 0, PHYSICS_DT_CAP);
      const writeDt = clamp(raw, 0, WRITE_DT_CAP);
      this.elapsed += this.reducedMotion ? 0 : dt;
      this.hover += (this.hoverTarget - this.hover) * (1 - Math.exp(-dt / 0.35));
      if (Math.abs(this.hoverTarget - this.hover) < HOVER_EPS) this.hover = this.hoverTarget;
      const settling = this.advanceRisk(dt);
      if (!this.reducedMotion && this.kind === 'road' && this.progress < 1) {
        const grow = (config.ink && config.ink.route && config.ink.route.growSeconds) || 5.2;
        this.writeElapsed += writeDt;
        this.progress = Math.min(1, this.writeElapsed / grow);
      }
      this.draw();
      if (this.points.length < 2) return;  /* 尚无路线：不空转 */
      const active = !this.reducedMotion && this.kind === 'road' && (this.progress < 1 || settling
        || Math.abs(this.hoverTarget - this.hover) > HOVER_EPS);
      if (active) {
        this.requestFrame();
      } else if (!this.reducedMotion && this.kind === 'road') {
        /* 稳定态仍有极轻微流动，低频重绘，几乎不占 CPU */
        global.clearTimeout(this.frameTimer);
        this.frameTimer = global.setTimeout(this.boundRequest, IDLE_REFRESH_MS);
      }
    }

    setVisible(visible) {
      this.visible = !!visible;
      /* 复位时间基准：切回前台时不会因为跳变的时间戳让墨线瞬间写完或抖动 */
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

    /* 供测试与调试读取的运行状态（不改变渲染行为）。 */
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
        backend: '连续墨线',
        kind: this.kind,
        points: this.points.length,
        written: Math.round(this.progress * 100)
      };
    }
  }

  global.RiskTideInkFlow = InkFlow;
})(window);