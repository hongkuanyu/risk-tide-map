/* global window */
(function (global) {
  'use strict';

  const DAY = 24 * 60;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function timeToMinutes(value) {
    if (typeof value !== 'string' || value.indexOf(':') < 0) return null;
    const parts = value.split(':');
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return ((hours * 60 + minutes) % DAY + DAY) % DAY;
  }

  function minutesToTime(totalMinutes) {
    const normalized = ((Math.round(totalMinutes) % DAY) + DAY) % DAY;
    const hours = Math.floor(normalized / 60);
    const minutes = normalized % 60;
    return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
  }

  function addMinutes(time, minutes) {
    const base = timeToMinutes(time);
    if (base === null || !Number.isFinite(minutes)) return '--:--';
    return minutesToTime(base + minutes);
  }

  function untilTime(departureTime, trainTime) {
    const departure = timeToMinutes(departureTime);
    const train = timeToMinutes(trainTime);
    if (departure === null || train === null) return null;
    return ((train - departure) % DAY + DAY) % DAY;
  }

  function calculateRisk(bufferMinutes, safeBufferMinutes) {
    const safe = Number.isFinite(safeBufferMinutes) ? safeBufferMinutes : 60;
    if (!Number.isFinite(bufferMinutes)) return null;
    if (bufferMinutes >= safe) return 0;
    if (bufferMinutes <= 0) return 100;
    return ((safe - bufferMinutes) / safe) * 100;
  }

  function riskLevel(risk) {
    if (!Number.isFinite(risk)) return 'unknown';
    if (risk < 30) return 'safe';
    if (risk < 70) return 'critical';
    if (risk < 85) return 'danger';
    return 'storm';
  }

  function riskLabel(risk) {
    const level = riskLevel(risk);
    /* 措辞对应"时间余量"而不是"迟到概率"，避免被读成 73% 会迟到 */
    return {
      safe: '宽裕',
      critical: '注意',
      danger: '很紧',
      storm: '可能迟到',
      unknown: '待设定'
    }[level];
  }

  function calculate(input) {
    const trainTime = input.trainTime || '18:00';
    const departureTime = input.departureTime || '16:00';
    const routeMinutes = Number(input.routeMinutes);
    const stationMinutes = Number(input.stationMinutes);
    const safeBufferMinutes = Number.isFinite(Number(input.safeBufferMinutes))
      ? Number(input.safeBufferMinutes)
      : 60;

    if (!Number.isFinite(routeMinutes) || routeMinutes <= 0 || !Number.isFinite(stationMinutes)) {
      return {
        valid: false,
        trainTime: trainTime,
        departureTime: departureTime,
        availableMinutes: untilTime(departureTime, trainTime),
        requiredMinutes: null,
        bufferMinutes: null,
        risk: null,
        level: 'unknown',
        label: riskLabel(null),
        latestDepartureTime: '--:--'
      };
    }

    const availableMinutes = untilTime(departureTime, trainTime);
    const requiredMinutes = routeMinutes + stationMinutes;
    const bufferMinutes = availableMinutes - requiredMinutes;
    const risk = calculateRisk(bufferMinutes, safeBufferMinutes);
    const latestDepartureTime = addMinutes(trainTime, -(routeMinutes + stationMinutes + safeBufferMinutes));

    return {
      valid: true,
      trainTime: trainTime,
      departureTime: departureTime,
      availableMinutes: availableMinutes,
      requiredMinutes: requiredMinutes,
      bufferMinutes: bufferMinutes,
      risk: risk,
      level: riskLevel(risk),
      label: riskLabel(risk),
      latestDepartureTime: latestDepartureTime
    };
  }

  function compareModes(routeMap) {
    const candidates = Object.keys(routeMap)
      .map(function (key) { return routeMap[key]; })
      .filter(function (route) {
        return route && Number.isFinite(Number(route.durationMinutes)) && Number(route.durationMinutes) > 0;
      })
      .sort(function (a, b) { return Number(a.durationMinutes) - Number(b.durationMinutes); });

    if (!candidates.length) {
      return { fastest: null, steadiest: null };
    }

    return {
      fastest: candidates[0],
      steadiest: candidates[candidates.length - 1]
    };
  }

  global.RiskTideRisk = {
    DAY: DAY,
    clamp: clamp,
    timeToMinutes: timeToMinutes,
    minutesToTime: minutesToTime,
    addMinutes: addMinutes,
    untilTime: untilTime,
    calculateRisk: calculateRisk,
    riskLevel: riskLevel,
    riskLabel: riskLabel,
    calculate: calculate,
    compareModes: compareModes
  };
})(window);
