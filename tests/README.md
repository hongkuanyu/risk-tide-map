# 单程墨线 · 浏览器回归测试

真实浏览器（Edge / Chrome，通过 DevTools Protocol 直接驱动，不依赖任何 npm 包）里验证
单程墨线的行为。它覆盖的正是"改一行渲染就悄悄回退"的那些点：路线真实性、地图同步、
交互动线、笔触稳定性、动画计时、规划失败与乱序响应、异常几何、长路线、屏幕矩阵、全国模式回归。

## 运行

```powershell
# 1) 起本地静态服务（另一个终端）
npm start                 # http://localhost:8123

# 2) 跑回归（约 8-10 分钟；14 个场景 / 140 项检查）
npm run test:browser

# 只跑某几个场景
node tests/browser-check.js pan hover planning viewports
# 场景名：real pan hover touch width fps reduced planning geometry longroute
#        routechange amap viewports nation
```

需要本机有 Edge 或 Chrome；用 `CHROME_PATH` 指定浏览器，用 `BASE_URL` 指向别的地址。
其中 `amap` / `deployed-probe` 需要外网；没有外网时 `amap` 会明确标记为「跳过」而不是通过。

> 注意：如果开发环境把 localhost 关在沙箱里（例如 Codex 的 workspace 沙箱），
> 浏览器测试要在沙箱外运行；服务也一样。

## 文件

| 文件 | 用途 |
|---|---|
| `cdp.js` | 极简 CDP 客户端（启动无头浏览器、导航、注入、鼠标 / 触摸 / 键盘、截图、CPU 降速） |
| `browser-check.js` | 回归测试主程序；失败项会打印出来并以非 0 退出码结束 |
| `capture.js` | 截图对照：同一套操作在任意版本上跑一遍，产出可对比的截图 |
| `amap-probe.js` | 高德（真实底图 + 真实路线规划）路径的检查，需要外网 |
| `amap-errors.js` | 分别对两个版本跑高德路径，比较控制台错误 |
| `ink-weight.js` | 墨线笔重测量：同一段几何量出各层笔触的像素宽度、墨迹总量与平均浓度；加 `RISK_HIGH=1` 看高风险配色、加 `PRESET=bold|mid|ink` 在同一份代码上对比三种笔触取向（A/B 对照用） |
| `deployed-probe.js` | 线上（GitHub Pages 正式域名）只读体检：高德规划是否可用、线上当前表现、控制台错误 |

## 截图对照

```powershell
# 当前代码
$env:PREFIX='after';  node tests/capture.js
# 与历史版本对照（把 HEAD 导出到临时目录后另起一个端口）
git archive --format=zip -o $env:TEMP\before.zip HEAD
$env:BASE_URL='http://localhost:8124'; $env:PREFIX='before'; node tests/capture.js
```

截图写到 `.shots/`（已在 .gitignore 中）。

## 覆盖的场景

| 场景 | 检查内容 |
|---|---|
| `real` | 真实道路几何 → 完整水墨笔触（含芯光层）；无道路几何 → 细虚线示意 + 明确徽标（且不发光）；起终点投影与底图 marker 重合 |
| `pan` | 拖动 / 滚轮缩放（指针不动）/ 惯性滑动时墨线与底图的最大错位；停下完全对齐；静止后回到低频渲染 |
| `hover` | 悬停浮层六项读数、不越界、点击钉住、点空白收起、Enter / 方向键 / Esc、aria 状态 |
| `touch` | 390×780 触摸设备上点按墨线出现浮层（DPR 3） |
| `width` | 已落纸的位置不会因为整条线继续生长而反复变粗变细 |
| `fps` | 60 / 10 / 4 fps 下写线动画都在 growSeconds 附近完成，且进度单调 |
| `reduced` | `prefers-reduced-motion`：不播动画但仍完整绘制，拖动后仍对齐 |
| `planning` | 规划失败（起终点变了 / 没变两种）、乱序响应只认最新结果、variant 时长不残留 |
| `geometry` | 折返 / 重复点 / 极短段 / 起终点重合 / 单点：不出现尖刺、不越出笔触包络 |
| `routechange` | 路线一变墨线就变（画布层取证）：换方案、换交通方式（真实↔示意）、换起终点后规划成功、规划失败、只改时间（几何不动 / 墨色变深） |
| `longroute` | 2000+ 点长路线：点数被上限兜住、单帧重投影/绘制在预算内、重采样不削角（≤3px） |
| `amap` | 生产路径：高德底图 + 注入真实几何 → WGS84→GCJ02 投影与高德 marker 重合、拖动/缩放跟随、浮层、失败不留旧路线（需外网） |
| `viewports` | 1920/1366/768/390/320 五档 × DPR 1—3：画布分辨率、对齐、无横向溢出、浮层与徽标不越界、marker 与真实坐标重合 |
| `nation` | 全国模式仍是 43 城墨场、图例与页脚不变、不受单程墨线改动影响 |