import * as THREE from 'three';
import { patchMaterial, GRID_GLSL } from './shared.js';
import { mulberry32 } from './heightfield.js';

const KINDS = ['house', 'terrace', 'residential', 'commercial', 'retail', 'industrial', 'church', 'school', 'garage', 'shed', 'other'];
const S_WALL = 0, S_ROOF = 1, S_FLAT = 2, S_CHIM = 3;
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
function addBuilding(G, b, rnd) {
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
  const c = (b.c | 0) & 7;
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
    for (let t = 0; t + 1 < ts.length; t++) {
      const t0 = ts[t], t1 = ts[t + 1];
      if (t1 - t0 < 1e-4) continue;
      const x0 = P[0] + ex * t0, z0 = P[1] + ez * t0, x1 = P[0] + ex * t1, z1 = P[1] + ez * t1;
      const uv0 = toUV(x0, z0), uv1 = toUV(x1, z1);
      const y0 = base + roofH(uv0[0], uv0[1]), y1 = base + roofH(uv1[0], uv1[1]);
      const a0 = G.v(x0, bottom, z0, nx, 0, nz, t0 * len, len, base, eaveAbs, c, kind, S_WALL, seed);
      const a1 = G.v(x1, bottom, z1, nx, 0, nz, t1 * len, len, base, eaveAbs, c, kind, S_WALL, seed);
      const b0 = G.v(x0, y0, z0, nx, 0, nz, t0 * len, len, base, eaveAbs, c, kind, S_WALL, seed);
      const b1 = G.v(x1, y1, z1, nx, 0, nz, t1 * len, len, base, eaveAbs, c, kind, S_WALL, seed);
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

  // ---- chimneys on houses / terraces
  if (roof !== 'flat' && (kind <= 2) && O.hl > 2.5) {
    const spots = [];
    if (kind === 1 || O.hl > 9) { for (let u = -O.hl + 3.5; u < O.hl - 2; u += 6.5 + rnd() * 1.5) spots.push(u); }
    else if (rnd() < 0.85) { spots.push((rnd() < 0.5 ? -1 : 1) * (O.hl - (roof === 'hipped' ? O.hw * 0.9 : 0.6))); if (rnd() < 0.35) spots.push(-spots[0]); }
    for (const u of spots) {
      const top = base + roofH(u, 0) + 0.9 + rnd() * 0.4;
      const yb = base + roofH(u, 0.5) - 0.6;
      const w = 0.45, d = 0.7;
      const corners = [[u - w, -d], [u + w, -d], [u + w, d], [u - w, d]].map((q) => toXZ(q[0], q[1]));
      const fn = [[-O.vx, -O.vz], [O.ux, O.uz], [O.vx, O.vz], [-O.ux, -O.uz]];
      for (let e = 0; e < 4; e++) {
        const P = corners[e], Q = corners[(e + 1) % 4];
        const [nx, nz] = fn[e];
        const ids = [G.v(P[0], yb, P[1], nx, 0, nz, 0, 1, base, eaveAbs, c, kind, S_CHIM, seed),
          G.v(Q[0], yb, Q[1], nx, 0, nz, 1, 1, base, eaveAbs, c, kind, S_CHIM, seed),
          G.v(P[0], top, P[1], nx, 0, nz, 0, 1, base, eaveAbs, c, kind, S_CHIM, seed),
          G.v(Q[0], top, Q[1], nx, 0, nz, 1, 1, base, eaveAbs, c, kind, S_CHIM, seed)];
        const ex = Q[0] - P[0], ez = Q[1] - P[1];
        if (ex * nz - ez * nx > 0) G.idx.push(ids[0], ids[1], ids[2], ids[2], ids[1], ids[3]); else G.idx.push(ids[0], ids[2], ids[1], ids[1], ids[2], ids[3]);
      }
      const tids = corners.map((q) => G.v(q[0], top, q[1], 0, 1, 0, 0, 0, base, eaveAbs, c, kind, S_FLAT, seed));
      const ny = (corners[1][1] - corners[0][1]) * (corners[2][0] - corners[0][0]) - (corners[1][0] - corners[0][0]) * (corners[2][1] - corners[0][1]);
      if (ny > 0) G.idx.push(tids[0], tids[1], tids[2], tids[0], tids[2], tids[3]); else G.idx.push(tids[0], tids[2], tids[1], tids[0], tids[3], tids[2]);
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
  if (c == 4) return lin3(vec3(0.56, 0.49, 0.37));
  if (c == 5) return lin3(vec3(0.40, 0.35, 0.28));
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
  if (surf == 0 || surf == 3) {
    float hgt = w.y - vW.z;           // above base
    float eave = vW.w - vW.z;
    float u = vW.x, L = vW.y;
    vec3 base = brickCol(c);
    bool brick = c <= 3 || (surf == 3);
    bool stone = c == 4 || c == 5 || kind == 6;
    if (kind == 6) base = lin3(vec3(0.50, 0.44, 0.34));
    vec3 col = base;
    if (industrial && surf == 0) {
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
      vec2 sp = vec2(u / 0.6, hgt / 0.28);
      float row = floor(sp.y);
      sp.x += hb(row + seed) ;
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
    if (surf == 0 && L > 1.8 && hgt < eave - 0.25 && hgt > 0.0) {
      float fh = industrial ? 4.2 : (kind == 6 ? 7.0 : 2.75);
      float nb = max(1.0, floor(L / (industrial ? 5.5 : 3.1) + 0.5));
      float bw = L / nb;
      float bay = floor(u / bw);
      float lu = u - bay * bw;
      float fl = floor(hgt / fh);
      float lh = hgt - fl * fh;
      float bayH = hb(bay * 3.7 + seed * 1.3 + L);
      vec2 fw = vec2(fwidth(u), fwidth(hgt)) * 0.75;
      float winW = industrial ? min(bw * 0.7, 3.5) : (kind == 6 ? 1.0 : min(bw * 0.48, 1.35));
      float winB = industrial ? 2.2 : (kind == 6 ? 1.5 : 0.85), winT = industrial ? 3.4 : (kind == 6 ? 5.5 : 2.2);
      if (fl == 0.0 && !industrial) { winB = 0.9; winT = 2.15; }
      float topLimit = eave - 0.2 - fl * fh;
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
        float fade = 1.0 - smoothstep(250.0, 700.0, dist);
        vec3 frameCol = (c >= 6 || bayH < 0.6) ? lin3(vec3(0.85, 0.85, 0.83)) : lin3(vec3(0.18, 0.18, 0.2));
        vec3 glassCol = lin3(vec3(0.035, 0.04, 0.05)) + lin3(vec3(0.12, 0.10, 0.08)) * hb(bay + fl * 7.0 + seed) * 0.3;
        vec3 doorCol = industrial ? lin3(vec3(0.45, 0.47, 0.48)) : (hb(seed + bay) < 0.5 ? lin3(vec3(0.12, 0.16, 0.30)) : lin3(vec3(0.35, 0.06, 0.06)));
        col = mix(col, frameCol, frame * fade);
        col = mix(col, lin3(vec3(0.62, 0.58, 0.50)) * (0.9 + 0.1 * n4.r), max(sill, lintel) * fade);
        if (door) { col = mix(col, doorCol, glass * fade); bRough = mix(bRough, 0.5, glass * fade); }
        else {
          col = mix(col, glassCol * (1.0 - 0.6 * clamp(reveal, 0.0, 1.0)), glass * fade);
          col = mix(col, frameCol, mull * fade);
          bRough = mix(bRough, 0.08, glass * fade * (1.0 - mull));
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
    bool slate = (c == 4 || c == 5 || kind == 1 || c == 2 || kind == 6);
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

export async function createBuildings(features, slicer, onProgress) {
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
    try { addBuilding(G, b, rnd); } catch (e) { /* skip broken footprint */ }
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
