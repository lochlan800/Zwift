import * as THREE from 'three';
import { SegmentIndex, splitByCell } from './heightfield.js';
import { patchMaterial, GRID_GLSL, WET_GLSL } from './shared.js';

// type codes used by the road shader
export const RT = { MAJOR: 0, MAJOR_DASH: 1, MINOR: 2, SERVICE: 3, TRACK: 4, FOOT: 5, PATH: 6, PAVE: 7, KERB: 8, BALLAST: 9, RAIL: 10, PARAPET: 11, CYCLE: 12, TOWN: 13 };

const KIND = {
  primary: { t: RT.MAJOR, w: 7.3, lift: 0.07, pave: true },
  secondary: { t: RT.MAJOR, w: 7.0, lift: 0.07, pave: true },
  tertiary: { t: RT.MAJOR_DASH, w: 6.5, lift: 0.065, pave: true },
  unclassified: { t: RT.MAJOR_DASH, w: 5.5, lift: 0.06, pave: false },
  residential: { t: RT.MINOR, w: 5.5, lift: 0.06, pave: true },
  service: { t: RT.SERVICE, w: 3.5, lift: 0.055, pave: false },
  track: { t: RT.TRACK, w: 3.0, lift: 0.04, pave: false },
  footway: { t: RT.FOOT, w: 2.0, lift: 0.045, pave: false },
  cycleway: { t: RT.CYCLE, w: 2.5, lift: 0.045, pave: false },
  path: { t: RT.PATH, w: 1.6, lift: 0.035, pave: false },
};
const URBAN = new Set([3, 5, 10, 6, 8, 9]);
const RANK = { primary: 5, secondary: 4, tertiary: 3, unclassified: 2, residential: 1, service: 0.5 };

export function roadInfo(r) { return KIND[r.k] || null; }
export function roadWidth(r) { const K = KIND[r.k]; return Math.max(1.2, r.w || (K ? K.w : 4)); }

function lcAt(hf, lc, x, z) {
  const i = Math.round((x - hf.x0) / hf.res), j = Math.round((z - hf.z0) / hf.res);
  if (i < 0 || j < 0 || i >= hf.cols || j >= hf.rows) return 0;
  return lc[j * hf.cols + i];
}

// Decide pavements per road (urban + suitable kind)
export function annotateRoads(features, hf, lc) {
  for (const r of features.roads) {
    const K = KIND[r.k];
    r._w = roadWidth(r);
    r._pave = 0;
    if (!K || r.tu) continue;
    if (K.pave) {
      let urban = 0;
      for (let i = 0; i < r.p.length; i += 3) if (URBAN.has(lcAt(hf, lc, r.p[i][0], r.p[i][2]))) urban++;
      if (urban / Math.ceil(r.p.length / 3) > 0.4) r._pave = r.k === 'residential' ? 1.8 : 2.0;
    }
  }
}

export function buildRoadIndex(features) {
  const idx = new SegmentIndex(24);
  for (const r of features.roads) {
    if (r.tu || !KIND[r.k]) continue;
    const hw = r._w / 2 + (r._pave || 0) + (r._verge || 0);
    for (let i = 0; i + 1 < r.p.length; i++) {
      const a = r.p[i], b = r.p[i + 1];
      idx.add(a[0], a[1], a[2], b[0], b[1], b[2], hw, r);
    }
  }
  return idx;
}

// Carve/raise terrain so it sits just below every road (no poke-through).
export function conformTerrain(hf, features) {
  const { cols, rows, res } = hf;
  const n = cols * rows;
  const target = new Float32Array(n);
  const weight = new Float32Array(n); // 0 = untouched, 1 = fully set to target
  const consider = (ax, ay, az, bx, by, bz, core, blend, dy = -0.18) => {
    const R = core + blend;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - R - hf.x0) / res)), i1 = Math.min(cols - 1, Math.ceil((Math.max(ax, bx) + R - hf.x0) / res));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - R - hf.z0) / res)), j1 = Math.min(rows - 1, Math.ceil((Math.max(az, bz) + R - hf.z0) / res));
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = hf.x0 + i * res, z = hf.z0 + j * res;
      let t = L2 > 0 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + dx * t - x, pz = az + dz * t - z;
      const d = Math.sqrt(px * px + pz * pz);
      if (d > R) continue;
      let w = d <= core ? 1 : 1 - (d - core) / blend;
      w = w * w * (3 - 2 * w);
      const k = j * cols + i;
      const y = ay + (by - ay) * t + dy;
      if (w > weight[k] + 1e-4 || (Math.abs(w - weight[k]) < 1e-4 && y < target[k])) { weight[k] = w; target[k] = y; }
    }
  };
  for (const r of features.roads) {
    if (r.tu || r.br || !KIND[r.k]) continue;
    const vg = r._verge || 0;
    const core = r._w / 2 + (r._pave || 0) + vg + 1.2;
    const blend = r._w > 4 ? 7 : 4;
    for (let i = 0; i + 1 < r.p.length; i++) {
      const a = r.p[i], b = r.p[i + 1];
      if (vg) {
        consider(a[0], a[1], a[2], b[0], b[1], b[2], r._w / 2 + 0.6, 0.5);
        consider(a[0], a[1], a[2], b[0], b[1], b[2], core, blend, 0.12);
      } else consider(a[0], a[1], a[2], b[0], b[1], b[2], core, blend);
    }
  }
  for (const r of features.rail || []) {
    if (r.br || r.tu) continue;
    for (let i = 0; i + 1 < r.p.length; i++) { const a = r.p[i], b = r.p[i + 1]; consider(a[0], a[1] - 0.15, a[2], b[0], b[1] - 0.15, b[2], 3.2, 5); }
  }
  const h = hf.h;
  for (let k = 0; k < n; k++) if (weight[k] > 0) h[k] = h[k] + (target[k] - h[k]) * weight[k];
  // bridges: never let the banks/DTM poke through the deck (lower only)
  for (const r of features.roads) {
    if (!r.br || r.tu || !KIND[r.k]) continue;
    const R = r._w / 2 + (r._pave || 0.3) + 1.5;
    for (let i = 0; i + 1 < r.p.length; i++) {
      const a = r.p[i], b = r.p[i + 1];
      const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - R - hf.x0) / res)), i1 = Math.min(cols - 1, Math.ceil((Math.max(a[0], b[0]) + R - hf.x0) / res));
      const j0 = Math.max(0, Math.floor((Math.min(a[2], b[2]) - R - hf.z0) / res)), j1 = Math.min(rows - 1, Math.ceil((Math.max(a[2], b[2]) + R - hf.z0) / res));
      const dx = b[0] - a[0], dz = b[2] - a[2], L2 = dx * dx + dz * dz || 1;
      for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) {
        const x = hf.x0 + ii * res, z = hf.z0 + j * res;
        let t = ((x - a[0]) * dx + (z - a[2]) * dz) / L2; t = Math.max(0, Math.min(1, t));
        if (Math.hypot(a[0] + dx * t - x, a[2] + dz * t - z) > R) continue;
        const y = a[1] + (b[1] - a[1]) * t - 1.2;
        const k = j * cols + ii;
        if (h[k] > y) h[k] = y;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------

class RibbonBuilder {
  constructor() { this.pos = []; this.nor = []; this.road = []; this.mark = []; this.idx = []; this.n = 0; this.gw = null; this.cross = null; }
  vert(x, y, z, nx, ny, nz, u, v, hw, t, m) {
    this.pos.push(x, y, z); this.nor.push(nx, ny, nz); this.road.push(u, v, hw, t);
    // give-way: signed distance from the stop line, lane side, active
    let gx = 1e4, side = 0, act = 0;
    const G = this.gw;
    if (this.cross != null) { gx = u - this.cross; act = 2; }
    else if (G) {
      // linear in u so interpolation across long ribbon quads stays exact
      const useStart = G.g0 >= 0 && (G.g1 < 0 || u < G.L * 0.5);
      if (useStart) { gx = u - G.g0; side = -1; act = 1; } else if (G.g1 >= 0) { gx = (G.L - u) - G.g1; side = 1; act = 1; }
    }
    this.mark.push(m, gx, side, act);
    return this.n++;
  }
  quad(a, b, c, d) { this.idx.push(a, c, b, b, c, d); } // a,b along left edge... see usage
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aRoad', new THREE.Float32BufferAttribute(this.road, 4));
    g.setAttribute('aMark', new THREE.Float32BufferAttribute(this.mark, 4));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

// per-point left-normal (miter averaged) and cumulative distance
function frames(p) {
  const n = p.length, L = new Float32Array(n), nx = new Float32Array(n), nz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[2] - a[2];
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    nx[i] = dz; nz[i] = -dx; // left of travel
    if (i > 0) L[i] = L[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][2] - p[i - 1][2]);
  }
  return { L, nx, nz };
}

/** Strip of constant offset range [o0,o1] (metres, +left) at height offset, flat-up normals */
function strip(B, p, F, o0, o1, dy, type, hw, markFn, keepFn) {
  let prev = null;
  for (let i = 0; i < p.length; i++) {
    const keep = keepFn ? keepFn(i) : true;
    if (!keep) { prev = null; continue; }
    const x = p[i][0], y = p[i][1] + dy, z = p[i][2];
    const m = markFn ? markFn(i) : 1;
    const a = B.vert(x + F.nx[i] * o0, y, z + F.nz[i] * o0, 0, 1, 0, F.L[i], o0, hw, type, m);
    const b = B.vert(x + F.nx[i] * o1, y, z + F.nz[i] * o1, 0, 1, 0, F.L[i], o1, hw, type, m);
    if (prev) {
      // prev.a, prev.b, a, b; o1 > o0 means b is to the left
      B.idx.push(prev[0], a, prev[1], prev[1], a, b);
    }
    prev = [a, b];
  }
}
/** vertical wall along offset o from y0 to y1 facing direction sign (+1 = faces left) */
function wall(B, p, F, o, y0, y1, face, type, hw, keepFn) {
  let prev = null;
  for (let i = 0; i < p.length; i++) {
    if (keepFn && !keepFn(i)) { prev = null; continue; }
    const x = p[i][0] + F.nx[i] * o, z = p[i][2] + F.nz[i] * o;
    const nx = F.nx[i] * face, nz = F.nz[i] * face;
    const a = B.vert(x, p[i][1] + y0, z, nx, 0, nz, F.L[i], y0, hw, type, 1);
    const b = B.vert(x, p[i][1] + y1, z, nx, 0, nz, F.L[i], y1, hw, type, 1);
    if (prev) {
      if (face > 0) B.idx.push(prev[0], prev[1], a, a, prev[1], b);
      else B.idx.push(prev[0], a, prev[1], prev[1], a, b);
    }
    prev = [a, b];
  }
}

const ROAD_FRAG = /* glsl */`
varying vec4 vRoad; varying float vMark; varying vec3 vGw;
uniform sampler2D uNoise;
vec3 rAlb; float rRough; float rBump;
vec3 lin3(vec3 c) { return pow(c, vec3(2.2)); }
float lineAA(float d, float w) { float fw = max(fwidth(d), 1e-3); return 1.0 - smoothstep(w - fw, w + fw, abs(d)); }
void roadSurface(vec3 w) {
  float u = vRoad.x, v = vRoad.y, hw = vRoad.z; int t = int(vRoad.w + 0.5);
  bool rural = t >= 20;
  if (rural) t -= 20;
  bool town = t == ${RT.TOWN};
  if (town) t = 1;
  bool xing = vGw.z > 1.5;
  float gxc = xing ? vGw.x : 1e4;
  vec4 n2 = texture2D(uNoise, w.xz / 23.0);
  vec4 n3 = texture2D(uNoise, w.xz / 3.1);
  vec4 n4 = texture2D(uNoise, w.xz / 1.9);
  float dist = distance(w, cameraPosition);
  vec4 n5 = texture2D(uNoise, w.xz / 0.37);
  float fa = 1.0 - smoothstep(8.0, 40.0, dist);
  // neutral warm-grey asphalt, fine aggregate
  vec3 asph = lin3(vec3(0.27, 0.268, 0.265)) * (1.0 + (n5.a - 0.5) * 0.28 * fa + (n4.b - 0.5) * 0.1) * (0.95 + 0.1 * n2.g);
  // fine cracks (thin dark lines from the noise iso-contours) and longitudinal tar-seal joints
  {
    float cn = texture2D(uNoise, w.xz / 4.7).g;
    float cw = fwidth(cn) * 1.2 + 1e-4;
    float crack = (1.0 - smoothstep(0.0, cw, abs(cn - 0.5))) * smoothstep(0.62, 0.8, n2.r) * fa * 0.6;
    float seal = (1.0 - smoothstep(0.0, 0.025 + fwidth(u), abs(fract(u / 47.0) - 0.5) * 47.0)) * 0.5 * fa;
    asph *= 1.0 - 0.4 * max(crack, seal);
  }
  // small rectangular patch repairs (low contrast)
  vec2 pc = floor(vec2(u / 3.5, (v + hw) / 2.2));
  float ph = fract(sin(dot(pc, vec2(12.9898, 78.233)) + floor(w.x * 0.003)) * 43758.5453);
  asph *= mix(1.0, ph > 0.5 ? 0.9 : 1.06, step(0.955, ph) * vMark);
  float tq = (abs(v) - hw * 0.5) / (hw * 0.16); float track = exp(-tq * tq);
  track *= vMark;
  asph *= 1.0 - 0.06 * track;
  asph *= mix(1.0, 0.9 + 0.1 * n3.b, smoothstep(hw - 0.5, hw, abs(v)) * vMark); // edge grime
  // oil drips / tar bleed along the lane centres
  float lq = (abs(v) - hw * 0.5) / 0.45; float lane = exp(-lq * lq) * vMark;
  float oil = smoothstep(0.72, 0.9, n3.r) * lane;
  asph *= 1.0 - 0.22 * oil;
  rAlb = asph; rRough = 0.9 - 0.06 * track - 0.25 * oil; rBump = n5.a * 0.5 + n4.a * 0.3;
  // gully grates at the kerb every ~32 m, manhole covers in the lane every ~73 m
  if (vRoad.w < 23.5 && vMark > 0.5 && hw > 2.0) {
    float gu = abs(fract(u / 32.0 + 0.37) - 0.5) * 32.0;
    vec2 gfw = vec2(fwidth(u), fwidth(v)) * 0.75 + 1e-4;
    float gx = 1.0 - smoothstep(0.32 - gfw.x, 0.32 + gfw.x, gu);
    float gy = (1.0 - smoothstep(0.5 - gfw.y, 0.5 + gfw.y, hw - abs(v))) * smoothstep(0.08 - gfw.y, 0.08 + gfw.y, hw - abs(v));
    float g = gx * gy;
    float bars = step(0.5, fract(gu / 0.05));
    rAlb = mix(rAlb, lin3(vec3(0.10, 0.10, 0.10)) * (0.4 + 0.6 * bars), g);
    rRough = mix(rRough, 0.55, g); rBump = mix(rBump, bars, g);
    float mu = abs(fract(u / 73.0 + 0.11) - 0.5) * 73.0;
    float md = length(vec2(mu, v - sign(v + 1e-3) * hw * 0.42));
    float m = 1.0 - smoothstep(0.33 - gfw.x, 0.33 + gfw.x, md);
    float ring = smoothstep(0.27, 0.29, md) * m;
    float pat = step(0.5, fract((mu + v) / 0.06));
    rAlb = mix(rAlb, lin3(vec3(0.16, 0.155, 0.15)) * (0.75 + 0.25 * pat) * (1.0 - 0.35 * ring), m);
    rRough = mix(rRough, 0.5, m); rBump = mix(rBump, pat, m);
  }
  if (t <= 3) {
    float paint = 0.0;
    float m = vMark;
    if (t <= 1 && abs(gxc) > 14.0) {
      float dash = step(fract(u / 9.0), t == 0 ? 0.5 : 0.33);
      paint = max(paint, lineAA(v, 0.06) * dash * m);
    }
    if (xing) {
      float ax = abs(gxc);
      // zebra bars (parallel to traffic), give-way dashes, zig-zags on approach
      float bars = step(ax, 1.5) * step(0.5, fract((v + hw) / 1.0)) * step(abs(v), hw - 0.1);
      float gwl = (1.0 - smoothstep(0.0, 0.03, abs(ax - 2.5) - 0.1)) * step(fract(v / 0.9), 0.55) * step(abs(v), hw - 0.15);
      float zz = 0.0;
      if (ax > 3.0 && ax < 14.0) {
        // sharp zig-zags: triangle wave, thickness measured perpendicular to each leg
        float P = 1.9, A = 0.32;
        float ph = fract((ax - 3.0) / P);
        float tri = abs(ph - 0.5) * 2.0;             // 1 -> 0 -> 1
        float slope = 4.0 * A / P;
        float k = 1.0 / sqrt(1.0 + slope * slope);
        float dK = abs(abs(v) - (hw - 0.3 - A * tri)) * k;     // kerb-side zig-zag
        float dC = abs(v - (A * (tri - 0.5) * 2.0)) * k;      // centre zig-zag
        float fwz = fwidth(v) * 0.7 + 0.01;
        zz = max(1.0 - smoothstep(0.05 - fwz, 0.05 + fwz, dK), 1.0 - smoothstep(0.05 - fwz, 0.05 + fwz, dC));
      }
      paint = max(paint, max(bars, max(gwl, zz)));
    }
    if (t == 0 && !town) paint = max(paint, lineAA(abs(v) - (hw - 0.35), 0.05) * m);
    // give-way: double broken transverse line across the approach lane
    if (vGw.z > 0.5 && vGw.x > -0.5 && vGw.x < 1.2) {
      float gx = vGw.x;
      float lane = step(0.0, v * vGw.y) * step(abs(v), hw - 0.15);
      float dash = step(fract(v / 0.9), 0.6);
      float l1 = 1.0 - smoothstep(0.0, 0.03, abs(gx - 0.1) - 0.1);
      float l2 = 1.0 - smoothstep(0.0, 0.03, abs(gx - 0.5) - 0.1);
      paint = max(paint, (l1 + l2) * dash * lane);
    }
    paint *= 0.75 + 0.25 * n4.b;
    paint *= 1.0 - smoothstep(0.62, 0.75, n3.r) * 0.5; // worn
    paint *= 0.8 - 0.25 * smoothstep(0.4, 0.8, n2.b); // faded
    rAlb = mix(rAlb, vec3(0.72, 0.72, 0.70), paint);
    // rural lanes without pavements: narrow grit shoulder
    if (rural && vMark > 0.5 && hw > 1.6) {
      float sh = smoothstep(hw - 0.45, hw - 0.3, abs(v));
      rAlb = mix(rAlb, lin3(vec3(0.42, 0.38, 0.32)) * (0.7 + 0.5 * n5.a), sh * 0.85);
      rBump = mix(rBump, n5.a, sh);
    }
    rRough = mix(rRough, 0.55, paint);
    if (town && abs(gxc) > 14.5) {
      // double yellow lines along both kerbs
      float yl = max(lineAA(abs(v) - (hw - 0.22), 0.05), lineAA(abs(v) - (hw - 0.42), 0.05)) * m;
      yl *= 0.8 + 0.2 * n4.b;
      rAlb = mix(rAlb, lin3(vec3(0.80, 0.62, 0.16)), yl * 0.9);
      rRough = mix(rRough, 0.6, yl);
    }
  } else if (t == ${RT.TRACK}) {
    float rq = (abs(v) - 0.8) / 0.35; float ruts = exp(-rq * rq);
    vec3 grav = lin3(vec3(0.50, 0.45, 0.37)) * (0.75 + 0.4 * n4.a);
    vec3 grassy = lin3(vec3(0.30, 0.36, 0.15)) * (0.8 + 0.3 * n3.g);
    float gm = clamp(1.0 - ruts * 1.6 + (n3.r - 0.5), 0.0, 1.0) * smoothstep(0.2, 0.6, abs(v) / hw + 0.3 * (1.0 - ruts));
    rAlb = mix(grav, grassy, gm * 0.8); rRough = 0.95; rBump = n4.a;
  } else if (t == ${RT.FOOT} || t == ${RT.CYCLE}) {
    rAlb = asph * (t == ${RT.CYCLE} ? vec3(1.35, 0.85, 0.8) : vec3(1.1));
  } else if (t == ${RT.PATH}) {
    rAlb = lin3(vec3(0.46, 0.39, 0.29)) * (0.75 + 0.4 * n4.a) * (0.85 + 0.3 * n3.g); rRough = 0.97; rBump = n4.a;
  } else if (t == ${RT.PAVE}) {
    // paving flags 0.6 x 0.9
    vec2 fl = vec2(u / 0.9, (abs(v) - hw) / 0.6);
    vec2 f = fract(fl); vec2 fw = fwidth(fl);
    float joint = 1.0 - (1.0 - smoothstep(0.0, fw.x * 1.5 + 0.03, min(f.x, 1.0 - f.x))) * (1.0 - smoothstep(0.0, fw.y * 1.5 + 0.03, min(f.y, 1.0 - f.y)));
    float jv = min(smoothstep(0.0, 0.04 + fw.x, min(f.x, 1.0 - f.x)), smoothstep(0.0, 0.04 + fw.y, min(f.y, 1.0 - f.y)));
    jv = mix(jv, 1.0, clamp(max(fw.x, fw.y) * 2.0, 0.0, 1.0));
    float fh = fract(sin(dot(floor(fl), vec2(41.3, 289.1))) * 43758.5453);
    vec3 c = lin3(vec3(0.47, 0.465, 0.45)) * (0.92 + 0.12 * fh) * (0.93 + 0.1 * n4.a) * (0.95 + 0.08 * n2.g);
    rAlb = c * (0.82 + 0.18 * jv); rRough = 0.92; rBump = jv * 0.4 + n4.a * 0.15;
    if (xing && abs(gxc) < 1.8) {
      float edge = abs(v) - hw;
      vec2 dp = fract(vec2(u, abs(v)) / 0.067) - 0.5;
      float blister = 1.0 - smoothstep(0.18, 0.3, length(dp));
      vec3 red = lin3(vec3(0.62, 0.30, 0.28)) * (0.9 + 0.1 * n4.a);
      if (edge < 1.2) { rAlb = red * (0.85 + 0.2 * blister); rBump = blister; }
      else rAlb = lin3(vec3(0.50, 0.26, 0.22)) * (0.82 + 0.18 * jv);   // red block paving
    }
  } else if (t == ${RT.KERB}) {
    // kerbstones: 0.9 m blocks with joints, top arris lighter
    float kj = smoothstep(0.0, 0.03 + fwidth(u / 0.9) * 0.9, min(fract(u / 0.9), 1.0 - fract(u / 0.9)));
    float kh = fract(sin(floor(u / 0.9) * 12.9898) * 43758.5453);
    rAlb = lin3(vec3(0.55, 0.545, 0.53)) * (0.85 + 0.15 * kh) * (0.55 + 0.45 * kj) * (0.9 + 0.15 * n4.a);
    rAlb *= mix(0.75, 1.1, smoothstep(0.0, 0.12, v - 0.02)); rRough = 0.85; rBump = kj;
  } else if (t == ${RT.BALLAST}) {
    float sl = step(0.62, fract(u / 0.65)) * step(abs(v), 1.3);
    rAlb = mix(lin3(vec3(0.40, 0.37, 0.34)) * (0.6 + 0.6 * n4.a), lin3(vec3(0.26, 0.22, 0.18)), sl * (1.0 - smoothstep(30.0, 80.0, dist)));
    rRough = 0.95; rBump = n4.a;
  } else if (t == ${RT.RAIL}) {
    rAlb = lin3(vec3(0.42, 0.36, 0.30)); rRough = 0.45;
  } else if (t == ${RT.PARAPET}) {
    vec2 st = vec2(u / 0.45, v / 0.25);
    vec2 f = fract(st + vec2(step(1.0, mod(floor(st.y), 2.0)) * 0.5, 0.0));
    float j = smoothstep(0.0, 0.08, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) * 2.0);
    rAlb = lin3(vec3(0.52, 0.46, 0.37)) * (0.75 + 0.3 * n3.g) * (0.75 + 0.25 * j); rRough = 0.9;
  }
}
`;

export async function createRoads(features, hf, lc, roadIdx, slicer, bIdx = null) {
  const giveWays = [];
  const B = new RibbonBuilder();
  const tmp = { seg: null, d: 0, t: 0, y: 0 };
  for (const r of features.roads) {
    const K = KIND[r.k];
    if (!K || r.tu || r.p.length < 2) continue;
    const p = r.p, F = frames(p), hw = r._w / 2;
    const lift = K.lift;
    // markings/pavements suppressed where another road crosses
    const other = (i, extra) => {
      const q = roadIdx.query(p[i][0], p[i][2], extra, (s) => s.ref !== r && s.ref._w >= 2.5, tmp);
      return q !== null;
    };
    const markFn = (i) => (other(i, 1.0) ? 0 : 1); // plain asphalt near junctions -> overlapping ribbons look identical
    // UK practice: no centre line on narrow lanes
    const tt = r._forceT !== undefined ? r._forceT : ((K.t <= 1 && (r._w < 6.0 || (!r._pave && r._w < 6.6 && (r.k === 'tertiary' || r.k === 'unclassified')))) ? RT.MINOR : K.t);
    // give-way where this (minor) road ends on a road of higher rank
    const rk = RANK[r.k] || 0;
    const gwEnd = (pt, fromEnd) => {
      if (rk <= 0 || rk >= 4) return -1;
      const flt = (s) => s.ref !== r && (RANK[s.ref.k] || 0) > rk;
      if (!roadIdx.query(pt[0], pt[2], 0.5, flt, tmp)) return -1;
      // walk back along this road until we leave the major carriageway
      const pts = fromEnd ? [...p].reverse() : p;
      let acc = 0;
      for (let i = 0; i + 1 < pts.length && acc < 25; i++) {
        const a = pts[i], b = pts[i + 1], L = Math.hypot(b[0] - a[0], b[2] - a[2]);
        for (let t = 0; t < L; t += 0.25) {
          const x = a[0] + (b[0] - a[0]) * t / L, z = a[2] + (b[2] - a[2]) * t / L;
          const q = roadIdx.query(x, z, 0.5, flt, tmp);
          if (!q || q.d > q.seg.ref._w / 2) return acc + t + 0.35;
        }
        acc += L;
      }
      return -1;
    };
    const L = F.L[p.length - 1];
    const g0 = gwEnd(p[0], false), g1 = gwEnd(p[p.length - 1], true);
    if ((g0 >= 0 || g1 >= 0) && L > 15) {
      B.gw = { g0, g1, L };
      const addSign = (i, g, dir) => {
        // sign on the approach lane's left verge
        const k = Math.max(0, Math.min(p.length - 1, i));
        giveWays.push({ x: p[k][0], y: p[k][1], z: p[k][2], nx: F.nx[k], nz: F.nz[k], dir, hw: hw + (r._pave || 0), g });
      };
      if (g0 >= 0) addSign(Math.round((g0 + 1.5) / Math.max(0.5, L / (p.length - 1))), g0, -1);
      if (g1 >= 0) addSign(p.length - 1 - Math.round((g1 + 1.5) / Math.max(0.5, L / (p.length - 1))), g1, 1);
    } else B.gw = null;
    B.cross = r._cross != null ? r._cross : null;
    strip(B, p, F, -hw, hw, lift, ((r._tc || r._dyl) && K.t <= 1 ? RT.TOWN : tt) + (!r._pave && tt <= 3 ? 20 : 0), hw, markFn, null);
    B.gw = null;
    // round caps at both ends: fill junction corners / dead ends seamlessly
    for (const e of [0, p.length - 1]) {
      const c = p[e], seg = 14, y = c[1] + lift - 0.004;
      const ci = B.vert(c[0], y, c[2], 0, 1, 0, F.L[e], 0, hw, K.t, 0);
      const ring = [];
      for (let k = 0; k <= seg; k++) {
        const a = (k / seg) * Math.PI * 2;
        ring.push(B.vert(c[0] + Math.cos(a) * hw, y, c[2] + Math.sin(a) * hw, 0, 1, 0, F.L[e], hw, hw, K.t, 0));
      }
      // cos/sin in (x,z): increasing angle is clockwise seen from above -> (ci, k+1, k) faces up
      for (let k = 0; k < seg; k++) B.idx.push(ci, ring[k + 1], ring[k]);
    }
    if (r._pave) {
      const pw = r._pave, vg = r._verge || 0;
      for (const side of [-1, 1]) {
        if (r._paveSide && side !== r._paveSide) continue;
        const keep = (i) => {
          const x = p[i][0] + F.nx[i] * side * (hw + vg + pw * 0.5), z = p[i][2] + F.nz[i] * side * (hw + vg + pw * 0.5);
          const q = roadIdx.query(x, z, -pw - 0.2, (s) => s.ref !== r, tmp);
          return q === null && !(bIdx && bIdx.find(x, z));
        };
        const o0 = side > 0 ? hw + vg : -hw - vg - pw, o1 = side > 0 ? hw + vg + pw : -hw - vg;
        strip(B, p, F, o0, o1, lift + (vg ? 0.1 : 0.12), r._paveTarmac ? RT.FOOT : RT.PAVE, hw + vg, null, keep);
        wall(B, p, F, side * hw, lift - 0.02, lift + 0.12, -side, RT.KERB, hw, keep);

        // town centre: pave forecourts right up to the building line
        if (r._tc && bIdx) {
          let prev = null;
          for (let i = 0; i < p.length; i++) {
            let d = -1;
            for (let s = 0.3; s <= 7.5; s += 0.4) {
              const x = p[i][0] + F.nx[i] * side * (hw + pw + s), z = p[i][2] + F.nz[i] * side * (hw + pw + s);
              if (bIdx.find(x, z)) { d = s + 0.25; break; }
              if (roadIdx.query(x, z, 0, (q) => q.ref !== r, tmp)) break;
            }
            if (d < 0 || !keep(i)) { prev = null; continue; }
            const y0 = p[i][1] + lift + 0.12;
            const ox = p[i][0] + F.nx[i] * side * (hw + pw + d), oz = p[i][2] + F.nz[i] * side * (hw + pw + d);
            const y1 = Math.max(y0, hf.sample(ox, oz) + 0.06);
            const inner = B.vert(p[i][0] + F.nx[i] * side * (hw + pw), y0, p[i][2] + F.nz[i] * side * (hw + pw), 0, 1, 0, F.L[i], side * (hw + pw), hw, RT.PAVE, 1);
            const outer = B.vert(ox, y1, oz, 0, 1, 0, F.L[i], side * (hw + pw + d), hw, RT.PAVE, 1);
            const a = side > 0 ? inner : outer, b = side > 0 ? outer : inner;
            if (prev) B.idx.push(prev[0], a, prev[1], prev[1], a, b);
            prev = [a, b];
          }
        }
      }
    }
    B.cross = null;
    if (r.br) {
      const ow = hw + (r._pave || 0.3);
      for (const side of [-1, 1]) {
        wall(B, p, F, side * ow, lift - 1.0, lift + 1.0, side, RT.PARAPET, hw, null);
        wall(B, p, F, side * (ow - 0.3), lift, lift + 1.0, -side, RT.PARAPET, hw, null);
        strip(B, p, F, side > 0 ? ow - 0.3 : -ow, side > 0 ? ow : -ow + 0.3, lift + 1.0, RT.PARAPET, hw, null, null);
      }
      // underside
      const Bu = B; const pr = p.map((q) => [q[0], q[1] - 1.0, q[2]]);
      const F2 = frames(pr);
      let prev = null;
      for (let i = 0; i < pr.length; i++) {
        const x = pr[i][0], y = pr[i][1] + lift, z = pr[i][2];
        const a = Bu.vert(x - F2.nx[i] * ow, y, z - F2.nz[i] * ow, 0, -1, 0, F2.L[i], 0, hw, RT.PARAPET, 1);
        const b = Bu.vert(x + F2.nx[i] * ow, y, z + F2.nz[i] * ow, 0, -1, 0, F2.L[i], 1, hw, RT.PARAPET, 1);
        if (prev) Bu.idx.push(prev[0], prev[1], a, prev[1], b, a);
        prev = [a, b];
      }
    }
    await slicer.tick();
  }
  for (const r of features.rail || []) {
    if (r.tu || r.p.length < 2) continue;
    const p = r.p, F = frames(p);
    strip(B, p, F, -1.9, 1.9, 0.05, RT.BALLAST, 1.9, null, null);
    for (const o of [-0.75, 0.72]) {
      strip(B, p, F, o, o + 0.07, 0.22, RT.RAIL, 1, null, null);
      wall(B, p, F, o, 0.05, 0.22, -1, RT.RAIL, 1, null);
      wall(B, p, F, o + 0.07, 0.05, 0.22, 1, RT.RAIL, 1, null);
    }
    await slicer.tick();
  }
  const geo = B.build();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, envMapIntensity: 0.8 });
  patchMaterial(mat, {
    key: 'roads',
    vertexPars: 'attribute vec4 aRoad; attribute vec4 aMark; varying vec4 vRoad; varying float vMark; varying vec3 vGw;',
    vertex: { begin_vertex: '$\n vRoad = aRoad; vMark = aMark.x; vGw = aMark.yzw;' },
    // shadow hook (sky/lighting): long-range baked sun shadow (terrain + buildings + trees) beyond the realtime cascades
    fragmentPars: GRID_GLSL + '\nfloat hbSun;\nvec3 hbNw;\n' + ROAD_FRAG + WET_GLSL, // WEATHER: wet GLSL appended
    fragment: {
      lights_fragment_begin: THREE.ShaderChunk.lights_fragment_begin.replace('getSunLightInfo( sunLight, directLight );', 'getSunLightInfo( sunLight, directLight ); directLight.color *= hbSun;'),
      // WEATHER: wetness (darker, glossy, puddles in gutters/dips).
      map_fragment: 'hbSun = bakedSun(vAerialWorld); roadSurface(vAerialWorld); hbApplyWet(vAerialWorld, rAlb, rRough, rBump, smoothstep(0.55, 1.0, abs(vRoad.y) / max(vRoad.z, 0.5)), 1.0, 1.0); diffuseColor.rgb = rAlb;',
      roughnessmap_fragment: 'float roughnessFactor = rRough;',
      normal_fragment_begin: `$
        {
          vec3 dpdx = dFdx(vAerialWorld), dpdy = dFdy(vAerialWorld);
          vec3 Nw = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          float bx = dFdx(rBump), by = dFdy(rBump);
          vec3 r1 = cross(dpdy, Nw), r2 = cross(Nw, dpdx);
          float det = dot(dpdx, r1);
          vec3 grad = sign(det) * (bx * r1 + by * r2);
          float fade = 1.0 - smoothstep(20.0, 90.0, distance(vAerialWorld, cameraPosition));
          Nw = normalize(abs(det) * Nw - grad * 0.015 * fade);
          Nw = hbWetNormal(Nw); // WEATHER: puddle ripples
          normal = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
          hbNw = Nw;
        }`,
      emissivemap_fragment: '$\n totalEmissiveRadiance += hbWetRefl(vAerialWorld, hbNw); // WEATHER: sky reflection in wet road / puddles',
    },
    uniforms: {},
  });
  const mesh = new THREE.Group();
  mesh.name = 'roads';
  for (const g of splitByCell(geo, 500)) {
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true; m.castShadow = false; m.matrixAutoUpdate = false;
    mesh.add(m);
  }
  geo.dispose();
  return { mesh, geometry: geo, giveWays };
}
