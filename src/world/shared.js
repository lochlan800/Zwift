import * as THREE from 'three';

// Uniforms shared by every custom/patched material (same objects => one update).
export const U = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Color(1, 1, 1) },
  uSkyLUT: { value: null },
  uFogDensity: { value: 0.00013 },
  uFogFalloff: { value: 0.0045 },
  uFogBase: { value: 20 },
  uNoise: { value: null },
  uWind: { value: new THREE.Vector2(0.8, 0.4) },
  uShadowBake: { value: null },
  uGridOrigin: { value: new THREE.Vector2() },
  uGridSize: { value: new THREE.Vector2() },
  uGridRes: { value: 4 },
  uBakeFade: { value: new THREE.Vector2(180, 260) },
  uSkyAmb: { value: new THREE.Color(0.5, 0.6, 0.8) },
  uSunI: { value: 8.5 },
  uRiderPos: { value: new THREE.Vector3(0, -1e5, 0) },
  // ---- WEATHER (written only by world/weather.js; everyone else just reads) ----
  uWxTime: { value: 0 },                              // weather clock (frozen while paused)
  uWet: { value: 0 },                                 // 0..1 surface wetness (puddles grow with it)
  uRain: { value: 0 },                                // 0..1 rain intensity (drives ripples)
  uStorm: { value: 0 },                               // 0..1 storminess
  uCloudCover: { value: 0.3 },                        // 0..1 cumulus cover (informational; sky reads its own)
  uLightning: { value: 0 },                           // 0..1 flash envelope (with flicker)
  uLightDir: { value: new THREE.Vector3(0, 0.5, 1) }, // direction of the current strike
  uGrey: { value: 0 },                                // 0 clear .. 1 overcast: sky/fog flatten to uGreyCol
  uGreyCol: { value: new THREE.Color(0.5, 0.55, 0.62) },
  uOver: { value: 0 },                                // overcast cloud sheet coverage
  uOverDark: { value: 0 },                            // 0 pale grey .. 1 charcoal
  uSunVis: { value: 1 },                              // sun disc / glare visibility
};

// GLSL: aerial perspective / exponential height fog using a sky colour LUT
// (equirect, rendered from the same Preetham sky as the background) so the
// distant terrain dissolves exactly into the horizon colour.
export const AERIAL_GLSL = /* glsl */`
uniform sampler2D uSkyLUT;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uFogBase;
uniform float uGrey;      // WEATHER: overcast flattening of sky/fog colour
uniform vec3 uGreyCol;
uniform float uLightning;
vec3 skyLUT(vec3 d) {
  d = normalize(vec3(d.x, max(d.y, 0.07), d.z));
  vec3 c = texture2D(uSkyLUT, equirectUv(d)).rgb * vec3(0.97, 0.99, 1.05);
  // WEATHER: overcast/storm haze colour (identical grade in the sky dome so the horizon seam vanishes)
  c = mix(c, uGreyCol * (1.12 + 0.3 * (1.0 - d.y)), uGrey);
  c += vec3(0.55, 0.65, 1.0) * uLightning * 0.45 * (0.3 + uGrey);
  return c;
}
float aerialAmount(vec3 wpos, out vec3 rd, out float dist) {
  vec3 v = wpos - cameraPosition;
  dist = length(v);
  rd = v / max(dist, 1e-3);
  float b = uFogFalloff;
  float ry = rd.y;
  ry = abs(ry) < 1e-4 ? 1e-4 : ry;
  float f = uFogDensity * exp(-(cameraPosition.y - uFogBase) * b) * (1.0 - exp(-dist * ry * b)) / (ry * b);
  return 1.0 - exp(-max(f, 0.0));
}
vec3 applyAerial(vec3 col, vec3 wpos) {
  vec3 rd; float dist;
  float t = aerialAmount(wpos, rd, dist);
  vec3 fc = skyLUT(rd);
  // keep the near-sun inscatter from veiling nearby objects (LUT is very bright there)
  float fl = dot(fc, vec3(0.2126, 0.7152, 0.0722));
  fc *= min(1.0, 1.3 / max(fl, 1e-4));
  // slight blue extinction tint of mid-distance before full haze
  col *= mix(vec3(1.0), vec3(0.86, 0.93, 1.06), clamp(t * 1.6, 0.0, 1.0));
  return mix(col, fc, t);
}
`;

// Screen-door fade for things that get too close to the camera or sit between camera and rider
export const OCC_GLSL = /* glsl */`
uniform vec3 uRiderPos;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float occFade(vec3 w) {
  vec3 v = w - cameraPosition;
  float a = smoothstep(2.5, 8.0, length(v));
  vec3 cr = uRiderPos + vec3(0.0, 1.0, 0.0) - cameraPosition;
  float L = length(cr);
  vec3 d = cr / max(L, 1e-3);
  float t = dot(v, d);
  if (t > 0.0 && t < L - 1.2) a = min(a, smoothstep(0.7, 1.8, length(v - d * t)));
  return a;
}
`;

// Shared grid helpers (terrain textures)
export const GRID_GLSL = /* glsl */`
uniform vec2 uGridOrigin;
uniform vec2 uGridSize;
uniform float uGridRes;
uniform sampler2D uShadowBake;
uniform vec2 uBakeFade;
vec2 gridUV(vec2 xz) { return ((xz - uGridOrigin) / uGridRes + 0.5) / uGridSize; }
// x: terrain self-shadow (always), y: objects shadow (only beyond realtime cascades)
float bakedSun(vec3 wpos) {
  vec2 s = texture2D(uShadowBake, gridUV(wpos.xz)).rg;
  float d = distance(wpos, cameraPosition);
  float far = smoothstep(uBakeFade.x, uBakeFade.y, d);
  return s.r * mix(1.0, s.g, far);
}
`;

const AERIAL_VARYING = 'varying vec3 vAerialWorld;\n';

/**
 * Patch a built-in (Standard/Lambert/Physical) material:
 * - adds shared uniforms + aerial perspective fog replacing <fog_fragment>
 * - opts.uniforms: extra uniforms
 * - opts.vertexPars / fragmentPars: GLSL prepended after <common>
 * - opts.vertex: { chunkName: replacementCode } (use '$' to refer to original include)
 * - opts.fragment: same for fragment shader
 */
export function patchMaterial(mat, opts = {}) {
  const key = opts.key || mat.type;
  mat.customProgramCacheKey = () => 'hb-' + key;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U, opts.uniforms || {});
    let vs = shader.vertexShader, fs = shader.fragmentShader;
    vs = vs.replace('#include <common>', '#include <common>\n' + AERIAL_VARYING + (opts.vertexPars || ''));
    fs = fs.replace('#include <common>', '#include <common>\n' + AERIAL_VARYING + AERIAL_GLSL + (opts.fragmentPars || ''));
    for (const [k, v] of Object.entries(opts.vertex || {})) {
      const inc = `#include <${k}>`;
      if (!vs.includes(inc)) console.warn('patch: missing vertex chunk', k);
      vs = vs.replace(inc, v.replace('$', inc));
    }
    vs = vs.replace('#include <project_vertex>', `#include <project_vertex>
      {
        vec4 aw = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          aw = instanceMatrix * aw;
        #endif
        vAerialWorld = (modelMatrix * aw).xyz;
      }`);
    for (const [k, v] of Object.entries(opts.fragment || {})) {
      const inc = `#include <${k}>`;
      if (!fs.includes(inc)) console.warn('patch: missing fragment chunk', k);
      fs = fs.replace(inc, v.replace('$', inc));
    }
    fs = fs.replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyAerial(gl_FragColor.rgb, vAerialWorld);');
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
    if (opts.onShader) opts.onShader(shader);
  };
  return mat;
}

// Tileable multi-octave value noise texture, RGBA8 256^2:
// R = low freq fbm (period 4 cells), G = mid (8), B = high (32), A = very fine (64)
export function makeNoiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  const lattice = (p, seed) => {
    const g = new Float32Array(p * p);
    let s = seed;
    for (let i = 0; i < g.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; g[i] = s / 4294967296; }
    return g;
  };
  const sampleNoise = (g, p, x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    let fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % p) + p) % p, y0 = ((yi % p) + p) % p, x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
    const a = g[y0 * p + x0], b = g[y0 * p + x1], c = g[y1 * p + x0], d = g[y1 * p + x1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  const fbm = (base, oct, seed) => {
    const layers = [];
    for (let o = 0; o < oct; o++) { const p = base << o; layers.push([lattice(p, seed + o * 977), p]); }
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let v = 0, a = 0.5, tot = 0;
      for (const [g, p] of layers) { v += a * sampleNoise(g, p, x * p / size, y * p / size); tot += a; a *= 0.5; }
      out[y * size + x] = v / tot;
    }
    // normalise contrast
    let mn = 1, mx = 0;
    for (const v of out) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
    for (let i = 0; i < out.length; i++) out[i] = (out[i] - mn) / (mx - mn);
    return out;
  };
  const ch = [fbm(4, 5, 11), fbm(8, 4, 23), fbm(32, 3, 37), fbm(64, 2, 51)];
  for (let i = 0; i < size * size; i++) for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.round(ch[c][i] * 255);
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

// ---------------------------------------------------------------------------------------------
// WEATHER: wet-surface GLSL (roads / pavements / terrain). Append AFTER the host material's own
// fragment pars (it needs `uniform sampler2D uNoise;` and AERIAL_GLSL's skyLUT()). Usage:
//   after computing albedo/roughness/bump:   hbApplyWet(w, alb, rough, bump, edge01, porosity, puddleAmount);
//   normal_fragment_begin (world normal Nw): Nw = hbWetNormal(Nw);
//   emissivemap_fragment:                     totalEmissiveRadiance += hbWetRefl(w, Nw);
// All of it is a no-op while uWet == 0.
// ---------------------------------------------------------------------------------------------
export const WET_GLSL = /* glsl */`
uniform float uWet;
uniform float uRain;
uniform float uWxTime;
float hbPud = 0.0; float hbWetAmt = 0.0; vec2 hbRip = vec2(0.0);
float hbHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hbRingLayer(vec2 p, float cs, float seed) {
  vec2 q = p / cs; vec2 id = floor(q); vec2 f = fract(q) - 0.5;
  float h1 = hbHash(id + seed), h2 = hbHash(id * 1.7 + seed + 3.1);
  float t = uWxTime * (0.8 + 0.6 * h2) + h1;
  float cyc = floor(t), ph = t - cyc;
  float act = step(hbHash(id + cyc * 7.3 + seed), uRain);
  vec2 off = (vec2(hbHash(id + cyc + 1.7), hbHash(id + cyc + 5.3)) - 0.5) * 0.3;
  vec2 d = (f - off) * cs; float r = length(d);
  float x = r - ph * cs * 0.34;
  float amp = (1.0 - ph) * (1.0 - ph) * act;
  float g = cos(x * 60.0) * exp(-x * x * 700.0) * amp * 0.5;
  return d / max(r, 1e-3) * g;
}
float hbPuddle(vec3 w, float edge) {
  float a = texture2D(uNoise, w.xz / 37.0).r;
  float b = texture2D(uNoise, w.xz / 11.0).g;
  float c = texture2D(uNoise, w.xz / 3.3).b;
  float n = a * 0.5 + b * 0.38 + c * 0.12 + edge * 0.10;
  float thr = mix(1.2, 0.585, smoothstep(0.25, 0.95, uWet));
  return smoothstep(thr, thr + 0.035, n);
}
void hbApplyWet(vec3 w, inout vec3 alb, inout float rough, inout float bump, float edge, float por, float pudAmt) {
  hbPud = 0.0; hbWetAmt = 0.0; hbRip = vec2(0.0);
  if (uWet < 0.005) return;
  float d = uWet * por;
  float near = 1.0 - smoothstep(25.0, 110.0, distance(w, cameraPosition));
  hbPud = hbPuddle(w, edge) * pudAmt * smoothstep(0.3, 0.8, uWet);
  hbWetAmt = d * (1.0 - hbPud);
  alb *= mix(1.0, 0.56, d);
  rough = mix(rough, 0.2, d * 0.8);
  alb = mix(alb, alb * 0.62, hbPud);
  rough = mix(rough, 0.03, hbPud);
  bump *= 1.0 - 0.85 * hbPud;
  if (uRain > 0.01 && near > 0.0) {
    vec2 g = hbRingLayer(w.xz, 0.5, 1.0) + hbRingLayer(w.xz + 7.7, 0.85, 5.0);
    hbRip = g * near * (hbPud + 0.25 * hbWetAmt);
  }
}
vec3 hbWetNormal(vec3 Nw) { return normalize(Nw + vec3(hbRip.x, 0.0, hbRip.y) + vec3(0.0, 0.0, 0.0)); }
vec3 hbWetRefl(vec3 w, vec3 Nw) {
  if (uWet < 0.005) return vec3(0.0);
  vec3 rd = normalize(w - cameraPosition);
  float c = clamp(dot(-rd, Nw), 0.0, 1.0);
  float f = pow(1.0 - c, 4.0);
  vec3 sky = skyLUT(reflect(rd, Nw));
  return sky * (hbPud * (0.08 + 0.45 * f) + hbWetAmt * 0.32 * f);
}
`;
