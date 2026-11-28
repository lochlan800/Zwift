import * as THREE from 'three';

// ---------------------------------------------------------------------------------------------
// Smooth, continuous pedestrian and dog meshes for the instanced crowd (people.js).
//   - Each body is ONE indexed mesh built from lofted elliptical sections (torso, neck, head, dog body) and
//     tapered limb tubes with rounded caps. Limb rings that meet at a joint share position and radius.
//   - Skinning is analytic: every vertex carries aSk = (boneA, boneB, blend). The vertex shader rotates the
//     vertex about each bone's pivot (hip, knee, shoulder, elbow...) and blends the two results, so
//     joints bend smoothly with no ball joints and no CPU skinning. Nothing is allocated per frame.
//   - aMat selects a colour region (top, trousers, skin, hair, shoes, coat hem, umbrella...) which the
//     shader resolves from per-instance colours, so one mesh gives many outfits.
// ---------------------------------------------------------------------------------------------

const UPV = new THREE.Vector3(0, 1, 0);

class Body {
  constructor() { this.P = []; this.SK = []; this.M = []; this.I = []; }
  // generic grid -> indexed surface. rings[k] = array of [x,y,z]; per-vertex bone / material callbacks
  _grid(rings, seg, skFn, matFn, flip = false) {
    const o = this.P.length / 3, R = rings.length;
    for (let k = 0; k < R; k++) for (let j = 0; j < seg; j++) {
      const p = rings[k][j], th = (j / seg) * Math.PI * 2, u = rings[k].u;
      this.P.push(p[0], p[1], p[2]);
      const s = skFn(u, th, p); this.SK.push(s[0], s[1], s[2]);
      this.M.push(matFn(u, th, p));
    }
    for (let k = 0; k < R - 1; k++) for (let j = 0; j < seg; j++) {
      const j1 = (j + 1) % seg;
      const a = o + k * seg + j, b = o + k * seg + j1, c = o + (k + 1) * seg + j, d = o + (k + 1) * seg + j1;
      if (flip) this.I.push(a, b, c, b, d, c); else this.I.push(a, c, b, b, c, d);
    }
  }
  // tapered tube from a to b; r(u) radius; rounded caps optional
  tube(a, b, r, { seg = 10, rings = 8, capA = false, capB = false, sk, mat }) {
    a = new THREE.Vector3(...a); b = new THREE.Vector3(...b);
    const dir = new THREE.Vector3().subVectors(b, a), len = dir.length(); dir.normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(UPV, dir);
    const prof = [];
    const r0 = r(0), r1 = r(1);
    if (capA) for (let k = 0; k < 3; k++) { const ph = ((k + 0.5) / 3.2) * Math.PI / 2; prof.push([-r0 * Math.cos(ph), r0 * Math.sin(ph), 0]); }
    for (let k = 0; k <= rings; k++) { const u = k / rings; prof.push([u * len, r(u), u]); }
    if (capB) for (let k = 2; k >= 0; k--) { const ph = ((k + 0.5) / 3.2) * Math.PI / 2; prof.push([len + r1 * Math.cos(ph), r1 * Math.sin(ph), 1]); }
    const rg = prof.map(([y, rad, u]) => {
      const ring = [];
      for (let j = 0; j < seg; j++) { const th = (j / seg) * Math.PI * 2; const v = new THREE.Vector3(Math.cos(th) * rad, y, Math.sin(th) * rad).applyQuaternion(q).add(a); ring.push([v.x, v.y, v.z]); }
      ring.u = u; return ring;
    });
    this._grid(rg, seg, sk, mat);
  }
  // loft of elliptical sections along 'y' or 'z'. sec = {t, rx, r2, c1, c2}
  loft(axis, secs, { seg = 14, sk, mat }) {
    const rg = secs.map((s, i) => {
      const ring = [];
      for (let j = 0; j < seg; j++) {
        const th = (j / seg) * Math.PI * 2, c = Math.cos(th), sn = Math.sin(th);
        ring.push(axis === 'y' ? [s.c1 + s.rx * c, s.t, s.c2 + s.r2 * sn] : [s.c1 + s.rx * c, s.c2 + s.r2 * sn, s.t]);
      }
      ring.u = s.u != null ? s.u : i / (secs.length - 1); return ring;
    });
    this._grid(rg, seg, sk, mat, axis === 'z');
  }
  // closed ellipsoid
  ell(c, r, { seg = 10, rings = 7, sk, mat, rot = null }) {
    const rg = [];
    for (let k = 0; k <= rings; k++) {
      const ph = (k / rings) * Math.PI, ring = [];
      for (let j = 0; j < seg; j++) {
        const th = (j / seg) * Math.PI * 2;
        const v = new THREE.Vector3(Math.sin(ph) * Math.cos(th) * r[0], Math.cos(ph) * r[1], Math.sin(ph) * Math.sin(th) * r[2]);
        if (rot) v.applyEuler(rot);
        ring.push([c[0] + v.x, c[1] + v.y, c[2] + v.z]);
      }
      ring.u = k / rings; rg.push(ring);
    }
    this._grid(rg, seg, sk, mat, true);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('aSk', new THREE.Float32BufferAttribute(this.SK, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.M, 1));
    g.setIndex(this.I);
    g.computeVertexNormals();
    return g;
  }
}
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const gauss = (u, c, w) => Math.exp(-(((u - c) / w) ** 2));

// ================================================================== PERSON
// bones: 0 torso/head, 1/2 thigh L/R, 3/4 shin L/R, 5/6 upper arm L/R, 7/8 forearm L/R
// materials: 0 top, 1 trousers, 2 skin, 3 hair, 4 shoe, 5 forearm (sleeve/skin), 7 sole, 8 coat hem, 10 lead, 11 umbrella pole, 12 canopy
export function personGeometry() {
  const B = new Body();
  const T = (m) => () => m;
  const torsoSk = () => [0, 0, 0];
  // ---- torso + neck: one loft (pelvis -> waist -> chest -> shoulders -> neck)
  const secs = [
    [0.80, 0.135, 0.095], [0.86, 0.17, 0.108], [0.92, 0.178, 0.112], [1.02, 0.158, 0.1], [1.12, 0.165, 0.102], [1.24, 0.185, 0.108],
    [1.34, 0.2, 0.105], [1.41, 0.205, 0.095], [1.47, 0.135, 0.08], [1.51, 0.06, 0.058], [1.60, 0.048, 0.05],
  ].map(([t, rx, r2], i, a) => ({ t, rx, r2, c1: 0, c2: t > 1.2 ? -0.004 : 0, u: i / (a.length - 1) }));
  B.loft('y', secs, { seg: 16, sk: torsoSk, mat: (u, th, p) => (p[1] > 1.46 ? 2 : p[1] > 0.96 ? 0 : p[1] > 0.84 ? 8 : 1) });
  // ---- legs
  for (const [s, hip, shin] of [[1, 1, 3], [-1, 2, 4]]) {
    const x = s * 0.09;
    // thigh: top inside the pelvis, tapers to the knee; blends to the torso at the top and the shin at the knee
    B.tube([x, 0.95, 0], [x, 0.48, 0], (u) => 0.098 - 0.036 * u + 0.006 * gauss(u, 0.15, 0.2), {
      seg: 12, rings: 8, capA: false, capB: false,
      sk: (u) => (u < 0.5 ? [hip, 0, 0.5 * (1 - sm(0, 0.25, u))] : [hip, shin, 0.5 * sm(0.72, 1, u)]),
      mat: (u) => (u < 0.38 ? 8 : 1),
    });
    // shin: calf bulge, thin ankle
    B.tube([x, 0.48, 0], [x, 0.09, 0], (u) => 0.06 - 0.026 * u + 0.008 * gauss(u, 0.28, 0.2), {
      seg: 12, rings: 8, capB: false,
      sk: (u) => [shin, hip, 0.5 * (1 - sm(0, 0.22, u))],
      mat: (u) => (u > 0.93 ? 2 : 1),
    });
    // shoe: toe box, heel counter, sole (move with the shin)
    const shk = () => [shin, shin, 0];
    B.ell([x, 0.075, 0.02], [0.048, 0.05, 0.075], { seg: 10, rings: 6, sk: shk, mat: T(4) });          // ankle/heel
    B.ell([x, 0.045, 0.1], [0.05, 0.036, 0.1], { seg: 10, rings: 6, sk: shk, mat: T(4) });              // forefoot
    B.ell([x, 0.016, 0.06], [0.052, 0.016, 0.15], { seg: 10, rings: 5, sk: shk, mat: T(7) });           // sole
  }
  // ---- arms
  for (const [s, up, fo] of [[1, 5, 7], [-1, 6, 8]]) {
    const sx = s * 0.215, ex = s * 0.235, wx = s * 0.25;
    B.ell([sx, 1.385, 0], [0.062, 0.07, 0.062], { seg: 10, rings: 6, sk: () => [up, 0, 0.35], mat: T(0) });    // deltoid
    B.tube([sx, 1.40, 0], [ex, 1.12, 0], (u) => 0.052 - 0.011 * u + 0.004 * gauss(u, 0.3, 0.2), {
      seg: 10, rings: 6, sk: (u) => (u < 0.4 ? [up, 0, 0.4 * (1 - sm(0, 0.3, u))] : [up, fo, 0.5 * sm(0.72, 1, u)]), mat: T(0),
    });
    B.tube([ex, 1.12, 0], [wx, 0.90, 0], (u) => 0.041 - 0.011 * u + 0.004 * gauss(u, 0.25, 0.25), {
      seg: 10, rings: 5, sk: (u) => [fo, up, 0.5 * (1 - sm(0, 0.25, u))], mat: (u) => (u > 0.88 ? 2 : 5),
    });
    B.ell([wx, 0.845, 0.004], [0.034, 0.07, 0.026], { seg: 10, rings: 6, sk: () => [fo, fo, 0], mat: T(2) });  // hand
    B.ell([wx + s * -0.004, 0.865, 0.03], [0.012, 0.03, 0.012], { seg: 6, rings: 4, sk: () => [fo, fo, 0], mat: T(2) }); // thumb
  }
  // ---- head: skull + jaw, hair cap + back volume, ears, face features
  const hs = () => [0, 0, 0];
  B.ell([0, 1.70, 0.012], [0.079, 0.108, 0.094], { seg: 14, rings: 10, sk: hs, mat: T(2) });
  B.ell([0, 1.62, 0.025], [0.062, 0.05, 0.075], { seg: 10, rings: 6, sk: hs, mat: T(2) });                       // jaw / chin
  B.ell([0, 1.725, -0.012], [0.088, 0.108, 0.1], { seg: 14, rings: 8, sk: hs, mat: T(3), rot: new THREE.Euler(-0.28, 0, 0) });  // hair mass
  B.ell([0, 1.69, -0.062], [0.082, 0.085, 0.06], { seg: 10, rings: 6, sk: hs, mat: T(3) });                      // hair volume at the back
  for (const s of [-1, 1]) {
    B.ell([s * 0.08, 1.685, 0.0], [0.011, 0.028, 0.018], { seg: 6, rings: 4, sk: hs, mat: T(2) });               // ears
    B.ell([s * 0.032, 1.705, 0.092], [0.011, 0.0085, 0.008], { seg: 6, rings: 4, sk: hs, mat: T(4) });          // eyes
    B.ell([s * 0.033, 1.724, 0.088], [0.021, 0.005, 0.01], { seg: 6, rings: 4, sk: hs, mat: T(3) });            // brows
  }
  B.ell([0, 1.678, 0.102], [0.011, 0.022, 0.015], { seg: 6, rings: 4, sk: hs, mat: T(2) });                       // nose
  B.ell([0, 1.642, 0.09], [0.027, 0.005, 0.01], { seg: 6, rings: 4, sk: hs, mat: T(4) });                         // mouth
  // ---- dog lead (hand -> collar, 1.5 m ahead) shown only for dog walkers; umbrella only in rain
  B.tube([0.25, 0.86, 0.05], [0.0, 0.5, 1.5], () => 0.0045, { seg: 4, rings: 6, sk: () => [0, 0, 0], mat: T(10) });
  B.tube([0.25, 0.86, 0.27], [0.25, 2.04, 0.27], () => 0.009, { seg: 5, rings: 3, sk: () => [0, 0, 0], mat: T(11) });
  B.ell([0.25, 2.0, 0.27], [0.56, 0.2, 0.56], { seg: 16, rings: 6, sk: () => [0, 0, 0], mat: T(12) });
  return B.build();
}

export const PERSON_PARS = /* glsl */`
attribute vec3 aSk; attribute float aMat;
attribute vec4 aMisc;       // phase, walking(0/1), scale, flags: skin(0-3) + 4 sleeve + 8 umbrella + 16 dog + 32 long coat
attribute vec3 aShirt; attribute vec3 aTrou; attribute vec3 aHair;
flat varying vec3 vMatCol; flat varying float vRough;
varying float vObjY; varying float vCloth; varying vec3 vShirt; varying vec3 vTrou; varying float vCoatF;
vec3 pv(int b) {
  if (b == 1) return vec3(0.09, 0.95, 0.0);  if (b == 2) return vec3(-0.09, 0.95, 0.0);
  if (b == 3) return vec3(0.09, 0.48, 0.0);  if (b == 4) return vec3(-0.09, 0.48, 0.0);
  if (b == 5) return vec3(0.215, 1.40, 0.0); if (b == 6) return vec3(-0.215, 1.40, 0.0);
  if (b == 7) return vec3(0.235, 1.12, 0.0); if (b == 8) return vec3(-0.235, 1.12, 0.0);
  return vec3(0.0, 1.0, 0.0);
}
vec3 rX(vec3 p, vec3 c, float th) { float cs = cos(th), sn = sin(th); vec3 d = p - c; return c + vec3(d.x, d.y * cs - d.z * sn, d.y * sn + d.z * cs); }
vec3 rY(vec3 p, vec3 c, float th) { float cs = cos(th), sn = sin(th); vec3 d = p - c; return c + vec3(d.x * cs + d.z * sn, d.y, -d.x * sn + d.z * cs); }
void bone(int b, inout vec3 p, inout vec3 n) {
  float a = aMisc.x, sw = aMisc.y;
  bool umb = mod(floor(aMisc.w / 8.0), 2.0) > 0.5;
  float hipL = 0.5 * sin(a) * sw, hipR = -hipL;
  float kneeL = 0.9 * max(0.0, cos(a)) * sw, kneeR = 0.9 * max(0.0, -cos(a)) * sw;
  float armL = -0.42 * sin(a) * sw, armR = -armL;
  float elb = 0.15 + 0.35 * sw;
  float elbR = elb;
  if (umb) { armR = -0.30; elbR = 1.25; }
  float tw = 0.07 * sin(a) * sw;
  vec3 O = vec3(0.0);
  if (b == 0) { p = rY(p, pv(0), tw); n = rY(n, O, tw); }
  else if (b == 1) { p = rX(p, pv(1), -hipL); n = rX(n, O, -hipL); }
  else if (b == 2) { p = rX(p, pv(2), -hipR); n = rX(n, O, -hipR); }
  else if (b == 3) { p = rX(p, pv(3), kneeL); n = rX(n, O, kneeL); p = rX(p, pv(1), -hipL); n = rX(n, O, -hipL); }
  else if (b == 4) { p = rX(p, pv(4), kneeR); n = rX(n, O, kneeR); p = rX(p, pv(2), -hipR); n = rX(n, O, -hipR); }
  else if (b == 5) { p = rX(p, pv(5), -armL); n = rX(n, O, -armL); }
  else if (b == 6) { p = rX(p, pv(6), -armR); n = rX(n, O, -armR); }
  else if (b == 7) { p = rX(p, pv(7), -elb); n = rX(n, O, -elb); p = rX(p, pv(5), -armL); n = rX(n, O, -armL); }
  else if (b == 8) { p = rX(p, pv(8), -elbR); n = rX(n, O, -elbR); p = rX(p, pv(6), -armR); n = rX(n, O, -armR); }
}
void skinPN(inout vec3 p, inout vec3 n) {
  vec3 p0 = p, n0 = n, p1 = p, n1 = n;
  bone(int(aSk.x + 0.5), p0, n0);
  if (aSk.z > 0.001) { bone(int(aSk.y + 0.5), p1, n1); p = mix(p0, p1, aSk.z); n = normalize(mix(n0, n1, aSk.z)); }
  else { p = p0; n = n0; }
}
`;
export const PERSON_NORMAL = /* glsl */`
vec3 objectNormal = vec3( normal );
vec3 pDummy = position;
skinPN(pDummy, objectNormal);
`;
export const PERSON_BEGIN = /* glsl */`
vec3 transformed = position;
vec3 nDummy = normal;
skinPN(transformed, nDummy);
transformed.y += abs(sin(aMisc.x)) * 0.014 * aMisc.y;
{
  float m = aMat;
  float sk = mod(aMisc.w, 4.0), sl = mod(floor(aMisc.w / 4.0), 2.0);
  float umb = mod(floor(aMisc.w / 8.0), 2.0), dog = mod(floor(aMisc.w / 16.0), 2.0), coat = mod(floor(aMisc.w / 32.0), 2.0);
  if ((m > 9.5 && m < 10.5 && dog < 0.5) || (m > 10.5 && umb < 0.5)) transformed *= 0.0;
  vec3 skin = sk < 0.5 ? vec3(0.50, 0.33, 0.25) : sk < 1.5 ? vec3(0.36, 0.21, 0.15) : sk < 2.5 ? vec3(0.22, 0.11, 0.075) : vec3(0.09, 0.045, 0.03);
  vec3 col = m < 0.5 ? aShirt : m < 1.5 ? aTrou : m < 2.5 ? skin : m < 3.5 ? aHair : m < 4.5 ? vec3(0.025, 0.022, 0.02) : (sl > 0.5 ? aShirt : skin);
  if (m > 6.5 && m < 7.5) col = vec3(0.12, 0.115, 0.11);
  if (m > 7.5 && m < 8.5) col = coat > 0.5 ? aShirt : aTrou;
  if (m > 9.5 && m < 11.5) col = vec3(0.03, 0.028, 0.026);
  if (m > 11.5) col = aTrou * 0.55 + 0.02;
  // skin contrast with the face: lips/cheeks a touch warmer is skipped; keep palettes muted
  vMatCol = col;
  vObjY = position.y; vCloth = ((m < 0.5) || (m > 0.5 && m < 1.5) || (m > 7.5 && m < 8.5)) ? 1.0 : 0.0; vShirt = aShirt; vTrou = aTrou; vCoatF = coat;
  vRough = (m < 0.5 || (m > 7.5 && m < 8.5)) ? 0.9 : m < 1.5 ? 0.85 : m < 2.5 ? 0.5 : m < 3.5 ? 0.75 : 0.55;
  transformed *= aMisc.z;
}
`;

// ================================================================== DOG
// bones: 0 body, 1/2 front upper L/R, 3/4 hind upper L/R, 5/6 front lower L/R, 7/8 hind lower L/R, 9 tail, 10 head
// materials: 0 coat, 1 light (muzzle, belly, paws), 2 nose/eyes, 3 floppy ear (dark coat), 4 prick ear, 5 collar
export function dogGeometry() {
  const B = new Body();
  const T = (m) => () => m;
  // body + neck + head: one loft along z (rump -> waist -> chest -> neck -> skull -> muzzle)
  const S = [
    [-0.31, 0.04, 0.05, 0.49], [-0.26, 0.085, 0.1, 0.5], [-0.17, 0.1, 0.115, 0.5], [-0.05, 0.088, 0.1, 0.49], [0.06, 0.097, 0.12, 0.5],
    [0.17, 0.105, 0.135, 0.51], [0.27, 0.085, 0.115, 0.55], [0.35, 0.058, 0.082, 0.6], [0.41, 0.052, 0.07, 0.645], [0.46, 0.062, 0.072, 0.675],
    [0.52, 0.054, 0.058, 0.67], [0.58, 0.042, 0.045, 0.655], [0.635, 0.032, 0.034, 0.645], [0.675, 0.022, 0.024, 0.64], [0.69, 0.005, 0.006, 0.64],
  ].map(([t, rx, r2, c2], i, a) => ({ t, rx: rx * (i >= 8 ? 1.12 : 1.14), r2: r2 * (i >= 8 ? 1.1 : 1.1), c1: 0, c2: c2 - 0.08, u: i / (a.length - 1) }));
  B.loft('z', S, {
    seg: 14,
    sk: (u, th, p) => [0, 10, sm(0.34, 0.46, p[2])],
    mat: (u, th, p) => (p[2] > 0.676 ? 2 : p[2] > 0.245 && p[2] < 0.275 ? 5 : p[2] > 0.5 && Math.sin(th) < 0.35 ? 1 : p[2] > -0.12 && p[2] < 0.3 && Math.sin(th) < -0.55 ? 1 : 0),
  });
  const hsk = () => [10, 10, 0];
  for (const s of [-1, 1]) {
    B.ell([s * 0.045, 0.655, 0.46], [0.011, 0.011, 0.008], { seg: 6, rings: 4, sk: hsk, mat: T(2) });                                     // eyes
    B.ell([s * 0.07, 0.605, 0.40], [0.02, 0.06, 0.042], { seg: 8, rings: 6, sk: hsk, mat: T(3), rot: new THREE.Euler(0.15, 0, -s * 0.5) });   // floppy ears
    B.ell([s * 0.048, 0.675, 0.395], [0.02, 0.05, 0.03], { seg: 8, rings: 6, sk: hsk, mat: T(4), rot: new THREE.Euler(-0.2, 0, -s * 0.2) });  // prick ears
  }
  // legs: upper (shoulder / thigh) + lower (elbow / hock) with a bend between them
  const legs = [
    // [x, upper bone, lower bone, hip(a), knee(b), paw(c)]
    [0.082, 1, 5, [0.085, 0.42, 0.19], [0.088, 0.22, 0.205], [0.09, 0.02, 0.21]],
    [-0.082, 2, 6, [-0.085, 0.42, 0.19], [-0.088, 0.22, 0.205], [-0.09, 0.02, 0.21]],
    [0.088, 3, 7, [0.09, 0.42, -0.2], [0.092, 0.25, -0.14], [0.088, 0.02, -0.2]],
    [-0.088, 4, 8, [-0.09, 0.42, -0.2], [-0.092, 0.25, -0.14], [-0.088, 0.02, -0.2]],
  ];
  for (const [x, up, lo, a, b, c] of legs) {
    const hind = up >= 3;
    B.tube(a, b, (u) => (hind ? 0.088 - 0.04 * u : 0.06 - 0.02 * u), { seg: 10, rings: 5, capA: true,
      sk: (u) => [up, u > 0.5 ? lo : 0, u > 0.5 ? 0.5 * sm(0.7, 1, u) : 0.5 * (1 - sm(0, 0.3, u))], mat: T(0) });
    B.tube(b, c, (u) => 0.037 - 0.014 * u, { seg: 9, rings: 5, capB: false,
      sk: (u) => [lo, up, 0.5 * (1 - sm(0, 0.25, u))], mat: (u) => (u > 0.78 ? 1 : 0) });
    B.ell([c[0], 0.022, c[2] + 0.018], [0.03, 0.022, 0.05], { seg: 8, rings: 5, sk: () => [lo, lo, 0], mat: T(1) });   // paw
  }
  // tail
  B.tube([0, 0.44, -0.3], [0, 0.6, -0.44], (u) => 0.034 - 0.022 * u, { seg: 8, rings: 5, capB: true, sk: () => [9, 9, 0], mat: (u) => (u > 0.78 ? 1 : 0) });
  return B.build();
}

export const DOG_PARS = /* glsl */`
attribute vec3 aSk; attribute float aMat;
attribute vec4 aMisc;       // phase, walking, scale, breed (0 lab-like floppy ears, 1 terrier prick ears, 2 spaniel)
attribute vec3 aShirt; attribute vec3 aTrou; attribute vec3 aHair;
flat varying vec3 vMatCol; flat varying float vRough;
vec3 pv(int b) {
  if (b == 1) return vec3(0.085, 0.42, 0.19);  if (b == 2) return vec3(-0.085, 0.42, 0.19);
  if (b == 3) return vec3(0.09, 0.42, -0.2);   if (b == 4) return vec3(-0.09, 0.42, -0.2);
  if (b == 5) return vec3(0.088, 0.22, 0.205); if (b == 6) return vec3(-0.088, 0.22, 0.205);
  if (b == 7) return vec3(0.092, 0.25, -0.14); if (b == 8) return vec3(-0.092, 0.25, -0.14);
  if (b == 9) return vec3(0.0, 0.44, -0.3);
  if (b == 10) return vec3(0.0, 0.54, 0.3);
  return vec3(0.0);
}
vec3 rX(vec3 p, vec3 c, float th) { float cs = cos(th), sn = sin(th); vec3 d = p - c; return c + vec3(d.x, d.y * cs - d.z * sn, d.y * sn + d.z * cs); }
vec3 rY(vec3 p, vec3 c, float th) { float cs = cos(th), sn = sin(th); vec3 d = p - c; return c + vec3(d.x * cs + d.z * sn, d.y, -d.x * sn + d.z * cs); }
void bone(int b, inout vec3 p, inout vec3 n) {
  float a = aMisc.x, sw = aMisc.y;
  // trot: diagonal pairs (front L + hind R)
  float fL = sin(a) * 0.55 * sw, fR = -fL, hL = -fL, hR = fL;
  float bendF = 0.55 * max(0.0, -cos(a)) * sw, bendFR = 0.55 * max(0.0, cos(a)) * sw;   // elbow/carpus flex on the forward swing
  float bendH = 0.7 * max(0.0, cos(a)) * sw, bendHR = 0.7 * max(0.0, -cos(a)) * sw;      // hock flex
  vec3 O = vec3(0.0);
  if (b == 1) { p = rX(p, pv(1), fL); n = rX(n, O, fL); }
  else if (b == 2) { p = rX(p, pv(2), fR); n = rX(n, O, fR); }
  else if (b == 3) { p = rX(p, pv(3), hL); n = rX(n, O, hL); }
  else if (b == 4) { p = rX(p, pv(4), hR); n = rX(n, O, hR); }
  else if (b == 5) { p = rX(p, pv(5), -bendF); n = rX(n, O, -bendF); p = rX(p, pv(1), fL); n = rX(n, O, fL); }
  else if (b == 6) { p = rX(p, pv(6), -bendFR); n = rX(n, O, -bendFR); p = rX(p, pv(2), fR); n = rX(n, O, fR); }
  else if (b == 7) { p = rX(p, pv(7), bendH); n = rX(n, O, bendH); p = rX(p, pv(3), hL); n = rX(n, O, hL); }
  else if (b == 8) { p = rX(p, pv(8), bendHR); n = rX(n, O, bendHR); p = rX(p, pv(4), hR); n = rX(n, O, hR); }
  else if (b == 9) { float w = sin(a * 2.3) * 0.55; p = rY(p, pv(9), w); n = rY(n, O, w); }
  else if (b == 10) { float nod = sin(a * 2.0) * 0.05 * sw; p = rX(p, pv(10), nod); n = rX(n, O, nod); }
}
void skinPN(inout vec3 p, inout vec3 n) {
  vec3 p0 = p, n0 = n, p1 = p, n1 = n;
  bone(int(aSk.x + 0.5), p0, n0);
  if (aSk.z > 0.001) { bone(int(aSk.y + 0.5), p1, n1); p = mix(p0, p1, aSk.z); n = normalize(mix(n0, n1, aSk.z)); }
  else { p = p0; n = n0; }
}
`;
export const DOG_NORMAL = /* glsl */`
vec3 objectNormal = vec3( normal );
vec3 pDummy = position;
skinPN(pDummy, objectNormal);
`;
export const DOG_BEGIN = /* glsl */`
vec3 transformed = position;
vec3 nDummy = normal;
skinPN(transformed, nDummy);
transformed.y += abs(sin(aMisc.x * 2.0)) * 0.012 * aMisc.y;
{
  float m = aMat;
  float breed = aMisc.w;
  if ((m > 2.5 && m < 3.5 && breed > 0.5 && breed < 1.5) || (m > 3.5 && m < 4.5 && !(breed > 0.5 && breed < 1.5))) transformed *= 0.0;
  vec3 col = m < 0.5 ? aShirt : m < 1.5 ? aTrou : m < 2.5 ? vec3(0.02) : m < 3.5 ? aShirt * 0.62 : m < 4.5 ? aShirt * 0.9 : vec3(0.35, 0.05, 0.05);
  vMatCol = col;
  vRough = m < 2.5 && m > 1.5 ? 0.35 : 0.85;
  transformed *= aMisc.z;
}
`;
