import * as THREE from 'three';
import { U } from './shared.js';
import { lensState } from './weatherfx.js';

// =============================================================================================
// WEATHER SYSTEM
//   States : sunny | cloudy | rain | storm | windy        (+ 'auto' mode that cycles them)
//   Coupling with the rest of the game is ONLY through the shared uniforms in shared.js `U`
//   (uWet, uRain, uStorm, uGrey/uGreyCol/uOver/uOverDark, uLightning, uWind, uSunVis, uWxTime, uFog*)
//   plus a few scene-light multipliers applied here (sun intensity, environment intensity, exposure).
//   Everything animated is on the GPU: rain streaks, splashes and leaves are instanced meshes whose
//   motion is a pure function of uWxTime; the CPU only sets a handful of uniforms per frame.
//   Draw calls added: rain 1, splashes 1, leaves 1, bolt 1, lens flare 1 (high tier) = max 5.
//
// PUBLIC API (module exports, usable before/after the world is built):
//   setWeather(name, transitionSeconds = 25)  name: 'sunny'|'cloudy'|'rain'|'storm'|'windy'|'auto'
//   getWeather()   -> live info object { name, auto, rain, wet, storm, cloudCover, overcast, wind, lightning, ... }
//   onWeatherEvent(cb) -> unsubscribe fn. cb receives
//        { type:'lightning', distance:<m>, azimuth:<rad>, intensity:0..1, visible:<bool> }  (thunder = distance / 343 s later)
//        { type:'weather', name, auto, duration }                                             (state change started)
//   cycleWeather() -> advances Sunny > Cloudy > Rain > Storm > Auto and returns the new mode name
// =============================================================================================

export const WEATHER_MODES = ['sunny', 'cloudy', 'rain', 'storm', 'auto'];

// tunable look per state (values are blended smoothly)
const STATES = {
  sunny:  { cover: 0.30, grey: 0.00, over: 0.00, dark: 0.00, sunMul: 1.25, envMul: 1.00, expMul: 1.00, fogMul: 0.75, rain: 0, storm: 0, wind: 0.55, gust: 0.15, sunVis: 1.0, cr: 0.52, cg: 0.57, cb: 0.65, drift: 1.0 },
  cloudy: { cover: 0.74, grey: 0.55, over: 0.60, dark: 0.15, sunMul: 0.32, envMul: 1.30, expMul: 1.10, fogMul: 1.30, rain: 0, storm: 0, wind: 1.00, gust: 0.25, sunVis: 0.30, cr: 0.50, cg: 0.525, cb: 0.56, drift: 1.8 },
  rain:   { cover: 0.95, grey: 0.97, over: 1.00, dark: 0.55, sunMul: 0.03, envMul: 1.25, expMul: 1.22, fogMul: 3.4, rain: 0.8, storm: 0, wind: 1.60, gust: 0.35, sunVis: 0.0, cr: 0.30, cg: 0.318, cb: 0.345, drift: 2.6 },
  storm:  { cover: 1.00, grey: 1.00, over: 1.00, dark: 1.00, sunMul: 0.0, envMul: 1.05, expMul: 1.35, fogMul: 5.0, rain: 1.0, storm: 1.0, wind: 4.20, gust: 0.55, sunVis: 0.0, cr: 0.135, cg: 0.145, cb: 0.165, drift: 6.0 },
  windy:  { cover: 0.42, grey: 0.00, over: 0.00, dark: 0.00, sunMul: 1.15, envMul: 1.00, expMul: 1.00, fogMul: 0.8, rain: 0, storm: 0, wind: 3.30, gust: 0.50, sunVis: 1.0, cr: 0.52, cg: 0.57, cb: 0.65, drift: 4.0 },
};
const KEYS = Object.keys(STATES.sunny);
const RAIN_LIKE = new Set(['rain', 'storm']);
// auto-cycle graph: sunny > cloudy > rain > storm > rain/cloudy > sunny ...
const NEXT = {
  sunny: ['cloudy', 'cloudy', 'windy'],
  windy: ['sunny', 'cloudy'],
  cloudy: ['rain', 'rain', 'sunny'],
  rain: ['storm', 'cloudy', 'cloudy'],
  storm: ['rain', 'rain', 'cloudy'],
};

// ----------------------------------------------------------------------- module level singleton
const listeners = [];
let inst = null;
let pending = null;
const info = {
  name: 'sunny', target: 'sunny', auto: false, mode: 'sunny', transition: 1,
  rain: 0, wet: 0, storm: 0, cloudCover: 0.3, overcast: 0, wind: 0.55, windVec: [0, 0], lightning: 0, sunVis: 1, leaves: 0,
};
export function getWeather() { return info; }
export function onWeatherEvent(cb) { listeners.push(cb); return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; }
function emit(ev) { for (const cb of listeners.slice()) { try { cb(ev); } catch (e) { console.error(e); } } }
export function setWeather(name, seconds = 25) {
  if (!inst) { pending = [name, seconds]; return; }
  inst.set(name, seconds);
}
export function cycleWeather(seconds = 8) {
  const cur = info.auto ? 'auto' : info.target;
  const i = WEATHER_MODES.indexOf(cur === 'windy' ? 'sunny' : cur);
  const n = WEATHER_MODES[(i + 1) % WEATHER_MODES.length];
  setWeather(n, seconds);
  return n;
}

// ----------------------------------------------------------------------- GLSL for the particles
const RAIN_VS = /* glsl */`
attribute vec4 aS;
uniform float uT; uniform vec3 uVel; uniform float uPx; uniform float uFlash;
varying vec2 vQ; varying float vA; varying float vAlong;
float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
void main() {
  float L = aS.w < 0.42 ? 0.0 : (aS.w < 0.78 ? 1.0 : 2.0);
  vec3 box = L < 0.5 ? vec3(20.0, 15.0, 20.0) : (L < 1.5 ? vec3(60.0, 38.0, 60.0) : vec3(170.0, 90.0, 170.0));
  float wd = L < 0.5 ? 0.006 : (L < 1.5 ? 0.018 : 0.06);
  float ln = L < 0.5 ? 0.42 : (L < 1.5 ? 1.25 : 3.6);
  float al = L < 0.5 ? 0.38 : (L < 1.5 ? 0.20 : 0.10);
  float sv = 0.85 + 0.35 * h11(aS.w * 97.0 + aS.x * 13.0);
  vec3 vel = uVel * sv;
  vec3 p0 = aS.xyz * box + vel * uT;
  vec3 rel = mod(p0 - cameraPosition + box * 0.5, box) - box * 0.5;
  vec3 head = cameraPosition + rel;
  vec3 tail = head - normalize(vel) * ln * sv;
  float rr = length(rel.xz) / (box.x * 0.5);
  float fade = (1.0 - smoothstep(0.62, 1.0, rr)) * (1.0 - smoothstep(0.7, 1.0, abs(rel.y) / (box.y * 0.5)));
  float dcam = length(rel);
  fade *= smoothstep(0.5, 2.4, dcam);
  vec3 vh = (viewMatrix * vec4(head, 1.0)).xyz;
  vec3 vt = (viewMatrix * vec4(tail, 1.0)).xyz;
  vh.z = min(vh.z, -0.2); vt.z = min(vt.z, -0.2);
  float s = position.y + 0.5;                    // 0 head .. 1 tail
  vec3 pv = mix(vh, vt, s);
  vec3 dir = normalize(vh - vt + 1e-5);
  vec3 side = normalize(cross(dir, normalize(pv)));
  float wpx = -pv.z * uPx * 1.25;                // never thinner than ~1.25 px (kills shimmer)
  float w = max(wd, wpx);
  vA = al * fade * min(1.0, wd / w) * (0.6 + 0.4 * (1.0 - s));
  vAlong = 1.0 - s;
  vQ = vec2(position.x * 2.0, s);
  pv += side * position.x * w;
  gl_Position = projectionMatrix * vec4(pv, 1.0);
}`;
const RAIN_FS = /* glsl */`
uniform vec3 uCol; uniform float uFlash;
varying vec2 vQ; varying float vA; varying float vAlong;
void main() {
  float a = (1.0 - vQ.x * vQ.x) * vA * pow(vAlong, 0.6);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uCol * (1.0 + uFlash * 5.0), a);
}`;

const SPLASH_VS = /* glsl */`
attribute vec4 aS; attribute float aPart;
uniform float uT; uniform float uR; uniform sampler2D uHeight;
uniform vec2 uGridOrigin; uniform vec2 uGridSize; uniform float uGridRes;
varying vec2 vUv; varying float vPart; varying float vAge; varying float vA;
float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
void main() {
  float per = 0.55 + 0.5 * aS.w;
  float t = uT / per + aS.z * 17.0;
  float cyc = floor(t); float age = t - cyc;
  vec2 r2 = vec2(h11(aS.x * 91.7 + cyc * 1.31), h11(aS.y * 53.3 + cyc * 2.17)) * 2.0 - 1.0;
  r2 = sign(r2) * pow(abs(r2), vec2(1.7));
  vec2 s = r2 * uR;
  vec2 wxz = s + 2.0 * uR * floor((cameraPosition.xz - s) / (2.0 * uR) + 0.5);
  float dd = length(wxz - cameraPosition.xz) / uR;
  float fade = 1.0 - smoothstep(0.55, 1.0, dd);
  vec2 tg = clamp((wxz - uGridOrigin) / uGridRes, vec2(0.0), uGridSize - 1.0);
  float gh = texelFetch(uHeight, ivec2(tg + 0.5), 0).r + 0.25;
  float sz = 0.9 + 0.8 * h11(aS.x * 7.0 + cyc);
  vec3 wp;
  vec2 q = position.xy;                          // -0.5..0.5
  if (aPart < 0.5) {
    float rad = (0.07 + 0.30 * sqrt(age)) * sz;
    wp = vec3(wxz.x + q.x * 2.0 * rad, gh + 0.01, wxz.y + q.y * 2.0 * rad);
  } else {
    float hh = 0.26 * sz;
    float yv = q.y + 0.5;
    vec2 off = aPart < 1.5 ? vec2(q.x * 2.0 * hh, 0.0) : vec2(0.0, q.x * 2.0 * hh);
    wp = vec3(wxz.x + off.x, gh + yv * hh * 1.6, wxz.y + off.y);
  }
  vUv = q * 2.0; vPart = aPart; vAge = age; vA = fade;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const SPLASH_FS = /* glsl */`
uniform vec3 uCol; uniform float uFlash;
varying vec2 vUv; varying float vPart; varying float vAge; varying float vA;
void main() {
  float a = 0.0;
  if (vPart < 0.5) {
    float r = length(vUv);
    float R = mix(0.12, 0.95, sqrt(vAge));
    float w = mix(0.16, 0.06, vAge);
    a = smoothstep(w * 0.6, 0.0, abs(r - R)) * pow(1.0 - vAge, 1.6) * 0.6;
    a += smoothstep(0.05, 0.0, abs(r - R * 0.55)) * (1.0 - vAge) * 0.35 * step(0.25, vAge);
  } else {
    // crown: a few droplets thrown up on parabolic arcs
    float y = vUv.y * 0.5 + 0.5;
    float x = vUv.x;
    for (int k = 0; k < 5; k++) {
      float fk = float(k) - 2.0;
      float ph = clamp(vAge * 1.6 - 0.05 * abs(fk), 0.0, 1.0);
      float ty = 4.0 * ph * (1.0 - ph) * (0.8 - 0.12 * abs(fk));
      float tx = fk * 0.30 * (0.3 + ph);
      float d = length(vec2((x - tx) * 1.0, (y - ty) * 1.3));
      a += smoothstep(0.10, 0.03, d) * step(ph, 0.999) * step(0.001, ph);
    }
    a *= (1.0 - vAge) * 0.28;
  }
  a *= vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uCol * (1.0 + uFlash * 4.0), min(a, 0.85));
}`;

const LEAF_VS = /* glsl */`
attribute vec4 aS;
uniform float uT; uniform vec2 uWind; uniform float uSpeed; uniform vec3 uSun; uniform float uSunK;
uniform float uPx;
varying vec2 vUv; varying vec3 vCol;
float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
void main() {
  vec3 box = vec3(40.0, 13.0, 40.0);
  float h1 = h11(aS.w * 71.0), h2 = h11(aS.w * 113.0 + 3.0), h3 = h11(aS.w * 29.0 + 7.0);
  float t = uT;
  vec3 drift = vec3(uWind.x, 0.0, uWind.y) * uSpeed * (0.8 + 0.5 * h1);
  vec3 p0 = aS.xyz * box + drift * t
          + vec3(sin(t * (0.8 + h2) + aS.x * 40.0) * 1.4, sin(t * (1.3 + h3) + aS.y * 30.0) * 1.1 - 0.30 * t * (0.6 + h2), cos(t * (0.7 + h1) + aS.z * 50.0) * 1.4);
  vec3 off = vec3(box.x * 0.5, 2.0, box.z * 0.5);
  vec3 rel = mod(p0 - cameraPosition + off, box) - off;
  float rr = length(rel.xz) / (box.x * 0.5);
  float sz = (0.12 + 0.14 * h2) * (1.0 - smoothstep(0.65, 1.0, rr)) * smoothstep(0.8, 2.5, length(rel));
  // tumbling
  vec3 ax = normalize(vec3(h1 - 0.5, h2 - 0.5 + 0.3, h3 - 0.5) + 1e-3);
  float ang = t * (2.0 + 5.0 * h3) + h1 * 6.283;
  float c = cos(ang), s = sin(ang);
  vec3 lp = vec3(position.xy * sz, 0.0);
  vec3 rp = lp * c + cross(ax, lp) * s + ax * dot(ax, lp) * (1.0 - c);
  vec3 n = vec3(0.0, 0.0, 1.0);
  n = n * c + cross(ax, n) * s + ax * dot(ax, n) * (1.0 - c);
  vec3 wp = cameraPosition + rel + rp;
  vUv = position.xy + 0.5;
  // palette: greens, yellows, orange, brown
  vec3 cols[5];
  cols[0] = vec3(0.11, 0.24, 0.04); cols[1] = vec3(0.30, 0.38, 0.05); cols[2] = vec3(0.55, 0.40, 0.05);
  cols[3] = vec3(0.50, 0.20, 0.04); cols[4] = vec3(0.26, 0.15, 0.06);
  int ci = int(floor(h1 * 4.999));
  vec3 base = cols[ci];
  float lam = abs(dot(n, uSun));
  vCol = base * (0.55 + 0.9 * lam * uSunK + 0.35);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const LEAF_FS = /* glsl */`
varying vec2 vUv; varying vec3 vCol;
void main() {
  vec2 q = (vUv - 0.5) * vec2(2.0, 2.4);
  float shape = 1.0 - smoothstep(0.78, 1.0, length(q * vec2(0.85, 1.0)) + abs(q.x) * 0.15 * (q.y + 1.0));
  if (shape < 0.5) discard;
  float vein = smoothstep(0.06, 0.0, abs(q.x)) * 0.25;
  gl_FragColor = vec4(vCol * (1.0 - vein), 1.0);
}`;

const BOLT_VS = /* glsl */`
attribute vec2 aK;   // x: side -1..1, y: kind (0 core, 1 glow)
varying vec2 vK;
void main() { vK = aK; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`;
const BOLT_FS = /* glsl */`
uniform float uEnv;
varying vec2 vK;
void main() {
  float x = abs(vK.x);
  vec3 c;
  if (vK.y < 0.5) c = vec3(0.95, 0.97, 1.0) * 7.0 * pow(1.0 - x, 2.0);
  else c = vec3(0.50, 0.62, 1.0) * 0.8 * exp(-x * x * 4.0);
  gl_FragColor = vec4(c * uEnv, 1.0);
}`;

const FLARE_VS = /* glsl */`
attribute vec4 aK;    // x: position along sun->centre line, y: size (ndc-y), z: kind (0 glare, 1 ghost disc, 2 ring, 3 streak), w: intensity
uniform vec3 uSunW; uniform float uAspect; uniform float uVis;
varying vec2 vP; varying float vKind; varying float vI;
void main() {
  vec4 c = projectionMatrix * viewMatrix * vec4(cameraPosition + uSunW * 1000.0, 1.0);
  float ok = step(0.05, c.w);
  vec2 ndc = c.xy / max(c.w, 0.05);
  float edge = 1.0 - smoothstep(0.75, 1.35, max(abs(ndc.x), abs(ndc.y)));
  vec2 centre = ndc * aK.x;
  vec2 q = position.xy;
  vec2 sz = vec2(aK.y / uAspect, aK.y);
  if (aK.z > 2.5) sz.x *= 6.0;
  vec2 pos = centre + q * 2.0 * sz;
  vP = q * 2.0; vKind = aK.z;
  float k = aK.z < 0.5 ? 1.0 : edge;
  vI = aK.w * uVis * ok * k;
  gl_Position = vec4(pos, aK.z < 0.5 ? 0.99999 : 0.0, 1.0);   // glare sits at the far plane (hidden behind geometry), ghosts are not occluded
}`;
const FLARE_FS = /* glsl */`
varying vec2 vP; varying float vKind; varying float vI;
void main() {
  float r = length(vP);
  vec3 c = vec3(0.0);
  if (vKind < 0.5) {            // glare: soft halo + subtle star
    float a = exp(-r * r * 5.0) * 0.42 + exp(-r * 2.2) * 0.10;
    float ang = atan(vP.y, vP.x);
    a += pow(max(cos(ang * 3.0), 0.0), 24.0) * exp(-r * 3.0) * 0.05;
    c = vec3(1.0, 0.93, 0.78) * a;
  } else if (vKind < 1.5) {     // ghost disc
    c = vec3(1.0, 0.9, 0.75) * smoothstep(1.0, 0.6, r) * 0.05;
  } else if (vKind < 2.5) {     // ring
    c = vec3(0.9, 0.95, 1.0) * smoothstep(0.2, 0.0, abs(r - 0.82)) * 0.03;
  } else {                      // horizontal anamorphic streak
    c = vec3(1.0, 0.95, 0.9) * exp(-abs(vP.y) * 30.0) * smoothstep(1.0, 0.2, abs(vP.x)) * 0.05;
  }
  gl_FragColor = vec4(c * vI, 1.0);
}`;

// ----------------------------------------------------------------------- helpers
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const smooth = (x) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function quadGeo(extra) {
  const g = new THREE.InstancedBufferGeometry();
  const p = new THREE.PlaneGeometry(1, 1);
  g.setIndex(p.index); g.setAttribute('position', p.attributes.position); g.setAttribute('uv', p.attributes.uv);
  if (extra) extra(g);
  return g;
}
function seeds(n, seed) {
  const r = rng(seed), a = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i++) a[i] = r();
  return new THREE.InstancedBufferAttribute(a, 4);
}

// =============================================================================================
export function createWeather(ctx) {
  const { scene, camera, renderer, sun, sky, cfg, hf, heightTex } = ctx;
  const getPost = ctx.getPost || (() => null);
  const tier = cfg.tier;
  const COUNTS = { low: { rain: 3000, splash: 180, leaves: 120 }, medium: { rain: 8000, splash: 520, leaves: 320 }, high: { rain: 20000, splash: 1300, leaves: 800 } }[tier];

  // base (sunny) values captured from the other systems so we only ever multiply them
  const base = {
    sunI: sun.intensity, env: scene.environmentIntensity, fog: U.uFogDensity.value, shadowR: sun.shadow.radius,
    amb: U.uSkyAmb.value.clone(),
    exposure: (getPost() && getPost().tone && getPost().tone.exposure) || 1.1,
  };
  const du = sky.dome.material.uniforms;
  const baseDrift = du.uWind.value.clone();
  const baseZen = du.uZenith.value.clone(), baseHor = du.uHorizon.value.clone();
  const deepZen = new THREE.Color(0.012, 0.095, 0.56), deepHor = new THREE.Color(0.29, 0.55, 0.95);

  const cur = {}, from = {}, tgt = {};
  for (const k of KEYS) { cur[k] = STATES.sunny[k]; from[k] = cur[k]; tgt[k] = cur[k]; }
  let name = 'sunny', auto = false, tp = 1, dur = 1, clock = 0, autoT = 0;
  let wet = 0, lensWet = 0, leafAmt = 0;

  // ---------------------------------------------------------------- rain
  const rainGeo = quadGeo((g) => g.setAttribute('aS', seeds(COUNTS.rain, 1234)));
  rainGeo.instanceCount = 0;
  const rainMat = new THREE.ShaderMaterial({
    vertexShader: RAIN_VS, fragmentShader: RAIN_FS, transparent: true, depthWrite: false, depthTest: true, toneMapped: false,
    uniforms: { uT: U.uWxTime, uVel: { value: new THREE.Vector3(0, -9.5, 0) }, uPx: { value: 0.002 }, uCol: { value: new THREE.Color(0.6, 0.66, 0.74) }, uFlash: U.uLightning },
  });
  const rain = new THREE.Mesh(rainGeo, rainMat);
  rain.frustumCulled = false; rain.renderOrder = 1010; rain.visible = false; rain.name = 'wxRain';
  scene.add(rain);

  // ---------------------------------------------------------------- splashes (ring + crown, one draw call)
  const splashGeo = (() => {
    const g = new THREE.InstancedBufferGeometry();
    const pos = [], idx = [], part = [];
    const quad = (pId) => {
      const o = pos.length / 3;
      pos.push(-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0);
      part.push(pId, pId, pId, pId);
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    };
    quad(0); quad(1); quad(2);
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
    g.setIndex(idx);
    g.setAttribute('aS', seeds(COUNTS.splash, 777));
    g.instanceCount = 0;
    return g;
  })();
  const splashMat = new THREE.ShaderMaterial({
    vertexShader: SPLASH_VS, fragmentShader: SPLASH_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    uniforms: { uT: U.uWxTime, uR: { value: tier === 'low' ? 9 : 12 }, uHeight: { value: heightTex }, uGridOrigin: U.uGridOrigin, uGridSize: U.uGridSize, uGridRes: U.uGridRes, uCol: { value: new THREE.Color(0.8, 0.85, 0.92) }, uFlash: U.uLightning },
  });
  const splash = new THREE.Mesh(splashGeo, splashMat);
  splash.frustumCulled = false; splash.renderOrder = 1011; splash.visible = false; splash.name = 'wxSplash';
  scene.add(splash);

  // ---------------------------------------------------------------- leaves
  const leafGeo = quadGeo((g) => g.setAttribute('aS', seeds(COUNTS.leaves, 4242)));
  leafGeo.instanceCount = 0;
  const leafMat = new THREE.ShaderMaterial({
    vertexShader: LEAF_VS, fragmentShader: LEAF_FS, side: THREE.DoubleSide, toneMapped: false,
    uniforms: { uT: U.uWxTime, uWind: U.uWind, uSpeed: { value: 2.2 }, uSun: { value: U.uSunDir.value }, uSunK: { value: 1 }, uPx: { value: 0.002 } },
  });
  const leaves = new THREE.Mesh(leafGeo, leafMat);
  leaves.frustumCulled = false; leaves.visible = false; leaves.name = 'wxLeaves';
  scene.add(leaves);

  // ---------------------------------------------------------------- lightning bolt (CPU-built once per strike)
  const MAXSEG = 80, MAXQ = MAXSEG * 2;
  const boltPos = new Float32Array(MAXQ * 4 * 3), boltK = new Float32Array(MAXQ * 4 * 2);
  const boltIdx = new Uint16Array(MAXQ * 6);
  for (let q = 0; q < MAXQ; q++) { const o = q * 4; boltIdx.set([o, o + 1, o + 2, o + 1, o + 3, o + 2], q * 6); }
  const boltGeo = new THREE.BufferGeometry();
  boltGeo.setAttribute('position', new THREE.BufferAttribute(boltPos, 3).setUsage(THREE.DynamicDrawUsage));
  boltGeo.setAttribute('aK', new THREE.BufferAttribute(boltK, 2).setUsage(THREE.DynamicDrawUsage));
  boltGeo.setIndex(new THREE.BufferAttribute(boltIdx, 1));
  boltGeo.setDrawRange(0, 0);
  const boltMat = new THREE.ShaderMaterial({
    vertexShader: BOLT_VS, fragmentShader: BOLT_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    uniforms: { uEnv: { value: 0 } },
  });
  const bolt = new THREE.Mesh(boltGeo, boltMat);
  bolt.frustumCulled = false; bolt.renderOrder = 1012; bolt.visible = false; bolt.name = 'wxBolt';
  scene.add(bolt);

  // scratch (no per-frame allocation)
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
  const nodes = [];     // reused polyline scratch
  const segs = [];      // [ax,ay,az,bx,by,bz,w]
  for (let i = 0; i < MAXSEG; i++) segs.push(new Float32Array(7));
  let segN = 0;

  function addSeg(ax, ay, az, bx, by, bz, w) { if (segN >= MAXSEG) return; const s = segs[segN++]; s[0] = ax; s[1] = ay; s[2] = az; s[3] = bx; s[4] = by; s[5] = bz; s[6] = w; }
  // midpoint-displacement jagged line; pushes segments
  function jag(ax, ay, az, bx, by, bz, iters, disp, w, rnd) {
    nodes.length = 0; nodes.push([ax, ay, az], [bx, by, bz]);
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < nodes.length - 1; i += 2) {
        const a = nodes[i], b = nodes[i + 1];
        const m = [(a[0] + b[0]) / 2 + (rnd() - 0.5) * 2 * disp, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + (rnd() - 0.5) * 2 * disp];
        nodes.splice(i + 1, 0, m);
      }
      disp *= 0.55;
    }
    for (let i = 0; i < nodes.length - 1; i++) addSeg(nodes[i][0], nodes[i][1], nodes[i][2], nodes[i + 1][0], nodes[i + 1][1], nodes[i + 1][2], w);
    return nodes.length > 0 ? nodes[nodes.length - 1] : null;
  }
  function buildBolt(bx, bz, dist, seed) {
    const rnd = rng(seed);
    segN = 0;
    const gy = hf.sample(bx, bz);
    const topY = camera.position.y + 700 + rnd() * 500;
    const H = topY - gy;
    const sx = bx + (rnd() - 0.5) * H * 0.25, sz = bz + (rnd() - 0.5) * H * 0.25;
    // main channel: 5 doublings -> 32 segments; keep copies of nodes for branching
    nodes.length = 0;
    const main = [];
    {
      nodes.push([sx, topY, sz], [bx, gy, bz]);
      let disp = H * 0.10;
      for (let it = 0; it < 5; it++) {
        for (let i = 0; i < nodes.length - 1; i += 2) {
          const a = nodes[i], b = nodes[i + 1];
          nodes.splice(i + 1, 0, [(a[0] + b[0]) / 2 + (rnd() - 0.5) * 2 * disp, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + (rnd() - 0.5) * 2 * disp]);
        }
        disp *= 0.55;
      }
      for (const n of nodes) main.push(n);
    }
    for (let i = 0; i < main.length - 1; i++) addSeg(main[i][0], main[i][1], main[i][2], main[i + 1][0], main[i + 1][1], main[i + 1][2], 1);
    // branches (3 iterations -> 8 segs each)
    const nb = 4;
    for (let b = 0; b < nb; b++) {
      const k = 2 + Math.floor(rnd() * (main.length * 0.6));
      const n = main[k];
      const ang = rnd() * Math.PI * 2, len = H * (0.12 + rnd() * 0.22);
      jag(n[0], n[1], n[2], n[0] + Math.cos(ang) * len, n[1] - H * (0.12 + rnd() * 0.3), n[2] + Math.sin(ang) * len, 3, len * 0.18, 0.5, rnd);
    }
    // ribbons facing the camera
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    let q = 0;
    for (let i = 0; i < segN; i++) {
      const s = segs[i];
      v1.set(s[3] - s[0], s[4] - s[1], s[5] - s[2]);
      v2.set((s[0] + s[3]) / 2 - cx, (s[1] + s[4]) / 2 - cy, (s[2] + s[5]) / 2 - cz);
      const d = v2.length();
      v3.crossVectors(v1, v2).normalize();
      for (let kind = 0; kind < 2; kind++) {
        const w = d * 0.0022 * s[6] * (kind === 0 ? 1 : 7.0);
        const o = q * 4;
        for (let j = 0; j < 4; j++) {
          const end = j >> 1, side = (j & 1) ? 1 : -1;
          const px = (end ? s[3] : s[0]) + v3.x * w * side, py = (end ? s[4] : s[1]) + v3.y * w * side, pz = (end ? s[5] : s[2]) + v3.z * w * side;
          boltPos[(o + j) * 3] = px; boltPos[(o + j) * 3 + 1] = py; boltPos[(o + j) * 3 + 2] = pz;
          boltK[(o + j) * 2] = side; boltK[(o + j) * 2 + 1] = kind;
        }
        q++;
      }
    }
    boltGeo.attributes.position.needsUpdate = true; boltGeo.attributes.aK.needsUpdate = true;
    boltGeo.setDrawRange(0, q * 6);
  }

  // ---------------------------------------------------------------- lens flare (high tier)
  let flare = null, flareVis = 0;
  if (tier === 'high') {
    const fg = new THREE.InstancedBufferGeometry();
    const p = new THREE.PlaneGeometry(1, 1);
    fg.setIndex(p.index); fg.setAttribute('position', p.attributes.position);
    const K = [
      [1.0, 0.55, 0, 1.0],
      [-0.35, 0.05, 1, 0.5], [-0.75, 0.09, 1, 0.35], [0.45, 0.04, 1, 0.45], [-1.25, 0.16, 2, 0.5], [0.8, 0.07, 1, 0.3], [1.0, 0.09, 3, 0.6],
    ];
    fg.setAttribute('aK', new THREE.InstancedBufferAttribute(new Float32Array(K.flat()), 4));
    fg.instanceCount = K.length;
    const fm = new THREE.ShaderMaterial({
      vertexShader: FLARE_VS, fragmentShader: FLARE_FS, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: false,
      uniforms: { uSunW: { value: U.uSunDir.value }, uAspect: { value: 1.6 }, uVis: { value: 0 } },
    });
    flare = new THREE.Mesh(fg, fm);
    flare.frustumCulled = false; flare.renderOrder = 1013; flare.visible = false; flare.name = 'wxFlare';
    scene.add(flare);
  }
  const cScr = new THREE.Color();
  function sunBlocked() {
    // coarse terrain horizon test toward the sun (buildings/trees are handled by the depth test on the glare quad)
    const sd = U.uSunDir.value, cx = camera.position.x, cz = camera.position.z, cy = camera.position.y;
    for (let t = 60; t < 3000; t *= 1.5) {
      if (hf.sample(cx + sd.x * t, cz + sd.z * t) > cy + sd.y * t - 2) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- lightning scheduling
  let strikeT = -1, strikeHold = false, nextStrike = 6, lightEnv = 0;
  const PULSES = [[0, 1.0, 0.07], [0.12, 0.5, 0.05], [0.21, 0.95, 0.10], [0.38, 0.35, 0.14], [0.55, 0.18, 0.18]];
  function envelope(t) {
    let v = 0;
    for (const p of PULSES) { const d = t - p[0]; if (d >= 0) v = Math.max(v, p[1] * Math.exp(-d / p[2]) * smooth(d / 0.012)); }
    return v;
  }
  function strike(opts = {}) {
    const rnd = Math.random;
    let az, dist;
    if (opts.inView) {
      camera.getWorldDirection(v1);
      az = Math.atan2(v1.z, v1.x) + (opts.offset != null ? opts.offset : (rnd() - 0.5) * 0.5);
      dist = opts.distance || 1500;
    } else {
      az = rnd() * Math.PI * 2;
      dist = opts.distance || (rnd() < 0.45 ? 800 + rnd() * 1400 : 2400 + rnd() * 3600);
    }
    const bx = camera.position.x + Math.cos(az) * dist, bz = camera.position.z + Math.sin(az) * dist;
    const visible = dist <= 2600;
    if (visible) buildBolt(bx, bz, dist, (Math.random() * 1e9) | 0);
    bolt.visible = visible;
    // direction to the strike (cloud base elevation ~ atan(900/dist))
    const el = Math.atan2(900, dist);
    U.uLightDir.value.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
    strikeT = 0; strikeHold = !!opts.hold;
    emit({ type: 'lightning', distance: dist, azimuth: az, intensity: 0.6 + 0.4 * (1 - Math.min(1, dist / 6000)), visible });
  }

  // ---------------------------------------------------------------- state machine
  function set(n, seconds) {
    if (n === 'auto') {
      auto = true; autoT = 60 + Math.random() * 60;
      info.auto = true; info.mode = 'auto';
      emit({ type: 'weather', name, auto: true, duration: 0 });
      return;
    }
    if (!STATES[n]) { console.warn('unknown weather', n); return; }
    // manual selection leaves auto mode unless called by the auto cycler itself
    if (!set._fromAuto) { auto = false; info.auto = false; }
    info.mode = auto ? 'auto' : n;
    name = n; info.name = n; info.target = n;
    for (const k of KEYS) { from[k] = cur[k]; tgt[k] = STATES[n][k]; }
    dur = Math.max(0, seconds);
    tp = dur <= 0 ? 1 : 0;
    if (dur <= 0) {
      for (const k of KEYS) cur[k] = tgt[k];
      wet = RAIN_LIKE.has(n) ? 1 : 0;
      lensWet = RAIN_LIKE.has(n) ? 1 : 0;
      leafAmt = 0;
    }
    emit({ type: 'weather', name: n, auto, duration: dur });
  }
  function autoNext() {
    const opts = NEXT[name] || ['sunny'];
    const n = opts[Math.floor(Math.random() * opts.length)];
    set._fromAuto = true;
    const d = 20 + Math.random() * 20;
    set(n, d);
    set._fromAuto = false;
    autoT = d + 100 + Math.random() * 110;
  }

  // ---------------------------------------------------------------- per-frame
  const gustPhase = Math.random() * 100;
  function update(dt, paused, speed = 0, drone = false) {
    if (paused) dt = 0;
    clock += dt;
    U.uWxTime.value = clock;

    // transition
    if (tp < 1) {
      tp = Math.min(1, tp + dt / Math.max(dur, 1e-3));
      for (const k of KEYS) {
        let e = smooth(tp);
        if (k === 'rain' || k === 'storm') e = tgt[k] > from[k] ? smooth((tp - 0.35) / 0.65) : smooth(tp / 0.55);
        cur[k] = from[k] + (tgt[k] - from[k]) * e;
      }
      info.transition = tp;
    }
    if (auto && dt > 0) { autoT -= dt; if (autoT <= 0) autoNext(); }

    // wetness: soaks quickly, dries slowly
    const wetT = clamp01(cur.rain * 1.8);
    if (dt > 0) wet += (wetT - wet) * Math.min(1, dt * (wetT > wet ? 0.12 : 0.012));
    lensWet += ((cur.rain > 0.15 ? 1 : 0) - lensWet) * Math.min(1, dt * (cur.rain > 0.15 ? 0.6 : 0.05));

    // wind with gusts
    const g = 0.55 * Math.sin(clock * 0.45 + gustPhase) + 0.30 * Math.sin(clock * 1.3 + gustPhase * 2.1) + 0.15 * Math.sin(clock * 3.1 + gustPhase * 0.7);
    const gustK = Math.max(0.2, 1 + cur.gust * g * 1.4);
    const wk = cur.wind * gustK;
    const th = 0.46 + 0.25 * Math.sin(clock * 0.05 + 2);
    U.uWind.value.set(Math.cos(th) * wk, Math.sin(th) * wk);
    leafAmt = smooth((wk - 1.8) / 2.0);

    // shared uniforms
    U.uWet.value = wet; U.uRain.value = cur.rain; U.uStorm.value = cur.storm; U.uCloudCover.value = cur.cover;
    U.uGrey.value = cur.grey; U.uOver.value = cur.over; U.uOverDark.value = cur.dark; U.uSunVis.value = cur.sunVis;
    U.uGreyCol.value.setRGB(cur.cr, cur.cg, cur.cb);

    // lightning
    if (cur.storm > 0.5 && dt > 0 && strikeT < 0) { nextStrike -= dt; if (nextStrike <= 0) { strike(); nextStrike = 3.5 + Math.random() * 9 / (0.5 + cur.storm); } }
    if (strikeT >= 0) {
      if (!strikeHold) strikeT += dt; else strikeT = 0.003;
      lightEnv = envelope(strikeT);
      if (strikeT > 0.9) { strikeT = -1; lightEnv = 0; bolt.visible = false; boltGeo.setDrawRange(0, 0); }
    }
    const flick = lightEnv * (0.85 + 0.15 * Math.sin(clock * 90));
    U.uLightning.value = flick * (0.35 + 0.65 * cur.storm);
    boltMat.uniforms.uEnv.value = lightEnv;

    // lights / environment / exposure / fog / ambient
    sun.intensity = base.sunI * cur.sunMul;
    U.uSunI.value = sun.intensity;
    sun.shadow.radius = base.shadowR * (0.7 + 1.6 * clamp01(cur.grey));
    scene.environmentIntensity = base.env * cur.envMul + U.uLightning.value * 2.2;
    const post = getPost();
    if (post && post.tone) post.tone.exposure = base.exposure * cur.expMul;
    if (post && post.godrays) post.godrays.blendMode.opacity.value = clamp01(cur.sunVis) * (1 - cur.grey);
    U.uFogDensity.value = base.fog * cur.fogMul;
    const gk = clamp01(cur.grey);
    U.uSkyAmb.value.copy(base.amb).lerp(cScr.setRGB(cur.cr * 2.2, cur.cg * 2.2, cur.cb * 2.2), gk * 0.7);
    U.uSkyAmb.value.r += U.uLightning.value * 0.8; U.uSkyAmb.value.g += U.uLightning.value * 0.95; U.uSkyAmb.value.b += U.uLightning.value * 1.5;

    // sky dome clouds
    du.uCover.value = cur.cover;
    { const sn = clamp01(cur.sunVis) * (1 - cur.grey); du.uZenith.value.copy(baseZen).lerp(deepZen, sn); du.uHorizon.value.copy(baseHor).lerp(deepHor, sn * 0.6); } // sunny: deeper blue
    du.uWind.value.copy(baseDrift).multiplyScalar(cur.drift);

    // ---- particles
    const rainA = cur.rain;
    rain.visible = rainA > 0.02;
    if (rain.visible) {
      const n = Math.floor(COUNTS.rain * Math.min(1, rainA));
      rainGeo.instanceCount = n;
      const wx = U.uWind.value.x, wz = U.uWind.value.y;
      rainMat.uniforms.uVel.value.set(wx * 0.7, -9.5, wz * 0.7);
      rainMat.uniforms.uPx.value = 2 / (camera.projectionMatrix.elements[5] * renderer.domElement.height);
      const gc = U.uGreyCol.value;
      rainMat.uniforms.uCol.value.setRGB(gc.r * 1.25 + 0.06, gc.g * 1.25 + 0.065, gc.b * 1.25 + 0.075);
    }
    splash.visible = rain.visible && (wet > 0.3 || rainA > 0.3);
    if (splash.visible) {
      splashGeo.instanceCount = Math.floor(COUNTS.splash * Math.min(1, rainA));
      const gc = U.uGreyCol.value;
      splashMat.uniforms.uCol.value.setRGB(gc.r * 1.9 + 0.22, gc.g * 1.9 + 0.24, gc.b * 1.9 + 0.27);
    }
    leaves.visible = leafAmt > 0.02;
    if (leaves.visible) {
      leafGeo.instanceCount = Math.floor(COUNTS.leaves * leafAmt);
      leafMat.uniforms.uSpeed.value = 1.1 + 0.55 * wk;
      leafMat.uniforms.uSunK.value = clamp01(cur.sunMul * 1.1);
    }

    // lens flare
    if (flare) {
      const want = clamp01((cur.sunVis - 0.5) * 2) * (1 - cur.grey);
      flare.visible = want > 0.02;
      if (flare.visible) {
        if ((frameNo++ & 7) === 0) flareBlocked = sunBlocked();
        flareVis += ((flareBlocked ? 0 : want) - flareVis) * Math.min(1, dt * 4 + 0.02);
        flare.material.uniforms.uVis.value = flareVis * 0.8;
        flare.material.uniforms.uAspect.value = camera.aspect;
      }
    }

    // screen drops
    lensState.time = clock;
    lensState.amount = 0.42 * lensWet * clamp01(cur.rain * 1.3) * (1 - 0.55 * clamp01(speed / 14)) * (drone ? 0.35 : 1);

    // public info
    info.rain = cur.rain; info.wet = wet; info.storm = cur.storm; info.cloudCover = cur.cover; info.overcast = cur.over;
    info.wind = wk; info.windVec[0] = U.uWind.value.x; info.windVec[1] = U.uWind.value.y; info.lightning = U.uLightning.value;
    info.sunVis = cur.sunVis; info.leaves = leafAmt;
  }
  let frameNo = 0, flareBlocked = false;

  const api = { update, set, strike, cur,
    releaseStrike() { strikeHold = false; },
    get lens() { return lensState; } };
  inst = api;
  // initial state (optionally from ?wx=)
  const q = new URLSearchParams(location.search).get('wx');
  if (pending) { const [n, s] = pending; pending = null; set(n, s); }
  else if (q && (STATES[q] || q === 'auto')) { if (q === 'auto') { set('sunny', 0); set('auto', 0); } else set(q, 0); }
  else { set('sunny', 0); set('auto', 0); }
  return api;
}
