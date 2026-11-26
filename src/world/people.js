import * as THREE from 'three';
import { patchMaterial, U } from './shared.js';
import { edgeAt, setPose, depthMaterialFor } from './lifeutil.js';
import { mulberry32 } from './heightfield.js';

// ---------------------------------------------------------------------------------------------
// Pedestrians and dogs. Realistic proportions (1.55-1.9 m), muted everyday clothing, natural gait.
// One InstancedMesh for people and one for dogs. The walk cycle runs in the vertex shader: each body
// part rotates about its joint (hip, knee, shoulder, elbow) from a per-instance phase, so there is no
// per-frame CPU skinning. Pedestrians walk the pavements on both sides of the real road edges, some
// stand chatting by shop fronts, some cross at the zebra crossings (traffic stops for them).
// ---------------------------------------------------------------------------------------------

const PERSON_PARS = /* glsl */`
attribute float aPart; attribute float aMat;
attribute vec4 aMisc;       // phase, speed(0..1), scale, skin + 4*sleeve
attribute vec3 aShirt; attribute vec3 aTrou; attribute vec3 aHair;
varying vec3 vMatCol; varying float vRough;
vec3 pivotOf(int p) {
  if (p == 1) return vec3(0.09, 0.92, 0.0);  if (p == 2) return vec3(-0.09, 0.92, 0.0);
  if (p == 3) return vec3(0.09, 0.48, 0.0);  if (p == 4) return vec3(-0.09, 0.48, 0.0);
  if (p == 5) return vec3(0.215, 1.42, 0.0); if (p == 6) return vec3(-0.215, 1.42, 0.0);
  if (p == 7) return vec3(0.215, 1.12, 0.0); if (p == 8) return vec3(-0.215, 1.12, 0.0);
  return vec3(0.0);
}
vec3 rotX(vec3 p, vec3 pv, float th) { float c = cos(th), s = sin(th); vec3 d = p - pv; return pv + vec3(d.x, d.y * c - d.z * s, d.y * s + d.z * c); }
void animate(int part, float a, float sw, inout vec3 p, inout vec3 n) {
  float hipL = 0.48 * sin(a) * sw, hipR = -hipL;
  float kneeL = 0.85 * max(0.0, cos(a)) * sw, kneeR = 0.85 * max(0.0, -cos(a)) * sw;
  float armL = -0.42 * sin(a) * sw, armR = -armL;
  float elb = 0.18 + 0.35 * sw;
  if (part == 3) { p = rotX(p, pivotOf(3), kneeL); n = rotX(n, vec3(0.0), kneeL); p = rotX(p, pivotOf(1), -hipL); n = rotX(n, vec3(0.0), -hipL); }
  else if (part == 4) { p = rotX(p, pivotOf(4), kneeR); n = rotX(n, vec3(0.0), kneeR); p = rotX(p, pivotOf(2), -hipR); n = rotX(n, vec3(0.0), -hipR); }
  else if (part == 1) { p = rotX(p, pivotOf(1), -hipL); n = rotX(n, vec3(0.0), -hipL); }
  else if (part == 2) { p = rotX(p, pivotOf(2), -hipR); n = rotX(n, vec3(0.0), -hipR); }
  else if (part == 7) { p = rotX(p, pivotOf(7), -elb); p = rotX(p, pivotOf(5), -armL); n = rotX(n, vec3(0.0), -elb - armL); }
  else if (part == 8) { p = rotX(p, pivotOf(8), -elb); p = rotX(p, pivotOf(6), -armR); n = rotX(n, vec3(0.0), -elb - armR); }
  else if (part == 5) { p = rotX(p, pivotOf(5), -armL); n = rotX(n, vec3(0.0), -armL); }
  else if (part == 6) { p = rotX(p, pivotOf(6), -armR); n = rotX(n, vec3(0.0), -armR); }
}
`;
const PERSON_NORMAL = /* glsl */`
vec3 objectNormal = vec3( normal );
vec3 pDummy = position;
animate(int(aPart + 0.5), aMisc.x, aMisc.y, pDummy, objectNormal);
`;
const PERSON_BEGIN = /* glsl */`
vec3 transformed = position;
vec3 nDummy = vec3(0.0);
animate(int(aPart + 0.5), aMisc.x, aMisc.y, transformed, nDummy);
transformed.y += abs(sin(aMisc.x)) * 0.014 * aMisc.y;
{
  float m = aMat;
  float sk = mod(aMisc.w, 4.0), sl = mod(floor(aMisc.w / 4.0), 2.0);
  if (aPart > 8.5 && aPart < 9.5 && mod(floor(aMisc.w / 8.0), 2.0) < 0.5) transformed *= 0.0;   // WEATHER: umbrella only while it rains
  if (aPart > 9.5 && floor(aMisc.w / 16.0) < 0.5) transformed *= 0.0;                                // dog lead only when walking a dog
  vec3 skin = sk < 0.5 ? vec3(0.50, 0.33, 0.25) : sk < 1.5 ? vec3(0.36, 0.21, 0.15) : sk < 2.5 ? vec3(0.22, 0.11, 0.075) : vec3(0.09, 0.045, 0.03);
  float part = aPart;
  vec3 col = m < 0.5 ? aShirt : m < 1.5 ? aTrou : m < 2.5 ? skin : m < 3.5 ? aHair : vec3(0.025, 0.022, 0.02);
  if (m > 4.5) col = (sl > 0.5) ? aShirt : skin;        // forearm: long sleeve or bare
  if (m > 5.5) col = aTrou * 0.6 + 0.015;                // umbrella canopy
  vMatCol = col;
  vRough = m < 0.5 ? 0.9 : m < 1.5 ? 0.85 : m < 2.5 ? 0.5 : m < 3.5 ? 0.75 : 0.55;
  transformed *= aMisc.z;   // person scale (height variety)
}
`;

const DOG_PARS = /* glsl */`
attribute float aPart; attribute float aMat;
attribute vec4 aMisc;
attribute vec3 aShirt; attribute vec3 aTrou; attribute vec3 aHair;
varying vec3 vMatCol; varying float vRough;
vec3 pivotOf(int p) {
  if (p == 1) return vec3(0.085, 0.47, 0.24);  if (p == 2) return vec3(-0.085, 0.47, 0.24);
  if (p == 3) return vec3(0.085, 0.47, -0.24); if (p == 4) return vec3(-0.085, 0.47, -0.24);
  if (p == 5) return vec3(0.0, 0.5, -0.38);
  return vec3(0.0);
}
vec3 rotX(vec3 p, vec3 pv, float th) { float c = cos(th), s = sin(th); vec3 d = p - pv; return pv + vec3(d.x, d.y * c - d.z * s, d.y * s + d.z * c); }
void animate(int part, float a, float sw, inout vec3 p, inout vec3 n) {
  float s = sin(a) * 0.6 * sw;
  float th = 0.0;
  if (part == 1 || part == 4) th = s; else if (part == 2 || part == 3) th = -s;
  if (part >= 1 && part <= 4) { p = rotX(p, pivotOf(part), th); n = rotX(n, vec3(0.0), th); }
  if (part == 5) { float w = sin(a * 1.7) * 0.35; vec3 d = p - pivotOf(5); float c = cos(w), sn = sin(w); p = pivotOf(5) + vec3(d.x * c + d.z * sn * 0.0, d.y, d.z); p.x += sin(a * 1.7) * 0.05 * (d.z < 0.0 ? 1.0 : 0.0) * 0.0; }
}
`;
const DOG_NORMAL = /* glsl */`
vec3 objectNormal = vec3( normal );
vec3 pDummy = position;
animate(int(aPart + 0.5), aMisc.x, aMisc.y, pDummy, objectNormal);
`;
const DOG_BEGIN = /* glsl */`
vec3 transformed = position;
vec3 nDummy = vec3(0.0);
animate(int(aPart + 0.5), aMisc.x, aMisc.y, transformed, nDummy);
transformed.y += abs(sin(aMisc.x * 2.0)) * 0.012 * aMisc.y;
{
  float m = aMat;
  vMatCol = m < 0.5 ? aShirt : m < 1.5 ? aTrou : m < 2.5 ? vec3(0.02) : vec3(0.35, 0.05, 0.05);
  vRough = 0.85;
  transformed *= aMisc.z;
}
`;

// ---- geometry helpers: parts merged into one buffer geometry carrying part id + material id
function mk(parts) {
  const P = [], N = [], I = [], PT = [], MT = [];
  for (const { geo, part, mat } of parts) {
    const g = geo.index ? geo : geo;
    const pos = g.attributes.position.array, nor = g.attributes.normal.array, idx = g.index.array;
    const o = P.length / 3;
    for (let i = 0; i < pos.length; i += 3) { P.push(pos[i], pos[i + 1], pos[i + 2]); N.push(nor[i], nor[i + 1], nor[i + 2]); PT.push(part); MT.push(mat); }
    for (const k of idx) I.push(o + k);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(PT, 1));
  g.setAttribute('aMat', new THREE.Float32BufferAttribute(MT, 1));
  g.setIndex(I);
  return g;
}
const ell = (rx, ry, rz, x, y, z, ws = 10, hs = 7) => { const g = new THREE.SphereGeometry(1, ws, hs); g.scale(rx, ry, rz); g.translate(x, y, z); return g; };
const limb = (r0, r1, len, x, yTop, z, seg = 8) => { const g = new THREE.CylinderGeometry(r0, r1, len, seg, 1); g.translate(x, yTop - len / 2, z); return g; };

function personGeometry() {
  const A = [];
  const add = (geo, part, mat) => A.push({ geo, part, mat });
  // torso
  add(ell(0.185, 0.21, 0.115, 0, 1.27, 0, 12, 8), 0, 0);
  add(ell(0.16, 0.17, 0.1, 0, 1.08, 0, 12, 7), 0, 0);
  add(ell(0.168, 0.13, 0.108, 0, 0.95, -0.005, 12, 7), 0, 1);
  // neck + head + hair
  add(limb(0.045, 0.05, 0.1, 0, 1.6, 0.005), 0, 2);
  add(ell(0.078, 0.108, 0.093, 0, 1.675, 0.012, 12, 9), 0, 2);
  add(ell(0.082, 0.1, 0.1, 0, 1.69, -0.012, 12, 7), 0, 3);
  for (const s of [-1, 1]) add(ell(0.012, 0.028, 0.018, s * 0.078, 1.67, 0.005, 6, 5), 0, 2);
  // legs (part 1/2 thigh, 3/4 shin+shoe), arms (5/6 upper, 7/8 fore+hand)
  for (const [s, pt, ps, pu, pf] of [[1, 1, 3, 5, 7], [-1, 2, 4, 6, 8]]) {
    add(limb(0.088, 0.06, 0.44, s * 0.09, 0.92, 0, 9), pt, 1);
    add(ell(0.092, 0.09, 0.1, s * 0.09, 0.93, 0, 8, 6), pt, 1);
    add(limb(0.058, 0.042, 0.4, s * 0.09, 0.48, 0, 8), ps, 1);
    const shoe = new THREE.BoxGeometry(0.095, 0.07, 0.27, 1, 1, 1); shoe.translate(s * 0.09, 0.045, 0.06); add(shoe, ps, 4);
    add(ell(0.062, 0.062, 0.062, s * 0.215, 1.415, 0, 8, 6), pu, 0);
    add(limb(0.05, 0.04, 0.3, s * 0.215, 1.42, 0, 8), pu, 0);
    add(limb(0.038, 0.03, 0.28, s * 0.215, 1.12, 0, 8), pf, 5);
    add(ell(0.034, 0.045, 0.026, s * 0.215, 0.81, 0.01, 7, 5), pf, 2);
  }
  // umbrella (hidden by the shader unless it is raining): canopy + pole held up beside the head
  const can = new THREE.SphereGeometry(1, 14, 5, 0, Math.PI * 2, 0, Math.PI / 2); can.scale(0.5, 0.17, 0.5); can.translate(0.16, 2.0, 0.1); add(can, 9, 6);
  add(limb(0.008, 0.008, 0.8, 0.16, 2.02, 0.1, 5), 9, 4);
  // dog lead: thin line from the right hand to the dog's collar (dog trots 1.3 m ahead)
  {
    const hx = 0.215, hy = 0.84, hz = 0.06, cx = 0.0, cy = 0.6, cz = 1.5;
    const len = Math.hypot(cx - hx, cy - hy, cz - hz);
    const g = new THREE.BoxGeometry(0.007, 0.007, len, 1, 1, 1);
    g.rotateX(-Math.asin((cy - hy) / len)); g.rotateY(Math.atan2(cx - hx, cz - hz));
    g.translate((hx + cx) / 2, (hy + cy) / 2, (hz + cz) / 2);
    add(g, 10, 4);
  }
  return mk(A.map((a) => ({ ...a, geo: a.geo.index ? a.geo : a.geo })));
}
function dogGeometry() {
  const A = [];
  const add = (geo, part, mat) => A.push({ geo, part, mat });
  add(ell(0.13, 0.15, 0.3, 0, 0.55, -0.02, 10, 8), 0, 0);
  add(ell(0.11, 0.12, 0.13, 0, 0.62, 0.3, 9, 7), 0, 0);
  add(ell(0.065, 0.065, 0.12, 0, 0.58, 0.42, 8, 6), 0, 1);
  add(ell(0.02, 0.02, 0.02, 0, 0.6, 0.53, 5, 4), 0, 2);
  for (const s of [-1, 1]) add(ell(0.03, 0.07, 0.05, s * 0.085, 0.69, 0.27, 6, 5), 0, 1);
  const tail = limb(0.018, 0.01, 0.3, 0, 0.52, -0.38, 5); tail.rotateX(0.0); add(tail, 5, 0);
  for (const [s, z, pt] of [[1, 0.24, 1], [-1, 0.24, 2], [1, -0.24, 3], [-1, -0.24, 4]]) add(limb(0.04, 0.026, 0.47, s * 0.085, 0.47, z, 7), pt, 0);
  return mk(A);
}

const SHIRTS = ['#2b3442', '#3a3d40', '#6b6f73', '#4a5a3c', '#7a3a35', '#c7b9a0', '#4d6a8a', '#16181a', '#b8b8b0', '#5a4a3a', '#2f4f4a', '#8c6d4a'];
const TROUS = ['#1d2a44', '#16181a', '#3c3f45', '#8a7a5c', '#26334f', '#4a4036', '#5b6068'];
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
  const shadow = cfg.tier !== 'low';

  // ---- paved edges grid
  const G = graph.G, grid = new Map(), gk = graph.gk;
  for (const e of graph.edges) {
    if (!(e.road._pave > 0) || e.len < 8) continue;
    const m = e.n >> 1, k = gk(Math.floor(e.x[m] / G), Math.floor(e.z[m] / G));
    let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(e);
  }

  function makeMesh(geo, count, pars, nrm, beg, key) {
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
      fragmentPars: 'varying vec3 vMatCol; varying float vRough;',
      fragment: { color_fragment: 'diffuseColor.rgb *= vMatCol;', roughnessmap_fragment: 'float roughnessFactor = vRough;' },
    });
    mesh.material = mat;
    mesh.customDepthMaterial = depthMaterialFor(pars, beg, nrm, {});
    mat.side = THREE.DoubleSide;
    mesh.frustumCulled = false; mesh.castShadow = shadow && key === 'people'; mesh.receiveShadow = true; mesh.count = 0; mesh.name = key;
    scene.add(mesh);
    return { mesh, attrs };
  }
  const pm = makeMesh(personGeometry(), N, PERSON_PARS, PERSON_NORMAL, PERSON_BEGIN, 'people');
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
    p.skin = rnd() < 0.78 ? 0 : (rnd() * 4) | 0; p.sleeve = rnd() < 0.7 ? 1 : 0; p.umb = rnd() < 0.6 ? 1 : 0;
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
      if (di >= 0) { const g = dogs[di]; g.on = true; g.owner = p.idx; p.dog = di; const dc = DOGS[(rnd() * DOGS.length) | 0]; g.c1.set(dc[0]); g.c2.set(dc[1]); g.scale = 0.75 + rnd() * 0.4; }
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
      for (const c of node.out) if (c.e !== e && c.e.road._pave > 0 && c.e.len >= 8) opts.push(c);
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
      aM.aMisc.array[o4] = p.ph; aM.aMisc.array[o4 + 1] = p.v > 0.1 ? 1 : 0; aM.aMisc.array[o4 + 2] = p.scale; aM.aMisc.array[o4 + 3] = p.skin + 4 * p.sleeve + (p.umb && umbOn ? 8 : 0) + (p.dog >= 0 ? 16 : 0);
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
      aD.aMisc.array[o4] = g.ph; aD.aMisc.array[o4 + 1] = 1; aD.aMisc.array[o4 + 2] = g.scale; aD.aMisc.array[o4 + 3] = 0;
      aD.aShirt.array[o3] = g.c1.r; aD.aShirt.array[o3 + 1] = g.c1.g; aD.aShirt.array[o3 + 2] = g.c1.b;
      aD.aTrou.array[o3] = g.c2.r; aD.aTrou.array[o3 + 1] = g.c2.g; aD.aTrou.array[o3 + 2] = g.c2.b;
      dl++;
    }
    dm.mesh.count = dl;
    dm.mesh.instanceMatrix.needsUpdate = true; for (const k in aD) aD[k].needsUpdate = true;
  }
  return { update, count: () => pm.mesh.count, dogCount: () => dm.mesh.count, meshes: [pm.mesh, dm.mesh], peds, dogs };
}
