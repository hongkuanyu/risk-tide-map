/* Warm-paper scenario presets + topbar departure sync.
   This add-on only writes into the existing UI inputs and dispatches their
   native events, so the original risk / map / particle pipeline stays intact. */
(function (global) {
  'use strict';

  var scenarios = {
    train:     { label: '赶高铁', trainTime: '18:00', station: 60, offset: 480, note: '按高铁 18:00 出发 · 全国视图默认 8 小时窗' },
    flight:    { label: '赶飞机', trainTime: '16:30', station: 120, offset: 100, note: '按航班 16:30 出发' },
    exam:      { label: '考试',   trainTime: '09:00', station: 30, offset: 90, note: '按考试 09:00 开始' },
    interview: { label: '面试',   trainTime: '10:00', station: 30, offset: 90, note: '按面试 10:00 开始' },
    meeting:   { label: '会议',   trainTime: '14:00', station: 15, offset: 70, note: '按会议 14:00 开始' },
    custom:    { label: '自定义', trainTime: null,   station: null, offset: null, note: '自定义时间窗' }
  };

  function cache() {
    return {
      chips: Array.prototype.slice.call(document.querySelectorAll('.scenario-chip')),
      train: document.getElementById('train-time'),
      station: document.getElementById('station-minutes'),
      slider: document.getElementById('departure-slider'),
      departure: document.getElementById('topbar-departure'),
      note: document.getElementById('topbar-scenario-note')
    };
  }

  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  function markActive(el, key) {
    el.chips.forEach(function (chip) {
      chip.setAttribute('aria-pressed', chip.dataset.scenario === key ? 'true' : 'false');
    });
  }

  function applyScenario(el, key) {
    var preset = scenarios[key];
    if (!preset || key === 'custom') {
      markActive(el, key);
      if (el.note) el.note.textContent = preset ? preset.note : '';
      return;
    }
    el.train.value = preset.trainTime;
    el.station.value = String(preset.station);
    el.slider.value = String(preset.offset);
    fire(el.train, 'input');
    fire(el.station, 'input');
    fire(el.slider, 'input');
    if (/[?&]debug=1/.test(location.search)) {
      var _ui = global.RiskTideApp && global.RiskTideApp.ui;
      console.log('[warm-ui] after fire slider=', el.slider.value, 'state=', _ui ? _ui.state.departureOffset : 'n/a');
    }
    markActive(el, key);
    if (el.note) el.note.textContent = preset.note;
  }

  function syncDeparture(el) {
    if (!el.departure) return;
    var label = document.getElementById('departure-label');
    if (label && label.textContent) el.departure.textContent = label.textContent;
  }

  function bind() {
    var el = cache();
    if (!el.chips.length) return;

    el.chips.forEach(function (chip) {
      chip.addEventListener('click', function () { applyScenario(el, chip.dataset.scenario); });
    });

    if (el.slider) {
      el.slider.addEventListener('input', function () { syncDeparture(el); });
    }
    if (el.train) {
      el.train.addEventListener('input', function () {
        var preset = scenarios.train;
        if (el.train.value === preset.trainTime) { markActive(el, 'train'); syncDeparture(el); }
      });
    }
    syncDeparture(el);

    var applied = false;
    function applyDefault() {
      if (/[?&]debug=1/.test(location.search)) {
        console.log('[warm-ui] applyDefault App=', !!global.RiskTideApp, 'slider=', el.slider && el.slider.value, 'offset=', scenarios.train.offset);
      }
      if (applied || !global.RiskTideApp || !global.RiskTideApp.ui) return;
      applied = true;
      applyScenario(el, 'train');
      syncDeparture(el);
    }
    var timer = global.setInterval(function () {
      applyDefault();
      if (applied) global.clearInterval(timer);
    }, 120);
    /* 8 秒对于首屏初始化较慢的环境（地图/路线/投影）不够，预设会整段丢失 */
    global.setTimeout(function () { global.clearInterval(timer); }, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }
})(window);
