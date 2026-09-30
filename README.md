# 风险潮汐：一张高铁票的最后一小时

一个无需后端、无需账号、可直接部署到 GitHub Pages 的互动地图。  
MapLibre GL JS 加载 OpenStreetMap 栅格底图，单 Canvas 水墨星云粒子沿路线从无锡东站流向无锡学院。

> **重要数据声明**：当前项目中的无锡学院、无锡东站端点和交通路线尚未完成外部核验，已明确标记为“待核对/预览占位”。页面可以完整运行和演示，但**不要将预览地点或手动输入时间当作真实出行结论**。

## 本地运行

需要 Node.js 18 或更高版本。

最省事的方式：直接双击项目根目录的：

```text
START_MAP.bat
```

等待命令行窗口出现 `Risk Tide Map: http://localhost:8080`，浏览器会自动打开。使用期间不要关闭这个命令行窗口。

手动方式：

```bash
cd risk-tide-map
npm start
```

然后打开：

```text
http://localhost:8080
```

如果 Node.js 启动失败，也可以直接双击 `index.html`；页面会保留水墨粒子、风险计算和墨黑网格降级底图。完整 OSM 底图仍建议使用 `START_MAP.bat` 启动本地服务器。

手机访问时，不要使用 localhost。手机必须和电脑连接同一个 Wi-Fi，然后打开电脑的局域网地址，例如：http://192.168.1.24:8080/。可在项目根目录的 MOBILE_URL.txt 中查看启动时写出的地址。

## 快速替换真实现场数据

### 1. 核对两个端点

编辑 `data/config.js`：

```js
const endpoints = {
  campus: {
    coordinate: [经度, 纬度],
    source: '你的 OSM / 导航查询来源',
    verified: true
  },
  station: {
    coordinate: [经度, 纬度],
    source: '你的 OSM / 导航查询来源',
    verified: true
  }
};
```

坐标顺序是 MapLibre 使用的 `[longitude, latitude]`，即 `[经度, 纬度]`。

### 2. 填写车辆与公交路线

编辑 `data/routes.js`。路线节点必须按 **无锡学院校门口 → 无锡东站大门口** 排列：

```js
taxi: {
  id: 'taxi',
  label: '网约车',
  durationMinutes: 35,
  source: '人工查询：平台 / 日期 / 截图文件名',
  verified: true,
  coordinates: [
    [120.0000, 31.0000],
    [120.0000, 31.0000]
  ]
}
```

公交路线必须把你实际核验过的站名写入 `stopNames`。没有核验的站名应保持空数组，并继续标记为“待核对”。

粒子动画内部会自动反转路线方向，因此仍然从无锡东站流向无锡学院。若路线坐标缺失，页面使用两端点之间的**示意虚线**继续展示粒子方向，并在界面附近显示风险警告。

### 3. 补全来源

同步修改：

- `DOCS/DATA_SOURCES.md`
- `data/routes.js` 的 `source`
- `data/config.js` 的端点 `source`

## 计算规则

可用时间：

```text
高铁发车时间 - 计划出发时间
```

必需时间：

```text
路线时间 + 站内流程时间 + 天气加时
```

安全缓冲：

```text
可用时间 - 必需时间
```

最晚安全出发时间：

```text
高铁发车时间 - 路线时间 - 站内流程时间 - 天气加时 - 60 分钟
```

> 天气加时来自实时天气模块，只会让所需时间变长、风险变高，不会降低风险。

风险值：

```text
缓冲 >= 60：0
缓冲 <= 0：100
其他：((60 - 缓冲) / 60) × 100
```

时间差使用 24 小时循环计算，因此支持跨天；例如 `23:40 → 00:20` 会按 40 分钟计算。


## 实时天气（Open-Meteo）

页面内置了 `js/weather.js`，使用 [Open-Meteo](https://open-meteo.com/) 的免费接口：

- 不需要 API Key，允许跨域，静态 GitHub Pages 可以直接调用。
- 同时读取「当前观测」和「逐小时预报」，风险模型使用的是**计划出发时刻那一小时**的天气，而不是此刻天气。
- 天气只做加时：取值上限为 `config.weather.maxExtraMinutes`（默认 30 分钟）。
- 请求按经纬度做 10 分钟缓存，页面每 15 分钟自动刷新一次；离线或接口失败时自动退回纯时间模型，界面标注“天气暂不可用”。

加时规则（WMO 天气代码 + 风速 / 阵风 + 降水概率 + 能见度，取最强项叠加，最后截断）：

| 天气 | 典型加时 |
|---|---|
| 阴 / 多云 | 0–1 分钟 |
| 小雨、阵雨 | 5 分钟左右 |
| 中雨、小雪 | 8–11 分钟 |
| 大雨、雷阵雨、大雪 | 15–18 分钟 |
| 雾（能见度 < 2 km） | 8–16 分钟 |
| 阵风 ≥ 55 km/h | 额外 +7 分钟 |

配置位置 `data/config.js`：

```js
weather: {
  enabled: true,
  endpoint: 'https://api.open-meteo.com/v1/forecast',
  timezone: 'Asia/Shanghai',
  refreshMinutes: 15,
  cacheMinutes: 10,
  maxExtraMinutes: 30
}
```

把 `enabled` 设为 `false` 即可关闭实时天气，风险回到纯时间缓冲模型。若要换成和风天气 / 高德天气，只需替换 `js/weather.js` 里的取数函数，`impact()` 与 UI 无需改动。

### 地图上的天气层

`js/weather-visual.js` 把当前天气画在地图上，用的是**独立 canvas**（`#weather-canvas`），完全不碰 `js/particles.js` 的水墨粒子——两者互不影响，可以单独关闭。

| 天气 | 表现 |
|---|---|
| 晴 / 少云 | 无叠加 |
| 多云 / 阴 | 淡灰薄雾（haze） |
| 小雨 → 大雨 | 淡墨斜线雨丝，密度与透明度随降水量增强 |
| 阵雨 / 小雪 → 大雪 | 同上，雪为缓慢飘落的小颗粒 |
| 冻雨 / 雨夹雪 | 雨雪混合 |
| 雷暴 | 雨丝 + 低频整屏微闪（默认关闭于 reduced-motion） |
| 雾 | 整套雾罩：降低底图对比度与饱和度，不加粒子 |

实现要点：

- **风向驱动倾角**：`wind_direction_10m` 是风的来向，雨丝朝 `风向 + 180°` 倾斜；风速决定倾角大小（上限 `visual.maxLeanDeg`，默认 26°）。
- **预算硬上限**：桌面 ≤ 420 条、手机 ≤ 130 条（`visual.budget`），与粒子池互不抢占；`ResizeObserver` 跟随地图尺寸重算分辨率。
- **水墨配色**：雨丝是 `rgba(38,64,78,α)` 的墨蓝而不是白色，避免破坏纸感；透明度上限 0.42。
- **空值安全**：当前观测没有能见度时视为“未知”，不会因为 `Number(null) === 0` 被误判成浓雾。
- **无障碍**：`prefers-reduced-motion: reduce` 时关闭雨雪动画与闪电，仅保留静态雾罩。

配置位置（`data/config.js` 的 `weather.visual`）：

```js
visual: {
  enabled: true,
  source: 'current',   // 'current' 现在的天气，'departure' 出发时段的预报
  budget: { desktop: 420, mobile: 130 },
  maxLeanDeg: 26,
  rainColor: '38,64,78',
  flash: true
}
```

另：本次一并修复了 `.map-vignette` 缺失定位样式的问题——此前 `[data-risk-level="danger"/"storm"]` 的红色晕影规则写了背景但元素高度为 0，实际从未显示过。

## 高德地图 API 配置

项目已内置高德地图适配层，未填写 Key 时自动使用原有 OpenStreetMap 降级底图。

编辑 `data/config.js`：

```js
amap: {
  enabled: true,
  key: '你的 Web端 JS API Key',
  securityJsCode: '你的 securityJsCode',
  mapStyle: 'amap://styles/darkblue'
}
```

然后在高德开放平台控制台配置安全域名。GitHub Pages 需要加入：

```text
hongkuanyu.github.io
```

本地开发可加入：

```text
localhost
```

启用后会使用：

- 高德地图底图
- 高德驾车路线规划：时间优先、距离优先、少收费
- 高德公交换乘路线规划
- 高德地图坐标与原有 Canvas 水墨粒子联动

前端 Map JS API Key 本身会出现在浏览器源代码中，这是高德 JS API 的正常方式；必须使用域名白名单限制，不能使用无限制的 Key。

## 粒子数量规则

粒子系统按屏幕宽度、CPU 核心数、设备内存和 `prefers-reduced-motion` 自适应。

### 桌面端

- 低性能：800，最高降到约 700–1000
- 普通：1500
- 高性能：2200
- 硬件上限：2500
- 设备像素比上限：2

### 手机端

- 低性能：320，降至约 250–450
- 普通：560
- 高性能：760
- 硬件上限：800
- 设备像素比上限：1.5

### 风险与数量

粒子数量会随风险连续变化：

- 0–30：基础数量的 50%–70%
- 30–70：基础数量的 80%–110%
- 70–100：基础数量的 110%–150%
- 数量始终受当前设备的最大值截断

粒子池在初始化时一次性创建，动画帧中不创建粒子对象。地图拖动时粒子质量暂时降低；页面隐藏时暂停动画；设备帧率低于目标时自动降级，恢复稳定后逐步提高质量。

## 三层粒子

- 墨雾层：约 50%，低透明度、大范围横向扩散，负责空间氛围。
- 流光层：约 35%，青色、金色或赤红色，速度更快，负责风险速度感。
- 高光层：约 15%，十字高光与短速度线，高风险时增强。

网约车提供 OSRM 快速路、Valhalla 推荐路和 Valhalla 备选路三套真实道路几何，可在“路线方案”下拉框中切换。粒子使用路线累计距离插值、屏幕投影和 curl noise 流场。风险超过 85 时会周期性生成短时赤墨爆发；粒子到达学院附近后会形成水墨汇聚脉冲。低风险为青蓝，临界为金色，危险为赤红，所有颜色和数量使用平滑插值。

## 性能降级

- 地图移动：粒子数量比例降到 `0.56`，尾迹和扩散降低。
- 页面隐藏：暂停 Canvas 动画。
- 帧率下降：从质量 `1.0` 逐步降到最低 `0.56`。
- 手机：限制 DPR 为 1.5，减少高成本光晕和风暴爆发数量。
- 地图不可用：隐藏地图 WebGL 层，保留墨黑网格、粒子系统和风险计算。
- MapLibre 不可用：底图进入降级状态，页面不会卡在无限等待中。

## MapLibre 本地资源

项目已内置官方 MapLibre GL JS 4.7.1 和无锡范围 z9–z12 的 OSM 瓦片，运行时不依赖 MapLibre CDN。需要更新依赖时可执行：

```bash
npm run vendor
```

该命令会把官方 `maplibre-gl.js` 和 `maplibre-gl.css` 覆盖到 `vendor/`。本地 OSM 瓦片位于 `assets/osm-tiles/`，z12 以上由 MapLibre 自动放大显示。

## GitHub Pages 发布

1. 把 `risk-tide-map` 目录推送到 GitHub 仓库。
2. 进入仓库 `Settings → Pages`。
3. 在 `Build and deployment` 中选择 `Deploy from a branch`。
4. 分支选择 `main`，目录选择 `/ (root)`；如果只想发布子目录，推荐把项目放在仓库根目录。
5. 保存后等待 Pages 构建完成。
6. 打开生成的 `https://用户名.github.io/仓库名/`。

项目使用相对路径，不依赖 Vite、Webpack 或后端。若仓库根目录下还有其它文件，建议将 `risk-tide-map` 内容直接作为 Pages 根目录，或在 Pages 设置中选择包含它的目录。

## 项目结构

```text
risk-tide-map/
├── index.html
├── styles.css
├── START_MAP.bat
├── serve.js
├── package.json
├── README.md
├── DATA_SOURCES.md
├── AI_USAGE.md
├── .nojekyll
├── js/
│   ├── app.js
│   ├── map.js
│   ├── amap-map.js
│   ├── weather.js
│   ├── weather-visual.js
│   ├── particles.js
│   ├── flow-field.js
│   ├── risk.js
│   └── ui.js
├── data/
│   ├── config.js
│   └── routes.js
├── assets/
│   ├── marker-campus.svg
│   ├── marker-station.svg
│   ├── ink-texture.png
│   └── osm-tiles/
├── scripts/
│   └── vendor-maplibre.js
└── vendor/
    ├── maplibre-gl.js
    └── maplibre-gl.css
```

## 已知边界

- 风险是时间缓冲风险，不是实时交通或事故预测；天气只作为额外加时项接入，不是气象预报结论。
- OSM 底图是公共栅格瓦片，访问量较大时应遵循 OSM 瓦片使用政策并自行选择合规瓦片服务。
- 当前端点坐标和路线时间必须在真实使用前替换。
- 本页面不包含用户账号、后端或数据库；唯一的外部实时请求是浏览器直连 Open-Meteo 天气接口（不含任何用户信息，只有路线中点的经纬度）。








