import * as THREE from 'three';
import { patchMaterial, GRID_GLSL } from './shared.js';
import { mulberry32 } from './heightfield.js';

const KINDS = ['house', 'terrace', 'residential', 'commercial', 'retail', 'industrial', 'church', 'school', 'garage', 'shed', 'other'];
// shop units found while building facades (used to place awnings, A-boards, the clock)
export const shopUnits = [];
const S_WALL = 0, S_ROOF = 1, S_FLAT = 2, S_CHIM = 3, S_SHOP = 5, S_POT = 6;
const CELL = 600;

// --- growable vertex buffers -------------------------------------------------------------
class GeoBuf {
  constructor() { this.cap = 4096; this.n = 0; this._alloc(); this.idx = []; }
  _alloc(old) {
    const p = new Float32Array(this.cap * 3), nr = new Int8Array(this.cap * 4), w = new Float32Array(this.cap * 4), b = new Uint8Array(this.cap * 4);
    if (old) { p.set(old.p); nr.set(old.nr); w.set(old.w); b.set(old.b); }
    this.p = p; this.nr = nr; this.w = w; this.b = b;
  }
  v(x, y, z, nx, ny, nz, w0, w1, w2, w3, b0, b1, b2, b3) {
    if (this.n >= this.cap) { const o = { p: this.p, nr: this.nr, w: this.w, b: this.b }; this.cap *= 2; this._alloc(o); }
    const i = this.n++;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.nr[i * 4] = nx * 127; this.nr[i * 4 + 1] = ny * 127; this.nr[i * 4 + 2] = nz * 127;
    this.w[i * 4] = w0; this.w[i * 4 + 1] = w1; this.w[i * 4 + 2] = w2; this.w[i * 4 + 3] = w3;
    this.b[i * 4] = b0; this.b[i * 4 + 1] = b1; this.b[i * 4 + 2] = b2; this.b[i * 4 + 3] = b3;
    return i;
  }
  build() {
    if (this.n === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p.slice(0, this.n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nr.slice(0, this.n * 4), 4, true));
    g.setAttribute('aW', new THREE.BufferAttribute(this.w.slice(0, this.n * 4), 4));
    g.setAttribute('aB', new THREE.BufferAttribute(this.b.slice(0, this.n * 4), 4, false));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

// --- geometry helpers ------------------------------------------------------------------------
function convexHull(pts) {
  const p = pts.map((q) => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  up.pop(); lo.pop();
  return lo.concat(up);
}

// minimum-area oriented bounding rectangle
function obb(poly) {
  const h = convexHull(poly);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    let ux = b[0] - a[0], uz = b[1] - a[1];
    const l = Math.hypot(ux, uz); if (l < 1e-6) continue;
    ux /= l; uz /= l;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of h) {
      const u = q[0] * ux + q[1] * uz, v = -q[0] * uz + q[1] * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uz, u0, u1, v0, v1 };
  }
  if (!best) return null;
  let { ux, uz, u0, u1, v0, v1 } = best;
  // make U the long axis
  if (v1 - v0 > u1 - u0) { const nux = -uz, nuz = ux; const t0 = v0, t1 = v1; v0 = -u1; v1 = -u0; u0 = t0; u1 = t1; ux = nux; uz = nuz; }
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  return {
    ux, uz, vx: -uz, vz: ux, cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, hl: (u1 - u0) / 2, hw: (v1 - v0) / 2, area: best.area,
  };
}

function polyArea(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return a / 2; }

// Sutherland-Hodgman clip of polygon (array of [u,v]) by half-plane a*u + b*v >= c
function clipHalf(poly, a, b, c) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const P = poly[i], Q = poly[(i + 1) % poly.length];
    const dp = a * P[0] + b * P[1] - c, dq = a * Q[0] + b * Q[1] - c;
    if (dp >= 0) out.push(P);
    if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]); }
  }
  return out;
}

function triangulate(poly2) {
  try {
    const contour = poly2.map((q) => new THREE.Vector2(q[0], q[1]));
    return THREE.ShapeUtils.triangulateShape(contour, []);
  } catch (e) { return []; }
}

// --- building generation -----------------------------------------------------------------------
function addBuilding(G, b, rnd, tcIdx) {
  const tq = { seg: null, d: 0, t: 0, y: 0 };
  let poly = b.p;
  if (!poly || poly.length < 3) return;
  // drop duplicate consecutive points
  poly = poly.filter((q, i) => { const r = poly[(i + 1) % poly.length]; return Math.hypot(q[0] - r[0], q[1] - r[1]) > 0.05; });
  if (poly.length < 3) return;
  const A = polyArea(poly);
  if (Math.abs(A) < 4) return;
  const outSign = A > 0 ? 1 : -1; // see notes: A>0 => clockwise from above => outward = (dz,-dx)
  const kind = Math.max(0, KINDS.indexOf(b.k));
  const base = b.b;
  let H = Math.max(2.2, b.h || 6), E = Math.min(H, Math.max(2.0, b.e || H));
  let roof = b.r || 'flat';
  const O = obb(poly);
  if (!O) return;
  if (roof !== 'flat' && (H - E < 0.4 || O.hw < 1.2)) roof = 'flat';
  // keep pitch plausible (<= 52 deg)
  if (roof !== 'flat') { const maxRise = O.hw * 1.28; if (H - E > maxRise) H = E + maxRise; }
  const rise = H - E;
  const s = roof === 'flat' ? 0 : rise / O.hw;
  const k = O.hl - O.hw;
  const toUV = (x, z) => { const dx = x - O.cx, dz = z - O.cz; return [dx * O.ux + dz * O.uz, dx * O.vx + dz * O.vz]; };
  const toXZ = (u, v) => [O.cx + u * O.ux + v * O.vx, O.cz + u * O.uz + v * O.vz];
  const roofH = roof === 'gabled' ? (u, v) => E + s * (O.hw - Math.abs(v))
    : roof === 'hipped' ? (u, v) => E + s * Math.min(O.hw - Math.abs(v), O.hl - Math.abs(u))
      : () => H;
  const c = Math.min(15, b.c | 0);
  const seed = (rnd() * 255) | 0;
  const bottom = base - 1.5;
  const eaveAbs = base + E;

  // ---- walls (edges split where the roof function changes slope)
  const lines = roof === 'gabled' ? [[0, 1, 0]] : roof === 'hipped' ? [[0, 1, 0], [1, -1, k], [1, 1, k], [-1, -1, k], [-1, 1, k]] : [];
  for (let i = 0; i < poly.length; i++) {
    const P = poly[i], Q = poly[(i + 1) % poly.length];
    const ex = Q[0] - P[0], ez = Q[1] - P[1], len = Math.hypot(ex, ez);
    if (len < 0.05) continue;
    const nx = outSign * ez / len, nz = -outSign * ex / len;
    // split points (t along edge)
    const ts = [0, 1];
    const pu = toUV(P[0], P[1]), qu = toUV(Q[0], Q[1]);
    for (const [a, bb, cc] of lines) {
      const dp = a * pu[0] + bb * pu[1] - cc, dq = a * qu[0] + bb * qu[1] - cc;
      if ((dp > 0) !== (dq > 0) && Math.abs(dp - dq) > 1e-9) ts.push(dp / (dp - dq));
    }
    ts.sort((x, y) => x - y);
    // town-centre shopfront: wall faces a centre street within a few metres
    let shopEdge = false;
    if (b._tc && tcIdx && len > 3 && E > 4.5 && b.k !== 'shed' && b.k !== 'garage') {
      const mx = (P[0] + Q[0]) / 2, mz = (P[1] + Q[1]) / 2;
      const h = tcIdx.query(mx + nx * 2, mz + nz * 2, 5, null, tq);
      if (h) {
        const s = h.seg, px = s.ax + (s.bx - s.ax) * h.t, pz = s.az + (s.bz - s.az) * h.t;
        shopEdge = (px - mx) * nx + (pz - mz) * nz > 0;
      }
      if (shopEdge) {
        const nu = Math.max(1, Math.floor(len / 5.5 + 0.5)), uw = len / nu;
        for (let k = 0; k < nu; k++) {
          const f = (k + 0.5) * uw / len;
          shopUnits.push({ x: P[0] + ex * f, z: P[1] + ez * f, y: base, nx, nz, tx: ex / len, tz: ez / len, w: uw, c, k, eave: E, id: shopUnits.length });
        }
      }
    }
    for (let t = 0; t + 1 < ts.length; t++) {
      const t0 = ts[t], t1 = ts[t + 1];
      if (t1 - t0 < 1e-4) continue;
      const x0 = P[0] + ex * t0, z0 = P[1] + ez * t0, x1 = P[0] + ex * t1, z1 = P[1] + ez * t1;
      const uv0 = toUV(x0, z0), uv1 = toUV(x1, z1);
      const y0 = base + roofH(uv0[0], uv0[1]), y1 = base + roofH(uv1[0], uv1[1]);
      const sw = shopEdge ? S_SHOP : S_WALL;
      const a0 = G.v(x0, bottom, z0, nx, 0, nz, t0 * len, len, base, eaveAbs, c, kind, sw, seed);
      const a1 = G.v(x1, bottom, z1, nx, 0, nz, t1 * len, len, base, eaveAbs, c, kind, sw, seed);
      const b0 = G.v(x0, y0, z0, nx, 0, nz, t0 * len, len, base, eaveAbs, c, kind, sw, seed);
      const b1 = G.v(x1, y1, z1, nx, 0, nz, t1 * len, len, base, eaveAbs, c, kind, sw, seed);
      // (a1-a0)x(b0-a0) = (-ez, 0, ex)*h : front-facing when it agrees with the outward normal
      if (ex * nz - ez * nx > 0) G.idx.push(a0, a1, b0, b0, a1, b1); else G.idx.push(a0, b0, a1, a1, b0, b1);
    }
  }

  // ---- roof
  const uvPoly0 = poly.map((q) => toUV(q[0], q[1]));
  // eaves / verge overhang for pitched roofs (approximated by scaling about the OBB centre)
  const OH = roof === 'flat' ? 0 : 0.32;
  const uvPoly = OH ? uvPoly0.map((q) => [q[0] * (O.hl + (roof === 'hipped' ? OH : OH * 0.8)) / O.hl, q[1] * (O.hw + OH) / O.hw]) : uvPoly0;
  const addPlane = (pl, hfun, nrm, surf) => {
    if (pl.length < 3) return;
    const tris = triangulate(pl);
    const ids = pl.map((q) => {
      const [x, z] = toXZ(q[0], q[1]);
      return G.v(x, base + hfun(q[0], q[1]), z, nrm[0], nrm[1], nrm[2], q[0], q[1], base, eaveAbs, c, kind, surf, seed);
    });
    // underside (soffit) only where the roof overhangs: cheap full duplicate, slightly lowered
    const sid = OH && surf === S_ROOF ? pl.map((q) => {
      const [x, z] = toXZ(q[0], q[1]);
      return G.v(x, base + hfun(q[0], q[1]) - 0.06, z, -nrm[0], -nrm[1], -nrm[2], q[0], q[1], base, eaveAbs, c, kind, 4, seed);
    }) : null;
    for (const t of tris) {
      const p0 = pl[t[0]], p1 = pl[t[1]], p2 = pl[t[2]];
      // orientation in xz (via uv->xz is a rotation, keeps handedness): want +y facing
      const [x0, z0] = toXZ(p0[0], p0[1]), [x1, z1] = toXZ(p1[0], p1[1]), [x2, z2] = toXZ(p2[0], p2[1]);
      const ny = (z1 - z0) * (x2 - x0) - (x1 - x0) * (z2 - z0);
      if (ny > 0) G.idx.push(ids[t[0]], ids[t[1]], ids[t[2]]); else G.idx.push(ids[t[0]], ids[t[2]], ids[t[1]]);
      if (sid) { if (ny > 0) G.idx.push(sid[t[0]], sid[t[2]], sid[t[1]]); else G.idx.push(sid[t[0]], sid[t[1]], sid[t[2]]); }
    }
  };
  const planeN = (gu, gv) => { // gradient of h wrt (u,v) -> world normal
    const gx = gu * O.ux + gv * O.vx, gz = gu * O.uz + gv * O.vz;
    const l = Math.hypot(gx, 1, gz); return [-gx / l, 1 / l, -gz / l];
  };
  if (roof === 'flat') {
    addPlane(uvPoly, () => H, [0, 1, 0], S_FLAT);
  } else if (roof === 'gabled') {
    addPlane(clipHalf(uvPoly, 0, 1, 0), (u, v) => E + s * (O.hw - v), planeN(0, -s), S_ROOF);
    addPlane(clipHalf(uvPoly, 0, -1, 0), (u, v) => E + s * (O.hw + v), planeN(0, s), S_ROOF);
  } else {
    let F = clipHalf(clipHalf(clipHalf(uvPoly, 0, 1, 0), -1, 1, -k), 1, 1, -k);
    addPlane(F, (u, v) => E + s * (O.hw - v), planeN(0, -s), S_ROOF);
    F = clipHalf(clipHalf(clipHalf(uvPoly, 0, -1, 0), -1, -1, -k), 1, -1, -k);
    addPlane(F, (u, v) => E + s * (O.hw + v), planeN(0, s), S_ROOF);
    F = clipHalf(clipHalf(uvPoly, 1, -1, k), 1, 1, k);
    addPlane(F, (u, v) => E + s * (O.hl - u), planeN(-s, 0), S_ROOF);
    F = clipHalf(clipHalf(uvPoly, -1, -1, k), -1, 1, k);
    addPlane(F, (u, v) => E + s * (O.hl + u), planeN(s, 0), S_ROOF);
  }

  // ---- chimneys (with pots) on houses / terraces / town-centre buildings
  const prism = (u, v, w, d, yb, top, surfSide, surfTop) => {
    const corners = [[u - w, v - d], [u + w, v - d], [u + w, v + d], [u - w, v + d]].map((q) => toXZ(q[0], q[1]));
    const fn = [[-O.vx, -O.vz], [O.ux, O.uz], [O.vx, O.vz], [-O.ux, -O.uz]];
    for (let e = 0; e < 4; e++) {
      const P = corners[e], Q = corners[(e + 1) % 4];
      const [nx, nz] = fn[e];
      const ids = [G.v(P[0], yb, P[1], nx, 0, nz, 0, 1, base, eaveAbs, c, kind, surfSide, seed),
        G.v(Q[0], yb, Q[1], nx, 0, nz, 1, 1, base, eaveAbs, c, kind, surfSide, seed),
        G.v(P[0], top, P[1], nx, 0, nz, 0, 1, base, eaveAbs, c, kind, surfSide, seed),
        G.v(Q[0], top, Q[1], nx, 0, nz, 1, 1, base, eaveAbs, c, kind, surfSide, seed)];
      const ex = Q[0] - P[0], ez = Q[1] - P[1];
      if (ex * nz - ez * nx > 0) G.idx.push(ids[0], ids[1], ids[2], ids[2], ids[1], ids[3]); else G.idx.push(ids[0], ids[2], ids[1], ids[1], ids[2], ids[3]);
    }
    const tids = corners.map((q) => G.v(q[0], top, q[1], 0, 1, 0, 0, 0, base, eaveAbs, c, kind, surfTop, seed));
    const ny = (corners[1][1] - corners[0][1]) * (corners[2][0] - corners[0][0]) - (corners[1][0] - corners[0][0]) * (corners[2][1] - corners[0][1]);
    if (ny > 0) G.idx.push(tids[0], tids[1], tids[2], tids[0], tids[2], tids[3]); else G.idx.push(tids[0], tids[2], tids[1], tids[0], tids[3], tids[2]);
  };
  if (roof !== 'flat' && (kind <= 2 || b._tc) && O.hl > 2.5 && b.k !== 'shed' && b.k !== 'garage') {
    const spots = [];
    if (kind === 1 || O.hl > 9) { for (let u = -O.hl + 3.5; u < O.hl - 2; u += 6.5 + rnd() * 1.5) spots.push(u); }
    else if (rnd() < (b._tc ? 1 : 0.85)) { spots.push((rnd() < 0.5 ? -1 : 1) * (O.hl - (roof === 'hipped' ? O.hw * 0.9 : 0.6))); if (rnd() < (b._tc ? 0.7 : 0.35)) spots.push(-spots[0]); }
    for (const u of spots) {
      const top = base + roofH(u, 0) + 0.9 + rnd() * 0.4;
      const yb = base + roofH(u, 0.5) - 0.6;
      prism(u, 0, 0.45, 0.7, yb, top, S_CHIM, S_FLAT);
      const np = 2 + (rnd() < 0.4 ? 1 : 0);
      for (let k = 0; k < np; k++) prism(u, (k - (np - 1) / 2) * 0.42, 0.1, 0.1, top - 0.02, top + 0.32 + rnd() * 0.12, S_POT, S_POT);
    }
  }
}

// --- material ------------------------------------------------------------------------------------
const BLD_FRAG = /* glsl */`
${GRID_GLSL}
varying vec4 vW; flat varying vec4 vB;
uniform sampler2D uNoise;
vec3 bAlb; float bRough; float bMetal; float bBump; float bAO; float hbSun;
vec3 lin3(vec3 c) { return pow(c, vec3(2.2)); }
float hb(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float boxAA(vec2 p, vec2 lo, vec2 hi, vec2 fw) {
  vec2 a = smoothstep(lo - fw, lo + fw, p) * (1.0 - smoothstep(hi - fw, hi + fw, p));
  return a.x * a.y;
}
vec3 brickCol(int c) {
  if (c == 0) return lin3(vec3(0.50, 0.24, 0.16));
  if (c == 1) return lin3(vec3(0.58, 0.32, 0.21));
  if (c == 2) return lin3(vec3(0.42, 0.21, 0.15));
  if (c == 3) return lin3(vec3(0.62, 0.40, 0.27));
  if (c == 4) return lin3(vec3(0.60, 0.50, 0.35));   // weathered buff gritstone
  if (c == 5) return lin3(vec3(0.47, 0.40, 0.30));   // darker sooted stone
  if (c == 8) return lin3(vec3(0.58, 0.23, 0.15));   // bright Victorian red brick
  if (c == 9) return lin3(vec3(0.72, 0.60, 0.42));   // honey/buff Yorkshire sandstone ashlar
  if (c == 10) return lin3(vec3(0.74, 0.72, 0.66));  // whitewashed render
  if (c == 6) return lin3(vec3(0.64, 0.60, 0.52));
  return lin3(vec3(0.58, 0.58, 0.555));
}
void buildingSurface(vec3 w, vec3 Nw) {
  int c = int(vB.x + 0.5), kind = int(vB.y + 0.5), surf = int(vB.z + 0.5);
  float seed = vB.w;
  vec4 n3 = texture2D(uNoise, w.xz / 5.0 + w.y / 9.0);
  vec4 n4 = texture2D(uNoise, vec2(w.x + w.z, w.y) / 1.1);
  float dist = distance(w, cameraPosition);
  bRough = 0.85; bMetal = 0.0; bBump = 0.0; bAO = 1.0;
  bool industrial = (kind == 3 || kind == 4 || kind == 5);
  if (surf == 0 || surf == 3 || surf == 5) {
    bool shop = surf == 5;
    float hgt = w.y - vW.z;           // above base
    float eave = vW.w - vW.z;
    float u = vW.x, L = vW.y;
    vec3 base = brickCol(c);
    bool brick = c <= 3 || c == 8 || (surf == 3);
    bool stone = (c == 4 || c == 5 || c == 9 || kind == 6) && surf != 3;
    bool dress = (c == 8 || c == 9) && surf != 3;
    vec3 dressCol = c == 8 ? lin3(vec3(0.82, 0.81, 0.77)) : lin3(vec3(0.80, 0.70, 0.52));
    if (kind == 6) base = lin3(vec3(0.50, 0.44, 0.34));
    vec3 col = base;
    if (industrial && surf == 0 && !shop) {
      // profiled metal cladding above brick plinth
      vec3 clad = c < 3 ? lin3(vec3(0.42, 0.47, 0.46)) : c < 6 ? lin3(vec3(0.36, 0.41, 0.50)) : lin3(vec3(0.66, 0.63, 0.55));
      float rib = 0.5 + 0.5 * sin(u / 0.25 * 6.2831);
      float fwr = fwidth(u / 0.25);
      rib = mix(rib, 0.5, clamp(fwr, 0.0, 1.0));
      col = hgt < 1.8 ? lin3(vec3(0.45, 0.24, 0.17)) : clad * (0.85 + 0.2 * rib);
      bBump = hgt < 1.8 ? 0.0 : rib * 0.4;
      bMetal = hgt < 1.8 ? 0.0 : 0.3; bRough = hgt < 1.8 ? 0.85 : 0.5;
    } else if (brick) {
      vec2 bp = vec2(u / 0.225, hgt / 0.075);
      float row = floor(bp.y);
      bp.x += mod(row, 2.0) * 0.5;
      vec2 f = fract(bp); vec2 fw = fwidth(bp);
      float mortar = (1.0 - smoothstep(0.0, 0.06 + fw.x, min(f.x, 1.0 - f.x) * 1.0)) ;
      mortar = max(mortar, 1.0 - smoothstep(0.0, 0.14 + fw.y, min(f.y, 1.0 - f.y)));
      float aa = smoothstep(0.12, 0.45, max(fw.x, fw.y));
      float bh = hb(floor(bp.x) + row * 31.7 + seed);
      vec3 bc = base * (0.82 + 0.3 * bh) * (0.9 + 0.2 * n4.r);
      vec3 mc = lin3(vec3(0.62, 0.58, 0.52));
      col = mix(mix(bc, mc, mortar * 0.85), mix(base, mc, 0.18), aa);
      bBump = (1.0 - mortar) * (1.0 - aa);
    } else if (stone) {
      vec2 sp = c == 9 ? vec2(u / 0.75, hgt / 0.32) : vec2(u / 0.6, hgt / 0.28);
      float row = floor(sp.y);
      sp.x += c == 9 ? mod(row, 2.0) * 0.5 : hb(row + seed);
      vec2 f = fract(sp); vec2 fw = fwidth(sp);
      float j = 1.0 - smoothstep(0.0, 0.05 + fw.x, min(f.x, 1.0 - f.x)) * 1.0;
      j = max(j, 1.0 - smoothstep(0.0, 0.08 + fw.y, min(f.y, 1.0 - f.y)));
      float aa = smoothstep(0.1, 0.4, max(fw.x, fw.y));
      float sh = hb(floor(sp.x) + row * 17.3 + seed);
      vec3 sc = base * (0.8 + 0.35 * sh) * (0.85 + 0.25 * n3.g);
      col = mix(mix(sc, base * 0.7, j * 0.7), base * 0.92, aa);
      bBump = (1.0 - j) * (1.0 - aa);
    } else {
      col = base * (0.92 + 0.1 * n3.b) * (1.0 - 0.15 * smoothstep(0.6, 0.9, n3.r));
      bRough = 0.9;
    }
    // grime: darker near ground, streaks under windows
    col *= 0.78 + 0.22 * smoothstep(0.0, 1.2, hgt);
    float underEave = smoothstep(eave - 0.9, eave - 0.05, hgt) * (1.0 - smoothstep(eave, eave + 0.3, hgt));
    col *= 1.0 - 0.22 * underEave;
    col *= 1.0 - 0.12 * smoothstep(0.55, 0.85, n3.r) * smoothstep(1.5, 0.0, hgt);
    bAO = (0.65 + 0.35 * smoothstep(0.0, 1.5, hgt)) * (1.0 - 0.35 * underEave);
    if (dress && hgt > (shop ? 3.55 : 0.3)) {
      // dressed quoins on the corners, alternating long/short
      float qd = min(u, L - u);
      float qr = floor(hgt / 0.32);
      float qw = mod(qr, 2.0) < 0.5 ? 0.55 : 0.3;
      vec2 fwq = vec2(fwidth(u), fwidth(hgt));
      float quoin = (1.0 - smoothstep(qw - fwq.x, qw + fwq.x, qd)) * (1.0 - smoothstep(0.0, 0.03 + fwq.y, 0.015 - min(fract(hgt / 0.32), 1.0 - fract(hgt / 0.32)) + 0.015));
      quoin = (1.0 - smoothstep(qw - fwq.x, qw + fwq.x, qd)) * smoothstep(0.0, 0.025 + fwq.y, min(fract(hgt / 0.32), 1.0 - fract(hgt / 0.32)));
      col = mix(col, dressCol * (0.92 + 0.1 * n4.g), quoin * (1.0 - smoothstep(300.0, 600.0, dist)));
      // string course between floors (stone only)
      if (c == 9) col = mix(col, dressCol, boxAA(vec2(0.5, hgt), vec2(0.0, eave - 0.35), vec2(1.0, eave - 0.2), fwq) * 0.8);
    }
    if (shop && hgt < 3.55) {
      // ---- ground-floor shopfronts (units of ~5.5 m)
      float nu = max(1.0, floor(L / 5.5 + 0.5));
      float uw = L / nu;
      float unit = floor(u / uw);
      float lu = u - unit * uw;
      float uh = hb(unit * 5.31 + seed * 0.71 + floor(L));
      float uh2 = hb(unit * 2.17 + seed * 1.37 + 3.0);
      vec2 fw = vec2(fwidth(u), fwidth(hgt)) * 0.75;
      vec3 fasc = uh < 0.22 ? lin3(vec3(0.05, 0.05, 0.06)) : uh < 0.4 ? lin3(vec3(0.16, 0.17, 0.18)) : uh < 0.58 ? lin3(vec3(0.06, 0.18, 0.12))
                : uh < 0.76 ? lin3(vec3(0.28, 0.06, 0.08)) : uh < 0.9 ? lin3(vec3(0.06, 0.09, 0.22)) : lin3(vec3(0.75, 0.74, 0.70));
      vec3 letter = uh < 0.9 ? lin3(vec3(0.86, 0.80, 0.62)) : lin3(vec3(0.08, 0.08, 0.10));
      vec3 pil = dress ? dressCol : (c == 10 ? lin3(vec3(0.62, 0.61, 0.58)) : lin3(vec3(0.20, 0.20, 0.21)));
      float pw = 0.32;
      float inPil = 1.0 - boxAA(vec2(lu, 0.5), vec2(pw, 0.0), vec2(uw - pw, 1.0), fw);
      vec3 sc = pil;
      // fascia band with "lettering" stripes (no real text)
      float fas = boxAA(vec2(lu, hgt), vec2(pw, 2.95), vec2(uw - pw, 3.45), fw);
      float txtZone = boxAA(vec2(lu, hgt), vec2(uw * 0.25, 3.08), vec2(uw * 0.75, 3.32), fw);
      // pseudo-lettering: each 0.13 m cell gets a random set of stems and bars (no real text)
      float gc = floor(lu / 0.13), gp = fract(lu / 0.13), gy = (hgt - 3.1) / 0.2;
      float gb = hb(gc * 1.7 + unit * 13.0 + seed);
      float gb2 = hb(gc * 3.1 + unit * 7.0 + 1.0);
      vec2 gfw = vec2(fwidth(lu / 0.13), fwidth(gy));
      float th = 0.09 + gfw.x;
      float stemL = step(gp, 0.2 + gfw.x) * step(0.05, gp);
      float stemR = step(0.55, gp) * step(gp, 0.72 + gfw.x) * step(0.4, gb);
      float barT = step(0.8, gy) * step(gp, 0.72) * step(0.5, gb2);
      float barM = step(abs(gy - 0.5), th + 0.03) * step(gp, 0.72) * step(gb, 0.7);
      float barB = step(gy, 0.2) * step(gp, 0.72) * step(0.3, gb2);
      float word = step(0.16, fract(gc / 7.0 + uh));
      float glyph = clamp(stemL + stemR + barT + barM + barB, 0.0, 1.0) * word * step(0.0, gy) * step(gy, 1.0);
      glyph = mix(glyph, 0.35 * word, smoothstep(0.3, 0.7, gfw.x));
      vec3 fcol = mix(fasc, letter, txtZone * glyph * (1.0 - smoothstep(60.0, 160.0, dist)) * 0.9);
      // door at one side, display window across the rest
      bool doorLeft = uh2 < 0.5;
      float dx0 = doorLeft ? pw + 0.15 : uw - pw - 1.15, dx1 = dx0 + 1.0;
      float doorM = boxAA(vec2(lu, hgt), vec2(dx0, 0.0), vec2(dx1, 2.35), fw);
      float wx0 = doorLeft ? dx1 + 0.12 : pw + 0.12, wx1 = doorLeft ? uw - pw - 0.12 : dx0 - 0.12;
      float win = boxAA(vec2(lu, hgt), vec2(wx0, 0.6), vec2(wx1, 2.8), fw);
      float riser = boxAA(vec2(lu, hgt), vec2(wx0, 0.0), vec2(wx1, 0.6), fw);
      float nm = max(1.0, floor((wx1 - wx0) / 1.7 + 0.5));
      float mw = (wx1 - wx0) / nm;
      float mull = (1.0 - smoothstep(0.025, 0.025 + fw.x, abs(fract((lu - wx0) / mw + 0.5) - 0.5) * mw)) * win;
      float transom = (1.0 - smoothstep(0.025, 0.025 + fw.y, abs(hgt - 2.35))) * win;
      float frameW = clamp(win - boxAA(vec2(lu, hgt), vec2(wx0 + 0.05, 0.65), vec2(wx1 - 0.05, 2.75), fw), 0.0, 1.0);
      bool shutter = uh2 > 0.86;
      vec3 glassC = lin3(vec3(0.03, 0.035, 0.045)) + lin3(vec3(0.22, 0.2, 0.17)) * smoothstep(0.4, 1.0, hb(floor(lu / 0.4) + unit)) * 0.25 * step(hgt, 1.6);
      if (shutter) glassC = lin3(vec3(0.42, 0.43, 0.44)) * (0.85 + 0.15 * step(0.5, fract(hgt / 0.08)));
      sc = mix(sc, fasc * 1.1, riser);
      sc = mix(sc, glassC, win);
      sc = mix(sc, lin3(vec3(0.06, 0.06, 0.07)), max(max(mull, transom), frameW) * (shutter ? 0.0 : 1.0));
      sc = mix(sc, mix(fasc * 0.8, glassC, boxAA(vec2(lu, hgt), vec2(dx0 + 0.15, 0.9), vec2(dx1 - 0.15, 2.1), fw)) * 0.8, doorM);
      sc = mix(sc, fcol, fas);
      // cornice above fascia
      sc = mix(sc, pil * 0.9, boxAA(vec2(lu, hgt), vec2(0.0, 3.45), vec2(uw, 3.55), fw));
      col = mix(sc, col, 0.0);
      bRough = mix(0.6, 0.16, win * (shutter ? 0.0 : 1.0));
      bMetal = 0.0; bBump = 0.0;
      bAO = mix(1.0, 0.7, doorM) * mix(1.0, 0.4, win);
    }
    if ((surf == 0 || (shop && hgt > 3.6)) && L > 1.8 && hgt < eave - 0.25 && hgt > 0.0) {
      float hOff = shop ? 3.6 : 0.0;
      float fh = industrial ? 4.2 : (kind == 6 ? 7.0 : 2.75);
      float nb = max(1.0, floor(L / (industrial ? 5.5 : 3.1) + 0.5));
      float bw = L / nb;
      float bay = floor(u / bw);
      float lu = u - bay * bw;
      float fl = shop ? 1.0 + floor((hgt - hOff) / fh) : floor(hgt / fh);
      float lh = shop ? (hgt - hOff) - (fl - 1.0) * fh : hgt - fl * fh;
      float bayH = hb(bay * 3.7 + seed * 1.3 + L);
      vec2 fw = vec2(fwidth(u), fwidth(hgt)) * 0.75;
      float winW = industrial ? min(bw * 0.7, 3.5) : (kind == 6 ? 1.0 : min(bw * 0.48, 1.35));
      float winB = industrial ? 2.2 : (kind == 6 ? 1.5 : 0.85), winT = industrial ? 3.4 : (kind == 6 ? 5.5 : 2.2);
      if (fl == 0.0 && !industrial) { winB = 0.9; winT = 2.15; }
      float topLimit = eave - 0.2 - (shop ? hOff + (fl - 1.0) * fh : fl * fh);
      winT = min(winT, topLimit - 0.25);
      bool door = (fl == 0.0) && (bayH < (industrial ? 0.2 : 0.33)) && L > 4.0;
      vec2 lo = vec2(bw * 0.5 - winW * 0.5, winB), hi = vec2(bw * 0.5 + winW * 0.5, winT);
      if (door) { lo = vec2(bw * 0.5 - (industrial ? 1.8 : 0.48), 0.02); hi = vec2(bw * 0.5 + (industrial ? 1.8 : 0.48), industrial ? 3.6 : 2.05); }
      bool skip = (industrial && fl > 0.0) || (!door && bayH > 0.93 && !industrial);
      if (!skip && winT > winB + 0.4) {
        vec2 lp = vec2(lu, lh);
        float frame = boxAA(lp, lo - 0.07, hi + 0.07, fw);
        float glass = boxAA(lp, lo, hi, fw);
        float sill = boxAA(lp, vec2(lo.x - 0.12, lo.y - 0.14), vec2(hi.x + 0.12, lo.y - 0.04), fw) * (door ? 0.0 : 1.0);
        float lintel = boxAA(lp, vec2(lo.x - 0.14, hi.y + 0.07), vec2(hi.x + 0.14, hi.y + 0.28), fw) * ((stone || brick) && !industrial ? 1.0 : 0.0);
        float reveal = boxAA(lp, vec2(lo.x, hi.y - 0.12), hi, fw) + boxAA(lp, lo, vec2(lo.x + 0.07, hi.y), fw);
        // window muntin
        float mull = door ? 0.0 : (1.0 - smoothstep(0.02, 0.02 + fw.x, abs(lu - bw * 0.5))) * glass;
        // sash meeting rail on older (dressed / stone / town-centre) buildings
        if (!door && !industrial && (dress || stone || shop || brick)) mull = max(mull, (1.0 - smoothstep(0.025, 0.025 + fw.y, abs(lh - (lo.y + hi.y) * 0.5))) * glass);
        float fade = 1.0 - smoothstep(250.0, 700.0, dist);
        vec3 frameCol = (c >= 6 || bayH < 0.6 || shop) ? lin3(vec3(0.85, 0.85, 0.83)) : lin3(vec3(0.18, 0.18, 0.2));
        vec3 glassCol = lin3(vec3(0.035, 0.04, 0.05)) + lin3(vec3(0.12, 0.10, 0.08)) * hb(bay + fl * 7.0 + seed) * 0.3;
        vec3 doorCol = industrial ? lin3(vec3(0.45, 0.47, 0.48)) : (hb(seed + bay) < 0.5 ? lin3(vec3(0.12, 0.16, 0.30)) : lin3(vec3(0.35, 0.06, 0.06)));
        col = mix(col, frameCol, frame * fade);
        float surround = dress && c == 9 ? clamp(boxAA(lp, lo - 0.2, hi + 0.2, fw) - frame, 0.0, 1.0) : 0.0;
        col = mix(col, dress ? dressCol : lin3(vec3(0.62, 0.58, 0.50)) * (0.9 + 0.1 * n4.r), max(max(sill, lintel), surround) * fade);
        if (door) { col = mix(col, doorCol, glass * fade); bRough = mix(bRough, 0.5, glass * fade); }
        else {
          col = mix(col, glassCol * (1.0 - 0.6 * clamp(reveal, 0.0, 1.0)), glass * fade);
          col = mix(col, frameCol, mull * fade);
          bRough = mix(bRough, 0.18, glass * fade * (1.0 - mull));
          bAO *= mix(1.0, 0.55, glass * fade);
          bMetal = mix(bMetal, 0.0, glass * fade);
        }
        bBump = mix(bBump, 0.0, frame);
        // far: simple darker band suggestion
        float far = smoothstep(250.0, 700.0, dist);
        col = mix(col, col * 0.9, far * 0.3);
      }
    }
    bAlb = col;
  } else if (surf == 1) {
    // pitched roof tiles / slates: courses on constant height lines
    vec3 along = normalize(cross(Nw, vec3(0.0, 1.0, 0.0)) + vec3(1e-5));
    float slope = sqrt(max(1.0 - Nw.y * Nw.y, 0.05));
    float down = w.y / slope; // distance along slope
    float ac = dot(w, along);
    bool slate = (c == 4 || c == 5 || kind == 1 || c == 2 || kind == 6 || c >= 8);
    vec3 rc = slate ? lin3(vec3(0.29, 0.31, 0.345)) : (c == 0 || c == 3) ? lin3(vec3(0.44, 0.29, 0.23)) : (c == 6) ? lin3(vec3(0.34, 0.28, 0.24)) : lin3(vec3(0.31, 0.31, 0.31));
    if (industrial) rc = lin3(vec3(0.42, 0.43, 0.44));
    vec2 tp = slate ? vec2(ac / 0.3, down / 0.22) : vec2(ac / 0.33, down / 0.26);
    float row = floor(tp.y);
    tp.x += mod(row, 2.0) * 0.5;
    vec2 f = fract(tp); vec2 fw = fwidth(tp);
    float aa = smoothstep(0.15, 0.5, max(fw.x, fw.y));
    float shadow = mix(smoothstep(0.0, 0.35, f.y) * 0.4 + 0.6, 0.8, aa);
    float gap = mix(smoothstep(0.0, 0.06 + fw.x, min(f.x, 1.0 - f.x)), 1.0, aa);
    float th = hb(floor(tp.x) + row * 13.1 + seed);
    vec3 col = rc * (0.85 + 0.3 * th * (1.0 - aa)) * shadow * (0.75 + 0.25 * gap);
    col = mix(col, lin3(vec3(0.30, 0.33, 0.18)), smoothstep(0.62, 0.85, n3.g) * 0.35); // moss
    bAlb = col * (0.9 + 0.15 * n4.b);
    bRough = slate ? 0.72 : 0.8;
    bBump = shadow * 0.7;
  } else if (surf == 6) {
    bAlb = lin3(vec3(0.52, 0.28, 0.18)) * (0.8 + 0.3 * n4.r); bRough = 0.85;
  } else if (surf == 4) {
    bAlb = lin3(vec3(0.16, 0.15, 0.14)); bRough = 0.9; bAO = 0.6;
  } else {
    // flat roof: felt / gravel / metal
    vec3 col = industrial ? lin3(vec3(0.46, 0.47, 0.47)) : lin3(vec3(0.20, 0.20, 0.21));
    col *= 0.8 + 0.3 * n4.r;
    if (industrial) { float rib = 0.5 + 0.5 * sin(w.x * 6.2831 / 0.3); col *= 0.92 + 0.08 * mix(rib, 0.5, clamp(fwidth(w.x / 0.3), 0.0, 1.0)); bMetal = 0.4; bRough = 0.45; }
    col = mix(col, col * 0.6, smoothstep(0.55, 0.8, n3.r) * 0.6);
    bAlb = col; bRough = industrial ? 0.45 : 0.9;
  }
  hbSun = bakedSun(w);
}
`;

export async function createBuildings(features, slicer, onProgress, tcIdx = null) {
  const cells = new Map();
  const rnd = mulberry32(1234);
  const list = features.buildings;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const q = b.p[0];
    if (!q) continue;
    const key = Math.floor(q[0] / CELL) + ',' + Math.floor(q[1] / CELL);
    let G = cells.get(key);
    if (!G) { G = new GeoBuf(); cells.set(key, G); }
    try { addBuilding(G, b, rnd, tcIdx); } catch (e) { /* skip broken footprint */ }
    if ((i & 63) === 0) { await slicer.tick(); onProgress && onProgress(i / list.length); }
  }
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0, envMapIntensity: 1.0 });
  const lightsBegin = THREE.ShaderChunk.lights_fragment_begin.replace(
    'getSunLightInfo( sunLight, directLight );', 'getSunLightInfo( sunLight, directLight ); directLight.color *= hbSun;');
  patchMaterial(mat, {
    key: 'buildings',
    vertexPars: 'attribute vec4 aW; attribute vec4 aB; varying vec4 vW; flat varying vec4 vB;',
    vertex: { begin_vertex: '$\n vW = aW; vB = aB;' },
    fragmentPars: BLD_FRAG,
    fragment: {
      map_fragment: `
        vec3 bNw = normalize((vec4(normalize(vNormal), 0.0) * viewMatrix).xyz);
        buildingSurface(vAerialWorld, bNw); diffuseColor.rgb = bAlb;`,
      roughnessmap_fragment: 'float roughnessFactor = bRough;',
      metalnessmap_fragment: 'float metalnessFactor = bMetal;',
      normal_fragment_begin: `$
        {
          vec3 dpdx = dFdx(vAerialWorld), dpdy = dFdy(vAerialWorld);
          float bx = dFdx(bBump), by = dFdy(bBump);
          vec3 r1 = cross(dpdy, bNw), r2 = cross(bNw, dpdx);
          float det = dot(dpdx, r1);
          vec3 grad = sign(det) * (bx * r1 + by * r2);
          float fade = 1.0 - smoothstep(15.0, 60.0, distance(vAerialWorld, cameraPosition));
          vec3 Nw2 = normalize(abs(det) * bNw - grad * 0.02 * fade);
          normal = normalize((viewMatrix * vec4(Nw2, 0.0)).xyz);
        }`,
      lights_fragment_begin: lightsBegin,
      aomap_fragment: 'reflectedLight.indirectDiffuse *= bAO; reflectedLight.indirectSpecular *= bAO;',
    },
  });
  const group = new THREE.Group();
  group.name = 'buildings';
  for (const G of cells.values()) {
    const geo = G.build();
    if (!geo) continue;
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    group.add(m);
  }
  return { group, material: mat };
}
