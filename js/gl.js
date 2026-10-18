/* =========================================================================
   AYLA UNIVERSE — gl.js
   A deliberately small WebGL2 layer: vector/matrix maths, shader programs,
   geometry builders and a cube-map render target. No third-party code.
   Matrices are column-major Float32Arrays, vectors are plain [x, y, z].
   ========================================================================= */
(function (global) {
  'use strict';

  /* ---------- vectors ---------- */
  const V3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
    dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  };

  /* ---------- matrices ---------- */
  const M4 = {
    identity() { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
    multiply(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
          o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
      }
      return o;
    },
    perspective(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2);
      const o = new Float32Array(16);
      o[0] = f / aspect; o[5] = f;
      o[10] = (far + near) / (near - far); o[11] = -1;
      o[14] = (2 * far * near) / (near - far);
      return o;
    },
    lookAt(eye, center, up) {
      const z = V3.norm(V3.sub(eye, center));
      const x = V3.norm(V3.cross(up, z));
      const y = V3.cross(z, x);
      return new Float32Array([
        x[0], y[0], z[0], 0,
        x[1], y[1], z[1], 0,
        x[2], y[2], z[2], 0,
        -V3.dot(x, eye), -V3.dot(y, eye), -V3.dot(z, eye), 1
      ]);
    },
    /* T * Rz(tilt) * Ry(spin) * S */
    model(pos, scale, spin, tilt) {
      const c = Math.cos(spin), s = Math.sin(spin), ct = Math.cos(tilt), st = Math.sin(tilt);
      return new Float32Array([
        ct * c * scale, st * c * scale, -s * scale, 0,
        -st * scale, ct * scale, 0, 0,
        ct * s * scale, st * s * scale, c * scale, 0,
        pos[0], pos[1], pos[2], 1
      ]);
    },
    /* project a world point; returns [x, y, depth] in CSS pixels, depth < 0 if behind the camera */
    project(vp, p, w, h) {
      const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
      const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
      const wc = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
      if (wc <= 0.0001) return [0, 0, -1];
      return [(x / wc * 0.5 + 0.5) * w, (1 - (y / wc * 0.5 + 0.5)) * h, wc];
    }
  };

  /* column-major mat3 for GLSL from a row-major 3x3 array */
  function mat3FromRows(r) {
    return new Float32Array([r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]]);
  }
  const MAT3_IDENTITY = mat3FromRows([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  /* Hue rotation (degrees) followed by a saturation scale, luminance-preserving. Returns a GLSL mat3. */
  function hueMatrix(deg, sat, gain) {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const H = [
      0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
      0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
      0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072
    ];
    const lr = 0.213, lg = 0.715, lb = 0.072;
    const S = [
      lr + (1 - lr) * sat, lg - lg * sat, lb - lb * sat,
      lr - lr * sat, lg + (1 - lg) * sat, lb - lb * sat,
      lr - lr * sat, lg - lg * sat, lb + (1 - lb) * sat
    ];
    const o = new Array(9);
    for (let r = 0; r < 3; r++) {
      for (let cc = 0; cc < 3; cc++) {
        o[r * 3 + cc] = (H[r * 3] * S[cc] + H[r * 3 + 1] * S[3 + cc] + H[r * 3 + 2] * S[6 + cc]) * gain;
      }
    }
    return mat3FromRows(o);
  }

  /* ---------- shader programs ---------- */
  const HEADER = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp samplerCube;\n';

  function compileShader(gl, type, src, name) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || '';
      const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
      const lines = src.split('\n');
      const bad = (log.match(/ERROR: \d+:(\d+)/) || [])[1];
      const ctx = bad ? lines.slice(Math.max(0, bad - 3), bad + 2).join('\n') : '';
      gl.deleteShader(sh);
      throw new Error('Shader "' + name + '" (' + kind + ') failed to compile:\n' + log + '\n' + ctx);
    }
    return sh;
  }

  class Program {
    constructor(gl, name, vs, fs, defines) {
      this.gl = gl;
      this.name = name;
      const d = defines || '';
      const v = compileShader(gl, gl.VERTEX_SHADER, HEADER + d + vs, name);
      const f = compileShader(gl, gl.FRAGMENT_SHADER, HEADER + d + fs, name);
      const p = gl.createProgram();
      gl.attachShader(p, v);
      gl.attachShader(p, f);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error('Program "' + name + '" failed to link:\n' + gl.getProgramInfoLog(p));
      }
      gl.deleteShader(v);
      gl.deleteShader(f);
      this.p = p;
      this.l = Object.create(null);
    }
    loc(n) {
      let l = this.l[n];
      if (l === undefined) { l = this.gl.getUniformLocation(this.p, n); this.l[n] = l; }
      return l;
    }
    use() { this.gl.useProgram(this.p); return this; }
    f(n, v) { const l = this.loc(n); if (l) this.gl.uniform1f(l, v); return this; }
    i(n, v) { const l = this.loc(n); if (l) this.gl.uniform1i(l, v); return this; }
    v2(n, a, b) { const l = this.loc(n); if (l) this.gl.uniform2f(l, a, b); return this; }
    v3(n, a) { const l = this.loc(n); if (l) this.gl.uniform3f(l, a[0], a[1], a[2]); return this; }
    v4(n, a, b, c, d) { const l = this.loc(n); if (l) this.gl.uniform4f(l, a, b, c, d); return this; }
    v3v(n, arr) { const l = this.loc(n); if (l) this.gl.uniform3fv(l, arr); return this; }
    m3(n, m) { const l = this.loc(n); if (l) this.gl.uniformMatrix3fv(l, false, m); return this; }
    m4(n, m) { const l = this.loc(n); if (l) this.gl.uniformMatrix4fv(l, false, m); return this; }
    dispose() { this.gl.deleteProgram(this.p); }
  }

  /* ---------- meshes ---------- */
  class Mesh {
    /* attribs: [{ loc, data: Float32Array, size, divisor? }] */
    constructor(gl, attribs, opts) {
      opts = opts || {};
      this.gl = gl;
      this.mode = opts.mode === undefined ? gl.TRIANGLES : opts.mode;
      this.vao = gl.createVertexArray();
      this.buffers = [];
      gl.bindVertexArray(this.vao);
      attribs.forEach((a) => {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, a.data, opts.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
        gl.enableVertexAttribArray(a.loc);
        gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, 0, 0);
        if (a.divisor) gl.vertexAttribDivisor(a.loc, a.divisor);
        this.buffers.push(b);
        if (this.count === undefined && !a.divisor) this.count = a.data.length / a.size;
      });
      if (opts.indices) {
        const ib = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, opts.indices, gl.STATIC_DRAW);
        this.buffers.push(ib);
        this.indexed = true;
        this.count = opts.indices.length;
      }
      this.instances = opts.instances || 0;
      gl.bindVertexArray(null);
    }
    draw() {
      const gl = this.gl;
      gl.bindVertexArray(this.vao);
      if (this.indexed) {
        if (this.instances) gl.drawElementsInstanced(this.mode, this.count, gl.UNSIGNED_INT, 0, this.instances);
        else gl.drawElements(this.mode, this.count, gl.UNSIGNED_INT, 0);
      } else if (this.instances) {
        gl.drawArraysInstanced(this.mode, 0, this.count, this.instances);
      } else {
        gl.drawArrays(this.mode, 0, this.count);
      }
    }
    dispose() {
      const gl = this.gl;
      this.buffers.forEach((b) => gl.deleteBuffer(b));
      gl.deleteVertexArray(this.vao);
    }
  }

  /* unit sphere, positions only (the normal is the position) */
  function sphereMesh(gl, seg, rings) {
    const pos = new Float32Array((seg + 1) * (rings + 1) * 3);
    let k = 0;
    for (let j = 0; j <= rings; j++) {
      const phi = -Math.PI / 2 + (j / rings) * Math.PI;
      const cp = Math.cos(phi), sp = Math.sin(phi);
      for (let i = 0; i <= seg; i++) {
        const th = (i / seg) * Math.PI * 2;
        pos[k++] = cp * Math.cos(th);
        pos[k++] = sp;
        pos[k++] = cp * Math.sin(th);
      }
    }
    const idx = new Uint32Array(seg * rings * 6);
    k = 0;
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * (seg + 1) + i, b = a + seg + 1;
        idx[k++] = a; idx[k++] = b; idx[k++] = a + 1;
        idx[k++] = a + 1; idx[k++] = b; idx[k++] = b + 1;
      }
    }
    return new Mesh(gl, [{ loc: 0, data: pos, size: 3 }], { indices: idx });
  }

  /* flat annulus in the XZ plane between two local radii */
  function ringMesh(gl, inner, outer, seg) {
    const pos = new Float32Array((seg + 1) * 2 * 3);
    let k = 0;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      pos[k++] = c * inner; pos[k++] = 0; pos[k++] = s * inner;
      pos[k++] = c * outer; pos[k++] = 0; pos[k++] = s * outer;
    }
    return new Mesh(gl, [{ loc: 0, data: pos, size: 3 }], { mode: gl.TRIANGLE_STRIP });
  }

  function quadMesh(gl) {
    return new Mesh(gl, [{ loc: 0, data: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), size: 2 }], { mode: gl.TRIANGLE_STRIP });
  }

  /* low-poly rock: an icosphere with one subdivision */
  function rockBase() {
    const t = (1 + Math.sqrt(5)) / 2;
    let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(V3.norm);
    let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const cache = {};
    const mid = (a, b) => {
      const key = a < b ? a + '_' + b : b + '_' + a;
      if (cache[key] !== undefined) return cache[key];
      verts.push(V3.norm(V3.scale(V3.add(verts[a], verts[b]), 0.5)));
      return (cache[key] = verts.length - 1);
    };
    const nf = [];
    faces.forEach((f) => {
      const a = mid(f[0], f[1]), b = mid(f[1], f[2]), c = mid(f[2], f[0]);
      nf.push([f[0], a, c], [f[1], b, a], [f[2], c, b], [a, b, c]);
    });
    const pos = new Float32Array(verts.length * 3);
    verts.forEach((v, i) => { pos[i * 3] = v[0]; pos[i * 3 + 1] = v[1]; pos[i * 3 + 2] = v[2]; });
    const idx = new Uint32Array(nf.length * 3);
    nf.forEach((f, i) => { idx[i * 3] = f[0]; idx[i * 3 + 1] = f[1]; idx[i * 3 + 2] = f[2]; });
    return { pos, idx };
  }

  /* ---------- cube-map render target ---------- */
  function createCube(gl, size) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
    for (let f = 0; f < 6; f++) {
      gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    return { tex, fbo, size };
  }

  function getContext(canvas) {
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    } catch (e) { gl = null; }
    return gl;
  }

  function webgl2Supported() {
    try {
      const c = document.createElement('canvas');
      return !!c.getContext('webgl2');
    } catch (e) { return false; }
  }

  global.AYLA_GL = { V3, M4, Program, Mesh, sphereMesh, ringMesh, quadMesh, rockBase, createCube, getContext, webgl2Supported, hueMatrix, mat3FromRows, MAT3_IDENTITY };
})(window);
