import * as THREE from 'three';
import { patchMaterial } from './shared.js';
import { buildGraph, edgeAt, curveLimit, buildCrossings, setPose, depthMaterialFor, BUS_NAMES } from './lifeutil.js';
import { mulberry32 } from './heightfield.js';
import { buildVehicles, TYPE_DEFS } from './vehicleGeo.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------------------------
// Moving traffic: cars (hatchback/saloon/SUV/van) and single-decker buses on the real road graph,
// driving on the LEFT. ONE instanced mesh for every vehicle (one draw call + one shadow draw):
// the body shape of each type is a table of boxes evaluated in the vertex shader (per-instance type),
// wheels are cylinders that spin from the distance the instance has travelled.
// ---------------------------------------------------------------------------------------------

const GLSL_PARS = /* glsl */`
uniform vec4 uWheel[2];  // per type in this mesh: half track, z front, z rear, radius
uniform float uBase;     // first type index in this mesh
attribute vec4 aInst;    // unused, travelled distance, far-LOD flag, 0
attribute vec3 aBody;
attribute vec3 aAcc;
attribute float aMat;
attribute float aType;
attribute float aWheel;
attribute float aDetail;
varying vec3 vMatCol;
varying float vRough;
varying float vMetal;
`;
const GLSL_NORMAL = /* glsl */`
vec3 objectNormal = vec3( normal );
if (aWheel > -0.5) {
  float ang = aInst.y / uWheel[int(aType - uBase + 0.5)].w;
  float ca = cos(ang), sa = sin(ang);
  objectNormal.yz = vec2(ca * objectNormal.y - sa * objectNormal.z, sa * objectNormal.y + ca * objectNormal.z);
}
`;
const GLSL_BEGIN = /* glsl */`
vec3 transformed = position;
{
  if (abs(aType - aInst.x) > 0.5) {
    transformed = vec3(0.0);                 // another type's geometry in a shared mesh: collapse
  } else if (aWheel > -0.5) {
    vec4 w = uWheel[int(aType - uBase + 0.5)];
    int wi = int(aWheel + 0.5);
    float sx = (wi == 1 || wi == 3) ? 1.0 : -1.0;
    float zc = wi < 2 ? w.y : w.z;
    float ang = aInst.y / w.w;
    float ca = cos(ang), sa = sin(ang);
    vec3 p = position;
    p.yz = vec2(ca * p.y - sa * p.z, sa * p.y + ca * p.z);
    transformed = vec3(p.x * w.w + sx * w.x, p.y * w.w + w.w, p.z * w.w + zc);
  }
  if (aDetail > 0.5 && aInst.z > 0.5) transformed = vec3(0.0);   // far LOD: drop plates, mirrors, rims, spokes, door lines
  float m = aMat;
  vec3 col = m < 0.5 ? aBody : m < 1.5 ? vec3(0.03, 0.04, 0.05) : m < 2.5 ? vec3(0.015) : m < 3.5 ? vec3(0.9, 0.88, 0.8) : m < 4.5 ? vec3(0.45, 0.02, 0.02)
    : m < 5.5 ? aAcc : m < 6.5 ? vec3(0.85) : m < 7.5 ? vec3(0.8, 0.6, 0.05) : m < 9.5 ? vec3(0.018) : m < 10.5 ? vec3(0.42, 0.43, 0.45) : vec3(0.035);
  vMatCol = col;
  vRough = m < 0.5 ? 0.26 : m < 1.5 ? 0.03 : m < 2.5 ? 0.55 : m < 3.5 ? 0.12 : m < 4.5 ? 0.2 : m < 5.5 ? 0.3 : m < 7.5 ? 0.5 : m < 9.5 ? 0.85 : m < 10.5 ? 0.4 : 0.8;
  vMetal = m < 0.5 ? 0.3 : m < 1.5 ? 0.55 : m < 2.5 ? 0.0 : m < 5.5 ? (m > 4.5 ? 0.3 : 0.0) : m < 9.5 ? 0.0 : m < 10.5 ? 0.85 : 0.0;
}
`;

const CAR_COLS = [[0.8, 0.8, 0.8], [0.5, 0.52, 0.55], [0.04, 0.04, 0.05], [0.07, 0.14, 0.34], [0.5, 0.05, 0.04], [0.28, 0.28, 0.3], [0.1, 0.22, 0.14], [0.62, 0.58, 0.5], [0.85, 0.85, 0.86], [0.04, 0.04, 0.05], [0.3, 0.05, 0.08], [0.75, 0.55, 0.1]];
const VAN_COLS = [[0.8, 0.8, 0.8], [0.8, 0.8, 0.8], [0.45, 0.46, 0.5], [0.1, 0.2, 0.45], [0.7, 0.7, 0.72]];
const BUS_BODY = [0.62, 0.12, 0.035], BUS_ACC = [0.42, 0.03, 0.03]; // original red-orange livery, no operator branding

export function createTraffic(scene, features, hf, cfg, ctx = {}) {
  const graph = buildGraph(features);
  const crossings = ctx.crossings || buildCrossings(ctx.tc);
  const nCars = cfg.tier === 'low' ? 14 : cfg.tier === 'medium' ? 26 : 38;
  const nBus = cfg.tier === 'low' ? 2 : cfg.tier === 'medium' ? 3 : 4;
  const N = nCars + nBus;
  const R_SPAWN = [110, 380], R_DESPAWN = 470;

  // ---- meshes: hatch+saloon, SUV+van, bus (3 meshes x 3 passes). A shared mesh carries both types' geometry and
  // collapses the one that does not match the instance, so draw calls stay low while vertex work stays modest.
  const geos = buildVehicles();
  const GROUPS = [[0, 1], [2, 3], [4]];
  const groupOf = [0, 0, 1, 1, 2];
  const meshes = GROUPS.map((types) => {
    const geo = types.length === 1 ? geos[types[0]] : mergeGeometries(types.map((t) => geos[t]));
    const cap = types.includes(4) ? nBus : nCars;
    const mesh = new THREE.InstancedMesh(geo, null, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const aInst = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); aInst.setUsage(THREE.DynamicDrawUsage);
    const aBody = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3); aBody.setUsage(THREE.DynamicDrawUsage);
    const aAcc = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3); aAcc.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aInst', aInst); geo.setAttribute('aBody', aBody); geo.setAttribute('aAcc', aAcc);
    const wh = [0, 1].map((i) => new THREE.Vector4(...TYPE_DEFS[types[Math.min(i, types.length - 1)]].wheel));
    const uniforms = { uWheel: { value: wh }, uBase: { value: types[0] } };
    const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.06, envMapIntensity: 1.3 });
    patchMaterial(mat, {
      key: 'traffic', uniforms,
      vertexPars: GLSL_PARS,
      vertex: { beginnormal_vertex: GLSL_NORMAL, begin_vertex: GLSL_BEGIN },
      fragmentPars: 'varying vec3 vMatCol; varying float vRough; varying float vMetal;',
      fragment: { lights_physical_fragment: '$\n material.clearcoat *= (vRough < 0.35 ? 1.0 : 0.0);', color_fragment: 'diffuseColor.rgb *= vMatCol;', roughnessmap_fragment: 'float roughnessFactor = vRough;', metalnessmap_fragment: 'float metalnessFactor = vMetal;' },
    });
    mesh.material = mat;
    mesh.customDepthMaterial = depthMaterialFor(GLSL_PARS, GLSL_BEGIN, GLSL_NORMAL, uniforms);
    mesh.customDepthMaterial.side = THREE.BackSide;   // back faces into the shadow map: no acne on roofs/bonnets
    mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = 'traffic-' + types.map((t) => TYPE_DEFS[t].name).join('+'); mesh.count = 0;
    scene.add(mesh);
    return { mesh, aInst, aBody, aAcc, cap };
  });
  const mesh = meshes[0].mesh; // (exposed for debugging)

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

  // pick an edge near a point 70-210 m ahead of the rider so traffic is always visible on the street being ridden
  function pickAhead(map) {
    const G = graph.G, ah = 70 + rnd() * 140, lat = (rnd() - 0.5) * 50;
    const px = rider.x + Math.sin(rider.yaw) * ah + Math.cos(rider.yaw) * lat, pz = rider.z + Math.cos(rider.yaw) * ah - Math.sin(rider.yaw) * lat;
    let best = null, bd = 60;
    const cx = Math.floor(px / G), cz = Math.floor(pz / G);
    for (let ax = -1; ax <= 1; ax++) for (let az = -1; az <= 1; az++) {
      const list = map.get(graph.gk(cx + ax, cz + az)); if (!list) continue;
      for (const e of list) { const m = e.n >> 1, d = Math.hypot(e.x[m] - px, e.z[m] - pz); if (d < bd && rnd() < 0.7) { bd = d; best = e; } }
    }
    return best;
  }
  function spawn(v, cx, cz) {
    const ahead = rnd() < 0.55 && rider.v >= 0;
    const e = (ahead && pickAhead(v.bus ? graph.busGrid : graph.grid)) || pickEdge(v.bus ? graph.busGrid : graph.grid, cx, cz);
    if (!e) return false;
    const dir = rnd() < 0.5 ? 1 : -1, s = rnd() * e.len;
    edgeAt(e, dir, s, out);
    const dc = Math.hypot(out.x - cx, out.z - cz);
    // never pop in right in front of the camera; ahead spawns may be much closer than the general ring
    if (dc < (ahead ? 75 : R_SPAWN[0] * 0.9) || dc > R_DESPAWN - 30) return false;
    for (const o of veh) if (o.on && o !== v && Math.hypot(o.x - out.x, o.z - out.z) < 16) return false;
    v.on = true; v.e = e; v.dir = dir; v.s = s;
    v.off = laneOff(e); v.offT = v.off; v.v = Math.min(e.lim * 0.6, 6); v.bx = v.bz = v.byaw = 0;
    v.stall = 0; v.ghost = 0; v.stop = 0; v.overtaking = false; v.lastStopE = -1;
    if (v.bus) { v.type = 4; v.len = TYPE_DEFS[4].L; v.hw = 1.25; v.vf = 0.9; }
    else {
      const r = rnd(); v.type = e.rank >= 3 && r < 0.12 ? 3 : r < 0.38 ? 0 : r < 0.62 ? 1 : r < 0.82 ? 2 : 3;
      v.len = TYPE_DEFS[v.type].L; v.hw = TYPE_DEFS[v.type].W / 2; v.vf = 0.82 + rnd() * 0.3;
    }
    const cols = v.bus ? BUS_BODY : v.type === 3 ? VAN_COLS[(rnd() * VAN_COLS.length) | 0] : CAR_COLS[(rnd() * CAR_COLS.length) | 0];
    v.cr = cols[0]; v.cg = cols[1]; v.cb = cols[2];
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
        if (timeSpawn <= 0 && dt > 0) { if (spawn(v, camP.x, camP.z)) timeSpawn = 0.15; }
        else if (dt === 0 && live < 0) { /* paused: nothing */ }
        continue;
      }
      if (dt > 0) step(v, dt);
      if (Math.hypot(v.x - camP.x, v.z - camP.z) > R_DESPAWN) { v.on = false; continue; }
    }
    // upload: compact each type into its own mesh
    for (let t = 0; t < meshes.length; t++) {
      const M = meshes[t], arr = M.mesh.instanceMatrix.array, ai = M.aInst.array, ab = M.aBody.array, aa = M.aAcc.array;
      let k = 0;
      for (let n = 0; n < N && k < M.cap; n++) {
        const v = veh[n];
        if (!v.on || groupOf[v.type] !== t) continue;
        setPose(arr, k * 16, v.x, v.y, v.z, v.yaw, v.pitch);
        const dx = v.x - camP.x, dz = v.z - camP.z;
        ai[k * 4] = v.type; ai[k * 4 + 1] = v.spin; ai[k * 4 + 2] = dx * dx + dz * dz > 120 * 120 ? 1 : 0; ai[k * 4 + 3] = 0;
        ab[k * 3] = v.cr; ab[k * 3 + 1] = v.cg; ab[k * 3 + 2] = v.cb;
        aa[k * 3] = BUS_ACC[0]; aa[k * 3 + 1] = BUS_ACC[1]; aa[k * 3 + 2] = BUS_ACC[2];
        k++;
      }
      M.mesh.count = k; live += k;
      M.mesh.instanceMatrix.needsUpdate = true; M.aInst.needsUpdate = true; M.aBody.needsUpdate = true; M.aAcc.needsUpdate = true;
    }
  }

  const fx0 = (v) => v.tx, fz0 = (v) => v.tz;
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
    // a cyclist closing from behind: don't dawdle (the rider has no avoidance, so slow cars would be ridden through)
    v.closing = false; v.rAlong = 99;
    { const rdx = v.x - rider.x, rdz = v.z - rider.z, ra = rdx * fx0(v) + rdz * fz0(v);
      if (ra > 0 && ra < 45 && Math.abs(rdx * fz0(v) - rdz * fx0(v)) < 3.2 && rider.v > v.v - 0.5) {
        v.closing = true; v.rAlong = ra;
        vt = Math.max(vt, Math.min(e.lim * 1.1, rider.v + 2.5));
        if (v.stop > 0 && ra < 70) v.stop = 0;           // buses and cars cancel a stop in the rider's path
      } }
    if (v.stop > 0) { vt = 0; v.stop -= dt; }
    else if (v.bus) {
      for (const st of stops) {
        if (st.e !== e || v.lastStopE === e.id) continue;
        const sPos = v.dir > 0 ? st.s : e.len - st.s;
        const d = sPos - v.s;
        if (d > -1 && d < 35) vt = Math.min(vt, Math.sqrt(2 * 2.2 * Math.max(0, d - 0.5)) + 0.4);
        if (d <= 1.0 && v.v < 0.8) { v.lastStopE = e.id; const rd = Math.hypot(rider.x - v.x, rider.z - v.z); if (rd > 90) v.stop = 6 + rnd() * 5; }
      }
    }
    // --- obstacles (cars, buses, rider): nearest in front inside a lateral window
    let gap = 1e9, bv = 0, blockRider = false;
    const fx = v.tx, fz = v.tz;
    const lookRange = 14 + v.v * 1.8;
    {
      for (let n = -2; n < N; n++) {
        let ox, oz, ov, ohw, olen, isRider = false;
        if (v.ghost > 0 && n >= 0) continue; // ghost mode (deadlock breaker) only ignores other vehicles, never the rider
        if (n === -2) { // the chase camera sits behind the rider: same-direction traffic must not drive into it
          if (v.tx * Math.sin(rider.yaw) + v.tz * Math.cos(rider.yaw) < 0.5) continue;
          ox = camP.x; oz = camP.z; ov = rider.v; ohw = 1.0; olen = 1.5;
        } else if (n === -1) { ox = rider.x; oz = rider.z; ov = rider.v; ohw = rider.hw; olen = rider.len; isRider = true; }
        else { const o = veh[n]; if (o === v || !o.on) continue; ox = o.x; oz = o.z; ov = o.v; ohw = o.hw; olen = o.len; }
        const dx = ox - v.x, dz = oz - v.z;
        const along = dx * fx + dz * fz;
        if (along < 0.5 || along > lookRange + olen) continue;
        const lat = Math.abs(dx * fz - dz * fx);
        if (lat > v.hw + ohw + 0.35) continue;
        const g = along - (v.len + olen) * 0.5 - (isRider ? 11 : 0); // keep clear of the chase camera (up to ~9 m behind the rider)
        if (g < gap) { gap = g; bv = ov; blockRider = isRider; }
      }
      // zebra crossings with someone on them
      if (v.ghost <= 0) for (const c of crossings) {
        if (c.timer <= 0 && !c.hold) continue;
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
    if (blockRider && gap < 24 && rider.v < v.v * 0.8 + 3 && !v.bus && !v.overtaking && v.ghost <= 0) {
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
    } else v.offT = v.closing ? Math.max(lane, Math.min(lane + 0.9, e.w * 0.5 - v.hw - 0.05)) : lane;   // hug the kerb for a closing cyclist
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
    if (v.v < 0.25 && gap < 6 && v.stop <= 0) { v.stall += dt; if (v.stall > 30) { v.ghost = 2.5; v.stall = 0; } } else v.stall = Math.max(0, v.stall - dt * 2);
    if (v.ghost > 0) v.ghost -= dt;
    // slower than the rider, still in its path and about to be ridden through: turn off (despawn)
    if (v.closing && v.rAlong < 4 && v.v < rider.v - 1 && v.stop <= 0) { v.on = false; return; }
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
      void uturn; // lane offset stays on the left of the NEW travel direction
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
  // API for the pedestrian system: crossings are indexed like ctx.tc.crossings (see buildCrossings).
  //   requestStop(i, true)  -> cars approaching crossing i brake to a halt before it; requestStop(i, false) releases them
  //   requestStop(i, true, seconds) -> auto-release after `seconds` (refresh each frame while someone is on the crossing)
  function requestStop(i, on, seconds = 0) {
    const c = crossings[i]; if (!c) return;
    if (on && seconds > 0) { c.timer = seconds; c.hold = false; } else { c.hold = !!on; if (!on) c.timer = 0; }
  }
  return { mesh, meshes: meshes.map((m) => m.mesh), update, carNear, requestStop, crossings, graph, count: () => meshes.reduce((a, m) => a + m.mesh.count, 0), vehicles: veh };
}
