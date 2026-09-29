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

  function sampleRiskColor(risk, out) {
    const colors = config.colors;
    const value = clamp(risk, 0, 100);
    let a;
    let b;
    let t;
    if (value <= 30) {
      a = colors.safe;
      b = colors.safeBright;
      t = value / 30 * 0.4;
    } else if (value <= 70) {
      a = colors.safe;
      b = colors.gold;
      t = (value - 30) / 40;
    } else {
      a = colors.gold;
      b = colors.danger;
      t = (value - 70) / 30;
    }
    out.r = Math.round(lerp(a[0], b[0], t));
    out.g = Math.round(lerp(a[1], b[1], t));
    out.b = Math.round(lerp(a[2], b[2], t));
    return out;
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
      this.riskColor = { r: config.colors.safe[0], g: config.colors.safe[1], b: config.colors.safe[2] };
      this.targetColor = { r: this.riskColor.r, g: this.riskColor.g, b: this.riskColor.b };
      this.route = null;
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
      this.riskTurbulence = 0;
      this.pointerX = 0;
      this.pointerY = 0;
      this.pointerActive = false;
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
        this.ripples[r] = { active: false, x: 0, y: 0, age: 0, seed: r };
      }
      this.rippleCursor = 0;
      this.bandSample = { x: 0, y: 0, tx: 1, ty: 0 };
      this.pointerBound = false;
      this.pressing = false;
      this.pressX = 0;
      this.pressY = 0;
      this.stormEnergy = 0;
      this.stormCooldown = 1.2;
      this.stormSeed = Math.random() * 1000;
      this.width = 1;
      this.height = 1;
      this.dpr = 1;
      this.sampleCount = this.profile.mobile ? 78 : 132;
      this.samplesX = new Float32Array(this.sampleCount + 1);
      this.samplesY = new Float32Array(this.sampleCount + 1);
      this.samplesTX = new Float32Array(this.sampleCount + 1);
      this.samplesTY = new Float32Array(this.sampleCount + 1);
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
      return {
        layer: layer,
        travel: random,
        lateral: (Math.random() * 2 - 1) * (layer === 0 ? 1.35 : 0.68),
        speed: layer === 0 ? 0.018 + Math.random() * 0.022 : (layer === 1 ? 0.035 + Math.random() * 0.04 : 0.055 + Math.random() * 0.055),
        size: layer === 0 ? 0.16 + Math.random() * 0.28 : (layer === 1 ? 0.28 + Math.random() * 0.45 : 0.42 + Math.random() * 0.55),
        alpha: layer === 0 ? 0.065 + Math.random() * 0.13 : (layer === 1 ? 0.3 + Math.random() * 0.38 : 0.46 + Math.random() * 0.46),
        phase: Math.random() * Math.PI * 2,
        breathe: 0.75 + Math.random() * 0.65,
        drift: (Math.random() * 2 - 1) * 46,
        wobble: 0.35 + Math.random() * 1.35,
        scatter: Math.random() * 1.6 - 0.8,
        spark: Math.random(),
        // --- Risk Tide V2 per-particle seeds ---------------------------
        // Two incommensurate wave frequencies plus this particle's own phase
        // keep the lateral drift from ever reading as one mechanical sway.
        tideFreqA: lerp(0.055, 0.115, Math.random()),
        tideFreqB: lerp(0.019, 0.043, Math.random()),
        tidePhaseA: Math.random() * Math.PI * 2,
        tidePhaseB: Math.random() * Math.PI * 2,
        eddySeed: Math.random() * Math.PI * 2,
        speedSpread: 0.82 + Math.random() * 0.36,
        trailScale: 0.78 + Math.random() * 0.44,
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
      // Only the target is stored here: update() eases toward it, so a slider
      // jump reads as water gradually growing restless instead of a snap.
      this.riskTarget = clamp(Number(risk) || 0, 0, 100);
      sampleRiskColor(this.riskTarget, this.targetColor);
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
      const life = (this.tideConfig.rippleLife || 1.25);
      const ripple = this.ripples[this.rippleCursor % this.ripples.length];
      this.rippleCursor += 1;
      ripple.active = true;
      ripple.x = x;
      ripple.y = y;
      ripple.age = 0;
      ripple.life = life;
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
      if (risk <= 30) return 0.5 + risk / 30 * 0.2;
      if (risk < 70) return 0.8 + (risk - 30) / 40 * 0.3;
      return 1.1 + (risk - 70) / 30 * 0.4;
    }

    speedFactor(risk) {
      // Risk Tide V2: risk is expressed mainly through turbulence, so the
      // global speed ramp stays deliberately gentle (0.86x -> 1.86x).
      const t = flow.smoothstep(0, 1, clamp(risk / 100, 0, 1));
      return 0.86 + t * 1.0;
    }

    updatePerformance(frameMs, delta) {
      this.frameAverage = lerp(this.frameAverage, frameMs, 0.07);
      this.qualityCooldown -= delta;
      if (this.qualityCooldown > 0) return;
      if (this.frameAverage > config.quality.targetFrameMs) {
        this.quality = Math.max(0.72, this.quality - 0.055);
        this.qualityCooldown = 1.1;
      } else if (this.frameAverage < config.quality.recoveryFrameMs && this.quality < 1) {
        this.quality = Math.min(1, this.quality + 0.018);
        this.qualityCooldown = 1.3;
      }
    }

    update(now, delta) {
      const dt = Math.min(delta, 0.05);
      this.risk = lerp(this.risk, this.riskTarget, 1 - Math.pow(0.001, dt));
      this.riskColor.r = Math.round(lerp(this.riskColor.r, this.targetColor.r, 1 - Math.pow(0.018, dt)));
      this.riskColor.g = Math.round(lerp(this.riskColor.g, this.targetColor.g, 1 - Math.pow(0.018, dt)));
      this.riskColor.b = Math.round(lerp(this.riskColor.b, this.targetColor.b, 1 - Math.pow(0.018, dt)));

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
      const minimumVisible = this.profile.mobile ? 420 : 900;
      const desired = Math.max(minimumVisible, Math.min(this.maxParticles, computedDesired));
      this.activeCount += Math.sign(desired - this.activeCount) * Math.min(18, Math.abs(desired - this.activeCount));
      for (let i = 0; i < this.pool.length; i += 1) {
        this.pool[i].active = i < this.activeCount;
      }

      const tide = this.tideConfig;
      const riskNorm = clamp(this.risk / 100, 0, 1);
      // Risk is expressed as turbulence, eased so low risk stays calm and the
      // instability only becomes obvious from the mid range upward.
      const riskTurbulence = flow.smoothstep(
        tide.turbulenceLowEdge !== undefined ? tide.turbulenceLowEdge : 0.16,
        tide.turbulenceHighEdge !== undefined ? tide.turbulenceHighEdge : 0.92,
        riskNorm
      );
      this.riskTurbulence = riskTurbulence;

      // Hover wake is purely visual weight; it never touches trajectory.
      const wakeTarget = (this.wakeRadiusSq > 0 && this.pointerActive) ? 1 : 0;
      this.wakeStrength = lerp(this.wakeStrength, wakeTarget, 1 - Math.exp(-dt * (tide.wakeSmoothRate || 6.5)));

      // Route resonance: one short wave packet travelling origin -> destination.
      if (this.resonanceCooldown > 0) this.resonanceCooldown -= dt;
      if (this.resonanceActive) {
        this.resonanceProgress += dt / (tide.resonanceLife || 2.4);
        if (this.resonanceProgress > 1.12) {
          this.resonanceActive = false;
          this.resonanceProgress = 0;
        }
      }
      const resActive = this.resonanceActive;
      const resProgress = this.resonanceProgress;
      const resWidth = (tide.resonanceWidth || 0.115) * 3;

      const totalLength = this.getPathLength();
      const routeWidth = clamp(totalLength * 0.035, 24, 90) * (this.profile.mobile ? 0.82 : 1);
      const speedFactor = this.speedFactor(this.risk);
      const curlStrength = (this.profile.mobile ? 8 : 11)
        * (0.7 + riskTurbulence * (tide.turbulenceCurlGain || 2.4))
        * (moving ? 0.55 : 1);
      const driftAmps = tide.driftAmplitude || { fog: 0.5, flow: 0.22, highlight: 0.11 };
      const trailBase = tide.trailLength || { fog: 0.5, flow: 0.66, highlight: 0.78 };
      const driftNoiseAmp = tide.driftNoiseAmp !== undefined ? tide.driftNoiseAmp : 0.22;
      const turbulenceDriftGain = tide.turbulenceDriftGain !== undefined ? tide.turbulenceDriftGain : 2.1;
      const eddyGain = tide.turbulenceEddyGain !== undefined ? tide.turbulenceEddyGain : 1.35;
      const speedSpreadGain = tide.turbulenceSpeedSpread !== undefined ? tide.turbulenceSpeedSpread : 0.9;
      const pathSample = this.pathSample;
      const curl = this.curlOut;
      const time = this.elapsed;

      for (let i = 0; i < this.activeCount; i += 1) {
        const particle = this.pool[i];
        const layer = particle.layer;
        const pulse = 0.86 + Math.sin(time * particle.breathe + particle.phase) * 0.14;
        const mechanicalBreak = 0.88 + Math.sin(time * 0.73 + particle.phase) * 0.12;
        const layerSpeed = layer === 0 ? 0.78 : (layer === 1 ? 1.05 : 1.25);
        // Per-particle speed differences widen with turbulence, so rising risk
        // shears the current instead of simply moving everything faster.
        const spread = 1 + (particle.speedSpread - 1) * (1 + riskTurbulence * speedSpreadGain);
        particle.previousTravel = particle.travel;
        particle.travel += particle.speed * speedFactor * spread * layerSpeed * mechanicalBreak * dt;

        // Natural tide: two incommensurate low-frequency waves + small noise.
        const waveA = Math.sin(time * particle.tideFreqA + particle.tidePhaseA);
        const waveB = Math.sin(time * particle.tideFreqB + particle.tidePhaseB);
        const noise = flow.noiseUnit(particle.travel * 240, particle.phase * 40, (time * 0.35) | 0);
        const driftAmp = layer === 0 ? driftAmps.fog : (layer === 1 ? driftAmps.flow : driftAmps.highlight);
        const lateralDrift = waveA * 0.6 + waveB * 0.4 + noise * driftNoiseAmp;

        // Slow integrator keeps neighbouring particles separating over time.
        particle.lateral += (waveA * 0.5 + waveB * 0.5) * dt * (layer === 0 ? 0.075 : 0.022);
        particle.lateral = clamp(particle.lateral, -1.5, 1.5);

        if (particle.travel > 1.04) {
          this.arrivalPulse = Math.min(1, this.arrivalPulse + 0.3);
          particle.travel = -Math.random() * 0.12;
          particle.lateral = (Math.random() * 2 - 1) * (layer === 0 ? 1 : 0.68);
          particle.phase = Math.random() * Math.PI * 2;
        }

        this.samplePath(clamp(particle.travel, 0, 1), pathSample);
        const lateralWidth = routeWidth * (layer === 0 ? 1.1 : (layer === 1 ? 0.34 : 0.18));
        // Local eddies: slow per-particle rotation that only appears as the
        // risk ramps. The route stays the dominant direction at every level.
        const eddy = Math.sin(time * 0.42 + particle.eddySeed + particle.travel * 6.0) * riskTurbulence * eddyGain;
        const drift = (particle.lateral + lateralDrift * (1 + riskTurbulence * turbulenceDriftGain)) * lateralWidth
          + eddy * lateralWidth * 0.55;
        const wobble = particle.wobble * Math.sin(time * 0.58 + particle.phase * 1.7) * (layer === 0 ? 2.1 : 0.95);
        let x = pathSample.x - pathSample.ty * (drift + wobble);
        let y = pathSample.y + pathSample.tx * (drift + wobble);

        flow.sample(x, y, time + particle.phase, this.profile.mobile ? 0.0042 : 0.0032, curl);
        const curlScale = layer === 0 ? curlStrength * 0.7 : (layer === 1 ? curlStrength * 0.28 : curlStrength * 0.12);
        x += curl.x * curlScale;
        y += curl.y * curlScale;

        // --- hover wake: brightness / clarity only ------------------------
        let wake = 0;
        if (this.wakeRadiusSq > 0 && this.wakeStrength > 0.01) {
          const dxw = x - this.pointerX;
          const dyw = y - this.pointerY;
          const d2 = dxw * dxw + dyw * dyw;
          if (d2 < this.wakeRadiusSq) {
            const f = 1 - d2 / this.wakeRadiusSq;
            wake = f * f * this.wakeStrength;
          }
        }
        particle.wake = wake;

        // --- route resonance envelope (Gaussian wave packet) --------------
        let resonance = 0;
        if (resActive) {
          const dRes = particle.travel - resProgress;
          if (dRes > -resWidth && dRes < resWidth) {
            const inv = dRes / (resWidth * 0.62);
            resonance = Math.exp(-inv * inv);
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

        let lifeAlpha = 1;
        if (particle.travel < 0) lifeAlpha = clamp(1 + particle.travel / 0.12, 0, 1);
        if (particle.travel > 0.86) lifeAlpha *= clamp((1.04 - particle.travel) / 0.18, 0, 1);
        const wakeGain = 1 + wake * (tide.wakeAlphaGain !== undefined ? tide.wakeAlphaGain : 0.6);
        particle.renderAlpha = particle.alpha * lifeAlpha * pulse * visibilityEnvelope
          * wakeGain * (1 + resonance * 0.35);
        particle.renderSize = particle.size
          * (0.92 + Math.sin(time * particle.breathe * 0.7 + particle.phase) * 0.12)
          * (1 + wake * 0.22);

        // Short, soft water filaments. Speed adds a little length, turbulence
        // and wake a little more, but the cap keeps them from becoming lasers.
        const baseTrail = layer === 0 ? trailBase.fog : (layer === 1 ? trailBase.flow : trailBase.highlight);
        const speedTerm = 1 + clamp(particle.speed / 0.11, 0, 1) * (tide.trailSpeedGain || 0.45);
        particle.renderTrail = clamp(
          baseTrail * particle.trailScale * speedTerm
            * (1 + riskTurbulence * (tide.trailRiskGain || 0.5))
            * (1 + wake * (tide.wakeTrailGain || 0.75))
            * (1 + resonance * 0.45),
          0.2,
          2.2
        );
      }

      this.arrivalPulse = Math.max(0, this.arrivalPulse - dt * 0.72);

      for (let r = 0; r < this.ripples.length; r += 1) {
        const ripple = this.ripples[r];
        if (!ripple.active) continue;
        ripple.age += dt;
        if (ripple.age >= ripple.life) ripple.active = false;
      }
      if (this.risk > 85) {
        this.stormCooldown -= dt;
        if (this.stormCooldown <= 0) {
          this.stormEnergy = 1;
          this.stormCooldown = 1.5 + Math.random() * 2.2;
          this.stormSeed = Math.random() * 1000;
        }
        this.stormEnergy = Math.max(0, this.stormEnergy - dt * 0.78);
      } else {
        this.stormEnergy = Math.max(0, this.stormEnergy - dt * 1.5);
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
      ctx.strokeStyle = 'rgba(' + this.riskColor.r + ',' + this.riskColor.g + ',' + this.riskColor.b + ',' + (pulse * 0.38) + ')';
      ctx.lineWidth = 1.2 + pulse * 2.4;
      ctx.beginPath();
      ctx.arc(end.x, end.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    drawStormBursts() {
      if (this.stormEnergy <= 0.01 || !this.projected || this.projected.length < 2) return;
      const ctx = this.ctx;
      const energy = this.stormEnergy * this.stormEnergy;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const count = this.profile.mobile ? 2 : 4;
      for (let i = 0; i < count; i += 1) {
        const t = ((this.stormSeed + i * 0.23) % 1 + 1) % 1;
        const index = Math.min(this.sampleCount, Math.floor(t * this.sampleCount));
        const x = this.samplesX[index];
        const y = this.samplesY[index];
        const radius = 8 + energy * (18 + i * 5);
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, 'rgba(231,46,42,' + (0.18 * energy) + ')');
        gradient.addColorStop(0.42, 'rgba(124,18,19,' + (0.14 * energy) + ')');
        gradient.addColorStop(1, 'rgba(20,0,0,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
      ctx.restore();
    }

    drawNebulaClouds() {
      if (!this.projected || this.projected.length < 2) return;
      const ctx = this.ctx;
      const count = this.profile.mobile ? 3 : 6;
      const r = this.riskColor.r;
      const g = this.riskColor.g;
      const b = this.riskColor.b;
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
      const r = this.riskColor.r;
      const g = this.riskColor.g;
      const b = this.riskColor.b;
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

    /* Soft, restrained water surface feedback - 1..2 rings per click. */
    drawRipples() {
      const ctx = this.ctx;
      const tide = this.tideConfig;
      const radiusBase = tide.rippleRadius || 96;
      const widthBase = tide.rippleWidth || 1.4;
      const alphaBase = tide.rippleAlpha !== undefined ? tide.rippleAlpha : 0.3;
      const r = this.riskColor.r;
      const g = this.riskColor.g;
      const b = this.riskColor.b;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (let i = 0; i < this.ripples.length; i += 1) {
        const ripple = this.ripples[i];
        if (!ripple.active) continue;
        const p = clamp(ripple.age / (ripple.life || 1.25), 0, 1);
        const alpha = (1 - p) * (1 - p) * alphaBase;
        if (alpha <= 0.004) continue;
        ctx.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
        ctx.lineWidth = Math.max(0.6, widthBase * (1 - p * 0.55));
        ctx.beginPath();
        ctx.arc(ripple.x, ripple.y, 8 + p * radiusBase, 0, Math.PI * 2);
        ctx.stroke();
        if (p > 0.18) {
          const p2 = (p - 0.18) / 0.82;
          const alpha2 = (1 - p2) * (1 - p2) * alphaBase * 0.5;
          if (alpha2 > 0.004) {
            ctx.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha2 + ')';
            ctx.lineWidth = Math.max(0.5, widthBase * 0.7 * (1 - p2 * 0.5));
            ctx.beginPath();
            ctx.arc(ripple.x, ripple.y, 6 + p2 * radiusBase * 0.7, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    }

    /* A short wave packet travelling origin -> destination along the route. */
    drawResonanceBand() {
      if (!this.resonanceActive || !this.projected || this.projected.length < 2) return;
      const ctx = this.ctx;
      const tide = this.tideConfig;
      const width = tide.resonanceWidth || 0.115;
      const progress = this.resonanceProgress;
      if (progress < -width || progress > 1 + width) return;
      const fade = clamp(Math.min(progress / 0.1, (1.08 - progress) / 0.2), 0, 1);
      if (fade <= 0.01) return;
      const alphaBase = (tide.resonanceBandAlpha !== undefined ? tide.resonanceBandAlpha : 0.16) * fade;
      const steps = this.profile.mobile ? 5 : 8;
      const r = this.riskColor.r;
      const g = this.riskColor.g;
      const b = this.riskColor.b;
      const sample = this.bandSample;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let pass = 0; pass < 2; pass += 1) {
        let started = false;
        ctx.beginPath();
        for (let i = 0; i <= steps; i += 1) {
          const t = progress - width + (width * 2) * (i / steps);
          if (t < 0 || t > 1) { started = false; continue; }
          this.samplePath(t, sample);
          if (!started) { ctx.moveTo(sample.x, sample.y); started = true; }
          else ctx.lineTo(sample.x, sample.y);
        }
        if (pass === 0) {
          ctx.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + alphaBase * 0.45 + ')';
          ctx.lineWidth = this.profile.mobile ? 10 : 16;
        } else {
          ctx.strokeStyle = 'rgba(' + Math.min(255, r + 42) + ',' + Math.min(255, g + 42) + ',' + Math.min(255, b + 38) + ',' + alphaBase + ')';
          ctx.lineWidth = 3.2;
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
      this.drawStormBursts();
      this.drawResonanceBand();

      const moving = this.map && this.map.getMoving && this.map.getMoving();
      const movingAlpha = moving ? 0.7 : 1;
      const r = this.riskColor.r;
      const g = this.riskColor.g;
      const b = this.riskColor.b;

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
          const tint = particle.spark * 0.28;
          const pr = Math.round(lerp(r, 247, tint));
          const pg = Math.round(lerp(g, 250, tint));
          const pb = Math.round(lerp(b, 238, tint));
          const vx = particle.x - particle.px;
          const vy = particle.y - particle.py;
          const tail = (particle.renderTrail || 0.6) * (moving ? 0.82 : 1);
          const tailX = particle.x - vx * tail;
          const tailY = particle.y - vy * tail;

          ctx.beginPath();
          ctx.moveTo(tailX, tailY);
          ctx.lineTo(particle.x, particle.y);

          if (isFog) {
            ctx.strokeStyle = 'rgba(1,6,7,' + alpha * 0.86 + ')';
            ctx.lineWidth = Math.max(0.48, size * 1.35);
            ctx.stroke();
            ctx.strokeStyle = 'rgba(' + Math.round(r * 0.34) + ',' + Math.round(g * 0.7) + ',' + Math.round(b * 0.78) + ',' + Math.min(0.3, alpha * 0.92) + ')';
            ctx.lineWidth = Math.max(0.2, size * 0.56);
            ctx.stroke();
            ctx.strokeStyle = 'rgba(' + Math.round(r * 0.62) + ',' + Math.round(g * 0.88) + ',' + Math.round(b * 0.9) + ',' + Math.min(0.22, alpha * 0.58) + ')';
            ctx.lineWidth = Math.max(0.12, size * 0.26);
            ctx.stroke();
            ctx.fillStyle = 'rgba(' + Math.round(r * 0.42) + ',' + Math.round(g * 0.68) + ',' + Math.round(b * 0.74) + ',' + Math.min(0.2, alpha * 0.42) + ')';
            ctx.beginPath();
            ctx.arc(particle.x, particle.y, Math.max(0.12, size * 0.3), 0, Math.PI * 2);
            ctx.fill();
          } else if (layer === 1) {
            ctx.strokeStyle = 'rgba(' + pr + ',' + pg + ',' + pb + ',' + alpha * 0.2 + ')';
            ctx.lineWidth = Math.max(0.32, size * 0.92);
            ctx.stroke();
            ctx.strokeStyle = 'rgba(' + pr + ',' + pg + ',' + pb + ',' + alpha + ')';
            ctx.lineWidth = Math.max(0.28, size * 0.52);
            ctx.stroke();
            ctx.fillStyle = 'rgba(' + Math.min(255, pr + 28) + ',' + Math.min(255, pg + 24) + ',' + Math.min(255, pb + 18) + ',' + alpha * 0.58 + ')';
            ctx.beginPath();
            ctx.arc(particle.x, particle.y, Math.max(0.16, size * 0.28), 0, Math.PI * 2);
            ctx.fill();
          } else {
            const highlight = r + 58;
            const highlightG = g + 48;
            const highlightB = b + 38;
            if (!this.profile.mobile && !this.profile.low) {
              ctx.shadowBlur = this.risk > 85 ? 5 : 3;
              ctx.shadowColor = 'rgba(' + pr + ',' + pg + ',' + pb + ',0.72)';
            }
            ctx.strokeStyle = 'rgba(' + pr + ',' + pg + ',' + pb + ',' + alpha * 0.2 + ')';
            ctx.lineWidth = Math.max(0.4, size * 1.05);
            ctx.stroke();
            ctx.strokeStyle = 'rgba(' + Math.min(255, highlight) + ',' + Math.min(255, highlightG) + ',' + Math.min(255, highlightB) + ',' + Math.min(0.98, alpha * 1.24) + ')';
            ctx.lineWidth = Math.max(0.34, size * 0.62);
            ctx.stroke();
            ctx.shadowBlur = 0;

            const cross = size * (this.risk > 85 ? 2.0 : 1.35) * (0.86 + particle.spark * 0.34);
            ctx.strokeStyle = 'rgba(' + Math.min(255, highlight) + ',' + Math.min(255, highlightG) + ',' + Math.min(255, highlightB) + ',' + alpha * 0.82 + ')';
            ctx.lineWidth = 0.26;
            ctx.beginPath();
            ctx.moveTo(particle.x - cross, particle.y);
            ctx.lineTo(particle.x + cross, particle.y);
            ctx.moveTo(particle.x, particle.y - cross);
            ctx.lineTo(particle.x, particle.y + cross);
            ctx.stroke();
            ctx.fillStyle = 'rgba(244,255,251,' + alpha * 0.86 + ')';
            ctx.beginPath();
            ctx.arc(particle.x, particle.y, Math.max(0.14, size * 0.18), 0, Math.PI * 2);
            ctx.fill();
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





























