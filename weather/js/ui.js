/* global window, document */
(function (global) {
  'use strict';

  const riskModel = global.RiskTideRisk;
  const config = global.RiskTideConfig;

  function numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  /* Keeps "missing" distinct from a real 0 (0 C, 0% humidity, 0% rain). */
  function finiteOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  class RiskTideUI {
    constructor(routeMap) {
      this.routeMap = routeMap;
      this.onChange = function () {};
      this.weatherInfo = null;
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
      this.renderWeather();
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
        departureBadge: document.getElementById('topbar-departure'),
        departurePicker: document.getElementById('departure-time-picker'),
        availableLabel: document.getElementById('available-label'),
        availableMinutes: document.getElementById('available-minutes'),
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
        mapShell: document.getElementById('map-shell'),
        weatherStrip: document.getElementById('weather-strip'),
        weatherGlyph: document.getElementById('weather-glyph'),
        weatherNow: document.getElementById('weather-now'),
        weatherNowLabel: document.getElementById('weather-now-label'),
        weatherDeparture: document.getElementById('weather-departure'),
        weatherDepartureLabel: document.getElementById('weather-departure-label'),
        weatherImpact: document.getElementById('weather-impact'),
        weatherImpactLabel: document.getElementById('weather-impact-label'),
        weatherNote: document.getElementById('weather-note')
      };
    }

    bindEvents() {
      const self = this;
      function emit() {
        global.dispatchEvent(new CustomEvent('risktide:interaction'));
        self.update();
        self.onChange(self.getState());
      }

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
      if (this.elements.departurePicker) {
        this.elements.departurePicker.addEventListener('focus', function () {
          self.elements.departurePicker.value = self.state.departureTime;
        });
        this.elements.departurePicker.addEventListener('change', function () {
          const picked = self.elements.departurePicker.value;
          if (!picked) return;
          self.state.departureTime = picked;
          const diffRaw = riskModel.untilTime(picked, self.state.trainTime);
          const diff = Number.isFinite(diffRaw) ? diffRaw : self.state.departureOffset;
          const safe = Math.min(720, Math.max(5, Math.round(diff)));
          self.state.departureOffset = safe;
          self.elements.departureSlider.value = String(safe);
          self.syncDeparture();
          emit();
        });
      }
      if (this.elements.availableMinutes) {
        this.elements.availableMinutes.addEventListener('change', function () {
          const raw = Number(self.elements.availableMinutes.value);
          const safe = Number.isFinite(raw) ? Math.min(720, Math.max(5, Math.round(raw))) : self.state.departureOffset;
          self.state.departureOffset = safe;
          self.elements.availableMinutes.value = String(safe);
          self.syncDeparture();
          emit();
        });
      }
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
      global.dispatchEvent(new CustomEvent('risktide:interaction'));
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
      if (this.elements.departureBadge) this.elements.departureBadge.textContent = this.state.departureTime;
      if (this.elements.departurePicker && document.activeElement !== this.elements.departurePicker) this.elements.departurePicker.value = this.state.departureTime;
      if (this.elements.availableLabel) this.elements.availableLabel.textContent = this.state.departureOffset + ' 分钟';
      if (this.elements.availableMinutes && document.activeElement !== this.elements.availableMinutes) {
        this.elements.availableMinutes.value = String(this.state.departureOffset);
      }
      if (this.elements.departureSlider && !this.elements.departureSlider.matches(':active')) {
        this.elements.departureSlider.value = String(this.state.departureOffset);
      }
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
    }

    /* ---- real-time weather strip ------------------------------------- */
    getWeather() { return this.weatherInfo; }

    getWeatherMinutes() {
      const info = this.weatherInfo;
      if (!info || !info.ok || !info.impact) return 0;
      const minutes = Number(info.impact.extraMinutes);
      return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
    }

    setWeather(info) {
      this.weatherInfo = info || null;
      this.renderWeather();
      this.update();
      this.onChange(this.getState());
    }

    renderWeather() {
      const el = this.elements;
      if (!el.weatherStrip) return;
      const info = this.weatherInfo;
      const weather = global.RiskTideWeather;

      const setGlyph = function (name) {
        if (!el.weatherGlyph) return;
        el.weatherGlyph.innerHTML = weather && weather.glyphMarkup ? weather.glyphMarkup(name) : '';
      };
      const text = function (node, value) {
        if (node) node.textContent = value;
      };

      if (!info) {
        el.weatherStrip.dataset.state = 'loading';
        setGlyph('cloud');
        text(el.weatherNow, '天气读取中');
        text(el.weatherNowLabel, '正在接入实时天气…');
        text(el.weatherDeparture, '--:--');
        text(el.weatherDepartureLabel, '等待出发时段预报');
        text(el.weatherImpact, '±0 分钟');
        text(el.weatherImpactLabel, '尚未计入');
        text(el.weatherNote, '数据来源：Open-Meteo 实时观测与逐小时预报。');
        return;
      }

      if (!info.ok) {
        el.weatherStrip.dataset.state = 'unavailable';
        setGlyph('unknown');
        text(el.weatherNow, '天气暂不可用');
        text(el.weatherNowLabel, '实时接口未返回数据');
        text(el.weatherDeparture, info.targetTime || '--:--');
        text(el.weatherDepartureLabel, '出发时段预报缺失');
        text(el.weatherImpact, '±0 分钟');
        text(el.weatherImpactLabel, '按纯时间模型计算');
        text(el.weatherNote, '天气接口未能返回数据，风险只由时间差计算，不额外加时。');
        return;
      }

      const current = info.current || {};
      const departure = info.departure || current || {};
      const impact = info.impact || { extraMinutes: 0, reasons: [] };
      const extra = Number(impact.extraMinutes) || 0;

      el.weatherStrip.dataset.state = extra >= 8 ? 'alert' : extra > 0 ? 'watch' : 'active';
      setGlyph(current.glyph || departure.glyph || 'cloud');

      const temperature = finiteOrNull(current.temperature);
      const feels = finiteOrNull(current.feelsLike);
      const humidity = finiteOrNull(current.humidity);
      text(el.weatherNow, (temperature !== null ? Math.round(temperature) + '°' : '--') + ' · ' + (current.label || '天气未知'));

      const nowBits = [];
      if (feels !== null) nowBits.push('体感 ' + Math.round(feels) + '°');
      if (humidity !== null) nowBits.push('湿度 ' + Math.round(humidity) + '%');
      const stamp = this.weatherTimeLabel(info.fetchedAt);
      if (stamp) nowBits.push(stamp);
      text(el.weatherNowLabel, nowBits.join(' · ') || '实时观测');

      text(el.weatherDeparture, info.targetTime || departure.time || '--:--');
      const depBits = [];
      const depTemp = finiteOrNull(departure.temperature);
      if (depTemp !== null) depBits.push(Math.round(depTemp) + '°');
      depBits.push(departure.label || '未知');
      const probability = finiteOrNull(departure.precipitationProbability);
      if (probability !== null) depBits.push('降水 ' + Math.round(probability) + '%');
      text(el.weatherDepartureLabel, depBits.join(' · '));

      text(el.weatherImpact, extra > 0 ? '+' + extra + ' 分钟' : '±0 分钟');
      text(el.weatherImpactLabel, extra > 0 ? '已计入路线时间' : '未计入风险');
      text(el.weatherNote, this.weatherNoteText(info, impact));
    }

    weatherTimeLabel(timestamp) {
      if (!Number.isFinite(Number(timestamp))) return '';
      const date = new Date(Number(timestamp));
      return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0') + ' 更新';
    }

    weatherNoteText(info, impact) {
      const source = (info.provider || 'Open-Meteo') + ' 实时观测与逐小时预报';
      const suffix = info.stale ? '（网络不可用，展示缓存数据）' : '';
      const minutes = Number(impact.extraMinutes) || 0;
      if (minutes > 0) {
        const reasons = (impact.reasons || []).join('、');
        return source + ' · ' + (reasons ? reasons + '，' : '') + '已把 +' + minutes + ' 分钟计入路线时间。' + suffix;
      }
      return source + ' · 出发时段无明显天气加时。' + suffix;
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
        weatherMinutes: this.getWeatherMinutes(),
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















