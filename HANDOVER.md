# 项目交接说明

## 当前视图

| 地址 | 视图 |
|---|---|
| `/risk-tide-map/` | 全国时间风险墨场（默认） |
| `/risk-tide-map/?route=1` | 单程路线墨线 |

两种视图复用同一张地图、风险模型、地点搜索和时间控件。全国行程使用直线距离推算，是可解释示意，不是实时交通或铁路时刻表。

## 渲染实现

- `js/nation-ink.js` 将城市风险按空间核权重归一化，生成低分辨率连续墨场；风险色在 OKLab 中插值，渲染风险按真实帧间隔缓动。城市不逐个绘制圆形 marker。
- `js/ink-flow.js` 缓存路线几何，以目的地到起点的方向一次性绘制墨晕、墨肉、墨骨三层渐变宽度笔迹。笔迹完成后停留，不循环、不生成粒子。
- 两个渲染器在标签页隐藏时暂停，遵守 `prefers-reduced-motion`。
- `js/risk.js` 的缓冲时间和风险算法保持不变。

## 数据边界

- `data/cities.js` 中城市坐标是近似值，`verified: false`。
- 校门、站前入口、路线几何与行程时间仍需现场或可靠数据源核验。
- 风险读数表示计划时间余量，不是迟到概率，也不接入天气、实时交通或事故数据。
- 浏览器端高德 API Key 必须使用域名白名单限制。

## 关键文件

| 文件 | 职责 |
|---|---|
| `index.html` | 应用入口、视图导航和脚本加载 |
| `styles.css` | 编辑式布局、地图与移动端样式 |
| `js/app.js` | 地图、时间表单与渲染器协调 |
| `js/nation-ink.js` | 全国归一化墨场 |
| `js/ink-flow.js` | 单程连续墨线 |
| `js/risk.js` | 时间风险计算 |
| `js/nation-risk.js` | 全国示意行程风险 |
| `data/config.js` | 地图、API 与视图默认值 |

## 本地检查与发布

```powershell
node --check js/app.js
node --check js/nation-ink.js
node --check js/ink-flow.js
npm start
```

GitHub Pages 从 `main` 分支根目录发布；合并或推送到 `main` 后等待 Pages 更新，再检查默认首页和 `?route=1`。
