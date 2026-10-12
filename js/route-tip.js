/* global window, document */
/* 墨线浮层：桌面端悬停、移动端点击 / 触摸、键盘均可读到同一条路线的读数。
   只负责定位与显隐，不参与风险计算，也不改变墨线本身的绘制。 */
(function (global) {
  'use strict';

  const GAP = 14;      /* 指针与浮层的间距 */
  const MARGIN = 10;   /* 与地图边缘的最小留白 */

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

  class RouteTip {
    constructor(root, element) {
      this.root = root || null;
      this.element = element || null;
      this.title = element ? element.querySelector('.route-tip-title') : null;
      this.rows = element ? element.querySelector('.route-tip-rows') : null;
      this.note = element ? element.querySelector('.route-tip-note') : null;
      this.anchor = null;
      this.visible = false;
      this.signature = '';
    }

    isAvailable() {
      return !!(this.root && this.element && this.title && this.rows);
    }

    isVisible() {
      return this.visible;
    }

    /* rows: [{ label, value, tone }]，值全部为纯文本（不使用 innerHTML）。 */
    show(anchor, content) {
      if (!this.isAvailable()) return;
      const signature = content.signature || '';
      if (this.visible && signature && signature === this.signature) {
        this.move(anchor);
        return;
      }
      this.signature = signature;
      this.title.textContent = content.title || '';
      this.rows.textContent = '';
      (content.rows || []).forEach((row) => {
        const dt = document.createElement('dt');
        dt.textContent = row.label;
        const dd = document.createElement('dd');
        dd.textContent = row.value;
        if (row.tone) dd.dataset.tone = row.tone;
        this.rows.appendChild(dt);
        this.rows.appendChild(dd);
      });
      if (this.note) {
        this.note.textContent = content.note || '';
        this.note.hidden = !content.note;
      }
      this.anchor = anchor;
      this.element.classList.add('is-visible');
      this.element.setAttribute('aria-hidden', 'false');
      this.visible = true;
      this.place();
    }

    move(anchor) {
      if (!this.visible) return;
      this.anchor = anchor;
      this.place();
    }

    hide() {
      if (!this.isAvailable() || !this.visible) return;
      this.visible = false;
      this.signature = '';
      this.anchor = null;
      this.element.classList.remove('is-visible');
      this.element.setAttribute('aria-hidden', 'true');
    }

    /* 浮层贴着落点但**不压在墨线上**：优先放在落点右侧，放不下再换左侧、上方、下方，
       最后统一夹在地图边距内，任何屏幕尺寸都不会溢出。 */
    place() {
      if (!this.isAvailable() || !this.visible || !this.anchor) return;
      const rootRect = this.root.getBoundingClientRect();
      const width = this.element.offsetWidth || 180;
      const height = this.element.offsetHeight || 90;
      const ax = this.anchor.x;
      const ay = this.anchor.y;
      const maxLeft = Math.max(MARGIN, rootRect.width - width - MARGIN);
      const maxTop = Math.max(MARGIN, rootRect.height - height - MARGIN);
      const candidates = [
        { left: ax + GAP, top: ay - height / 2 },              /* 右侧 */
        { left: ax - width - GAP, top: ay - height / 2 },      /* 左侧 */
        { left: ax - width / 2, top: ay - height - 10 },       /* 上方 */
        { left: ax - width / 2, top: ay + 10 }                 /* 下方 */
      ];
      let chosen = null;
      for (let i = 0; i < candidates.length; i += 1) {
        const option = candidates[i];
        if (option.left >= MARGIN && option.left <= maxLeft
            && option.top >= MARGIN && option.top <= maxTop) { chosen = option; break; }
      }
      if (!chosen) chosen = candidates[0];
      this.element.style.left = Math.round(clamp(chosen.left, MARGIN, maxLeft)) + 'px';
      this.element.style.top = Math.round(clamp(chosen.top, MARGIN, maxTop)) + 'px';
    }
  }

  global.RiskTideRouteTip = RouteTip;
})(window);