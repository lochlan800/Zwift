import * as THREE from 'three';
import { patchMaterial } from '../world/shared.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Procedural road bike and rider (original design). Local frame: +z forward, +y up, +x = rider's left.
// Draw calls for the rider: bike (1), wheels (2), body (1). The body is one CPU-skinned mesh whose
// parts (torso, head, limbs, cranks, pedals) are re-posed each frame; no per-frame allocations.

const R_WHEEL = 0.336;                    // 700c, 0.67 m diameter
const CRANK = 0.1725;
const BB = [0, 0.27, -0.09];
const RA = [0, R_WHEEL, -0.505];          // rear axle; wheelbase 0.99 m
const FA = [0, R_WHEEL, 0.485];
const HIP = [0, 1.07, -0.25];             // hip pivot at rest
const PHI_REST = 0.85;                    // torso lean from vertical at rest (rad, ~49 deg)
const SHOULDER = 0.47;                    // shoulder height along the torso
const HEAD_AT = [0, 0.68, 0.03];          // head centre in torso space
const HEAD_PITCH = 0.2;                   // head tilted slightly down toward the road
const L_THIGH = 0.46, L_SHIN = 0.47, L_UP = 0.29, L_FORE = 0.28;
const CRANK_ARM = Math.hypot(0.05, CRANK);
const TAU = Math.PI * 2;

// original team kit palette
const PAL = {
  jersey: 0xff5a2a, navy: 0x1c2140, accent: 0xffd23f, white: 0xf4f6fa,
  bibs: 0x1c2140, chamois: 0x8ea6c4, skin: 0xd6a386, sock: 0xf4f6fa, glove: 0x1a1c22,
  helmet: 0xf4f6fa, vent: 0x2a2d36, visor: 0x14171e, lens: 0x0c0e13,
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

// Body of revolution along +y from 0..len. rOf(u) gives the radius at u in [0,1]; the ends are
// hemispherical caps, so limbs and joints read as smooth rounded shapes.
function revolve(len, rOf, seg = 16) {
  const r0 = rOf(0), r1 = rOf(1), N = 5, M = 14, pts = [];
  for (let k = 0; k <= N; k++) {
    const t = -Math.PI / 2 + (k / N) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r0 * Math.cos(t), r0 + r0 * Math.sin(t)));
  }
  for (let k = 1; k < M; k++) {
    const u = k / M;
    pts.push(new THREE.Vector2(rOf(u), r0 + u * (len - r0 - r1)));
  }
  for (let k = 0; k <= N; k++) {
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

// ---------------------------------------------------------------- rider parts (body space)
const paintTorso = (x, y, z) => {
  if (y < 0.07) return K.bibs;
  if (Math.abs(x) > 0.12) return K.navy;                                  // side panels
  if (Math.abs(x) > 0.03 && Math.abs(x) < 0.058 && z > 0.05 && y < 0.5) return K.bibs; // bib straps
  if (z > 0 && y > 0.2 && y < 0.245) return K.accent;                     // chest band
  return null;
};
const paintPelvis = (x, y) => (y < -0.045 ? K.chamois : null);
const paintHelmet = (x, y, z) => (Math.abs(x) > 0.028 && Math.abs(x) < 0.04 && y > 0.06 && z > -0.06 && z < 0.07 ? K.vent : null);
const paintThigh = (x, y) => (y < 0.28 ? K.bibs : y < 0.31 ? K.accent : null);
const paintShin = (x, y) => (y > L_SHIN - 0.15 && y <= L_SHIN - 0.13 ? K.accent : y > L_SHIN - 0.13 ? K.sock : null);
const paintUpperArm = (x, y) => (y > 0.25 && y < 0.28 ? K.accent : null);
const paintFore = (x, y) => (y > L_FORE - 0.08 ? K.glove : null);

function buildRiderGeo() {
  // torso space: origin at hip, +y up the torso, +z forward
  const pelvis = ell([0, -0.03, 0], [0.128, 0.078, 0.13], 'bibs', paintPelvis);
  const torso = finish(xf(revolve(0.55, (u) => 0.112 + 0.012 * Math.sin(u * Math.PI * 0.9), 18), [0, 0, 0], IDQ, [1.2, 1, 0.92]), 'jersey', paintTorso);
  const shL = ell([-0.158, SHOULDER, 0], [0.05, 0.05, 0.05], 'jersey');
  const shR = ell([0.158, SHOULDER, 0], [0.05, 0.05, 0.05], 'jersey');
  const neck = finish(xf(revolve(0.22, () => 0.048, 12), [0, 0.48, 0]), 'skin');
  const spine = mergeGeometries([pelvis, torso, shL, shR, neck]);

  // head space: origin at head centre
  const head = [
    ell([0, 0, 0], [0.086, 0.1, 0.096], 'skin'),
    ell([0, -0.055, 0.035], [0.06, 0.05, 0.065], 'skin'),
    ell([0, -0.02, 0.095], [0.014, 0.024, 0.016], 'skin'),
    ell([-0.084, -0.005, -0.005], [0.013, 0.026, 0.02], 'skin'),
    ell([0.084, -0.005, -0.005], [0.013, 0.026, 0.02], 'skin'),
    // aero helmet: shell, tail and vents
    finish(xf(new THREE.SphereGeometry(1, 28, 16, 0, TAU, 0, 1.3), [0, 0.005, -0.01], IDQ, [0.108, 0.114, 0.124]), 'helmet', paintHelmet),
    ell([0, 0.0, -0.085], [0.085, 0.08, 0.09], 'helmet', paintHelmet),
    // tinted visor band across the forehead
    finish(xf(new THREE.SphereGeometry(1, 28, 8, Math.PI / 2 - 0.6, 1.2, 0.98, 0.3), [0, 0, 0], IDQ, [0.118, 0.118, 0.128]), 'visor'),
    ell([-0.036, -0.006, 0.1], [0.03, 0.016, 0.012], 'lens'),
    ell([0.036, -0.006, 0.1], [0.03, 0.016, 0.012], 'lens'),
  ];
  const headG = mergeGeometries(head);

  const thigh = finish(revolve(L_THIGH, (u) => 0.08 - 0.02 * u, 14), 'skin', paintThigh);
  const shin = finish(revolve(L_SHIN, (u) => 0.05 - 0.012 * u + 0.012 * Math.exp(-(((u - 0.25) / 0.18) ** 2)), 14), 'skin', paintShin);
  const shoe = mergeGeometries([
    ell([0, 0.04, 0.02], [0.042, 0.03, 0.12], 'shoe'),
    finish(new THREE.BoxGeometry(0.085, 0.012, 0.25).translate(0, 0.006, 0.02), 'sole'),
  ]);
  const pedal = finish(new THREE.BoxGeometry(0.1, 0.014, 0.1), 'pedal');
  const crank = finish(tubeGeo([0, 0, 0], [0, CRANK_ARM, 0], 0.011, 0.008, 8), 'alu');
  const upper = finish(revolve(L_UP, (u) => 0.044 - 0.006 * u, 14), 'jersey', paintUpperArm);
  const fore = finish(revolve(L_FORE, (u) => 0.032 - 0.006 * u, 12), 'skin', paintFore);
  const hand = ell([0, 0, 0.03], [0.03, 0.02, 0.05], 'glove', null, 10);
  return { spine, headG, thigh, shin, shoe, pedal, crank, upper, fore, hand };
}

// ---------------------------------------------------------------- public API
export function createRider() {
  const root = new THREE.Group(); root.name = 'rider';
  const lean = new THREE.Group(); root.add(lean); // rolls around the contact line

  const bikeMat = patchMaterial(new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.4, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08,
  }), { key: 'riderBike' });
  const bodyMat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 }), { key: 'riderBody' });

  // static bike: one mesh; wheels: one mesh each
  const bike = new THREE.Group(); lean.add(bike);
  const bikeMesh = new THREE.Mesh(bikeGeo(), bikeMat); bikeMesh.castShadow = true; bikeMesh.receiveShadow = true; bike.add(bikeMesh);
  const wR = new THREE.Group(), wF = new THREE.Group();
  wR.position.set(...RA); wF.position.set(...FA);
  for (const [w, rear] of [[wR, true], [wF, false]]) {
    const m = new THREE.Mesh(wheelGeo(rear), bikeMat); m.castShadow = true; m.receiveShadow = true; w.add(m); bike.add(w);
  }

  // rider: parts are CPU-skinned into one mesh each frame
  const G = buildRiderGeo();
  const parts = [];
  const addPart = (g, spine = false) => {
    const p = {
      P: g.attributes.position.array, N: g.attributes.normal.array, C: g.attributes.color.array,
      n: g.attributes.position.count, spine, pos: new THREE.Vector3(), quat: new THREE.Quaternion(),
    };
    parts.push(p); return p;
  };
  const spinePart = addPart(G.spine, true);
  const headPart = addPart(G.headG, true);
  headPart.pos.copy(V(HEAD_AT));
  const legs = [-1, 1].map((s) => ({
    s, thigh: addPart(G.thigh), shin: addPart(G.shin), shoe: addPart(G.shoe), pedal: addPart(G.pedal), crank: addPart(G.crank),
  }));
  const arms = [-1, 1].map((s) => ({ s, upper: addPart(G.upper), fore: addPart(G.fore), hand: addPart(G.hand) }));

  let nv = 0;
  for (const p of parts) nv += p.n * 3;
  const bPos = new Float32Array(nv), bNor = new Float32Array(nv), bCol = new Float32Array(nv);
  { let o = 0; for (const p of parts) { bCol.set(p.C, o); o += p.n * 3; } }
  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute('position', new THREE.BufferAttribute(bPos, 3).setUsage(THREE.DynamicDrawUsage));
  bodyGeo.setAttribute('normal', new THREE.BufferAttribute(bNor, 3).setUsage(THREE.DynamicDrawUsage));
  bodyGeo.setAttribute('color', new THREE.BufferAttribute(bCol, 3));
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.castShadow = true; bodyMesh.receiveShadow = true; bodyMesh.frustumCulled = false;
  lean.add(bodyMesh);

  const Mspine = new THREE.Matrix4(), _m = new THREE.Matrix4();
  function skin() {
    let o = 0;
    for (const p of parts) {
      _m.compose(p.pos, p.quat, ONE);
      if (p.spine) _m.premultiply(Mspine);
      const e = _m.elements, P = p.P, N = p.N, n = p.n * 3;
      for (let i = 0; i < n; i += 3, o += 3) {
        const x = P[i], y = P[i + 1], z = P[i + 2];
        bPos[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
        bPos[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        bPos[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        const a = N[i], b = N[i + 1], c = N[i + 2];
        bNor[o] = e[0] * a + e[4] * b + e[8] * c;
        bNor[o + 1] = e[1] * a + e[5] * b + e[9] * c;
        bNor[o + 2] = e[2] * a + e[6] * b + e[10] * c;
      }
    }
    bodyGeo.attributes.position.needsUpdate = true;
    bodyGeo.attributes.normal.needsUpdate = true;
  }

  // ---- posing
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _t = new THREE.Vector3();
  const hipJ = new THREE.Vector3(), pedal = new THREE.Vector3(), knee = new THREE.Vector3(), ankle = new THREE.Vector3();
  const axle = new THREE.Vector3(), shJ = new THREE.Vector3(), elbow = new THREE.Vector3(), wrist = new THREE.Vector3();
  const spineP = new THREE.Vector3(), spineQ = new THREE.Quaternion(), qx = new THREE.Quaternion(), qz = new THREE.Quaternion();
  const kneeBend = new THREE.Vector3(0, 0.3, 1).normalize();

  // two-bone IK: a->c with bone lengths l1, l2; bend hint picks the side of the plane
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
  // orient a part so its +y axis runs from a to b
  function aim(p, a, b) {
    p.pos.copy(a);
    _d.subVectors(b, a).normalize();
    p.quat.setFromUnitVectors(UP, _d);
  }
  function pedalAt(s, out) {
    const a = crankA + (s > 0 ? Math.PI : 0);
    return out.set(s * 0.095, BB[1] + Math.cos(a) * CRANK, BB[2] + Math.sin(a) * CRANK);
  }

  // hands on the hoods; wrist target and grip direction are fixed in the bike frame
  const GRIP = new THREE.Vector3();
  for (const A of arms) {
    A.bend = new THREE.Vector3(A.s * 0.7, -0.3, -0.8).normalize();
    A.wrist = new THREE.Vector3(A.s * 0.19, 0.975, 0.34);
    GRIP.set(A.s * 0.2, 0.93, 0.415).sub(A.wrist).normalize();
    A.hand.pos.copy(A.wrist);
    A.hand.quat.setFromUnitVectors(Z, GRIP);
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
    const climb = Math.min(1, Math.max(0, (grade - 0.03) / 0.07));
    const standWant = grade > 0.08 && clock % 30 < 9 ? 1 : 0;
    standA += (standWant - standA) * Math.min(1, dt * 2);
    const roll = Math.sin(crankA) * (0.015 + 0.03 * climb) * Math.min(1, speed / 4);
    const phi = PHI_REST - standA * 0.4;
    spineP.set(0, HIP[1], HIP[2] + standA * 0.1);
    qx.setFromAxisAngle(X, phi);
    qz.setFromAxisAngle(Z, roll);
    spineQ.multiplyQuaternions(qz, qx);
    Mspine.compose(spineP, spineQ, ONE);
    headPart.quat.setFromAxisAngle(X, HEAD_PITCH - phi);

    for (const L of legs) {
      hipJ.set(L.s * 0.1, HIP[1], spineP.z);
      pedalAt(L.s, pedal);
      ankle.set(pedal.x, pedal.y + 0.075, pedal.z - 0.035);
      ik(hipJ, ankle, L_THIGH, L_SHIN, kneeBend, knee);
      aim(L.thigh, hipJ, knee);
      aim(L.shin, knee, ankle);
      L.shoe.pos.set(pedal.x, pedal.y + 0.012, pedal.z);
      L.pedal.pos.copy(pedal);
      axle.set(L.s * 0.045, BB[1], BB[2]);
      aim(L.crank, axle, pedal);
    }
    for (const A of arms) {
      shJ.set(A.s * 0.158, SHOULDER, 0).applyMatrix4(Mspine);
      ik(shJ, A.wrist, L_UP, L_FORE, A.bend, elbow);
      aim(A.upper, shJ, elbow);
      aim(A.fore, elbow, A.wrist);
    }
    skin();
  }
  update(0, 0, 0, 0);
  return { root, update };
}
