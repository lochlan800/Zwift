import * as THREE from 'three';
import { patchMaterial } from '../world/shared.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Procedural road bike and rider (original design). Local frame: +z forward, +y up, +x = rider's left.
// Draw calls for the rider: bike (1), wheels (2), body (1). The body is one linear-blend-skinned mesh
// driven by a small skeleton (spine, upper back, head, arms, legs, cranks, pedals), so joints bend
// smoothly instead of showing ball joints. Nothing is allocated per frame.

const R_WHEEL = 0.336;                    // 700c, 0.67 m diameter
const CRANK = 0.1725;
const BB = [0, 0.27, -0.09];
const RA = [0, R_WHEEL, -0.505];          // rear axle; wheelbase 0.99 m
const FA = [0, R_WHEEL, 0.485];
const HIP = [0, 1.07, -0.23];             // hip pivot at rest
const TAU = Math.PI * 2;
const CRANK_ARM = Math.hypot(0.05, CRANK);

// original team kit palette
const PAL = {
  jersey: 0xe84f26, navy: 0x1c2140, rimDark: 0x0e1020, accent: 0xffd23f, white: 0xf4f6fa,
  bibs: 0x1c2140, chamois: 0x8ea6c4, skin: 0xc8977c, sock: 0xf4f6fa, glove: 0x1a1c22,
  helmet: 0x1c2140, vent: 0x07080d, visor: 0x14171e, lens: 0x0c0e13,
  frame: 0x2d6fe0, frameDark: 0x17191f, stripe: 0xffd23f, bartape: 0xf1f3f6,
  tyre: 0x161616, rim: 0x23262d, alu: 0xc9ced6, chain: 0x8e959f, saddle: 0x101216,
  shoe: 0xf4f6fa, sole: 0x1a1c22, pedal: 0x1a1c22, bottle: 0x2aa3ff, cage: 0xc9ced6,
};
const K = {};
for (const k in PAL) K[k] = new THREE.Color(PAL[k]);

const UP = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1), X = new THREE.Vector3(1, 0, 0);
const ONE = new THREE.Vector3(1, 1, 1), IDQ = new THREE.Quaternion();
const V = (a) => (a instanceof THREE.Vector3 ? a : new THREE.Vector3(a[0], a[1], a[2]));

// ---------------------------------------------------------------- geometry helpers
// Result is non-indexed with position, normal and colour only (so everything merges together).
// paint(x, y, z) may return a palette Color to override the base colour for that vertex.
function finish(g, col, paint) {
  if (g.index) g = g.toNonIndexed();
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  const P = g.attributes.position.array, n = g.attributes.position.count;
  const C = new Float32Array(n * 3), base = K[col];
  for (let i = 0; i < n; i++) {
    const c = (paint && paint(P[i * 3], P[i * 3 + 1], P[i * 3 + 2])) || base;
    C[i * 3] = c.r; C[i * 3 + 1] = c.g; C[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(C, 3));
  return g;
}

const xf = (g, p = [0, 0, 0], q = IDQ, s = ONE) => g.applyMatrix4(new THREE.Matrix4().compose(V(p), q, V(s)));

function ell(c, r, col, paint, seg = 14) {
  return finish(xf(new THREE.SphereGeometry(1, seg, seg >> 1), c, IDQ, r), col, paint);
}

// cylinder from a to b with radii r0 (at a) and r1 (at b)
function tubeGeo(a, b, r0, r1 = r0, seg = 8) {
  a = V(a); b = V(b);
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, false).translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3().subVectors(b, a).normalize());
  return g.applyMatrix4(new THREE.Matrix4().compose(a, q, ONE));
}

// Body of revolution along +y from 0..len. rOf(u) gives the radius at u in [0,1]. Ends can be
// rounded caps (capStart / capEnd) or left open where the limb joins its neighbour.
function revolve(len, rOf, seg = 16, capStart = true, capEnd = true) {
  const r0 = rOf(0), r1 = rOf(1), N = 5, M = 16, pts = [];
  const yS = capStart ? r0 : 0, yE = capEnd ? len - r1 : len;
  if (capStart) for (let k = 0; k <= N; k++) {
    const t = -Math.PI / 2 + (k / N) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r0 * Math.cos(t), r0 + r0 * Math.sin(t)));
  }
  for (let k = 0; k <= M; k++) {
    const y = yS + (k / M) * (yE - yS);
    pts.push(new THREE.Vector2(rOf(Math.min(1, Math.max(0, y / len))), y));
  }
  if (capEnd) for (let k = 0; k <= N; k++) {
    const t = (k / N) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r1 * Math.cos(t), len - r1 + r1 * Math.sin(t)));
  }
  return new THREE.LatheGeometry(pts, seg);
}

// toothed ring (chainring / cassette sprocket) in the plane normal to x, centred at (ax..ax+depth, cy, cz)
function gear(R, teeth, depth, holes, ax, cy, cz) {
  const s = new THREE.Shape(), n = teeth * 2;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU, r = i % 2 ? R - 0.005 : R;
    if (i === 0) s.moveTo(Math.cos(t) * r, Math.sin(t) * r); else s.lineTo(Math.cos(t) * r, Math.sin(t) * r);
  }
  for (const [hx, hy, hr] of holes) { const p = new THREE.Path(); p.absarc(hx, hy, hr, 0, TAU, true); s.holes.push(p); }
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 2 });
  return g.rotateY(Math.PI / 2).translate(ax, cy, cz);
}

// ---------------------------------------------------------------- bike
function bikeGeo() {
  const G = [];
  const add = (g) => G.push(g);
  const T = (a, b, r0, r1, col, seg) => add(finish(tubeGeo(a, b, r0, r1, seg), col));
  const fr = 'frame', fd = 'frameDark';

  // frame: pearl-blue metallic tubes, black head/fork
  T(BB, [0, 0.86, -0.27], 0.018, 0.016, fr, 12);          // seat tube
  T(BB, [0, 0.74, 0.37], 0.027, 0.02, fr, 12);             // down tube
  T([0, 0.86, -0.27], [0, 0.86, 0.36], 0.02, 0.017, fr, 12); // top tube
  T([0, 0.74, 0.37], [0, 0.9, 0.36], 0.022, 0.022, fd, 12);  // head tube
  for (const s of [-1, 1]) {
    T([s * 0.04, BB[1], BB[2]], [s * 0.065, RA[1], RA[2]], 0.012, 0.009, fr);    // chainstay
    T([s * 0.02, 0.8, -0.25], [s * 0.065, RA[1], RA[2]], 0.009, 0.006, fr);      // seatstay
    T([s * 0.045, 0.74, 0.37], [s * 0.05, FA[1], FA[2]], 0.014, 0.009, fd);      // fork blade
  }
  T([-0.045, 0.74, 0.37], [0.045, 0.74, 0.37], 0.015, 0.015, fd);                // fork crown
  T([-0.06, BB[1], BB[2]], [0.06, BB[1], BB[2]], 0.02, 0.02, 'alu', 12);         // bottom bracket shell

  // contrasting decal stripe on the down tube
  const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const dtA = [0, 0.74, 0.37];
  T(lerp(BB, dtA, 0.3), lerp(BB, dtA, 0.72), 0.0255, 0.0225, 'stripe', 12);

  // seatpost, saddle, rails
  T([0, 0.86, -0.27], [0, 0.99, -0.305], 0.0135, 0.0135, fd);
  add(finish(xf(new THREE.SphereGeometry(1, 16, 8), [0, 0.99, -0.285], IDQ, [0.036, 0.02, 0.13]), 'saddle'));
  for (const s of [-1, 1]) T([s * 0.018, 0.975, -0.33], [s * 0.018, 0.975, -0.25], 0.0035, 0.0035, 'alu', 6);

  // stem and drop handlebar with tape and hoods
  T([0, 0.9, 0.36], [0, 0.935, 0.41], 0.02, 0.018, fd, 10);
  T([0, 0.935, 0.41], [0, 0.935, 0.46], 0.016, 0.016, fd, 10);
  const barR = [[0, 0.935, 0.46], [0.1, 0.935, 0.455], [0.19, 0.93, 0.43], [0.215, 0.905, 0.42],
    [0.225, 0.86, 0.45], [0.215, 0.8, 0.515], [0.175, 0.775, 0.545], [0.15, 0.79, 0.53]];
  const mir = (p) => [-p[0], p[1], p[2]];
  const curve = (p) => new THREE.CatmullRomCurve3(p.map(V), false, 'centripetal');
  const barPts = [...barR.slice(1).map(mir).reverse(), ...barR];
  add(finish(new THREE.TubeGeometry(curve(barPts), 120, 0.0115, 8, false), fd));
  const tapeR = barR.slice(2);
  add(finish(new THREE.TubeGeometry(curve(tapeR), 40, 0.0135, 8, false), 'bartape'));
  add(finish(new THREE.TubeGeometry(curve(tapeR.map(mir)), 40, 0.0135, 8, false), 'bartape'));
  for (const s of [-1, 1]) add(finish(xf(new THREE.SphereGeometry(1, 12, 8), [s * 0.2, 0.93, 0.415], IDQ, [0.026, 0.022, 0.045]), fd));

  // chainring with spider holes, chain run, bottle and cage on the down tube
  const holes = [[0, 0, 0.03]];
  for (let k = 0; k < 5; k++) { const t = (k * TAU) / 5 + 0.3; holes.push([Math.cos(t) * 0.068, Math.sin(t) * 0.068, 0.015]); }
  add(finish(gear(0.1, 46, 0.004, holes, -0.056, BB[1], BB[2]), 'alu'));
  for (const y of [1, -1]) T([-0.054, BB[1] + y * 0.1, BB[2]], [-0.066, RA[1] + y * 0.036, RA[2]], 0.0035, 0.0035, 'chain', 4);

  const bc = [0.06, 0.5, 0.2];
  const bd = new THREE.Vector3(0, 0.47, 0.46).normalize();
  const bcV = V(bc);
  T(bcV.clone().addScaledVector(bd, -0.11), bcV.clone().addScaledVector(bd, 0.11), 0.03, 0.028, 'bottle', 12);
  for (const o of [-0.05, 0.05]) {
    const q = new THREE.Quaternion().setFromUnitVectors(Z, bd);
    const ring = new THREE.TorusGeometry(0.038, 0.0028, 6, 18).applyQuaternion(q)
      .translate(bcV.x + bd.x * o, bcV.y + bd.y * o, bcV.z + bd.z * o);
    add(finish(ring, 'cage'));
  }
  return mergeGeometries(G);
}

// one wheel in its own frame (axle along x); spins as a single mesh with spokes
function wheelGeo(rear) {
  const G = [];
  const add = (g, col) => G.push(finish(g, col));
  let t = new THREE.TorusGeometry(R_WHEEL - 0.0125, 0.0125, 10, 64).rotateY(Math.PI / 2);
  add(t, 'tyre');
  // deep-section carbon rim: a torus with an oval cross-section
  const rim = new THREE.TorusGeometry(R_WHEEL - 0.046, 0.021, 8, 64).scale(1, 1, 0.62).rotateY(Math.PI / 2);
  add(rim, 'rim');
  add(tubeGeo([-0.068, 0, 0], [0.068, 0, 0], 0.011, 0.011, 8), 'alu');
  for (const s of [-1, 1]) add(tubeGeo([s * 0.04, 0, 0], [s * 0.05, 0, 0], 0.02, 0.02, 10), 'alu');
  if (rear) add(gear(0.036, 11, 0.003, [[0, 0, 0.012]], -0.068, 0, 0), 'alu');
  // 36 spokes, crossed lacing; positions are on the rim circle in the (y, z) plane
  const n = 36, rHub = 0.02, rRim = R_WHEEL - 0.06;
  for (let i = 0; i < n; i++) {
    const side = i & 1 ? 1 : -1;
    const a0 = (i / n) * TAU, a1 = a0 + side * 0.8 * (TAU / n);
    const p0 = [side * 0.035, rHub * Math.sin(a0), -rHub * Math.cos(a0)];
    const p1 = [side * 0.011, rRim * Math.sin(a1), -rRim * Math.cos(a1)];
    add(tubeGeo(p0, p1, 0.00095, 0.00095, 3), 'alu');
  }
  return mergeGeometries(G);
}

// ---------------------------------------------------------------- rider skeleton
const PHI_REST = 0.98;                     // lower-back lean from vertical at rest (rad)
const CHEST_Y = 0.24;                      // spine height where the upper-back bone starts
const ROUND = 0.16;                        // upper back rounded forward (rad)
const SHOULDER_X = 0.158, SHOULDER_Y = 0.23;  // chest-local shoulder joint
const HEAD_LOCAL = [0, 0.53, 0.02];         // chest-local head centre
const HEAD_PITCH = -0.12;                  // head pitch in the world: looking slightly up the road
const L_THIGH = 0.46, L_SHIN = 0.47, L_UP = 0.29, L_FORE = 0.28;
const WRIST_Y = 0.93, WRIST_Z = 0.465;     // wrists on the front of the hoods

// bone indices (lean frame); arm/leg entries are [right, left] i.e. [s<0, s>0]
const B = { SPINE: 0, CHEST: 1, HEAD: 2, UA: [3, 4], FA: [5, 6], HAND: [7, 8], TH: [9, 10], SH: [11, 12], SHOE: [13, 14], PEDAL: [15, 16], CRANK: [17, 18] };
const NB = 19;
const W = Array.from({ length: NB }, () => new THREE.Matrix4());   // current bone matrices
const Bm = Array.from({ length: NB }, () => new THREE.Matrix4());  // bind (rest) matrices
const Binv = Array.from({ length: NB }, () => new THREE.Matrix4());
const SM = new Float64Array(NB * 16);                              // per-frame skin matrices

const _m = new THREE.Matrix4(), _qx = new THREE.Quaternion(), _qz = new THREE.Quaternion(), _sq = new THREE.Quaternion();
const _cq = new THREE.Quaternion(), _hq = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _sp = new THREE.Vector3(), _c0 = new THREE.Vector3(), _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3();
const _d = new THREE.Vector3(), _t = new THREE.Vector3(), _b = new THREE.Vector3();
const _hip = new THREE.Vector3(), _pedal = new THREE.Vector3(), _ankle = new THREE.Vector3(), _knee = new THREE.Vector3();
const _axle = new THREE.Vector3(), _shJ = new THREE.Vector3(), _elbow = new THREE.Vector3();
const KNEE_BEND = new THREE.Vector3(0, 0.3, 1).normalize();
const ARM_BEND = [new THREE.Vector3(-0.7, -0.3, -0.8).normalize(), new THREE.Vector3(0.7, -0.3, -0.8).normalize()];
const WRIST = [new THREE.Vector3(-0.19, WRIST_Y, WRIST_Z), new THREE.Vector3(0.19, WRIST_Y, WRIST_Z)];
const GRIP_Q = [new THREE.Quaternion(), new THREE.Quaternion()];
{
  const grip = new THREE.Vector3(0, 0, 0);
  for (let k = 0; k < 2; k++) {
    const s = k ? 1 : -1;
    grip.set(s * 0.2, 0.93, 0.415).sub(WRIST[k]).normalize();
    GRIP_Q[k].setFromUnitVectors(Z, grip);
  }
}

const aimQ = (q, from, to) => { _d.subVectors(to, from).normalize(); return q.setFromUnitVectors(UP, _d); };
// two-bone IK: a->c with bone lengths l1, l2; the bend hint picks the side of the plane
function ik(a, c, l1, l2, bend, out) {
  _t.subVectors(c, a);
  const d = _t.length();
  const dd = Math.min(d, l1 + l2 - 1e-3);
  _t.multiplyScalar(1 / d);
  const x = (l1 * l1 - l2 * l2 + dd * dd) / (2 * dd);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  _b.copy(bend).addScaledVector(_t, -bend.dot(_t)).normalize();
  out.copy(a).addScaledVector(_t, x).addScaledVector(_b, h);
}
const pedalAt = (s, crankA, out) => {
  const a = crankA + (s > 0 ? Math.PI : 0);
  return out.set(s * 0.095, BB[1] + Math.cos(a) * CRANK, BB[2] + Math.sin(a) * CRANK);
};

// pose all bones for the given crank angle, standing amount (0..1) and roll (rad)
function solvePose(crankA, stand, roll) {
  const phi = PHI_REST - stand * 0.4;
  _qz.setFromAxisAngle(Z, roll);
  _qx.setFromAxisAngle(X, phi);
  _sp.set(0, HIP[1], HIP[2] + stand * 0.1);
  _sq.multiplyQuaternions(_qz, _qx);
  W[B.SPINE].compose(_sp, _sq, ONE);
  _cq.setFromAxisAngle(X, ROUND + 0.006 * Math.sin(2 * crankA));          // slight torso bob twice per revolution
  _q2.setFromAxisAngle(UP, 0.022 * Math.sin(crankA) * (1 - stand * 0.3));   // shoulders counter-rotate against the pedalling hips
  _cq.multiply(_q2);
  W[B.CHEST].multiplyMatrices(W[B.SPINE], _m.compose(_c0.set(0, CHEST_Y, 0), _cq, ONE));
  _hq.setFromAxisAngle(X, HEAD_PITCH - (phi + ROUND));
  W[B.HEAD].multiplyMatrices(W[B.CHEST], _m.compose(_c1.set(HEAD_LOCAL[0], HEAD_LOCAL[1], HEAD_LOCAL[2]), _hq, ONE));

  for (const s of [-1, 1]) {
    const k = s > 0 ? 1 : 0;
    _hip.set(s * 0.1, HIP[1], _sp.z);
    pedalAt(s, crankA, _pedal);
    _ankle.set(_pedal.x, _pedal.y + 0.075, _pedal.z - 0.035);
    ik(_hip, _ankle, L_THIGH, L_SHIN, KNEE_BEND, _knee);
    W[B.TH[k]].compose(_hip, aimQ(_q1, _hip, _knee), ONE);
    W[B.SH[k]].compose(_knee, aimQ(_q2, _knee, _ankle), ONE);
    // ankle: toes dip through the bottom of the stroke and rise at the top (about +-8 degrees)
    _q3.setFromAxisAngle(X, 0.03 - 0.15 * Math.cos(crankA + (s > 0 ? Math.PI : 0)));
    W[B.SHOE[k]].compose(_c2.set(_pedal.x, _pedal.y + 0.012, _pedal.z), _q3, ONE);
    W[B.PEDAL[k]].compose(_pedal, IDQ, ONE);
    _axle.set(s * 0.045, BB[1], BB[2]);
    W[B.CRANK[k]].compose(_axle, aimQ(_q3, _axle, _pedal), ONE);
  }
  for (const s of [-1, 1]) {
    const k = s > 0 ? 1 : 0;
    _shJ.set(s * SHOULDER_X, SHOULDER_Y, 0).applyMatrix4(W[B.CHEST]);
    ik(_shJ, WRIST[k], L_UP, L_FORE, ARM_BEND[k], _elbow);
    W[B.UA[k]].compose(_shJ, aimQ(_q1, _shJ, _elbow), ONE);
    W[B.FA[k]].compose(_elbow, aimQ(_q2, _elbow, WRIST[k]), ONE);
    W[B.HAND[k]].compose(WRIST[k], GRIP_Q[k], ONE);
  }
}

// ---------------------------------------------------------------- skinned body geometry
// Vertices are stored in bind (rest) space with up to two bone influences: `bone` (owner) and `bone2`
// with weight `w2`. Blends are 50/50 at a joint and ramp over `blend` metres either side.
const SK = { P: [], N: [], C: [], A: [], B2: [], W: [], I: [], S: [], L: [], n: 0 };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function skinGeo(geo, bone, opts = {}) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position.array, nor = geo.attributes.normal.array;
  const idx = geo.index ? geo.index.array : null;
  const n = geo.attributes.position.count, e = Bm[bone].elements, base = K[opts.col || 'skin'];
  const off = SK.n;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    let b2 = bone, w = 0;
    if (opts.high && y > opts.high.y0) { b2 = opts.high.bone; w = 0.5 * smooth(opts.high.y0, opts.high.y1, y); }
    else if (opts.low && y < opts.low.y1) { b2 = opts.low.bone; w = 0.5 * (1 - smooth(0, opts.low.y1, y)); }
    const c = (opts.paint && opts.paint(x, y, z)) || base;
    SK.P.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
    const nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2];
    SK.N.push(e[0] * nx + e[4] * ny + e[8] * nz, e[1] * nx + e[5] * ny + e[9] * nz, e[2] * nx + e[6] * ny + e[10] * nz);
    SK.C.push(c.r, c.g, c.b);
    SK.S.push(c === K.skin ? 1 : 0); SK.L.push(x, y, z);   // skin mask + bone-local position (for shader seams)
    SK.A.push(bone); SK.B2.push(b2); SK.W.push(w);
  }
  if (idx) for (let k = 0; k < idx.length; k++) SK.I.push(idx[k] + off);
  else for (let k = 0; k < n; k++) SK.I.push(off + k);
  SK.n += n;
}

const E = (c, r, seg = 14) => new THREE.SphereGeometry(1, seg, seg >> 1).applyMatrix4(
  new THREE.Matrix4().compose(V(c), IDQ, V(r)));

// paints (local coordinates of the owning bone)
const paintPelvis = (x, y) => (y < -0.06 ? K.chamois : null);
const paintTorso = (x, y, z) => {
  if (Math.abs(x) > 0.12) return K.navy;                                              // side panels
  if (Math.abs(x) > 0.03 && Math.abs(x) < 0.058 && z > 0.05 && y < 0.25) return K.bibs; // bib straps
  if (z > 0 && y > 0.1 && y < 0.135) return K.accent;                                 // chest band
  return null;
};
const paintHelmet = (x, y) => {
  if (y < 0.045) return K.rimDark;                                                    // darker edge band
  if (Math.abs(x) < 0.013 && y > 0.05) return K.jersey;                               // vermilion centre stripe
  return null;
};
const paintThigh = (x, y) => (y < 0.39 ? K.bibs : y < 0.41 ? K.glove : null);       // shorts end above the knee
const paintShin = (x, y) => (y > 0.34 ? K.sock : y > 0.32 ? K.accent : null);
const paintUpperArm = (x, y) => (y > 0.22 ? K.skin : y > 0.2 ? K.accent : null);     // short sleeve
const paintFore = (x, y) => (y > L_FORE - 0.08 ? K.glove : null);

// upper arm / thigh / calf radius profiles (muscle shapes, tapering to the joints)
const rThigh = (u) => 0.09 - 0.03 * u + 0.006 * Math.exp(-(((u - 0.15) / 0.18) ** 2));
const rShin = (u) => 0.06 - 0.024 * u + 0.01 * Math.exp(-(((u - 0.3) / 0.18) ** 2));
const rUpper = (u) => 0.044 - 0.006 * u + 0.004 * Math.exp(-(((u - 0.35) / 0.2) ** 2));
const rFore = (u) => 0.035 - 0.004 * u + 0.005 * Math.exp(-(((u - 0.3) / 0.25) ** 2));

function buildBody() {
  solvePose(0, 0, 0);
  for (let b = 0; b < NB; b++) { Bm[b].copy(W[b]); Binv[b].copy(W[b]).invert(); }

  // spine: pelvis and lower back
  skinGeo(E([0, -0.03, 0.02], [0.115, 0.06, 0.09]), B.SPINE, { col: 'bibs', paint: paintPelvis });
  // rounded glutes that sit on the saddle (placed so they land just above/behind the saddle in the lean frame)
  for (const s of [-1, 1]) skinGeo(E([s * 0.06, -0.062, 0.014], [0.082, 0.078, 0.092], 16), B.SPINE, { col: 'bibs' });
  const lower = revolve(CHEST_Y, (u) => 0.114 + 0.004 * u, 18, true, false).scale(1.2, 1, 0.92);
  skinGeo(lower, B.SPINE, { col: 'bibs', high: { bone: B.CHEST, y0: CHEST_Y - 0.07, y1: CHEST_Y } });

  // chest: upper back, shoulders, neck
  const upper = revolve(0.33, (u) => 0.118 - 0.008 * u + 0.004 * Math.sin(u * Math.PI), 18, false, false).scale(1.2, 1, 0.92);
  skinGeo(upper, B.CHEST, { col: 'jersey', paint: paintTorso, low: { bone: B.SPINE, y1: 0.07 } });
  for (const s of [-1, 1]) skinGeo(E([s * SHOULDER_X, SHOULDER_Y, 0], [0.05, 0.05, 0.05]), B.CHEST, { col: 'jersey' });
  const neck = revolve(0.2, () => 0.05, 12, false, false).translate(0, 0.3, 0.01);
  skinGeo(neck, B.CHEST, { col: 'skin', high: { bone: B.HEAD, y0: 0.42, y1: 0.5 } });

  // head: skin, jaw, nose, ears, aero helmet, visor-sunglasses, chin straps
  const H = B.HEAD;
  skinGeo(E([0, 0, 0], [0.086, 0.1, 0.096]), H, { col: 'skin' });
  skinGeo(E([0, -0.055, 0.035], [0.06, 0.05, 0.065]), H, { col: 'skin' });
  skinGeo(E([0, -0.02, 0.095], [0.014, 0.024, 0.016]), H, { col: 'skin' });
  for (const s of [-1, 1]) skinGeo(E([s * 0.084, -0.005, -0.005], [0.013, 0.026, 0.02], 10), H, { col: 'skin' });
  // modern road helmet: low-profile shell, long tapered tail, brow ridge, ventilation channels
  skinGeo(new THREE.SphereGeometry(1, 30, 18, 0, TAU, 0, 1.3).scale(0.104, 0.106, 0.128).translate(0, 0.012, -0.012),
    H, { col: 'helmet', paint: paintHelmet });
  skinGeo(E([0, -0.004, -0.15], [0.064, 0.056, 0.105], 14), H, { col: 'helmet' });
  skinGeo(E([0, 0.058, -0.02], [0.082, 0.04, 0.115], 14), H, { col: 'helmet' });
  skinGeo(E([0, 0.033, 0.098], [0.098, 0.022, 0.03], 12), H, { col: 'rimDark' });
  // flush vent slots on the shell (no protruding geometry)
  for (const s of [-1, 1]) for (const z of [0.06, -0.01, -0.08]) skinGeo(E([s * 0.034, 0.1, z], [0.012, 0.004, 0.026], 8), H, { col: 'vent' });
  for (const s of [-1, 1]) for (const z of [-0.04, 0, 0.04]) {
    skinGeo(E([s * 0.04, 0.108, z], [0.011, 0.0045, 0.02], 8), H, { col: 'vent' });
  }
  skinGeo(new THREE.SphereGeometry(1, 28, 8, Math.PI / 2 - 0.85, 1.7, 1.25, 0.35).scale(0.1, 0.1, 0.108), H, { col: 'lens' });
  for (const s of [-1, 1]) {
    skinGeo(tubeGeo([s * 0.094, 0.025, -0.005], [s * 0.07, -0.07, 0.05], 0.0045, 0.0045, 6), H, { col: 'lens' });
    skinGeo(tubeGeo([s * 0.07, -0.07, 0.05], [0, -0.1, 0.085], 0.0045, 0.0045, 6), H, { col: 'lens' });
  }

  // arms, legs and cycling kit
  const geoUA = revolve(L_UP, rUpper, 14, true, false);
  const geoFA = revolve(L_FORE, rFore, 12, false, false);
  const geoTH = revolve(L_THIGH, rThigh, 16, true, false);
  const geoSH = revolve(L_SHIN, rShin, 14, false, true);
  const geoHand = E([0, 0, 0.03], [0.03, 0.02, 0.05], 10);
  const geoShoeUp = E([0, 0.04, 0.02], [0.042, 0.03, 0.12], 12);
  const geoSole = new THREE.BoxGeometry(0.085, 0.012, 0.25).translate(0, 0.006, 0.02);
  const geoPedal = new THREE.BoxGeometry(0.1, 0.014, 0.1);
  const geoCrank = tubeGeo([0, 0, 0], [0, CRANK_ARM, 0], 0.011, 0.008, 8);
  for (const k of [0, 1]) {
    skinGeo(geoUA, B.UA[k], { col: 'jersey', paint: paintUpperArm, high: { bone: B.FA[k], y0: L_UP - 0.06, y1: L_UP } });
    skinGeo(geoFA, B.FA[k], { col: 'skin', paint: paintFore, low: { bone: B.UA[k], y1: 0.06 }, high: { bone: B.HAND[k], y0: L_FORE - 0.04, y1: L_FORE } });
    skinGeo(geoHand, B.HAND[k], { col: 'glove' });
    skinGeo(geoTH, B.TH[k], { col: 'skin', paint: paintThigh, high: { bone: B.SH[k], y0: L_THIGH - 0.07, y1: L_THIGH } });
    skinGeo(geoSH, B.SH[k], { col: 'skin', paint: paintShin, low: { bone: B.TH[k], y1: 0.07 } });
    skinGeo(geoShoeUp, B.SHOE[k], { col: 'shoe' });
    skinGeo(geoSole, B.SHOE[k], { col: 'sole' });
    // shoe detail: toe box, heel cup, two retention straps with a dial, carbon sole edge, cleat and ankle cuff
    skinGeo(E([0, 0.034, 0.11], [0.04, 0.03, 0.065], 10), B.SHOE[k], { col: 'shoe' });
    skinGeo(E([0, 0.046, -0.075], [0.04, 0.042, 0.05], 10), B.SHOE[k], { col: 'shoe' });
    for (const z of [-0.005, 0.06]) skinGeo(new THREE.BoxGeometry(0.086, 0.006, 0.026).translate(0, 0.066 + (z < 0 ? 0.004 : -0.002), z), B.SHOE[k], { col: 'sole' });
    skinGeo(new THREE.CylinderGeometry(0.014, 0.014, 0.008, 10).translate(0.02, 0.076, 0.03), B.SHOE[k], { col: 'alu' });
    skinGeo(new THREE.BoxGeometry(0.046, 0.01, 0.075).translate(0, -0.004, 0.012), B.SHOE[k], { col: 'chain' });
    skinGeo(new THREE.CylinderGeometry(0.036, 0.04, 0.05, 12).translate(0, 0.095, -0.065), B.SHOE[k], { col: 'sock' });
    skinGeo(geoPedal, B.PEDAL[k], { col: 'pedal' });
    skinGeo(geoCrank, B.CRANK[k], { col: 'alu' });
  }
}

// ---------------------------------------------------------------- public API
export function createRider() {
  const root = new THREE.Group(); root.name = 'rider';
  const lean = new THREE.Group(); root.add(lean); // rolls around the contact line

  const bikeMat = patchMaterial(new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.4, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08,
  }), { key: 'riderBike' });
  // body: fabric sheen on the kit, softer warmer skin (cheap scattering lift), woven micro-texture and stitched seams
  const bodyMat = patchMaterial(new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.72, metalness: 0, sheen: 1, sheenRoughness: 0.45, sheenColor: new THREE.Color(0.5, 0.52, 0.58),
  }), {
    key: 'riderBody',
    vertexPars: 'attribute float aSkin; attribute vec3 aLoc; attribute float aOwn; varying float vSkin; varying vec3 vLoc; varying float vOwn;',
    vertex: { begin_vertex: '$\n vSkin = aSkin; vLoc = aLoc; vOwn = aOwn;' },
    fragmentPars: `varying float vSkin; varying vec3 vLoc; varying float vOwn;
      float rbHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float rbSeam;`,
    fragment: {
      color_fragment: `$
        {
          float torso = (vOwn < 1.5) ? 1.0 : 0.0;
          float nearF = 1.0 - smoothstep(1.5, 4.0, length(vViewPosition));
          vec2 wp = vLoc.xy * 650.0 + vLoc.zz * 40.0;
          float weave = (rbHash(floor(wp)) - 0.5) * (1.0 - vSkin) * nearF;
          diffuseColor.rgb *= 1.0 + weave * 0.07;
          // stitched seams on the jersey: side panel edges and the front zip
          float side = 1.0 - smoothstep(0.0015, 0.004, abs(abs(vLoc.x) - 0.1195));
          float zip = (1.0 - smoothstep(0.0012, 0.003, abs(vLoc.x))) * step(0.0, vLoc.z) * step(0.1, vLoc.y);
          rbSeam = torso * max(side, zip) * (1.0 - vSkin);
          diffuseColor.rgb *= 1.0 - 0.38 * rbSeam;
        }`,
      roughnessmap_fragment: 'float roughnessFactor = mix(0.74, 0.48, vSkin);',
      lights_physical_fragment: `$
        #ifdef USE_SHEEN
          material.sheenColor *= (1.0 - vSkin) * (1.0 - 0.6 * rbSeam);
        #endif`,
      emissivemap_fragment: '$\n totalEmissiveRadiance += vSkin * diffuseColor.rgb * vec3(0.10, 0.035, 0.022) * 0.5;',
    },
  });

  // static bike: one mesh; wheels: one mesh each
  const bike = new THREE.Group(); lean.add(bike);
  const bikeMesh = new THREE.Mesh(bikeGeo(), bikeMat); bikeMesh.castShadow = true; bikeMesh.receiveShadow = true; bike.add(bikeMesh);
  const wR = new THREE.Group(), wF = new THREE.Group();
  wR.position.set(...RA); wF.position.set(...FA);
  for (const [w, rear] of [[wR, true], [wF, false]]) {
    const m = new THREE.Mesh(wheelGeo(rear), bikeMat); m.castShadow = true; m.receiveShadow = true; w.add(m); bike.add(w);
  }

  // rider body: one skinned mesh
  buildBody();
  const nv = SK.n;
  const BP = Float32Array.from(SK.P), BN = Float32Array.from(SK.N);
  const IA = Uint8Array.from(SK.A), IB = Uint8Array.from(SK.B2), WB = Float32Array.from(SK.W);
  const OP = new Float32Array(nv * 3), ON = new Float32Array(nv * 3);
  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute('position', new THREE.BufferAttribute(OP, 3).setUsage(THREE.DynamicDrawUsage));
  bodyGeo.setAttribute('normal', new THREE.BufferAttribute(ON, 3).setUsage(THREE.DynamicDrawUsage));
  bodyGeo.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(SK.C), 3));
  bodyGeo.setAttribute('aSkin', new THREE.BufferAttribute(Float32Array.from(SK.S), 1));
  bodyGeo.setAttribute('aLoc', new THREE.BufferAttribute(Float32Array.from(SK.L), 3));
  bodyGeo.setAttribute('aOwn', new THREE.BufferAttribute(Float32Array.from(SK.A), 1));
  bodyGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(SK.I), 1));
  bodyGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 2);
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.castShadow = true; bodyMesh.receiveShadow = true; bodyMesh.frustumCulled = false;
  lean.add(bodyMesh);

  function skin() {
    for (let b = 0; b < NB; b++) { _m.multiplyMatrices(W[b], Binv[b]); SM.set(_m.elements, b * 16); }
    for (let i = 0; i < nv; i++) {
      const v = i * 3, x = BP[v], y = BP[v + 1], z = BP[v + 2];
      const a = IA[i] * 16, c = IB[i] * 16, w = WB[i], wa = 1 - w;
      const ax = SM[a] * x + SM[a + 4] * y + SM[a + 8] * z + SM[a + 12];
      const ay = SM[a + 1] * x + SM[a + 5] * y + SM[a + 9] * z + SM[a + 13];
      const az = SM[a + 2] * x + SM[a + 6] * y + SM[a + 10] * z + SM[a + 14];
      const bx = SM[c] * x + SM[c + 4] * y + SM[c + 8] * z + SM[c + 12];
      const by = SM[c + 1] * x + SM[c + 5] * y + SM[c + 9] * z + SM[c + 13];
      const bz = SM[c + 2] * x + SM[c + 6] * y + SM[c + 10] * z + SM[c + 14];
      OP[v] = wa * ax + w * bx; OP[v + 1] = wa * ay + w * by; OP[v + 2] = wa * az + w * bz;
      const nx = BN[v], ny = BN[v + 1], nz = BN[v + 2];
      const anx = SM[a] * nx + SM[a + 4] * ny + SM[a + 8] * nz, any = SM[a + 1] * nx + SM[a + 5] * ny + SM[a + 9] * nz, anz = SM[a + 2] * nx + SM[a + 6] * ny + SM[a + 10] * nz;
      const bnx = SM[c] * nx + SM[c + 4] * ny + SM[c + 8] * nz, bny = SM[c + 1] * nx + SM[c + 5] * ny + SM[c + 9] * nz, bnz = SM[c + 2] * nx + SM[c + 6] * ny + SM[c + 10] * nz;
      const mx = wa * anx + w * bnx, my = wa * any + w * bny, mz = wa * anz + w * bnz;
      const l = 1 / (Math.hypot(mx, my, mz) || 1);
      ON[v] = mx * l; ON[v + 1] = my * l; ON[v + 2] = mz * l;
    }
    bodyGeo.attributes.position.needsUpdate = true;
    bodyGeo.attributes.normal.needsUpdate = true;
  }

  let crankA = 0, wheelA = 0, leanA = 0, standA = 0, clock = 0;
  function update(dt, speed, leanTarget, cadenceRpm, grade = 0) {
    clock += dt;
    crankA += (cadenceRpm / 60) * TAU * dt;
    wheelA += (speed / R_WHEEL) * dt;
    wR.rotation.x = wheelA; wF.rotation.x = wheelA;
    leanA += (leanTarget - leanA) * Math.min(1, dt * 4);
    lean.rotation.z = -leanA;

    // out of the saddle for a few seconds at a time on steep climbs (grade as a fraction, 0.08 = 8%)
    const climb = Math.min(1, Math.max(0, ((grade || 0) - 0.03) / 0.07));
    const standWant = (grade || 0) > 0.08 && clock % 30 < 9 ? 1 : 0;
    standA += (standWant - standA) * Math.min(1, dt * 2);
    const roll = Math.sin(crankA) * (0.015 + 0.03 * climb) * Math.min(1, speed / 4);

    solvePose(crankA, standA, roll);
    skin();
  }
  update(0, 0, 0, 0);
  return { root, update };
}
