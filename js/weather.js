/* global window, fetch */
/*
 * Risk Tide - real-time weather layer.
 *
 * Provider: Open-Meteo (https://open-meteo.com)
 *   - no API key, CORS enabled, so it works from a static GitHub Pages site
 *   - returns current conditions plus an hourly forecast we reuse to score
 *     the *planned departure hour*, not just "now"
 *
 * The module is intentionally dependency-free and exposes three things:
 *   RiskTideWeather.Client      -> cached fetch wrapper
 *   RiskTideWeather.parse       -> normalise an Open-Meteo payload
 *   RiskTideWeather.impact      -> weather -> extra route minutes
 */
(function (global) {
  'use strict';

  const DEFAULT_OPTIONS = {
    endpoint: 'https://api.open-meteo.com/v1/forecast',
    timezone: 'Asia/Shanghai',
    cacheMinutes: 10,
    staleHours: 6,
    timeoutMs: 9000,
    forecastDays: 2,
    maxExtraMinutes: 30,
    label: 'Open-Meteo'
  };

  /* WMO weather interpretation codes -> Chinese label, glyph and a base
     delay in minutes. Codes follow the Open-Meteo documentation. */
  const CODES = {
    0: { key: 'clear', label: '晴', glyph: 'clear', minutes: 0, severity: 0 },
    1: { key: 'mainly-clear', label: '晴间多云', glyph: 'partly', minutes: 0, severity: 0.05 },
    2: { key: 'partly-cloudy', label: '多云', glyph: 'partly', minutes: 1, severity: 0.1 },
    3: { key: 'overcast', label: '阴', glyph: 'cloud', minutes: 1, severity: 0.15 },
    45: { key: 'fog', label: '有雾', glyph: 'fog', minutes: 8, severity: 0.5 },
    48: { key: 'rime-fog', label: '雾凇', glyph: 'fog', minutes: 10, severity: 0.6 },
    51: { key: 'drizzle-light', label: '小毛毛雨', glyph: 'rain', minutes: 2, severity: 0.15 },
    53: { key: 'drizzle', label: '毛毛雨', glyph: 'rain', minutes: 4, severity: 0.22 },
    55: { key: 'drizzle-dense', label: '较密毛毛雨', glyph: 'rain', minutes: 6, severity: 0.3 },
    56: { key: 'freezing-drizzle-light', label: '冻毛毛雨', glyph: 'snow', minutes: 12, severity: 0.55 },
    57: { key: 'freezing-drizzle', label: '强冻毛毛雨', glyph: 'snow', minutes: 15, severity: 0.65 },
    61: { key: 'rain-slight', label: '小雨', glyph: 'rain', minutes: 5, severity: 0.3 },
    63: { key: 'rain', label: '中雨', glyph: 'rain', minutes: 9, severity: 0.5 },
    65: { key: 'rain-heavy', label: '大雨', glyph: 'rain', minutes: 15, severity: 0.75 },
    66: { key: 'freezing-rain-light', label: '冻雨', glyph: 'snow', minutes: 14, severity: 0.7 },
    67: { key: 'freezing-rain', label: '强冻雨', glyph: 'snow', minutes: 18, severity: 0.85 },
    71: { key: 'snow-slight', label: '小雪', glyph: 'snow', minutes: 7, severity: 0.5 },
    73: { key: 'snow', label: '中雪', glyph: 'snow', minutes: 11, severity: 0.65 },
    75: { key: 'snow-heavy', label: '大雪', glyph: 'snow', minutes: 17, severity: 0.85 },
    77: { key: 'snow-grains', label: '雪粒', glyph: 'snow', minutes: 6, severity: 0.45 },
    80: { key: 'showers-slight', label: '阵雨', glyph: 'rain', minutes: 5, severity: 0.35 },
    81: { key: 'showers', label: '强阵雨', glyph: 'rain', minutes: 10, severity: 0.55 },
    82: { key: 'showers-violent', label: '暴雨', glyph: 'rain', minutes: 16, severity: 0.85 },
    85: { key: 'snow-showers-slight', label: '阵雪', glyph: 'snow', minutes: 8, severity: 0.55 },
    86: { key: 'snow-showers-heavy', label: '强阵雪', glyph: 'snow', minutes: 14, severity: 0.8 },
    95: { key: 'thunderstorm', label: '雷阵雨', glyph: 'thunder', minutes: 15, severity: 0.8 },
    96: { key: 'thunderstorm-hail', label: '雷暴伴冰雹', glyph: 'thunder', minutes: 18, severity: 0.9 },
    99: { key: 'thunderstorm-hail-heavy', label: '强雷暴冰雹', glyph: 'thunder', minutes: 22, severity: 1 }
  };

  const UNKNOWN_CODE = { key: 'unknown', label: '天气未知', glyph: 'unknown', minutes: 0, severity: 0 };

  /* Inline SVG bodies so the panel keeps the ink look instead of emoji. */
  const GLYPH_PATHS = {
    clear: '<circle cx="12" cy="12" r="4.1"/><path d="M12 2.6v2.5M12 18.9v2.5M2.6 12h2.5M18.9 12h2.5M5.4 5.4l1.8 1.8M16.8 16.8l1.8 1.8M18.6 5.4l-1.8 1.8M7.2 16.8l-1.8 1.8"/>',
    partly: '<circle cx="8.6" cy="8.4" r="3.1"/><path d="M8.6 1.9v1.9M2.2 8.4h1.9M4.3 4.1l1.3 1.3M12.9 4.1l-1.3 1.3"/><path d="M9.4 18.8h8a3.3 3.3 0 0 0 .3-6.6 4.7 4.7 0 0 0-8.9-1.1 3.9 3.9 0 0 0 .6 7.7Z"/>',
    cloud: '<path d="M6.6 18.4h10.2a3.7 3.7 0 0 0 .3-7.4 5.3 5.3 0 0 0-10-1.3 4.4 4.4 0 0 0-.5 8.7Z"/>',
    rain: '<path d="M6.8 15.4h9.9a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.4-1.2 4.2 4.2 0 0 0-.8 8.2Z"/><path d="M8.7 17.9l-.9 2.2M12.1 17.9l-.9 2.2M15.5 17.9l-.9 2.2"/>',
    snow: '<path d="M6.8 14.4h9.9a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.4-1.2 4.2 4.2 0 0 0-.8 8.2Z"/><path d="M8.6 17.6v3.1M7.2 18.4l2.8 1.5M10 18.4l-2.8 1.5M15.4 17.6v3.1M14 18.4l2.8 1.5M16.8 18.4l-2.8 1.5"/>',
    thunder: '<path d="M6.8 14.4h9.9a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.4-1.2 4.2 4.2 0 0 0-.8 8.2Z"/><path d="M12.7 16.1l-2.3 3.5h2.5l-.8 2.7 3.2-4.1h-2.4l1.2-2.1Z"/>',
    fog: '<path d="M4.6 9.4h14.8M3.6 13h16.8M5.4 16.6h13.2M7.4 20h9.2"/>',
    unknown: '<path d="M6.6 18.4h10.2a3.7 3.7 0 0 0 .3-7.4 5.3 5.3 0 0 0-10-1.3 4.4 4.4 0 0 0-.5 8.7Z"/>'
  };

  function glyphMarkup(name) {
    const body = GLYPH_PATHS[name] || GLYPH_PATHS.unknown;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }

  function describe(code) {
    const numeric = Number(code);
    return CODES[numeric] || UNKNOWN_CODE;
  }

  /* Number(null) is 0, which would turn a missing visibility into "0 m =
     dense fog". Treat empty values as genuinely unknown. */
  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function minutesOfDay(value) {
    if (typeof value !== 'string' || value.indexOf(':') < 0) return null;
    const parts = value.split(':');
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return ((Math.round(hours) * 60 + Math.round(minutes)) % 1440 + 1440) % 1440;
  }

  function clockDistance(a, b) {
    const raw = Math.abs(a - b) % 1440;
    return Math.min(raw, 1440 - raw);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /* Index of the hourly slot that best represents the planned departure.
     Only slots at/after "now" are eligible, so a 06:00 departure viewed at
     23:00 resolves to tomorrow morning rather than this morning. */
  function departureHourIndex(hourly, currentTime, targetTime) {
    const times = hourly && hourly.time;
    if (!times || !times.length) return -1;
    const target = minutesOfDay(targetTime);
    if (target === null) return -1;

    let nowIndex = -1;
    if (typeof currentTime === 'string') {
      const nowHour = currentTime.slice(0, 13);
      for (let i = 0; i < times.length; i += 1) {
        if (times[i].slice(0, 13) === nowHour) { nowIndex = i; break; }
      }
    }
    if (nowIndex < 0) nowIndex = 0;

    let best = nowIndex;
    let bestDistance = Infinity;
    for (let i = Math.max(0, nowIndex - 1); i < times.length; i += 1) {
      const candidate = minutesOfDay(String(times[i]).slice(11, 16));
      if (candidate === null) continue;
      const distance = clockDistance(candidate, target);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
      if (distance === 0) break;
    }
    return best;
  }

  function valueAt(series, index) {
    if (!series || index < 0 || index >= series.length) return null;
    return numberOrNull(series[index]);
  }

  function readingFromCurrent(current) {
    if (!current) return null;
    const code = Number(current.weather_code);
    const info = describe(code);
    return {
      time: current.time || '',
      code: code,
      label: info.label,
      glyph: info.glyph,
      severity: info.severity,
      temperature: numberOrNull(current.temperature_2m),
      feelsLike: numberOrNull(current.apparent_temperature),
      humidity: numberOrNull(current.relative_humidity_2m),
      precipitation: numberOrNull(current.precipitation),
      precipitationProbability: null,
      windSpeed: numberOrNull(current.wind_speed_10m),
      windDirection: numberOrNull(current.wind_direction_10m),
      windGust: numberOrNull(current.wind_gusts_10m),
      cloudCover: numberOrNull(current.cloud_cover),
      visibility: null,
      isDay: current.is_day === undefined ? null : Number(current.is_day) === 1,
      source: 'current'
    };
  }

  function readingFromHourly(hourly, index, targetTime) {
    if (!hourly || index < 0) return null;
    const code = valueAt(hourly.weather_code, index);
    const info = describe(code);
    return {
      time: String(hourly.time[index] || '').slice(11, 16) || (targetTime || ''),
      fullTime: hourly.time[index],
      code: code,
      label: info.label,
      glyph: info.glyph,
      severity: info.severity,
      temperature: valueAt(hourly.temperature_2m, index),
      feelsLike: null,
      humidity: valueAt(hourly.relative_humidity_2m, index),
      precipitation: valueAt(hourly.precipitation, index),
      precipitationProbability: valueAt(hourly.precipitation_probability, index),
      windSpeed: valueAt(hourly.wind_speed_10m, index),
      windDirection: valueAt(hourly.wind_direction_10m, index),
      windGust: valueAt(hourly.wind_gusts_10m, index),
      cloudCover: valueAt(hourly.cloud_cover, index),
      visibility: valueAt(hourly.visibility, index),
      isDay: null,
      source: 'hourly'
    };
  }

  /* Weather -> extra minutes on top of the route estimate.
     Components are additive but each category is capped by the strongest
     reason inside it, so heavy rain plus gusts does not double count. */
  function impact(reading, options) {
    const limits = Object.assign({}, DEFAULT_OPTIONS, options || {});
    const max = Number.isFinite(Number(limits.maxExtraMinutes)) ? Number(limits.maxExtraMinutes) : 30;
    const result = { extraMinutes: 0, severity: 0, level: 'none', reasons: [] };
    if (!reading) return result;

    const info = describe(reading.code);
    const code = Number(reading.code);
    let minutes = Number(info.minutes) || 0;
    const reasons = [];
    if (minutes > 0) reasons.push(info.label);

    /* Wind: strongest of sustained speed / gust. */
    const windSpeed = numberOrNull(reading.windSpeed);
    const windGust = numberOrNull(reading.windGust);
    let windMinutes = 0;
    let windReason = '';
    if (windGust !== null && windGust >= 55) { windMinutes = 7; windReason = '阵风 ' + Math.round(windGust) + ' km/h'; }
    else if (windSpeed !== null && windSpeed >= 30) { windMinutes = 5; windReason = '风速 ' + Math.round(windSpeed) + ' km/h'; }
    else if (windGust !== null && windGust >= 40) { windMinutes = 5; windReason = '阵风 ' + Math.round(windGust) + ' km/h'; }
    else if (windSpeed !== null && windSpeed >= 20) { windMinutes = 2; windReason = '风速 ' + Math.round(windSpeed) + ' km/h'; }
    else if (windGust !== null && windGust >= 28) { windMinutes = 2; windReason = '阵风 ' + Math.round(windGust) + ' km/h'; }

    /* Visibility: only meaningful when we actually got the series. */
    const visibility = numberOrNull(reading.visibility);
    let visibilityMinutes = 0;
    let visibilityReason = '';
    if (visibility !== null && visibility < 800) { visibilityMinutes = 8; visibilityReason = '能见度 ' + (visibility / 1000).toFixed(1) + ' km'; }
    else if (visibility !== null && visibility < 2000) { visibilityMinutes = 6; visibilityReason = '能见度 ' + (visibility / 1000).toFixed(1) + ' km'; }
    else if (visibility !== null && visibility < 4000) { visibilityMinutes = 4; visibilityReason = '能见度 ' + (visibility / 1000).toFixed(1) + ' km'; }
    else if (visibility !== null && visibility < 6000) { visibilityMinutes = 2; visibilityReason = '能见度 ' + (visibility / 1000).toFixed(1) + ' km'; }

    /* Probability of precipitation: a soft nudge when the code is dry but the
       forecast hour is clearly wet. */
    const probability = numberOrNull(reading.precipitationProbability);
    let probabilityMinutes = 0;
    let probabilityReason = '';
    if (probability !== null && probability >= 80 && minutes < 5) { probabilityMinutes = 3; probabilityReason = '降水概率 ' + Math.round(probability) + '%'; }
    else if (probability !== null && probability >= 60 && minutes === 0) { probabilityMinutes = 2; probabilityReason = '降水概率 ' + Math.round(probability) + '%'; }

    minutes += windMinutes + visibilityMinutes + probabilityMinutes;
    minutes = clamp(Math.round(minutes), 0, max);

    if (windMinutes > 0) reasons.push(windReason);
    if (visibilityMinutes > 0) reasons.push(visibilityReason);
    if (probabilityMinutes > 0) reasons.push(probabilityReason);
    if (!minutes) reasons.length = 0;

    result.extraMinutes = minutes;
    result.severity = clamp(Number(info.severity) || 0, 0, 1);
    result.reasons = reasons;
    result.level = minutes >= 15 ? 'severe' : minutes >= 8 ? 'warn' : minutes >= 3 ? 'watch' : minutes > 0 ? 'slight' : 'none';
    result.headline = minutes > 0 ? '天气加时 +' + minutes + ' 分钟' : (code === 0 || code === 1 ? '天气良好' : '暂无加时');
    return result;
  }

  /* Normalise a raw Open-Meteo payload into the shape the UI consumes. */
  function parse(payload, options) {
    if (!payload || !payload.current) throw new Error('天气数据格式无法识别');
    const settings = Object.assign({}, DEFAULT_OPTIONS, options || {});
    const current = readingFromCurrent(payload.current);
    const hourly = payload.hourly || {};
    const index = departureHourIndex(hourly, payload.current.time, settings.targetTime);
    const departure = readingFromHourly(hourly, index, settings.targetTime);

    /* The departure hour is the one that actually drives the risk model.
       Fall back to the current reading when the hourly series is missing. */
    const driver = departure || current;
    const hourImpact = impact(driver, settings);

    return {
      ok: true,
      stale: false,
      provider: settings.label,
      providerUrl: 'https://open-meteo.com/',
      fetchedAt: Date.now(),
      place: settings.place || '',
      current: current,
      departure: departure,
      hourImpact: hourImpact,
      impact: hourImpact,
      targetTime: settings.targetTime || '',
      elevation: numberOrNull(payload.elevation),
      timezone: payload.timezone || settings.timezone
    };
  }

  function unavailable(reason, options) {
    const settings = Object.assign({}, DEFAULT_OPTIONS, options || {});
    return {
      ok: false,
      stale: false,
      provider: settings.label,
      providerUrl: 'https://open-meteo.com/',
      fetchedAt: Date.now(),
      place: settings.place || '',
      current: null,
      departure: null,
      hourImpact: impact(null),
      impact: impact(null),
      targetTime: settings.targetTime || '',
      error: reason ? String(reason.message || reason) : '天气暂不可用'
    };
  }

  function buildUrl(settings, latitude, longitude) {
    const params = [
      'latitude=' + encodeURIComponent(latitude),
      'longitude=' + encodeURIComponent(longitude),
      'current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day',
      'hourly=temperature_2m,relative_humidity_2m,precipitation,precipitation_probability,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility',
      'timezone=' + encodeURIComponent(settings.timezone),
      'forecast_days=' + encodeURIComponent(settings.forecastDays),
      'wind_speed_unit=kmh',
      'precipitation_unit=mm'
    ];
    return settings.endpoint + '?' + params.join('&');
  }

  class Client {
    constructor(options) {
      this.options = Object.assign({}, DEFAULT_OPTIONS, options || {});
      this.memory = {};
      this.inFlight = {};
    }

    cacheKey(latitude, longitude, targetTime) {
      const lat = Number(latitude).toFixed(3);
      const lon = Number(longitude).toFixed(3);
      return 'risktide:weather:v1:' + lat + ',' + lon + ':' + (targetTime || 'now');
    }

    readCache(key) {
      const ttl = Number(this.options.cacheMinutes) * 60000;
      if (this.memory[key] && Date.now() - this.memory[key].fetchedAt < ttl) {
        return this.memory[key];
      }
      try {
        const raw = global.localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.fetchedAt) return null;
        if (Date.now() - parsed.fetchedAt >= ttl) return null;
        this.memory[key] = parsed;
        return parsed;
      } catch (error) {
        return null;
      }
    }

    /* Last-known reading, deliberately ignoring the fresh-cache TTL.
       Only used when a fresh request fails, so the panel can keep showing the
       previous hour instead of going blank. */
    readStale(key) {
      const hours = Number(this.options.staleHours) > 0 ? Number(this.options.staleHours) : 6;
      const maxAge = hours * 3600000;
      let candidate = this.memory[key] || null;
      if (!candidate) {
        try {
          const raw = global.localStorage.getItem(key);
          if (raw) candidate = JSON.parse(raw);
        } catch (error) {
          candidate = null;
        }
      }
      if (!candidate || !candidate.fetchedAt) return null;
      if (Date.now() - candidate.fetchedAt > maxAge) return null;
      this.memory[key] = candidate;
      return candidate;
    }

    writeCache(key, value) {
      this.memory[key] = value;
      try {
        global.localStorage.setItem(key, JSON.stringify(value));
      } catch (error) {
        /* private mode / quota - memory cache still works for this session */
      }
    }

    get(params) {
      const options = Object.assign({}, this.options, params || {});
      const latitude = Number(options.latitude);
      const longitude = Number(options.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return Promise.resolve(unavailable('缺少经纬度', options));
      }

      const key = this.cacheKey(latitude, longitude, options.targetTime);
      const cached = this.readCache(key);
      if (cached) return Promise.resolve(cached);
      if (this.inFlight[key]) return this.inFlight[key];

      const url = buildUrl(options, latitude, longitude);
      const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 9000;
      const self = this;

      const request = new Promise(function (resolve, reject) {
        if (typeof global.fetch !== 'function') {
          reject(new Error('浏览器不支持 fetch'));
          return;
        }
        let timer = 0;
        let controller = null;
        if (typeof global.AbortController === 'function') {
          controller = new global.AbortController();
          timer = global.setTimeout(function () { controller.abort(); }, timeoutMs);
        }
        global.fetch(url, controller ? { signal: controller.signal } : undefined)
          .then(function (response) {
            if (!response.ok) throw new Error('天气接口返回 ' + response.status);
            return response.json();
          })
          .then(function (payload) {
            if (timer) global.clearTimeout(timer);
            const info = parse(payload, options);
            self.writeCache(key, info);
            resolve(info);
          })
          .catch(function (error) {
            if (timer) global.clearTimeout(timer);
            reject(error);
          });
      }).then(function (info) {
        delete self.inFlight[key];
        return info;
      }).catch(function (error) {
        delete self.inFlight[key];
        const fallback = self.readStale(key);
        if (fallback) return Object.assign({}, fallback, { stale: true, error: String(error.message || error) });
        throw error;
      });

      this.inFlight[key] = request;
      return request;
    }
  }

  global.RiskTideWeather = {
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    CODES: CODES,
    glyphMarkup: glyphMarkup,
    describe: describe,
    impact: impact,
    parse: parse,
    unavailable: unavailable,
    buildUrl: buildUrl,
    Client: Client
  };
})(window);