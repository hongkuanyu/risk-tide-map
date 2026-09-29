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
      this.campusPulse = 0;
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
        size: layer === 0 ? 0.5 + Math.random() * 0.8 : (layer === 1 ? 0.9 + Math.random() * 1.25 : 1.2 + Math.random() * 1.8),
        alpha: layer === 0 ? 0.08 + Math.random() * 0.16 : (layer === 1 ? 0.34 + Math.random() * 0.42 : 0.5 + Math.random() * 0.5),
        phase: Math.random() * Math.PI * 2,
        breathe: 0.75 + Math.random() * 0.65,
        drift: (Math.random() * 2 - 1) * 46,
        wobble: 0.35 + Math.random() * 1.35,
        scatter: Math.random() * 1.6 - 0.8,
        spark: Math.random(),
        trail: layer === 0 ? 1.75 : (layer === 1 ? 1.42 : 1.85),
        x: 0,
        y: 0,
        px: 0,
        py: 0,
        previousTravel: random,
        active: index < this.profile.base
      };
    }

    setRoute(route) {
      this.pendingRoute = route || null;
      this.routeChangeProgress = 0;
      this.routeDirty = true;
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
      this.riskTarget = clamp(Number(risk) || 0, 0, 100);
      sampleRiskColor(this.riskTarget, this.targetColor);
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
        return route.coordinates.slice().reverse();
      }
      return [config.endpoints.station.coordinate, config.endpoints.campus.coordinate];
    }

    rebuildProjectedPath() {
      if (!this.map) return;
      const coordinates = this.getRouteCoordinates();
      const projected = new Array(coordinates.length);
      for (let i = 0; i < coordinates.length; i += 1) {
        const point = this.map.project(coordinates[i]);
        projected[i] = { x: point.x, y: point.y };
      }
      this.projected = projected;
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
      if (risk <= 30) return 0.52 + risk / 30 * 0.34;
      if (risk < 70) return 0.9 + (risk - 30) / 40 * 1.2;
      return 2.1 + (risk - 70) / 30 * 1.25;
    }

    updatePerformance(frameMs, delta) {
      this.frameAverage = lerp(this.frameAverage, frameMs, 0.07);
      this.qualityCooldown -= delta;
      if (this.qualityCooldown > 0) return;
      if (this.frameAverage > config.quality.targetFrameMs) {
        this.quality = Math.max(0.52, this.quality - 0.055);
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
      const desired = Math.min(
        this.maxParticles,
        Math.round(this.baseTarget * this.countFactor(this.risk) * this.quality * (moving ? config.quality.movingScale : 1))
      );
      this.activeCount += Math.sign(desired - this.activeCount) * Math.min(18, Math.abs(desired - this.activeCount));
      for (let i = 0; i < this.pool.length; i += 1) {
        this.pool[i].active = i < this.activeCount;
      }

      const totalLength = this.getPathLength();
      const routeWidth = clamp(totalLength * 0.052, 26, 150) * (this.profile.mobile ? 0.72 : 1);
      const speedFactor = this.speedFactor(this.risk);
      const curlStrength = (this.profile.mobile ? 17 : 25) * (1 + this.risk / 100 * 1.65) * (moving ? 0.62 : 1);
      const pathSample = this.pathSample;
      const curl = this.curlOut;

      for (let i = 0; i < this.activeCount; i += 1) {
        const particle = this.pool[i];
        const layer = particle.layer;
        const pulse = 0.86 + Math.sin(this.elapsed * particle.breathe + particle.phase) * 0.14;
        const mechanicalBreak = 0.88 + Math.sin(this.elapsed * 0.73 + particle.phase) * 0.12;
        const layerSpeed = layer === 0 ? 0.78 : (layer === 1 ? 1.05 : 1.25);
        particle.previousTravel = particle.travel;
        particle.travel += particle.speed * speedFactor * layerSpeed * mechanicalBreak * dt;
        particle.lateral += Math.sin(this.elapsed * 0.18 + particle.phase * 1.3) * dt * (layer === 0 ? 0.075 : 0.022);
        particle.lateral = clamp(particle.lateral, -1.5, 1.5);
        if (particle.travel > 1.04) {
          this.campusPulse = Math.min(1, this.campusPulse + 0.3);
          particle.travel = -Math.random() * 0.12;
          particle.lateral = (Math.random() * 2 - 1) * (layer === 0 ? 1 : 0.68);
          particle.phase = Math.random() * Math.PI * 2;
        }

        this.samplePath(clamp(particle.travel, 0, 1), pathSample);
        const lateralWidth = routeWidth * (layer === 0 ? 1.65 : (layer === 1 ? 0.74 : 0.36));
        const lateralPixels = particle.lateral * lateralWidth + particle.drift * Math.sin(this.elapsed * 0.24 + particle.phase) * 0.22;
        const swirl = particle.wobble * Math.sin(this.elapsed * 0.58 + particle.phase * 1.7) * (layer === 0 ? 4.2 : 1.9);
        let x = pathSample.x - pathSample.ty * (lateralPixels + swirl);
        let y = pathSample.y + pathSample.tx * (lateralPixels + swirl);

        flow.sample(x, y, this.elapsed + particle.phase, this.profile.mobile ? 0.0042 : 0.0032, curl);
        const curlScale = layer === 0 ? curlStrength * 1.18 : (layer === 1 ? curlStrength * 0.62 : curlStrength * 0.28);
        x += curl.x * curlScale;
        y += curl.y * curlScale;

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
        particle.renderAlpha = particle.alpha * lifeAlpha * pulse * visibilityEnvelope;
        particle.renderSize = particle.size * (0.92 + Math.sin(this.elapsed * particle.breathe * 0.7 + particle.phase) * 0.12);
      }

      this.campusPulse = Math.max(0, this.campusPulse - dt * 0.72);
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

    drawCampusRing() {
      if (!this.projected || this.projected.length < 2) return;
      const ctx = this.ctx;
      const end = this.projected[this.projected.length - 1];
      const pulse = this.campusPulse;
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
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, 'rgba(' + Math.round(r * 0.32) + ',' + Math.round(g * 0.38) + ',' + Math.round(b * 0.4) + ',0.055)');
        gradient.addColorStop(0.38, 'rgba(7,28,29,0.035)');
        gradient.addColorStop(1, 'rgba(2,8,9,0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    drawStationSource() {
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

    draw() {
      const ctx = this.ctx;
      const fade = this.profile.mobile ? 0.26 : 0.135;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,' + fade + ')';
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.restore();

      this.drawNebulaClouds();
      this.drawStationSource();
      this.drawStormBursts();

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
          const tail = particle.trail * (moving ? 0.72 : 1);
          const tailX = particle.x - vx * tail;
          const tailY = particle.y - vy * tail;

          ctx.beginPath();
          ctx.moveTo(tailX, tailY);
          ctx.lineTo(particle.x, particle.y);

          if (isFog) {
            ctx.strokeStyle = 'rgba(1,6,7,' + alpha * 0.86 + ')';
            ctx.lineWidth = Math.max(2.2, size * 6.2);
            ctx.stroke();
            ctx.strokeStyle = 'rgba(' + Math.round(r * 0.34) + ',' + Math.round(g * 0.7) + ',' + Math.round(b * 0.78) + ',' + Math.min(0.3, alpha * 0.92) + ')';
            ctx.lineWidth = Math.max(1.1, size * 3.2);
            ctx.stroke();
            ctx.strokeStyle = 'rgba(' + Math.round(r * 0.62) + ',' + Math.round(g * 0.88) + ',' + Math.round(b * 0.9) + ',' + Math.min(0.22, alpha * 0.58) + ')';
            ctx.lineWidth = Math.max(0.36, size * 0.72);
            ctx.stroke();
            ctx.fillStyle = 'rgba(' + Math.round(r * 0.42) + ',' + Math.round(g * 0.68) + ',' + Math.round(b * 0.74) + ',' + Math.min(0.2, alpha * 0.42) + ')';
            ctx.beginPath();
            ctx.arc(particle.x, particle.y, Math.max(0.45, size * 1.15), 0, Math.PI * 2);
            ctx.fill();
          } else if (layer === 1) {
            ctx.strokeStyle = 'rgba(' + pr + ',' + pg + ',' + pb + ',' + alpha * 0.13 + ')';
            ctx.lineWidth = Math.max(0.9, size * 2.25);
            ctx.stroke();
            ctx.strokeStyle = 'rgba(' + pr + ',' + pg + ',' + pb + ',' + alpha + ')';
            ctx.lineWidth = Math.max(0.7, size * 0.92);
            ctx.stroke();
            ctx.fillStyle = 'rgba(' + Math.min(255, pr + 28) + ',' + Math.min(255, pg + 24) + ',' + Math.min(255, pb + 18) + ',' + alpha * 0.58 + ')';
            ctx.beginPath();
            ctx.arc(particle.x, particle.y, Math.max(0.45, size * 0.62), 0, Math.PI * 2);
            ctx.fill();
          } else {
            const highlight = r + 58;
            const highlightG = g + 48;
            const highlightB = b + 38;
            if (!this.profile.mobile && !this.profile.low) {
              ctx.shadowBlur = this.risk > 85 ? 12 : 7;
              ctx.shadowColor = 'rgba(' + pr + ',' + pg + ',' + pb + ',0.72)';
            }
            ctx.strokeStyle = 'rgba(' + pr + ',' + pg + ',' + pb + ',' + alpha * 0.2 + ')';
            ctx.lineWidth = Math.max(1.2, size * 2.65);
            ctx.stroke();
            ctx.strokeStyle = 'rgba(' + Math.min(255, highlight) + ',' + Math.min(255, highlightG) + ',' + Math.min(255, highlightB) + ',' + alpha + ')';
            ctx.lineWidth = Math.max(0.8, size * 1.18);
            ctx.stroke();
            ctx.shadowBlur = 0;

            const cross = size * (this.risk > 85 ? 2.0 : 1.35) * (0.86 + particle.spark * 0.34);
            ctx.strokeStyle = 'rgba(' + Math.min(255, highlight) + ',' + Math.min(255, highlightG) + ',' + Math.min(255, highlightB) + ',' + alpha * 0.82 + ')';
            ctx.lineWidth = 0.75;
            ctx.beginPath();
            ctx.moveTo(particle.x - cross, particle.y);
            ctx.lineTo(particle.x + cross, particle.y);
            ctx.moveTo(particle.x, particle.y - cross);
            ctx.lineTo(particle.x, particle.y + cross);
            ctx.stroke();
            ctx.fillStyle = 'rgba(244,255,251,' + alpha * 0.86 + ')';
            ctx.beginPath();
            ctx.arc(particle.x, particle.y, Math.max(0.55, size * 0.48), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
      }

      this.drawCampusRing();
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
      this.updatePerformance(deltaMs, Math.min(deltaMs / 1000, 0.05));
      this.update(timestamp / 1000, deltaMs / 1000);
      this.draw();
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






