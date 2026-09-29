/* Risk Tide Particle Flow V2
 * Non-destructive enhancement layer for the existing RiskTideParticles engine.
 * Load AFTER js/particles.js and BEFORE js/app.js.
 */
(function (global) {
  'use strict';

  const Base = global.RiskTideParticles;
  if (!Base || Base.__riskTideV2) return;

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(a, b, x) {
    const t = clamp((x - a) / Math.max(0.0001, b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  class RiskTideParticlesV2 extends Base {
    constructor(canvas, mapController) {
      super(canvas, mapController);

      this.pointer = { x: -9999, y: -9999, active: false, wake: 0 };
      this.ripples = [];
      this.routeResonance = { active: false, t: 0, energy: 0 };
      this.resonanceCooldown = 0;
      this._v2Bound = [];

      // Keep map gestures intact: observe events without capturing them.
      const target = canvas.parentElement || canvas;
      this._listen(target, 'pointermove', (e) => this._onPointerMove(e), { passive: true });
      this._listen(target, 'pointerenter', () => { this.pointer.active = true; }, { passive: true });
      this._listen(target, 'pointerleave', () => { this.pointer.active = false; }, { passive: true });
      this._listen(target, 'pointerdown', (e) => this._onPointerDown(e), { passive: true });
    }

    _listen(node, type, fn, opts) {
      node.addEventListener(type, fn, opts);
      this._v2Bound.push([node, type, fn, opts]);
    }

    _localPoint(e) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    _onPointerMove(e) {
      const p = this._localPoint(e);
      this.pointer.x = p.x;
      this.pointer.y = p.y;
      this.pointer.active = true;

      // D · Route resonance: approaching the route sends one restrained wave
      // toward the destination. It has a cooldown so it never becomes noisy.
      if (this.resonanceCooldown <= 0 && this.projected && this.projected.length > 1) {
        const near = this._nearestRouteSample(p.x, p.y);
        if (near.distance < (this.profile.mobile ? 28 : 42)) {
          this.routeResonance.active = true;
          this.routeResonance.t = near.t;
          this.routeResonance.energy = 1;
          this.resonanceCooldown = 1.65;
        }
      }
    }

    _onPointerDown(e) {
      const p = this._localPoint(e);
      // A · Water ripple: visual wave only. It does not repel particles
      // or alter the underlying route flow.
      this.ripples.push({
        x: p.x, y: p.y, age: 0,
        life: this.profile.mobile ? 0.9 : 1.15,
        radius: 8
      });
      if (this.ripples.length > 4) this.ripples.shift();
    }

    _nearestRouteSample(x, y) {
      let best = Infinity, bestIndex = 0;
      const step = this.profile.mobile ? 4 : 3;
      for (let i = 0; i <= this.sampleCount; i += step) {
        const dx = x - this.samplesX[i];
        const dy = y - this.samplesY[i];
        const d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; bestIndex = i; }
      }
      return { distance: Math.sqrt(best), t: bestIndex / this.sampleCount };
    }

    update(now, delta) {
      super.update(now, delta);
      const dt = Math.min(delta, 0.05);

      // B · Wake: smoothly fades in/out. No force is applied to particles.
      const wakeTarget = this.pointer.active ? 1 : 0;
      this.pointer.wake = lerp(this.pointer.wake, wakeTarget, 1 - Math.pow(0.002, dt));

      this.resonanceCooldown = Math.max(0, this.resonanceCooldown - dt);
      if (this.routeResonance.active) {
        // Wave travels from trigger point toward destination.
        this.routeResonance.t += dt * (this.profile.mobile ? 0.42 : 0.34);
        this.routeResonance.energy = Math.max(0, this.routeResonance.energy - dt * 0.42);
        if (this.routeResonance.t > 1.08 || this.routeResonance.energy <= 0.02) {
          this.routeResonance.active = false;
        }
      }

      for (let i = this.ripples.length - 1; i >= 0; i--) {
        const r = this.ripples[i];
        r.age += dt;
        r.radius += dt * (this.profile.mobile ? 74 : 96);
        if (r.age >= r.life) this.ripples.splice(i, 1);
      }

      // Convert "risk" into organic instability rather than only raw speed.
      // The base engine still owns route travel; V2 adds a coherent lateral tide.
      const risk01 = clamp(this.risk / 100, 0, 1);
      const instability = smoothstep(0.22, 0.92, risk01);
      const wakeRadius = this.profile.mobile ? 70 : 105;

      for (let i = 0; i < this.activeCount; i++) {
        const p = this.pool[i];
        if (!p.active) continue;

        // Natural tide: two low-frequency waves prevent mechanical sine motion.
        const waveA = Math.sin(this.elapsed * (0.42 + p.wobble * 0.06) + p.phase * 1.17);
        const waveB = Math.sin(this.elapsed * 0.19 + p.phase * 0.63 + p.travel * 12.0);
        const cross = (waveA * 0.68 + waveB * 0.32);

        // High risk increases lateral disorder, but keeps the route as the anchor.
        const amplitude = (p.layer === 0 ? 6.2 : (p.layer === 1 ? 3.5 : 2.0))
          * (0.45 + instability * 1.45);
        const sample = this.pathSample;
        this.samplePath(clamp(p.travel, 0, 1), sample);
        p.x += -sample.ty * cross * amplitude;
        p.y +=  sample.tx * cross * amplitude;

        // Fine eddies only emerge as risk rises.
        if (instability > 0.18) {
          const eddy = Math.sin(this.elapsed * (0.95 + p.spark * 0.7) + p.phase * 2.1);
          const eddyAmp = instability * instability * (p.layer === 0 ? 5.0 : 2.5);
          p.x += -sample.ty * eddy * eddyAmp;
          p.y +=  sample.tx * eddy * eddyAmp;
        }

        // Hover wake changes appearance, not trajectory.
        p.v2Wake = 0;
        if (this.pointer.wake > 0.01) {
          const dx = p.x - this.pointer.x;
          const dy = p.y - this.pointer.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          p.v2Wake = (1 - smoothstep(wakeRadius * 0.28, wakeRadius, d)) * this.pointer.wake;
        }

        // Resonance highlights particles close to the traveling route wave.
        p.v2Resonance = 0;
        if (this.routeResonance.active) {
          const dTravel = Math.abs(p.travel - this.routeResonance.t);
          p.v2Resonance = (1 - smoothstep(0.015, 0.09, dTravel)) * this.routeResonance.energy;
        }

        // Keep previous point compatible with the new lateral tide.
        // Blend instead of snapping, preserving elegant short trails.
        const trailBoost = 1 + (p.v2Wake || 0) * 1.15 + (p.v2Resonance || 0) * 0.8;
        p.v2TrailBoost = trailBoost;
        p.v2AlphaBoost = 1 + (p.v2Wake || 0) * 0.55 + (p.v2Resonance || 0) * 0.72;
      }
    }

    draw() {
      // Draw base flow first.
      super.draw();

      const ctx = this.ctx;
      if (!ctx) return;

      // B · Wake overlay: redraw only nearby particles with longer, clearer tails.
      // Bounded work: stride increases on mobile/low quality.
      if (this.pointer.wake > 0.015) {
        const stride = this.profile.mobile || this.profile.low ? 3 : 2;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        for (let i = 0; i < this.activeCount; i += stride) {
          const p = this.pool[i];
          const w = p.v2Wake || 0;
          if (w < 0.035 || p.renderAlpha <= 0.005) continue;
          const vx = p.x - p.px, vy = p.y - p.py;
          const boost = p.v2TrailBoost || 1;
          const tx = p.x - vx * (2.2 + boost * 2.8);
          const ty = p.y - vy * (2.2 + boost * 2.8);
          const a = Math.min(0.58, p.renderAlpha * w * 0.78);
          ctx.strokeStyle = 'rgba(236,255,249,' + a + ')';
          ctx.lineWidth = Math.max(0.28, (p.renderSize || p.size) * 0.48);
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }
        ctx.restore();
      }

      this._drawRouteResonance();
      this._drawRipples();
    }

    _drawRouteResonance() {
      const wave = this.routeResonance;
      if (!wave.active || !this.projected || this.projected.length < 2) return;
      const ctx = this.ctx;
      const center = clamp(wave.t, 0, 1) * this.sampleCount;
      const span = this.profile.mobile ? 8 : 12;
      const r = this.riskColor.r, g = this.riskColor.g, b = this.riskColor.b;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';

      // A small moving packet, not a whole-route flash.
      for (let band = 0; band < 3; band++) {
        const offset = band * 3.2;
        const start = Math.max(0, Math.floor(center - span - offset));
        const end = Math.min(this.sampleCount, Math.ceil(center + span - offset));
        if (end <= start) continue;
        const alpha = wave.energy * (0.15 - band * 0.032);
        ctx.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
        ctx.lineWidth = 1.4 + (2 - band) * 0.65;
        ctx.beginPath();
        for (let i = start; i <= end; i++) {
          const distance = Math.abs(i - center + offset) / span;
          const envelope = 1 - clamp(distance, 0, 1);
          const nx = -this.samplesTY[i], ny = this.samplesTX[i];
          const oscillation = Math.sin((i - center) * 0.8 - this.elapsed * 7) * envelope * (5 - band);
          const x = this.samplesX[i] + nx * oscillation;
          const y = this.samplesY[i] + ny * oscillation;
          if (i === start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    _drawRipples() {
      if (!this.ripples.length) return;
      const ctx = this.ctx;
      const r = this.riskColor.r, g = this.riskColor.g, b = this.riskColor.b;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const ripple of this.ripples) {
        const t = clamp(ripple.age / ripple.life, 0, 1);
        const ease = 1 - Math.pow(1 - t, 2);
        const alpha = (1 - t) * (this.profile.mobile ? 0.18 : 0.24);
        const radius = ripple.radius + ease * 22;

        ctx.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
        ctx.lineWidth = 1.15;
        ctx.beginPath();
        ctx.arc(ripple.x, ripple.y, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(240,255,250,' + alpha * 0.38 + ')';
        ctx.lineWidth = 0.55;
        ctx.beginPath();
        ctx.arc(ripple.x, ripple.y, radius * 0.72, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    stop() {
      super.stop();
      // Listeners remain while stopped so restart works; cleanup is exposed explicitly.
    }

    destroyV2() {
      for (const [node, type, fn, opts] of this._v2Bound) node.removeEventListener(type, fn, opts);
      this._v2Bound.length = 0;
      this.ripples.length = 0;
    }
  }

  RiskTideParticlesV2.__riskTideV2 = true;
  global.RiskTideParticles = RiskTideParticlesV2;
})(window);
