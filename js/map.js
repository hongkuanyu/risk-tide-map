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

  function riskColor(risk) {
    const colors = config.colors;
    const value = Math.max(0, Math.min(100, Number(risk) || 0));
    if (value <= 30) return colors.safe;
    if (value <= 70) return mixRgb(colors.safe, colors.gold, (value - 30) / 40);
    return mixRgb(colors.gold, colors.danger, (value - 70) / 30);
  }

  function routeGeometry(route, fallback) {
    if (route && route.coordinates && route.coordinates.length >= 2) {
      return { coordinates: route.coordinates, preview: false };
    }
    return {
      coordinates: [fallback.campus.coordinate, fallback.station.coordinate],
      preview: true
    };
  }

  class RiskTideMap {
    constructor() {
      this.map = null;
      this.container = null;
      this.canvasStage = null;
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
    }

    init(options) {
      this.container = options.container;
      this.canvasStage = options.canvasStage;
      this.onMovement = options.onMovement || function () {};
      this.onStatus = options.onStatus || function () {};

      if (!this.container) return Promise.reject(new Error('缺少地图容器。'));

      return waitForMapLibre()
        .then(() => this.createMap())
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
                'raster-opacity': mapConfig.rasterOpacity,
                'raster-saturation': -0.88,
                'raster-contrast': 0.52,
                'raster-brightness-min': 0.02,
                'raster-brightness-max': 0.66
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
            'line-color': cssRgb(config.colors.safeBright, 0.18),
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 8, 15, 18],
            'line-blur': 3
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
            'line-color': cssRgb(config.colors.safe, 0.78),
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.2, 15, 4.8],
            'line-opacity': 0.84,
            'line-dasharray': [1.2, 1.8]
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
            'line-color': cssRgb(config.colors.coolWhite, 0.7),
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 15, 2.3],
            'line-opacity': 0.38,
            'line-dasharray': [0.3, 3.2]
          }
        });
      }
    }

    addMarkers() {
      if (!this.map) return;
      const endpoints = config.endpoints;

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
      const geometry = routeGeometry(route, config.endpoints);
      this.route = geometry.coordinates;
      this.routePreview = geometry.preview;
      this.updateFallbackOverlay();

      if (this.map && this.map.getSource && this.map.getSource('risk-route')) {
        this.map.getSource('risk-route').setData(this.toGeoJSON(this.route));
        this.map.setPaintProperty('risk-route-core', 'line-dasharray', this.routePreview ? [1.2, 1.4] : [1.2, 1.8]);
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
      const opacity = 0.48 + Math.max(0, (risk - 50) / 50) * 0.12;
      const rasterOpacity = Math.max(0.16, config.map.rasterOpacity - Math.max(0, risk - 58) / 42 * 0.18);

      if (this.map.getLayer('risk-route-core')) {
        this.map.setPaintProperty('risk-route-core', 'line-color', cssRgb(color, 0.84));
        this.map.setPaintProperty('risk-route-core', 'line-opacity', opacity);
      }
      if (this.map.getLayer('risk-route-halo')) {
        this.map.setPaintProperty('risk-route-halo', 'line-color', cssRgb(color, risk > 70 ? 0.35 : 0.18));
      }
      if (this.map.getLayer('risk-route-flow')) {
        this.map.setPaintProperty('risk-route-flow', 'line-color', cssRgb(color, risk > 70 ? 0.95 : 0.7));
      }
      if (this.map.getLayer('osm-raster')) {
        this.map.setPaintProperty('osm-raster', 'raster-opacity', rasterOpacity);
        this.map.setPaintProperty('osm-raster', 'raster-contrast', 0.5 + risk / 100 * 0.32);
      }

      if (this.canvasStage) {
        this.canvasStage.dataset.risk = String(Math.round(risk));
      }
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

      const campusMarker = makeMarker(config.endpoints.campus, 'campus-marker', 'assets/marker-campus.svg');
      const stationMarker = makeMarker(config.endpoints.station, 'station-marker', 'assets/marker-station.svg');
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

      const coordinates = this.route && this.route.length >= 2
        ? this.route
        : [config.endpoints.campus.coordinate, config.endpoints.station.coordinate];
      const points = [];
      for (let i = 0; i < coordinates.length; i += 1) {
        const point = this.project(coordinates[i]);
        points.push(point.x + ',' + point.y);
      }
      this.fallbackPolyline.setAttribute('points', points.join(' '));
      this.fallbackPolyline.setAttribute('class', this.routePreview ? 'fallback-route-line is-preview' : 'fallback-route-line');

      const campusPoint = this.project(config.endpoints.campus.coordinate);
      const stationPoint = this.project(config.endpoints.station.coordinate);
      this.fallbackMarkers.campus.style.left = campusPoint.x + 'px';
      this.fallbackMarkers.campus.style.top = campusPoint.y + 'px';
      this.fallbackMarkers.station.style.left = stationPoint.x + 'px';
      this.fallbackMarkers.station.style.top = stationPoint.y + 'px';
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





