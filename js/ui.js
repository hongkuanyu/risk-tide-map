/* global window, document */
(function (global) {
  'use strict';

  const riskModel = global.RiskTideRisk;
  const config = global.RiskTideConfig;

  function numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  class RiskTideUI {
    constructor(routeMap) {
      this.routeMap = routeMap;
      this.onChange = function () {};
      this.state = {
        mode: null,
        trainTime: '18:00',
        departureOffset: 120,
        departureTime: '16:00',
        routeMinutes: null,
        stationMinutes: 20,
        variantId: null
      };
      this.cacheElements();
      this.bindEvents();
      this.update();
    }

    cacheElements() {
      this.elements = {
        panel: document.getElementById('control-panel'),
        taxiButton: document.getElementById('mode-taxi'),
        busButton: document.getElementById('mode-bus'),
        trainTime: document.getElementById('train-time'),
        routeMinutes: document.getElementById('route-minutes'),
        routeVariant: document.getElementById('route-variant'),
        routeVariantField: document.getElementById('route-variant-field'),
        stationMinutes: document.getElementById('station-minutes'),
        departureSlider: document.getElementById('departure-slider'),
        departureLabel: document.getElementById('departure-label'),
        availableLabel: document.getElementById('available-label'),
        buffer: document.getElementById('result-buffer'),
        risk: document.getElementById('result-risk'),
        latest: document.getElementById('result-latest'),
        fastest: document.getElementById('result-fastest'),
        steadiest: document.getElementById('result-steadiest'),
        riskFill: document.getElementById('risk-fill'),
        riskBadge: document.getElementById('risk-badge'),
        routeWarning: document.getElementById('route-warning'),
        routeSource: document.getElementById('route-source'),
        showcase: document.getElementById('showcase-overlay'),
        showcaseProgress: document.getElementById('showcase-progress'),
        statusLine: document.getElementById('status-line'),
        metrics: document.getElementById('metrics'),
        mapShell: document.getElementById('map-shell')
      };
    }

    bindEvents() {
      const self = this;
      function emit() { self.update(); self.onChange(self.getState()); }

      this.elements.taxiButton.addEventListener('click', function () { self.selectMode('taxi'); });
      this.elements.busButton.addEventListener('click', function () { self.selectMode('bus'); });
      this.elements.trainTime.addEventListener('input', function () {
        self.state.trainTime = self.elements.trainTime.value || '18:00';
        self.syncDeparture();
        emit();
      });
      this.elements.departureSlider.addEventListener('input', function () {
        self.state.departureOffset = Number(self.elements.departureSlider.value);
        self.syncDeparture();
        emit();
      });
      this.elements.routeMinutes.addEventListener('input', function () {
        self.state.routeMinutes = numberOrNull(self.elements.routeMinutes.value);
        emit();
      });
      this.elements.stationMinutes.addEventListener('input', function () {
        self.state.stationMinutes = Number(self.elements.stationMinutes.value) || 0;
        emit();
      });
      this.elements.routeVariant.addEventListener('change', function () {
        self.selectVariant(self.elements.routeVariant.value);
      });
    }

    selectMode(mode) {
      if (!this.routeMap[mode]) return;
      this.state.mode = mode;
      const route = this.routeMap[mode];
      this.state.variantId = route.variants && route.variants.length ? route.variants[0].id : null;
      this.populateVariants(route);
      const active = this.getActiveRoute(this.state) || route;
      const hasDuration = Number.isFinite(Number(active.durationMinutes)) && Number(active.durationMinutes) > 0;
      this.state.routeMinutes = hasDuration ? Number(active.durationMinutes) : null;
      this.elements.routeMinutes.value = hasDuration ? String(active.durationMinutes) : '';
      this.elements.routeMinutes.disabled = false;
      this.elements.taxiButton.classList.toggle('is-active', mode === 'taxi');
      this.elements.busButton.classList.toggle('is-active', mode === 'bus');
      this.elements.taxiButton.setAttribute('aria-pressed', mode === 'taxi' ? 'true' : 'false');
      this.elements.busButton.setAttribute('aria-pressed', mode === 'bus' ? 'true' : 'false');
      this.update();
      this.onChange(this.getState());
    }

    populateVariants(route) {
      const variants = route && route.variants ? route.variants : [];
      this.elements.routeVariant.innerHTML = '';
      this.elements.routeVariantField.hidden = variants.length < 2;
      for (let i = 0; i < variants.length; i += 1) {
        const option = document.createElement('option');
        option.value = variants[i].id;
        option.textContent = variants[i].label + ' · ' + variants[i].durationMinutes + '分钟';
        this.elements.routeVariant.appendChild(option);
      }
      if (this.state.variantId) this.elements.routeVariant.value = this.state.variantId;
    }

    getActiveVariant() {
      if (!this.state.mode) return null;
      const route = this.routeMap[this.state.mode];
      if (!route || !route.variants || !route.variants.length) return null;
      const self = this;
      return route.variants.find(function (variant) { return variant.id === self.state.variantId; }) || route.variants[0];
    }

    getActiveRoute(state) {
      const current = state || this.state;
      const route = current.mode ? this.routeMap[current.mode] : null;
      if (!route || !route.variants || !route.variants.length) return route;
      const variant = route.variants.find(function (item) { return item.id === current.variantId; }) || route.variants[0];
      return Object.assign({}, route, variant, {
        id: route.id,
        label: route.label + ' · ' + variant.label,
        source: variant.source || route.source,
        variants: route.variants
      });
    }

    selectVariant(id) {
      this.state.variantId = id;
      const active = this.getActiveRoute(this.state);
      if (active && Number.isFinite(Number(active.durationMinutes))) {
        this.state.routeMinutes = Number(active.durationMinutes);
        this.elements.routeMinutes.value = String(active.durationMinutes);
      }
      this.update();
      this.onChange(this.getState());
    }

    refreshRoutes() {
      const route = this.state.mode ? this.routeMap[this.state.mode] : null;
      if (!route) { this.update(); return; }
      this.populateVariants(route);
      if (route.variants && route.variants.length) {
        const exists = route.variants.some(function (variant) { return variant.id === this.state.variantId; }.bind(this));
        if (!exists) {
          this.state.variantId = route.variants[0].id;
          this.elements.routeVariant.value = this.state.variantId;
        }
      }
      const active = this.getActiveRoute(this.state);
      if (active && Number.isFinite(Number(active.durationMinutes))) {
        this.state.routeMinutes = Number(active.durationMinutes);
        this.elements.routeMinutes.value = String(active.durationMinutes);
      }
      this.update();
    }

    syncDeparture() {
      this.state.departureTime = riskModel.addMinutes(this.state.trainTime, -this.state.departureOffset);
      this.elements.departureLabel.textContent = this.state.departureTime;
      this.elements.availableLabel.textContent = this.state.departureOffset + ' 分钟';
    }

    getState() {
      return Object.assign({}, this.state);
    }

    setStatus(message, type) {
      this.elements.statusLine.textContent = message || '';
      this.elements.statusLine.dataset.type = type || 'normal';
    }

    setShowcase(active, progress) {
      this.elements.showcase.classList.toggle('is-active', active);
      if (typeof progress === 'number') {
        this.elements.showcaseProgress.style.transform = 'scaleX(' + Math.max(0, Math.min(1, progress)) + ')';
      }
      this.elements.panel.classList.toggle('is-locked', active);
    }

    updateMetrics(metrics) {
      const label = metrics.mobile ? '移动端' : '桌面端';
      const quality = Math.round(metrics.quality * 100);
      this.elements.metrics.textContent = label + ' · ' + metrics.active + '/' + metrics.max + ' 粒子 · 质量 ' + quality + '% · ~' + metrics.fpsAverage + ' FPS';
    }

    update() {
      this.syncDeparture();
      const result = riskModel.calculate({
        trainTime: this.state.trainTime,
        departureTime: this.state.departureTime,
        routeMinutes: this.state.routeMinutes,
        stationMinutes: this.state.stationMinutes,
        safeBufferMinutes: config.risk.safeBufferMinutes
      });

      const route = this.getActiveRoute(this.state);
      const hasRoute = !!(route && route.coordinates && route.coordinates.length >= 2);
      const routeIsVerified = !!(route && route.verified);

      if (!this.state.mode) {
        this.elements.routeWarning.textContent = '请选择网约车或公交。路线数据未接入前，风险不会被伪装成实时结论。';
        this.elements.routeWarning.dataset.type = 'warning';
      } else if (!hasRoute) {
        this.elements.routeWarning.textContent = route.label + '路线数据尚未录入；预计时间可手动填写，但不会生成真实路线几何。';
        this.elements.routeWarning.dataset.type = 'warning';
      } else if (!routeIsVerified) {
        this.elements.routeWarning.textContent = route.label + '路线几何已载入；校门、站前入口和预计时间仍待核对。';
        this.elements.routeWarning.dataset.type = 'warning';
      } else {
        this.elements.routeWarning.textContent = '路线来源已标记为人工核验。';
        this.elements.routeWarning.dataset.type = 'ok';
      }

      this.elements.routeSource.textContent = route ? route.source : '尚未选择交通方式';
      this.elements.buffer.textContent = result.valid ? (result.bufferMinutes > 0 ? '+' : '') + Math.round(result.bufferMinutes) + ' 分钟' : '--';
      this.elements.risk.textContent = result.valid ? Math.round(result.risk) + ' / 100' : '--';
      this.elements.latest.textContent = result.valid ? result.latestDepartureTime : '--:--';

      const routeMapForCompare = Object.assign({}, this.routeMap);
      if (this.state.mode && this.state.routeMinutes) {
        routeMapForCompare[this.state.mode] = Object.assign({}, route, { durationMinutes: this.state.routeMinutes });
      }
      const compare = riskModel.compareModes(routeMapForCompare);
      this.elements.fastest.textContent = compare.fastest ? compare.fastest.label + ' · ' + compare.fastest.durationMinutes + '分钟' : '待核对';
      this.elements.steadiest.textContent = compare.steadiest ? compare.steadiest.label + ' · ' + compare.steadiest.durationMinutes + '分钟' : '待核对';

      const riskValue = result.valid ? result.risk : 0;
      const color = global.RiskTideMapUtils.riskColor(riskValue);
      this.elements.riskFill.style.width = riskValue + '%';
      this.elements.riskFill.style.background = 'linear-gradient(90deg, rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',0.25), rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',0.98))';
      this.elements.riskBadge.textContent = result.valid ? result.label : '等待路线';
      this.elements.riskBadge.dataset.level = result.level;

      if (this.elements.mapShell) {
        this.elements.mapShell.dataset.riskLevel = result.level;
      }
      return result;
    }
  }

  global.RiskTideUI = RiskTideUI;
})(window);






