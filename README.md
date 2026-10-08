# 风险潮汐：一张高铁票的最后一小时

一个无需后端、无需账号、可直接部署到 GitHub Pages 的互动地图。  
全国视图以城市时间风险归一化生成连续墨场；单程视图以一次性生长的三层墨线呈现路线。

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

如果 Node.js 启动失败，也可以直接双击 `index.html`；地图瓦片和风险计算仍可运行。完整 OSM 底图仍建议使用 `START_MAP.bat` 启动本地服务器。

默认打开全国潮汐视图；在地址后添加 `?route=1` 可查看单程墨线。

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

路线墨线从目的地向起点生长。若路线坐标缺失，页面使用两端点之间的**示意虚线**并在界面附近显示风险警告。

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
- 高德地图坐标与 Canvas 水墨渲染联动

前端 Map JS API Key 本身会出现在浏览器源代码中，这是高德 JS API 的正常方式；必须使用域名白名单限制，不能使用无限制的 Key。

## 水墨渲染

- 全国墨场将邻近城市风险按空间核权重归一化混合；城市密集不会通过透明度叠加自然变黑。
- 风险使用 OKLab 连续插值，并按真实帧间隔缓动；极高风险才会透出少量朱砂。
- 单程路线以墨晕、墨肉和墨骨逐次写出，写完后停留；不使用粒子或循环飞行效果。
- 场景切换：默认全国视图；`?route=1` 打开单程视图。页面隐藏时暂停渲染，尊重 `prefers-reduced-motion`。
- 全国行程是可解释的距离示意，并非实时交通或铁路时刻表；起终点和部分路线仍待核验。

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
│   ├── nation-ink.js
│   ├── ink-flow.js
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






