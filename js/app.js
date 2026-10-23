/* global window, document */
(function (global) {
  'use strict';

  const config = global.RiskTideConfig;
  const riskModel = global.RiskTideRisk;

  function clamp01(value) { return Math.min(1, Math.max(0, value)); }

  function createApp() {
    /* 单程墨线是唯一模式：不再有全国 / 单程双模式切换 */

    const search = global.location ? global.location.search : '';
    const host = global.location ? global.location.hostname : '';
    const allowAmapHost = host === 'hongkuanyu.github.io' || /[?&]amap=1(?:&|$)/.test(search);
    const forceOsm = /[?&]osm=1(?:&|$)/.test(search);
    const useAmap = !!(config.amap && config.amap.enabled && config.amap.key
      && global.RiskTideAmapMap && allowAmapHost && !forceOsm);
    const amapMissingKey = !!(config.amap && config.amap.enabled && !config.amap.key);
    const mapController = useAmap ? new global.RiskTideAmapMap() : new global.RiskTideMap();
    const shell = document.getElementById('map-shell');
    const silkCanvas = document.getElementById('silk-canvas');
    const silk = (config.silk && config.silk.enabled && global.RiskTideSilkRoute && silkCanvas)
      ? new global.RiskTideSilkRoute(silkCanvas, mapController)
      : null;
    /* One slot, two backends. They expose the same API, so every call site
       below is backend-agnostic and the WebGL2 path can be adopted (or rolled
       back) by flipping config.inkGL.enabled. */
    const statusLine = document.getElementById('status-line');
    if (statusLine) statusLine.textContent = '移近路线，查看时间余量';

    const inkGL = (config.inkGL && config.inkGL.enabled && global.RiskTideInkGL && silkCanvas)
      ? new global.RiskTideInkGL(silkCanvas, mapController)
      : null;
    const inkFlow = (inkGL && !inkGL.failed) ? inkGL
      : ((config.inkFlow && config.inkFlow.enabled && global.RiskTideInkFlow && silkCanvas)
        ? new global.RiskTideInkFlow(silkCanvas, mapController)
        : null);
    const ui = new global.RiskTideUI(global.routes);
  /* 无默认起终点时，内置演示几何不再对应任何端点：启动即清空，避免画出旧路线 */
  invalidateStaleRoutes();

    /* The ink-map palette lives in data/config.js; publish it to CSS so the
       pigment blooms, the map filter and the paper grain have one source of
       truth between the config and the stylesheet. */
    function applyInkMapTheme() {
      const ink = config.inkMap;
      const shell = document.getElementById('map-shell');
      if (!ink || !ink.enabled || !shell) return;
      if (ink.blooms && ink.blooms.length) {
        const parts = ink.blooms.map(function (b) {
          return 'radial-gradient(' + b.rx + '% ' + b.ry + '% at ' + b.x + '% ' + b.y + '%, rgba('
            + b.color + ',' + b.alpha + '), transparent 72%)';
        });
        parts.push(ink.baseWash);
        shell.style.setProperty('--ink-blooms', parts.join(', '));
      }
      if (ink.canvasFilter) shell.style.setProperty('--ink-canvas-filter', ink.canvasFilter);
      if (ink.textureOpacity !== undefined) {
        shell.style.setProperty('--ink-texture-opacity', String(ink.textureOpacity));
      }
      /* 图例色条直接取自配置里的色阶（唯一色源）：
         路线墨线的风险通道是"流光"（coreRamp），所以图例用光脉色阶。 */
      const ramps = [config.ink && config.ink.coreRamp];
      for (let r = 0; r < ramps.length; r += 1) {
        const ramp = ramps[r];
        if (!ramp || !ramp.length) continue;
        const stops = ramp.map(function (stop) {
          return 'rgb(' + stop.rgb.join(',') + ') ' + Math.round(stop.at * 100) + '%';
        });
        shell.style.setProperty('--ink-ramp-gradient', 'linear-gradient(90deg, ' + stops.join(', ') + ')');
        break;
      }
    }
    applyInkMapTheme();
    let lastRouteKey = null;
    let latestResult = null;
    /* 路线规划请求序号：晚到的旧响应一律丢弃，避免旧路线覆盖新路线。 */
    let planSeq = 0;
    let planPending = false;
    let planFailure = null;

    function beginPlan() {
      planSeq += 1;
      planPending = true;
      planFailure = null;
      return planSeq;
    }

    function guardFor(seq) {
      return function () { return seq === planSeq; };
    }

    function supportsPlanning() {
      return !!(mapController && typeof mapController.supportsPlanning === 'function'
        && mapController.supportsPlanning());
    }

    function sameCoordinate(a, b) {
      if (!a || !b || !a.coordinate || !b.coordinate) return false;
      return Math.abs(a.coordinate[0] - b.coordinate[0]) < 1e-9
        && Math.abs(a.coordinate[1] - b.coordinate[1]) < 1e-6;
    }

    /* 内置演示几何（data/routes.js）只对内置起终点成立。起终点没动，它就是
       这条路的真实道路数据，可以留着；起终点一动，它就不再对应，必须让位。 */
    function bundledGeometryValid(route) {
      if (!route || route.origin === 'plan') return false;
      if (!Array.isArray(route.coordinates) || route.coordinates.length < 2) return false;
      const live = (mapController.getEndpoints && mapController.getEndpoints()) || {};
      const builtin = config.endpoints || {};
      return sameCoordinate(live.campus, builtin.campus)
        && sameCoordinate(live.station, builtin.station);
    }

    function hasRoadGeometry(route) {
      return !!(route && Array.isArray(route.coordinates) && route.coordinates.length >= 2);
    }

    /* 几何与时长必须一起清：getActiveRoute 会把 variant 的时长合并上来，
       只清 route 上的值会让旧行程时间从 variant 里"复活"。 */
    function clearRouteGeometry(route) {
      route.coordinates = [];
      if (route.variants) {
        route.variants = route.variants.map(function (variant) {
          return Object.assign({}, variant, {
            coordinates: [],
            durationMinutes: null,
            distanceMeters: 0,
            rawDurationSeconds: 0
          });
        });
      }
      route.durationMinutes = null;
      route.distanceMeters = 0;
      route.rawDurationSeconds = 0;
    }

    /* 起终点变了 / 本轮没返回：清掉不再成立的几何，等新结果落地。 */
    function invalidateStaleRoutes() {
      ['taxi', 'bus'].forEach(function (key) {
        const route = global.routes[key];
        if (!route) return;
        route.failed = false;
        route.reason = '';
        if (bundledGeometryValid(route)) return;   /* 内置几何仍对应当前起终点 */
        clearRouteGeometry(route);
      });
    }

    /* 这条线是"真实道路"还是"仅起终点示意"：渲染器只负责画，判定留在这一层。 */
    function inkStatusFor(route) {
      if (hasRoadGeometry(route)) return { kind: 'road', reason: planFailure || '' };
      if (planFailure) return { kind: 'failed', reason: planFailure };
      return { kind: 'preview', reason: '' };
    }

    function routeSignature(route, status) {
      const coords = route && Array.isArray(route.coordinates) ? route.coordinates : [];
      const first = coords.length ? coords[0][0].toFixed(4) + ',' + coords[0][1].toFixed(4) : '';
      const last = coords.length
        ? coords[coords.length - 1][0].toFixed(4) + ',' + coords[coords.length - 1][1].toFixed(4) : '';
      /* 真实几何只看几何本身：规划失败的说明变化不该让墨线重写一遍 */
      const reason = status.kind === 'road' ? '' : (status.reason || '');
      return [status.kind, coords.length, first, last, (route && route.source) || '',
        (route && route.variantId) || '', reason].join('|');
    }

    /* 端点是否齐全：起终点都填了才有"规划失败"这回事，否则只是待输入。 */
    function hasBothEndpoints() {
      const eps = (mapController && typeof mapController.getEndpoints === 'function')
        ? mapController.getEndpoints() : {};
      return !!(eps && eps.campus && eps.campus.coordinate && eps.station && eps.station.coordinate);
    }

    function endpointPrompt() {
      const eps = (mapController && typeof mapController.getEndpoints === 'function')
        ? mapController.getEndpoints() : {};
      const hasOrigin = !!(eps && eps.campus && eps.campus.coordinate);
      const hasDest = !!(eps && eps.station && eps.station.coordinate);
      if (hasOrigin && hasDest) return null;
      if (hasOrigin) return '已设置起点，请再输入终点，路线将自动生成。';
      if (hasDest) return '请先输入起点，路线将自动生成。';
      return '请输入起点和终点，路线将自动生成。';
    }

    function markPlanFailed(reason) {
      planPending = false;
      /* 端点不完整是"待输入"，不是"规划失败"：给引导而不是错误。 */
      if (!hasBothEndpoints()) {
        planFailure = null;
        ['taxi', 'bus'].forEach(function (key) {
          const route = global.routes[key];
          if (!route) return;
          route.failed = false;
          route.reason = '';
        });
        ui.refreshRoutes();
        lastRouteKey = null;
        applyState(ui.getState());
        ui.setStatus(endpointPrompt(), 'normal');
        return;
      }
      planFailure = reason || '路线规划失败';
      invalidateStaleRoutes();
      /* 没有可用几何的方式明确打上失败标记：界面不再把上一轮的行程时间当有效读数 */
      let kept = false;
      ['taxi', 'bus'].forEach(function (key) {
        const route = global.routes[key];
        if (!route) return;
        if (hasRoadGeometry(route)) { kept = true; return; }
        route.failed = true;
        route.reason = planFailure;
      });
      ui.refreshRoutes();
      lastRouteKey = null;
      applyState(ui.getState());
      ui.setStatus(kept
        ? '本次路线规划失败：' + planFailure + '（仍显示内置演示几何，非本次规划结果）'
        : '路线规划失败：' + planFailure + '（未展示旧路线）', kept ? 'warning' : 'error');
    }

    function applyPlanResult(seq, routes) {
      if (seq !== planSeq) return false;   /* 已有更新的规划请求，丢弃这次结果 */
      planPending = false;
      if (!routes) {
        markPlanFailed(mapController.lastPlanError || '地图服务未返回可用路线');
        return false;
      }
      planFailure = null;
      ui.refreshRoutes();
      lastRouteKey = null;
      applyState(ui.getState());
      ui.setStatus('已按新的起终点规划路线。', 'normal');
      return true;
    }

    function replanForEndpoints() {
      /* 立刻清掉不再对应当前起终点的几何，不让旧路线继续冒充新路线 */
      invalidateStaleRoutes();
      planFailure = null;
      lastRouteKey = null;
      ui.refreshRoutes();
      applyState(ui.getState());
      if (!supportsPlanning()) return Promise.resolve(null);
      const seq = beginPlan();
      ui.setStatus('正在重新规划路线…', 'loading');
      return mapController.replanRoutes(guardFor(seq)).then(function (routes) {
        return applyPlanResult(seq, routes);
      }).catch(function (error) {
        if (seq !== planSeq) return null;
        markPlanFailed((error && error.message) || '路线规划失败');
        return null;
      });
    }

    function getSelectedRoute(state) {
      return state.mode ? ui.getActiveRoute(state) : null;
    }

    function pushRisk(risk) {
      if (silk) silk.setRisk(risk);
      if (inkFlow) inkFlow.setRisk(risk);
      mapController.setRisk(risk);
    }

    function applyState(state) {
      const result = riskModel.calculate({
        trainTime: state.trainTime,
        departureTime: state.departureTime,
        routeMinutes: state.routeMinutes,
        stationMinutes: state.stationMinutes,
        safeBufferMinutes: config.risk.safeBufferMinutes
      });
      latestResult = result;

      const route = getSelectedRoute(state);
      const status = inkStatusFor(route);
      /* 只有真实道路几何交给渲染器；其余情况只画弱化的起终点示意 */
      const drawable = status.kind === 'road' ? route : null;
      const routeKey = (state.mode ? state.mode + ':' + (state.variantId || 'default') : 'none')
        + '::' + routeSignature(route, status);
      if (routeKey !== lastRouteKey) {
        mapController.setRoute(drawable);
        if (silk) silk.setRoute(drawable);
        if (inkFlow) inkFlow.setRoute(drawable, status);
        hideRouteTip();
        lastRouteKey = routeKey;
      }
      /* 提示条 / 徽标随规划状态变化，不受"几何是否变化"限制 */
      updateRouteNotice();

      pushRisk(result.valid ? result.risk : 0);
      /* 浮层打开时随状态刷新读数，不改变它的位置 */
      refreshRouteTip();

      return result;
    }

    /* ---- 墨线浮层 / 真实性徽标 ------------------------------------------
       浮层读数与面板同源（ui.getRouteSummary），颜色语义只有一条：
       墨色 = 整段行程的时间余量，不是某段道路的实时拥堵。 */
    const routeTip = (shell && global.RiskTideRouteTip)
      ? new global.RiskTideRouteTip(shell, document.getElementById('route-tip')) : null;
    const tip = {
      show: function (anchorPoint, content) {
        if (routeTip && routeTip.isAvailable()) routeTip.show(anchorPoint, content);
      },
      hide: function () { if (routeTip) routeTip.hide(); },
      visible: function () { return !!(routeTip && routeTip.visible); },
      anchorPoint: function () { return routeTip ? routeTip.anchor : null; }
    };

    function requestInkFrame() {
      if (inkFlow && typeof inkFlow.requestFrame === 'function') inkFlow.requestFrame();
    }

    /* 这条线到底可不可信：徽标与状态行共用一份判断，没有疑问时不出提示条。 */
    function routeNotice() {
      const state = ui.getState();
      const road = hasRoadGeometry(getSelectedRoute(state));
      if (!hasBothEndpoints()) {
        return { kind: 'preview', text: endpointPrompt() };
      }
      if (planFailure) {
        return road
          ? { kind: 'demo', text: '本次规划失败：' + planFailure + ' · 显示内置演示几何（非本次规划结果）' }
          : { kind: 'failed', text: '路线规划失败：' + planFailure + ' · 未展示旧路线' };
      }
      if (road) return null;
      if (planPending) return { kind: 'pending', text: '正在重新规划路线… · 当前仅为起终点示意' };
      if (!state.mode) return { kind: 'preview', text: '尚未选择出行方式 · 当前仅为起终点示意' };
      return { kind: 'preview', text: '非真实道路路线 · 仅以直线示意起终点' };
    }

    function updateRouteNotice() {
      const notice = document.getElementById('route-authenticity');
      if (!notice) return;
      const info = routeNotice();
      if (!info) {
        notice.hidden = true;
        notice.textContent = '';
        notice.dataset.kind = 'none';
        return;
      }
      if (notice.textContent !== info.text) notice.textContent = info.text;
      notice.dataset.kind = info.kind;
      notice.hidden = false;
    }

    function routeHintStatus() {
      return inkStatusFor(getSelectedRoute(ui.getState()));
    }

    /* 交通方式 / 预计行程 / 计划出发 / 安全预留 / 剩余余量 / 风险等级 */
    function routeTipContent() {
      const summary = ui.getRouteSummary();
      const status = routeHintStatus();
      if (status.kind !== 'road') {
        return {
          signature: 'hint:' + status.kind + ':' + (status.reason || '') + ':' + summary.mode,
          title: '非真实道路路线',
          rows: [
            { label: '交通方式', value: summary.modeLabel },
            { label: '几何来源', value: '仅起终点示意' }
          ],
          note: status.kind === 'failed'
            ? '规划失败：' + (status.reason || '未知原因') + '，未沿用旧路线与旧时间。'
            : '没有道路几何时不给出行程读数，以免把直线误读成真实路线。'
        };
      }
      const buffer = summary.valid ? summary.bufferMinutes : null;
      return {
        signature: ['road', summary.mode, summary.routeMinutes, summary.departureTime,
          summary.stationMinutes, summary.valid ? Math.round(summary.risk) : 'x'].join(':'),
        title: '时间余量',
        rows: [
          { label: '交通方式', value: summary.modeLabel },
          { label: '预计行程', value: summary.routeMinutes ? summary.routeMinutes + ' 分钟' : '待填写' },
          { label: '计划出发', value: summary.departureTime },
          { label: '安全预留', value: summary.safeBufferMinutes + ' 分钟' },
          {
            label: '剩余余量',
            value: buffer === null ? '待设定'
              : (buffer > 0 ? '+' : '') + Math.round(buffer) + ' 分钟',
            tone: summary.level
          },
          {
            label: '风险等级',
            value: summary.valid
              ? summary.riskLabel + ' · ' + Math.round(summary.risk) + '/100' : '待设定',
            tone: summary.level
          }
        ],
        note: status.reason
          ? '本次规划失败：' + status.reason + '；显示的是内置演示几何。'
          : (summary.valid
            ? '墨色深浅表示整段行程的时间余量，不是路段实时拥堵。'
            : '填写行程时间后这里会显示时间余量。')
      };
    }

    function routeTipLine() {
      const summary = ui.getRouteSummary();
      const status = routeHintStatus();
      if (status.kind === 'failed') return '路线规划失败：' + (status.reason || '未知原因');
      if (status.kind !== 'road') return '非真实道路路线 · 仅起终点示意';
      if (!summary.valid) return summary.modeLabel + ' · 时间条件待填写';
      const buffer = Math.round(summary.bufferMinutes);
      return summary.modeLabel + ' · 预计 ' + summary.routeMinutes + ' 分钟 · 余量 '
        + (buffer > 0 ? '+' : '') + buffer + ' 分钟 · ' + summary.riskLabel;
    }

    function hideRouteTip() {
      tip.hide();
      if (inkFlow && typeof inkFlow.setHover === 'function') inkFlow.setHover(0);
    }

    /* 状态变化时刷新已打开的浮层内容（位置不动）。 */
    function refreshRouteTip() {
      if (!tip.visible()) return;
      const anchorPoint = tip.anchorPoint();
      if (!anchorPoint) return;
      tip.show(anchorPoint, routeTipContent());
    }

    /* 单程墨线：桌面悬停、移动端点击 / 触摸、键盘均可读到同一份读数。 */
    if (inkFlow && shell) {
      let pinned = false;
      let keyboardOffset = 0.5;

      const hitAt = function (clientX, clientY) {
        if (typeof inkFlow.hitTest !== 'function') return null;
        const rect = shell.getBoundingClientRect();
        return inkFlow.hitTest(clientX - rect.left, clientY - rect.top);
      };
      /* 锚点沿法线离开墨线 12px：浮层靠边放置时不会盖住笔画本身 */
      const anchorFor = function (hit) {
        return { x: hit.x + (hit.nx || 0) * 12, y: hit.y + (hit.ny || 0) * 12 };
      };
      const paint = function (hit) {
        inkFlow.setHover(hit ? hit.strength : 0);
        if (!hit) { tip.hide(); return; }
        tip.show(anchorFor(hit), routeTipContent());
        ui.setStatus(routeTipLine(), 'normal');
      };
      const release = function () {
        pinned = false;
        inkFlow.setHover(0);
        tip.hide();
        ui.setStatus('移近路线，查看时间余量', 'normal');
      };

      shell.addEventListener('pointermove', function (event) {
        if (event.target.closest('button, input, select, a')) { inkFlow.setHover(0); return; }
        /* 触摸 / 笔不参与悬停：拖动地图时不抢浮层，交给 click（点按）与键盘 */
        if (event.pointerType && event.pointerType !== 'mouse') return;
        const hit = hitAt(event.clientX, event.clientY);
        /* 浮层被点按钉住后，只有再次点击空白或 Esc 才收起：鼠标滑开不打断阅读 */
        if (pinned) { inkFlow.setHover(hit ? hit.strength : 0); return; }
        paint(hit);
      });

      shell.addEventListener('pointerleave', function () {
        if (pinned) return;
        inkFlow.setHover(0);
        tip.hide();
      });

      /* 点击 / 触摸：把浮层钉在落点上，再点空白处收起 */
      shell.addEventListener('click', function (event) {
        if (event.target.closest('button, input, select, a')) return;
        const hit = hitAt(event.clientX, event.clientY);
        if (hit) { pinned = true; paint(hit); } else if (pinned) { release(); }
      });

      /* 键盘：地图区域可聚焦，Enter / 空格开合浮层，左右方向键沿墨线移动 */
      shell.addEventListener('keydown', function (event) {
        const open = tip.visible();
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          if (open && pinned) { release(); } else {
            pinned = true;
            const point = typeof inkFlow.midpointAt === 'function' ? inkFlow.midpointAt(keyboardOffset) : null;
            if (!point) return;
            tip.show({ x: point.x, y: point.y }, routeTipContent());
            ui.setStatus(routeTipLine(), 'normal');
          }
          event.preventDefault();
          return;
        }
        if (event.key === 'Escape' && open) {
          release();
          event.preventDefault();
          return;
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          if (!open || typeof inkFlow.midpointAt !== 'function') return;
          keyboardOffset = clamp01(keyboardOffset + (event.key === 'ArrowRight' ? 0.05 : -0.05));
          const point = inkFlow.midpointAt(keyboardOffset);
          if (point) tip.show({ x: point.x, y: point.y }, routeTipContent());
          event.preventDefault();
        }
      });
    }

    ui.onChange = applyState;

    const initPlanSeq = beginPlan();
    mapController.init({
      guard: guardFor(initPlanSeq),
      container: document.getElementById('map'),
      canvasStage: document.getElementById('map-shell'),
      onMovement: function (moving) {
        if (silk) silk.routeDirty = true;
        /* 关键：标脏之后必须请求一帧，否则滚轮缩放（指针不动、没有 hover 事件）
           和惯性滑动时墨线会停在旧投影上，肉眼可见地掉队。 */
        if (inkFlow) { inkFlow.routeDirty = true; requestInkFrame(); }
        /* Skip the hue-selective pigment passes while the map is moving so
           panning/zooming keeps its frame budget. */
        if (shell) shell.classList.toggle('is-moving', !!moving);
        if (!moving) {
          global.setTimeout(function () {
            if (silk) silk.routeDirty = true;
            if (inkFlow) { inkFlow.routeDirty = true; requestInkFrame(); }
          }, 80);
        }
      },
      onStatus: function (status) {
        if (status.state === 'ready') {
          if (silk) { silk.resize(); silk.routeDirty = true; }
          if (inkFlow) { inkFlow.resize(); inkFlow.routeDirty = true; requestInkFrame(); }
          ui.setStatus('路线已载入 · 可调整时间条件', 'normal');
        } else {
          ui.setStatus(status.message || '地图已降级，风险计算仍可使用。', 'warning');
        }
      },
      onRoutesReady: function (plannedRoutes) {
        /* 本轮没有返回的方式要清掉几何：否则新起终点会配上上一轮的道路与时间 */
        ['taxi', 'bus'].forEach(function (key) {
          if (plannedRoutes[key]) return;
          const current = global.routes[key];
          if (!current) return;
          if (bundledGeometryValid(current)) return;   /* 内置几何仍对应当前起终点 */
          clearRouteGeometry(current);
        });
        Object.keys(plannedRoutes).forEach(function (key) {
          /* 打上"来自规划"的标记：这些几何只对本次起终点成立，
             换了起终点或下次规划失败都不能继续沿用。 */
          const planned = Object.assign({}, plannedRoutes[key], { origin: 'plan' });
          global.routes[key] = planned;
        });
        ui.refreshRoutes();
        lastRouteKey = null;
        applyState(ui.getState());
      }
    }).then(function (routes) {
      /* 无在线规划能力（OpenStreetMap 降级 / 本地演示几何）：保留内置路线 */
      if (!supportsPlanning()) {
        planPending = false;
        lastRouteKey = null;
        applyState(ui.getState());
        return;
      }
      applyPlanResult(initPlanSeq, routes);
    });
    if (inkFlow) inkFlow.start();
    applyState(ui.getState());


    function syncSearch() {
      if (global.RiskTideSearch) global.RiskTideSearch.sync();
    }

    function initLocationSearch() {
      var originInput = document.getElementById('origin-input');
      var destInput = document.getElementById('dest-input');
      if (!originInput || !destInput || !global.RiskTideLocationSearch) return;
      var initial = mapController.getEndpoints ? mapController.getEndpoints() : {};
      originInput.value = (initial.campus && (initial.campus.shortName || initial.campus.name)) || '';
      destInput.value = (initial.station && (initial.station.shortName || initial.station.name)) || '';
      global.RiskTideSearch = new global.RiskTideLocationSearch({
        originInput: originInput,
        destInput: destInput,
        swapButton: document.getElementById('search-swap'),
        locateButton: document.getElementById('search-locate'),
        hint: document.getElementById('search-hint'),
        onSelect: function (role, extra, city) {
          var updates = {};
          if (role === 'both') {
            updates.campus = extra.campus;
            updates.station = extra.station;
          } else if (role === 'origin' || role === 'campus') {
            updates.campus = extra;
          } else if (role === 'dest' || role === 'station') {
            updates.station = extra;
          }
          if (city) updates.city = city;
          mapController.setEndpoints(updates);
          /* 起终点一变：旧几何立即失效，新结果落地前只显示起终点示意 */
          replanForEndpoints();
        },
        onLocate: function () {
          ui.setStatus('已按当前位置更新起点。', 'normal');
        }
      });
      syncSearch();
      global.setInterval(syncSearch, 1200);
    }

    initLocationSearch();

    global.addEventListener('risktide:interaction', function () {
      if (!ui.getState().mode) ui.selectMode('taxi');
      else applyState(ui.getState());
    });

    function handleVisibility() {
      const visible = !document.hidden;
      if (silk) silk.setVisible(visible);
      if (inkFlow) inkFlow.setVisible(visible);
    }

    document.addEventListener('visibilitychange', handleVisibility);

    let resizeTimer = 0;
    global.addEventListener('resize', function () {
      global.clearTimeout(resizeTimer);
      resizeTimer = global.setTimeout(function () {
        mapController.resize();
        if (silk) { silk.resize(); silk.routeDirty = true; }
        if (inkFlow) { inkFlow.resize(); inkFlow.routeDirty = true; requestInkFrame(); }
      }, 120);
    }, { passive: true });

    global.setInterval(function () {
      if (document.hidden) return;
      if (inkFlow) {
        const flow = inkFlow.getMetrics();
        ui.updateMetrics({ text: '单程墨线 · ' + flow.points + ' 个路线采样点' });
      }
    }, 1800);

    global.RiskTideApp = {
      map: mapController,
      silk: silk,
      inkFlow: inkFlow,
      ui: ui,
      result: function () { return latestResult; }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createApp, { once: true });
  } else {
    createApp();
  }
})(window);








