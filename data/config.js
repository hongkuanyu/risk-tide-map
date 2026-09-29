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
      rasterOpacity: 0.42,
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
      ink: '#020708',
      paper: '#d9d0b7',
      safe: [55, 202, 219],
      safeBright: [151, 244, 247],
      gold: [238, 181, 72],
      warmWhite: [255, 239, 199],
      danger: [228, 55, 48],
      darkRed: [102, 18, 19],
      coolWhite: [221, 249, 255]
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
      channelWidth: { fog: 1.15, flow: 0.5, highlight: 0.3 },
      channelConcentration: 1.8,        // >1 keeps most particles near centre
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
      trailLength: { fog: 1.05, flow: 1.35, highlight: 1.55 },
      trailSpeedGain: 0.35,
      trailRiskGain: 0.32,
      trailPersonality: [0.85, 1.15],
      trailSegments: { fog: 2, flow: 3, highlight: 2 },

      // ---- Layer depth (deliberately subtle) ---------------------------
      layerOpacity: { fog: 1.0, flow: 1.0, highlight: 1.0 },
      layerSize: { fog: 0.94, flow: 1.0, highlight: 0.88 },
      globalOpacity: 1.0,

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


















