import { U } from './shared.js';

// Sky-dome weather overlay (used by world/sky.js). Reads shared weather uniforms; with
// uGrey = uOver = uLightning = 0 and uSunVis = 1 it returns the colour unchanged.
// Needs vnoise()/fbm() and uSun/uTime/uWind from the sky shader's common block.
export const WX_SKY_UNIFORMS = /* glsl */`
uniform float uGrey;
uniform vec3 uGreyCol;
uniform float uOver;
uniform float uOverDark;
uniform float uLightning;
uniform vec3 uLightDir;
uniform float uSunVis;
uniform float uWxTime;
uniform float uStorm;
`;

export const WX_SKY_GLSL = /* glsl */`
vec3 wxSky(vec3 d, vec3 col) {
  float y = d.y;
  float yy = max(y, 0.0);
  // 1) flatten the clear sky toward the overcast haze colour (same grade as the fog LUT)
  col = mix(col, uGreyCol * (1.12 + 0.3 * (1.0 - yy)), uGrey);
  float cover = 0.0;
  if (uOver > 0.003 && y > -0.03) {
    // 2) layered overcast sheet: two drifting noise layers, thick bases darker, thin patches lighter
    vec2 p = d.xz / (yy * 0.85 + 0.22);
    float k = uWxTime * (0.010 + 0.030 * uStorm);
    vec2 q1 = p * 0.85 + vec2(k, k * 0.35) + 4.0;
    vec2 q2 = p * 2.1 + vec2(k * 2.2, k * 0.6) + 17.0;
    q1 += 0.35 * vec2(vnoise(q1 * 1.3), vnoise(q1 * 1.3 + 5.1)) - 0.17;
    float n1 = fbm(q1), n2 = fbm(q2);
    float tex = n1 * 0.62 + n2 * 0.38;
    float thick = smoothstep(0.30, 0.70, tex);
    vec3 lightC = uGreyCol * mix(1.30, 1.05, uOverDark);
    vec3 darkC = uGreyCol * mix(0.62, 0.28, uOverDark);
    vec3 cc = mix(lightC, darkC, thick);
    // ragged luminous gaps / lit undersides in the lighter parts (stops it looking like a flat grey lid)
    cc += uGreyCol * 0.22 * smoothstep(0.55, 0.20, tex) * (1.0 - uOverDark * 0.7);
    // distance: sheet melts into the fog colour near the horizon so there is no seam
    float hzf = 1.0 - smoothstep(0.0, 0.34, yy);
    cc = mix(cc, uGreyCol * (1.12 + 0.3 * (1.0 - yy)), hzf * 0.85);
    float thr = mix(1.0, -0.25, uOver);
    cover = smoothstep(thr, thr + 0.22, tex) * smoothstep(-0.03, 0.04, y);
    col = mix(col, cc, cover);
  }
  // 3) lightning: whole-sky flash, brighter inside the cloud near the strike
  float flash = uLightning;
  if (flash > 0.001) {
    float near = pow(max(dot(d, uLightDir), 0.0), 4.0);
    col += vec3(0.55, 0.66, 1.0) * flash * (0.35 + 1.9 * near) * (0.35 + 0.65 * max(cover, uGrey));
  }
  return col;
}
`;

export const WX_SKY_UNIFORM_OBJECTS = {
  uGrey: U.uGrey, uGreyCol: U.uGreyCol, uOver: U.uOver, uOverDark: U.uOverDark, uLightning: U.uLightning,
  uLightDir: U.uLightDir, uSunVis: U.uSunVis, uWxTime: U.uWxTime, uStorm: U.uStorm,
};
