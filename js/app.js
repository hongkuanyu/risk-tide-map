/* global window, document */
(function (global) {
  'use strict';

  const config = global.RiskTideConfig;
  const riskModel = global.RiskTideRisk;

  function createApp() {
    /* 全国模式：在创建地图控制器之前套用全国视野（覆盖 center/zoom/maxBounds），
       这样锁死无锡的 maxBounds 不会把 43 座城市挡在画布外。 */
    const routeView = /[?&]route=1(?:&|$)/.test(global.location ? global.location.search : '');
    const nationOn = !routeView && (!!(config.nation && config.nation.enabled)
      || /[?&]nation=1(?:&|$)/.test(global.location ? global.location.search : ''));
    const viewLink = document.querySelector('.view-nav [data-view="' + (nationOn ? 'nation' : 'route') + '"]');
    if (viewLink) viewLink.setAttribute('aria-current', 'page');
    if (nationOn && config.nation.map) {
      const nm = config.nation.map;
      config.map.center = nm.center;
      config.map.zoom = nm.zoom;
      config.map.minZoom = nm.minZoom;
      config.map.maxZoom = nm.maxZoom;
      config.map.maxBounds = nm.maxBounds;
      if (config.amap) config.amap.zoom = nm.amapZoom;
    }

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
    /* 全国墨迹与单路线墨流二选一：nation 开启时不启动单路线渲染器 */
    const nationCanvas = document.getElementById('nation-canvas');
    const nationInk = (nationOn && global.RiskTideNationInk && nationCanvas)
      ? new global.RiskTideNationInk(nationCanvas, mapController) : null;

    if (nationInk && shell) shell.dataset.nation = 'on';
    if (nationOn) {
      const legend = document.querySelector('.map-legend');
      if (legend) {
        legend.setAttribute('aria-label', '时间风险浓度图例');
        legend.innerHTML = '<span>宽裕</span><i class="legend-risk-scale" aria-hidden="true"></i><span>紧迫</span>';
      }
    } else {
      const status = document.getElementById('status-line');
      if (status) status.textContent = '移近路线，查看时间余量';
    }

    function refreshNation() {
      if (!nationInk) return;
      const state = ui.getState();
      const eps = (mapController.getEndpoints && mapController.getEndpoints()) || config.endpoints;
      const origin = (eps.campus && eps.campus.coordinate) || config.endpoints.campus.coordinate;
      const rows = global.RiskTideNationRisk.computeAll(global.RiskTideCities.list, origin, {
        trainTime: state.trainTime,
        departureTime: state.departureTime,
        stationMinutes: state.stationMinutes,
        safeBufferMinutes: config.risk.safeBufferMinutes,
        mode: (config.nation && config.nation.mode) || 'rail'
      });
      nationInk.setData(rows);
      /* 全国模式下首屏答案应给全国结论，而不是本地路线时间 */
      const heroLatest = document.getElementById('hero-latest');
      const heroBuffer = document.getElementById('hero-buffer');
      const heroLabel = document.querySelector('.hero-label');
      const reachable = rows.filter(function (r) { return r.risk !== null && r.risk < 30; });
      const tight = rows.filter(function (r) { return r.risk !== null && r.risk >= 30 && r.risk < 70; });
      if (heroLabel) heroLabel.textContent = '最远安全可达';
      if (heroLatest) {
        let farthest = null;
        reachable.forEach(function (r) { if (!farthest || r.distanceKm > farthest.distanceKm) farthest = r; });
        heroLatest.textContent = farthest ? farthest.city.name : '暂无';
      }
      if (heroBuffer) {
        heroBuffer.textContent = '全国 ' + rows.length + ' 城中 ' + reachable.length + ' 城宽裕'
          + (tight.length ? ' · ' + tight.length + ' 城偏紧' : '');
      }
    }

    const inkGL = (config.inkGL && config.inkGL.enabled && global.RiskTideInkGL && silkCanvas)
      ? new global.RiskTideInkGL(silkCanvas, mapController)
      : null;
    const inkFlow = nationOn ? null : ((inkGL && !inkGL.failed) ? inkGL
      : ((config.inkFlow && config.inkFlow.enabled && global.RiskTideInkFlow && silkCanvas)
        ? new global.RiskTideInkFlow(silkCanvas, mapController)
        : null));
    const ui = new global.RiskTideUI(global.routes);

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
    }
    applyInkMapTheme();
    let lastRouteKey = null;
    let latestResult = null;

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
      refreshNation();

      const routeKey = state.mode ? state.mode + ':' + (state.variantId || 'default') : 'none';
      if (routeKey !== lastRouteKey) {
        const route = getSelectedRoute(state);
        mapController.setRoute(route);
        if (silk) silk.setRoute(route);
        if (inkFlow) inkFlow.setRoute(route);
        lastRouteKey = routeKey;
      }

      pushRisk(result.valid ? result.risk : 0);

      return result;
    }

    ui.onChange = applyState;

    mapController.init({
      container: document.getElementById('map'),
      canvasStage: document.getElementById('map-shell'),
      onMovement: function (moving) {
        if (nationInk) {
          nationInk.projectDirty = true;
          nationInk.requestFrame();
        }
        if (silk) silk.routeDirty = true;
        if (inkFlow) inkFlow.routeDirty = true;
        /* Skip the hue-selective pigment passes while the map is moving so
           panning/zooming keeps its frame budget. */
        if (shell) shell.classList.toggle('is-moving', !!moving);
        if (!moving) {
          global.setTimeout(function () {
            if (nationInk) {
              nationInk.projectDirty = true;
              nationInk.requestFrame();
            }
            if (silk) silk.routeDirty = true;
            if (inkFlow) inkFlow.routeDirty = true;
          }, 80);
        }
      },
      onStatus: function (status) {
        if (status.state === 'ready') {
          /* 只覆盖配置对象不够：地图初始化后仍会按自己的 maxBounds 收敛视野，
             所以在 ready 之后显式再设一次全国视野。 */
          if (nationOn && mapController.map && config.nation && config.nation.map) {
            const nm = config.nation.map;
            try {
              if (typeof mapController.map.setZoomAndCenter === 'function') {
                mapController.map.setZoomAndCenter(nm.amapZoom, nm.center);
              } else if (typeof mapController.map.jumpTo === 'function') {
                mapController.map.jumpTo({ center: nm.center, zoom: nm.zoom });
              }
            } catch (e) { }
          }
          if (nationInk) nationInk.resize();
          if (silk) { silk.resize(); silk.routeDirty = true; }
          if (inkFlow) { inkFlow.resize(); inkFlow.routeDirty = true; }
          ui.setStatus(nationOn ? '选择城市，查看时间潮位' : '路线已载入 · 可调整时间条件', 'normal');
        } else {
          ui.setStatus(status.message || '地图已降级，风险计算仍可使用。', 'warning');
        }
      },
      onRoutesReady: function (plannedRoutes) {
        Object.keys(plannedRoutes).forEach(function (key) {
          global.routes[key] = plannedRoutes[key];
        });
        ui.refreshRoutes();
        lastRouteKey = null;
        applyState(ui.getState());
      }
    }).then(function () {
      mapController.setRoute(getSelectedRoute(ui.getState()));
      if (silk) {
        silk.setRoute(getSelectedRoute(ui.getState()));
        silk.routeDirty = true;
      }
    });
    if (nationOn && config.nation && config.nation.defaultWindowMinutes) {
      const target = Number(config.nation.defaultWindowMinutes);
      if (Number.isFinite(target) && target > 0) {
        ui.state.departureOffset = Math.min(720, Math.max(5, Math.round(target)));
        ui.state.departureTime = riskModel.addMinutes(ui.state.trainTime, -ui.state.departureOffset);
        ui.update();
        applyState(ui.getState());
      }
    }

    if (nationInk) nationInk.start();
    if (inkFlow) inkFlow.start();
    applyState(ui.getState());

    if (nationInk && shell) {
      const status = document.getElementById('status-line');
      function cityAtPoint(event) {
        if (event.target.closest('button, input, select, a')) return null;
        const rect = shell.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        let nearest = null;
        let distance = 22;
        nationInk.rows.forEach(function (row) {
          const next = Math.hypot(row.x - x, row.y - y);
          if (next < distance) { nearest = row; distance = next; }
        });
        return nearest;
      }
      shell.addEventListener('pointermove', function (event) {
        const row = cityAtPoint(event);
        nationInk.setSelected(row ? row.city.id : null);
        if (row && status) {
          status.textContent = row.city.name + ' · 时间风险 ' + Math.round(row.displayRisk) + ' / 100';
          status.dataset.type = 'normal';
        }
      });
      shell.addEventListener('click', function (event) {
        const row = cityAtPoint(event);
        nationInk.setSelected(row ? row.city.id : null);
        if (row && status) {
          status.textContent = row.city.name + ' · 时间风险 ' + Math.round(row.displayRisk) + ' / 100';
          status.dataset.type = 'normal';
        }
      });
      shell.addEventListener('pointerleave', function () {
        nationInk.setSelected(null);
        if (status) status.textContent = '选择城市，查看时间潮位';
      });
    }

    /* 单程墨线 hover：只轻微增强墨骨对比，不发光 / 放大 / 弹窗 */
    if (inkFlow && shell) {
      shell.addEventListener('pointermove', function (event) {
        if (event.target.closest('button, input, select, a')) { inkFlow.setHover(0); return; }
        const rect = shell.getBoundingClientRect();
        inkFlow.setHover(inkFlow.hoverAt(event.clientX - rect.left, event.clientY - rect.top));
      });
      shell.addEventListener('pointerleave', function () {
        inkFlow.setHover(0);
      });
    }

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
          ui.refreshRoutes();
          lastRouteKey = null;
          if (mapController.replanRoutes) {
            mapController.replanRoutes().then(function () {
              applyState(ui.getState());
              ui.setStatus('已按新起终点重新规划路线。', 'normal');
            }).catch(function () {
              mapController.setRoute(getSelectedRoute(ui.getState()));
              if (silk) silk.setRoute(getSelectedRoute(ui.getState()));
            });
          } else {
            mapController.setRoute(getSelectedRoute(ui.getState()));
            if (silk) silk.setRoute(getSelectedRoute(ui.getState()));
          }
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
      if (nationInk) nationInk.setVisible(visible);
      if (silk) silk.setVisible(visible);
      if (inkFlow) inkFlow.setVisible(visible);
    }

    document.addEventListener('visibilitychange', handleVisibility);

    let resizeTimer = 0;
    global.addEventListener('resize', function () {
      global.clearTimeout(resizeTimer);
      resizeTimer = global.setTimeout(function () {
        mapController.resize();
        if (nationInk) {
          nationInk.resize();
          nationInk.projectDirty = true;
        }
        if (silk) { silk.resize(); silk.routeDirty = true; }
        if (inkFlow) { inkFlow.resize(); inkFlow.routeDirty = true; }
      }, 120);
    }, { passive: true });

    global.setInterval(function () {
      if (document.hidden) return;
      const metrics = nationInk ? nationInk.getMetrics() : null;
      if (inkFlow) {
        const flow = inkFlow.getMetrics();
        ui.updateMetrics({ text: '单程墨线 · ' + flow.points + ' 个路线采样点' });
      } else if (metrics) {
        ui.updateMetrics({ text: '全国墨场 · ' + metrics.cities + ' 城 · ' + metrics.field });
      }
    }, 1800);

    global.RiskTideApp = {
      map: mapController,
      silk: silk,
      inkFlow: inkFlow,
      nationInk: nationInk,
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








