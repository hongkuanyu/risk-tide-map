/* global window, document */
(function (global) {
  'use strict';

  const config = global.RiskTideConfig;
  const riskModel = global.RiskTideRisk;

  function ease(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function getShowcaseRisk(progress) {
    const timeline = config.showcase.timeline;
    if (progress <= 0) return timeline[0].risk;
    for (let i = 1; i < timeline.length; i += 1) {
      const previous = timeline[i - 1];
      const current = timeline[i];
      if (progress <= current.at) {
        const local = (progress - previous.at) / (current.at - previous.at || 1);
        return previous.risk + (current.risk - previous.risk) * ease(local);
      }
    }
    return timeline[timeline.length - 1].risk;
  }

  function createApp() {
    const useAmap = !!(config.amap && config.amap.enabled && config.amap.key && global.RiskTideAmapMap);
    const amapMissingKey = !!(config.amap && config.amap.enabled && !config.amap.key);
    const mapController = useAmap ? new global.RiskTideAmapMap() : new global.RiskTideMap();
    const particleCanvas = document.getElementById('particle-canvas');
    const particles = new global.RiskTideParticles(particleCanvas, mapController);
    const ui = new global.RiskTideUI(global.routes);
    let showcaseActive = false;
    let showcaseStart = 0;
    let showcaseFrame = 0;
    let lastRouteKey = null;
    let latestResult = null;

    function getSelectedRoute(state) {
      return state.mode ? ui.getActiveRoute(state) : null;
    }

    function pushRisk(risk) {
      particles.setRisk(risk);
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

      const routeKey = state.mode ? state.mode + ':' + (state.variantId || 'default') : 'none';
      if (routeKey !== lastRouteKey) {
        const route = getSelectedRoute(state);
        mapController.setRoute(route);
        particles.setRoute(route);
        lastRouteKey = routeKey;
      }

      if (!showcaseActive) {
        pushRisk(result.valid ? result.risk : 0);
      }

      if (showcaseActive) {
        ui.setShowcase(true, 0);
      }
      return result;
    }

    ui.onChange = applyState;

    mapController.init({
      container: document.getElementById('map'),
      canvasStage: document.getElementById('map-shell'),
      onMovement: function () {
        particles.routeDirty = true;
      },
      onStatus: function (status) {
        if (status.state === 'ready') {
          particles.resize();
          particles.routeDirty = true;
          ui.setStatus('地图底图已加载 · 路线规划同步中', 'normal');
        } else {
          ui.setStatus(status.message || '地图已降级，粒子仍持续流动。', 'warning');
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
      particles.setRoute(getSelectedRoute(ui.getState()));
    });

    particles.start();
    applyState(ui.getState());

    function showcaseTick(timestamp) {
      if (!showcaseActive) return;
      const progress = Math.min(1, (timestamp - showcaseStart) / config.showcase.durationMs);
      const risk = getShowcaseRisk(progress);
      pushRisk(risk);
      ui.setShowcase(true, progress);
      const secondsLeft = Math.max(0, Math.ceil((config.showcase.durationMs - (timestamp - showcaseStart)) / 1000));
      ui.setStatus('粒子序章播放中 · ' + secondsLeft + ' 秒后开放操作', 'normal');
      if (progress >= 1) {
        showcaseActive = false;
        ui.setShowcase(false, 1);
        if (!ui.getState().mode) {
          ui.selectMode('taxi');
          ui.setStatus('演示结束，已自动选择网约车。拖动出发时间即可看到粒子颜色随风险变化。', 'normal');
        } else {
          ui.setStatus('演示结束。拖动出发时间即可测试粒子风险颜色。', 'normal');
          applyState(ui.getState());
        }
      }
      showcaseFrame = global.requestAnimationFrame(showcaseTick);
    }

    global.addEventListener('risktide:interaction', function () {
      if (showcaseActive) {
        showcaseActive = false;
        global.cancelAnimationFrame(showcaseFrame);
        ui.setShowcase(false, 1);
        ui.setStatus('已跳过演示，正在按你的操作更新风险颜色。', 'normal');
      }
      if (!ui.getState().mode) ui.selectMode('taxi');
    });
    function startShowcase() {
      showcaseActive = true;
      showcaseStart = global.performance.now();
      ui.setShowcase(true, 0);
      showcaseFrame = global.requestAnimationFrame(showcaseTick);
    }

    global.setTimeout(startShowcase, 420);

    function handleVisibility() {
      const visible = !document.hidden;
      particles.setVisible(visible);
      if (!visible) {
        global.cancelAnimationFrame(showcaseFrame);
      } else if (showcaseActive) {
        showcaseStart = global.performance.now() - 500;
        showcaseFrame = global.requestAnimationFrame(showcaseTick);
      }
    }

    document.addEventListener('visibilitychange', handleVisibility);

    let resizeTimer = 0;
    global.addEventListener('resize', function () {
      global.clearTimeout(resizeTimer);
      resizeTimer = global.setTimeout(function () {
        mapController.resize();
        particles.resize();
        particles.routeDirty = true;
      }, 120);
    }, { passive: true });

    global.setInterval(function () {
      if (!showcaseActive) ui.updateMetrics(particles.getMetrics());
    }, 1800);

    global.RiskTideApp = {
      map: mapController,
      particles: particles,
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







