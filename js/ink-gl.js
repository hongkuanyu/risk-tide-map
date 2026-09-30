/* global window, document */
/*
 * Risk Tide V7 - InkFluidRenderer (WebGL2, ping-pong feedback).
 *
 * Same contract as the CPU field (setRoute / setRisk / resize / start /
 * setVisible / getMetrics) so it can replace js/ink-flow.js without touching
 * any business code.
 *
 * Pipeline (all on the GPU, no per-frame CPU work):
 *   route-aligned velocity texture (uploaded on route change)
 *     -> inject pass   : pigment fed in along the route
 *     -> advect pass   : semi-Lagrangian back-trace, ping-pong
 *     -> display pass  : density -> ink colour with risk ramp
 *
 * Gated behind config.inkGL.enabled (default false) so the live CPU field
 * keeps running until this path has been verified on the target devices.
 */
(function (global) {
  'use strict';
  const config = global.RiskTideConfig;

  const VERT = `#version 300 es
  layout(location = 0) in vec2 aPos;   // fixed slot: attribute locations are per-program
  out vec2 vUv;
  void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  /* pigment: .r = warm ratio, .a = density */
  const INJECT = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 outColor;
  uniform sampler2D uPig; uniform sampler2D uVel;
  uniform float uInject; uniform float uWarmBias;
  void main(){
    vec4 p = texture(uPig, vUv);
    vec3 v = texture(uVel, vUv).rgb;
    float core = v.z;                       // 0..1 = how close to the route
    float add = core * uInject;
    float warm = clamp(add * uWarmBias, 0.0, 1.0);
    p.r = p.r * p.a + warm * add;
    p.a = p.a + add;
    if (p.a > 0.0001) p.r /= p.a;
    outColor = p;
  }`;

  const ADVECT = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 outColor;
  uniform sampler2D uPig; uniform sampler2D uVel;
  uniform vec2 uStep; uniform float uDecay;
  void main(){
    vec2 vel = texture(uVel, vUv).xy * 2.0 - 1.0;   // decode
    /* one step = speed*dt in UV units, so the displacement is real pixels */
    vec2 back = vUv - vel * uStep;                  // back-trace
    vec4 p = texture(uPig, back);
    p.a *= uDecay;
    outColor = p;
  }`;

  const DISPLAY = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 outColor;
  uniform sampler2D uPig; uniform vec3 uCool; uniform vec3 uWarm;
  uniform float uAlpha;
  void main(){
    vec4 p = texture(uPig, vUv);
    float d = clamp(p.a, 0.0, 1.0);
    float a = pow(d, 1.5) * uAlpha;          // contrasty: solid core, vanishing rim
    vec3 col = mix(uWarm, uCool, clamp(p.r, 0.0, 1.0));
    outColor = vec4(col, a);
  }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('shader: ' + log);
    }
    return s;
  }

  function program(gl, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    return p;
  }

  class InkGL {
    constructor(canvas, mapController) {
      const cfg = (config && config.inkGL) || {};
      this.config = cfg;
      this.canvas = canvas;
      this.map = mapController;
      this.route = null;
      this.routeDirty = true;
      this.running = false;
      this.visible = !document.hidden;
      this.lastTime = 0;
      this.risk = 0;
      this.riskTarget = 0;
      this.colour = [0, 124, 108];
      this.width = 1; this.height = 1;
      const opts = { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false };
      this.gl = canvas && canvas.getContext ? canvas.getContext('webgl2', opts) : null;
      if (!this.gl) { this.failed = true; return; }
      const gl = this.gl;
      this.progInject = program(gl, INJECT);
      this.progAdvect = program(gl, ADVECT);
      this.progDisplay = program(gl, DISPLAY);
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      this.vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(this.progInject, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.texVel = gl.createTexture();
      this.resize();
      this.observeResize();
    }

    observeResize() {
      if (!global.ResizeObserver || !this.canvas || this.resizeObserver) return;
      const self = this;
      this.resizeObserver = new global.ResizeObserver(function () { self.resize(); });
      this.resizeObserver.observe(this.canvas.parentNode || this.canvas);
    }

    makeTarget(w, h) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex: tex, fbo: fbo, w: w, h: h };
    }

    resize() {
      if (this.failed || !this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, rect.width || 600);
      const h = Math.max(1, rect.height || 400);
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      this.width = w; this.height = h;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      if (this.simW === undefined) {
        const target = this.config.sim || 256;      // simulation resolution
        this.simW = Math.max(32, Math.min(target, Math.round(target)));
        this.simH = Math.max(32, Math.round(this.simW * (h / w)));
      }
      const gl = this.gl;
      if (!this.ping) {
        this.ping = this.makeTarget(this.simW, this.simH);
        this.pong = this.makeTarget(this.simW, this.simH);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.ping.fbo);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.pong.fbo);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      this.routeDirty = true;
    }

    setRoute(route) { this.route = route || null; this.routeDirty = true; return this; }
    setRisk(risk) { this.riskTarget = Math.max(0, Math.min(100, Number(risk) || 0)); return this; }

    /* Route-aligned velocity field: RG = tangent (encoded 0..1), B = core
       weight (how strongly this cell belongs to the stream). */
    uploadVelocity() {
      if (!this.map || !this.canvas) return;
      const coords = (this.route && this.route.coordinates && this.route.coordinates.length >= 2)
        ? this.route.coordinates
        : null;
      const w = this.simW, h = this.simH;
      const data = new Uint8Array(w * h * 4);
      if (coords && typeof this.map.getScreenPath === 'function') {
        const pts = this.map.getScreenPath(coords, this.route && this.route.coordinateSystem);
        const clean = pts.filter(function (p) { return p && Number.isFinite(p.x) && Number.isFinite(p.y); });
        const rPx = (this.config.influence && this.config.influence.radius) || 14;
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            const sx = (x / w) * this.width;
            const sy = (y / h) * this.height;
            let best = -1, bestD = rPx;
            for (let i = 0; i < clean.length; i += 1) {
              const d = Math.hypot(clean[i].x - sx, clean[i].y - sy);
              if (d < bestD) { bestD = d; best = i; }
            }
            const o = (y * w + x) * 4;
            if (best < 0) { data[o + 2] = 0; continue; }
            const a = clean[Math.max(0, best - 1)];
            const b = clean[Math.min(clean.length - 1, best + 1)];
            let tx = b.x - a.x, ty = b.y - a.y;
            const len = Math.hypot(tx, ty) || 1;
            tx /= len; ty /= len;
            data[o] = Math.round((tx * 0.5 + 0.5) * 255);
            data[o + 1] = Math.round((ty * 0.5 + 0.5) * 255);
            data[o + 2] = Math.round(255 * Math.max(0, 1 - bestD / rPx));
          }
        }
      }
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.texVel);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      this.routeDirty = false;
    }

    pass(prog, target, setup) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, target ? target.w : this.canvas.width, target ? target.h : this.canvas.height);
      gl.useProgram(prog);
      gl.bindVertexArray(this.vao);
      setup(prog);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /* The pass callbacks run inside gl callbacks, so never rely on `this`
       there: capture the renderer instance explicitly. (The display pass was
       missing its binding entirely, which is what threw
       "Cannot read properties of undefined (reading 'ping')".) */
    step(dt) {
      const self = this;
      const gl = this.gl;
      const u = function (p, n) { return gl.getUniformLocation(p, n); };
      // inject
      this.pass(this.progInject, this.pong, function (p) {
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, self.ping.tex);
        gl.uniform1i(u(p, 'uPig'), 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, self.texVel);
        gl.uniform1i(u(p, 'uVel'), 1);
        gl.uniform1f(u(p, 'uInject'), (self.config.injection || 1.0) * dt * 3.0);
        gl.uniform1f(u(p, 'uWarmBias'), self.config.warmBias || 0.24);
      });
      const tmp = self.ping; self.ping = self.pong; self.pong = tmp;
      // advect
      this.pass(this.progAdvect, this.pong, function (p) {
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, self.ping.tex);
        gl.uniform1i(u(p, 'uPig'), 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, self.texVel);
        gl.uniform1i(u(p, 'uVel'), 1);
        const spd = (self.config.speed || 60) * dt;
        gl.uniform2f(u(p, 'uStep'), spd / self.width, spd / self.height);
        gl.uniform1f(u(p, 'uDecay'), self.config.decay || 0.99);
      });
      const tmp2 = self.ping; self.ping = self.pong; self.pong = tmp2;
    }

    render() {
      const gl = this.gl;
      const ramp = (config.silk && config.silk.riskRamp) || null;
      let cool = [0, 124, 108];
      if (ramp) {
        const t = this.riskTarget / 100;
        let a = ramp[0], b = ramp[ramp.length - 1];
        for (let i = 1; i < ramp.length; i += 1) { if (t <= ramp[i].at) { a = ramp[i - 1]; b = ramp[i]; break; } }
        const k = Math.min(1, Math.max(0, (t - a.at) / ((b.at - a.at) || 1)));
        cool = [0, 1, 2].map(function (i) { return Math.round(a.rgb[i] + (b.rgb[i] - a.rgb[i]) * k); });
      }
      const warm = [Math.round(cool[0] + (196 - cool[0]) * 0.34), Math.round(cool[1] + (150 - cool[1]) * 0.34), Math.round(cool[2] + (60 - cool[2]) * 0.34)];
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const m = this.map && this.map.getMoving && this.map.getMoving();
      const self = this;
      this.pass(this.progDisplay, null, function (p) {
        const u = function (n) { return gl.getUniformLocation(p, n); };
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, self.ping.tex);
        gl.uniform1i(u('uPig'), 0);
        gl.uniform3f(u('uCool'), cool[0] / 255, cool[1] / 255, cool[2] / 255);
        gl.uniform3f(u('uWarm'), warm[0] / 255, warm[1] / 255, warm[2] / 255);
        gl.uniform1f(u('uAlpha'), m ? 0.72 : 0.94);
      });
    }

    setVisible(v) { this.visible = !!v; this.lastTime = 0; }
    start() {
      if (this.failed || this.running) return;
      this.running = true;
      this.frameBound = this.frameBound || this.frame.bind(this);
      global.requestAnimationFrame(this.frameBound);
    }
    stop() { this.running = false; }
    getMetrics() {
      return { backend: 'webgl2', sim: this.simW + 'x' + this.simH, fps: Math.round(1000 / Math.max(1, this.frameAvg || 16.7)), frameMs: Number((this.frameAvg || 16.7).toFixed(1)) };
    }
    frame(ts) {
      if (!this.running) return;
      const dt = this.lastTime ? Math.min((ts - this.lastTime) / 1000, 0.032) : 0.016;
      this.lastTime = ts;
      this.frameAvg = this.frameAvg ? this.frameAvg + (dt * 1000 - this.frameAvg) * 0.05 : dt * 1000;
      try {
        if (this.visible) {
          if (this.routeDirty) this.uploadVelocity();
          this.step(dt);
          this.render();
        }
      } catch (e) {
        if (global.console && console.warn) console.warn('InkFLuid frame skipped: ' + (e && e.message ? e.message : e));
      }
      global.requestAnimationFrame(this.frameBound);
    }
  }

  global.RiskTideInkGL = InkGL;
})(window);