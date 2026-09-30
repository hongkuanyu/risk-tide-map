/* global window */
(function (global) {
  'use strict';

  /*
   * IMPORTANT DATA STATUS
   * The two point coordinates below are preview coordinates only, deliberately
   * marked "待核对". Replace them with coordinates from your own OSM query or
   * manually verified navigation result before using this project for travel.
   */
  const endpoints = {
    campus: {
      id: 'campus',
      name: '无锡学院校门口',
      shortName: '无锡学院',
      coordinate: [120.4660492, 31.5834765],
      source: 'Photon geocoding · 2026-09-29 · 校门位置仍待现场核对',
      verified: false
    },
    station: {
      id: 'station',
      name: '无锡东站大门口',
      shortName: '无锡东站',
      coordinate: [120.4548648, 31.5981564],
      source: 'Photon geocoding · 2026-09-29 · 校门位置仍待现场核对',
      verified: false
    }
  };

  const config = {
    appName: '风险潮汐',
    subtitle: '一张高铁票的最后一小时',
    endpoints: endpoints,

    map: {
      center: [120.437, 31.548],
      zoom: 11.35,
      minZoom: 9.8,
      maxZoom: 16.5,
      maxBounds: [[120.295, 31.385], [120.565, 31.705]],
      tileUrl: 'assets/osm-tiles/{z}/{x}/{y}.png',
      attribution: '地图数据 © OpenStreetMap contributors',
      tileMaxZoom: 12,
      rasterOpacity: 0.58,
      routePaddingDesktop: { top: 36, right: 34, bottom: 48, left: 390 },
      routePaddingMobile: { top: 28, right: 18, bottom: 28, left: 18 }
    },

    amap: {
      enabled: true,
      key: 'f791654cdc91bbe2b567810d34074a70',
      securityJsCode: 'aba2b2cd55058232eef8d45e0e62f72e',
      version: '2.0',
      city: '无锡',
      mapStyle: 'amap://styles/normal',
      zoom: 12,
      minZoom: 9,
      maxZoom: 18,
      autoRoute: true,
      drivingVariants: [
        { id: 'amap-fast', label: '高德·时间优先', policy: 'LEAST_TIME' },
        { id: 'amap-short', label: '高德·距离优先', policy: 'LEAST_DISTANCE' },
        { id: 'amap-fee', label: '高德·少收费', policy: 'LEAST_FEE' }
      ]
    },
    showcase: {
      durationMs: 12000,
      timeline: [
        { at: 0.00, risk: 22 },
        { at: 0.18, risk: 35 },
        { at: 0.42, risk: 74 },
        { at: 0.68, risk: 96 },
        { at: 0.84, risk: 92 },
        { at: 1.00, risk: 30 }
      ]
    },

    risk: {
      safeBufferMinutes: 60,
      levels: {
        safe: 30,
        critical: 70,
        danger: 85
      }
    },

    colors: {
      ink: '#17241f',
      paper: '#efe9da',
      safe: [0, 124, 108],
      safeBright: [15, 151, 122],
      gold: [207, 151, 34],
      warmWhite: [255, 239, 199],
      danger: [215, 49, 23],
      darkRed: [132, 25, 27],
      coolWhite: [219, 247, 238]
    },

    /* ---- V4 · 彩墨地图 (modern mineral-pigment ink map) ----------------
       The base map is pushed towards 宣纸 + 矿物颜料 in layers rather than a
       single sepia filter: one filter pass for the tile canvas, then blooms,
       washes and paper grain blended on top of it in CSS. */
    inkMap: {
      enabled: true,
      paper: '#efe9da',
      /* Applied to the raster/vector map canvas only - never to markers,
         the route or the ink tide. */
      canvasFilter: 'saturate(0.90) contrast(1.07) brightness(1.04) sepia(0.24) hue-rotate(-16deg)',
      /* 孔雀青 / 竹青 / 石青 / 藤黄 / 赭石 / 胭脂 - pigment pooling */
      blooms: [
        { x: 14, y: 26, rx: 44, ry: 36, color: '38, 143, 111', alpha: 0.20 },
        { x: 44, y: 80, rx: 38, ry: 32, color:  '196, 151, 48', alpha: 0.17 },
        { x: 63, y: 20, rx: 37, ry: 31, color:   '48, 92, 154', alpha: 0.19 },
        { x: 84, y: 66, rx: 33, ry: 29, color:  '166, 76, 54', alpha: 0.14 },
        { x: 30, y: 55, rx: 30, ry: 26, color:   '86, 128, 96', alpha: 0.13 },
        { x: 70, y: 46, rx: 26, ry: 22, color:  '214, 178, 92', alpha: 0.10 }
      ],
      baseWash: 'linear-gradient(118deg, rgba(239,233,218,0.10), rgba(44,132,120,0.045) 48%, rgba(61,91,145,0.055))',
      textureOpacity: 0.18,
      grainOpacity: 0.30
    },

    /* ---- V4 · 丝绸湿墨路线 (silk wet-ink route) ------------------------
       Replaces the solid navigation polyline with 12-24 semi-transparent ink
       strands. Consumes the existing route points + risk score only. */
    silk: {
      /* V6：路线不再由墨丝线层绘制，改由 inkFlow 的连续墨体承担。
         InkFlowRenderer 未启用时会自动回退到这套墨丝渲染。 */
      enabled: false,
      strands: { desktop: 24, mobile: 16 },      // 12-24 per the brief
      baseWidth: { desktop: [10, 13], mobile: [8.5, 11] },
      strandWidth: [1.0, 1.9],                    // 1-2.5px ink hairs, fine end
      /* wet ink diffusion / main strands / moving highlight / ink runners */
      layerShare: { wet: 0.25, main: 0.42, highlight: 0.22, runner: 0.11 },
      alpha: {
        wet: [0.05, 0.12],
        main: [0.20, 0.36],
        highlight: [0.32, 0.46],
        runner: [0.34, 0.48]
      },
      speed: [0.85, 1.20],                        // per-strand flow multiplier
      breathe: [0.90, 1.10],                      // slow width breathing
      breathePeriod: [7.5, 13.5],                 // seconds
      waveAmp: 0.68,                              // hand-drawn silhouette
      waveFreq: [0.35, 0.95],
      centreBias: 1.16,                           // >1 keeps strands dense at centre
      envelope: 0.22,                             // strands converge at both ends
      /* 飞白 / 断墨: dash pattern per strand, in px */
      dash: { minRun: 40, maxRun: 140, minGap: 3, maxGap: 15, brokenShare: 0.34 },
      riskRamp: [
        { at: 0.00, rgb: [0, 124, 108] },   // 青碧 / 孔雀青
        { at: 0.27, rgb: [15, 137, 105] },  // 青绿
        { at: 0.46, rgb: [188, 151, 34] },  // 金
        { at: 0.61, rgb: [224, 137, 19] },  // 金橙
        { at: 0.77, rgb: [229, 82, 16] },   // 橙朱
        { at: 0.90, rgb: [215, 49, 23] },   // 朱砂
        { at: 1.00, rgb: [181, 25, 25] }    // 深朱红
      ],
      colourEaseMs: 280,                          // temporal easing on risk
      flowSpeed: 34,                              // px per second along the route
      riskSpeedGain: 0.38,                        // faster when risky, gently
      pulse: { minAlphaGain: 0.05, riskGain: 0.10, freq: 0.42 },
      cinnabarPulse: { riskThreshold: 86, period: 6.5, width: 0.16, alpha: 0.20 },
      /* ---- V5 · 毛笔笔锋 ------------------------------------------------
         A brush travels the route and re-inks it. The settled stroke stays on
         the paper; what moves is the wet pass: a window of fresh, darker,
         slightly wider ink behind the tip, plus the brush tip itself. */
      brush: {
        enabled: true,
        speed: 0.085,          // laps per second (one full pass ~12s)
        windowLength: 250,     // px of wet ink trailing the tip
        passes: 5,             // offset wet strokes travelling together
        headAlphaGain: 0.90,   // extra ink where the brush just passed
        headWidthGain: 0.55,   // the wet stroke is visibly fatter
        tip: { length: 48, width: 9.5, alpha: 0.66, bristles: 6 },
        halo: { radius: 26, alpha: 0.20 },   // the brush pressing the paper
        dryGap: { min: 2, max: 15 },   // 飞白 along the wet pass
        pool: { minCurvature: 0.5, alpha: 0.18, radius: 8, max: 14 }
      },

      /* Layer D: a flowing ink unit with a long tapering tail (Bezier-ish),
         not a dot. Each runner is drawn as sub-segments whose width and alpha
         ramp from tail to head. */
      runner: {
        count: 3,
        headSpeed: [0.55, 0.95],   // laps per second along the route
        tailLength: [30, 72],      // 约占路线 3%-10%
        headWidth: 2.2,
        segments: 14,
        alpha: [0.05, 0.42]
      },
      dpr: { desktop: 2, mobile: 1.75 },
      reducedMotionScale: 0.32
    },

    /* ---- V6 · InkFlowRenderer ------------------------------------------
       The route is a persistent ink body pushed through a velocity field:
       advection -> diffusion -> decay -> injection. No lines, no moving
       points. See js/ink-flow.js. */
    /* WebGL2 path: same API as inkFlow, ping-pong feedback. Off until it has
       been verified on the target devices - flip to true to try it. */
    inkGL: {
      enabled: false,
      sim: 256,
      influence: { radius: 22 },
      mask: { inner: 7, outer: 20 },   // soft pigment confinement band (px)
      speed: 60,
      decayIn: 0.45,                   // per second, inside the band
      decayOut: 2.6,                   // per second, outside -> dries fast
      gamma: 1.17,                     // contrast curve, composite only (from the density histogram)
      gain: 1.95,                      // maps the median ink density to a visible 0.30 alpha
      injectBase: 0.35,                // low steady feed
      injectPulse: 1.1,                // travelling pigment pulse
      pulseHz: 0.11,                   // low frequency, no visible periodicity
      warmBias: 0.24
    },

    inkFlow: {
      enabled: true,
      grid: { desktop: 300, mobile: 200 },   // finer grid -> crisper core
      influence: { radius: 8, coreRadius: 2.5 },  // thin stream, not a blob
      speed: 108,            // px/s along the route at the core
      edgeShear: 0.35,      // edges lag the core -> stretching / shear
      curveSwirl: 0.55,     // rotational term at bends -> curl and vortices
      diffusion: 0.008,     // barely spreads
      decay: 0.992,         // slow drying
      injection: 1.25,      // pigment fed in at the source
      warmBias: 0.24,       // second pigment field -> internal colour drift
      colourEaseMs: 280,
      prewarmSteps: 240
    },

    particleBudgets: {
      desktop: { low: 2000, base: 2800, high: 3100, maximum: 3400 },
      mobile: { low: 560, base: 880, high: 960, maximum: 1050 },
      layers: { fog: 0.50, flow: 0.35, highlight: 0.15 },
      dpr: { desktop: 2, mobile: 1.5 }
    },

    /* ---- Risk Tide V2 visual layer -------------------------------------
       All particle-motion, interaction and trail tuning lives here so the
       look can be re-tuned without touching js/particles.js logic. */
    tide: {
      /* V5: the particle tide is switched OFF. The route is now animated as a
         brush painting - a wet brush travels along the line and re-inks it.
         Flip this back to true to restore the particle system (the code is
         untouched and still fully wired). */
      enabled: false,
      /* ============ Risk Tide water tuning (single source of truth) =====
         Everything that decides how the current *feels* lives here.
         Motion -> channel -> risk -> trail -> layers -> interactions. */

      // ---- Motion ------------------------------------------------------
      speedVariance: [0.85, 1.15],      // stable per-particle speed bias
      speedModulationAmp: 0.06,         // very slow individual speed drift
      speedModulationFreq: [0.04, 0.08],
      lateralAmplitude: { fog: 0.5, flow: 0.22, highlight: 0.11 },
      driftFreqA: [0.055, 0.115],       // two incommensurate tide waves
      driftFreqB: [0.019, 0.043],
      driftNoiseScale: 0.0016,
      driftNoiseAmp: 0.2,

      // ---- Channel (the invisible current width) ------------------------
      channelWidth: { fog: 1.28, flow: 0.62, highlight: 0.38 },
      channelConcentration: 2.05,        // >1 keeps most particles near centre
      channelRiskGain: 0.3,             // mild "rising tide" with risk
      channelConvergeStart: 0.8,        // converge into the destination
      channelConvergeAmount: 0.5,

      // ---- Risk --------------------------------------------------------
      turbulenceLowEdge: 0.16,          // calm until the mid range
      turbulenceHighEdge: 0.92,
      turbulenceDriftGain: 1.85,        // bounded: heading stays route-led
      turbulenceCurlGain: 1.8,
      turbulenceEddyGain: 1.05,
      turbulenceSpeedSpread: 0.5,
      riskSmoothing: 0.12,              // exponential base, smaller = slower
      colorSmoothing: 0.12,

      // ---- Trail -------------------------------------------------------
      trailLength: { fog: 1.32, flow: 1.72, highlight: 1.92 },
      trailSpeedGain: 0.28,
      trailRiskGain: 0.24,
      trailPersonality: [0.85, 1.15],
      trailSegments: { fog: 3, flow: 5, highlight: 4 },

      // ---- Layer depth (deliberately subtle) ---------------------------
      layerOpacity: { fog: 0.58, flow: 0.84, highlight: 0.88 },
      layerSize: { fog: 1.22, flow: 1.28, highlight: 1.14 },
      globalOpacity: 0.76,

      // ---- Lifecycle ---------------------------------------------------
      lifeFadeIn: 0.1,
      lifeFadeOutStart: 0.86,

      // ---- Hover wake --------------------------------------------------
      wakeRadius: { desktop: 108, mobile: 0 },
      wakeAlphaGain: 0.42,
      wakeTrailGain: 0.5,
      wakeSizeGain: 0.08,
      wakeFadeSpeed: 7.0,
      wakeSpeedGain: 0.22,

      // ---- Click ripple ------------------------------------------------
      rippleLife: 1.15,
      rippleMax: { desktop: 4, mobile: 2 },
      rippleRadius: 86,
      rippleWidth: 1.1,
      rippleAlpha: 0.19,
      rippleDelay: 0.11,

      // ---- Route resonance --------------------------------------------
      resonanceCooldown: 1.9,
      resonanceLife: 1.3,
      resonanceWidth: 0.1,              // ahead of the packet
      resonanceWidthBehind: 0.055,      // faster decay behind it
      resonanceGain: 1.0,
      resonanceBandAlpha: 0.12,
      resonanceTriggerDistance: { desktop: 62, mobile: 0 }
    },
    quality: {
      movingScale: 0.64,
      lowMemoryGb: 4,
      lowCpuCores: 4,
      targetFrameMs: 19,
      recoveryFrameMs: 14.5,
      sampleDesktop: 1.0,
      sampleMobile: 0.72
    }
  };

  global.RiskTideConfig = config;
})(window);


















