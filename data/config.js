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
      routePaddingDesktop: { top: 36, right: 34, bottom: 48, left: 34 },
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
      blooms: [],
      baseWash: 'none',
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
      /* 墨色浓度即风险：淡墨 -> 灰墨 -> 浓墨 -> 焦墨，
         只有在最高的约 8% 区间才让焦墨里透出一点朱砂。
         不做 绿→黄→橙→红 的 Dashboard 色阶。 */
      riskRamp: [
        { at: 0.00, rgb: [114, 140, 122] },  // 淡墨（略偏青绿，颜色读得出来）
        { at: 0.30, rgb: [86, 110, 98] },  // 灰墨
        { at: 0.58, rgb: [60, 80, 74] },     // 浓墨
        { at: 0.82, rgb: [44, 58, 52] },     // 深墨（不再压到纯黑）
        { at: 0.94, rgb: [46, 44, 38] },     // 深墨平台（避免过早泛红）
        { at: 1.00, rgb: [136, 52, 42] }     // 朱砂暗渗（红比原来更看得见）
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

    /* 全国视图默认开启；?route=1 进入单程路线视图。
       行程时间来自直线距离示意模型，并非实时交通或铁路时刻表。 */
    nation: {
      enabled: true,
      mode: 'rail',            // 'rail' | 'drive'
      defaultWindowMinutes: 480,
      map: {
        center: [104.5, 35.5],
        zoom: 3.4,
        minZoom: 3.2,
        maxZoom: 16.5,
        maxBounds: [[72, 14], [138, 55]],
        amapZoom: 3.6
      },
      ink: {
        projection: 'auto',
        bounds: [73, 18, 136, 54],
        pad: 0.06
      }
    },

    /* ---- 水墨颜料系统（唯一色源）----------------------------------------
       淡墨 -> 灰墨 -> 浓墨 -> 焦墨 -> 焦墨+朱砂，OKLab 连续插值，不做 if/else
       色阶切换。视觉只读取 displayRisk；朱砂在最后约 6% 风险区间慢慢渗出。 */
    ink: {
      ramp: [
        { at: 0.00, rgb: [114, 140, 122] },  // 淡墨（略偏青绿，颜色读得出来）
        { at: 0.30, rgb: [86, 110, 98] },  // 灰墨
        { at: 0.58, rgb: [60, 80, 74] },     // 浓墨
        { at: 0.82, rgb: [44, 58, 52] },     // 深墨（不再压到纯黑）
        { at: 0.94, rgb: [46, 44, 38] },     // 深墨平台
        { at: 1.00, rgb: [136, 52, 42] }     // 朱砂暗渗（红比原来更看得见）
      ],
      /* 主光脉色阶（风险三段，平滑插值，不允许跳变）：
         安全 #68DFED 青蓝 → 临界 #EABB6C 金 → 危险 #E66A5A 赤红。
         这是路线墨线的"时间压力"通道；墨体本身始终保持深墨黑，不随风险变色。 */
      coreRamp: [
        { at: 0.00, rgb: [104, 223, 237] },  // #68DFED 青蓝 · 安全
        { at: 0.55, rgb: [234, 187, 108] },  // #EABB6C 金 · 临界
        { at: 1.00, rgb: [230, 106, 90] }    // #E66A5A 赤红 · 危险
      ],
      /* 流动高光（沿主光脉推进的冷白短光段） */
      highlightRamp: [
        { at: 0.00, rgb: [229, 250, 252] },  // #E5FAFC 冷白
        { at: 0.55, rgb: [255, 243, 214] },  // #FFF3D6 暖白
        { at: 1.00, rgb: [255, 224, 216] }   // #FFE0D8 浅赤白
      ],
      /* 单程墨线：墨晕 / 墨肉 / 飞白 / 墨骨 / 芯光 + 生长中的湿墨头 */
      route: {
        growSeconds: 5.2,          // 终点 -> 起点 一次写完
        /* ── 浓墨流光材质（按 2026-10-12 外观规范）─────────────────────────
           层次自外向内：
             ① 外围墨晕  很薄的半透明青灰，紧贴边界，不影响地图
             ② 浓墨主体  #12252D → #03080C 的实心过渡，哑光、不透明、中央饱满
             ③ 暗青过渡  连接浓墨与内芯
             ④ 中央光脉  单束连续青蓝，宽度 = 墨体宽 × core.veinRatio（≈6:1）
             ⑤ 流动高光  沿光脉推进的冷白短光段
           视觉优先级：浓墨主体 ＞ 连续光脉 ＞ 短时高光 ＞ 边缘墨雾。
           颜色：墨体不随风险变色（始终深墨黑）；风险只体现在光脉/高光的颜色与流速。 */
        halo: { width: 13, alpha: 0.045, color: '#1B3540', phase: 0.5, undulate: 0.22 },
        /* 外→内：暗青过渡（薄）→ 浓墨主体（厚实、近黑，占绝大宽度）→ 墨脊 */
        passes: [
          { width: 17.5, alpha: 0.28, color: '#12252D', sharp: 0.15, phase: 0.0, undulate: 0.32 },
          { width: 16.0, alpha: 0.52, color: '#0C1A22', sharp: 0.30, phase: 0.6, undulate: 0.30 },
          { width: 14.0, alpha: 0.68, color: '#071216', sharp: 0.50, phase: 1.2, undulate: 0.26 },
          { width: 12.0, alpha: 0.82, color: '#03080C', sharp: 0.70, phase: 1.8, undulate: 0.22 }
        ],
        bone: { width: 8.0, alpha: 0.90, color: '#02060A', phase: 0.3, undulate: 0.16 },  // 实心墨脊（近黑主体）
        head: { radius: 4.4, alpha: 0.95 },                                              // 墨头
        /* 飞白：只留少量紧贴主线的短毛边（不再是向外伸的长划痕） */
        bristle: { strands: 4, width: 1.6, inner: 0.95, outer: 1.18, alpha: 0.22,
          color: '#08131A', scatter: 0.55, tailKeep: 0.45, phase: 0.2, undulate: 0.20 },
        /* 中央流光：单束连续光脉 + 少量沿线条推进的冷白高光 */
        core: {
          enabled: true,
          veinRatio: 0.13,                        // 光脉宽 = 墨体宽 × 0.15（≈6:1）
          glowRatio: { min: 0.30, max: 0.45 },    // 外层柔光 = 墨体宽 × 0.30~0.45
          veinAlpha: 0.72,
          glowAlpha: 0.16,
          hold: 0.10,                             // 两端淡出比例
          drift: 0.35,                            // 光脉内部明暗游走（慢）
          highlight: { width: 0.5, alpha: 0.90, count: 2, speed: 0.14, length: 0.055,
            speedRisk: 1.6 }                      // 风险越高，光段推进越快
        },
        /* 危险态：边缘可出现极少量赤墨渗出 */
        bleed: { from: 72, max: 0.12, color: '#E66A5A' },
        /* 风险调制：仅轻微加宽/加浓，墨体不能因此变成"压力管" */
        risk: {
          width: { min: 0.94, max: 1.14 },
          alpha: { min: 0.92, max: 1.04 }
        },
        /* 风险变化沿墨线传播（墨头先响应、墨尾滞后），单位秒 */
        propagate: { rise: 1.6, fall: 3.4 },
        /* 极微弱呼吸（整条线不许膨胀收缩） */
        flow: { amplitude: 0.04, period: 16 }
      },
      /* 全国墨潮：潮岸缓慢扩散、等值线、城市墨源半径 */
      tide: {
        shoreAmplitude: 0.035,     // 潮岸扩散幅度（肉眼可见但克制）
        shorePeriod: 60,           // 秒
        contourRisk: 55,           // 潮岸等值线阈值
        contourAlpha: 0.34,
        dotTier1: 13,              // 主要枢纽城市墨源半径 (px)
        dotTier2: 9,               // 一般城市墨源半径 (px)
        fieldRadius: 30,           // 墨场核半径 (px)：离散墨点只在邻近城市间融合
        fieldAlpha: 0.22           // 墨场最大不透明度：留白透气，不做热力图糊底
      }
    },

    /* Retained as an opt-in experimental renderer; the default route uses
       the cached, one-time ink stroke in js/ink-flow.js. */
    inkGL: {
      enabled: false,
      sim: 256,
      influence: { radius: 22 },
      mask: { inner: 7, outer: 20 },   // soft pigment confinement band (px)
      speed: 112,
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
      enabled: true
    }
  };

  global.RiskTideConfig = config;
})(window);















