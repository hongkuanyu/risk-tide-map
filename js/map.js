/* global window, document */
(function (global) {
  'use strict';

  const config = global.RiskTideConfig;

  function waitForMapLibre() {
    if (global.maplibregl) return Promise.resolve(global.maplibregl);
    return new Promise(function (resolve, reject) {
      let elapsed = 0;
      const timer = global.setInterval(function () {
        elapsed += 120;
        if (global.maplibregl) {
          global.clearInterval(timer);
          resolve(global.maplibregl);
        } else if (elapsed > 3200) {
          global.clearInterval(timer);
          reject(new Error('MapLibre 未加载，启用墨黑网格降级底图。'));
        }
      }, 120);
    });
  }

  function cssRgb(rgb, alpha) {
    return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
  }

  function mixRgb(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t)
    ];
  }

  function smoothstep01(t) {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
  }

  /* 风险读条 / 示意虚线 / 高德路线共用单程风险色阶（coreRamp，青蓝→金→赤红）。 */
  function riskColor(risk) {
    const value = Math.max(0, Math.min(100, Number(risk) || 0));
    const ramp = (config.ink && config.ink.coreRamp) || (config.silk && config.silk.riskRamp);
    if (ramp && ramp.length) {
      const t = value / 100;
      let a = ramp[0];
      let b = ramp[ramp.length - 1];
      for (let i = 1; i < ramp.length; i += 1) {
        if (t <= ramp[i].at) { a = ramp[i - 1]; b = ramp[i]; break; }
      }
      const span = (b.at - a.at) || 1;
      return mixRgb(a.rgb, b.rgb, smoothstep01((t - a.at) / span));
    }
    const colors = config.colors;
    if (value <= 30) return colors.safe;
    if (value <= 70) return mixRgb(colors.safe, colors.gold, (value - 30) / 40);
    return mixRgb(colors.gold, colors.danger, (value - 70) / 30);
  }

  function routeGeometry(route, fallback) {
    if (route && route.coordinates && route.coordinates.length >= 2) {
      return { coordinates: route.coordinates, preview: false };
    }
    if (fallback && fallback.campus && fallback.station
        && fallback.campus.coordinate && fallback.station.coordinate) {
      return {
        coordinates: [fallback.campus.coordinate, fallback.station.coordinate],
        preview: true
      };
    }
    return { coordinates: [], preview: true };
  }

  class RiskTideMap {
    constructor() {
      this.map = null;
      this.container = null;
      this.canvasStage = null;
      this.endpoints = { campus: null, station: null };
      this.markers = {};
      this.route = null;
      this.routePreview = true;
      this.risk = 0;
      this.moving = false;
      this.ready = false;
      this.fallback = false;
      this.onMovement = null;
      this.onStatus = null;
      this.styleLoaded = false;
      this.errorNotified = false;
      this.lastPlanError = '';
    }

    init(options) {
      this.container = options.container;
      this.canvasStage = options.canvasStage;
      this.onMovement = options.onMovement || function () {};
      this.onStatus = options.onStatus || function () {};
      /* 与高德控制器保持同一套接口；无在线服务时由 OSRM 请求真实道路折线。 */
      this.onRoutesReady = options.onRoutesReady || function () {};

      if (!this.container) return Promise.reject(new Error('缺少地图容器。'));

      return waitForMapLibre()
        .then(() => { this.createMap(); return null; })
        .catch((error) => {
          this.enableFallback(error.message);
          return null;
        });
    }

    createMap() {
      const mapConfig = config.map;
      this.map = new global.maplibregl.Map({
        container: this.container,
        style: {
          version: 8,
          sources: {
            osm: {
              type: 'raster',
              tiles: [mapConfig.tileUrl],
              tileSize: 256,
              maxzoom: mapConfig.tileMaxZoom || 19,
              attribution: mapConfig.attribution
            }
          },
          layers: [
            {
              id: 'osm-raster',
              type: 'raster',
              source: 'osm',
              paint: {
                'raster-opacity': Math.max(0.58, mapConfig.rasterOpacity),
                'raster-saturation': -0.22,
                'raster-contrast': 0.38,
                'raster-brightness-min': 0.10,
                'raster-brightness-max': 0.84
              }
            }
          ]
        },
        center: mapConfig.center,
        zoom: mapConfig.zoom,
        minZoom: mapConfig.minZoom,
        maxZoom: mapConfig.maxZoom,
        maxBounds: mapConfig.maxBounds,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        antialias: true,
        fadeDuration: 280
      });

      this.map.addControl(new global.maplibregl.NavigationControl({
        showCompass: false,
        showZoom: true,
        visualizePitch: false
      }), 'bottom-right');

      this.map.addControl(new global.maplibregl.AttributionControl({
        compact: true,
        customAttribution: mapConfig.attribution
      }), 'bottom-left');

      this.map.on('load', () => {
        this.ready = true;
        this.styleLoaded = true;
        this.container.classList.remove('is-fallback');
        this.fallback = false;
        this.removeFallbackOverlay();
        this.addRouteLayers();
        this.addMarkers();
        this.fitRoute();
        this.onStatus({ state: 'ready', message: '' });
      });

      this.map.on('move', () => {
        this.moving = true;
        this.onMovement(true);
      });

      this.map.on('moveend', () => {
        this.moving = false;
        this.onMovement(false);
      });

      this.map.on('error', (event) => {
        const message = event && event.error ? event.error.message : '地图资源加载异常';
        if (!this.errorNotified) {
          this.errorNotified = true;
          this.onStatus({ state: 'warning', message: message });
        }
      });

      global.setTimeout(() => {
        if (!this.ready) {
          this.enableFallback('地图初始化超时，改用坐标投影示意位置。');
        }
      }, 9000);

      return this.map;
    }

    enableFallback(message) {
      this.fallback = true;
      this.ready = false;
      if (this.canvasStage) this.canvasStage.classList.add('is-fallback');
      if (this.container) this.container.classList.add('is-fallback');
      this.createFallbackOverlay();
      this.onStatus({ state: 'warning', message: message || '地图底图不可用，粒子系统继续运行。' });
    }

    addRouteLayers() {
      if (!this.map || !this.map.getSource) return;
      if (!this.map.getSource('risk-route')) {
        this.map.addSource('risk-route', {
          type: 'geojson',
          lineMetrics: true,
          data: { type: 'FeatureCollection', features: [] }
        });
      }

      if (!this.map.getLayer('risk-route-halo')) {
        this.map.addLayer({
          id: 'risk-route-halo',
          type: 'line',
          source: 'risk-route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            /* V4: a faint wet-ink bed under the silk strands. */
            'line-color': cssRgb(config.colors.safeBright, 0.11),
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 7, 15, 15],
            'line-blur': 4,
            'line-opacity': 0
          }
        });
      }

      if (!this.map.getLayer('risk-route-core')) {
        this.map.addLayer({
          id: 'risk-route-core',
          type: 'line',
          source: 'risk-route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': cssRgb(config.colors.safe, 0.70),
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.7, 15, 1.4],
            'line-opacity': 0
          }
        });
      }

      if (!this.map.getLayer('risk-route-flow')) {
        this.map.addLayer({
          id: 'risk-route-flow',
          type: 'line',
          source: 'risk-route',
          layout: { 'line-cap': 'butt', 'line-join': 'round' },
          paint: {
            'line-color': cssRgb(config.colors.coolWhite, 0.6),
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 15, 1.2],
            'line-opacity': 0,
            'line-dasharray': [0.3, 3.2]
          }
        });
      }
    }

    addMarkers() {
      if (!this.map) return;
      if (!this.endpoints.campus || !this.endpoints.station
          || !this.endpoints.campus.coordinate || !this.endpoints.station.coordinate) return;
      const endpoints = this.endpoints;

      const campusElement = document.createElement('div');
      campusElement.className = 'map-marker campus-marker';
      campusElement.setAttribute('title', endpoints.campus.name + '（位置待核对）');
      campusElement.innerHTML = '<img src="assets/marker-campus.svg" alt=""><span class="marker-label">' + endpoints.campus.shortName + '</span>';

      const stationElement = document.createElement('div');
      stationElement.className = 'map-marker station-marker';
      stationElement.setAttribute('title', endpoints.station.name + '（位置待核对）');
      stationElement.innerHTML = '<img src="assets/marker-station.svg" alt=""><span class="marker-label">' + endpoints.station.shortName + '</span>';

      this.markers.campus = new global.maplibregl.Marker({ element: campusElement, anchor: 'bottom' })
        .setLngLat(endpoints.campus.coordinate)
        .addTo(this.map);

      this.markers.station = new global.maplibregl.Marker({ element: stationElement, anchor: 'bottom' })
        .setLngLat(endpoints.station.coordinate)
        .addTo(this.map);
    }

    setEndpoints(endpoints) {
      if (!endpoints) return;
      if (endpoints.campus) this.endpoints.campus = endpoints.campus;
      if (endpoints.station) this.endpoints.station = endpoints.station;
      if (!this.map || !this.ready) return;
      if (!this.markers.campus || !this.markers.station) this.addMarkers();
      this.repositionMarkers();
      // Rebuild the preview geometry from the new endpoints so the map and
      // the particle flow both move immediately, before the router answers.
      this.setRoute(null);
      this.fitRoute();
    }

    getEndpoints() { return this.endpoints; }

    /* OpenStreetMap 底图没有官方在线导航，但可通过 OSRM 公共演示服务
       为任意起终点请求真实驾车道路折线；失败时退化为起终点示意。 */
    supportsPlanning() {
      return true;
    }

    replanRoutes(guard) {
      if (!this.endpoints.campus || !this.endpoints.station
          || !this.endpoints.campus.coordinate || !this.endpoints.station.coordinate) {
        this.lastPlanError = '请先设置起点和终点';
        return Promise.resolve(null);
      }
      const origin = this.endpoints.campus.coordinate;
      const destination = this.endpoints.station.coordinate;
      const url = 'https://router.project-osrm.org/route/v1/driving/'
        + origin[0] + ',' + origin[1] + ';' + destination[0] + ',' + destination[1]
        + '?overview=full&geometries=geojson&alternatives=false&steps=false';
      const self = this;
      return global.fetch(url).then(function (res) {
        if (!res.ok) throw new Error('OSRM 请求失败（' + res.status + '）');
        return res.json();
      }).then(function (json) {
        if (guard && !guard()) return null;
        if (!json || json.code !== 'Ok' || !json.routes || !json.routes.length) {
          throw new Error('OSRM 未返回可用路线');
        }
        const route = json.routes[0];
        const geometry = route.geometry || {};
        const coordinates = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
        if (coordinates.length < 2) throw new Error('OSRM 路线几何为空');
        const durationSeconds = Number(route.duration) || 0;
        const distanceMeters = Number(route.distance) || 0;
        const variant = {
          id: 'osrm-fast',
          label: 'OSRM 驾车',
          durationMinutes: Math.max(1, Math.ceil(durationSeconds / 60)),
          distanceMeters: distanceMeters,
          rawDurationSeconds: durationSeconds,
          source: 'OSRM public demo · ' + new Date().toISOString().slice(0, 10),
          verified: false,
          coordinates: coordinates
        };
        const taxi = Object.assign({}, global.routes.taxi, {
          durationMinutes: variant.durationMinutes,
          distanceMeters: distanceMeters,
          rawDurationSeconds: durationSeconds,
          source: variant.source,
          verified: false,
          coordinates: coordinates,
          coordinateSystem: 'WGS84',
          variants: [variant]
        });
        self.lastPlanError = '';
        self.onRoutesReady({ taxi: taxi });
        return { taxi: taxi };
      }).catch(function (error) {
        if (guard && !guard()) return null;
        self.lastPlanError = (error && error.message) || 'OSRM 路线规划失败';
        return null;
      });
    }

    /* 无真实道路几何时折线只作弱化虚线示意。 */
    previewVisible() {
      return this.routePreview;
    }

    repositionMarkers() {
      if (!this.markers.campus || !this.markers.station
          || !this.endpoints.campus || !this.endpoints.station) return;
      this.markers.campus.setLngLat(this.endpoints.campus.coordinate);
      this.markers.station.setLngLat(this.endpoints.station.coordinate);
      const campusLabel = this.markers.campus.getElement().querySelector('.marker-label');
      const stationLabel = this.markers.station.getElement().querySelector('.marker-label');
      if (campusLabel) campusLabel.textContent = this.endpoints.campus.shortName || this.endpoints.campus.name || '起点';
      if (stationLabel) stationLabel.textContent = this.endpoints.station.shortName || this.endpoints.station.name || '终点';
    }
    toGeoJSON(coordinates) {
      return {
        type: 'FeatureCollection',
        features: coordinates && coordinates.length >= 2 ? [{
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: coordinates }
        }] : []
      };
    }

    setRoute(route) {
      const geometry = route && route.coordinates && route.coordinates.length >= 2
        ? routeGeometry(route, this.endpoints)
        : ((this.endpoints.campus && this.endpoints.station
            && this.endpoints.campus.coordinate && this.endpoints.station.coordinate)
          ? { coordinates: [this.endpoints.campus.coordinate, this.endpoints.station.coordinate], preview: true }
          : { coordinates: [], preview: true });
      this.route = geometry.coordinates;
      this.routePreview = geometry.preview;
      this.updateFallbackOverlay();

      if (this.map && this.map.getSource && this.map.getSource('risk-route')) {
        this.map.getSource('risk-route').setData(this.toGeoJSON(this.route));
        if (this.map.getLayer('risk-route-core')) {
          this.map.setPaintProperty('risk-route-core', 'line-dasharray', this.routePreview ? [2, 3] : [1.2, 1.8]);
          this.map.setPaintProperty('risk-route-core', 'line-opacity', this.previewVisible() ? 0.34 : 0);
        }
      }
    }

    fitRoute() {
      if (!this.map || !this.route || this.route.length < 2) return;
      const padding = global.matchMedia('(max-width: 760px)').matches
        ? config.map.routePaddingMobile
        : config.map.routePaddingDesktop;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < this.route.length; i += 1) {
        const coordinate = this.route[i];
        minX = Math.min(minX, coordinate[0]);
        minY = Math.min(minY, coordinate[1]);
        maxX = Math.max(maxX, coordinate[0]);
        maxY = Math.max(maxY, coordinate[1]);
      }
      this.map.fitBounds([[minX, minY], [maxX, maxY]], {
        padding: padding,
        duration: 0,
        maxZoom: 13.1
      });
    }

    setRisk(risk) {
      this.risk = risk;
      if (!this.map || !this.ready) return;
      const color = riskColor(risk);
      /* InkFlowRenderer 拥有全部视觉；只有在"无真实道路几何"时，
         才让折线以弱化虚线露出来，明确这是示意而不是真实路线。 */
      const opacity = this.previewVisible() ? 0.34 : 0;
      const rasterOpacity = Math.max(0.48, config.map.rasterOpacity - Math.max(0, risk - 58) / 42 * 0.10);

      if (this.map.getLayer('risk-route-core')) {
        this.map.setPaintProperty('risk-route-core', 'line-color', cssRgb(color, 0.84));
        this.map.setPaintProperty('risk-route-core', 'line-opacity', opacity);
      }
      if (this.map.getLayer('risk-route-halo')) {
        this.map.setPaintProperty('risk-route-halo', 'line-color', cssRgb(color, 0));
      }
      if (this.map.getLayer('risk-route-flow')) {
        this.map.setPaintProperty('risk-route-flow', 'line-color', cssRgb(color, risk > 70 ? 0.95 : 0.7));
      }
      if (this.map.getLayer('osm-raster')) {
        this.map.setPaintProperty('osm-raster', 'raster-opacity', rasterOpacity);
        this.map.setPaintProperty('osm-raster', 'raster-contrast', 0.34 + risk / 100 * 0.12);
      }

      if (this.canvasStage) {
        this.canvasStage.dataset.risk = String(Math.round(risk));
      }
    }

    getScreenPath(coordinates, coordinateSystem) {
      const points = [];
      if (this.map && this.ready && typeof this.map.project === 'function') {
        for (let i = 0; i < coordinates.length; i += 1) {
          const point = this.map.project({ lng: coordinates[i][0], lat: coordinates[i][1] });
          points.push({ x: point.x, y: point.y });
        }
        return points;
      }
      for (let j = 0; j < coordinates.length; j += 1) {
        points.push(this.project(coordinates[j]));
      }
      return points;
    }
    project(coordinate) {
      if (this.map && this.ready && typeof this.map.project === 'function') {
        const point = this.map.project({ lng: coordinate[0], lat: coordinate[1] });
        return { x: point.x, y: point.y };
      }

      const bounds = config.map.maxBounds;
      const width = this.container ? this.container.clientWidth : global.innerWidth;
      const height = this.container ? this.container.clientHeight : global.innerHeight;
      const minX = bounds[0][0];
      const maxX = bounds[1][0];
      const minY = bounds[0][1];
      const maxY = bounds[1][1];
      return {
        x: ((coordinate[0] - minX) / (maxX - minX)) * width,
        y: ((maxY - coordinate[1]) / (maxY - minY)) * height
      };
    }

    createFallbackOverlay() {
      if (!this.canvasStage || this.fallbackLayer) return;
      const layer = document.createElement('div');
      layer.className = 'fallback-map-layer';
      layer.setAttribute('aria-label', '坐标投影降级地图');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'fallback-route-svg');
      const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      polyline.setAttribute('class', 'fallback-route-line');
      svg.appendChild(polyline);

      const makeMarker = (endpoint, className, asset) => {
        const marker = document.createElement('div');
        marker.className = 'fallback-map-marker ' + className;
        marker.innerHTML = '<img src="' + asset + '" alt=""><span class="fallback-marker-label"><b>' + endpoint.shortName + '</b><small>待核对位置</small></span>';
        layer.appendChild(marker);
        return marker;
      };

      const campusMarker = (this.endpoints.campus && this.endpoints.campus.coordinate)
        ? makeMarker(this.endpoints.campus, 'campus-marker', 'assets/marker-campus.svg') : null;
      const stationMarker = (this.endpoints.station && this.endpoints.station.coordinate)
        ? makeMarker(this.endpoints.station, 'station-marker', 'assets/marker-station.svg') : null;
      layer.insertBefore(svg, layer.firstChild);
      this.canvasStage.appendChild(layer);
      this.fallbackLayer = layer;
      this.fallbackSvg = svg;
      this.fallbackPolyline = polyline;
      this.fallbackMarkers = {
        campus: campusMarker,
        station: stationMarker
      };
      this.updateFallbackOverlay();
    }

    removeFallbackOverlay() {
      if (!this.fallbackLayer) return;
      this.fallbackLayer.remove();
      this.fallbackLayer = null;
      this.fallbackSvg = null;
      this.fallbackPolyline = null;
      this.fallbackMarkers = null;
    }

    updateFallbackOverlay() {
      if (!this.fallbackLayer || !this.canvasStage || !this.fallbackMarkers) return;
      const width = Math.max(1, this.canvasStage.clientWidth);
      const height = Math.max(1, this.canvasStage.clientHeight);
      this.fallbackSvg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      this.fallbackSvg.setAttribute('width', String(width));
      this.fallbackSvg.setAttribute('height', String(height));

      const hasEndpoints = !!(this.endpoints.campus && this.endpoints.station
        && this.endpoints.campus.coordinate && this.endpoints.station.coordinate);
      const coordinates = this.route && this.route.length >= 2
        ? this.route
        : (hasEndpoints ? [this.endpoints.campus.coordinate, this.endpoints.station.coordinate] : []);
      const points = [];
      for (let i = 0; i < coordinates.length; i += 1) {
        const point = this.project(coordinates[i]);
        points.push(point.x + ',' + point.y);
      }
      this.fallbackPolyline.setAttribute('points', points.join(' '));
      this.fallbackPolyline.setAttribute('class', this.routePreview ? 'fallback-route-line is-preview' : 'fallback-route-line');

      if (hasEndpoints && this.fallbackMarkers.campus && this.fallbackMarkers.station) {
        const campusPoint = this.project(this.endpoints.campus.coordinate);
        const stationPoint = this.project(this.endpoints.station.coordinate);
        this.fallbackMarkers.campus.style.left = campusPoint.x + 'px';
        this.fallbackMarkers.campus.style.top = campusPoint.y + 'px';
        this.fallbackMarkers.station.style.left = stationPoint.x + 'px';
        this.fallbackMarkers.station.style.top = stationPoint.y + 'px';
      }
    }
    resize() {
      if (this.map && typeof this.map.resize === 'function') this.map.resize();
      this.updateFallbackOverlay();
    }

    getMoving() {
      return this.moving;
    }

    getReady() {
      return this.ready && !this.fallback;
    }
  }

  global.RiskTideMap = RiskTideMap;
  global.RiskTideMapUtils = { riskColor: riskColor, mixRgb: mixRgb };
})(window);













