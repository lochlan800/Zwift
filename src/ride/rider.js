import * as THREE from 'three';
import { patchMaterial } from '../world/shared.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Procedural road bike + rider. Local frame: +z forward, +y up, +x = rider's left.
const R_WHEEL = 0.336;
const CRANK = 0.1725;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

function std(color, rough = 0.5, metal = 0, extra = {}) {
  const m = new THREE.MeshPhysicalMaterial({ color, roughness: rough, metalness: metal, ...extra });
  return patchMaterial(m, { key: 'rider' + (extra.clearcoat ? 'cc' : '') });
}

// a unit cylinder along +y from 0..1, placed between two points each frame
class Limb {
  constructor(parent, r0, r1, mat, seg = 10) {
    const g = new THREE.CylinderGeometry(r1, r0, 1, seg, 1, false);
    g.translate(0, 0.5, 0);
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.castShadow = true;
    parent.add(this.mesh);
  }
  set(a, b) {
    _d.subVectors(b, a);
    const len = _d.length();
    this.mesh.position.copy(a);
    _q.setFromUnitVectors(_up, _d.multiplyScalar(1 / len));
    this.mesh.quaternion.copy(_q);
    this.mesh.scale.set(1, len, 1);
  }
}

function tube(parent, a, b, r, mat) { const l = new Limb(parent, r, r, mat, 8); l.set(new THREE.Vector3(...a), new THREE.Vector3(...b)); return l; }

function joint(parent, r, mat, seg = 12) { const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, seg >> 1), mat); m.castShadow = true; parent.add(m); return m; }

function wheel(mats) {
  const g = new THREE.Group();
  const tyre = new THREE.Mesh(new THREE.TorusGeometry(R_WHEEL - 0.012, 0.0125, 8, 40), mats.tyre);
  tyre.rotation.y = Math.PI / 2; tyre.castShadow = true; g.add(tyre);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(R_WHEEL - 0.035, 0.014, 6, 40), mats.rim);
  rim.rotation.y = Math.PI / 2; rim.scale.set(1, 1, 1.6); rim.castShadow = true; g.add(rim);
  const pos = [];
  const n = 24;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, side = (i & 1) ? 1 : -1;
    pos.push(side * 0.03, 0, 0, 0, Math.cos(a) * (R_WHEEL - 0.045), Math.sin(a) * (R_WHEEL - 0.045));
  }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.add(new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0x9aa0a8 })));
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.1, 10), mats.rim);
  hub.rotation.z = Math.PI / 2; g.add(hub);
  return g;
}

export function createRider() {
  const root = new THREE.Group(); root.name = 'rider';
  const lean = new THREE.Group(); root.add(lean); // rolls around contact line
  const mats = {
    frame: std(0xe8551d, 0.32, 0.25, { clearcoat: 1, clearcoatRoughness: 0.12 }),
    frame2: std(0x111216, 0.4, 0.2, { clearcoat: 1, clearcoatRoughness: 0.15 }),
    tyre: std(0x141414, 0.85),
    rim: std(0x2a2c30, 0.3, 0.8),
    alu: std(0xb8bcc4, 0.3, 0.9),
    jersey: std(0x1e6fd9, 0.6, 0, { sheen: 1, sheenColor: new THREE.Color(0x88b4ff), sheenRoughness: 0.5 }),
    jersey2: std(0xf5f5f5, 0.6),
    shorts: std(0x101114, 0.55, 0, { sheen: 0.6, sheenColor: new THREE.Color(0x444444) }),
    skin: std(0xc68a6a, 0.6, 0, { sheen: 0.3, sheenColor: new THREE.Color(0xffc0a0) }),
    helmet: std(0xf2f2f2, 0.3, 0, { clearcoat: 1, clearcoatRoughness: 0.2 }),
    shoe: std(0xf0f0f0, 0.4),
    sock: std(0xffffff, 0.8),
    visor: std(0x111111, 0.05, 0.6),
    saddle: std(0x0c0c0c, 0.5),
  };
  const bike = new THREE.Group(); lean.add(bike);
  const RA = [0, R_WHEEL, -0.505], FA = [0, R_WHEEL, 0.485], BB = [0, 0.27, -0.09];
  const ST = [0, 0.86, -0.27], HT = [0, 0.86, 0.36], HB = [0, 0.71, 0.405];
  tube(bike, BB, ST, 0.017, mats.frame);
  tube(bike, BB, HB, 0.024, mats.frame);
  tube(bike, ST, HT, 0.016, mats.frame);
  tube(bike, HB, HT, 0.024, mats.frame2);
  for (const s of [-1, 1]) {
    tube(bike, [s * 0.04, BB[1], BB[2]], [s * 0.065, RA[1], RA[2]], 0.011, mats.frame);
    tube(bike, [s * 0.025, ST[1] - 0.03, ST[2] + 0.005], [s * 0.065, RA[1], RA[2]], 0.009, mats.frame);
    tube(bike, [s * 0.03, HB[1], HB[2]], [s * 0.05, FA[1], FA[2]], 0.011, mats.frame2);
  }
  // seatpost + saddle
  tube(bike, ST, [0, 0.99, -0.305], 0.0135, mats.frame2);
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.03, 0.26), mats.saddle);
  saddle.position.set(0, 1.0, -0.285); saddle.castShadow = true; bike.add(saddle);
  // stem + bars
  const stemEnd = [0, 0.905, 0.46];
  tube(bike, HT, [0, 0.9, 0.37], 0.016, mats.frame2);
  tube(bike, [0, 0.9, 0.37], stemEnd, 0.014, mats.frame2);
  tube(bike, [-0.21, stemEnd[1], stemEnd[2]], [0.21, stemEnd[1], stemEnd[2]], 0.012, mats.frame2);
  for (const s of [-1, 1]) {
    tube(bike, [s * 0.21, stemEnd[1], stemEnd[2]], [s * 0.21, stemEnd[1] + 0.03, stemEnd[2] + 0.07], 0.012, mats.frame2);
    tube(bike, [s * 0.21, stemEnd[1], stemEnd[2]], [s * 0.21, stemEnd[1] - 0.1, stemEnd[2] + 0.06], 0.012, mats.frame2);
    tube(bike, [s * 0.21, stemEnd[1] - 0.1, stemEnd[2] + 0.06], [s * 0.21, stemEnd[1] - 0.13, stemEnd[2] - 0.03], 0.012, mats.frame2);
  }
  // chainring
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.006, 6, 32), mats.alu);
  ring.rotation.y = Math.PI / 2; ring.position.set(-0.06, BB[1], BB[2]); bike.add(ring);
  const wR = wheel(mats), wF = wheel(mats);
  wR.position.set(...RA); wF.position.set(...FA);
  bike.add(wR, wF);
  const crank = new THREE.Group(); crank.position.set(0, BB[1], BB[2]); bike.add(crank);
  const armL = new Limb(crank, 0.011, 0.011, mats.alu, 6), armR = new Limb(crank, 0.011, 0.011, mats.alu, 6);

  // --- rider body
  const body = new THREE.Group(); lean.add(body);
  const hip = new THREE.Vector3(0, 1.035, -0.25);
  const shoulder = new THREE.Vector3(0, 1.39, 0.17);
  const torso = new Limb(body, 0.135, 0.15, mats.jersey, 14); torso.set(hip, shoulder);
  torso.mesh.scale.x = 1.0;
  const pelvis = joint(body, 0.13, mats.shorts); pelvis.position.copy(hip); pelvis.scale.set(1.15, 0.8, 1.2);
  const chest = joint(body, 0.15, mats.jersey, 16); chest.position.copy(shoulder).lerp(hip, 0.18); chest.scale.set(1.25, 0.85, 1.1);
  const neck = new Limb(body, 0.05, 0.045, mats.skin); neck.set(new THREE.Vector3(0, 1.42, 0.2), new THREE.Vector3(0, 1.5, 0.26));
  const head = joint(body, 0.1, mats.skin, 16); head.position.set(0, 1.55, 0.3); head.scale.set(0.9, 1.05, 1.05);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), mats.helmet);
  helmet.position.set(0, 1.575, 0.285); helmet.scale.set(0.95, 0.9, 1.25); helmet.rotation.x = 0.35; helmet.castShadow = true; body.add(helmet);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.104, 16, 6, -1.2, 2.4, 1.35, 0.4), mats.visor);
  visor.position.copy(head.position); visor.rotation.y = 0; visor.rotation.x = 0; body.add(visor);
  // jersey stripe
  const stripe = new Limb(body, 0.137, 0.152, mats.jersey2, 14); stripe.set(hip.clone().lerp(shoulder, 0.55), hip.clone().lerp(shoulder, 0.62));

  const legs = [-1, 1].map((s) => ({
    s, thigh: new Limb(body, 0.075, 0.058, mats.shorts), shin: new Limb(body, 0.05, 0.04, mats.skin),
    sock: new Limb(body, 0.042, 0.038, mats.sock), knee: joint(body, 0.058, mats.skin), foot: (() => {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.06, 0.26), mats.shoe); f.castShadow = true; body.add(f); return f;
    })(),
  }));
  const arms = [-1, 1].map((s) => ({
    s, upper: new Limb(body, 0.05, 0.042, mats.jersey), fore: new Limb(body, 0.04, 0.032, mats.skin), elbow: joint(body, 0.045, mats.skin),
    hand: joint(body, 0.038, mats.frame2),
  }));
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  // ---- draw-call reduction: bake parts into vertex-coloured merged meshes
  const colGeo = (o, matrix) => {
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    if (matrix) g.applyMatrix4(matrix);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    const n = g.attributes.position.count, c = new Float32Array(n * 3), col = o.material.color;
    for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  };
  const bikeMat = patchMaterial(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.15 }), { key: 'riderBike' });
  const bodyMat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.0 }), { key: 'riderBody' });
  // static bike: one mesh
  {
    const gs = [];
    for (const o of [...bike.children]) { if (!o.isMesh) continue; o.updateMatrix(); gs.push(colGeo(o, o.matrix)); bike.remove(o); }
    const mm = new THREE.Mesh(mergeGeometries(gs), bikeMat); mm.castShadow = true; mm.receiveShadow = true; bike.add(mm);
  }
  // wheels: tyre+rim+hub in one mesh each (spokes stay a line)
  for (const w of [wR, wF]) {
    const gs = [];
    for (const o of [...w.children]) { if (!o.isMesh) continue; o.updateMatrix(); gs.push(colGeo(o, o.matrix)); w.remove(o); }
    const mm = new THREE.Mesh(mergeGeometries(gs), bikeMat); mm.castShadow = true; mm.receiveShadow = true; w.add(mm);
  }
  // animated body: CPU-skinned single mesh rebuilt each frame from the (hidden) part transforms
  const parts = [];
  for (const o of [...body.children]) {
    if (!o.isMesh) continue;
    const g = colGeo(o, null);
    parts.push({ o, pos: g.attributes.position.array, nor: g.attributes.normal.array, col: g.attributes.color.array });
    o.visible = false;
  }
  const nv = parts.reduce((a, p) => a + p.pos.length / 3, 0);
  const bPos = new Float32Array(nv * 3), bNor = new Float32Array(nv * 3), bCol = new Float32Array(nv * 3);
  { let o = 0; for (const p of parts) { bCol.set(p.col, o); o += p.col.length; } }
  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute('position', new THREE.BufferAttribute(bPos, 3).setUsage(THREE.DynamicDrawUsage));
  bodyGeo.setAttribute('normal', new THREE.BufferAttribute(bNor, 3).setUsage(THREE.DynamicDrawUsage));
  bodyGeo.setAttribute('color', new THREE.BufferAttribute(bCol, 3));
  bodyGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 2);
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.castShadow = true; bodyMesh.receiveShadow = true;
  body.add(bodyMesh);
  const _m = new THREE.Matrix4(), _n = new THREE.Matrix3();
  function skin() {
    let o = 0;
    for (const p of parts) {
      p.o.updateMatrix();
      const e = _m.copy(p.o.matrix).elements;
      _n.getNormalMatrix(_m); const q = _n.elements;
      const P = p.pos, N = p.nor;
      for (let i = 0; i < P.length; i += 3, o += 3) {
        const x = P[i], y = P[i + 1], z = P[i + 2];
        bPos[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
        bPos[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        bPos[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        const a = N[i], b = N[i + 1], c = N[i + 2];
        let nx = q[0] * a + q[3] * b + q[6] * c, ny = q[1] * a + q[4] * b + q[7] * c, nz = q[2] * a + q[5] * b + q[8] * c;
        const l = 1 / (Math.hypot(nx, ny, nz) || 1);
        bNor[o] = nx * l; bNor[o + 1] = ny * l; bNor[o + 2] = nz * l;
      }
    }
    bodyGeo.attributes.position.needsUpdate = true;
    bodyGeo.attributes.normal.needsUpdate = true;
  }

  const hipJ = new THREE.Vector3(), pedal = new THREE.Vector3(), knee = new THREE.Vector3(), ankle = new THREE.Vector3();
  const shJ = new THREE.Vector3(), hand = new THREE.Vector3(), elbow = new THREE.Vector3();
  const tmp = new THREE.Vector3(), c0 = new THREE.Vector3(), c1 = new THREE.Vector3();

  // two-bone IK in a plane containing a->c with bend direction hint
  function ik(a, c, l1, l2, bend, out) {
    tmp.subVectors(c, a);
    let d = tmp.length();
    const dd = Math.min(d, l1 + l2 - 1e-3);
    tmp.multiplyScalar(1 / d);
    const x = (l1 * l1 - l2 * l2 + dd * dd) / (2 * dd);
    const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
    // perpendicular in plane of tmp and bend
    _b.copy(bend).addScaledVector(tmp, -bend.dot(tmp)).normalize();
    out.copy(a).addScaledVector(tmp, x).addScaledVector(_b, h);
  }
  const kneeBend = new THREE.Vector3(0, 0.3, 1).normalize();
  const elbowBend = new THREE.Vector3(0, -0.2, -1).normalize();

  let crankA = 0, wheelA = 0, leanA = 0, bob = 0;
  function update(dt, speed, leanTarget, cadenceRpm) {
    crankA += (cadenceRpm / 60) * Math.PI * 2 * dt;
    wheelA += (speed / R_WHEEL) * dt;
    wR.rotation.x = wheelA; wF.rotation.x = wheelA;
    leanA += (leanTarget - leanA) * Math.min(1, dt * 4);
    lean.rotation.z = -leanA;
    // pedals
    const pl = (s) => {
      const a = crankA + (s > 0 ? Math.PI : 0);
      return pedal.set(s * 0.115, BB[1] + Math.cos(a) * CRANK, BB[2] + Math.sin(a) * CRANK);
    };
    armL.set(c0.set(0.09, 0, 0), c1.set(0.09, Math.cos(crankA + Math.PI) * CRANK, Math.sin(crankA + Math.PI) * CRANK));
    armR.set(c0.set(-0.09, 0, 0), c1.set(-0.09, Math.cos(crankA) * CRANK, Math.sin(crankA) * CRANK));
    bob = Math.sin(crankA * 2) * 0.006;
    body.position.y = bob;
    body.rotation.z = Math.sin(crankA) * 0.025 * Math.min(1, speed / 5);
    for (const L of legs) {
      hipJ.set(L.s * 0.095, hip.y - 0.02, hip.z);
      pl(L.s);
      ankle.copy(pedal); ankle.y += 0.07; ankle.z -= 0.03;
      ik(hipJ, ankle, 0.43, 0.44, kneeBend, knee);
      L.thigh.set(hipJ, knee); L.shin.set(knee, ankle);
      L.knee.position.copy(knee);
      tmp.copy(knee).lerp(ankle, 0.75); L.sock.set(tmp, ankle);
      L.foot.position.set(pedal.x, pedal.y + 0.03, pedal.z + 0.035);
      L.foot.rotation.x = -0.12 + Math.sin(crankA + (L.s > 0 ? Math.PI : 0)) * 0.18;
    }
    for (const A of arms) {
      shJ.set(A.s * 0.2, shoulder.y - 0.03, shoulder.z);
      hand.set(A.s * 0.205, stemEnd[1] + 0.035, stemEnd[2] + 0.055);
      tmp.set(A.s * 0.6, -0.2, -1).normalize();
      ik(shJ, hand, 0.29, 0.28, tmp, elbow);
      A.upper.set(shJ, elbow); A.fore.set(elbow, hand);
      A.elbow.position.copy(elbow); A.hand.position.copy(hand);
    }
    skin();
  }
  update(0, 0, 0, 0);
  return { root, update };
}
