/* global window */
(function (global) {
  'use strict';

  function fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  function hash2(x, y, time) {
    let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (time | 0) * 1442695041;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967295;
  }

  function valueNoise(x, y, time) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const sx = fade(x - x0);
    const sy = fade(y - y0);
    const n00 = hash2(x0, y0, time);
    const n10 = hash2(x1, y0, time);
    const n01 = hash2(x0, y1, time);
    const n11 = hash2(x1, y1, time);
    const nx0 = n00 + (n10 - n00) * sx;
    const nx1 = n01 + (n11 - n01) * sx;
    return nx0 + (nx1 - nx0) * sy;
  }

  /*
   * Curl-like field generated from a smooth scalar potential.
   * It returns a normalized direction into the supplied object, avoiding
   * per-particle allocations inside the animation loop.
   */
  function sample(x, y, time, scale, out) {
    const s = scale || 0.003;
    const t = Math.floor(time * 0.16);
    const px = x * s;
    const py = y * s;
    const e = 0.72;
    const nTop = valueNoise(px, py + e, t);
    const nBottom = valueNoise(px, py - e, t);
    const nRight = valueNoise(px + e, py, t);
    const nLeft = valueNoise(px - e, py, t);
    let vx = (nTop - nBottom) / (2 * e);
    let vy = -(nRight - nLeft) / (2 * e);
    const mag = Math.sqrt(vx * vx + vy * vy) || 1;
    vx /= mag;
    vy /= mag;
    out.x = vx;
    out.y = vy;
    return out;
  }

  global.RiskTideFlowField = {
    valueNoise: valueNoise,
    sample: sample
  };
})(window);
