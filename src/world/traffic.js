import * as THREE from 'three';
import { patchMaterial } from './shared.js';
import { buildGraph, edgeAt, curveLimit, buildCrossings, setPose, depthMaterialFor, BUS_NAMES } from './lifeutil.js';
import { mulberry32 } from './heightfield.js';

// ---------------------------------------------------------------------------------------------
// Moving traffic: cars (hatchback/saloon/SUV/van) and single-decker buses on the real road graph,
// driving on the LEFT. ONE instanced mesh for every vehicle (one draw call + one shadow draw):
// the body shape of each type is a table of boxes evaluated in the vertex shader (per-instance type),
// wheels are cylinders that spin from the distance the instance has travelled.
// ---------------------------------------------------------------------------------------------

// boxes: [cx, cy, cz, sx, sy, sz, taper, mat]  mat: 0 body 1 glass 2 dark trim 3 headlight 4 taillight 5 accent 6 light grey
const NB = 8;
const TYPES = [
  { name: 'hatch', wheel: [0.76, 1.25, -1.2, 0.31], boxes: [
    [0, 0.58, 0, 1.72, 0.52, 3.95, 0, 0], [0, 1.07, -0.1, 1.6, 0.44, 2.2, 0.3, 1], [0, 1.31, -0.1, 1.5, 0.06, 1.5, 0, 0],
    [0, 0.42, 1.97, 1.66, 0.2, 0.1, 0, 2], [0, 0.42, -1.97, 1.66, 0.2, 0.1, 0, 2], [0, 0.7, 1.98, 1.5, 0.1, 0.06, 0, 3], [0, 0.72, -1.98, 1.5, 0.1, 0.06, 0, 4], [0, 0, 0, 0, 0, 0, 0, 0]] },
  { name: 'saloon', wheel: [0.78, 1.45, -1.4, 0.32], boxes: [
    [0, 0.6, 0, 1.78, 0.55, 4.6, 0, 0], [0, 1.1, -0.2, 1.64, 0.44, 2.1, 0.3, 1], [0, 1.33, -0.2, 1.52, 0.06, 1.4, 0, 0],
    [0, 0.44, 2.27, 1.72, 0.2, 0.1, 0, 2], [0, 0.44, -2.27, 1.72, 0.2, 0.1, 0, 2], [0, 0.72, 2.3, 1.56, 0.1, 0.06, 0, 3], [0, 0.76, -2.3, 1.56, 0.1, 0.06, 0, 4], [0, 0, 0, 0, 0, 0, 0, 0]] },
  { name: 'suv', wheel: [0.82, 1.4, -1.35, 0.37], boxes: [
    [0, 0.86, 0, 1.9, 0.82, 4.5, 0, 0], [0, 1.46, -0.25, 1.78, 0.5, 2.7, 0.14, 1], [0, 1.73, -0.25, 1.72, 0.07, 2.5, 0, 0],
    [0, 0.55, 2.22, 1.86, 0.25, 0.12, 0, 2], [0, 0.55, -2.22, 1.86, 0.25, 0.12, 0, 2], [0, 0.95, 2.26, 1.64, 0.12, 0.06, 0, 3], [0, 0.98, -2.26, 1.64, 0.12, 0.06, 0, 4], [0, 0, 0, 0, 0, 0, 0, 0]] },
  { name: 'van', wheel: [0.86, 1.6, -1.55, 0.35], boxes: [
    [0, 0.95, 0, 2.0, 0.9, 5.2, 0, 0], [0, 1.78, -0.6, 2.0, 1.0, 3.9, 0.04, 0], [0, 1.62, 1.72, 1.86, 0.55, 1.15, 0.2, 1],
    [0, 0.58, 2.57, 1.96, 0.25, 0.12, 0, 2], [0, 0.58, -2.57, 1.96, 0.25, 0.12, 0, 2], [0, 1.0, 2.62, 1.7, 0.14, 0.06, 0, 3], [0, 1.05, -2.62, 1.7, 0.14, 0.06, 0, 4], [0, 2.3, -0.6, 1.9, 0.05, 3.7, 0, 6]] },
  { name: 'bus', wheel: [1.0, 3.3, -3.5, 0.5], boxes: [
    [0, 0.9, 0, 2.5, 1.1, 10.6, 0, 0], [0, 1.95, 0, 2.52, 0.95, 10.0, 0.0, 1], [0, 2.62, 0, 2.5, 0.38, 10.5, 0, 5],
    [0, 1.95, 5.31, 2.3, 0.9, 0.06, 0, 1], [0, 2.58, 5.33, 1.5, 0.22, 0.06, 0, 3], [0, 0.62, 5.32, 2.3, 0.2, 0.08, 0, 3], [0, 0.78, -5.32, 2.3, 0.22, 0.08, 0, 4], [0, 0.3, 0, 2.3, 0.15, 10.4, 0, 2]] },
];

const GLSL_PARS = /* glsl */`
uniform vec4 uBoxC[${TYPES.length * NB}];
uniform vec4 uBoxS[${TYPES.length * NB}];
uniform vec4 uWheel[${TYPES.length}];
attribute vec4 aInst;    // type, travelled distance, 0, 0
attribute vec3 aBody;
attribute vec3 aAcc;
attribute float aBox;
attribute float aShade;
varying vec3 vMatCol;
`;
const GLSL_NORMAL = /* glsl */`
vec3 objectNormal = vec3( normal );
if (aBox > 7.5) {
  int ty = int(aInst.x + 0.5);
  float ang = aInst.y / uWheel[ty].w;
  float ca = cos(ang), sa = sin(ang);
  objectNormal.yz = vec2(ca * objectNormal.y - sa * objectNormal.z, sa * objectNormal.y + ca * objectNormal.z);
}
`;
const GLSL_BEGIN = /* glsl */`
vec3 transformed;
{
  int ty = int(aInst.x + 0.5);
  vec3 col;
  if (aBox < 7.5) {
    int k = ty * ${NB} + int(aBox + 0.5);
    vec4 c = uBoxC[k]; vec4 sz = uBoxS[k];
    vec3 p = position;
    p.z *= 1.0 - c.w * (p.y + 0.5);
    transformed = p * sz.xyz + c.xyz;
    float m = sz.w;
    col = m < 0.5 ? aBody : m < 1.5 ? vec3(0.025, 0.04, 0.06) : m < 2.5 ? vec3(0.03) : m < 3.5 ? vec3(0.95, 0.88, 0.65) : m < 4.5 ? vec3(0.55, 0.03, 0.03) : m < 5.5 ? aAcc : vec3(0.62);
  } else {
    vec4 w = uWheel[ty];
    int wi = int(aBox + 0.5) - 8;
    float sx = (wi == 1 || wi == 3) ? 1.0 : -1.0;
    float zc = wi < 2 ? w.y : w.z;
    float ang = aInst.y / w.w;
    float ca = cos(ang), sa = sin(ang);
    vec3 p = position;
    p.yz = vec2(ca * p.y - sa * p.z, sa * p.y + ca * p.z);
    transformed = vec3(p.x * (w.w > 0.45 ? 0.32 : 0.24) + sx * w.x, p.y * 2.0 * w.w + w.w, p.z * 2.0 * w.w + zc);
    col = aShade < 0.5 ? vec3(0.022) : aShade < 1.5 ? vec3(0.62, 0.63, 0.65) : vec3(0.16);
  }
  vMatCol = col;
}
`;

function buildGeometry() {
  const pos = [], nor = [], box = [], shade = [], idx = [];
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const cp = cube.attributes.position.array, cn = cube.attributes.normal.array, ci = cube.index.array;
  for (let b = 0; b < NB; b++) {
    const o = pos.length / 3;
    for (let i = 0; i < cp.length; i += 3) { pos.push(cp[i], cp[i + 1], cp[i + 2]); nor.push(cn[i], cn[i + 1], cn[i + 2]); box.push(b); shade.push(0); }
    for (const k of ci) idx.push(o + k);
  }
  const SEG = 12;
  for (let w = 0; w < 4; w++) {
    // cylinder along x, radius 0.5, length 1; caps carry alternating light/dark segments (shows the spin)
    let o = pos.length / 3;
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2, y = Math.cos(a) * 0.5, z = Math.sin(a) * 0.5;
      for (const x of [-0.5, 0.5]) { pos.push(x, y, z); nor.push(0, Math.cos(a), Math.sin(a)); box.push(8 + w); shade.push(0); }
    }
    for (let i = 0; i < SEG; i++) { const a = o + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    for (const side of [-1, 1]) {
      for (let i = 0; i < SEG; i++) {
        o = pos.length / 3;
        const a0 = (i / SEG) * Math.PI * 2, a1 = ((i + 1) / SEG) * Math.PI * 2;
        const sh = i & 1 ? 1 : 2;
        pos.push(side * 0.5, 0, 0, side * 0.5, Math.cos(a0) * 0.42, Math.sin(a0) * 0.42, side * 0.5, Math.cos(a1) * 0.42, Math.sin(a1) * 0.42);
        for (let k = 0; k < 3; k++) { nor.push(side, 0, 0); box.push(8 + w); shade.push(sh); }
        if (side > 0) idx.push(o, o + 2, o + 1); else idx.push(o, o + 1, o + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aBox', new THREE.Float32BufferAttribute(box, 1));
  g.setAttribute('aShade', new THREE.Float32BufferAttribute(shade, 1));
  g.setIndex(idx);
  return g;
}

const CAR_COLS = [[0.8, 0.8, 0.8], [0.5, 0.52, 0.55], [0.04, 0.04, 0.05], [0.07, 0.14, 0.34], [0.5, 0.05, 0.04], [0.28, 0.28, 0.3], [0.1, 0.22, 0.14], [0.62, 0.58, 0.5], [0.85, 0.85, 0.86], [0.04, 0.04, 0.05], [0.3, 0.05, 0.08], [0.75, 0.55, 0.1]];
const VAN_COLS = [[0.8, 0.8, 0.8], [0.8, 0.8, 0.8], [0.45, 0.46, 0.5], [0.1, 0.2, 0.45], [0.7, 0.7, 0.72]];
const BUS_BODY = [0.9, 0.34, 0.04], BUS_ACC = [0.62, 0.05, 0.05];

export function createTraffic(scene, features, hf, cfg, ctx = {}) {
  const graph = buildGraph(features);
  const crossings = ctx.crossings || buildCrossings(ctx.tc);
  const nCars = cfg.tier === 'low' ? 14 : cfg.tier === 'medium' ? 26 : 38;
  const nBus = cfg.tier === 'low' ? 2 : cfg.tier === 'medium' ? 3 : 4;
  const N = nCars + nBus;
  const R_SPAWN = [190, 380], R_DESPAWN = 470;

  // ---- instanced mesh
  const geo = buildGeometry();
  const mesh = new THREE.InstancedMesh(geo, null, N);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const aInst = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4); aInst.setUsage(THREE.DynamicDrawUsage);
  const aBody = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  const aAcc = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  geo.setAttribute('aInst', aInst); geo.setAttribute('aBody', aBody); geo.setAttribute('aAcc', aAcc);
  const uBoxC = [], uBoxS = [], uWheel = [];
  for (const t of TYPES) {
    for (let i = 0; i < NB; i++) { const b = t.boxes[i]; uBoxC.push(new THREE.Vector4(b[0], b[1], b[2], b[6])); uBoxS.push(new THREE.Vector4(b[3], b[4], b[5], b[7])); }
    uWheel.push(new THREE.Vector4(...t.wheel));
  }
  const uniforms = { uBoxC: { value: uBoxC }, uBoxS: { value: uBoxS }, uWheel: { value: uWheel } };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.3, envMapIntensity: 1.2 });
  patchMaterial(mat, {
    key: 'traffic', uniforms,
    vertexPars: GLSL_PARS,
    vertex: { beginnormal_vertex: GLSL_NORMAL, begin_vertex: GLSL_BEGIN },
    fragmentPars: 'varying vec3 vMatCol;',
    fragment: { color_fragment: 'diffuseColor.rgb *= vMatCol;' },
  });
  mesh.material = mat;
  mesh.customDepthMaterial = depthMaterialFor(GLSL_PARS, GLSL_BEGIN, GLSL_NORMAL, uniforms);
  mesh.frustumCulled = false;
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.name = 'traffic';
  mesh.count = 0;
  scene.add(mesh);

  // ---- vehicles (pool)
  const rnd = mulberry32(4242);
  const veh = [];
  for (let i = 0; i < N; i++) {
    veh.push({ on: false, bus: i >= nCars, type: 0, e: null, dir: 1, s: 0, off: 0, offT: 0, v: 0, vf: 1, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
      bx: 0, bz: 0, byaw: 0, len: 4, hw: 0.9, spin: 0, stall: 0, ghost: 0, stop: 0, stopped: new Set(), lastStopE: -1, overtaking: false, slot: -1, idx: i });
  }
  // bus stops: a few along named main roads (one is on mid High Street, where the shelter is)
  const stops = [];
  for (const e of graph.edges) {
    if (!e.bus || e.len < 40 || !(BUS_NAMES.has(e.name))) continue;
    if (hashI(e.id) % 4 === 0 || (e.name === 'High Street')) stops.push({ e, s: e.len * 0.5 });
  }
  function hashI(i) { return (Math.imul(i, 2654435761) >>> 0) >>> 3; }

  const out = { x: 0, y: 0, z: 0, tx: 0, tz: 1, sl: 0, cap: 99 };
  const camP = new THREE.Vector3();
  const rider = { x: 0, z: 0, yaw: 0, v: 0, hw: 0.3, len: 1.8 };
  let timeSpawn = 0;

  function pickEdge(map, cx, cz) {
    const G = graph.G;
    for (let t = 0; t < 10; t++) {
      const a = rnd() * Math.PI * 2, r = R_SPAWN[0] + rnd() * (R_SPAWN[1] - R_SPAWN[0]);
      const gx = Math.floor((cx + Math.cos(a) * r) / G), gz = Math.floor((cz + Math.sin(a) * r) / G);
      const list = map.get(graph.gk(gx, gz));
      if (list && list.length) return list[(rnd() * list.length) | 0];
    }
    return null;
  }
  function laneOff(e) { return Math.min(2.0, Math.max(1.1, e.w * 0.26)); }

  function spawn(v, cx, cz) {
    const e = pickEdge(v.bus ? graph.busGrid : graph.grid, cx, cz);
    if (!e) return false;
    const dir = rnd() < 0.5 ? 1 : -1, s = rnd() * e.len;
    edgeAt(e, dir, s, out);
    const dc = Math.hypot(out.x - cx, out.z - cz);
    if (dc < R_SPAWN[0] * 0.9 || dc > R_DESPAWN - 30) return false;
    for (const o of veh) if (o.on && o !== v && Math.hypot(o.x - out.x, o.z - out.z) < 14) return false;
    v.on = true; v.e = e; v.dir = dir; v.s = s;
    v.off = laneOff(e); v.offT = v.off; v.v = Math.min(e.lim * 0.6, 6); v.bx = v.bz = v.byaw = 0;
    v.stall = 0; v.ghost = 0; v.stop = 0; v.overtaking = false; v.lastStopE = -1;
    if (v.bus) { v.type = 4; v.len = 10.6; v.hw = 1.25; v.vf = 0.9; }
    else {
      const r = rnd(); v.type = e.rank >= 3 && r < 0.12 ? 3 : r < 0.38 ? 0 : r < 0.62 ? 1 : r < 0.82 ? 2 : 3;
      v.len = [3.95, 4.6, 4.5, 5.2][v.type]; v.hw = v.type === 3 ? 1.0 : v.type === 2 ? 0.95 : 0.88; v.vf = 0.82 + rnd() * 0.3;
    }
    const cols = v.bus ? BUS_BODY : v.type === 3 ? VAN_COLS[(rnd() * VAN_COLS.length) | 0] : CAR_COLS[(rnd() * CAR_COLS.length) | 0];
    const i = v.idx;
    aBody.setXYZ(i, cols[0], cols[1], cols[2]);
    aAcc.setXYZ(i, BUS_ACC[0], BUS_ACC[1], BUS_ACC[2]);
    v.px = undefined;
    place(v, 0, true);
    return true;
  }

  function place(v, dt, snap) {
    const e = v.e;
    edgeAt(e, v.dir, v.s, out);
    const o = v.off;
    const tx = out.x + out.tz * o, tz = out.z - out.tx * o;
    let yaw = Math.atan2(out.tx, out.tz);
    const k = snap ? 1 : 1;
    void k;
    if (snap) { v.bx = v.bz = v.byaw = 0; }
    else {
      const d = Math.exp(-dt * 3.5);
      v.bx *= d; v.bz *= d; v.byaw *= d;
    }
    v.x = tx + v.bx; v.z = tz + v.bz; v.y = out.y + 0.06; v.yaw = yaw + v.byaw; v.pitch = Math.atan(out.sl);
    v.tx = out.tx; v.tz = out.tz;
  }

  function nextEdge(v) {
    const e = v.e, node = graph.nodes[v.dir > 0 ? e.b : e.a];
    let best = null, tot = 0;
    const cand = node.out;
    for (let i = 0; i < cand.length; i++) {
      const c = cand[i];
      if (c.e === e && cand.length > 1) continue;
      if (v.bus && !c.e.bus) continue;
      const w = (c.e.name && c.e.name === e.name ? 2.2 : 1) * (0.6 + c.e.rank * 0.25) * (v.bus ? 1.5 : 1);
      tot += w; cand[i]._w = w;
    }
    let r = rnd() * tot;
    for (let i = 0; i < cand.length; i++) {
      const c = cand[i];
      if (c.e === e && cand.length > 1) continue;
      if (v.bus && !c.e.bus) continue;
      r -= c._w; if (r <= 0) { best = c; break; }
    }
    return best;
  }

  function update(dt, camPos, riderPos, riderYaw, riderSpeed, paused) {
    camP.copy(camPos);
    rider.x = riderPos.x; rider.z = riderPos.z; rider.yaw = riderYaw; rider.v = riderSpeed;
    if (dt > 0.1) dt = 0.1;
    if (paused) dt = 0;
    // crossing timers (set by people) decay
    for (const c of crossings) if (c.timer > 0) c.timer = Math.max(0, c.timer - dt);
    timeSpawn -= dt;
    let live = 0;
    for (let n = 0; n < N; n++) {
      const v = veh[n];
      if (!v.on) {
        if (timeSpawn <= 0 && dt > 0) { if (spawn(v, camP.x, camP.z)) timeSpawn = 0.25; }
        else if (dt === 0 && live < 0) { /* paused: nothing */ }
        continue;
      }
      if (dt > 0) step(v, dt);
      if (Math.hypot(v.x - camP.x, v.z - camP.z) > R_DESPAWN) { v.on = false; continue; }
    }
    // upload
    const arr = mesh.instanceMatrix.array, ai = aInst.array;
    for (let n = 0; n < N; n++) {
      const v = veh[n];
      if (!v.on) continue;
      setPose(arr, live * 16, v.x, v.y, v.z, v.yaw, v.pitch);
      ai[live * 4] = v.type; ai[live * 4 + 1] = v.spin;
      // colours are per pool slot; copy to live slot
      aBody.array[live * 3] = aBodyStore[v.idx * 3]; aBody.array[live * 3 + 1] = aBodyStore[v.idx * 3 + 1]; aBody.array[live * 3 + 2] = aBodyStore[v.idx * 3 + 2];
      aAcc.array[live * 3] = BUS_ACC[0]; aAcc.array[live * 3 + 1] = BUS_ACC[1]; aAcc.array[live * 3 + 2] = BUS_ACC[2];
      live++;
    }
    mesh.count = live;
    mesh.instanceMatrix.needsUpdate = true; aInst.needsUpdate = true; aBody.needsUpdate = true; aAcc.needsUpdate = true;
  }
  // body colours: kept in a separate store keyed by pool index (instance slots are compacted every frame)
  const aBodyStore = new Float32Array(N * 3);
  const _setBody = aBody.setXYZ.bind(aBody);
  aBody.setXYZ = (i, x, y, z) => { aBodyStore[i * 3] = x; aBodyStore[i * 3 + 1] = y; aBodyStore[i * 3 + 2] = z; void _setBody; };

  function step(v, dt) {
    const e = v.e;
    // --- target speed
    let vt = e.lim * v.vf;
    if (v.bus) vt = Math.min(vt, 11.5);
    const left = v.dir > 0 ? e.len - v.s : v.s; // not used directly: s is distance travelled along dir
    void left;
    const remain = e.len - v.s;
    const node = graph.nodes[v.dir > 0 ? e.b : e.a];
    const junction = node.out.length >= 3;
    if (remain < 40) vt = Math.min(vt, Math.sqrt((junction ? 3.5 : 6) ** 2 + 2 * 2.5 * Math.max(0, remain - 4)));
    vt = Math.min(vt, curveLimit(e, v.dir, v.s, 45, v.v));
    if (v.stop > 0) { vt = 0; v.stop -= dt; }
    else if (v.bus) {
      for (const st of stops) {
        if (st.e !== e || v.lastStopE === e.id) continue;
        const sPos = v.dir > 0 ? st.s : e.len - st.s;
        const d = sPos - v.s;
        if (d > -1 && d < 35) vt = Math.min(vt, Math.sqrt(2 * 2.2 * Math.max(0, d - 0.5)) + 0.4);
        if (d <= 1.0 && v.v < 0.8) { v.stop = 6 + rnd() * 5; v.lastStopE = e.id; }
      }
    }
    // --- obstacles (cars, buses, rider): nearest in front inside a lateral window
    let gap = 1e9, bv = 0, blockRider = false;
    const fx = v.tx, fz = v.tz;
    const lookRange = 14 + v.v * 1.8;
    if (v.ghost <= 0) {
      for (let n = -1; n < N; n++) {
        let ox, oz, ov, ohw, olen, isRider = false;
        if (n < 0) { ox = rider.x; oz = rider.z; ov = rider.v; ohw = rider.hw; olen = rider.len; isRider = true; }
        else { const o = veh[n]; if (o === v || !o.on) continue; ox = o.x; oz = o.z; ov = o.v; ohw = o.hw; olen = o.len; }
        const dx = ox - v.x, dz = oz - v.z;
        const along = dx * fx + dz * fz;
        if (along < 0.5 || along > lookRange + olen) continue;
        const lat = Math.abs(dx * fz - dz * fx);
        if (lat > v.hw + ohw + 0.35) continue;
        const g = along - (v.len + olen) * 0.5;
        if (g < gap) { gap = g; bv = ov; blockRider = isRider; }
      }
      // zebra crossings with someone on them
      for (const c of crossings) {
        if (c.timer <= 0) continue;
        const dx = c.x - v.x, dz = c.z - v.z;
        const along = dx * fx + dz * fz;
        if (along < 1 || along > 30) continue;
        if (Math.abs(dx * fz - dz * fx) > 6 || Math.abs(c.tx * fx + c.tz * fz) < 0.6) continue;
        const g = along - v.len * 0.5 - 3.2;
        if (g < gap) { gap = g; bv = 0; blockRider = false; }
      }
    }
    // --- overtake a slow cyclist when the oncoming lane is clear
    const lane = laneOff(e);
    if (blockRider && gap < 14 && rider.v < v.v * 0.8 + 3 && !v.bus && !v.overtaking && v.ghost <= 0) {
      let clear = true;
      for (const o of veh) {
        if (!o.on || o === v) continue;
        const dx = o.x - v.x, dz = o.z - v.z, al = dx * fx + dz * fz;
        if (al > -10 && al < 90 && Math.abs(dx * fz - dz * fx) < 9 && (o.tx * fx + o.tz * fz) < 0.3) { clear = false; break; }
      }
      if (clear) { v.overtaking = true; v.offT = -(lane + 0.55); }
    }
    if (v.overtaking) {
      const dx = rider.x - v.x, dz = rider.z - v.z, al = dx * fx + dz * fz;
      if (al < -12 || Math.hypot(dx, dz) > 60) { v.overtaking = false; v.offT = lane; }
    } else v.offT = lane;
    const dOff = v.offT - v.off;
    v.off += Math.max(-1.1 * dt, Math.min(1.1 * dt, dOff));
    // --- car following
    if (gap < 1e8) {
      const allow = Math.max(0, bv * 0.9 + (gap - (2.2 + v.v * 0.45)) * 1.1);
      vt = Math.min(vt, allow);
      if (v.overtaking) vt = Math.min(vt, Math.max(allow, 0) + 4); // keep rolling past
    }
    const a = vt > v.v ? (v.bus ? 1.2 : 2.0) : 6.5;
    v.v += Math.max(-a * dt, Math.min((vt > v.v ? 1 : 1) * 2.4 * dt, vt - v.v));
    if (v.v < 0) v.v = 0;
    if (v.v < 0.25 && gap < 6 && v.stop <= 0) { v.stall += dt; if (v.stall > 9) { v.ghost = 4; v.stall = 0; } } else v.stall = Math.max(0, v.stall - dt * 2);
    if (v.ghost > 0) v.ghost -= dt;
    const ds = v.v * dt;
    v.s += ds; v.spin += ds;
    if (v.s >= e.len) {
      const pickN = nextEdge(v);
      const ox = v.x, oz = v.z, oyaw = v.yaw;
      if (!pickN) { v.on = false; return; }
      const over = v.s - e.len;
      // U-turn at dead ends flips lane
      const uturn = pickN.e === e;
      v.e = pickN.e; v.dir = pickN.dir; v.s = Math.min(over, 4);
      if (uturn) v.off = -v.off;
      place(v, 0, true);
      v.bx = ox - v.x; v.bz = oz - v.z;
      let dy = oyaw - v.yaw; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
      v.byaw = dy; v.bx = Math.max(-6, Math.min(6, v.bx)); v.bz = Math.max(-6, Math.min(6, v.bz));
    } else place(v, dt, false);
  }

  // does any vehicle sit within r of (x,z)? (used by pedestrians before they step on a crossing)
  function carNear(x, z, r) {
    for (const v of veh) if (v.on && Math.hypot(v.x - x, v.z - z) < r) return true;
    return false;
  }
  return { mesh, update, carNear, crossings, graph, count: () => mesh.count, vehicles: veh };
}
