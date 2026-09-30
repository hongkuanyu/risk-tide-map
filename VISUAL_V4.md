# Risk Tide Visual V4 · 彩墨地图 + 丝绸湿墨路线

在 V3（silk-ink）基础上做的一次**纯视觉层升级**。没有改动任何业务逻辑：地点搜索、地理定位、起终点、场景切换、交通方式、时间参数、路线规划、风险计算、风险等级、地图缩放拖动、以及全部控件与交互都原样保留。

## 一、渲染分层

```
1  .map                  地图底图（高德或 MapLibre）
2  .map::after           彩墨晕染（局部颜料沉积，multiply）
3  .map-shell::after     宣纸纤维 / 颗粒（ink-texture.png，双层）
4  .particle-canvas      水墨潮汐粒子（原有系统，未改逻辑）
5  .map-grid             网格
6  .silk-canvas          丝绸湿墨路线（新增）
12 .map-legend / .map-status
14 .showcase-overlay
```

## 二、彩墨地图：真正的颜色层次

**不是**单一 `sepia/saturate` 全局滤镜。底图经过两段处理：

**① 基础色调**（`data/config.js` → `inkMap.canvasFilter`，由 `applyInkMapTheme()` 注入 CSS 变量）
统一推向宣纸暖调：`saturate(0.90) contrast(1.07) brightness(1.04) sepia(0.24) hue-rotate(-16deg)`。

**② 色相分离颜料层**（`index.html` 内联 SVG 滤镜 `#inkPigment`）
把底图按**色相倾向**拆成三层，各自以矿物颜料 multiply 叠回：

| 层 | 判据 | 颜料 | 作用 |
|---|---|---|---|
| 水系 | `A = 1.7(B − R)` | `#63b6a6` 孔雀青 | 蓝 → 青碧/孔雀青 |
| 植被 | `A = 4.6G − 2.3(R + B)` | `#86ad63` 竹青 | 绿 → 竹青/灰绿 |
| 暗部 | `A = 0.92 − 0.34(R+G+B)` | `#9a7a5c` 赭石 | 道路/文字 → 暖墨褐 |
| 留白 | 全局轻微提亮回暖 | — | 保留宣纸空气感 |

**实测（已知色块对照）**：

| 元素 | 原始 | 处理后 | 结果 |
|---|---|---|---|
| 水系 | `rgb(168,216,232)` | `rgb(160,211,209)` | 冷度 64→49、绿度 16→26 → 孔雀青 |
| 植被 | `rgb(200,230,201)` | `rgb(177,213,160)` | 绿度 30→44 → 竹青 |
| 暗部 | `rgb(74,74,74)` | `rgb(68,60,51)` | 暖度 0→17 → 赭石 |
| 留白 | `rgb(242,239,230)` | `rgb(255,249,231)` | 保留并略提亮 |
| 品红道路 | `rgb(224,168,188)` | `rgb(236,177,189)` | 基本保留 |

性能：色相分离只在**桌面端**启用；地图拖动/缩放时（`.map-shell.is-moving`）自动跳过，松手后恢复，保证平移流畅。移动端使用基础色调。

**重要修复**：原先的滤镜选择器只匹配 `.maplibregl-canvas`，**开启高德时彩墨处理完全不生效**。现在同时匹配 `.map canvas.amap-layer` / `.amap-maps canvas` / `.amap-layers canvas`。

## 三、丝绸湿墨路线

`js/silk-route.js`（新增，独立 canvas，不碰原有粒子系统）：

- **24 条墨丝**（移动端 16；低配 ×0.75），四层：湿墨扩散 6 / 主墨丝 10 / 动态高光 5 / 墨流长尾 3
- 每条墨丝 **1.0–1.9px**，中密边疏（`centreBias`），首尾收束（`envelope`）
- **基础流束宽度 10–13px**（移动端 8.5–11），随缓慢呼吸 0.9–1.1 倍变化
- **半透明**：湿墨 0.05–0.12 / 主墨丝 0.20–0.36 / 高光 0.32–0.46，地图可透出
- **连续风险色**：7 档 `青碧 #007C6C → 青绿 → 金 → 金橙 → 橙朱 → 朱砂 → 深朱红 #B51919`，档位间 smoothstep 插值 + 280ms 时间缓动
- **运动**：dash 偏移持续前流、0.85–1.2 倍速度差、宽窄呼吸、极慢整体摆荡；无抖动
- **长尾墨流（Layer D）**：3 条流动单元，每条由 14 段子线段构成，宽度与透明度从尾到头递增（`1.45` 次幂曲线），形成**渐细长尾**而非圆点
- **毛笔效果**：飞白 / 断墨（26% 墨丝断开、最大间隙 10px，不成虚线）、分叉与汇合、边缘扩散
- **极高风险**（≥86）每 6.5 秒一次低对比朱砂脉冲
- **平滑**：Catmull-Rom 重采样，90° 直角被圆滑成 13.5° 长曲率；不改动路线地理意义
- **性能**：DPR ≤2、rAF、dt 上限 32ms、预计算切线 / 法线 / 累计长度、每帧 24 段丝 + 42 段长尾 = 66 次描边、支持 `prefers-reduced-motion`（降速至 0.32）

## 四、实心导航线退场

- 高德：`routePolyline` 从 4px / 0.9 不透明 → 1.1px / 0.26，`routeHalo` 16px / 0.11 作为湿墨底
- MapLibre：`risk-route-core` 从 2.6–5.6px → 0.7–1.4px / 0.30，halo 7–15px 变淡
- 注意：AMap 的 `strokeColor` **只接受 16 进制**，透明度必须走 `strokeOpacity`

## 五、调参入口

| 想改什么 | 改哪里 |
|---|---|
| 地图色调 / 彩墨浓度 | `data/config.js` → `inkMap.canvasFilter` / `inkMap.blooms` |
| 颜料分离的三层配色 | `index.html` → `#inkPigment` 里的 `feFlood` 与矩阵系数 |
| 宣纸颗粒强度 | `inkMap.textureOpacity` |
| 墨丝数量 / 宽度 / 透明 | `silk.strands` / `silk.baseWidth` / `silk.strandWidth` / `silk.alpha` |
| 长尾墨流 | `silk.runner`（条数、头速、尾长、分段数） |
| 风险色阶 | `silk.riskRamp` |
| 流速 / 缓动 / 脉冲 | `silk.flowSpeed` / `riskSpeedGain` / `colourEaseMs` / `cinnabarPulse` |
| 潮汐粒子退让程度 | `tide.layerOpacity` / `tide.globalOpacity` |