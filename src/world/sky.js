import * as THREE from 'three';
import { U } from './shared.js';
import { detectTier } from '../render/quality.js';

// Bright, clean, sunny afternoon: sun fairly high in the WSW, deep-blue sky with soft cumulus.
export const SUN_AZIMUTH_DEG = 244; // clockwise from north
export const SUN_ELEVATION_DEG = 33;

// ---------------------------------------------------------------------------------------------
// Artistic (not Preetham) sky: gradient + warm sun glow + lit/shaded 2D cumulus layer.
// One shader serves three uses:
//   dome   : visible background (clouds + sun disc), depth-tested at far plane so only sky pixels shade
//   lut    : equirect 256x128 (no clouds / disc) -> aerial-perspective fog colour + ambient estimate
//   env    : same LUT with desaturated sky + bright green-ish ground bounce -> PMREM for PBR reflections
// ---------------------------------------------------------------------------------------------
const SKY_COMMON = /* glsl */`
uniform vec3 uSun;
uniform float uScale;
uniform float uTime;
uniform float uSunDisc;
uniform vec3 uGround;
uniform float uDesat;
uniform vec3 uZenith;
uniform vec3 uHorizon;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  const mat2 R = mat2(0.80, 0.60, -0.60, 0.80);
  float a = 0.5, s = 0.0;
  for (int i = 0; i < CLOUD_OCT; i++) { s += a * vnoise(p); p = R * p * 2.03 + 11.7; a *= 0.5; }
  return s;
}

// clear-sky radiance (linear, pre-exposure)
vec3 skyBase(vec3 d, out float hz) {
  float y = max(d.y, 0.0);
  hz = 1.0 - pow(y, 0.5);                       // 1 at horizon -> 0 high up
  vec3 col = mix(uHorizon, uZenith, pow(y, 0.52));
  float mu = max(dot(d, uSun), 0.0);
  // forward-scatter glow around the sun, warm; horizon band warms toward the sun side
  vec3 warm = vec3(1.0, 0.80, 0.52);
  col = mix(col, col * vec3(1.12, 0.98, 0.80) + warm * 0.10, pow(mu, 2.5) * hz);
  col += warm * (pow(mu, 8.0) * 0.20 + pow(mu, 60.0) * 0.55 + pow(mu, 700.0) * 2.5);
  return col;
}

vec3 skyColor(vec3 d) {
  float hz;
  vec3 col = skyBase(d, hz) * uScale;
  float sl = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(sl), uDesat);
  return col;
}
`;

const SKY_VS = /* glsl */`
varying vec3 vDir;
#ifdef LUT
varying vec2 vLutUv;
#endif
void main() {
#ifdef LUT
  vLutUv = uv;
  float phi = (uv.x - 0.5) * 6.2831853, th = (uv.y - 0.5) * 3.14159265;
  vDir = vec3(cos(th) * cos(phi), sin(th), cos(th) * sin(phi));
  gl_Position = vec4(position.xy, 0.0, 1.0);
#else
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w;   // far plane: depth test then only shades uncovered (sky) pixels
#endif
}`;

const SKY_FS = /* glsl */`
varying vec3 vDir;
${SKY_COMMON}
uniform vec2 uWind;
uniform float uCover;

void main() {
  vec3 d = normalize(vDir);
  vec3 col;
#ifdef LUT
  col = skyColor(d);
  col = mix(col, uGround, smoothstep(0.0, -0.25, d.y));
#else
  float hz;
  col = skyBase(d, hz) * uScale;
  float mu = dot(d, uSun);

  // sun disc (HDR, drives bloom + light shafts) with a soft limb
  col += vec3(1.0, 0.93, 0.80) * 45.0 * smoothstep(0.99972, 0.99986, mu) * uSunDisc;

  // ---- cumulus layer: noise on a plane, lit from the sun side, blue-grey bellies
  if (d.y > 0.0) {
    float y = d.y;
    vec2 p = d.xz / (y * 0.9 + 0.24);
    p = p * 0.62 + uWind * uTime;
    // billow warp
    p += 0.35 * vec2(vnoise(p * 1.6), vnoise(p * 1.6 + 7.3)) - 0.17;
    float n = fbm(p);
    float th = 1.0 - uCover;
    float dens = smoothstep(th, th + 0.15, n);
    float fade = smoothstep(0.015, 0.20, y);        // dissolve into horizon haze
    float a = dens * fade;
    if (a > 0.003) {
      // light: compare density a step toward the sun with density here -> shadowed bellies
      vec2 sdir = normalize(uSun.xz + 1e-4) ;
      float lit;
#ifdef CLOUD_LIT
      float n2 = fbm(p + sdir * 0.07);
      lit = clamp(0.62 + (n - n2) * 5.5, 0.0, 1.0);
#else
      lit = clamp(0.35 + 0.65 * smoothstep(th, th + 0.5, n), 0.0, 1.0);
#endif
      float core = smoothstep(th + 0.05, th + 0.35, n);
      vec3 shade = vec3(0.60, 0.70, 0.90);
      vec3 sunl = vec3(1.28, 1.20, 1.08);
      vec3 cc = mix(shade, sunl, lit * (0.55 + 0.45 * (1.0 - core * 0.5)));
      // silver rim toward the sun
      float rim = pow(max(mu, 0.0), 6.0) * (1.0 - core) * 0.9;
      cc += vec3(1.0, 0.9, 0.7) * rim;
      cc = mix(cc, mix(uHorizon, cc, 0.35), (1.0 - smoothstep(0.0, 0.35, y)) * 0.6); // aerial haze on distant clouds
      col = mix(col, cc * uScale, clamp(a * 1.15, 0.0, 1.0));
    }
  }
#endif
  gl_FragColor = vec4(min(col, vec3(60.0)), 1.0);
}`;

function skyMaterial({ lut, cloudOct, cloudLit }) {
  return new THREE.ShaderMaterial({
    name: lut ? 'SkyLUT' : 'SkyDome',
    defines: { CLOUD_OCT: cloudOct, ...(lut ? { LUT: 1 } : {}), ...(cloudLit ? { CLOUD_LIT: 1 } : {}) },
    uniforms: {
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uScale: { value: 1 },
      uTime: { value: 0 },
      uSunDisc: { value: 1 },
      uGround: { value: new THREE.Color(0.06, 0.07, 0.045) },
      uDesat: { value: 0 },
      uZenith: { value: new THREE.Color(0.08, 0.25, 0.76) },
      uHorizon: { value: new THREE.Color(0.42, 0.66, 1.0) },
      uWind: { value: new THREE.Vector2(0.004, 0.0012) },
      uCover: { value: 0.55 },
    },
    vertexShader: SKY_VS, fragmentShader: SKY_FS,
    side: lut ? THREE.FrontSide : THREE.BackSide,
    depthWrite: false, depthTest: !lut, depthFunc: THREE.LessEqualDepth, toneMapped: false,
  });
}

export function sunDirection() {
  const az = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG), el = THREE.MathUtils.degToRad(SUN_ELEVATION_DEG);
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)).normalize();
}

export function createSky(renderer) {
  const sunDir = sunDirection();
  U.uSunDir.value.copy(sunDir);
  const cfg = detectTier();
  const low = cfg.tier === 'low';

  // Aerial perspective: keep the foreground crisp and let haze build only with distance.
  U.uFogDensity.value = 0.000085;

  // visible dome. Drawn AFTER opaque geometry (renderOrder 1000) with depth test at the far plane,
  // so the (relatively expensive) cloud shader only runs on pixels that show sky.
  const dome = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), skyMaterial({ lut: false, cloudOct: low ? 3 : 5, cloudLit: !low }));
  dome.scale.setScalar(5000);
  dome.frustumCulled = false;
  dome.renderOrder = 1000;
  const du = dome.material.uniforms;
  du.uSun.value.copy(sunDir);

  // LUT: equirect 256x128 HDR, no sun disc, no clouds -> fog colour + environment
  const lutRT = new THREE.WebGLRenderTarget(256, 128, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
    magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false,
  });
  lutRT.texture.mapping = THREE.EquirectangularReflectionMapping;
  lutRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
  const lutMat = skyMaterial({ lut: true, cloudOct: 3, cloudLit: false });
  const lu = lutMat.uniforms;
  lu.uSun.value.copy(sunDir);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), lutMat);
  quad.frustumCulled = false;
  const sc = new THREE.Scene(); sc.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  renderer.setRenderTarget(lutRT);
  renderer.render(sc, cam);
  renderer.setRenderTarget(null);
  U.uSkyLUT.value = lutRT.texture;

  // ambient estimate: cosine-weighted upper hemisphere, pulled toward neutral so shadows stay
  // blue-ish but not neon, with a touch of green ground bounce.
  const px = new Uint16Array(256 * 128 * 4);
  U.uSkyAmb.value.setRGB(0.36, 0.50, 0.78);
  try {
    renderer.readRenderTargetPixels(lutRT, 0, 0, 256, 128, px);
    const f = THREE.DataUtils.fromHalfFloat;
    let r = 0, g = 0, b = 0, w = 0;
    for (let y = 64; y < 128; y++) {
      const th = ((y + 0.5) / 128 - 0.5) * Math.PI, wt = Math.sin(th) * Math.cos(th);
      for (let x = 0; x < 256; x += 8) {
        const k = (y * 256 + x) * 4; r += wt * f(px[k]); g += wt * f(px[k + 1]); b += wt * f(px[k + 2]); w += wt;
      }
    }
    const a = new THREE.Color(r / w, g / w, b / w);
    const l = a.r * 0.2126 + a.g * 0.7152 + a.b * 0.0722;
    a.lerp(new THREE.Color(l, l, l), 0.25).lerp(new THREE.Color(0.30, 0.40, 0.22), 0.12).multiplyScalar(1.5);
    U.uSkyAmb.value.copy(a);
  } catch (e) { /* not fatal */ }

  // environment for PBR IBL: bright, softly desaturated sky + grassy ground bounce so shadowed
  // faces pick up blue from above and warm green from below
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envLut = lutRT.clone();
  lu.uDesat.value = 0.30; lu.uGround.value.setRGB(0.24, 0.27, 0.15); lu.uScale.value = 2.3;
  renderer.setRenderTarget(envLut); renderer.render(sc, cam); renderer.setRenderTarget(null);
  const envRT = pmrem.fromEquirectangular(envLut.texture);
  pmrem.dispose();
  envLut.dispose();

  // Sun colour: warm but clean (high-ish sun, little reddening)
  const sunCol = new THREE.Color().setRGB(1.0, 0.89, 0.72);
  U.uSunColor.value.copy(sunCol);

  return {
    dome, sunDir, sunColor: sunCol, envMap: envRT.texture, lut: lutRT.texture,
    update(t, camPos) { du.uTime.value = t; dome.position.copy(camPos); },
  };
}
