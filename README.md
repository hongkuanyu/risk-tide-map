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
路线时间 + 站内流程时间
```

安全缓冲：

```text
可用时间 - 必需时间
```

最晚安全出发时间：

```text
高铁发车时间 - 路线时间 - 站内流程时间 - 60 分钟
```

风险值：

```text
缓冲 >= 60：0
缓冲 <= 0：100
其他：((60 - 缓冲) / 60) × 100
```

时间差使用 24 小时循环计算，因此支持跨天；例如 `23:40 → 00:20` 会按 40 分钟计算。

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

- 风险是时间缓冲风险，不是实时交通、天气或事故预测。
- OSM 底图是公共栅格瓦片，访问量较大时应遵循 OSM 瓦片使用政策并自行选择合规瓦片服务。
- 当前端点坐标和路线时间必须在真实使用前替换。
- 本页面不包含用户账号、后端、数据库或任何实时交通接口。






