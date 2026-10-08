/* global window, document, AMap */
(function (global) {
  'use strict';

  var config = global.RiskTideConfig;
  var endpointMeta = {
    campus: { id: 'campus', shortName: '起点' },
    station: { id: 'station', shortName: '终点' }
  };


  var PI = Math.PI;
  var A = 6378245.0;
  var EE = 0.00669342162296594323;

  function isOutOfChina(lng, lat) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }

  function transformLat(x, y) {
    var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }

  function transformLng(x, y) {
    var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return ret;
  }

  function wgs84ToGcj02(lng, lat) {
    if (isOutOfChina(lng, lat)) return [lng, lat];
    var dLat = transformLat(lng - 105.0, lat - 35.0);
    var dLng = transformLng(lng - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * PI;
    var magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    var adjustLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
    var adjustLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
    return [lng + adjustLng, lat + adjustLat];
  }

  /* AMap place search / geolocation returns GCJ02. The map and every stored
     endpoint use WGS84, so untranslated GCJ02 points would drift ~500m. */
  function gcj02ToWgs84(lng, lat) {
    if (isOutOfChina(lng, lat)) return [lng, lat];
    var wgsLng = lng;
    var wgsLat = lat;
    for (var i = 0; i < 4; i += 1) {
      var gcj = wgs84ToGcj02(wgsLng, wgsLat);
      wgsLng += lng - gcj[0];
      wgsLat += lat - gcj[1];
    }
    return [wgsLng, wgsLat];
  }
  function readPoint(point) {
    if (!point) return null;
    if (typeof point.getLng === 'function') return [point.getLng(), point.getLat()];
    if (Array.isArray(point) && point.length >= 2) return [Number(point[0]), Number(point[1])];
    if (Number.isFinite(point.lng) && Number.isFinite(point.lat)) return [point.lng, point.lat];
    return null;
  }

  function pickCity(adcode, region, city) {
    if (city && typeof city === 'string' && city.indexOf('市') < 0) return city;
    if (region) return region;
    if (adcode) return String(adcode);
    return '无锡';
  }

  function LocationSearch(options) {
    this.originInput = options.originInput;
    this.destInput = options.destInput;
    this.swapButton = options.swapButton;
    this.locateButton = options.locateButton;
    this.hint = options.hint;
    this.onSelect = options.onSelect || function () {};
    this.onLocate = options.onLocate || function () {};
    this.autocomplete = null;
    this.autoMap = {};
    this.geocoder = null;
    this.geolocation = null;
    this.role = null;
    this.pending = null;
    this.silent = false;
    this.tries = 0;
    this.bind();
  }

  LocationSearch.prototype.setHint = function (message, type) {
    if (!this.hint) return;
    this.hint.textContent = message || '';
    this.hint.dataset.type = type || '';
  };

  LocationSearch.prototype.bind = function () {
    var self = this;
    ['origin', 'dest'].forEach(function (role) {
      var input = role === 'origin' ? self.originInput : self.destInput;
      if (!input) return;
      input.addEventListener('input', function () {
        self.role = role;
        var instance = self.autoMap && self.autoMap[role];
        if (instance) instance.search(input.value);
      });
      input.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' || !input.value) return;
        event.preventDefault();
        self.role = role;
        self.searchText(input.value);
      });
      input.addEventListener('focus', function () {
        self.role = role;
        self.showEndpoint();
      });
    });
    if (this.swapButton) this.swapButton.addEventListener('click', function () { self.swap(); });
    if (this.locateButton) this.locateButton.addEventListener('click', function () { self.useCurrentLocation(); });

  };

  LocationSearch.prototype.showEndpoint = function () {
    if (this.silent || !this.role) return;
    var endpoint = config.endpoints[this.role];
    var input = this.role === 'origin' ? this.originInput : this.destInput;
    if (!input || !endpoint) return;
    var place = global.RiskTideApp && global.RiskTideApp.map ? global.RiskTideApp.map.getEndpoints() : null;
    var current = place && place[this.role] ? place[this.role] : endpoint;
    this.silent = true;
    input.value = current.shortName || current.name || '';
    this.silent = false;
  };


  LocationSearch.prototype.commit = function (coordinate, meta) {
    var role = this.role === 'dest' ? 'station' : (this.role || 'campus');
    var input = role === 'campus' ? this.originInput : this.destInput;
    var name = (meta && (meta.name || meta.shortName)) || (input ? input.value : '');
    var wgs = gcj02ToWgs84(coordinate[0], coordinate[1]);
    var endpoint = Object.assign({}, endpointMeta[role], {
      name: name,
      shortName: name,
      coordinate: [wgs[0], wgs[1]],
      coordinateSystem: 'WGS84',
      source: '高德地图地点搜索 · ' + new Date().toISOString().slice(0, 10),
      verified: false
    });
    if (input) input.value = name;
    this.setHint('已选择「' + name + '」，正在重新规划路线…', 'ok');
    this.onSelect(role, endpoint, meta && meta.city);
  };

  LocationSearch.prototype.swap = function () {
    var map = global.RiskTideApp && global.RiskTideApp.map;
    if (!map || typeof map.getEndpoints !== 'function') return;
    var current = map.getEndpoints();
    if (!current || !current.campus || !current.station) return;
    var campus = Object.assign({}, current.station, { id: 'campus' });
    var station = Object.assign({}, current.campus, { id: 'station' });
    var originName = campus.shortName;
    var destName = station.shortName;
    campus.shortName = originName;
    station.shortName = destName;
    if (this.originInput) this.originInput.value = campus.shortName || campus.name;
    if (this.destInput) this.destInput.value = station.shortName || station.name;
    this.onSelect('both', { campus: campus, station: station }, campus.city || station.city);
  };

  LocationSearch.prototype.useCurrentLocation = function () {
    var self = this;
    if (!this.geolocation || !this.geocoder) {
      this.setHint('定位需要加载高德服务；如果网络受限，可先手动输入起点。', 'warning');
      return;
    }
    this.setHint('正在获取当前位置…', '');
    this.geolocation.getCurrentPosition(function (status, result) {
      if (status !== 'complete' || !result || !result.position) {
        self.setHint('定位失败，请检查浏览器定位权限。', 'warning');
        return;
      }
      var point = readPoint(result.position);
      self.role = 'origin';
      self.geocoder.getAddress(point, function (geoStatus, geoResult) {
        var regeocode = geoStatus === 'complete' && geoResult ? geoResult.regeocode : null;
        var formatted = regeocode && regeocode.formattedAddress ? regeocode.formattedAddress : '当前位置';
        var city = pickCity(regeocode && regeocode.addressComponent && regeocode.addressComponent.adcode,
          regeocode && regeocode.addressComponent && regeocode.addressComponent.city,
          '');
        self.commit(point, { name: formatted, shortName: formatted, city: city });
        self.onLocate(point, formatted);
      });
    }, { enableHighAccuracy: true, timeout: 10000 });
  };

  LocationSearch.prototype.searchText = function (text) {
    var self = this;
    if (!global.AMap || !global.AMap.PlaceSearch || !text) return;
    this.setHint('正在搜索「' + text + '」…', '');
    var search = new AMap.PlaceSearch({ city: '全国', pageSize: 1, citylimit: false, extensions: 'base' });
    search.search(text, function (status, result) {
      var poi = status === 'complete' && result && result.poiList && result.poiList.pois && result.poiList.pois[0];
      if (!poi) {
        self.setHint('没有找到这个地点，换个更具体的名称试试。', 'warning');
        return;
      }
      var point = readPoint(poi.location);
      if (!point) {
        self.setHint('这个地点没有可用坐标。', 'warning');
        return;
      }
      self.commit(point, {
        name: poi.name,
        shortName: poi.name,
        city: pickCity(poi.adcode, poi.pname, poi.cityname)
      });
    });
  };

  LocationSearch.prototype.ready = function () {
    if (!global.AMap || !global.AMap.AutoComplete) return false;
    if (this.autocomplete) return true;
    var self = this;
    this.autocomplete = new AMap.AutoComplete({ city: '全国', citylimit: false });
    if (global.AMap.Geocoder) this.geocoder = new AMap.Geocoder({ city: '全国' });
    if (global.AMap.Geolocation) {
      this.geolocation = new AMap.Geolocation({ enableHighAccuracy: true, timeout: 10000, showButton: false, showMarker: false, showCircle: false });
    }
    var inputs = [
      { role: 'origin', element: this.originInput },
      { role: 'dest', element: this.destInput }
    ];
    inputs.forEach(function (item) {
      if (!item.element) return;
      var instance = new AMap.AutoComplete({ input: item.element, city: '全国', citylimit: false });
      self.autoMap[item.role] = instance;
      instance.on('select', function (event) {
        self.role = item.role;
        var poi = event && event.poi;
        if (!poi) return;
        var point = readPoint(poi.location);
        if (point) {
          self.commit(point, { name: poi.name || item.element.value, shortName: poi.name || item.element.value, city: pickCity(poi.adcode, poi.district, poi.cityname) });
          return;
        }
        self.searchText(poi.name || item.element.value);
      });
    });
    this.setHint('可直接搜索全国任一地点，或使用当前位置。', '');
    return true;
  };
  LocationSearch.prototype.sync = function () {
    this.tries += 1;
    if (this.ready()) return true;
    if (this.tries > 60) {
      this.setHint('高德服务未加载，搜索暂不可用；地图与风险计算仍可使用。', 'warning');
      return false;
    }
    return false;
  };

  LocationSearch.prototype.setBusy = function (busy) {
    if (this.locateButton) {
      this.locateButton.disabled = !!busy;
      this.locateButton.textContent = busy ? '正在定位…' : '使用当前位置';
    }
  };

  global.RiskTideLocationSearch = LocationSearch;
})(window);



