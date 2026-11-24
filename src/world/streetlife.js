import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial, GRID_GLSL, OCC_GLSL } from './shared.js';
const OCC_FRAG = { alphatest_fragment: '$\n if (ign(gl_FragCoord.xy) > occFade(vAerialWorld)) discard;' };
import { hash2, mulberry32 } from './heightfield.js';

// ------------------------------------------------------------------ helpers
const fract = (x) => x - Math.floor(x);
// exact port of the terrain shader's h22 so 3D hedgerows sit on the painted field margins
function h22(px, py) {
  let x = fract(px * 0.1031), y = fract(py * 0.1030), z = fract(px * 0.0973);
  const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33);
  x += d; y += d; z += d;
  return [fract((x + y) * z), fract((x + z) * y)];
}
const FIELD = 165;

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

function lcAt(hf, lc, x, z) {
  const i = Math.round((x - hf.x0) / hf.res), j = Math.round((z - hf.z0) / hf.res);
  if (i < 0 || j < 0 || i >= hf.cols || j >= hf.rows) return 255;
  return lc[j * hf.cols + i];
}

// walk a road polyline at fixed spacing; cb(x, y, z, tx, tz, s)
function walk(p, step, cb) {
  let acc = 0, next = step * 0.5;
  for (let i = 0; i + 1 < p.length; i++) {
    const a = p[i], b = p[i + 1];
    const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (L < 1e-3) continue;
    const tx = (b[0] - a[0]) / L, tz = (b[2] - a[2]) / L;
    while (next <= acc + L) {
      const t = (next - acc) / L;
      cb(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, tx, tz, next);
      next += step;
    }
    acc += L;
  }
}

// ------------------------------------------------------------------ hedgerows (field boundaries + lanes)
export function generateHedgerows(features, hf, lc, roadIdx, bIdx) {
  const tmp = { seg: null, d: 0, t: 0, y: 0 };
  const rnd = mulberry32(4242);
  const walls = [], trees = [];
  const ok = (x, z, needFarm, nx, nz) => {
    const c = lcAt(hf, lc, x, z);
    if (!(c === 0 || c === 1 || c === 7)) return false;
    if (needFarm && lcAt(hf, lc, x + nx * 7, z + nz * 7) !== 1 && lcAt(hf, lc, x - nx * 7, z - nz * 7) !== 1) return false;
    if (roadIdx.query(x, z, 2.5, null, tmp)) return false;
    if (bIdx.find(x, z, 3)) return false;
    return true;
  };
  const flush = (run) => {
    if (run.length >= 3) {
      walls.push({ k: 'hedge', p: run.map((q) => [q[0], hf.sample(q[0], q[1]), q[1]]) });
      for (const q of run) if (rnd() < 0.045) { const h = 8 + rnd() * 8; trees.push([q[0], hf.sample(q[0], q[1]), q[1], h, h * (0.3 + rnd() * 0.12)]); }
    }
  };
  // field voronoi edges
  const seen = new Set();
  const i0 = Math.floor(hf.x0 / FIELD) - 1, i1 = Math.ceil((hf.x0 + hf.width) / FIELD) + 1;
  const j0 = Math.floor(hf.z0 / FIELD) - 1, j1 = Math.ceil((hf.z0 + hf.depth) / FIELD) + 1;
  const seed = (i, j) => { const o = h22(i, j); return [(i + o[0] * 0.8 + 0.1) * FIELD, (j + o[1] * 0.8 + 0.1) * FIELD]; };
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const s = seed(i, j);
    let poly = [[s[0] - 3 * FIELD, s[1] - 3 * FIELD], [s[0] + 3 * FIELD, s[1] - 3 * FIELD], [s[0] + 3 * FIELD, s[1] + 3 * FIELD], [s[0] - 3 * FIELD, s[1] + 3 * FIELD]];
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      if (!di && !dj) continue;
      const t = seed(i + di, j + dj);
      const a = s[0] - t[0], b = s[1] - t[1];
      poly = clipHalf(poly, a, b, (a * (s[0] + t[0]) + b * (s[1] + t[1])) / 2);
      if (poly.length < 3) break;
    }
    for (let e = 0; e < poly.length; e++) {
      const A = poly[e], B = poly[(e + 1) % poly.length];
      const key = Math.round((A[0] + B[0]) * 2) + ',' + Math.round((A[1] + B[1]) * 2);
      if (seen.has(key)) continue;
      seen.add(key);
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (L < 3) continue;
      const nx = -(B[1] - A[1]) / L, nz = (B[0] - A[0]) / L;
      let run = [];
      for (let d = 0; d <= L; d += 3) {
        const x = A[0] + (B[0] - A[0]) * d / L, z = A[1] + (B[1] - A[1]) * d / L;
        if (ok(x, z, true, nx, nz)) run.push([x, z]); else { flush(run); run = []; }
      }
      flush(run);
    }
  }
  // country lanes: hedges both sides
  for (const r of features.roads) {
    if (r.tu || r.br || r._pave || !['tertiary', 'unclassified', 'residential', 'track', 'secondary'].includes(r.k)) continue;
    const off = r._w / 2 + 1.4;
    for (const side of [-1, 1]) {
      let run = [];
      walk(r.p, 3, (x, y, z, tx, tz) => {
        const nx = tz * side, nz = -tx * side;
        const px = x + nx * off, pz = z + nz * off;
        const c = lcAt(hf, lc, px, pz);
        const good = (c === 0 || c === 1 || c === 7) && !roadIdx.query(px, pz, 1.2, null, tmp) && !bIdx.find(px, pz, 3);
        if (good) run.push([px, pz]); else { flush(run); run = []; }
      });
      flush(run);
    }
  }
  return { walls, trees };
}

// ------------------------------------------------------------------ instanced props near the camera
class NearSet {
  constructor(geo, mat, items, max, radius, hf, shadow = true) {
    this.items = items; // Float32Array stride 10: x y z yaw sx sy sz r g b
    this.n = items.length / 10;
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, Math.min(max, this.n)));
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.mesh.count * 3), 3);
    this.max = this.mesh.count; this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadow; this.mesh.receiveShadow = true;
    this.radius = radius;
    this.last = new THREE.Vector3(1e9, 0, 0);
    // grid
    const C = this.C = 96;
    this.gx = Math.ceil(hf.width / C) + 2; this.gz = Math.ceil(hf.depth / C) + 2; this.x0 = hf.x0 - C; this.z0 = hf.z0 - C;
    const cnt = new Int32Array(this.gx * this.gz + 1), cell = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const cx = Math.max(0, Math.min(this.gx - 1, Math.floor((items[i * 10] - this.x0) / C)));
      const cz = Math.max(0, Math.min(this.gz - 1, Math.floor((items[i * 10 + 2] - this.z0) / C)));
      cell[i] = cz * this.gx + cx; cnt[cell[i] + 1]++;
    }
    for (let c = 0; c < this.gx * this.gz; c++) cnt[c + 1] += cnt[c];
    this.start = cnt; this.order = new Int32Array(this.n);
    const fill = cnt.slice(0, this.gx * this.gz);
    for (let i = 0; i < this.n; i++) this.order[fill[cell[i]]++] = i;
  }
  update(cam, force) {
    const dx = cam.x - this.last.x, dz = cam.z - this.last.z;
    if (!force && dx * dx + dz * dz < 100) return;
    this.last.copy(cam);
    const R = this.radius, C = this.C, it = this.items;
    const e = this.mesh.instanceMatrix.array, col = this.mesh.instanceColor.array;
    let n = 0;
    const cx0 = Math.max(0, Math.floor((cam.x - R - this.x0) / C)), cx1 = Math.min(this.gx - 1, Math.floor((cam.x + R - this.x0) / C));
    const cz0 = Math.max(0, Math.floor((cam.z - R - this.z0) / C)), cz1 = Math.min(this.gz - 1, Math.floor((cam.z + R - this.z0) / C));
    for (let cz = cz0; cz <= cz1 && n < this.max; cz++) for (let cx = cx0; cx <= cx1 && n < this.max; cx++) {
      const c = cz * this.gx + cx;
      for (let k = this.start[c]; k < this.start[c + 1] && n < this.max; k++) {
        const i = this.order[k] * 10;
        const ddx = it[i] - cam.x, ddz = it[i + 2] - cam.z;
        if (ddx * ddx + ddz * ddz > R * R) continue;
        const cs = Math.cos(it[i + 3]), sn = Math.sin(it[i + 3]), o = n * 16;
        e[o] = cs * it[i + 4]; e[o + 1] = 0; e[o + 2] = -sn * it[i + 4]; e[o + 3] = 0;
        e[o + 4] = 0; e[o + 5] = it[i + 5]; e[o + 6] = 0; e[o + 7] = 0;
        e[o + 8] = sn * it[i + 6]; e[o + 9] = 0; e[o + 10] = cs * it[i + 6]; e[o + 11] = 0;
        e[o + 12] = it[i]; e[o + 13] = it[i + 1]; e[o + 14] = it[i + 2]; e[o + 15] = 1;
        col[n * 3] = it[i + 7]; col[n * 3 + 1] = it[i + 8]; col[n * 3 + 2] = it[i + 9];
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.clearUpdateRanges(); this.mesh.instanceMatrix.addUpdateRange(0, n * 16); this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.clearUpdateRanges(); this.mesh.instanceColor.addUpdateRange(0, n * 3); this.mesh.instanceColor.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ geometries
function colored(g, r, gg, b) {
  const n = g.attributes.position.count, c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = gg; c[i * 3 + 2] = b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (g.index) g = g.toNonIndexed();
  g.deleteAttribute('uv');
  return g;
}
function box(w, h, d, x, y, z, col) { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return colored(g, ...col); }

function carGeometry() {
  const P = [1, 1, 1], G = [0.035, 0.04, 0.05], T = [0.03, 0.03, 0.03], L = [0.9, 0.85, 0.75], R = [0.5, 0.05, 0.04];
  const parts = [
    box(1.74, 0.62, 4.15, 0, 0.62, 0, P), // body
    box(1.6, 0.5, 2.15, 0, 1.18, -0.2, G), // glasshouse
    box(1.5, 0.06, 1.95, 0, 1.45, -0.25, P), // roof
    box(1.62, 0.12, 0.5, 0, 0.92, 0.95, P), // bonnet slope helper
    box(1.5, 0.12, 0.05, 0, 0.66, 2.08, L), // headlights
    box(1.5, 0.1, 0.05, 0, 0.72, -2.08, R), // tail lights
  ];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const w = new THREE.CylinderGeometry(0.32, 0.32, 0.22, 12); w.rotateZ(Math.PI / 2); w.translate(sx * 0.78, 0.32, sz * 1.32);
    parts.push(colored(w, ...T));
  }
  return mergeGeometries(parts);
}
function lampGeometry() {
  const D = [0.16, 0.17, 0.18], H = [0.85, 0.82, 0.7];
  const pole = new THREE.CylinderGeometry(0.06, 0.09, 6.0, 8); pole.translate(0, 3.0, 0);
  const arm = new THREE.CylinderGeometry(0.04, 0.04, 1.1, 6); arm.rotateX(Math.PI / 2); arm.translate(0, 5.95, 0.5);
  return mergeGeometries([colored(pole, ...D), colored(arm, ...D), box(0.22, 0.12, 0.55, 0, 5.92, 1.05, D), box(0.18, 0.02, 0.45, 0, 5.85, 1.05, H)]);
}
function signGeometry() {
  const D = [0.35, 0.36, 0.37], Rd = [0.6, 0.04, 0.04], W = [0.9, 0.9, 0.9];
  const post = new THREE.CylinderGeometry(0.04, 0.04, 2.3, 6); post.translate(0, 1.15, 0);
  const tri = new THREE.CylinderGeometry(0.5, 0.5, 0.04, 3); tri.rotateX(Math.PI / 2); tri.translate(0, 2.15, 0.03);
  const triW = new THREE.CylinderGeometry(0.32, 0.32, 0.02, 3); triW.rotateX(Math.PI / 2); triW.translate(0, 2.15, 0.06);
  return mergeGeometries([colored(post, ...D), colored(tri, ...Rd), colored(triW, ...W)]);
}

const CAR_COLS = [[0.85, 0.85, 0.84], [0.55, 0.56, 0.58], [0.05, 0.05, 0.06], [0.08, 0.15, 0.35], [0.5, 0.06, 0.05], [0.3, 0.3, 0.32], [0.12, 0.25, 0.16], [0.62, 0.6, 0.55]];

// ------------------------------------------------------------------ main
export function createStreetLife(features, hf, lc, roadIdx, bIdx, routeIdx, giveWays, cfg) {
  const tmp = { seg: null, d: 0, t: 0, y: 0 };
  const rnd = mulberry32(99);
  const walls = [], hedges = [], lamps = [], cars = [], signs = [];
  const push = (arr, x, y, z, yaw, sx, sy, sz, c) => arr.push(x, y, z, yaw, sx, sy, sz, c[0], c[1], c[2]);
  const routeClear = (x, z, m) => !routeIdx.query(x, z, m, null, tmp);

  for (const r of features.roads) {
    if (r.tu || !r._pave || r.br) continue;
    const hw = r._w / 2, pw = r._pave, lift = 0.06;
    for (const side of [-1, 1]) {
      // --- front garden boundaries
      walk(r.p, 2.0, (x, y, z, tx, tz, s) => {
        const nx = tz * side, nz = -tx * side; // side=+1 -> left of travel
        const o = hw + pw + 0.25;
        const px = x + nx * o, pz = z + nz * o;
        if (bIdx.find(px + nx * 0.6, pz + nz * 0.6)) return; // house fronts the pavement
        let b = null;
        for (const d of [3, 5.5, 8, 11]) { b = bIdx.find(px + nx * d, pz + nz * d); if (b) break; }
        if (!b || !(b.k === 'house' || b.k === 'terrace' || b.k === 'residential')) return;
        if (roadIdx.query(px, pz, 1.0, (q) => q.ref !== r, tmp)) return;
        if (hash2(Math.floor(s / 6) + side * 0.37, x * 0.01 + z * 0.013) < 0.14) return; // driveway gaps
        const gy = hf.sample(px, pz);
        const yaw = Math.atan2(tx, tz);
        if ((b.c % 3) === 0) {
          const hh = 0.95 + hash2(b.p[0][0], b.p[0][1]) * 0.35;
          push(hedges, px + nx * 0.15, gy - 0.1, pz + nz * 0.15, yaw, 0.65, hh, 2.08, [0.75 + hash2(x, z) * 0.3, 0.9 + hash2(z, x) * 0.2, 0.8]);
        } else {
          const stone = b.c === 4 || b.c === 5;
          const col = stone ? [0.52, 0.46, 0.36] : b.c >= 6 ? [0.68, 0.66, 0.6] : [0.48, 0.24, 0.16];
          push(walls, px, gy - 0.25, pz, yaw, 0.3, 0.85 + hash2(b.p[0][1], b.p[0][0]) * 0.3, 2.04, col);
        }
      });
      // --- street lamps every ~30 m, alternating sides
      walk(r.p, 30, (x, y, z, tx, tz, s) => {
        if ((Math.round(s / 30) & 1) !== (side > 0 ? 1 : 0)) return;
        const nx = tz * side, nz = -tx * side, o = hw + pw - 0.45;
        const px = x + nx * o, pz = z + nz * o;
        if (bIdx.find(px, pz, 0.5) || roadIdx.query(px, pz, 0.3, (q) => q.ref !== r, tmp)) return;
        push(lamps, px, y + lift + 0.12, pz, Math.atan2(-nx, -nz), 1, 1, 1, [1, 1, 1]);
      });
    }
  }
  // --- parked cars on residential streets (terraces mostly), clear of the riding line and junctions
  for (const r of features.roads) {
    if (r.tu || r.br || !(r.k === 'residential' || ((r.k === 'tertiary' || r.k === 'unclassified') && r._pave)) || r._w < 5) continue;
    const hw = r._w / 2;
    for (const side of [-1, 1]) {
      walk(r.p, 6.4, (x, y, z, tx, tz, s) => {
        const nx = tz * side, nz = -tx * side, o = hw - 1.05;
        const px = x + nx * o, pz = z + nz * o;
        let b = null;
        for (const d of [3, 6, 9, 12]) { b = bIdx.find(x + nx * (hw + d), z + nz * (hw + d), 1); if (b) break; }
        const p = !b ? 0.03 : b.k === 'terrace' ? 0.6 : b.k === 'house' ? 0.2 : 0.08;
        if (rnd() > p) return;
        if (!routeClear(px, pz, 2.5 + 1.0)) return;
        if (roadIdx.query(x, z, 9, (q) => q.ref !== r && q.ref._w >= 2.5, tmp)) return;
        const yaw = Math.atan2(tx * side, tz * side) + (rnd() - 0.5) * 0.04;
        const c = CAR_COLS[Math.floor(rnd() * CAR_COLS.length)];
        push(cars, px, y + 0.06, pz, yaw, 1, 1, 1, c);
      });
    }
  }
  // --- give-way signs
  for (const g of giveWays) {
    const side = g.dir; // approach lane is on this side
    const o = g.hw + 0.5;
    const px = g.x + g.nx * side * o, pz = g.z + g.nz * side * o;
    if (bIdx.find(px, pz)) continue;
    // face approaching traffic: approach direction is along -dir*(tangent)
    const tx = -g.nz, tz = g.nx; // tangent from left normal
    const yaw = Math.atan2(tx * -side, tz * -side);
    signs.push(px, hf.sample(px, pz), pz, yaw, 1, 1, 1, 1, 1, 1);
  }

  const group = new THREE.Group(); group.name = 'streetlife';
  const sets = [];
  const R = cfg.propRadius;
  // shared props material (vertex colours x instance colour)
  const propMat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1, envMapIntensity: 1.0 }), { key: 'props', fragmentPars: OCC_GLSL, fragment: OCC_FRAG });
  const carMat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.35, envMapIntensity: 1.2 }), { key: 'cars', fragmentPars: OCC_GLSL, fragment: OCC_FRAG });
  const boundaryMat = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }), {
    key: 'gwall',
    fragmentPars: OCC_GLSL + 'uniform sampler2D uNoise; vec3 lin3(vec3 c) { return pow(c, vec3(2.2)); }',
    fragment: {
      ...OCC_FRAG,
      color_fragment: `$
        {
          vec3 w = vAerialWorld;
          vec4 n = texture2D(uNoise, (w.xz + w.y) / 0.9);
          vec2 st = vec2((w.x + w.z) / 0.42, w.y / 0.16);
          vec2 f = fract(st + vec2(fract(floor(st.y) * 0.5), 0.0));
          float j = smoothstep(0.0, 0.1, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
          diffuseColor.rgb = lin3(diffuseColor.rgb) * (0.65 + 0.35 * j) * (0.8 + 0.35 * n.r);
        }`,
    },
  });
  const hedgeMat = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), {
    key: 'ghedge',
    fragmentPars: OCC_GLSL + 'uniform sampler2D uNoise;',
    fragment: {
      ...OCC_FRAG,
      color_fragment: `$
        {
          vec3 w = vAerialWorld;
          vec4 n = texture2D(uNoise, (w.xz + w.y * 0.7) / 0.6);
          vec4 m = texture2D(uNoise, (w.xz - w.y) / 2.3);
          diffuseColor.rgb *= mix(vec3(0.05, 0.11, 0.03), vec3(0.13, 0.22, 0.06), n.a) * (0.7 + 0.5 * m.g);
        }`,
    },
  });
  const unitBox = new THREE.BoxGeometry(1, 1, 1); unitBox.translate(0, 0.5, 0);
  const hedgeGeo = new THREE.BoxGeometry(1, 1, 1, 1, 2, 2); hedgeGeo.translate(0, 0.5, 0);
  {
    // round the hedge tops a little
    const p = hedgeGeo.attributes.position;
    for (let i = 0; i < p.count; i++) if (p.getY(i) > 0.99) p.setX(i, p.getX(i) * 0.75);
    hedgeGeo.computeVertexNormals();
  }
  const mk = (geo, mat, arr, max, rad, shadow) => {
    if (!arr.length) return;
    const s = new NearSet(geo, mat, new Float32Array(arr), max, rad, hf, shadow);
    sets.push(s); group.add(s.mesh);
  };
  const lowF = cfg.tier === 'low' ? 0.5 : 1;
  mk(unitBox, boundaryMat, walls, 3000 * lowF, R * 0.7, true);
  mk(hedgeGeo, hedgeMat, hedges, 2000 * lowF, R * 0.7, true);
  mk(lampGeometry(), propMat, lamps, 600 * lowF, R, true);
  mk(carGeometry(), carMat, cars, 900 * lowF, R * 0.8, true);
  mk(signGeometry(), propMat, signs, 200, R * 0.6, false);
  const counts = { walls: walls.length / 10, hedges: hedges.length / 10, lamps: lamps.length / 10, cars: cars.length / 10, signs: signs.length / 10 };
  let scale = 1;
  return {
    group, counts,
    setRadiusScale(k) { if (k !== scale) { for (const s of sets) s.radius = s.radius / scale * k; scale = k; for (const s of sets) s.last.set(1e9, 0, 0); } },
    update(cam) { for (const s of sets) s.update(cam); },
  };
}
