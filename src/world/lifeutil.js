import * as THREE from 'three';
import { mulberry32 } from './heightfield.js';

// ---------------------------------------------------------------------------------------------
// Shared helpers for the "street life" systems (traffic, people, birds): a drivable road graph built
// from features.roads, path sampling without allocation, and instanced-mesh GLSL building blocks.
// ---------------------------------------------------------------------------------------------

export const DRIVE = {
  primary: { lim: 13.4, rank: 5 }, secondary: { lim: 13.4, rank: 4 }, tertiary: { lim: 12, rank: 3 },
  unclassified: { lim: 11, rank: 2 }, residential: { lim: 8.9, rank: 1 },
};
export const BUS_NAMES = new Set(['High Street', 'Northfield Lane', 'Wakefield Road', 'Bridge Road', 'Quarry Hill', 'Dewsbury Road', 'Horbury Road', 'Westfield Road']);

// Graph of drivable edges. Roads are split at junction vertices (shared endpoints and T-junctions,
// found by snapping road endpoints onto the nearest other road vertex within 2.5 m).
export function buildGraph(features) {
  const roads = features.roads.filter((r) => DRIVE[r.k] && !r.tu && r.p.length >= 2);
  let nv = 0;
  const base = new Int32Array(roads.length + 1);
  for (let i = 0; i < roads.length; i++) { base[i] = nv; nv += roads[i].p.length; }
  base[roads.length] = nv;
  const parent = new Int32Array(nv); for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const C = 3;
  const hash = new Map();
  const key = (cx, cz) => cx * 73856093 ^ cz * 19349663;
  const vroad = new Int32Array(nv);
  for (let i = 0; i < roads.length; i++) for (let j = 0; j < roads[i].p.length; j++) {
    const v = base[i] + j, p = roads[i].p[j];
    vroad[v] = i;
    const k = key(Math.floor(p[0] / C), Math.floor(p[2] / C));
    let a = hash.get(k); if (!a) { a = []; hash.set(k, a); } a.push(v);
  }
  const vp = (v) => { const i = vroad[v]; return roads[i].p[v - base[i]]; };
  for (let i = 0; i < roads.length; i++) {
    const n = roads[i].p.length;
    for (const j of [0, n - 1]) {
      const v = base[i] + j, p = roads[i].p[j];
      const cx = Math.floor(p[0] / C), cz = Math.floor(p[2] / C);
      let best = -1, bd = 2.5;
      for (let ax = -1; ax <= 1; ax++) for (let az = -1; az <= 1; az++) {
        const a = hash.get(key(cx + ax, cz + az)); if (!a) continue;
        for (const u of a) {
          if (vroad[u] === i) continue;
          const q = vp(u), d = Math.hypot(q[0] - p[0], q[2] - p[2]);
          if (d < bd && Math.abs(q[1] - p[1]) < 3) { bd = d; best = u; }
        }
      }
      if (best >= 0) unite(v, best);
    }
  }
  const size = new Int32Array(nv);
  for (let v = 0; v < nv; v++) size[find(v)]++;
  const nodeOf = new Map(); const nodes = [];
  const nodeId = (v) => {
    const r = find(v); let id = nodeOf.get(r);
    if (id === undefined) { id = nodes.length; nodeOf.set(r, id); const p = vp(v); nodes.push({ x: p[0], y: p[1], z: p[2], out: [] }); }
    return id;
  };
  const edges = [];
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i], n = r.p.length;
    let start = 0;
    for (let j = 1; j < n; j++) {
      const v = base[i] + j;
      if (j === n - 1 || size[find(v)] > 1) {
        if (j - start >= 1) {
          const m = j - start + 1;
          const e = { id: edges.length, a: nodeId(base[i] + start), b: nodeId(v), n: m, road: r, k: r.k, w: r._w || r.w || 5.5, name: r.n || '',
            lim: DRIVE[r.k].lim, rank: DRIVE[r.k].rank, x: new Float32Array(m), y: new Float32Array(m), z: new Float32Array(m), cum: new Float32Array(m),
            tx: new Float32Array(m), tz: new Float32Array(m), cap: new Float32Array(m), len: 0, bus: false };
          for (let q = 0; q < m; q++) {
            const p = r.p[start + q]; e.x[q] = p[0]; e.y[q] = p[1]; e.z[q] = p[2];
            if (q) e.cum[q] = e.cum[q - 1] + Math.hypot(e.x[q] - e.x[q - 1], e.z[q] - e.z[q - 1]);
          }
          e.len = e.cum[m - 1];
          if (e.len > 2) {
            for (let q = 0; q < m; q++) {
              const a = Math.max(0, q - 1), b = Math.min(m - 1, q + 1);
              let dx = e.x[b] - e.x[a], dz = e.z[b] - e.z[a]; const l = Math.hypot(dx, dz) || 1;
              e.tx[q] = dx / l; e.tz[q] = dz / l;
            }
            for (let q = 0; q < m; q++) {
              if (q === 0 || q === m - 1) { e.cap[q] = 99; continue; }
              const d0x = e.x[q] - e.x[q - 1], d0z = e.z[q] - e.z[q - 1], d1x = e.x[q + 1] - e.x[q], d1z = e.z[q + 1] - e.z[q];
              const l0 = Math.hypot(d0x, d0z) || 1, l1 = Math.hypot(d1x, d1z) || 1;
              const ang = Math.acos(Math.min(1, Math.max(-1, (d0x * d1x + d0z * d1z) / (l0 * l1))));
              const R = (l0 + l1) * 0.5 / Math.max(ang, 1e-3);
              e.cap[q] = Math.min(99, Math.max(3.2, Math.sqrt(2.4 * R)));
            }
            e.bus = (e.name && BUS_NAMES.has(e.name)) || e.rank >= 4;
            edges.push(e);
            nodes[e.a].out.push({ e, dir: 1 }); nodes[e.b].out.push({ e, dir: -1 });
          }
        }
        start = j;
      }
    }
  }
  // spatial grid of edge midpoints for spawning
  const G = 120, grid = new Map(), busGrid = new Map();
  const gk = (cx, cz) => cx * 10007 + cz;
  for (const e of edges) {
    const m = e.n >> 1, k = gk(Math.floor(e.x[m] / G), Math.floor(e.z[m] / G));
    let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(e);
    if (e.bus) { let b = busGrid.get(k); if (!b) { b = []; busGrid.set(k, b); } b.push(e); }
  }
  return { edges, nodes, grid, busGrid, G, gk };
}

const _o = { x: 0, y: 0, z: 0, tx: 0, tz: 1, sl: 0, cap: 99 };
// sample edge e travelling in `dir` at distance s from the travel start; result (travel tangent) in out
export function edgeAt(e, dir, s, out = _o) {
  const L = e.len;
  let u = dir > 0 ? s : L - s;
  u = u < 0 ? 0 : u > L ? L : u;
  let lo = 0, hi = e.n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (e.cum[m] <= u) lo = m; else hi = m; }
  const l = Math.max(1e-4, e.cum[hi] - e.cum[lo]), t = (u - e.cum[lo]) / l;
  out.x = e.x[lo] + (e.x[hi] - e.x[lo]) * t;
  out.y = e.y[lo] + (e.y[hi] - e.y[lo]) * t;
  out.z = e.z[lo] + (e.z[hi] - e.z[lo]) * t;
  let tx = e.tx[lo] + (e.tx[hi] - e.tx[lo]) * t, tz = e.tz[lo] + (e.tz[hi] - e.tz[lo]) * t;
  const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
  out.sl = (e.y[hi] - e.y[lo]) / l * dir;
  out.cap = Math.min(e.cap[lo], e.cap[hi]);
  out.tx = tx * dir; out.tz = tz * dir;
  return out;
}
// speed cap from curvature in the next `look` metres (so cars brake before bends)
export function curveLimit(e, dir, s, look, vNow, out) {
  const L = e.len;
  let m = 99;
  const u0 = dir > 0 ? s : L - s;
  for (let q = 1; q < e.n - 1; q++) {
    const d = dir > 0 ? e.cum[q] - u0 : u0 - e.cum[q];
    if (d < -1 || d > look) continue;
    const c = e.cap[q];
    m = Math.min(m, Math.sqrt(c * c + 2 * 3.0 * Math.max(0, d)));
  }
  return m;
}

// zebra crossings: position + road tangent + width, shared by traffic (stop) and people (cross)
export function buildCrossings(tc) {
  const out = [];
  if (!tc || !tc.crossings) return out;
  for (const c of tc.crossings) {
    const r = c.road; if (!r || !r.p) continue;
    let acc = 0, x = r.p[0][0], z = r.p[0][2], tx = 1, tz = 0, y = r.p[0][1];
    for (let i = 0; i + 1 < r.p.length; i++) {
      const a = r.p[i], b = r.p[i + 1], l = Math.hypot(b[0] - a[0], b[2] - a[2]);
      if (acc + l >= c.u || i + 2 === r.p.length) {
        const t = Math.min(1, Math.max(0, (c.u - acc) / (l || 1)));
        x = a[0] + (b[0] - a[0]) * t; z = a[2] + (b[2] - a[2]) * t; y = a[1] + (b[1] - a[1]) * t; tx = (b[0] - a[0]) / (l || 1); tz = (b[2] - a[2]) / (l || 1);
        break;
      }
      acc += l;
    }
    out.push({ x, y, z, tx, tz, w: r._w || 7, pave: r._pave || 2, timer: 0 });
  }
  return out;
}

export const rngFor = (seed) => mulberry32(seed);
export const TAU = Math.PI * 2;
// write a yaw+pitch+translation (no scale) into a column-major instance matrix array
export function setPose(arr, o, x, y, z, yaw, pitch, sx = 1, sy = 1, sz = 1) {
  const cy = Math.cos(yaw), sy_ = Math.sin(yaw), ca = Math.cos(pitch), sa = -Math.sin(pitch);
  // columns: X=(cy,0,-sy) Y=(sy*sa, ca, cy*sa) Z=(sy*ca, -sa, cy*ca)
  arr[o] = cy * sx; arr[o + 1] = 0; arr[o + 2] = -sy_ * sx; arr[o + 3] = 0;
  arr[o + 4] = sy_ * sa * sy; arr[o + 5] = ca * sy; arr[o + 6] = cy * sa * sy; arr[o + 7] = 0;
  arr[o + 8] = sy_ * ca * sz; arr[o + 9] = -sa * sz; arr[o + 10] = cy * ca * sz; arr[o + 11] = 0;
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
}

// Build a depth material (for shadow casting) that shares the vertex program of a patched colour material.
export function depthMaterialFor(vertexPars, beginVertex, beginNormal, uniforms) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + vertexPars)
      .replace('#include <begin_vertex>', beginVertex);
  };
  m.customProgramCacheKey = () => 'life-depth-' + vertexPars.length + beginVertex.length;
  void beginNormal;
  return m;
}
