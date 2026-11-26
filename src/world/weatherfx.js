import * as THREE from 'three';
import { Effect } from 'postprocessing';

// ---------------------------------------------------------------------------------------------
// Screen-space "rain on the camera lens" for the post-processing composer.
//   - lensState is written by world/weather.js each frame (amount 0..1, time in seconds).
//   - The effect refracts the image through procedural water drops (mainUv, so it merges into the
//     existing EffectPass: ZERO extra passes, ZERO extra texture taps for the refraction), adds a
//     small specular glint and edge darkening in mainImage.
//   - Two drop layers: tiny static beads that fade in/out, and bigger drops that slide down with a
//     wiggle and leave a trail. `lite` = single layer (used on medium); the effect is not created
//     at all on the low tier (see render/post.js).
// ---------------------------------------------------------------------------------------------
export const lensState = { amount: 0, time: 0 };

export class LensDropsEffect extends Effect {
  constructor(lite = false) {
    super('LensDropsEffect', /* glsl */`
      uniform float uAmt;
      uniform float uT;
      float wxSS(float a, float b, float x) { float d = b - a; d = abs(d) < 1e-4 ? (d < 0.0 ? -1e-4 : 1e-4) : d; float t = clamp((x - a) / d, 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
      float wxDrop; vec2 wxDropN;
      vec3 wxN13(float p) {
        vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.11369, 0.13787));
        p3 += dot(p3, p3.yzx + 19.19);
        return fract(vec3((p3.x + p3.y) * p3.z, (p3.x + p3.z) * p3.y, (p3.y + p3.z) * p3.x));
      }
      float wxSaw(float b, float t) { return wxSS(0.0, b, t) * wxSS(1.0, b, t); }
      // static beads: pop in, linger, shrink away
      float wxBeads(vec2 uv, float t, float amt) {
        uv *= 34.0;
        vec2 id = floor(uv); vec2 f = fract(uv) - 0.5;
        vec3 n = wxN13(id.x * 107.45 + id.y * 3543.654);
        vec2 p = (n.xy - 0.5) * 0.7;
        float d = length(f - p);
        float fade = wxSaw(0.025, fract(t * 0.07 + n.z));
        float on = step(n.z * 0.9 + 0.05, amt);
        return wxSS(0.30, 0.0, d) * fract(n.z * 10.0) * fade * on;
      }
      // sliding drops with trails (BigWings-style grid, simplified)
      vec2 wxSlide(vec2 uv, float t, float amt) {
        vec2 UV = uv;
        uv.y += t * 0.75;
        vec2 a = vec2(6.0, 1.0);
        vec2 grid = a * 2.0;
        vec2 id = floor(uv * grid);
        float colShift = fract(sin(id.x * 17.3) * 43758.5);
        uv.y += colShift;
        id = floor(uv * grid);
        vec3 n = wxN13(id.x * 35.2 + id.y * 2376.1);
        vec2 st = fract(uv * grid) - vec2(0.5, 0.0);
        float x = n.x - 0.5;
        float y = UV.y * 20.0;
        float wiggle = sin(y + sin(y));
        x += wiggle * (0.5 - abs(x)) * (n.z - 0.5);
        x *= 0.7;
        float ti = fract(t * 0.5 + n.z);
        y = (wxSaw(0.85, ti) - 0.5) * 0.9 + 0.5;
        vec2 p = vec2(x, y);
        float d = length((st - p) * a.yx);
        float md = wxSS(0.4, 0.0, d);
        float r = sqrt(wxSS(1.0, y, st.y));
        float cd = abs(st.x - x);
        float trail = wxSS(0.23 * r, 0.15 * r * r, cd);
        float trailFront = wxSS(-0.02, 0.02, st.y - y);
        trail *= trailFront * r * r;
        float droplets = 0.0;
        float on = step(n.y * 0.9 + 0.05, amt);
        return vec2(md + droplets, trail * 0.6) * on;
      }
      // combined drop height field (smooth: evaluated 3x for finite-difference normals, no 2x2 derivative blockiness)
      vec2 wxH(vec2 p) {
        float m = wxBeads(p * 0.55, uT, uAmt);
        float trail = 0.0;
        #ifndef LENS_LITE
        vec2 s = wxSlide(p * 0.9, uT, uAmt);
        m = max(m, s.x);
        trail = s.y;
        #endif
        return vec2(m, trail);
      }
      void mainUv(inout vec2 uv) {
        wxDrop = 0.0; wxDropN = vec2(0.0);
        if (uAmt < 0.01) return;
        float asp = resolution.x / resolution.y;
        vec2 p = (uv - 0.5) * vec2(asp, 1.0);
        float e = 1.5 * texelSize.y;
        vec2 h0 = wxH(p), hx = wxH(p + vec2(e, 0.0)), hy = wxH(p + vec2(0.0, e));
        float f0 = h0.x + h0.y * 0.25, fx = hx.x + hx.y * 0.25, fy = hy.x + hy.y * 0.25;
        vec2 n = vec2(fx - f0, fy - f0) / e;
        if (any(isnan(n)) || any(isinf(n))) n = vec2(0.0);
        float inDrop = wxSS(0.05, 0.45, h0.x);
        wxDrop = max(h0.x, h0.y * 0.3); wxDropN = n * 0.004;
        // refraction: bend toward the drop centre; magnified inverted view inside the drop body
        vec2 off = n * 0.0011;
        float l = length(off); if (l > 0.035) off *= 0.035 / l;
        uv += off / vec2(asp, 1.0) * vec2(asp, 1.0);
      }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = inputColor.rgb;
        if (wxDrop > 0.0) {
          float m = wxSS(0.02, 0.5, wxDrop);
          // slight darkening of the rim, bright glint on the upper-left of each drop
          float rim = clamp(length(wxDropN) * 0.9, 0.0, 1.0) * clamp(-wxDropN.y * 40.0, 0.0, 1.0);
          float glint = clamp(dot(normalize(wxDropN + 1e-6), vec2(-0.6, 0.8)), 0.0, 1.0) * rim;
          c = mix(c, c * 0.9, rim * m * 0.3);
          c += vec3(0.9, 0.95, 1.0) * glint * glint * glint * m * 0.35;
        }
        if (any(isnan(c))) c = inputColor.rgb;
        outputColor = vec4(c, inputColor.a);
      }`, {
      defines: new Map(lite ? [['LENS_LITE', '1']] : []),
      uniforms: new Map([
        ['uAmt', new THREE.Uniform(0)],
        ['uT', new THREE.Uniform(0)],
      ]),
    });
  }
  update() {
    this.uniforms.get('uAmt').value = lensState.amount;
    this.uniforms.get('uT').value = lensState.time;
  }
}

export function createLensDrops(cfg) {
  if (cfg.tier === 'low') return null;
  return new LensDropsEffect(cfg.tier === 'medium');
}
