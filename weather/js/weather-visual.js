/* global window, document */
/*
 * Risk Tide - weather visual layer (option 1).
 *
 * Draws the *current* weather on its own canvas above the map grid:
 *   rain   -> ink-lean streaks, lean angle follows the wind direction
 *   snow   -> slow drifting flakes
 *   storm  -> rain plus a rare low-alpha screen flash
 *   fog    -> no particles, the .weather-veil CSS layer does the work
 *
 * Design rules:
 *   - one canvas, one batched path per drop type, no per-drop shadow blur
 *   - hard device budget (mobile <= 130 drops) so the ink particles keep
 *     their frame rate
 *   - honours prefers-reduced-motion: the veil still tints the map, but
 *     nothing falls
 *   - the module never touches js/particles.js
 */
(function (global) {
  'use strict';

  const config = global.RiskTideConfig;

  const DEFAULT_BUDGET = { desktop: 420, mobile: 130 };
  const DEFAULT_DPR = { desktop: 1.5, mobile: 1.25 };

  /* ---- weather code -> visual descriptor ------------------------------
     Pure function, exported so it can be unit tested without a canvas.
     kind:      none | haze | fog | rain | snow | sleet | storm
     intensity: 0..1 base strength for this code
     flash:     only meaningful for thunderstorms */
  const CODE_VISUALS = {
    0: { kind: 'none', intensity: 0 },
    1: { kind: 'none', intensity: 0.04 },
    2: { kind: 'haze', intensity: 0.10 },
    3: { kind: 'haze', intensity: 0.16 },
    45: { kind: 'fog', intensity: 0.52 },
    48: { kind: 'fog', intensity: 0.66 },
    51: { kind: 'rain', intensity: 0.18 },
    53: { kind: 'rain', intensity: 0.30 },
    55: { kind: 'rain', intensity: 0.42 },
    56: { kind: 'sleet', intensity: 0.34 },
    57: { kind: 'sleet', intensity: 0.46 },
    61: { kind: 'rain', intensity: 0.40 },
    63: { kind: 'rain', intensity: 0.60 },
    65: { kind: 'rain', intensity: 0.85 },
    66: { kind: 'sleet', intensity: 0.58 },
    67: { kind: 'sleet', intensity: 0.74 },
    71: { kind: 'snow', intensity: 0.44 },
    73: { kind: 'snow', intensity: 0.62 },
    75: { kind: 'snow', intensity: 0.85 },
    77: { kind: 'snow', intensity: 0.38 },
    80: { kind: 'rain', intensity: 0.50 },
    81: { kind: 'rain', intensity: 0.70 },
    82: { kind: 'storm', intensity: 0.95, flash: true },
    85: { kind: 'snow', intensity: 0.52 },
    86: { kind: 'snow', intensity: 0.80 },
    95: { kind: 'storm', intensity: 0.78, flash: true },
    96: { kind: 'storm', intensity: 0.88, flash: true },
    99: { kind: 'storm', intensity: 1.00, flash: true }
  };

  const NONE = { kind: 'none', intensity: 0, flash: false, leanDeg: 0, fog: 0 };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function numberOr(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  /* Unknown must stay unknown: Number(null) is 0, and "0 m visibility"
     would be read as dense fog. */
  function numOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function visualFor(reading, options) {
    if (!reading) return Object.assign({}, NONE);
    const settings = options || {};
    const base = CODE_VISUALS[Number(reading.code)] || Object.assign({}, NONE, { kind: 'haze', intensity: 0.08 });
    const result = {
      kind: base.kind,
      intensity: base.intensity,
      flash: !!base.flash,
      leanDeg: 0,
      fog: 0
    };

    /* Measured precipitation can out-rank the code (e.g. a heavy shower
       reported as code 61). */
    const precipitation = numberOr(reading.precipitation, 0);
    if (precipitation > 0 && (result.kind === 'rain' || result.kind === 'storm' || result.kind === 'sleet')) {
      result.intensity = Math.max(result.intensity, clamp(precipitation / 7.6, 0.2, 1));
    }

    /* Wind: direction decides the lean, speed decides how far. */
    const windSpeed = numberOr(reading.windSpeed, 0);
    const windDirection = numOrNull(reading.windDirection);
    const maxLean = numberOr(settings.maxLeanDeg, 26);
    if (windDirection !== null) {
      /* Meteorological direction is where the wind comes FROM, so the rain
         leans towards (direction + 180). Screen x grows to the right. */
      const towards = (windDirection + 180) * Math.PI / 180;
      const amount = clamp(windSpeed / 42, 0, 1);
      result.leanDeg = Math.sin(towards) * amount * maxLean;
    } else {
      result.leanDeg = clamp(windSpeed / 42, 0, 1) * maxLean * 0.5;
    }
    /* Math.sin() of a full turn leaves a signed zero; normalise it so the
       lean reads as exactly 0 when there is no wind. */
    if (Math.abs(result.leanDeg) < 1e-9) result.leanDeg = 0;

    /* Low visibility thickens the veil even when the code is not "fog". */
    const visibility = numOrNull(reading.visibility);
    if (visibility !== null && visibility < 8000) {
      result.fog = clamp((8000 - visibility) / 7000, 0, 1);
      if (result.kind === 'none' || result.kind === 'haze') {
        result.kind = result.fog > 0.6 ? 'fog' : 'haze';
        result.intensity = Math.max(result.intensity, result.fog * 0.8);
      }
    }
    if (base.kind === 'fog') result.fog = Math.max(result.fog, base.intensity);

    result.intensity = clamp(result.intensity, 0, 1);
    if (settings.reduceMotion) result.flash = false;
    return result;
  }

  function detectProfile() {
    const width = global.innerWidth || document.documentElement.clientWidth || 960;
    const mobile = width <= 760 || /Mobi|Android|iPhone|iPad/i.test(global.navigator.userAgent);
    const visual = (config && config.weather && config.weather.visual) || {};
    const budget = visual.budget || {};
    const dprCap = visual.dprCap || {};
    const reduceMotion = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    return {
      mobile: mobile,
      reduceMotion: reduceMotion,
      maxDrops: Math.max(0, Math.floor(mobile ? numberOr(budget.mobile, DEFAULT_BUDGET.mobile) : numberOr(budget.desktop, DEFAULT_BUDGET.desktop))),
      dprCap: numberOr(mobile ? dprCap.mobile : dprCap.desktop, mobile ? DEFAULT_DPR.mobile : DEFAULT_DPR.desktop),
      maxLeanDeg: numberOr(visual.maxLeanDeg, 26),
      rainColor: visual.rainColor || '38,64,78',
      snowColor: visual.snowColor || '236,243,246',
      rainSpeed: visual.rainSpeed || [430, 880],
      snowSpeed: visual.snowSpeed || [38, 88],
      rainLength: visual.rainLength || [9, 26],
      snowSize: visual.snowSize || [1.3, 3.0],
      rainAlpha: visual.rainAlpha || [0.15, 0.32],
      snowAlpha: visual.snowAlpha || [0.28, 0.55],
      flash: visual.flash !== false
    };
  }

  function randomBetween(range, fallback) {
    const a = Array.isArray(range) ? Number(range[0]) : NaN;
    const b = Array.isArray(range) ? Number(range[1]) : NaN;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return fallback;
    return a + Math.random() * (b - a);
  }

  class WeatherVisual {
    constructor(canvas, shell) {
      this.canvas = canvas;
      this.ctx = canvas && canvas.getContext ? canvas.getContext('2d', { alpha: true, desynchronized: true }) : null;
      this.shell = shell || null;
      this.profile = detectProfile();
      this.width = 1;
      this.height = 1;
      this.dpr = 1;
      this.running = false;
      this.visible = !document.hidden;
      this.drops = [];
      this.target = Object.assign({}, NONE);
      this.displayKind = 'none';
      this.intensity = 0;
      this.flash = 0;
      this.flashTimer = 0;
      this.nextFlash = 0;
      this.lastTime = 0;
      this.boundFrame = this.frame.bind(this);
      this.resize();
      this.applyVeil('none');
      this.observeResize();
    }

    /* The canvas is laid out by CSS, so its pixel size must follow the shell.
       Without this the backing store keeps whatever size the first paint had
       and the rain gets stretched when the map panel grows. */
    observeResize() {
      if (!global.ResizeObserver || !this.shell || this.resizeObserver) return;
      const self = this;
      this.resizeObserver = new global.ResizeObserver(function () {
        self.resize();
      });
      this.resizeObserver.observe(this.shell);
    }

    resize() {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const cssWidth = Math.max(1, rect.width || (this.shell ? this.shell.clientWidth : 1));
      const cssHeight = Math.max(1, rect.height || (this.shell ? this.shell.clientHeight : 1));
      const dpr = Math.min(global.devicePixelRatio || 1, this.profile.dprCap);
      this.width = cssWidth;
      this.height = cssHeight;
      this.dpr = dpr;
      if (this.canvas.width === Math.round(cssWidth * dpr) && this.canvas.height === Math.round(cssHeight * dpr)) return;
      this.canvas.width = Math.round(cssWidth * dpr);
      this.canvas.height = Math.round(cssHeight * dpr);
      if (this.ctx && this.ctx.setTransform) this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (let i = 0; i < this.drops.length; i += 1) this.placeDrop(this.drops[i], true);
    }

    /* Weather is reference material for the renderer, not the risk model. */
    set(info) {
      const source = (config && config.weather && config.weather.visual && config.weather.visual.source) || 'current';
      const reading = info && info.ok
        ? (source === 'departure' ? (info.departure || info.current) : (info.current || info.departure))
        : null;
      this.target = visualFor(reading, {
        maxLeanDeg: this.profile.maxLeanDeg,
        reduceMotion: this.profile.reduceMotion
      });
      this.applyVeil(info && info.ok ? this.target.kind : 'none');
      return this.target;
    }

    applyVeil(kind) {
      if (!this.shell) return;
      if (kind === 'none') this.shell.removeAttribute('data-weather');
      else this.shell.setAttribute('data-weather', kind);
    }

    createDrop(kind) {
      const isSnow = kind === 'snow' || (kind === 'sleet' && Math.random() < 0.45);
      const drop = {
        snow: isSnow,
        x: 0,
        y: 0,
        vx: 0,
        speed: 0,
        length: 0,
        size: 0,
        alpha: 0.2,
        swayPhase: Math.random() * Math.PI * 2,
        swayFreq: 0.6 + Math.random() * 1.1,
        swayAmp: 4 + Math.random() * 10,
        baseX: 0
      };
      this.placeDrop(drop, true);
      return drop;
    }

    placeDrop(drop, anywhere) {
      drop.baseX = Math.random() * this.width;
      drop.x = drop.baseX;
      drop.y = anywhere ? Math.random() * this.height : -this.height * 0.12 - Math.random() * 40;
      drop.speed = drop.snow
        ? randomBetween(this.profile.snowSpeed, 60)
        : randomBetween(this.profile.rainSpeed, 620);
      drop.length = drop.snow ? 0 : randomBetween(this.profile.rainLength, 16);
      drop.size = drop.snow ? randomBetween(this.profile.snowSize, 2) : 1;
      drop.alpha = drop.snow
        ? randomBetween(this.profile.snowAlpha, 0.4)
        : randomBetween(this.profile.rainAlpha, 0.22);
      if (!drop.snow && this.profile.reduceMotion) drop.speed = 0;
    }

    rebuild(kind) {
      this.drops.length = 0;
      if (kind === 'none' || kind === 'haze' || kind === 'fog') return;
      const max = this.profile.maxDrops;
      for (let i = 0; i < max; i += 1) this.drops.push(this.createDrop(kind));
    }

    setVisible(visible) {
      this.visible = !!visible;
      this.lastTime = 0;
    }

    start() {
      if (this.running || !this.canvas || !this.ctx) return;
      this.running = true;
      this.visible = !document.hidden;
      this.lastTime = 0;
      global.requestAnimationFrame(this.boundFrame);
    }

    stop() {
      this.running = false;
    }

    /* Number of drops actually drawn, for metrics / debugging. */
    activeCount() {
      const ratio = (this.displayKind === this.target.kind) ? this.intensity : Math.min(this.intensity, 0.999);
      return Math.round(this.drops.length * clamp(ratio, 0, 1));
    }

    update(dt, time) {
      const target = this.target;
      const wanted = target.kind === 'none' || target.kind === 'haze' || target.kind === 'fog' ? 0 : target.intensity;

      /* Fade out before switching kind, so snow never pops into rain. */
      if (this.displayKind !== target.kind && this.intensity < 0.02) {
        this.displayKind = target.kind;
        this.rebuild(target.kind);
      }
      const goal = this.displayKind === target.kind ? wanted : 0;
      this.intensity += (goal - this.intensity) * Math.min(1, dt * 2.6);
      if (this.intensity < 0.004 && goal === 0) this.intensity = 0;

      if (this.displayKind === 'none' || this.displayKind === 'haze' || this.displayKind === 'fog') return;

      const active = this.activeCount();
      const leanRad = (target.leanDeg || 0) * Math.PI / 180;
      const driftX = Math.tan(leanRad);
      for (let i = 0; i < this.drops.length; i += 1) {
        const drop = this.drops[i];
        if (i >= active) continue;
        if (drop.snow) {
          drop.y += drop.speed * dt;
          drop.x = drop.baseX + Math.sin(time * drop.swayFreq + drop.swayPhase) * drop.swayAmp;
        } else {
          drop.y += drop.speed * dt;
          drop.x += drop.speed * driftX * dt;
        }
        if (drop.y - 40 > this.height || drop.x < -60 || drop.x > this.width + 60) {
          this.placeDrop(drop, false);
        }
      }

      /* Thunder flash: rare, low contrast, never in reduced-motion mode. */
      if (target.flash && this.profile.flash && !this.profile.reduceMotion && this.displayKind === 'storm') {
        this.flashTimer -= dt;
        if (this.flashTimer <= 0) {
          this.flash = 1;
          this.flashTimer = 2.4 + Math.random() * 5.2;
        }
      }
      this.flash = Math.max(0, this.flash - dt * 3.4);
    }

    draw() {
      if (!this.ctx) return;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.width, this.height);
      const active = this.activeCount();

      if (active > 0) {
        const rain = [];
        const snow = [];
        for (let i = 0; i < active; i += 1) {
          const drop = this.drops[i];
          if (drop.snow) snow.push(drop); else rain.push(drop);
        }

        if (rain.length) {
          const leanRad = (this.target.leanDeg || 0) * Math.PI / 180;
          const dx = Math.sin(leanRad);
          const dy = Math.cos(leanRad);
          ctx.save();
          ctx.lineCap = 'round';
          ctx.strokeStyle = 'rgba(' + this.profile.rainColor + ',' + clamp(0.16 + this.intensity * 0.22, 0, 0.42).toFixed(3) + ')';
          ctx.lineWidth = this.profile.mobile ? 1 : 1.15;
          ctx.beginPath();
          for (let i = 0; i < rain.length; i += 1) {
            const drop = rain[i];
            const length = drop.length * (0.55 + this.intensity * 0.75);
            ctx.moveTo(drop.x, drop.y);
            ctx.lineTo(drop.x + dx * length, drop.y + dy * length);
          }
          ctx.stroke();
          ctx.restore();
        }

        if (snow.length) {
          ctx.save();
          ctx.fillStyle = 'rgba(' + this.profile.snowColor + ',' + clamp(0.22 + this.intensity * 0.3, 0, 0.6).toFixed(3) + ')';
          ctx.beginPath();
          for (let i = 0; i < snow.length; i += 1) {
            const drop = snow[i];
            ctx.moveTo(drop.x, drop.y);
            ctx.arc(drop.x, drop.y, drop.size * (0.7 + this.intensity * 0.5), 0, Math.PI * 2);
          }
          ctx.fill();
          ctx.restore();
        }
      }

      if (this.flash > 0.01) {
        ctx.save();
        ctx.fillStyle = 'rgba(226,238,244,' + (this.flash * 0.14).toFixed(3) + ')';
        ctx.fillRect(0, 0, this.width, this.height);
        ctx.restore();
      }
    }

    frame(timestamp) {
      if (!this.running) return;
      const dt = this.lastTime ? Math.min((timestamp - this.lastTime) / 1000, 0.05) : 0.0167;
      this.lastTime = timestamp;
      try {
        if (this.visible) {
          this.update(dt, timestamp / 1000);
          this.draw();
        }
      } catch (error) {
        if (global.console && console.warn) console.warn('天气图层帧已跳过：' + (error && error.message ? error.message : error));
      }
      global.requestAnimationFrame(this.boundFrame);
    }
  }

  WeatherVisual.visualFor = visualFor;
  WeatherVisual.CODE_VISUALS = CODE_VISUALS;

  global.RiskTideWeatherVisual = WeatherVisual;
  global.RiskTideWeatherVisualSpec = { visualFor: visualFor, codeVisuals: CODE_VISUALS };
})(window);