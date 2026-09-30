/* global window, document */
(function (global) {
  'use strict';

  const config = global.RiskTideConfig;
  const flow = global.RiskTideFlowField;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /* Possibility channel: one tone per still-open branch. As a branch closes it
     first desaturates through grey, then gets absorbed into the surviving
     colour - so the eye reads "several futures" collapsing into "one future",
     never a mix that simply turns muddy. */
  function resolveBranchTone(tone, closeProgress, spec, out) {
    const greyAt = spec.greyAt;
    const grey = spec.grey;
    const absorb = spec.absorb;
    let from;
    let to;
    let t;
    if (closeProgress <= greyAt) {
      from = tone;
      to = grey;
      t = greyAt > 0 ? closeProgress / greyAt : 1;
    } else {
      from = grey;
      to = absorb;
      t = (closeProgress - greyAt) / Math.max(0.0001, 1 - greyAt);
    }
    out.r = Math.round(lerp(from[0], to[0], t));
    out.g = Math.round(lerp(from[1], to[1], t));
    out.b = Math.round(lerp(from[2], to[2], t));
    return out;
  }

  /* Reads a [slack, taut] pair and interpolates by tension. */
  function pairAt(pair, t, fallbackSlack, fallbackTaut) {
    const a = (pair && pair.length === 2) ? pair[0] : fallbackSlack;
    const b = (pair && pair.length === 2) ? pair[1] : fallbackTaut;
    return lerp(a, b, t);
  }

  function detectProfile() {
    const width = global.innerWidth || document.documentElement.clientWidth;
    const mobile = width <= 760 || /Mobi|Android|iPhone|iPad/i.test(global.navigator.userAgent);
    const cores = global.navigator.hardwareConcurrency || 4;
    const memory = global.navigator.deviceMemory || 4;
    const reducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const budgetSet = mobile ? config.particleBudgets.mobile : config.particleBudgets.desktop;
    const low = cores <= config.quality.lowCpuCores || memory <= config.quality.lowMemoryGb || reducedMotion;
    const high = cores >= 8 && memory >= 8 && !mobile;
    return {
      mobile: mobile,
      low: low,
      high: high,
      cores: cores,
      memory: memory,
      dprCap: mobile ? config.particleBudgets.dpr.mobile : config.particleBudgets.dpr.desktop,
      base: low ? budgetSet.low : (high ? budgetSet.high : budgetSet.base),
      maximum: budgetSet.maximum
    };
  }

  class InkParticleSystem {
    constructor(canvas, mapController) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
      this.map = mapController;
      this.profile = detectProfile();
      this.maxParticles = this.profile.maximum;
      this.baseTarget = this.profile.base;
      this.quality = 1;
      this.activeCount = 0;
      this.risk = 0;
      this.riskTarget = 0;
      /* --- Possibility: the only colour channel ------------------------- */
      const poss = (config.tide && config.tide.possibility) || {};
      this.possibility = {
        count: poss.count || 4,
        tones: poss.tones || [[30, 75, 87]],
        absorb: poss.absorb || [46, 143, 168],
        grey: poss.grey || [122, 126, 128],
        greyAt: poss.greyAt !== undefined ? poss.greyAt : 0.45,
        closeDuration: poss.closeDuration || 0.6,
        stagger: poss.staggerPerBranch !== undefined ? poss.staggerPerBranch : 0.1
      };
      const pcount = this.possibility.count;
      this.branchClose = new Float32Array(pcount);      // 0 open .. 1 absorbed
      this.branchRGB = new Array(pcount);
      for (let b = 0; b < pcount; b += 1) {
        this.branchRGB[b] = {
          r: this.possibility.tones[b][0],
          g: this.possibility.tones[b][1],
          b: this.possibility.tones[b][2]
        };
      }
      this.openCount = pcount;
      this.waterColor = {
        r: this.possibility.absorb[0],
        g: this.possibility.absorb[1],
        b: this.possibility.absorb[2]
      };      this.route = null;
      this.pendingRoute = null;
      this.routeChangeProgress = 1;
      this.running = false;
      this.visible = true;
      this.lastTime = 0;
      this.elapsed = 0;
      this.frameAverage = 16.7;
      this.qualityCooldown = 0;
      this.arrivalPulse = 0;
      // --- Risk Tide V2 interaction state -------------------------------
      this.tideConfig = (config.tide) || {};
      this.tension = 0;
      this.pointerX = 0;
      this.pointerY = 0;
      this.pointerActive = false;
      this.pointerSpeed = 0;
      this.lastPointerX = 0;
      this.lastPointerY = 0;
      this.lastPointerTime = 0;
      this.wakeStrength = 0;
      this.wakeRadius = this.profile.mobile
        ? ((this.tideConfig.wakeRadius || {}).mobile || 0)
        : ((this.tideConfig.wakeRadius || {}).desktop || 0);
      this.wakeRadiusSq = this.wakeRadius * this.wakeRadius;
      this.resonanceDistance = this.profile.mobile
        ? ((this.tideConfig.resonanceTriggerDistance || {}).mobile || 0)
        : ((this.tideConfig.resonanceTriggerDistance || {}).desktop || 0);
      this.resonanceActive = false;
      this.resonanceProgress = 0;
      this.resonanceCooldown = 0;
      const rippleMax = this.profile.mobile
        ? ((this.tideConfig.rippleMax || {}).mobile || 2)
        : ((this.tideConfig.rippleMax || {}).desktop || 4);
      this.ripples = new Array(rippleMax);
      for (let r = 0; r < rippleMax; r += 1) {
        this.ripples[r] = { active: false, x: 0, y: 0, age: 0, seed: r, aspect: 1, tilt: 0 };
      }
      this.rippleCursor = 0;
      this.bandSample = { x: 0, y: 0, tx: 1, ty: 0 };
      this.pointerBound = false;
      this.pressing = false;
      this.pressX = 0;
      this.pressY = 0;
      this.width = 1;
      this.height = 1;
      this.dpr = 1;
      this.sampleCount = this.profile.mobile ? 78 : 132;
      this.samplesX = new Float32Array(this.sampleCount + 1);
      this.samplesY = new Float32Array(this.sampleCount + 1);
      this.samplesTX = new Float32Array(this.sampleCount + 1);
      this.samplesTY = new Float32Array(this.sampleCount + 1);
      this.smoothTX = new Float32Array(this.sampleCount + 1);
      this.smoothTY = new Float32Array(this.sampleCount + 1);
      this.projected = [];
      this.routeDirty = true;
      this.curlOut = { x: 0, y: 0 };
      this.pathSample = { x: 0, y: 0, tx: 0, ty: 1 };
      this.pool = new Array(this.maxParticles);
      for (let i = 0; i < this.maxParticles; i += 1) {
        this.pool[i] = this.createParticle(i);
      }
      this.resize();
      this.setRoute(null);
    }

    createParticle(index) {
      const modulo = index % 20;
      const layer = modulo < 10 ? 0 : (modulo < 17 ? 1 : 2);
      const random = Math.random();
      const tide = this.tideConfig || {};
      const variance = tide.speedVariance || [0.85, 1.15];
      const trailRange = tide.trailPersonality || [0.85, 1.15];
      const modRange = tide.speedModulationFreq || [0.04, 0.08];
      const driftA = tide.driftFreqA || [0.055, 0.115];
      const driftB = tide.driftFreqB || [0.019, 0.043];
      // Centre-weighted channel position: most particles hug the middle of the
      // current, only a few drift along its edges. Never a uniform spread.
      const concentration = tide.channelConcentration || 1.8;
      const direction = Math.random() < 0.5 ? -1 : 1;
      const channelOffset = direction * Math.pow(Math.random(), concentration);
      return {
        layer: layer,
        /* ---- Flow personality: stable for the particle's whole life ---- */
        flowSeed: Math.random() * 1000,
        /* Which possibility this particle belongs to. Round-robin keeps the
           four tones evenly populated without any randomness drift. */
        branch: index % ((this.tideConfig && this.tideConfig.possibility
          && this.tideConfig.possibility.count) || 4),
        shiverFreq: lerp(5.5, 9.5, Math.random()),
        speedBias: lerp(variance[0], variance[1], Math.random()),
        channelOffset: channelOffset,
        lateralBias: (Math.random() * 2 - 1) * 0.18,
        trailBias: lerp(trailRange[0], trailRange[1], Math.random()),
        opacityBias: 0.9 + Math.random() * 0.2,
        sizeBias: 0.88 + Math.random() * 0.24,
        phaseA: Math.random() * Math.PI * 2,
        phaseB: Math.random() * Math.PI * 2,
        modFreq: lerp(modRange[0], modRange[1], Math.random()),
        modPhase: Math.random() * Math.PI * 2,
        eddySeed: Math.random() * Math.PI * 2,
        tideFreqA: lerp(driftA[0], driftA[1], Math.random()),
        tideFreqB: lerp(driftB[0], driftB[1], Math.random()),
        /* ---- Base shape ------------------------------------------------ */
        travel: random,
        lateral: (Math.random() * 2 - 1) * (layer === 0 ? 0.35 : 0.18),
        speed: layer === 0 ? 0.018 + Math.random() * 0.022 : (layer === 1 ? 0.035 + Math.random() * 0.04 : 0.055 + Math.random() * 0.055),
        size: layer === 0 ? 0.16 + Math.random() * 0.28 : (layer === 1 ? 0.28 + Math.random() * 0.45 : 0.42 + Math.random() * 0.55),
        alpha: layer === 0 ? 0.1 + Math.random() * 0.17 : (layer === 1 ? 0.42 + Math.random() * 0.44 : 0.5 + Math.random() * 0.46),
        phase: Math.random() * Math.PI * 2,
        breathe: 0.75 + Math.random() * 0.65,
        drift: (Math.random() * 2 - 1) * 46,
        wobble: 0.35 + Math.random() * 1.35,
        scatter: Math.random() * 1.6 - 0.8,
        spark: Math.random(),
        wake: 0,
        resonance: 0,
        renderTrail: 0.6,
        x: 0,
        y: 0,
        px: 0,
        py: 0,
        previousTravel: random,
        active: index < this.profile.base
      };
    }

    setRoute(route) {
      this.route = route || null;
      this.pendingRoute = null;
      this.routeChangeProgress = 1;
      this.routeDirty = true;
      if (this.ctx) this.ctx.clearRect(0, 0, this.width, this.height);
      for (let i = 0; i < this.pool.length; i += 1) {
        const particle = this.pool[i];
        particle.travel = Math.random();
        particle.previousTravel = particle.travel;
        particle.lateral = (Math.random() * 2 - 1) * (particle.layer === 0 ? 0.65 : 0.24);
        particle.phase = Math.random() * Math.PI * 2;
      }
    }

    applyPendingRoute() {
      this.route = this.pendingRoute;
      this.routeDirty = true;
      for (let i = 0; i < this.pool.length; i += 1) {
        const particle = this.pool[i];
        particle.travel = Math.random();
        particle.previousTravel = particle.travel;
        particle.lateral = (Math.random() * 2 - 1) * (particle.layer === 0 ? 1 : 0.68);
      }
    }

    setRisk(risk) {
      // The app still feeds a single risk number, but it now drives TWO
      // separate channels:
      //   tension   -> how tightly the water is constrained (motion)
      //   openCount -> how many futures are still open (colour)
      const value = clamp(Number(risk) || 0, 0, 100);
      this.riskTarget = value;
      this.tensionTarget = flow.smoothstep(0.15, 0.88, value / 100);
      this.setPossibility(1 + Math.round((this.possibility.count - 1) * this.tensionTarget));
    }

    /* How many branches are still open. 4 = everything still possible,
       1 = committed. Each closing branch fades through grey on its own, so the
       eye sees them go one at a time rather than all at once. */
    setPossibility(openCount) {
      this.openCount = clamp(Math.round(openCount), 1, this.possibility.count);
    }

    /* ---- Risk Tide V2 pointer layer ----------------------------------
       Hover, click and route proximity are strictly visual. None of these
       handlers touch particle position, velocity or the flow field. */
    bindPointer(element) {
      if (!element || this.pointerBound) return;
      this.pointerBound = true;
      const self = this;
      const pointFrom = function (event) {
        const rect = self.canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      };
      element.addEventListener('pointermove', function (event) {
        const point = pointFrom(event);
        if (!point) return;
        // Pointer velocity only tunes how strongly the wake reacts; it never
        // touches a particle's path.
        const stamp = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
        if (self.lastPointerTime) {
          const dtMove = Math.max(16, stamp - self.lastPointerTime);
          const distX = point.x - self.lastPointerX;
          const distY = point.y - self.lastPointerY;
          const speed = Math.sqrt(distX * distX + distY * distY) / dtMove * 1000;
          self.pointerSpeed = self.pointerSpeed * 0.65 + speed * 0.35;
        }
        self.lastPointerX = point.x;
        self.lastPointerY = point.y;
        self.lastPointerTime = stamp;
        self.pointerX = point.x;
        self.pointerY = point.y;
        self.pointerActive = self.wakeRadiusSq > 0 && event.pointerType !== 'touch';
        if (self.resonanceDistance > 0 && self.resonanceCooldown <= 0 && self.isNearRoute(point.x, point.y)) {
          self.triggerResonance();
        }
      }, { passive: true });
      element.addEventListener('pointerleave', function () {
        self.pointerActive = false;
      }, { passive: true });
      // A click/tap ripples; a map drag must not. So the ring only fires when
      // the pointer travelled less than a few pixels between down and up.
      element.addEventListener('pointerdown', function (event) {
        if (self.isInteractiveControl(event.target)) return;
        const point = pointFrom(event);
        if (!point) return;
        self.pressX = point.x;
        self.pressY = point.y;
        self.pressing = true;
      }, { passive: true });
      const endPress = function (event) {
        if (!self.pressing) return;
        self.pressing = false;
        if (self.isInteractiveControl(event.target)) return;
        const point = pointFrom(event);
        if (!point) return;
        const dx = point.x - self.pressX;
        const dy = point.y - self.pressY;
        if (dx * dx + dy * dy > 36) return;
        self.spawnRipple(point.x, point.y);
      };
      element.addEventListener('pointerup', endPress, { passive: true });
      element.addEventListener('pointercancel', function () { self.pressing = false; }, { passive: true });
      this.pointerElement = element;
    }

    isInteractiveControl(target) {
      if (!target || !target.closest) return false;
      return !!target.closest('button, a, input, select, .maplibregl-ctrl, .map-legend, .showcase-overlay');
    }

    spawnRipple(x, y) {
      const life = (this.tideConfig.rippleLife || 1.15);
      const ripple = this.ripples[this.rippleCursor % this.ripples.length];
      this.rippleCursor += 1;
      ripple.active = true;
      ripple.x = x;
      ripple.y = y;
      ripple.age = 0;
      ripple.life = life;
      // A slight, stable irregularity so the ring never reads as a perfect
      // geometric circle (i.e. never like a UI ripple animation).
      ripple.aspect = 0.93 + Math.random() * 0.14;
      ripple.tilt = (Math.random() * 2 - 1) * 0.22;
    }

    triggerResonance() {
      this.resonanceActive = true;
      this.resonanceProgress = 0;
      this.resonanceCooldown = (this.tideConfig.resonanceCooldown || 1.8);
    }

    /* Squared-distance segment test: cheap enough to run on pointermove. */
    isNearRoute(x, y) {
      const points = this.projected;
      if (!points || points.length < 2) return false;
      const threshold = this.resonanceDistance;
      const thresholdSq = threshold * threshold;
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy || 1;
        let t = ((x - a.x) * dx + (y - a.y) * dy) / lenSq;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        const ox = x - (a.x + dx * t);
        const oy = y - (a.y + dy * t);
        if (ox * ox + oy * oy < thresholdSq) return true;
      }
      return false;
    }
    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const cssWidth = Math.max(1, rect.width);
      const cssHeight = Math.max(1, rect.height);
      const dpr = Math.min(global.devicePixelRatio || 1, this.profile.dprCap);
      this.width = cssWidth;
      this.height = cssHeight;
      this.dpr = dpr;
      this.canvas.width = Math.round(cssWidth * dpr);
      this.canvas.height = Math.round(cssHeight * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.routeDirty = true;
    }

    getRouteCoordinates() {
      const route = this.route;
      if (route && route.coordinates && route.coordinates.length >= 2) {
        // Risk Tide V2: the tide flows from the origin toward the destination,
        // so the deadline at the far end is what the water keeps moving to.
        return route.coordinates;
      }
      return [config.endpoints.campus.coordinate, config.endpoints.station.coordinate];
    }

    rebuildProjectedPath() {
      if (!this.map) return;
      const coordinates = this.getRouteCoordinates();
      let projected;
      if (typeof this.map.getScreenPath === 'function') {
        projected = this.map.getScreenPath(coordinates, this.route && this.route.coordinateSystem);
      } else {
        projected = new Array(coordinates.length);
        for (let i = 0; i < coordinates.length; i += 1) {
          const point = this.map.project(coordinates[i]);
          projected[i] = { x: point.x, y: point.y };
        }
      }
      this.projected = projected.filter(function (point) {
        return point && Number.isFinite(point.x) && Number.isFinite(point.y);
      });
      this.buildUniformSamples();
      this.routeDirty = false;
    }

    buildUniformSamples() {
      const points = this.projected;
      if (!points || points.length < 2) return;
      const segmentLengths = new Float64Array(points.length - 1);
      let totalLength = 0;
      for (let i = 0; i < points.length - 1; i += 1) {
        const dx = points[i + 1].x - points[i].x;
        const dy = points[i + 1].y - points[i].y;
        const length = Math.sqrt(dx * dx + dy * dy);
        segmentLengths[i] = length;
        totalLength += length;
      }

      if (totalLength < 1) {
        for (let i = 0; i <= this.sampleCount; i += 1) {
          this.samplesX[i] = points[0].x;
          this.samplesY[i] = points[0].y;
          this.samplesTX[i] = 0;
          this.samplesTY[i] = -1;
        }
        return;
      }

      let segment = 0;
      let segmentStartLength = 0;
      for (let i = 0; i <= this.sampleCount; i += 1) {
        const target = totalLength * i / this.sampleCount;
        while (segment < segmentLengths.length - 1 && segmentStartLength + segmentLengths[segment] < target) {
          segmentStartLength += segmentLengths[segment];
          segment += 1;
        }
        const length = segmentLengths[segment] || 1;
        const t = clamp((target - segmentStartLength) / length, 0, 1);
        const a = points[segment];
        const b = points[segment + 1] || points[segment];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const mag = Math.sqrt(dx * dx + dy * dy) || 1;
        this.samplesX[i] = lerp(a.x, b.x, t);
        this.samplesY[i] = lerp(a.y, b.y, t);
        this.samplesTX[i] = dx / mag;
        this.samplesTY[i] = dy / mag;
      }

      // Smooth the tangent field with a small moving average. Without this the
      // direction snaps at every route node, which reads as a mechanical turn;
      // smoothed, the current bends through corners like water in a channel.
      const tx = this.samplesTX;
      const ty = this.samplesTY;
      const stx = this.smoothTX;
      const sty = this.smoothTY;
      for (let i = 0; i <= this.sampleCount; i += 1) {
        let ax = 0;
        let ay = 0;
        for (let k = -2; k <= 2; k += 1) {
          const j = clamp(i + k, 0, this.sampleCount);
          ax += tx[j];
          ay += ty[j];
        }
        const mag = Math.sqrt(ax * ax + ay * ay) || 1;
        stx[i] = ax / mag;
        sty[i] = ay / mag;
      }
      for (let i = 0; i <= this.sampleCount; i += 1) {
        tx[i] = stx[i];
        ty[i] = sty[i];
      }
    }

    samplePath(travel, out) {
      const t = clamp(travel, 0, 1);
      const exact = t * this.sampleCount;
      const index = Math.min(this.sampleCount - 1, Math.floor(exact));
      const fraction = exact - index;
      const next = index + 1;
      out.x = lerp(this.samplesX[index], this.samplesX[next], fraction);
      out.y = lerp(this.samplesY[index], this.samplesY[next], fraction);
      out.tx = lerp(this.samplesTX[index], this.samplesTX[next], fraction);
      out.ty = lerp(this.samplesTY[index], this.samplesTY[next], fraction);
      return out;
    }

    countFactor(risk) {
      if (risk <= 30) return 0.66 + risk / 30 * 0.18;
      if (risk < 70) return 0.9 + (risk - 30) / 40 * 0.28;
      return 1.2 + (risk - 70) / 30 * 0.3;
    }

    speedFactor(risk) {
      // Taut water moves faster, but only gently (0.86x -> 1.86x). Speed is
      // not the message - tension is.
      const t = flow.smoothstep(0, 1, clamp(risk / 100, 0, 1));
      return 0.86 + t * 1.0;
    }

    updatePerformance(frameMs, delta) {
      this.frameAverage = lerp(this.frameAverage, frameMs, 0.07);
      this.qualityCooldown -= delta;
      if (this.qualityCooldown > 0) return;
      if (this.frameAverage > config.quality.targetFrameMs) {
        this.quality = Math.max(0.78, this.quality - 0.055);
        this.qualityCooldown = 1.1;
      } else if (this.frameAverage < config.quality.recoveryFrameMs && this.quality < 1) {
        this.quality = Math.min(1, this.quality + 0.018);
        this.qualityCooldown = 1.3;
      }
    }

    update(now, delta) {
      const dt = Math.min(delta, 0.05);
      const tide = this.tideConfig;
      const smoothBase = tide.tensionSmoothing !== undefined ? tide.tensionSmoothing : 0.12;
      // Exponential smoothing on deltaTime, so 60 / 120 / 144 Hz share one
      // time constant and the water tightens like weather, not like a switch.
      this.tension = lerp(this.tension, this.tensionTarget, 1 - Math.pow(smoothBase, dt));
      this.risk = lerp(this.risk, this.riskTarget, 1 - Math.pow(smoothBase, dt));

      /* --- possibility: close / reopen branches, then resolve colours ---- */
      const pcount = this.possibility.count;
      const closeSpeed = 1 / Math.max(0.05, this.possibility.closeDuration);
      for (let b = 0; b < pcount; b += 1) {
        const target = b < this.openCount ? 0 : 1;
        const speed = closeSpeed * (0.85 + b * this.possibility.stagger);
        const current = this.branchClose[b];
        if (current < target) this.branchClose[b] = Math.min(target, current + speed * dt);
        else if (current > target) this.branchClose[b] = Math.max(target, current - speed * dt);
      }
      let wr = 0;
      let wg = 0;
      let wb = 0;
      for (let b = 0; b < pcount; b += 1) {
        resolveBranchTone(this.possibility.tones[b], this.branchClose[b], this.possibility, this.branchRGB[b]);
        wr += this.branchRGB[b].r;
        wg += this.branchRGB[b].g;
        wb += this.branchRGB[b].b;
      }
      // The water's overall colour is the mean of the branch tones, so it
      // converges to the surviving colour as branches are absorbed.
      this.waterColor.r = Math.round(wr / pcount);
      this.waterColor.g = Math.round(wg / pcount);
      this.waterColor.b = Math.round(wb / pcount);

      const moving = this.map && this.map.getMoving && this.map.getMoving();
      if (this.routeDirty || (moving && this.elapsed % 0.09 < dt)) {
        this.rebuildProjectedPath();
      }

      if (this.routeChangeProgress < 1) {
        this.routeChangeProgress = Math.min(1, this.routeChangeProgress + dt / 1.15);
        if (this.pendingRoute !== this.route && this.routeChangeProgress >= 0.48) {
          this.applyPendingRoute();
        }
      }

      let visibilityEnvelope = 1;
      if (this.routeChangeProgress < 1) {
        visibilityEnvelope = this.routeChangeProgress < 0.48
          ? clamp(1 - this.routeChangeProgress / 0.48, 0, 1)
          : clamp((this.routeChangeProgress - 0.48) / 0.52, 0, 1);
      }
      const computedDesired = Math.round(this.baseTarget * this.countFactor(this.risk) * this.quality * (moving ? config.quality.movingScale : 1));
      const minimumVisible = this.profile.mobile ? 500 : (this.profile.low ? 950 : 1250);
      const desired = Math.max(minimumVisible, Math.min(this.maxParticles, computedDesired));
      this.activeCount += Math.sign(desired - this.activeCount) * Math.min(18, Math.abs(desired - this.activeCount));

      // Performance budget: when quality drops, thin the background ink cloud
      // first and protect the main current and the surface highlights, because
      // the main current is what makes the route readable.
      const nominal = Math.round(this.baseTarget * this.countFactor(this.risk) * (moving ? config.quality.movingScale : 1));
      const flowQuota = Math.min(Math.round(nominal * 0.35), Math.round(this.activeCount * 0.40));
      const surfQuota = Math.min(Math.round(nominal * 0.15), Math.round(this.activeCount * 0.18));
      const fogQuota = Math.max(0, this.activeCount - flowQuota - surfQuota);
      let seenFog = 0;
      let seenFlow = 0;
      let seenSurf = 0;
      for (let i = 0; i < this.pool.length; i += 1) {
        const p = this.pool[i];
        if (p.layer === 0) p.active = seenFog++ < fogQuota;
        else if (p.layer === 1) p.active = seenFlow++ < flowQuota;
        else p.active = seenSurf++ < surfQuota;
      }

      /* ---- the single dynamic channel: TENSION --------------------------
         slack (0) = wide / slow / varied / long trail
         taut  (1) = narrow / fast / uniform / short trail
         Taut means *constrained*. It is never "messier" - the old
         risk -> chaos mapping is deliberately gone. */
      const tension = this.tension;
      const tensionChannel = pairAt(tide.tensionChannel, tension, 1.6, 0.55);
      const tensionLateral = pairAt(tide.tensionLateral, tension, 1.5, 0.45);
      const tensionCurl = pairAt(tide.tensionCurl, tension, 1.4, 0.6);
      const tensionEddy = pairAt(tide.tensionEddy, tension, 1.2, 0.5);
      const tensionTrail = pairAt(tide.tensionTrail, tension, 1.35, 0.7);
      const tensionShear = pairAt(tide.tensionShear, tension, 1.35, 0.25);
      const shiverAmp = (tide.shiverAmp !== undefined ? tide.shiverAmp : 0.5) * tension;

      // Hover wake: purely visual weight. A quicker pointer pass wakes the
      // water slightly more but lets it settle sooner.
      const speedRatio = clamp(this.pointerSpeed / 900, 0, 1);
      const wakeTarget = (this.wakeRadiusSq > 0 && this.pointerActive)
        ? 1 + speedRatio * (tide.wakeSpeedGain !== undefined ? tide.wakeSpeedGain : 0.22)
        : 0;
      const wakeRate = (tide.wakeFadeSpeed || 7) * (this.pointerActive ? 1 : 1 + speedRatio * 0.6);
      this.wakeStrength = lerp(this.wakeStrength, wakeTarget, 1 - Math.exp(-dt * wakeRate));
      this.pointerSpeed = lerp(this.pointerSpeed, 0, 1 - Math.exp(-dt * 2.2));

      // Route resonance: one short asymmetric wave packet, origin -> destination.
      if (this.resonanceCooldown > 0) this.resonanceCooldown -= dt;
      if (this.resonanceActive) {
        this.resonanceProgress += dt / (tide.resonanceLife || 1.3);
        if (this.resonanceProgress > 1.08) {
          this.resonanceActive = false;
          this.resonanceProgress = 0;
        }
      }
      const resActive = this.resonanceActive;
      const resProgress = this.resonanceProgress;
      const resAhead = tide.resonanceWidth || 0.1;
      const resBehind = tide.resonanceWidthBehind || 0.055;
      const resGain = tide.resonanceGain !== undefined ? tide.resonanceGain : 1;

      const totalLength = this.getPathLength();
      const baseChannel = clamp(totalLength * 0.035, 24, 90) * (this.profile.mobile ? 0.82 : 1);
      const speedFactor = this.speedFactor(this.risk);
      const curlStrength = (this.profile.mobile ? 8 : 11) * tensionCurl * (moving ? 0.55 : 1);
      const channelWidths = tide.channelWidth || { fog: 1.15, flow: 0.5, highlight: 0.3 };
      const driftAmps = tide.lateralAmplitude || { fog: 0.5, flow: 0.22, highlight: 0.11 };
      const trailBaseCfg = tide.trailLength || { fog: 0.85, flow: 1.05, highlight: 1.2 };
      const layerOpacity = tide.layerOpacity || { fog: 0.92, flow: 1, highlight: 0.95 };
      const layerSizeCfg = tide.layerSize || { fog: 0.94, flow: 1, highlight: 0.88 };
      const globalOpacity = tide.globalOpacity !== undefined ? tide.globalOpacity : 1;
      const driftNoiseAmp = tide.driftNoiseAmp !== undefined ? tide.driftNoiseAmp : 0.2;
      const convergeStart = tide.channelConvergeStart !== undefined ? tide.channelConvergeStart : 0.8;
      const convergeAmount = tide.channelConvergeAmount !== undefined ? tide.channelConvergeAmount : 0.5;
      const fadeIn = tide.lifeFadeIn !== undefined ? tide.lifeFadeIn : 0.1;
      const fadeOutStart = tide.lifeFadeOutStart !== undefined ? tide.lifeFadeOutStart : 0.86;
      const modulationAmp = tide.speedModulationAmp !== undefined ? tide.speedModulationAmp : 0.06;
      const pathSample = this.pathSample;
      const curl = this.curlOut;
      const time = this.elapsed;

      for (let i = 0; i < this.activeCount; i += 1) {
        const particle = this.pool[i];
        const layer = particle.layer;
        const layerKey = layer === 0 ? 'fog' : (layer === 1 ? 'flow' : 'highlight');

        /* ---- forward motion: personal bias + very slow modulation ------- */
        const modulation = 1 + Math.sin(time * particle.modFreq + particle.modPhase) * modulationAmp;
        const shear = 1 + (particle.speedBias - 1) * tensionShear;
        const layerSpeed = layer === 0 ? 0.78 : (layer === 1 ? 1.05 : 1.25);
        particle.previousTravel = particle.travel;
        particle.travel += particle.speed * speedFactor * particle.speedBias * modulation * shear * layerSpeed * dt;

        if (particle.travel > 1.02) {
          this.arrivalPulse = Math.min(1, this.arrivalPulse + 0.3);
          particle.travel = -Math.random() * fadeIn;
          particle.lateral = (Math.random() * 2 - 1) * 0.2;
        }

        const progress = clamp(particle.travel, 0, 1);

        /* ---- natural tide: two incommensurate waves + shared noise ------ */
        const waveA = Math.sin(time * particle.tideFreqA + particle.phaseA);
        const waveB = Math.sin(time * particle.tideFreqB + particle.phaseB);
        // A fast micro-tremor that only appears when the water is taut. It is
        // *added* rather than raising the wave frequency, so tightening never
        // causes a phase jump.
        const shiver = Math.sin(time * particle.shiverFreq + particle.phase * 2.3) * shiverAmp;
        const noiseSeed = (particle.flowSeed % 97) * 0.37;
        const noise = flow.noiseUnit(progress * 200 + noiseSeed, particle.phase * 30, (time * 0.3) | 0);
        const lateralDrift = waveA * 0.6 + waveB * 0.4 + noise * driftNoiseAmp;

        // Very slow integrator so neighbouring particles never move as one body.
        particle.lateral += (waveA * 0.4 + waveB * 0.6) * dt * (layer === 0 ? 0.05 : 0.016);
        particle.lateral = clamp(particle.lateral, -0.35, 0.35);

        /* ---- invisible current channel ---------------------------------- */
        // The channel widens slightly with risk ("rising tide") and narrows
        // again near the destination so the water gathers instead of bulging.
        const convergence = 1 - flow.smoothstep(convergeStart, 1, progress) * convergeAmount;
        const channelHalf = baseChannel * channelWidths[layerKey] * tensionChannel * convergence;

        this.samplePath(progress, pathSample);

        /* ---- short-lived local eddies, per-particle ---------------------- */
        const eddy = Math.sin(time * 0.34 + particle.eddySeed + progress * 5.5) * tension * tensionEddy;
        const wobble = particle.wobble * Math.sin(time * 0.47 + particle.phase * 1.7) * (layer === 0 ? 1.6 : 0.7);
        const oscillating = (lateralDrift * 0.55 + eddy * 0.5 + wobble * 0.28 + shiver * 0.2)
          * tensionLateral
          * driftAmps[layerKey];
        const drift = particle.channelOffset + particle.lateralBias + particle.lateral + oscillating;
        // Hard bound keeps the heading route-led even at full tension.
        const bounded = clamp(drift, -1.5, 1.5);
        let x = pathSample.x - pathSample.ty * bounded * channelHalf;
        let y = pathSample.y + pathSample.tx * bounded * channelHalf;

        flow.sample(x, y, time + particle.phase, this.profile.mobile ? 0.0042 : 0.0032, curl);
        const curlScale = layer === 0 ? curlStrength * 0.7 : (layer === 1 ? curlStrength * 0.28 : curlStrength * 0.12);
        x += curl.x * curlScale;
        y += curl.y * curlScale;

        /* ---- hover wake: smooth radial falloff, visual only ------------- */
        let wake = 0;
        if (this.wakeRadiusSq > 0 && this.wakeStrength > 0.01) {
          const dxw = x - this.pointerX;
          const dyw = y - this.pointerY;
          const d2 = dxw * dxw + dyw * dyw;
          if (d2 < this.wakeRadiusSq) {
            const n = 1 - d2 / this.wakeRadiusSq;
            wake = (n * n * (3 - 2 * n)) * this.wakeStrength;
          }
        }
        particle.wake = wake;

        /* ---- route resonance: asymmetric wave packet -------------------- */
        let resonance = 0;
        if (resActive) {
          const dRes = progress - resProgress;
          const width = dRes >= 0 ? resAhead : resBehind;
          if (dRes > -width && dRes < width) {
            const inv = dRes / (width * 0.66);
            resonance = Math.exp(-inv * inv) * resGain;
          }
        }
        particle.resonance = resonance;

        if (particle.previousTravel < particle.travel && Math.abs(particle.travel - particle.previousTravel) < 0.12) {
          particle.px = particle.x || x;
          particle.py = particle.y || y;
        } else {
          particle.px = x;
          particle.py = y;
        }
        particle.x = x;
        particle.y = y;

        /* ---- lifecycle: gentle birth and death, never a pop ------------- */
        const birth = flow.smoothstep(0, fadeIn, progress);
        const death = 1 - flow.smoothstep(fadeOutStart, 1, progress);
        const pulse = 0.9 + Math.sin(time * particle.breathe + particle.phase) * 0.1;
        const wakeGain = 1 + wake * (tide.wakeAlphaGain !== undefined ? tide.wakeAlphaGain : 0.42);
        particle.renderAlpha = particle.alpha * birth * death * pulse * visibilityEnvelope
          * particle.opacityBias * globalOpacity * layerOpacity[layerKey]
          * wakeGain * (1 + resonance * 0.3);
        particle.renderSize = particle.size * particle.sizeBias * layerSizeCfg[layerKey]
          * (0.94 + Math.sin(time * particle.breathe * 0.7 + particle.phase) * 0.08)
          * (1 + wake * (tide.wakeSizeGain !== undefined ? tide.wakeSizeGain : 0.08));

        /* ---- trail: short, tapered, only lightly state-dependent -------- */
        const speedTerm = 1 + clamp(particle.speed / 0.11, 0, 1) * (tide.trailSpeedGain || 0.35);
        particle.renderTrail = clamp(
          trailBaseCfg[layerKey] * particle.trailBias * speedTerm * tensionTrail
            * (1 + wake * (tide.wakeTrailGain || 0.5))
            * (1 + resonance * 0.35),
          0.2,
          2.0
        );

        /* ---- this particle wears the tone of its own possibility ------- */
        const branchRGB = this.branchRGB[particle.branch] || this.branchRGB[0];
        particle.colR = branchRGB.r;
        particle.colG = branchRGB.g;
        particle.colB = branchRGB.b;
      }

      this.arrivalPulse = Math.max(0, this.arrivalPulse - dt * 0.72);

      for (let r = 0; r < this.ripples.length; r += 1) {
        const ripple = this.ripples[r];
        if (!ripple.active) continue;
        ripple.age += dt;
        if (ripple.age >= ripple.life) ripple.active = false;
      }
      this.elapsed += dt;
    }

    getPathLength() {
      if (!this.projected || this.projected.length < 2) return 160;
      let total = 0;
      for (let i = 0; i < this.projected.length - 1; i += 1) {
        const dx = this.projected[i + 1].x - this.projected[i].x;
        const dy = this.projected[i + 1].y - this.projected[i].y;
        total += Math.sqrt(dx * dx + dy * dy);
      }
      return total;
    }

    drawArrivalRing() {
      if (!this.projected || this.projected.length < 2) return;
      const ctx = this.ctx;
      const end = this.projected[this.projected.length - 1];
      const pulse = this.arrivalPulse;
      if (pulse <= 0.02) return;
      const radius = 18 + (1 - pulse) * 72;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(' + this.waterColor.r + ',' + this.waterColor.g + ',' + this.waterColor.b + ',' + (pulse * 0.38) + ')';
      ctx.lineWidth = 1.2 + pulse * 2.4;
      ctx.beginPath();
      ctx.arc(end.x, end.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }


    drawNebulaClouds() {
      if (!this.projected || this.projected.length < 2) return;
      const ctx = this.ctx;
      const count = this.profile.mobile ? 3 : 6;
      const r = this.waterColor.r;
      const g = this.waterColor.g;
      const b = this.waterColor.b;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      for (let i = 0; i < count; i += 1) {
        const t = (i + 0.5) / count;
        const index = Math.min(this.sampleCount, Math.max(0, Math.floor(t * this.sampleCount)));
        const x = this.samplesX[index];
        const y = this.samplesY[index];
        const radius = (this.profile.mobile ? 54 : 84) + Math.sin(this.elapsed * 0.17 + i) * 16;
        const riskTint = 0.045 + this.risk / 100 * 0.075;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',' + riskTint + ')');
        gradient.addColorStop(0.38, 'rgba(' + Math.round(r * 0.65) + ',' + Math.round(g * 0.7) + ',' + Math.round(b * 0.72) + ',' + riskTint * 0.5 + ')');
        gradient.addColorStop(1, 'rgba(2,8,9,0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    drawOriginSource() {
      if (!this.projected || this.projected.length < 2) return;
      const ctx = this.ctx;
      const origin = this.projected[0];
      const pulse = 0.72 + Math.sin(this.elapsed * 1.1) * 0.18;
      const radius = (this.profile.mobile ? 28 : 42) * pulse;
      const r = this.waterColor.r;
      const g = this.waterColor.g;
      const b = this.waterColor.b;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const halo = ctx.createRadialGradient(origin.x, origin.y, 0, origin.x, origin.y, radius);
      halo.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',0.15)');
      halo.addColorStop(0.35, 'rgba(' + r + ',' + g + ',' + b + ',0.06)');
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(origin.x - radius, origin.y - radius, radius * 2, radius * 2);
      ctx.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',0.24)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, radius * 0.38, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    /* Soft, restrained water-surface feedback: two slightly irregular rings
       travelling at different speeds, the second arriving a beat later.
       Ink on paper rather than an emitting UI ripple. */
    drawRipples() {
      const ctx = this.ctx;
      const tide = this.tideConfig;
      const radiusBase = tide.rippleRadius || 86;
      const widthBase = tide.rippleWidth || 1.1;
      const alphaBase = tide.rippleAlpha !== undefined ? tide.rippleAlpha : 0.19;
      const delay = tide.rippleDelay !== undefined ? tide.rippleDelay : 0.11;
      const r = this.waterColor.r;
      const g = this.waterColor.g;
      const b = this.waterColor.b;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineCap = 'round';
      for (let i = 0; i < this.ripples.length; i += 1) {
        const ripple = this.ripples[i];
        if (!ripple.active) continue;
        const life = ripple.life || 1.15;
        for (let ring = 0; ring < 2; ring += 1) {
          const age = ripple.age - ring * delay;
          if (age <= 0) continue;
          const p = clamp(age / (life * (ring === 0 ? 1 : 0.82)), 0, 1);
          if (p >= 1) continue;
          const alpha = (1 - p) * (1 - p) * alphaBase * (ring === 0 ? 1 : 0.62);
          if (alpha <= 0.004) continue;
          const radius = 7 + p * radiusBase * (ring === 0 ? 1 : 0.72);
          ctx.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
          ctx.lineWidth = Math.max(0.5, widthBase * (1 - p * 0.6) * (ring === 0 ? 1 : 0.75));
          ctx.beginPath();
          ctx.ellipse(ripple.x, ripple.y, radius, radius * ripple.aspect, ripple.tilt, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    /* A short asymmetric wave packet travelling origin -> destination.
       Slightly brighter at its leading edge, decaying quickly behind it, and
       always confined to one short stretch of the route. */
    drawResonanceBand() {
      if (!this.resonanceActive || !this.projected || this.projected.length < 2) return;
      const ctx = this.ctx;
      const tide = this.tideConfig;
      const ahead = tide.resonanceWidth || 0.1;
      const behind = tide.resonanceWidthBehind || 0.055;
      const progress = this.resonanceProgress;
      if (progress < -behind || progress > 1 + ahead) return;
      const fade = clamp(Math.min(progress / 0.08, (1.06 - progress) / 0.16), 0, 1);
      if (fade <= 0.01) return;
      const alphaBase = (tide.resonanceBandAlpha !== undefined ? tide.resonanceBandAlpha : 0.12) * fade;
      const steps = this.profile.mobile ? 4 : 7;
      const r = this.waterColor.r;
      const g = this.waterColor.g;
      const b = this.waterColor.b;
      const sample = this.bandSample;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let pass = 0; pass < 2; pass += 1) {
        const wide = pass === 0;
        // The crest sits slightly forward of the wash, so the packet reads as
        // moving water instead of a scanning highlight.
        const start = progress - behind * (wide ? 1 : 0.55);
        const end = progress + ahead * (wide ? 0.85 : 1);
        ctx.beginPath();
        let started = false;
        for (let i = 0; i <= steps; i += 1) {
          const t = start + (end - start) * (i / steps);
          if (t < 0 || t > 1) { started = false; continue; }
          this.samplePath(t, sample);
          if (!started) { ctx.moveTo(sample.x, sample.y); started = true; }
          else ctx.lineTo(sample.x, sample.y);
        }
        if (wide) {
          ctx.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + alphaBase * 0.4 + ')';
          ctx.lineWidth = this.profile.mobile ? 8 : 13;
        } else {
          ctx.strokeStyle = 'rgba(' + Math.min(255, r + 38) + ',' + Math.min(255, g + 38) + ',' + Math.min(255, b + 32) + ',' + alphaBase + ')';
          ctx.lineWidth = 2.4;
        }
        ctx.stroke();
      }
      ctx.restore();
    }
    draw() {
      const ctx = this.ctx;
      const fade = this.profile.mobile ? 0.24 : 0.138;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,' + fade + ')';
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.restore();

      this.drawNebulaClouds();
      this.drawOriginSource();
      this.drawResonanceBand();

      const moving = this.map && this.map.getMoving && this.map.getMoving();
      const movingAlpha = moving ? 0.7 : 1;
      const trailSegments = (this.tideConfig && this.tideConfig.trailSegments) || { fog: 2, flow: 3, highlight: 2 };
      const r = this.waterColor.r;
      const g = this.waterColor.g;
      const b = this.waterColor.b;

      for (let layer = 0; layer < 3; layer += 1) {
        const isFog = layer === 0;
        ctx.save();
        ctx.globalCompositeOperation = isFog ? 'source-over' : 'lighter';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        for (let i = 0; i < this.activeCount; i += 1) {
          const particle = this.pool[i];
          if (particle.layer !== layer || particle.renderAlpha <= 0.005) continue;
          const alpha = particle.renderAlpha * movingAlpha;
          const size = (particle.renderSize || particle.size) * (moving ? 0.82 : 1);
          // Each particle wears the tone of the possibility it belongs to, so
          // several futures are visible at once as layers of one current.
          const cr = particle.colR !== undefined ? particle.colR : r;
          const cg = particle.colG !== undefined ? particle.colG : g;
          const cb = particle.colB !== undefined ? particle.colB : b;
          const tint = particle.spark * 0.18;
          const pr = Math.round(lerp(cr, 247, tint));
          const pg = Math.round(lerp(cg, 250, tint));
          const pb = Math.round(lerp(cb, 238, tint));
          const vx = particle.x - particle.px;
          const vy = particle.y - particle.py;
          const tail = (particle.renderTrail || 0.6) * (moving ? 0.82 : 1);
          const layerKey = layer === 0 ? 'fog' : (layer === 1 ? 'flow' : 'highlight');
          const segments = trailSegments[layerKey] || 2;
          const vMag = Math.sqrt(vx * vx + vy * vy) || 1;

          // One soft wide pass first: this is the water body that carries the
          // current, and it keeps the flow readable without long trails.
          if (!isFog && this.tideConfig.softPass !== false) {
            const softAlpha = alpha * 0.32;
            if (softAlpha > 0.004) {
              ctx.beginPath();
              ctx.moveTo(particle.x - vx * tail, particle.y - vy * tail);
              ctx.lineTo(particle.x, particle.y);
              ctx.strokeStyle = 'rgba(' + pr + ',' + pg + ',' + pb + ',' + softAlpha + ')';
              ctx.lineWidth = Math.max(0.32, size * 0.95);
              ctx.stroke();
            }
          }

          // Tapered trail: crisp near the head, falling away quickly behind.
          // A cheap approximation of a per-particle gradient that allocates
          // nothing inside the frame loop.
          for (let s = segments; s >= 1; s -= 1) {
            const t0 = (s - 1) / segments;
            const t1 = s / segments;
            const weight = 1 - t0;
            const segAlpha = alpha * weight * weight * (isFog ? 0.95 : 0.85);
            if (segAlpha <= 0.004) continue;
            ctx.beginPath();
            ctx.moveTo(particle.x - vx * tail * t0, particle.y - vy * tail * t0);
            ctx.lineTo(particle.x - vx * tail * t1, particle.y - vy * tail * t1);
            ctx.strokeStyle = isFog
              ? 'rgba(1,6,7,' + segAlpha + ')'
              : 'rgba(' + pr + ',' + pg + ',' + pb + ',' + segAlpha + ')';
            ctx.lineWidth = Math.max(0.2, size * (isFog ? 1.1 : 0.78) * (0.4 + weight * 0.6));
            ctx.stroke();
          }

          if (isFog) {
            // Ink-cloud head: a soft tinted dot, not a spark.
            ctx.fillStyle = 'rgba(' + Math.round(cr * 0.45) + ',' + Math.round(cg * 0.7) + ',' + Math.round(cb * 0.76) + ',' + Math.min(0.36, alpha * 0.72) + ')';
            ctx.beginPath();
            ctx.arc(particle.x, particle.y, Math.max(0.14, size * 0.34), 0, Math.PI * 2);
            ctx.fill();
          } else if (layer === 1) {
            ctx.fillStyle = 'rgba(' + Math.min(255, pr + 22) + ',' + Math.min(255, pg + 20) + ',' + Math.min(255, pb + 14) + ',' + alpha * 0.5 + ')';
            ctx.beginPath();
            ctx.arc(particle.x, particle.y, Math.max(0.16, size * 0.3), 0, Math.PI * 2);
            ctx.fill();
          } else {
            // Surface layer: a small catch-light stretched along the flow.
            // Deliberately not a star or sparkle shape.
            if (!this.profile.mobile && !this.profile.low) {
              ctx.shadowBlur = this.risk > 85 ? 3 : 2;
              ctx.shadowColor = 'rgba(' + pr + ',' + pg + ',' + pb + ',0.46)';
            }
            const stretch = size * (0.5 + particle.spark * 0.35);
            ctx.fillStyle = 'rgba(' + Math.min(255, cr + 46) + ',' + Math.min(255, cg + 42) + ',' + Math.min(255, cb + 34) + ',' + Math.min(0.9, alpha * 1.05) + ')';
            ctx.beginPath();
            ctx.arc(particle.x + vx / vMag * stretch, particle.y + vy / vMag * stretch, Math.max(0.16, size * 0.26), 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
          }
        }
        ctx.restore();
      }

      this.drawArrivalRing();
      this.drawRipples();
    }
    frame(timestamp) {
      if (!this.running) return;
      if (!this.visible) {
        this.lastTime = timestamp;
        global.requestAnimationFrame(this.boundFrame);
        return;
      }
      const deltaMs = this.lastTime ? timestamp - this.lastTime : 16.7;
      this.lastTime = timestamp;
      try {
        this.updatePerformance(deltaMs, Math.min(deltaMs / 1000, 0.05));
        this.update(timestamp / 1000, deltaMs / 1000);
        this.draw();
      } catch (error) {
        this.routeDirty = true;
        if (global.console && console.warn) console.warn('粒子帧已跳过：' + (error && error.message ? error.message : error));
      }
      global.requestAnimationFrame(this.boundFrame);
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.visible = !document.hidden;
      this.lastTime = 0;
      this.boundFrame = this.boundFrame || this.frame.bind(this);
      global.requestAnimationFrame(this.boundFrame);
    }

    stop() {
      this.running = false;
    }

    setVisible(visible) {
      this.visible = visible;
      this.lastTime = 0;
    }

    getMetrics() {
      return {
        active: this.activeCount,
        base: this.baseTarget,
        max: this.maxParticles,
        mobile: this.profile.mobile,
        low: this.profile.low,
        quality: this.quality,
        fpsAverage: Math.round(1000 / Math.max(1, this.frameAverage))
      };
    }
  }

  global.RiskTideParticles = InkParticleSystem;
  global.RiskTideParticleProfile = detectProfile;
})(window);



























































