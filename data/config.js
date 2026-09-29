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
      desktop: { low: 850, base: 2200, high: 2400, maximum: 2500 },
      mobile: { low: 360, base: 740, high: 790, maximum: 800 },
      layers: { fog: 0.50, flow: 0.35, highlight: 0.15 },
      dpr: { desktop: 2, mobile: 1.5 }
    },

    /* ---- Risk Tide V2 visual layer -------------------------------------
       All particle-motion, interaction and trail tuning lives here so the
       look can be re-tuned without touching js/particles.js logic. */
    tide: {
      // Natural lateral drift: two low-frequency waves + a small noise term.
      // Amplitudes are fractions of the local route width.
      driftAmplitude: { fog: 0.5, flow: 0.22, highlight: 0.11 },
      driftFreqA: [0.055, 0.115],   // waves per second, per-particle range
      driftFreqB: [0.019, 0.043],
      driftNoiseScale: 0.0016,
      driftNoiseAmp: 0.22,
      // risk -> turbulence (smoothstep over normalised risk)
      turbulenceLowEdge: 0.16,
      turbulenceHighEdge: 0.92,
      turbulenceDriftGain: 2.1,
      turbulenceCurlGain: 2.4,
      turbulenceEddyGain: 1.35,
      turbulenceSpeedSpread: 0.9,
      // trails: short, soft, water-like filaments
      trailLength: { fog: 0.85, flow: 1.05, highlight: 1.25 },
      trailSpeedGain: 0.45,
      trailRiskGain: 0.5,
      // hover wake (visual only, never touches trajectory)
      wakeRadius: { desktop: 120, mobile: 0 },
      wakeAlphaGain: 0.6,
      wakeTrailGain: 0.75,
      wakeSmoothRate: 6.5,
      // click ripple
      rippleLife: 1.25,
      rippleMax: { desktop: 4, mobile: 2 },
      rippleRadius: 96,
      rippleWidth: 1.4,
      rippleAlpha: 0.3,
      // route resonance wave packet
      resonanceCooldown: 1.8,
      resonanceLife: 2.4,
      resonanceWidth: 0.115,
      resonanceGain: 1.5,
      resonanceBandAlpha: 0.16,
      resonanceTriggerDistance: { desktop: 62, mobile: 0 }
    },
    quality: {
      movingScale: 0.56,
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










