'use strict';
/* Minimal Chrome DevTools Protocol driver (no npm deps).
   Node >= 22 provides a global WebSocket, so this talks to a headless
   Edge/Chrome instance over http+ws directly. */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function httpJson(url) {
  const res = await fetch(url);
  return res.json();
}

class Browser {
  constructor(proc, port, userDataDir) {
    this.proc = proc;
    this.port = port;
    this.userDataDir = userDataDir;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.sessionId = null;
  }

  static async launch(options = {}) {
    const exe = options.executablePath || process.env.CHROME_PATH;
    if (!exe) throw new Error('no browser executable');
    const port = options.port || (9200 + Math.floor(Math.random() * 400));
    const userDataDir = options.userDataDir
      || fs.mkdtempSync(path.join(os.tmpdir(), 'risk-tide-cdp-'));
    const args = [
      '--headless=new',
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + userDataDir,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--hide-scrollbars',
      '--disable-features=Translate,BackForwardCache,AcceptCHFrame',
      '--window-size=' + (options.width || 1280) + ',' + (options.height || 900),
      '--force-device-scale-factor=' + (options.dsf || 1),
      'about:blank'
    ];
    const proc = spawn(exe, args, { stdio: 'ignore' });
    const browser = new Browser(proc, port, userDataDir);
    let version = null;
    for (let i = 0; i < 100; i += 1) {
      try {
        version = await httpJson('http://127.0.0.1:' + port + '/json/version');
        break;
      } catch (e) { await sleep(100); }
    }
    if (!version) throw new Error('browser did not expose CDP in time');
    await browser.connect(version.webSocketDebuggerUrl);
    return browser;
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (e) => reject(new Error('ws error')));
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.error.message + ' :: ' + entry.method));
          else entry.resolve(msg.result);
          return;
        }
        if (msg.method && this.handlers.has(msg.method)) {
          this.handlers.get(msg.method).forEach((fn) => {
            try { fn(msg.params, msg.sessionId); } catch (e) { /* ignore */ }
          });
        }
      });
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (sessionId || this.sessionId) payload.sessionId = sessionId || this.sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(payload));
    });
  }

  async newPage() {
    const target = await this.send('Target.createTarget', { url: 'about:blank' });
    const attached = await this.send('Target.attachToTarget', {
      targetId: target.targetId, flatten: true
    });
    this.sessionId = attached.sessionId;
    return this.sessionId;
  }
}

class Page {
  constructor(browser, sessionId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.consoleLogs = [];
    this.errors = [];
    this.dialogs = [];
  }

  async init() {
    const b = this.browser;
    await b.send('Page.enable', {}, this.sessionId);
    await b.send('Runtime.enable', {}, this.sessionId);
    await b.send('Log.enable', {}, this.sessionId);
    await b.send('Network.enable', {}, this.sessionId);
    b.on('Runtime.consoleAPICalled', (params, sid) => {
      if (sid !== this.sessionId) return;
      const text = (params.args || []).map((a) => {
        if (a.value !== undefined) return String(a.value);
        if (a.description) return a.description;
        return a.type;
      }).join(' ');
      this.consoleLogs.push({ type: params.type, text });
    });
    b.on('Runtime.exceptionThrown', (params, sid) => {
      if (sid !== this.sessionId) return;
      const d = params.exceptionDetails || {};
      this.errors.push(d.exception && d.exception.description ? d.exception.description : (d.text || 'error'));
    });
    b.on('Log.entryAdded', (params, sid) => {
      if (sid !== this.sessionId) return;
      if (params.entry && params.entry.level === 'error') this.errors.push(params.entry.text);
    });
    return this;
  }

  async setViewport(width, height, dsf, mobile, touch) {
    await this.browser.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: dsf || 1, mobile: !!mobile,
      screenWidth: width, screenHeight: height
    }, this.sessionId);
    const touchParams = { enabled: !!touch };
    if (touch) touchParams.maxTouchPoints = 5;
    await this.browser.send('Emulation.setTouchEmulationEnabled', touchParams, this.sessionId);
  }

  async setReducedMotion(reduced) {
    await this.browser.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }]
    }, this.sessionId);
  }

  async setCpuThrottle(rate) {
    await this.browser.send('Emulation.setCPUThrottlingRate', { rate }, this.sessionId);
  }

  async goto(url, waitMs) {
    const loaded = new Promise((resolve) => {
      const handler = (params, sid) => {
        if (sid !== this.sessionId) return;
        if (params.frameId) resolve();
      };
      this.browser.on('Page.loadEventFired', handler);
    });
    await this.browser.send('Page.navigate', { url }, this.sessionId);
    await Promise.race([loaded, sleep(15000)]);
    if (waitMs) await sleep(waitMs);
    return this;
  }

  async evaluate(fnString, opts) {
    const result = await this.browser.send('Runtime.evaluate', {
      expression: fnString,
      returnByValue: true,
      awaitPromise: !!(opts && opts.awaitPromise),
      userGesture: true
    }, this.sessionId);
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error('evaluate failed: ' + (d.exception ? d.exception.description : d.text));
    }
    return result.result ? result.result.value : undefined;
  }

  async mouse(type, x, y, extra) {
    await this.browser.send('Input.dispatchMouseEvent', Object.assign({
      type, x, y, button: 'none', buttons: 0, clickCount: type === 'mouseMoved' ? 0 : 1
    }, extra || {}), this.sessionId);
  }

  async touch(type, x, y) {
    await this.browser.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }]
    }, this.sessionId);
  }

  async key(type, key, code, keyCode) {
    await this.browser.send('Input.dispatchKeyEvent', {
      type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode
    }, this.sessionId);
  }

  async screenshot(file) {
    const res = await this.browser.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    if (file) fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    return res.data;
  }

  async close() {
    try { await this.browser.send('Target.closeTarget', { targetId: this.sessionId && undefined }, this.sessionId); } catch (e) { /* ignore */ }
  }
}

async function openPage(browser, opts = {}) {
  const sessionId = await browser.newPage();
  const page = new Page(browser, sessionId);
  await page.init();
  if (opts.width) await page.setViewport(opts.width, opts.height, opts.dsf, opts.mobile, opts.touch);
  return page;
}

module.exports = { Browser, Page, openPage, sleep };