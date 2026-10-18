/* =========================================================================
   AYLA UNIVERSE — shaders
   Everything you see in the 3D views is procedural: no textures are
   downloaded. Planets are evaluated per pixel from 3D noise on the sphere,
   so there are no seams and the detail keeps sharpening as you zoom in.
   All sources are GLSL ES 3.00 (WebGL2). Attribute locations are fixed:
     sphere/ring/rock mesh : 0 position
     billboard quad        : 0 corner
     points                : 0 position, 1 colour+size, 2 phase
     orbit line            : 0 position, 1 angle
     rock instances        : 1 (radius, angle, height, scale), 2 random
   ========================================================================= */
(function (global) {
  'use strict';

  /* ---------- shared chunks ---------- */

  const NOISE = `
#ifndef LOWQ
#define LOWQ 0
#endif
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

// 3D simplex noise (Ashima Arts / Stefan Gustavson, MIT)
float snoise(vec3 v){
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float hash13(vec3 p3){
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3){
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

// fractal sum, roughly in [-1, 1]
float fbm(vec3 p, int n){
  float a = 0.5, s = 0.0, norm = 0.0;
  int cnt = max(n - LOWQ, 1);
  for (int i = 0; i < 8; i++) {
    if (i >= cnt) break;
    s += a * snoise(p);
    norm += a;
    p = p * 2.03 + vec3(11.7, 3.1, 7.3);
    a *= 0.5;
  }
  return s / norm;
}
// ridged multifractal, roughly in [0, 1]
float ridged(vec3 p, int n){
  float a = 0.5, s = 0.0, w = 1.0, norm = 0.0;
  int cnt = max(n - LOWQ, 1);
  for (int i = 0; i < 8; i++) {
    if (i >= cnt) break;
    float v = 1.0 - abs(snoise(p));
    v *= v;
    v *= w;
    w = clamp(v * 2.0, 0.0, 1.0);
    s += v * a;
    norm += a;
    p = p * 2.07 + vec3(5.2, 1.3, 8.7);
    a *= 0.5;
  }
  return s / norm;
}
mat2 rot2(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
vec3 rotY(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
`;

  const COMMON = `
uniform vec3 uCam;
uniform vec3 uSunPos;
uniform float uTime;

vec3 finish(vec3 c){
  c = 1.0 - exp(-c * 1.35);
  return pow(c, vec3(1.0 / 2.2));
}
// Screen-space bump mapping from a scalar height (Mikkelsen), no tangents needed
vec3 bumpN(vec3 N, vec3 P, float h, float s){
  vec3 dpdx = dFdx(P), dpdy = dFdy(P);
  float dhx = dFdx(h), dhy = dFdy(h);
  vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx);
  float det = dot(dpdx, r1);
  if (abs(det) < 1e-14) return N;
  float fade = smoothstep(0.10, 0.50, dot(N, normalize(uCam - P)));
  vec3 pert = s * fade * sign(det) * (dhx * r1 + dhy * r2);
  float lim = abs(det) * 0.85;
  float pl = length(pert);
  if (pl > lim) pert *= lim / pl;
  return normalize(abs(det) * N - pert);
}
// Bump by finite differences on the sphere: heights sampled one step along two tangents.
// Unlike screen-space derivatives this has no 2x2 pixel blocking, so it is used at high quality.
vec3 fdNormalObj(vec3 p, float h0, float h1, float h2, float eps, float s, vec3 t1, vec3 t2){
  vec3 grad = ((h1 - h0) / eps) * t1 + ((h2 - h0) / eps) * t2;
  float gl = length(grad);
  float lim = 2.2;                       // keep the tilt sane on very steep crater rims
  if (gl * s > lim) grad *= lim / (gl * s);
  return normalize(p - s * grad);
}
vec2 raySphere(vec3 ro, vec3 rd, vec3 c, float r){
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float cc = dot(oc, oc) - r * r;
  float h = b * b - cc;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}
`;

  /* Saturn-style ring density, u in [0,1] from inner to outer edge.
     Shared by the ring itself and by the shadow it casts on the planet. */
  const RING_PROFILE = `
float ringDensity(float u){
  float C = smoothstep(0.0, 0.03, u) * (1.0 - smoothstep(0.24, 0.28, u)) * 0.22;
  float B = smoothstep(0.24, 0.30, u) * (1.0 - smoothstep(0.64, 0.675, u)) * (0.78 + 0.2 * smoothstep(0.3, 0.5, u));
  float cassini = smoothstep(0.665, 0.69, u) * (1.0 - smoothstep(0.73, 0.75, u));
  float A = smoothstep(0.74, 0.76, u) * (1.0 - smoothstep(0.965, 0.985, u)) * 0.62;
  float encke = 1.0 - 0.9 * (1.0 - smoothstep(0.0, 0.012, abs(u - 0.915)));
  float d = (C + B + A) * encke + cassini * 0.06;
  float stri = 0.82 + 0.18 * snoise(vec3(u * 190.0, 0.5, 1.7)) + 0.10 * snoise(vec3(u * 520.0, 2.1, 0.3));
  return clamp(d * stri, 0.0, 1.0);
}
`;

  /* ---------- planet vertex shader (shared by every sphere) ---------- */
  const SPHERE_VS = `
layout(location = 0) in vec3 aPos;
uniform mat4 uVP;
uniform mat4 uModel;
uniform vec3 uSunPos;
out vec3 vObj;
out vec3 vN;
out vec3 vW;
out vec3 vLobj;
void main(){
  vec4 w = uModel * vec4(aPos, 1.0);
  vObj = aPos;
  vN = normalize(mat3(uModel) * aPos);
  vW = w.xyz;
  vec3 Lw = normalize(uSunPos - w.xyz);
  vLobj = normalize(Lw * mat3(uModel));
  gl_Position = uVP * w;
}
`;

  /* ---------- stars: the Sun, Ayla Prime, the sandbox star ---------- */
  const STAR_FS = `
in vec3 vObj; in vec3 vN; in vec3 vW; in vec3 vLobj;
out vec4 fragColor;
uniform vec3 uC0, uC1, uC2, uC3;
uniform float uPulse;      // 0..1 pulsation depth
uniform float uWarp;       // plasma domain-warp strength
uniform float uGlow;       // overall emission
uniform float uSeed;
uniform float uScale;
void main(){
  vec3 p = normalize(vObj);
  float t = uTime * 0.045;
  float pulse = 1.0 + uPulse * sin(uTime * 1.7);
  vec3 q = p + uSeed;
  if (uWarp > 0.0) {
    q += uWarp * vec3(fbm(q * 1.9 + vec3(0.0, t, 0.0), 3), fbm(q * 1.9 + vec3(7.0, 0.0, t), 3), fbm(q * 1.9 + vec3(t, 3.0, 11.0), 3));
  }
  float gran = fbm(q * 7.0 * uScale + vec3(0.0, 0.0, t), 5) * 0.5 + 0.5;
  float cells = ridged(q * 15.0 * uScale + vec3(t * 2.0, 0.0, 0.0), 3);
  float spots = smoothstep(0.50, 0.62, fbm(q * 2.2 + 21.0, 3));
  float heat = clamp(gran * 0.62 + cells * 0.5 - spots * 0.32, 0.0, 1.0);
  vec3 col = mix(uC0, uC1, smoothstep(0.0, 0.40, heat));
  col = mix(col, uC2, smoothstep(0.35, 0.72, heat));
  col = mix(col, uC3, smoothstep(0.72, 1.0, heat));
  float mu = clamp(dot(normalize(vN), normalize(uCam - vW)), 0.0, 1.0);
  float limb = 0.30 + 0.70 * pow(mu, 0.55);
  col = mix(col * vec3(1.0, 0.5, 0.3), col, smoothstep(0.0, 0.55, mu));
  col *= limb * uGlow * pulse;
  fragColor = vec4(finish(col), 1.0);
}
`;

  /* ---------- Earth-like worlds ---------- */
  const EARTH_FS = `
in vec3 vObj; in vec3 vN; in vec3 vW; in vec3 vLobj;
out vec4 fragColor;
uniform float uSeed, uSea, uCloudAmt, uCloudRot, uCity, uBump;
uniform mat3 uHue;
uniform mat4 uModel;
float earthH(vec3 p){
  vec3 q = p + vec3(uSeed, uSeed * 0.7, -uSeed * 1.3);
  float e = max(fbm(q * 1.2, 3) - uSea, 0.0);
  return e * 1.4 + ridged(q * 3.2, 2) * smoothstep(0.02, 0.35, e) * 0.18;
}
void main(){
  vec3 p = normalize(vObj);
  vec3 q = p + vec3(uSeed, uSeed * 0.7, -uSeed * 1.3);
  float c = fbm(q * 1.2, 6) + 0.16 * fbm(q * 3.7 + 2.0, 4);
  float h = c - uSea;
  float land = smoothstep(-0.012, 0.018, h);
  float lat = abs(p.y);
  float mnt = ridged(q * 3.6, 5) * smoothstep(0.02, 0.35, h);
  float elev = max(h, 0.0) * 1.5 + mnt * 0.55;
  float moist = fbm(q * 2.0 + 9.0, 4) * 0.5 + 0.5;
  float temp = 1.0 - lat * 1.25 + fbm(q * 3.0, 2) * 0.12 - elev * 0.35;

  vec3 desert = vec3(0.60, 0.47, 0.28);
  vec3 grass  = vec3(0.13, 0.23, 0.07);
  vec3 forest = vec3(0.04, 0.12, 0.05);
  vec3 tundra = vec3(0.30, 0.30, 0.23);
  vec3 rock   = vec3(0.31, 0.27, 0.23);
  vec3 snow   = vec3(0.90, 0.93, 0.98);
  vec3 landC = mix(desert, grass, smoothstep(0.30, 0.62, moist));
  landC = mix(landC, forest, smoothstep(0.58, 0.88, moist) * smoothstep(0.35, 0.70, temp));
  landC = mix(tundra, landC, smoothstep(0.12, 0.42, temp));
  landC = mix(landC, rock, smoothstep(0.32, 0.70, elev));
  float polar = smoothstep(0.72, 0.86, lat + fbm(q * 5.0, 3) * 0.07);
  float snowAmt = max(smoothstep(0.62, 0.85, elev + (1.0 - temp) * 0.30), polar);
  landC = mix(landC, snow, snowAmt);

  float depth = clamp(-h * 3.2, 0.0, 1.0);
  vec3 sea = mix(vec3(0.05, 0.27, 0.34), vec3(0.008, 0.04, 0.14), pow(depth, 0.55));
  sea = mix(sea, snow * 0.92, smoothstep(0.80, 0.92, lat + fbm(q * 6.0, 2) * 0.05));
  vec3 alb = uHue * mix(sea, landC, land);

  // clouds, with their own slow drift
  vec3 cp = rotY(p, uCloudRot);
  float cw = fbm(cp * 2.0 + vec3(0.0, 0.0, uTime * 0.004), 4);
  vec3 cq = cp * vec3(2.5, 3.3, 2.5) + cw * 0.50 + 3.0;
  float band = 0.5 + 0.5 * cos((lat - 0.42) * 6.0);
  float cl = fbm(cq, 6) * 0.5 + 0.5 + band * 0.08;
  float cloud = smoothstep(1.0 - uCloudAmt, 1.0 - uCloudAmt + 0.22, cl);
  float cl2 = fbm(cq + vLobj * 0.35, 4) * 0.5 + 0.5 + band * 0.08;
  float cshadow = smoothstep(1.0 - uCloudAmt, 1.0 - uCloudAmt + 0.20, cl2);

  vec3 N0 = normalize(vN);
  vec3 L = normalize(uSunPos - vW);
  vec3 V = normalize(uCam - vW);
#if LOWQ == 0
  vec3 tA = normalize(cross(p, abs(p.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 tB = cross(p, tA);
  float hE = earthH(p);
  vec3 nObj = fdNormalObj(p, hE, earthH(normalize(p + tA * 0.004)), earthH(normalize(p + tB * 0.004)), 0.004, uBump * 0.8, tA, tB);
  vec3 N = normalize(mat3(uModel) * nObj);
#else
  float hb = (max(fbm(q * 1.2, 3) - uSea, 0.0) * 1.4 + ridged(q * 3.2, 2) * smoothstep(0.02, 0.35, h) * 0.18) * land;
  vec3 N = bumpN(N0, vW, hb, uBump);
#endif
  float ndl0 = dot(N0, L);
  float ndl = dot(N, L);
  float lit = smoothstep(-0.04, 0.14, ndl0);
  float sun = clamp(ndl, 0.0, 1.0) * lit * (1.0 - 0.6 * cshadow * land - 0.35 * cshadow * (1.0 - land));
  vec3 col = alb * (sun * vec3(1.0, 0.97, 0.92) * 1.15 + 0.012);

  float ocean = 1.0 - land;
  vec3 H = normalize(L + V);
  float ndh = max(dot(N0, H), 0.0);
  float spec = (pow(ndh, 170.0) * 1.1 + pow(ndh, 22.0) * 0.10) * ocean * (1.0 - cloud) * lit;
  float fres = pow(1.0 - max(dot(N0, V), 0.0), 4.0);
  col += ocean * fres * vec3(0.20, 0.34, 0.62) * lit * 0.8;
  col += spec * vec3(1.0, 0.94, 0.84);

  vec3 cloudCol = vec3(0.97, 0.98, 1.0) * (max(ndl0, 0.0) * lit * 1.1 + 0.014);
  col = mix(col, cloudCol, cloud * 0.92);

  float night = 1.0 - smoothstep(-0.14, 0.05, ndl0);
  float pop = smoothstep(0.50, 0.78, fbm(q * 26.0, 3) * 0.5 + 0.5) * land
            * smoothstep(0.10, 0.50, temp) * (1.0 - smoothstep(0.25, 0.65, elev))
            * smoothstep(0.35, 0.60, moist + 0.1) * (1.0 - cloud * 0.85);
  col += vec3(1.0, 0.70, 0.36) * pop * night * uCity * 0.55;
  fragColor = vec4(finish(col), 1.0);
}
`;

  /* ---------- crater helper + rocky worlds (Mars, Moon, deserts, ice) ---------- */
  const CRATERS = `
// returns (bowl height, rim height); cells are tiled on the sphere surface
vec2 craters(vec3 p, float sc, float dens){
  p *= sc;
  vec3 ip = floor(p);
  vec3 fp = p - ip;
  float bowl = 0.0, rim = 0.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      for (int z = -1; z <= 1; z++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 id = ip + g;
        if (hash13(id) > dens) continue;
        vec3 c = g + hash33(id + 7.7) * 0.7 + 0.15;
        float r = mix(0.14, 0.46, pow(hash13(id + 3.3), 1.6));
        float d = length(fp - c) / r;
        float b = d < 1.0 ? -(1.0 - d * d) : 0.0;
        bowl += b * (0.45 + r);
        rim += exp(-pow((d - 1.02) * 5.5, 2.0)) * (0.30 + r * 0.8);
      }
    }
  }
  return vec2(bowl, rim);
}
`;

  const ROCKY_FS = `
in vec3 vObj; in vec3 vN; in vec3 vW; in vec3 vLobj;
out vec4 fragColor;
uniform vec3 uPal0, uPal1, uPal2, uPal3, uCapCol;
uniform vec4 uCrat;     // x density, y big scale, z small scale, w depth
uniform float uMaria, uCap, uBump, uSeed, uSpec, uIce;
uniform mat3 uHue;
uniform mat4 uModel;
${CRATERS}
float rockyH(vec3 p){
  vec3 q = p + vec3(uSeed, -uSeed * 0.6, uSeed * 1.7);
  float base = fbm(q * 1.5, 5);
  float mid = fbm(q * 5.0, 4);
  float mount = ridged(q * 3.0, 4);
  vec2 cA = craters(p + uSeed * 0.013, uCrat.y, uCrat.x);
  vec2 cB = craters(p + 3.7 + uSeed * 0.011, uCrat.z, min(uCrat.x * 1.3, 1.0));
  return base * 0.45 + mount * 0.32 * (1.0 - 0.7 * uIce) + mid * 0.07 + (cA.x * 0.9 + cB.x * 0.5) * uCrat.w + (cA.y + cB.y * 0.6) * uCrat.w * 0.5;
}
void main(){
  vec3 p = normalize(vObj);
  vec3 q = p + vec3(uSeed, -uSeed * 0.6, uSeed * 1.7);
  float base = fbm(q * 1.5, 5);
  float mid = fbm(q * 5.0, 4);
  float fine = fbm(q * 18.0, 3);
  float mount = ridged(q * 3.0, 4);
  vec2 cA = craters(p + uSeed * 0.013, uCrat.y, uCrat.x);
  vec2 cB = craters(p + 3.7 + uSeed * 0.011, uCrat.z, min(uCrat.x * 1.3, 1.0));
  float bowl = cA.x * 0.9 + cB.x * 0.5;
  float rim = cA.y + cB.y * 0.6;
  float height = base * 0.45 + mount * 0.32 * (1.0 - 0.7 * uIce) + mid * 0.07 + bowl * uCrat.w + rim * uCrat.w * 0.5;

  float t0 = smoothstep(-0.45, 0.5, base + mid * 0.3);
  vec3 alb = mix(uPal0, uPal1, t0);
  alb = mix(alb, uPal2, smoothstep(0.20, 0.90, mid * 0.6 + mount * 0.5 + fine * 0.08) * 0.62);
  alb *= 0.96 + 0.08 * fine;
  alb = mix(alb, uPal3, smoothstep(0.55, 0.9, fbm(q * 2.3 + 4.0, 3) * 0.5 + 0.5) * 0.35);
  float maria = smoothstep(0.10, 0.34, fbm(q * 0.9 + 13.0, 3)) * uMaria;
  alb = mix(alb, uPal0 * 0.55, maria);
  alb *= 1.0 + rim * 0.40 + cA.x * 0.10;
  if (uIce > 0.5) {
    float cr = 1.0 - smoothstep(0.0, 0.04, abs(snoise(q * 3.2 + fbm(q * 2.0, 3) * 0.8)));
    float cr2 = 1.0 - smoothstep(0.0, 0.03, abs(snoise(q * 7.0 + 5.0)));
    alb = mix(alb, uPal0 * 0.75, clamp(cr * 0.65 + cr2 * 0.30, 0.0, 0.8));
  }
  float cap = smoothstep(1.0 - uCap, 1.0 - uCap + 0.06, abs(p.y) + fbm(q * 4.0, 3) * 0.05);
  alb = mix(alb, uCapCol, cap * step(0.001, uCap));
  alb = uHue * alb;

  vec3 N0 = normalize(vN);
  vec3 L = normalize(uSunPos - vW);
  vec3 V = normalize(uCam - vW);
#if LOWQ == 0
  vec3 rA = normalize(cross(p, abs(p.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 rB = cross(p, rA);
  vec3 nObj = fdNormalObj(p, height, rockyH(normalize(p + rA * 0.004)), rockyH(normalize(p + rB * 0.004)), 0.004, uBump * 1.1, rA, rB);
  vec3 N = normalize(mat3(uModel) * nObj);
#else
  vec3 N = bumpN(N0, vW, height, uBump);
#endif
  float ndl0 = dot(N0, L);
  float ndl = dot(N, L);
  float lit = smoothstep(-0.03, 0.12, ndl0);
  float diff = clamp(ndl, 0.0, 1.0) * lit;
  float surge = pow(max(dot(V, L), 0.0), 10.0) * 0.12 * lit;
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 40.0) * uSpec * lit;
  vec3 col = alb * (diff * 1.15 + surge + 0.012) + spec * vec3(0.9, 0.95, 1.0);
  fragColor = vec4(finish(col), 1.0);
}
`;

  /* ---------- gas and ice giants ---------- */
  const GAS_FS = `
in vec3 vObj; in vec3 vN; in vec3 vW; in vec3 vLobj;
out vec4 fragColor;
uniform vec3 uBand[5];
uniform float uBandFreq, uTurb, uSeed, uContrast;
uniform vec4 uSpot;           // lat, lon, size, enabled
uniform mat3 uHue;
uniform vec3 uRingN, uCenter;
uniform vec2 uRingR;          // inner, outer in world units
uniform float uHasRing;
${RING_PROFILE}
float ringShadowAt(vec3 P, vec3 L){
  float denom = dot(L, uRingN);
  if (abs(denom) < 1e-4) return 1.0;
  float t = dot(uCenter - P, uRingN) / denom;
  if (t < 0.0) return 1.0;
  vec3 hit = P + L * t;
  float r = length(hit - uCenter);
  if (r < uRingR.x || r > uRingR.y) return 1.0;
  float u = (r - uRingR.x) / (uRingR.y - uRingR.x);
  return 1.0 - ringDensity(u) * 0.88;
}
vec3 ramp5(float v){
  v = clamp(v, 0.0, 1.0) * 4.0;
  vec3 c = mix(uBand[0], uBand[1], smoothstep(0.0, 1.0, v));
  c = mix(c, uBand[2], smoothstep(1.0, 2.0, v));
  c = mix(c, uBand[3], smoothstep(2.0, 3.0, v));
  c = mix(c, uBand[4], smoothstep(3.0, 4.0, v));
  return c;
}
void main(){
  vec3 p = normalize(vObj);
  float lat = p.y;
  float lon = atan(p.z, p.x);
  vec3 sd = vec3(uSeed, uSeed * 0.5, -uSeed);

  // storm: swirl the band coordinates around its centre
  float spotMask = 0.0, spotRing = 0.0, swirl = 0.0;
  if (uSpot.w > 0.5) {
    float dl = lon - uSpot.y;
    dl = atan(sin(dl), cos(dl));
    vec2 sp = vec2(dl * sqrt(max(1.0 - lat * lat, 0.05)) / (uSpot.z * 1.7), (lat - uSpot.x) / uSpot.z);
    float e = length(sp);
    spotMask = 1.0 - smoothstep(0.55, 1.0, e);
    spotRing = (1.0 - smoothstep(1.0, 1.35, e)) - (1.0 - smoothstep(0.7, 1.0, e));
    swirl = (1.0 - smoothstep(0.0, 1.5, e)) * 2.2;
  }
  vec3 pp = p;
  pp.xz = rot2(swirl * 0.35) * pp.xz;

  float t1 = fbm(vec3(pp.x * 2.0, pp.y * 6.5, pp.z * 2.0) + vec3(0.0, 0.0, uTime * 0.004) + sd, 5);
  float t2 = fbm(vec3(pp.x * 6.0, pp.y * 17.0, pp.z * 6.0) + sd * 2.0, 4);
  float bands = lat * uBandFreq + t1 * uTurb + t2 * uTurb * 0.35 + swirl * 0.5;
  float v = 0.5 + 0.5 * sin(bands) * 0.7 + 0.5 * 0.3 * sin(bands * 2.3 + 1.1 + t2);
  v = clamp((v - 0.5) * uContrast + 0.5, 0.0, 1.0);
  vec3 alb = ramp5(v);
  alb *= 0.94 + 0.12 * fbm(vec3(p.x * 20.0, p.y * 40.0, p.z * 20.0) + sd, 3);
  if (uSpot.w > 0.5) {
    vec3 spotCol = vec3(0.62, 0.27, 0.17);
    alb = mix(alb, spotCol, spotMask * 0.85);
    alb += vec3(0.12, 0.09, 0.07) * spotRing * 0.5;
  }
  alb = uHue * alb;

  vec3 N = normalize(vN);
  vec3 L = normalize(uSunPos - vW);
  vec3 V = normalize(uCam - vW);
  float ndl = dot(N, L);
  float lit = smoothstep(-0.18, 0.30, ndl);
  float diff = clamp(ndl * 0.85 + 0.15, 0.0, 1.0) * lit;
  float sh = uHasRing > 0.5 ? ringShadowAt(vW, L) : 1.0;
  float mu = max(dot(N, V), 0.0);
  float limb = 0.45 + 0.55 * pow(mu, 0.4);
  vec3 col = alb * (diff * 1.2 * sh * limb + 0.010);
  col += vec3(0.16, 0.20, 0.30) * pow(1.0 - mu, 3.0) * lit * 0.35;
  fragColor = vec4(finish(col), 1.0);
}
`;

  /* ---------- rings ---------- */
  const RING_VS = `
layout(location = 0) in vec3 aPos;
uniform mat4 uVP;
uniform mat4 uModel;
out vec3 vLocal;
out vec3 vW;
void main(){
  vLocal = aPos;
  vec4 w = uModel * vec4(aPos, 1.0);
  vW = w.xyz;
  gl_Position = uVP * w;
}
`;
  const RING_FS = `
in vec3 vLocal; in vec3 vW;
out vec4 fragColor;
uniform vec3 uRingN, uCenter;
uniform vec2 uLocalR;     // inner/outer radius in local units
uniform float uPlanetR;   // planet radius in world units
uniform mat3 uHue;
${RING_PROFILE}
void main(){
  float r = length(vLocal.xz);
  float u = (r - uLocalR.x) / (uLocalR.y - uLocalR.x);
  if (u < 0.0 || u > 1.0) discard;
  float dens = ringDensity(u);
  vec3 L = normalize(uSunPos - vW);
  vec3 V = normalize(uCam - vW);
  float side = dot(L, uRingN);
  float viewSide = dot(V, uRingN);
  float facing = abs(side);
  vec3 beige = vec3(0.80, 0.72, 0.58);
  vec3 grey  = vec3(0.48, 0.43, 0.38);
  vec3 alb = mix(grey, beige, smoothstep(0.1, 0.5, dens + 0.2 * snoise(vec3(u * 30.0, 4.0, 0.0))));
  alb = uHue * alb;

  // shadow of the planet on the rings
  vec3 toC = uCenter - vW;
  float b = dot(toC, L);
  float shadow = 1.0;
  if (b > 0.0) {
    float d = length(toC - L * b);
    shadow = smoothstep(uPlanetR * 0.985, uPlanetR * 1.02, d);
  }
  float lightAmt = (0.12 + 0.88 * pow(facing, 0.55)) * shadow;
  // seen from the unlit side the rings only glow where they are thick
  float throughLight = (side * viewSide < 0.0) ? 0.40 : 1.0;
  vec3 col = alb * lightAmt * throughLight * 1.25 + 0.006;
  float alpha = clamp(dens * 1.15, 0.0, 1.0);
  fragColor = vec4(finish(col), alpha);
}
`;

  /* ---------- atmosphere: single-scattering ray march through a thin shell ---------- */
  const ATMO_FS = `
in vec3 vObj; in vec3 vN; in vec3 vW; in vec3 vLobj;
out vec4 fragColor;
uniform vec3 uCenter, uBeta;
uniform float uRp, uRa, uH, uInt;
void main(){
  vec3 rd = normalize(vW - uCam);
  vec2 ta = raySphere(uCam, rd, uCenter, uRa);
  if (ta.y < 0.0) discard;
  float t0 = max(ta.x, 0.0);
  float t1 = ta.y;
  vec2 tp = raySphere(uCam, rd, uCenter, uRp);
  if (tp.x > 0.0) t1 = min(t1, tp.x);
  if (t1 <= t0) discard;
  const int STEPS = 10;
  float dt = (t1 - t0) / float(STEPS);
  vec3 sum = vec3(0.0);
  float od = 0.0;
  for (int i = 0; i < STEPS; i++) {
    vec3 pos = uCam + rd * (t0 + (float(i) + 0.5) * dt);
    vec3 up = normalize(pos - uCenter);
    float alt = max(length(pos - uCenter) - uRp, 0.0);
    float dens = exp(-alt / uH);
    od += dens * dt / uH;
    vec3 L = normalize(uSunPos - pos);
    float mu = dot(up, L);
    float path = 1.0 / max(mu * 0.9 + 0.30, 0.08);
    vec3 Tl = exp(-uBeta * dens * path * 1.6) * smoothstep(-0.32, 0.12, mu);
    vec3 Tv = exp(-uBeta * od * 0.9);
    float cosA = dot(rd, L);
    float phase = 0.75 * (1.0 + cosA * cosA) * 0.5 + 0.35;
    sum += uBeta * dens * dt / uH * Tl * Tv * phase;
  }
  vec3 col = sum * uInt;
  fragColor = vec4(col, 1.0);
}
`;

  /* ---------- billboards: coronas and glows ---------- */
  const BB_VS = `
layout(location = 0) in vec2 aQ;
uniform mat4 uVP;
uniform vec3 uCenter, uRight, uUp;
uniform float uSize;
out vec2 vUV;
void main(){
  vUV = aQ;
  vec3 w = uCenter + (uRight * aQ.x + uUp * aQ.y) * uSize;
  gl_Position = uVP * vec4(w, 1.0);
}
`;
  const CORONA_FS = `
in vec2 vUV;
out vec4 fragColor;
uniform vec3 uColor;
uniform float uTime, uStarR, uPulse, uAmt;
${NOISE}
void main(){
  float r = length(vUV);
  float a = atan(vUV.y, vUV.x);
  float rr = max(r - uStarR, 0.0) / (1.0 - uStarR);
  float pulse = 1.0 + uPulse * sin(uTime * 1.7);
  float core = exp(-rr * 9.0) * 0.95 + exp(-rr * 2.6) * 0.30 + 0.035 / (r * r + 0.03);
  float st = snoise(vec3(cos(a) * 1.8, sin(a) * 1.8, uTime * 0.05 + r * 1.4)) * 0.5 + 0.5;
  float streamers = pow(st, 2.4) * exp(-rr * 3.4) * 0.55;
  float rays = pow(max(snoise(vec3(a * 2.6, 0.4, uTime * 0.02)) * 0.5 + 0.5, 0.0), 5.0) * exp(-rr * 4.5) * 0.7;
  float k = (core + streamers + rays) * pulse * uAmt * (1.0 - smoothstep(0.72, 1.0, r));
  k *= smoothstep(uStarR * 0.9, uStarR * 1.02, r);
  vec3 col = uColor * k;
  fragColor = vec4(col, 1.0);
}
`;
  const GLOW_FS = `
in vec2 vUV;
out vec4 fragColor;
uniform vec3 uColor;
uniform float uAmt;
void main(){
  float r = length(vUV);
  float k = (exp(-r * 5.5) * 0.7 + exp(-r * 14.0) * 0.8 + 0.02 / (r * r + 0.05)) * (1.0 - smoothstep(0.6, 1.0, r));
  fragColor = vec4(uColor * k * uAmt, 1.0);
}
`;

  /* ---------- point stars ---------- */
  const STARS_VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aCol;
layout(location = 2) in float aPh;
uniform mat4 uVP;
uniform vec3 uCam;
uniform float uLock, uPx, uTime, uTw, uSkyRot, uNear;
out vec3 vCol;
out float vSize;
void main(){
  vec3 wp = aPos;
  if (uLock > 0.5) {
    float c = cos(uSkyRot), s = sin(uSkyRot);
    wp = vec3(c * wp.x + s * wp.z, wp.y, -s * wp.x + c * wp.z) + uCam;
  }
  gl_Position = uVP * vec4(wp, 1.0);
  float tw = 1.0 + uTw * 0.35 * sin(uTime * (1.2 + aPh * 3.0) + aPh * 60.0);
  float size = aCol.a;
  if (uLock < 0.5) {
    float d = length(wp - uCam);
    size *= clamp(uNear / d, 0.35, 2.4);
  }
  vCol = aCol.rgb * tw;
  vSize = size;
  gl_PointSize = max(size * uPx, 1.0);
}
`;
  const STARS_FS = `
in vec3 vCol;
in float vSize;
out vec4 fragColor;
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(c, c);
  if (d2 > 1.0) discard;
  float core = exp(-d2 * 6.0);
  float halo = exp(-d2 * 1.6) * 0.18 * smoothstep(2.5, 6.0, vSize);
  float spike = 0.0;
  if (vSize > 5.0) {
    spike = (exp(-abs(c.x) * 26.0) * exp(-abs(c.y) * 2.2) + exp(-abs(c.y) * 26.0) * exp(-abs(c.x) * 2.2)) * 0.55 * smoothstep(5.0, 9.0, vSize);
  }
  float k = core + halo + spike;
  fragColor = vec4(vCol * k, 1.0);
}
`;

  /* ---------- orbit lines: bright just behind the body, a hairline elsewhere ---------- */
  const ORBIT_VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in float aAng;
uniform mat4 uVP;
uniform vec3 uOff;
uniform float uBodyAng, uBase, uTrail, uBoost;
out float vA;
void main(){
  float d = mod(uBodyAng - aAng, 6.2831853) / 6.2831853;
  vA = (uBase + uTrail * exp(-d * 3.2)) * uBoost;
  gl_Position = uVP * vec4(aPos + uOff, 1.0);
}
`;
  const ORBIT_FS = `
in float vA;
out vec4 fragColor;
uniform vec3 uColor;
void main(){ fragColor = vec4(uColor * vA, 1.0); }
`;

  /* ---------- asteroid belt (instanced, faceted, lit by the star) ---------- */
  const BELT_VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aInst;    // radius, start angle, height, scale
layout(location = 2) in vec4 aRnd;     // axis xyz-ish, spin / tint
uniform mat4 uVP;
uniform float uBeltT;
out vec3 vW;
out float vTint;
${NOISE}
void main(){
  float r = aInst.x;
  float ang = aInst.y + uBeltT / (r * sqrt(r));
  vec3 center = vec3(cos(ang) * r, aInst.z, -sin(ang) * r);
  vec3 ax = normalize(aRnd.xyz * 2.0 - 1.0 + 1e-3);
  float spin = uBeltT * (0.4 + aRnd.w * 1.6) + aRnd.x * 6.28;
  float c = cos(spin), s = sin(spin);
  vec3 v = aPos;
  float lump = 0.75 + 0.5 * hash13(aPos * 5.0 + aRnd.xyz * 9.0);
  v *= lump * vec3(1.0, 0.7 + 0.5 * aRnd.y, 0.8 + 0.4 * aRnd.z);
  v = v * c + cross(ax, v) * s + ax * dot(ax, v) * (1.0 - c);
  vec3 w = center + v * aInst.w;
  vW = w;
  vTint = aRnd.w;
  gl_Position = uVP * vec4(w, 1.0);
}
`;
  const BELT_FS = `
in vec3 vW;
in float vTint;
out vec4 fragColor;
uniform vec3 uSunPos;
void main(){
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  vec3 L = normalize(uSunPos - vW);
  float d = max(dot(n, L), 0.0);
  vec3 alb = mix(vec3(0.30, 0.26, 0.22), vec3(0.52, 0.47, 0.41), vTint);
  vec3 col = alb * (d * 1.3 + 0.015);
  col = 1.0 - exp(-col * 1.35);
  fragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
`;

  /* ---------- sky: baked once into a cube map ---------- */
  const FULL_VS = `
out vec2 vNdc;
void main(){
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vNdc = pos * 2.0 - 1.0;
  gl_Position = vec4(vNdc, 0.9999, 1.0);
}
`;
  const SKY_FS = `
in vec2 vNdc;
out vec4 fragColor;
uniform int uFace;
uniform float uSeed;
${NOISE}
vec3 faceDir(int f, vec2 s){
  vec3 d;
  if (f == 0) d = vec3(1.0, -s.y, -s.x);
  else if (f == 1) d = vec3(-1.0, -s.y, s.x);
  else if (f == 2) d = vec3(s.x, 1.0, s.y);
  else if (f == 3) d = vec3(s.x, -1.0, -s.y);
  else if (f == 4) d = vec3(s.x, -s.y, 1.0);
  else d = vec3(-s.x, -s.y, -1.0);
  return normalize(d);
}
// a distant spiral or elliptical galaxy as a small smudge on the sky
vec3 farGalaxy(vec3 d, vec3 dir, float size, float tilt, float rotA, vec3 core, vec3 arm, float amt){
  float facing = dot(d, dir);
  if (facing < 0.9) return vec3(0.0);
  vec3 up = abs(dir.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 tx = normalize(cross(dir, up));
  vec3 ty = cross(tx, dir);
  vec2 uv = vec2(dot(d, tx), dot(d, ty)) / size;
  uv = rot2(rotA) * uv;
  uv.y /= max(tilt, 0.12);
  float r = length(uv);
  if (r > 1.6) return vec3(0.0);
  float a = atan(uv.y, uv.x);
  float arms = 0.5 + 0.5 * cos(2.0 * (a - log(r + 0.03) * 2.8));
  float disk = exp(-r * 3.2) * (0.35 + 0.65 * arms);
  float bulge = exp(-r * r * 38.0);
  vec3 c = core * bulge * 1.5 + mix(arm, core, 0.25) * disk * 0.55;
  return c * amt * (1.0 - smoothstep(0.9, 1.6, r));
}
void main(){
  vec3 d = faceDir(uFace, vNdc);
  vec3 sd = vec3(uSeed, uSeed * 0.37, -uSeed * 0.61);

  // faint deep-space gradient so black is never flat
  vec3 col = vec3(0.0016, 0.0022, 0.0062) + vec3(0.0022, 0.0016, 0.0050) * (0.5 + 0.5 * d.y);

  // Milky Way: a tilted band with a warm bulge and soft dark rifts
  vec3 gN = normalize(vec3(0.30, 0.82, 0.48));
  vec3 gC = normalize(cross(gN, vec3(0.0, 0.0, 1.0)));
  float lat = dot(d, gN);
  float core = exp(-pow(lat / 0.12, 2.0));
  float haze = exp(-pow(lat / 0.40, 2.0));
  float structure = fbm(d * 2.6 + sd, 5) * 0.5 + 0.5;
  float detail = fbm(d * 9.0 + sd * 2.0, 4) * 0.5 + 0.5;
  float rift = smoothstep(0.50, 0.74, fbm(d * vec3(2.4, 3.8, 2.4) + 5.0 + sd, 4) * 0.5 + 0.5);
  float bulge = exp(-pow(acos(clamp(dot(d, gC), -1.0, 1.0)) / 0.62, 2.0));
  vec3 mwCool = vec3(0.18, 0.20, 0.42);
  vec3 mwWarm = vec3(0.66, 0.50, 0.44);
  vec3 mw = mix(mwCool, mwWarm, bulge);
  float dens = (core * (0.40 + 0.85 * structure) + haze * 0.30 * structure) * (0.75 + 0.5 * detail) * (1.0 - 0.62 * rift * (core + bulge * 0.4));
  col += mw * dens * 0.12;
  // unresolved stars inside the band
  float grain = pow(max(snoise(d * 240.0 + sd) * 0.5 + 0.5, 0.0), 10.0) * (core + haze * 0.3) * (0.4 + structure) * (1.0 - 0.5 * rift);
  col += vec3(0.95, 0.9, 1.0) * grain * 0.26;
  float grain2 = pow(max(snoise(d * 520.0 + sd * 2.0) * 0.5 + 0.5, 0.0), 12.0) * (core + haze * 0.2) * (1.0 - 0.5 * rift);
  col += vec3(1.0, 0.95, 0.9) * grain2 * 0.18;

  // emission nebulae: violet, indigo and magenta, with one restrained cyan
  vec3 dirs[6]; vec3 cols[6]; float sizes[6]; float amts[6];
  dirs[0] = normalize(vec3( 0.62,  0.35, -0.70)); cols[0] = vec3(0.50, 0.22, 0.95); sizes[0] = 0.62; amts[0] = 0.62;
  dirs[1] = normalize(vec3(-0.55,  0.25, -0.80)); cols[1] = vec3(0.92, 0.26, 0.66); sizes[1] = 0.50; amts[1] = 0.50;
  dirs[2] = normalize(vec3( 0.10, -0.50,  0.86)); cols[2] = vec3(0.18, 0.20, 0.78); sizes[2] = 0.80; amts[2] = 0.60;
  dirs[3] = normalize(vec3(-0.80, -0.20,  0.55)); cols[3] = vec3(0.14, 0.62, 0.80); sizes[3] = 0.34; amts[3] = 0.28;
  dirs[4] = normalize(vec3( 0.30,  0.80,  0.50)); cols[4] = vec3(0.62, 0.26, 0.90); sizes[4] = 0.56; amts[4] = 0.46;
  dirs[5] = normalize(vec3( 0.85, -0.30, -0.10)); cols[5] = vec3(0.34, 0.18, 0.80); sizes[5] = 0.52; amts[5] = 0.40;
  vec3 neb = vec3(0.0);
  for (int k = 0; k < 6; k++) {
    float ang = acos(clamp(dot(d, dirs[k]), -1.0, 1.0));
    float m = exp(-pow(ang / sizes[k], 2.0));
    if (m < 0.0004) continue;
    vec3 q = d * 3.0 + float(k) * 9.3 + sd;
    float n = fbm(q, 5) * 0.5 + 0.5;
    float fine = fbm(q * 3.4, 3) * 0.5 + 0.5;
    float w = smoothstep(0.42, 0.88, n) * (0.55 + 0.9 * fine);
    neb += cols[k] * m * w * amts[k];
  }
  col += neb * 0.16;

  // distant galaxies
  col += farGalaxy(d, normalize(vec3(-0.35, 0.55, 0.76)), 0.040, 0.45, 0.7, vec3(1.0, 0.85, 0.62), vec3(0.6, 0.7, 1.0), 0.58);
  col += farGalaxy(d, normalize(vec3(0.72, 0.30, 0.62)), 0.030, 0.30, 2.3, vec3(1.0, 0.82, 0.7), vec3(0.8, 0.7, 1.0), 0.52);
  col += farGalaxy(d, normalize(vec3(-0.15, -0.35, -0.92)), 0.052, 0.62, 1.4, vec3(1.0, 0.88, 0.66), vec3(0.55, 0.68, 1.0), 0.63);
  col += farGalaxy(d, normalize(vec3(0.45, -0.62, 0.64)), 0.026, 0.22, 0.2, vec3(1.0, 0.9, 0.75), vec3(0.7, 0.75, 1.0), 0.47);
  col += farGalaxy(d, normalize(vec3(-0.78, 0.18, -0.60)), 0.034, 0.5, 3.0, vec3(1.0, 0.8, 0.6), vec3(0.75, 0.6, 1.0), 0.52);
  col += farGalaxy(d, normalize(vec3(0.05, 0.92, -0.38)), 0.024, 0.4, 5.1, vec3(1.0, 0.9, 0.7), vec3(0.6, 0.7, 1.0), 0.44);

  col = 1.0 - exp(-col * 1.5);
  col = pow(col, vec3(1.0 / 2.2));
  // a hair of dithering so the dark gradients do not band in 8 bits
  col += (hash13(vec3(gl_FragCoord.xy, float(uFace) + uSeed)) - 0.5) / 255.0;
  fragColor = vec4(col, 1.0);
}
`;
  const BG_VS = `
out vec2 vNdc;
void main(){
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vNdc = pos * 2.0 - 1.0;
  gl_Position = vec4(vNdc, 0.99999, 1.0);
}
`;
  const BG_FS = `
in vec2 vNdc;
out vec4 fragColor;
uniform samplerCube uSky;
uniform vec3 uFwd, uRight, uUp;
uniform vec2 uTan;
uniform float uSkyRot, uExposure;
void main(){
  vec3 d = normalize(uFwd + uRight * (vNdc.x * uTan.x) + uUp * (vNdc.y * uTan.y));
  float c = cos(-uSkyRot), s = sin(-uSkyRot);
  d = vec3(c * d.x + s * d.z, d.y, -s * d.x + c * d.z);
  vec3 col = texture(uSky, d).rgb * uExposure;
  fragColor = vec4(col, 1.0);
}
`;

  /* ---------- sandbox galaxies: a few thousand additive stars along log-spiral arms ---------- */
  const GAL_VS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aCol;
layout(location = 2) in float aPh;
uniform mat4 uVP;
uniform mat4 uModel;
uniform vec3 uCam;
uniform float uPx, uTime, uSpin, uNear;
out vec3 vCol;
out float vSize;
void main(){
  float c = cos(uSpin / (0.35 + length(aPos.xz) * 0.12)), s = sin(uSpin / (0.35 + length(aPos.xz) * 0.12));
  vec3 p = vec3(c * aPos.x + s * aPos.z, aPos.y, -s * aPos.x + c * aPos.z);
  vec4 w = uModel * vec4(p, 1.0);
  gl_Position = uVP * w;
  float d = length(w.xyz - uCam);
  float size = aCol.a * clamp(uNear / d, 0.4, 3.0);
  vCol = aCol.rgb * (0.85 + 0.15 * sin(uTime * (1.0 + aPh * 2.0) + aPh * 40.0));
  vSize = size;
  gl_PointSize = max(size * uPx, 1.0);
}
`;
  const GAL_FS = `
in vec3 vCol;
in float vSize;
out vec4 fragColor;
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(c, c);
  if (d2 > 1.0) discard;
  float k = exp(-d2 * 4.5);
  fragColor = vec4(vCol * k, 1.0);
}
`;

  global.AYLA_SHADERS = {
    NOISE, COMMON,
    programs: {
      star:   { vs: SPHERE_VS, fs: NOISE + COMMON + STAR_FS },
      earth:  { vs: SPHERE_VS, fs: NOISE + COMMON + EARTH_FS },
      rocky:  { vs: SPHERE_VS, fs: NOISE + COMMON + ROCKY_FS },
      gas:    { vs: SPHERE_VS, fs: NOISE + COMMON + GAS_FS },
      ring:   { vs: RING_VS,   fs: NOISE + COMMON + RING_FS },
      atmo:   { vs: SPHERE_VS, fs: NOISE + COMMON + ATMO_FS },
      corona: { vs: BB_VS,     fs: CORONA_FS },
      glow:   { vs: BB_VS,     fs: GLOW_FS },
      stars:  { vs: STARS_VS,  fs: STARS_FS },
      orbit:  { vs: ORBIT_VS,  fs: ORBIT_FS },
      belt:   { vs: BELT_VS,   fs: BELT_FS },
      sky:    { vs: FULL_VS,   fs: SKY_FS },
      bg:     { vs: BG_VS,     fs: BG_FS },
      galaxy: { vs: GAL_VS,    fs: GAL_FS }
    }
  };
})(window);
