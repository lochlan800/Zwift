import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './heightfield.js';
import { patchMaterial, OCC_GLSL } from './shared.js';
import { foliageTexture } from './trees.js';

// Small-scale versions of the tree crown builder: opaque dark core + many alpha-tested leaf cards on the surface.
// Used for Storrs Hill scrub (hawthorn / elder / bramble) and clipped garden hedges (privet / beech).
// Atlas cells (see trees.js): 0 oak, 1 sycamore+beech (broad), 2 ash+birch (small leaves).
const AH = 1152, CELLPX = 512;
function cellUV(cell) {
  const u0 = (cell % 2) * 0.5, v1 = 1 - Math.floor(cell / 2) * CELLPX / AH, v0 = v1 - CELLPX / AH;
  const e = 2 / 1024, ev = 2 / AH;
  return [u0 + e, v0 + ev, u0 + 0.5 - e, v1 - ev];
}
const OPAQUE_UV = [0.25, 0.05];

class Builder {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; this.idx = []; this.v = 0; }
  card(c, ax, ay, hs, cell, col, n) {
    const [u0, v0, u1, v1] = cellUV(cell);
    const base = this.v;
    const ci = [-1, 1, 1, -1], cj = [-1, -1, 1, 1];
    for (let q = 0; q < 4; q++) {
      const i = ci[q], j = cj[q];
      this.pos.push(c[0] + (ax[0] * i + ay[0] * j) * hs[0], c[1] + (ax[1] * i + ay[1] * j) * hs[1], c[2] + (ax[2] * i + ay[2] * j) * hs[2]);
      this.nor.push(n[0], n[1], n[2]);
      this.uv.push(u0 + (i * 0.5 + 0.5) * (u1 - u0), v0 + (j * 0.5 + 0.5) * (v1 - v0));
      this.col.push(col[0], col[1], col[2]);
      this.v++;
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  tri(p, n, col) { this.pos.push(...p); this.nor.push(...n); this.uv.push(OPAQUE_UV[0], OPAQUE_UV[1]); this.col.push(...col); this.idx.push(this.v++); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    return g;
  }
}

const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function axes(nc, rnd) {
  const up = Math.abs(nc[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const a = norm(cross(nc, up)), b = cross(nc, a);
  const r = rnd() * 6.283, cs = Math.cos(r), sn = Math.sin(r);
  return [[a[0] * cs + b[0] * sn, a[1] * cs + b[1] * sn, a[2] * cs + b[2] * sn], [-a[0] * sn + b[0] * cs, -a[1] * sn + b[1] * cs, -a[2] * sn + b[2] * cs]];
}
function icoCore(B, cx, cy, cz, rx, ry, rz, rnd, col) {
  const ico = new THREE.IcosahedronGeometry(1, 1);
  const p = ico.attributes.position;
  const ph = rnd() * 6;
  for (let i = 0; i < p.count; i++) {
    const dx = p.getX(i), dy = p.getY(i), dz = p.getZ(i);
    const nz = 1 + 0.16 * Math.sin(dx * 7 + ph) * Math.cos(dz * 6 - dy * 4);
    const x = cx + dx * rx * nz, y = Math.max(0.0, cy + dy * ry * nz), z = cz + dz * rz * nz;
    const n = norm([dx, dy + 0.1, dz]);
    B.tri([x, y, z], n, col);
  }
  ico.dispose();
}

// ragged leafy bush with a couple of taller stems poking out (elder / hawthorn / bramble)
export function scrubGeometry() {
  const rnd = mulberry32(7771);
  const B = new Builder();
  const lumps = [[0, 0.42, 0, 0.48, 0.4], [0.46, 0.34, 0.2, 0.36, 0.3], [-0.4, 0.36, -0.22, 0.38, 0.34], [0.05, 0.3, -0.5, 0.3, 0.26], [-0.12, 0.28, 0.5, 0.32, 0.27], [0.2, 0.95, -0.1, 0.3, 0.32]];
  for (const [x, y, z, r, ry] of lumps) icoCore(B, x, y, z, r * 0.7, ry * 0.7, r * 0.7, rnd, [0.05, 0.075, 0.03]);
  // thin stems (visible between the leaves)
  for (const [x, y, z] of [[0.2, 0.95, -0.1], [0.0, 0.5, 0.0]]) {
    const top = [x, y, z];
    for (let k = 0; k < 5; k++) {
      const a = k / 5 * 6.283, w = 0.015;
      const b0 = [Math.cos(a) * w, 0, Math.sin(a) * w], b1 = [Math.cos(a + 1.2566) * w, 0, Math.sin(a + 1.2566) * w];
      B.tri([b0[0], 0, b0[2]], [b0[0], 0.2, b0[2]], [0.09, 0.06, 0.04]);
      B.tri([b1[0], 0, b1[2]], [b1[0], 0.2, b1[2]], [0.09, 0.06, 0.04]);
      B.tri([top[0], top[1], top[2]], [0, 1, 0], [0.07, 0.05, 0.035]);
    }
  }
  // leaf cards on the surface of every lump: ragged silhouette
  const nCards = 110;
  for (let k = 0; k < nCards; k++) {
    const L = lumps[Math.floor(rnd() * lumps.length)];
    let d;
    do { d = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]; } while (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] > 1 || d[0] * d[0] + d[1] * d[1] + d[2] * d[2] < 0.05);
    d = norm(d);
    const f = 0.82 + rnd() * 0.4;
    const c = [L[0] + d[0] * L[3] * f, Math.max(0.03, L[1] + (d[1] < 0 ? d[1] * 0.6 : d[1]) * L[4] * f), L[2] + d[2] * L[3] * f];
    const nrm = norm([d[0], d[1] + 0.25, d[2]]);
    const [ax, ay] = axes(rnd() < 0.8 ? nrm : norm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]), rnd);
    const hs = 0.10 + rnd() * 0.07;
    const lit = 0.55 + 0.45 * Math.min(1, Math.max(0, (c[1] + 0.1) / 1.0)) + (rnd() - 0.5) * 0.2;
    const col = [0.62 * lit, 0.68 * lit, 0.42 * lit];
    B.card(c, ax, ay, [hs, hs, hs], rnd() < 0.55 ? 1 : 2, col, nrm);
  }
  return B.geometry();
}

// clipped garden hedge: flat top and sides, small dense leaves.  Instance scale is (0.65, ~1.1, 2.08).
export function clippedHedgeGeometry() {
  const rnd = mulberry32(991);
  const B = new Builder();
  const SX = 0.65, SY = 1.1, SZ = 2.08;
  // dark core: slightly inset box
  const bx = 0.455, by = 0.965, bz = 0.5;
  const faces = [
    { n: [0, 1, 0], p: [[-bx, by, -bz], [bx, by, -bz], [bx, by, bz], [-bx, by, bz]] },
    { n: [1, 0, 0], p: [[bx, 0, -bz], [bx, by, -bz], [bx, by, bz], [bx, 0, bz]] },
    { n: [-1, 0, 0], p: [[-bx, 0, bz], [-bx, by, bz], [-bx, by, -bz], [-bx, 0, -bz]] },
  ];
  for (const f of faces) {
    const q = f.p; const c = [0.04, 0.06, 0.025];
    B.tri(q[0], f.n, c); B.tri(q[1], f.n, c); B.tri(q[2], f.n, c); B.tri(q[0], f.n, c); B.tri(q[2], f.n, c); B.tri(q[3], f.n, c);
  }
  const hs = 0.10; // metres (half extent)
  const add = (c, nrm, tu, tv) => {
    // card lies on the face: tangent axes tu, tv in unit space, sized so it is isotropic in world space
    const rr = rnd() * 6.283, cs = Math.cos(rr), sn = Math.sin(rr);
    const ax = [tu[0] * cs + tv[0] * sn, tu[1] * cs + tv[1] * sn, tu[2] * cs + tv[2] * sn];
    const ay = [-tu[0] * sn + tv[0] * cs, -tu[1] * sn + tv[1] * cs, -tu[2] * sn + tv[2] * cs];
    // per-axis half extents in unit space (compensate non-uniform instance scale)
    const h = [hs * Math.hypot(ax[0] / SX, ay[0] / SX) / 1.0, hs * Math.hypot(ax[1] / SY, ay[1] / SY), hs * Math.hypot(ax[2] / SZ, ay[2] / SZ)];
    const shade = 0.62 + 0.4 * rnd();
    B.card(c, ax, ay, [hs / SX, hs / SY, hs / SZ].map((v, i) => v), rnd() < 0.8 ? 2 : 1, [0.6 * shade, 0.68 * shade, 0.4 * shade], nrm);
    void h;
  };
  // top
  for (let i = 0; i < 7; i++) for (let j = 0; j < 9; j++) add([(-0.5 + (i + rnd()) / 7) * 0.96, 1.0 + rnd() * 0.02, (-0.5 + (j + rnd()) / 9) * 1.0], [0, 1, 0.0], [1, 0, 0], [0, 0, 1]);
  // sides
  for (const s of [-1, 1]) for (let j = 0; j < 10; j++) for (let k = 0; k < 4; k++) add([s * (0.49 + rnd() * 0.02), (k + rnd()) / 4 * 0.98 + 0.04, (-0.5 + (j + rnd()) / 10)], norm([s, 0.3, 0]), [0, 0, 1], [0, 1, 0]);
  return B.geometry();
}

// alpha-tested leaf material (instanced; instance colour tints the vertex colours)
export function leafMaterial(key) {
  const mat = new THREE.MeshStandardMaterial({ map: foliageTexture(), alphaTest: 0.42, vertexColors: true, side: THREE.DoubleSide, roughness: 1.0, metalness: 0, envMapIntensity: 0.5 });
  patchMaterial(mat, {
    key, fragmentPars: OCC_GLSL,
    fragment: { alphatest_fragment: '$\n if (ign(gl_FragCoord.xy) > occFade(vAerialWorld)) discard;' },
  });
  return mat;
}
