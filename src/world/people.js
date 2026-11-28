import * as THREE from 'three';
import { patchMaterial, U } from './shared.js';
import { edgeAt, setPose, depthMaterialFor } from './lifeutil.js';
import { personGeometry, dogGeometry, PERSON_PARS, PERSON_NORMAL, PERSON_BEGIN, DOG_PARS, DOG_NORMAL, DOG_BEGIN } from './bodies.js';
import { mulberry32 } from './heightfield.js';

// ---------------------------------------------------------------------------------------------
// Pedestrians and dogs. Realistic proportions (1.55-1.9 m), muted everyday clothing, natural gait.
// One InstancedMesh for people and one for dogs. The walk cycle runs in the vertex shader: each body
// part rotates about its joint (hip, knee, shoulder, elbow) from a per-instance phase, so there is no
// per-frame CPU skinning. Pedestrians walk the pavements on both sides of the real road edges, some
// stand chatting by shop fronts, some cross at the zebra crossings (traffic stops for them).
// ---------------------------------------------------------------------------------------------

// clothing is never skin-toned: dark coats / navy / grey / green / burgundy, plus a few clean light tops (white, pale blue)
const SHIRTS = ['#2b3442', '#3a3d40', '#6b6f73', '#3f5a3a', '#7a3a35', '#e6e6e2', '#4d6a8a', '#16181a', '#c9d1d8', '#5a2f2f', '#2f4f4a', '#243a5e', '#8a2f3a', '#d8d8d4', '#4a4f55'];
const TROUS = ['#1d2a44', '#16181a', '#3c3f45', '#2b2f36', '#26334f', '#33302c', '#4b5058'];
const HAIR = ['#14100d', '#2a1c12', '#4a3320', '#8a6a3a', '#a9a9a6', '#c8b58a', '#0a0a0a'];
const DOGS = [['#7a5a35', '#e6dcc4'], ['#1a1a1a', '#6b6b6b'], ['#c9a46a', '#efe3c8'], ['#3b2a1f', '#8c6a45'], ['#e4ded2', '#bfb6a4']];
const col3 = (h) => new THREE.Color(h);

export function createPeople(scene, graph, features, cfg, ctx = {}) {
  const traffic = ctx.traffic || null;
  const crossings = (traffic && traffic.crossings) || ctx.crossings || [];
  const nWalk = cfg.tier === 'low' ? 18 : cfg.tier === 'medium' ? 34 : 56;
  const nDog = cfg.tier === 'low' ? 3 : cfg.tier === 'medium' ? 6 : 10;
  const nCross = crossings.length * 2;
  const N = nWalk + nCross;
  const rnd = mulberry32(777);
  const R_SPAWN = [50, 210], R_DESPAWN = 250;
  const shadow = cfg.tier === 'high';  // perf: no shadow pass for pedestrians on medium/low

  // ---- paved edges grid
  const G = graph.G, grid = new Map(), gk = graph.gk;
  for (const e of graph.edges) {
    if (!(e.road._pave > 0) || e.road._verge > 0 || e.len < 8) continue;   // paved footways only (no grass verges)
    const m = e.n >> 1, k = gk(Math.floor(e.x[m] / G), Math.floor(e.z[m] / G));
    let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(e);
  }

  function makeMesh(geo, count, pars, nrm, beg, key, person = false) {
    const mesh = new THREE.InstancedMesh(geo, null, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const attrs = {
      aMisc: new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4),
      aShirt: new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3),
      aTrou: new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3),
      aHair: new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3),
    };
    for (const k in attrs) { attrs[k].setUsage(THREE.DynamicDrawUsage); geo.setAttribute(k, attrs[k]); }
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0, envMapIntensity: 0.9 });
    patchMaterial(mat, {
      key, vertexPars: pars, vertex: { beginnormal_vertex: nrm, begin_vertex: beg },
      fragmentPars: person ? 'flat varying vec3 vMatCol; flat varying float vRough; varying float vObjY; varying float vCloth; varying vec3 vShirt; varying vec3 vTrou; varying float vCoatF;' : 'flat varying vec3 vMatCol; flat varying float vRough;',
      // clothing seams (top / coat hem / trousers) are resolved per pixel from the rest-pose height so edges stay crisp
      fragment: { color_fragment: person ? 'vec3 mc = vMatCol; if (vCloth > 0.5) mc = (vObjY > 0.96 || (vCoatF > 0.5 && vObjY > 0.77)) ? vShirt : vTrou; diffuseColor.rgb *= mc;' : 'diffuseColor.rgb *= vMatCol;', roughnessmap_fragment: 'float roughnessFactor = vRough;' },
    });
    mesh.material = mat;
    mesh.customDepthMaterial = depthMaterialFor(pars, beg, nrm, {});
    mat.side = THREE.DoubleSide;
    mesh.frustumCulled = false; mesh.castShadow = shadow && key === 'people'; mesh.receiveShadow = true; mesh.count = 0; mesh.name = key;
    scene.add(mesh);
    return { mesh, attrs };
  }
  const pm = makeMesh(personGeometry(), N, PERSON_PARS, PERSON_NORMAL, PERSON_BEGIN, 'people', true);
  const dm = makeMesh(dogGeometry(), nDog, DOG_PARS, DOG_NORMAL, DOG_BEGIN, 'dogs');

  const peds = [];
  for (let i = 0; i < N; i++) {
    peds.push({ on: false, cross: i >= nWalk, e: null, dir: 1, s: 0, side: 1, off: 0, sp: 1.3, ph: rnd() * 6.28, x: 0, y: 0, z: 0, yaw: 0, scale: 1, stand: 0, dog: -1,
      shirt: col3(SHIRTS[0]), trou: col3(TROUS[0]), hair: col3(HAIR[0]), skin: 0, sleeve: 0, state: 0, t: 0, cx: 0, cz: 0, ax: 0, az: 0, bx: 0, bz: 0, ci: 0, tx: 0, tz: 1, v: 0 });
  }
  const dogs = [];
  for (let i = 0; i < nDog; i++) dogs.push({ on: false, owner: -1, ph: rnd() * 6.28, x: 0, y: 0, z: 0, yaw: 0, scale: 1, c1: col3('#7a5a35'), c2: col3('#e6dcc4') });
  const out = { x: 0, y: 0, z: 0, tx: 0, tz: 1, sl: 0, cap: 99 };

  function dress(p) {
    p.shirt.set(SHIRTS[(rnd() * SHIRTS.length) | 0]); p.trou.set(TROUS[(rnd() * TROUS.length) | 0]); p.hair.set(HAIR[(rnd() * HAIR.length) | 0]);
    p.skin = rnd() < 0.78 ? 0 : (rnd() * 4) | 0; p.sleeve = rnd() < 0.7 ? 1 : 0; p.umb = rnd() < 0.6 ? 1 : 0; p.coat = rnd() < 0.5 ? 1 : 0;
    p.scale = 0.9 + rnd() * 0.12 + (rnd() < 0.5 ? 0 : 0.03);
    p.sp = 1.05 + rnd() * 0.45;
  }
  const offsetFor = (e) => e.w * 0.5 + (e.road._verge || 0) + (e.road._pave || 2) * (0.35 + rnd() * 0.3);
  const sideFor = (e) => e.road._paveSide || (rnd() < 0.5 ? 1 : -1); // side in the road polyline frame (+ = left of polyline direction)

  // seeding: any paved edge in the cells around the camera (so the crowd is visible immediately), town-centre first
  function pickNear(cx, cz) {
    const k = Math.ceil(120 / G), gx = Math.floor(cx / G), gz = Math.floor(cz / G);
    let pick = null, n = 0;
    for (let j = -k; j <= k; j++) for (let i = -k; i <= k; i++) {
      const l = grid.get(gk(gx + i, gz + j)); if (!l) continue;
      for (const e of l) { const w = e.road._tc ? 4 : 1; n += w; if (rnd() * n < w) pick = e; }
    }
    return pick;
  }
  function pickEdge(cx, cz, seed) {
    if (seed) { const e = pickNear(cx, cz); if (e) return e; }
    for (let t = 0; t < 14; t++) {
      const a = rnd() * 6.283, r = seed ? 20 + rnd() * 100 : R_SPAWN[0] + rnd() * (R_SPAWN[1] - R_SPAWN[0]);
      const list = grid.get(gk(Math.floor((cx + Math.cos(a) * r) / G), Math.floor((cz + Math.sin(a) * r) / G)));
      if (list && list.length) {
        // town-centre streets are busier: weight them
        for (let k = 0; k < 3; k++) { const e = list[(rnd() * list.length) | 0]; if (e.road._tc || rnd() < 0.5) return e; }
        return list[(rnd() * list.length) | 0];
      }
    }
    return null;
  }

  function spawnWalker(p, cx, cz, seed) {
    const e = pickEdge(cx, cz, seed);
    if (!e) return false;
    p.e = e; p.dir = rnd() < 0.5 ? 1 : -1; p.s = rnd() * e.len; p.side = sideFor(e);
    p.off = offsetFor(e);
    edgeAt(e, p.dir, p.s, out);
    if (seed) {   // slide along the edge until the person stands 18-120 m from the camera
      let ok = false;
      for (let t = 0; t < 10 && !ok; t++) {
        p.s = rnd() * e.len; edgeAt(e, p.dir, p.s, out);
        const dd = Math.hypot(out.x - cx, out.z - cz); ok = dd > 18 && dd < 120;
      }
      if (!ok) return false;
    }
    const x = out.x + out.tz * p.dir * p.side * p.off, z = out.z - out.tx * p.dir * p.side * p.off;
    const d = Math.hypot(x - cx, z - cz);
    if (d < (seed ? 12 : R_SPAWN[0] * 0.8)) return false;
    dress(p);
    p.on = true; p.stand = 0; p.state = 0; p.dog = -1; p.fy = undefined;
    // chatting pair in the centre (second person is the next free walker slot)
    if (e.road._tc && rnd() < 0.3) {
      p.stand = 1; p.t = 0; p.fy = Math.atan2(out.tx, out.tz);
      const q = peds.find((o) => !o.on && !o.cross && o !== p);
      if (q) { q.e = e; q.dir = p.dir; q.side = p.side; q.off = p.off; q.s = Math.min(e.len - 0.3, p.s + 0.9); dress(q); q.on = true; q.stand = 1; q.dog = -1; q.fy = p.fy + Math.PI; q.t = 0; }
    }
    else if (rnd() < nDog / Math.max(1, nWalk) * 1.4) {
      const di = dogs.findIndex((g) => !g.on);
      if (di >= 0) { const g = dogs[di]; g.on = true; g.owner = p.idx; p.dog = di; const dc = DOGS[(rnd() * DOGS.length) | 0]; g.c1.set(dc[0]); g.c2.set(dc[1]); g.breed = (rnd() * 3) | 0; g.scale = g.breed === 1 ? 0.72 + rnd() * 0.1 : g.breed === 2 ? 0.85 + rnd() * 0.1 : 1.0 + rnd() * 0.12; }
    }
    return true;
  }
  peds.forEach((p, i) => { p.idx = i; });

  function walkerPos(p) {
    edgeAt(p.e, p.dir, p.s, out);
    p.tx = out.tx; p.tz = out.tz;
    const lat = p.dir * p.side * p.off;
    p.x = out.x + out.tz * lat; p.z = out.z - out.tx * lat; p.y = out.y + 0.15;
    p.yaw = p.stand && p.fy !== undefined ? p.fy : Math.atan2(out.tx, out.tz);
  }

  function stepWalker(p, dt) {
    if (p.stand) {
      p.v = 0; p.t += dt;
      // chatters face along the road, slightly toward the shop side; gentle idle sway handled by phase 0
      return;
    }
    p.v = p.sp;
    p.s += p.sp * dt;
    if (p.s >= p.e.len) {
      const e = p.e, node = graph.nodes[p.dir > 0 ? e.b : e.a];
      const opts = [];
      for (const c of node.out) if (c.e !== e && c.e.road._pave > 0 && !(c.e.road._verge > 0) && c.e.len >= 8) opts.push(c);
      if (!opts.length) { p.dir = -p.dir; p.s = 0; p.side = p.e.road._paveSide || p.side; /* turn round, stay on the same polyline side */ }
      else { const c = opts[(rnd() * opts.length) | 0]; const tl = p.side * p.dir; p.e = c.e; p.dir = c.dir; p.s = 0; p.off = offsetFor(c.e); p.side = c.e.road._paveSide || tl * c.dir; }
    }
    p.ph += p.sp * dt * 4.4;
  }

  // crossers: wait on one kerb, cross when no car is close, linger, return
  function initCrosser(p, ci, k) {
    const c = crossings[ci];
    p.on = true; p.cross = true; p.ci = ci; p.state = 0; p.t = rnd() * 6; dress(p); p.sp = 1.3;
    const nx = c.tz, nz = -c.tx, half = c.w * 0.5 + (c.pave || 2) * 0.35;
    const sgn = k ? 1 : -1;
    p.ax = c.x + nx * half * sgn + c.tx * (k ? 1.2 : -1.2); p.az = c.z + nz * half * sgn + c.tz * (k ? 1.2 : -1.2);
    p.bx = c.x - nx * half * sgn + c.tx * (k ? 1.2 : -1.2); p.bz = c.z - nz * half * sgn + c.tz * (k ? 1.2 : -1.2);
    p.x = p.ax; p.z = p.az; p.y = c.y + 0.12; p.yaw = Math.atan2(p.bx - p.ax, p.bz - p.az); p.cx = 0; p.stand = 1;
  }
  function stepCrosser(p, dt, camP) {
    const c = crossings[p.ci];
    const dxc = c.x - camP.x, dzc = c.z - camP.z;
    if (dxc * dxc + dzc * dzc > 300 * 300) { p.v = 0; return; }
    if (p.state === 0) { // waiting at kerb
      p.v = 0; p.t -= dt; p.ph = 0;
      if (p.t <= 0 && !(traffic && traffic.carNear(c.x, c.z, 16))) { p.state = 1; p.cx = 0; }
    } else if (p.state === 1) { // crossing
      const L = Math.hypot(p.bx - p.ax, p.bz - p.az);
      p.cx += 1.3 * dt / L; p.v = 1.3; p.ph += 1.3 * dt * 4.4;
      if (traffic && traffic.requestStop) traffic.requestStop(p.ci, true, 2.0); else c.timer = 2.0;
      p.x = p.ax + (p.bx - p.ax) * Math.min(1, p.cx); p.z = p.az + (p.bz - p.az) * Math.min(1, p.cx);
      p.yaw = Math.atan2(p.bx - p.ax, p.bz - p.az);
      if (p.cx >= 1) { p.state = 2; p.t = 4 + rnd() * 8; }
    } else { // wait on far kerb, then swap ends and cross back
      p.v = 0; p.t -= dt; p.ph = 0;
      if (p.t <= 0) { const tx = p.ax, tz = p.az; p.ax = p.bx; p.az = p.bz; p.bx = tx; p.bz = tz; p.state = 0; p.t = 2 + rnd() * 6; p.yaw = Math.atan2(p.bx - p.ax, p.bz - p.az); }
    }
  }

  let crossInit = false;
  const lastCam = new THREE.Vector3();
  const camP = new THREE.Vector3();
  let spawnT = 0;
  function update(dt, camPos, riderPos, riderYaw, riderSpeed, paused) {
    // (re)seed the crowd near the camera on first frame or after a teleport (route jump)
    const jumped = !lastCam.initd || lastCam.distanceTo(camPos) > 150;
    lastCam.copy(camPos); lastCam.initd = true;
    camP.copy(camPos);
    if (jumped) { for (const q of peds) if (!q.cross) q.on = false; for (const g of dogs) g.on = false; }
    if (dt > 0.1) dt = 0.1;
    if (paused) dt = 0;
    if (!crossInit && crossings.length) {
      crossInit = true;
      for (let i = 0; i < crossings.length; i++) { initCrosser(peds[nWalk + i * 2], i, 0); initCrosser(peds[nWalk + i * 2 + 1], i, 1); }
    }
    spawnT -= dt;
    // WEATHER: fewer people out in the rain; umbrellas up once it is properly raining
    const rainK = Math.min(1, U.uRain.value * 1.2), maxWalk = nWalk * (1 - 0.7 * rainK), umbOn = U.uRain.value > 0.3;
    let onN = 0;
    for (let i = 0; i < nWalk; i++) if (peds[i].on) onN++;
    let live = 0, dl = 0;
    const R2 = R_DESPAWN * R_DESPAWN;
    for (let i = 0; i < N; i++) {
      const p = peds[i];
      if (!p.on) {
        if (!p.cross && (spawnT <= 0 || jumped || onN < maxWalk * 0.6) && dt > 0 && onN < maxWalk) { if (spawnWalker(p, camP.x, camP.z, jumped || onN < maxWalk * 0.6)) { spawnT = 0.12; onN++; } }
        continue;
      }
      if (p.cross) { if (dt > 0) stepCrosser(p, dt, camP); }
      else {
        if (dt > 0) stepWalker(p, dt);
        walkerPos(p);
        const dx = p.x - camP.x, dz = p.z - camP.z;
        if ((dx * dx + dz * dz > R2) || (onN > maxWalk + 1 && dt > 0 && rnd() < 0.02 && dx * dx + dz * dz > 40 * 40)) { onN--; p.on = false; if (p.dog >= 0) { dogs[p.dog].on = false; p.dog = -1; } continue; }
      }
    }
    // upload people (compact)
    const mA = pm.mesh.instanceMatrix.array, aM = pm.attrs;
    for (let i = 0; i < N; i++) {
      const p = peds[i];
      if (!p.on) continue;
      if (p.cross) { const c = crossings[p.ci]; const dx = c.x - camP.x, dz = c.z - camP.z; if (dx * dx + dz * dz > 320 * 320) continue; }
      setPose(mA, live * 16, p.x, p.y, p.z, p.yaw, 0);
      const o4 = live * 4, o3 = live * 3;
      aM.aMisc.array[o4] = p.ph; aM.aMisc.array[o4 + 1] = p.v > 0.1 ? 1 : 0; aM.aMisc.array[o4 + 2] = p.scale; aM.aMisc.array[o4 + 3] = p.skin + 4 * p.sleeve + (p.umb && umbOn ? 8 : 0) + (p.dog >= 0 ? 16 : 0) + (p.coat ? 32 : 0);
      aM.aShirt.array[o3] = p.shirt.r; aM.aShirt.array[o3 + 1] = p.shirt.g; aM.aShirt.array[o3 + 2] = p.shirt.b;
      aM.aTrou.array[o3] = p.trou.r; aM.aTrou.array[o3 + 1] = p.trou.g; aM.aTrou.array[o3 + 2] = p.trou.b;
      aM.aHair.array[o3] = p.hair.r; aM.aHair.array[o3 + 1] = p.hair.g; aM.aHair.array[o3 + 2] = p.hair.b;
      live++;
    }
    pm.mesh.count = live;
    pm.mesh.instanceMatrix.needsUpdate = true; for (const k in aM) aM[k].needsUpdate = true;
    // dogs trot just ahead of their owner on the lead
    const dA = dm.mesh.instanceMatrix.array, aD = dm.attrs;
    for (let i = 0; i < nDog; i++) {
      const g = dogs[i]; if (!g.on) continue;
      const o = peds[g.owner];
      if (!o.on || o.dog !== i) { g.on = false; continue; }
      const ax = o.tx * 1.3, az = o.tz * 1.3;
      g.x = o.x + ax; g.z = o.z + az; g.y = o.y; g.yaw = o.yaw; g.ph = o.ph * 1.1 + 1;
      setPose(dA, dl * 16, g.x, g.y, g.z, g.yaw, 0);
      const o4 = dl * 4, o3 = dl * 3;
      aD.aMisc.array[o4] = g.ph; aD.aMisc.array[o4 + 1] = 1; aD.aMisc.array[o4 + 2] = g.scale; aD.aMisc.array[o4 + 3] = g.breed || 0;
      aD.aShirt.array[o3] = g.c1.r; aD.aShirt.array[o3 + 1] = g.c1.g; aD.aShirt.array[o3 + 2] = g.c1.b;
      aD.aTrou.array[o3] = g.c2.r; aD.aTrou.array[o3 + 1] = g.c2.g; aD.aTrou.array[o3 + 2] = g.c2.b;
      dl++;
    }
    dm.mesh.count = dl;
    dm.mesh.instanceMatrix.needsUpdate = true; for (const k in aD) aD[k].needsUpdate = true;
  }
  return { update, count: () => pm.mesh.count, dogCount: () => dm.mesh.count, meshes: [pm.mesh, dm.mesh], peds, dogs };
}
