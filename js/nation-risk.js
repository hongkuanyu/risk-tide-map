/* global window */
/*
 * 全国墨迹 · 风险模型（示意）
 *
 * 重要：本模型不宣称任何真实时刻表。
 *   行程时间 = 直线距离 / 假设均速 + 固定接驳耗时
 * 所有城市的风险都由这一个公式推出，可解释、可复算、稳定 ——
 * 同样的输入永远得到同样的输出，随机性只允许出现在墨的纹理上。
 *
 * 风险计算本身完全复用 js/risk.js 的缓冲公式，不重写算法。
 */
(function (global) {
  'use strict';

  const DEFAULTS = {
    /* 假设均速（km/h）：高铁站到站的平均旅行速度，非最高速度；
       驾车含收费与路口损耗。都刻意取保守值。 */
    speed: { rail: 195, drive: 82 },
    /* 固定接驳耗时（分钟）：从起点到车站 + 从车站到城市 */
    overhead: { rail: 45, drive: 18 },
    mode: 'rail'
  };

  function toRad(deg) { return deg * Math.PI / 180; }

  /* 大圆距离（km） */
  function distanceKm(a, b) {
    const R = 6371;
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const la1 = toRad(a[1]);
    const la2 = toRad(b[1]);
    const h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function travelMinutes(km, options) {
    const cfg = Object.assign({}, DEFAULTS, options || {});
    const mode = cfg.mode === 'drive' ? 'drive' : 'rail';
    const speed = cfg.speed[mode];
    const overhead = cfg.overhead[mode];
    return km / speed * 60 + overhead;
  }

  /* 单座城市的风险：复用 risk.js，只是把"路线时间"换成推算行程时间 */
  function riskForCity(city, origin, params) {
    const riskModel = global.RiskTideRisk;
    const km = distanceKm(origin, city.coordinate);
    const minutes = travelMinutes(km, params);
    const result = riskModel.calculate({
      trainTime: params.trainTime,
      departureTime: params.departureTime,
      routeMinutes: minutes,
      stationMinutes: params.stationMinutes,
      safeBufferMinutes: params.safeBufferMinutes,
      weatherMinutes: 0
    });
    result.city = city;
    result.distanceKm = km;
    result.travelMinutes = minutes;
    result.reachable = result.valid;
    return result;
  }

  function computeAll(cities, origin, params) {
    const out = (cities || []).map(function (city) {
      return riskForCity(city, origin, params);
    });
    /* 稳定的排序：风险高的在前，风险相同按距离，再按 id —— 便于逐帧比较 */
    out.sort(function (a, b) {
      const ra = a.risk === null ? -1 : a.risk;
      const rb = b.risk === null ? -1 : b.risk;
      if (rb !== ra) return rb - ra;
      if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
      return a.city.id < b.city.id ? -1 : 1;
    });
    return out;
  }

  global.RiskTideNationRisk = {
    DEFAULTS: DEFAULTS,
    distanceKm: distanceKm,
    travelMinutes: travelMinutes,
    riskForCity: riskForCity,
    computeAll: computeAll
  };
})(window);