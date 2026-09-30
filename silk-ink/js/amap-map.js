/* global window, document, AMap */
(function (global) {
  'use strict';

  const config = global.RiskTideConfig;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function loadScript(source) {
    return new Promise(function (resolve, reject) {
      const existing = document.querySelector('script[data-risk-tide-amap]');
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = source;
      script.async = true;
      script.dataset.riskTideAmap = 'true';
      script.onload = resolve;
      script.onerror = function () { reject(new Error('高德地图脚本加载失败')); };
      document.head.appendChild(script);
    });
  }

  function wgs84ToGcj02(lng, lat) {
    const a = 6378245.0;
    const ee = 0.00669342162296594323;
    const dLat = transformLat(lng - 105.0, lat - 35.0);
    const dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    const adjustLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
    const adjustLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
    return [lng + adjustLng, lat + adjustLat];
  }

  function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }

  function transformLng(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return ret;
  }

  function toGcj(point) {
    return wgs84ToGcj02(point[0], point[1]);
  }

  function readPoint(point) {
    if (!point) return null;
    const lng = typeof point.getLng === 'function' ? point.getLng() : point[0];
    const lat = typeof point.getLat === 'function' ? point.getLat() : point[1];
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }

  function appendPath(target, path) {
    if (!Array.isArray(path)) return;
    for (let i = 0; i < path.length; i += 1) {
      const point = readPoint(path[i]);
      if (!point) continue;
      const previous = target[target.length - 1];
      if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) target.push(point);
    }
  }

  function flattenDriving(result) {
    const route = result && result.routes && result.routes[0];
    const points = [];
    if (route && Array.isArray(route.steps)) {
      route.steps.forEach(function (step) { appendPath(points, step.path); });
    }
    if (!points.length && route) appendPath(points, route.path);
    return { coordinates: points, distanceMeters: route ? Number(route.distance) : 0, durationSeconds: route ? Number(route.time) : 0 };
  }

  function flattenTransfer(result) {
    const plan = result && result.plans && result.plans[0];
    const points = [];
    if (plan && Array.isArray(plan.segments)) {
      plan.segments.forEach(function (segment) {
        if (segment.walking && Array.isArray(segment.walking.steps)) {
          segment.walking.steps.forEach(function (step) { appendPath(points, step.path); });
        }
        if (segment.transit && Array.isArray(segment.transit.lines)) {
          segment.transit.lines.forEach(function (line) { appendPath(points, line.path); });
        }
      });
    }
    return { coordinates: points, distanceMeters: plan ? Number(plan.distance) : 0, durationSeconds: plan ? Number(plan.time) : 0 };
  }

  function searchWithPlanner(planner, origin, destination) {
    return new Promise(function (resolve, reject) {
      planner.search(origin, destination, function (status, result) {
        if (status === 'complete' && result && result.info === 'OK') resolve(result);
        else reject(new Error(result && result.info ? result.info : '高德路线规划失败'));
      });
    });
  }

  function routeToVariant(id, label, source, flattened) {
    return {
      id: id,
      label: label,
      durationMinutes: Math.max(1, Math.ceil(flattened.durationSeconds / 60)),
      distanceMeters: flattened.distanceMeters,
      rawDurationSeconds: flattened.durationSeconds,
      source: source,
      verified: false,
      coordinates: flattened.coordinates
    };
  }

  class RiskTideAmapMap {
    constructor() {
      this.map = null;
      this.container = null;
      this.canvasStage = null;
      this.ready = false;
      this.moving = false;
      this.fallback = false;
      this.route = null;
      this.routePreview = false;
      this.risk = 0;
      this.markers = {};
      this.routePolyline = null;
      this.routeHalo = null;
      this.onMovement = function () {};
      this.onStatus = function () {};
      this.onRoutesReady = function () {};
      this.endpoints = {
        campus: config.endpoints.campus,
        station: config.endpoints.station
      };
      this.city = (config.amap && config.amap.city) || '无锡';
    }

    setEndpoints(endpoints) {
      if (!endpoints) return;
      if (endpoints.campus) this.endpoints.campus = endpoints.campus;
      if (endpoints.station) this.endpoints.station = endpoints.station;
      if (endpoints.city) this.city = endpoints.city;
      if (this.fallbackMap && typeof this.fallbackMap.setEndpoints === 'function') {
        this.fallbackMap.setEndpoints(endpoints);
      }
      if (this.map && this.ready) {
        this.repositionMarkers();
        this.setRoute(null);
      }
    }

    getEndpoints() { return this.endpoints; }

    replanRoutes() {
      if (!this.map || !this.ready) return Promise.resolve(null);
      if (this.fallbackMap) return Promise.resolve(null);
      return this.planRoutes();
    }

    init(options) {
      this.options = options;
      this.container = options.container;
      this.canvasStage = options.canvasStage;
      this.onMovement = options.onMovement || function () {};
      this.onStatus = options.onStatus || function () {};
      this.onRoutesReady = options.onRoutesReady || function () {};

      const amapConfig = config.amap || {};
      if (!amapConfig.enabled || !amapConfig.key) {
        this.enableFallback('高德 API 尚未配置，已使用 OpenStreetMap 降级地图。');
        return Promise.resolve(false);
      }

      global._AMapSecurityConfig = {
        securityJsCode: amapConfig.securityJsCode || ''
      };
      const pluginNames = ['AMap.Driving', 'AMap.Transfer', 'AMap.AutoComplete', 'AMap.PlaceSearch', 'AMap.Geocoder', 'AMap.Geolocation', 'AMap.ToolBar', 'AMap.Scale'].join(',');
      const source = 'https://webapi.amap.com/maps?v=' + encodeURIComponent(amapConfig.version || '2.0') +
        '&key=' + encodeURIComponent(amapConfig.key) +
        '&plugin=' + encodeURIComponent(pluginNames);

      return loadScript(source)
        .then(() => this.createMap())
        .then(() => {
          if (amapConfig.autoRoute !== false) return this.planRoutes();
          return null;
        })
        .catch((error) => {
          this.enableFallback(error.message || '高德地图初始化失败。');
          return false;
        });
    }

    createMap() {
      const amapConfig = config.amap || {};
      return new Promise((resolve, reject) => {
        try {
          this.map = new AMap.Map(this.container, {
            viewMode: '2D',
            zoom: amapConfig.zoom || 12,
            center: toGcj(config.map.center),
            mapStyle: amapConfig.mapStyle || 'amap://styles/normal',
            resizeEnable: true,
            showLabel: true,
            features: ['bg', 'road', 'building', 'point']
          });
          this.map.on('complete', () => {
            this.ready = true;
            this.addMarkers();
            this.addRouteLayer();
            this.map.on('movestart', () => { this.moving = true; this.onMovement(true); });
            this.map.on('moveend', () => { this.moving = false; this.onMovement(false); });
            this.onStatus({ state: 'ready', message: '高德地图已加载 · 路线由高德规划' });
            resolve(this.map);
          });
        } catch (error) {
          reject(error);
        }
      });
    }

    enableFallback(message) {
      this.fallback = true;
      this.ready = false;
      if (this.canvasStage) this.canvasStage.classList.add('is-fallback');
      if (this.container) this.container.classList.add('is-fallback');
      this.onStatus({ state: 'warning', message: message || '高德地图不可用，已切换 OpenStreetMap。' });
      if (this.fallbackMap || !global.RiskTideMap || !this.options) return Promise.resolve(false);
      const self = this;
      this.fallbackMap = new global.RiskTideMap();
      return this.fallbackMap.init(Object.assign({}, this.options, {
        onRoutesReady: null,
        onStatus: function (status) { self.onStatus(status); }
      })).then(function () { return false; }).catch(function () { return false; });
    }

    markerContent(endpoint, asset) {
      return '<div class="map-marker ' + endpoint.id + '-marker"><img src="' + asset + '" alt=""><span class="marker-label">' + endpoint.shortName + '</span></div>';
    }

    addMarkers() {
      if (!this.map) return;
      this.markers.campus = new AMap.Marker({
        position: new AMap.LngLat(toGcj(this.endpoints.campus.coordinate)[0], toGcj(this.endpoints.campus.coordinate)[1]),
        content: this.markerContent(this.endpoints.campus, 'assets/marker-campus.svg'),
        anchor: 'bottom-center',
        zIndex: 120
      });
      this.markers.station = new AMap.Marker({
        position: new AMap.LngLat(toGcj(this.endpoints.station.coordinate)[0], toGcj(this.endpoints.station.coordinate)[1]),
        content: this.markerContent(this.endpoints.station, 'assets/marker-station.svg'),
        anchor: 'bottom-center',
        zIndex: 121
      });
      this.map.add(this.markers.campus);
      this.map.add(this.markers.station);
    }

    repositionMarkers() {
      if (!this.map || !this.markers.campus || !this.markers.station) return;
      this.markers.campus.setPosition(new AMap.LngLat(toGcj(this.endpoints.campus.coordinate)[0], toGcj(this.endpoints.campus.coordinate)[1]));
      this.markers.station.setPosition(new AMap.LngLat(toGcj(this.endpoints.station.coordinate)[0], toGcj(this.endpoints.station.coordinate)[1]));
      this.markers.campus.setContent(this.markerContent(this.endpoints.campus, 'assets/marker-campus.svg'));
      this.markers.station.setContent(this.markerContent(this.endpoints.station, 'assets/marker-station.svg'));
    }

    addRouteLayer() {
      if (!this.map) return;
      this.routeHalo = new AMap.Polyline({
        path: [],
        strokeColor: 'rgba(112,196,194,0.24)',
        strokeWeight: 12,
        strokeOpacity: 0.45,
        lineJoin: 'round',
        lineCap: 'round',
        zIndex: 80
      });
      this.routePolyline = new AMap.Polyline({
        path: [],
        strokeColor: '#267f86',
        strokeWeight: 4,
        strokeOpacity: 0.9,
        lineJoin: 'round',
        lineCap: 'round',
        showDir: true,
        zIndex: 81
      });
      this.map.add([this.routeHalo, this.routePolyline]);
    }

    setRoute(route) {
      if (this.fallbackMap) return this.fallbackMap.setRoute(route);
      if (!this.map) return;
      const hasRoute = route && route.coordinates && route.coordinates.length >= 2;
      this.route = hasRoute ? route.coordinates : [this.endpoints.campus.coordinate, this.endpoints.station.coordinate];
      this.routePreview = !hasRoute;
      this.projectCoordinatesAreGcj = !!(route && route.coordinateSystem === 'GCJ02');
      const gcjPath = this.route.map(this.projectCoordinatesAreGcj ? function (point) { return point.slice(); } : toGcj);
      this.routeCoordinatesGcj = gcjPath;
      if (this.routeHalo) this.routeHalo.setPath(gcjPath);
      if (this.routePolyline) this.routePolyline.setPath(gcjPath);
      this.fitRoute();
      this.setRisk(this.risk);
    }

    fitRoute() {
      if (!this.map || !this.route || this.route.length < 2) return;
      const overlays = [this.routeHalo, this.routePolyline, this.markers.campus, this.markers.station].filter(Boolean);
      if (overlays.length) {
        this.map.setFitView(overlays, false, [90, 50, 240, 50], 13);
      }
    }

    setRisk(risk) {
      this.risk = clamp(Number(risk) || 0, 0, 100);
      const color = global.RiskTideMapUtils ? global.RiskTideMapUtils.riskColor(this.risk) : [38, 127, 134];
      const rgba = 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',0.9)';
      const halo = 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',' + (this.risk > 70 ? 0.26 : 0.15) + ')';
      if (this.routePolyline) this.routePolyline.setOptions({ strokeColor: rgba, strokeOpacity: 0.9, strokeWeight: this.risk > 70 ? 5 : 4 });
      if (this.routeHalo) this.routeHalo.setOptions({ strokeColor: halo, strokeWeight: this.risk > 70 ? 18 : 12 });
    }

    getScreenPath(coordinates, coordinateSystem) {
      if (this.fallbackMap && typeof this.fallbackMap.getScreenPath === 'function') {
        return this.fallbackMap.getScreenPath(coordinates, coordinateSystem);
      }
      const points = [];
      if (!this.map || !this.ready) {
        for (let f = 0; f < coordinates.length; f += 1) points.push(this.project(coordinates[f]));
        return points;
      }
      const isGcj = coordinateSystem === 'GCJ02';
      for (let i = 0; i < coordinates.length; i += 1) {
        const source = coordinates[i];
        const current = isGcj ? source : toGcj(source);
        const screen = this.map.lngLatToContainer(new AMap.LngLat(current[0], current[1]));
        points.push({ x: screen.x, y: screen.y });
      }
      return points;
    }
    project(coordinate) {
      if (this.fallbackMap && typeof this.fallbackMap.project === 'function') {
        return this.fallbackMap.project(coordinate);
      }
      if (this.map && this.ready) {
        const current = this.projectCoordinatesAreGcj ? coordinate : toGcj(coordinate);
        const screen = this.map.lngLatToContainer(new AMap.LngLat(current[0], current[1]));
        return { x: screen.x, y: screen.y };
      }
      const bounds = config.map.maxBounds;
      const width = this.container ? this.container.clientWidth : global.innerWidth;
      const height = this.container ? this.container.clientHeight : global.innerHeight;
      return {
        x: ((coordinate[0] - bounds[0][0]) / (bounds[1][0] - bounds[0][0])) * width,
        y: ((bounds[1][1] - coordinate[1]) / (bounds[1][1] - bounds[0][1])) * height
      };
    }

    resize() {
      if (this.fallbackMap) return this.fallbackMap.resize();
      if (this.map && typeof this.map.resize === 'function') this.map.resize();
    }

    getMoving() { return this.fallbackMap ? this.fallbackMap.getMoving() : this.moving; }
    getReady() { return this.fallbackMap ? this.fallbackMap.getReady() : (this.ready && !this.fallback); }

    planRoutes() {
      if (!global.AMap || !global.AMap.Driving || !global.AMap.Transfer) return Promise.resolve(null);
      const amapConfig = config.amap || {};
      const origin = toGcj(this.endpoints.campus.coordinate);
      const destination = toGcj(this.endpoints.station.coordinate);
      const drivingPolicies = amapConfig.drivingVariants || [];
      const self = this;

      const drivePromises = drivingPolicies.map(function (variant) {
        const policyValue = global.AMap.DrivingPolicy && global.AMap.DrivingPolicy[variant.policy] !== undefined
          ? global.AMap.DrivingPolicy[variant.policy]
          : 0;
        const planner = new AMap.Driving({
          policy: policyValue,
          map: null,
          hideMarkers: true,
          extensions: 'base'
        });
        return searchWithPlanner(planner, origin, destination)
          .then(function (result) {
            return routeToVariant(variant.id, variant.label, '高德地图 Driving · ' + variant.policy, flattenDriving(result));
          });
      });

      const transferPlanner = new AMap.Transfer({
        city: this.city || '无锡',
        cityd: this.city || '无锡',
        policy: AMap.TransferPolicy && AMap.TransferPolicy.LEAST_TIME !== undefined ? AMap.TransferPolicy.LEAST_TIME : 0,
        map: null,
        panel: null,
        extensions: 'base'
      });
      const transferPromise = searchWithPlanner(transferPlanner, origin, destination)
        .then(function (result) {
          return routeToVariant('amap-transit', '高德公交·时间优先', '高德地图 Transfer · LEAST_TIME', flattenTransfer(result));
        });

      return Promise.all([
        Promise.all(drivePromises).catch(function () { return []; }),
        transferPromise.catch(function () { return null; })
      ]).then(function (values) {
        const driving = values[0].filter(function (item) { return item && item.coordinates.length >= 2; });
        const transit = values[1] && values[1].coordinates.length >= 2 ? values[1] : null;
        const routes = {};

        if (driving.length) {
          routes.taxi = Object.assign({}, global.routes.taxi, {
            durationMinutes: driving[0].durationMinutes,
            distanceMeters: driving[0].distanceMeters,
            rawDurationSeconds: driving[0].rawDurationSeconds,
            source: '高德地图路线规划 · 2026-09-29',
            sourceUrl: 'https://lbs.amap.com/api/javascript-api-v2/guide/services/driving',
            verified: false,
            coordinates: driving[0].coordinates,
            coordinateSystem: 'GCJ02',
            variants: driving
          });
        }

        if (transit) {
          routes.bus = Object.assign({}, global.routes.bus, {
            durationMinutes: transit.durationMinutes,
            distanceMeters: transit.distanceMeters,
            rawDurationSeconds: transit.rawDurationSeconds,
            source: '高德地图公交换乘规划 · 2026-09-29',
            sourceUrl: 'https://lbs.amap.com/api/javascript-api-v2/guide/services/transfer',
            verified: false,
            coordinates: transit.coordinates,
            coordinateSystem: 'GCJ02',
            variants: [transit],
            stopNames: []
          });
        }

        self.onRoutesReady(routes);
        self.onStatus({ state: 'ready', message: '高德地图与路线已完成规划' });
        return routes;
      }).catch(function (error) {
        self.onStatus({ state: 'warning', message: '高德路线规划失败：' + error.message });
        return null;
      });
    }
  }

  global.RiskTideAmapMap = RiskTideAmapMap;
})(window);













