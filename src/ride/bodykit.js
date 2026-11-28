import * as THREE from 'three';

// ---------------------------------------------------------------------------------------------
// bodykit: small shared helpers for procedural, skinned characters (used by the rider; reusable
// for pedestrians and dogs).
//
//   tubeGeo(a, b, r0, r1 = r0, seg = 8)        cylinder from point a to b (arrays or Vector3), radius r0 at a, r1 at b
//   revolve(len, rOf, seg = 16, capStart = true, capEnd = true)
//                                              lathe body along +y from 0..len; rOf(u in 0..1) = radius profile;
//                                              round caps optional (leave open where limbs join a neighbour)
//   ellipsoid(c, r, seg = 14)                  sphere scaled to radii r = [rx, ry, rz], centred at c = [x, y, z]
//   smoothstep(a, b, x)                        classic smoothstep
//   loftRing(stations, nRing, ringFn)          loft a closed ring through stations ({z,...}); ringFn(station, f 0..1) -> [x, y]
//   class SkinBuffer                           CPU linear-blend skinning, two bone influences per vertex, one mesh:
//       const sk = new SkinBuffer(numBones);
//       sk.setBind(bone, Matrix4)              rest-pose bone matrix, for every bone, BEFORE add()
//       sk.add(geo, bone, { color, paint, high, low, mask })
//            geo     BufferGeometry in the bone's LOCAL rest space (indexed or not)
//            color   THREE.Color for the whole piece (default white); paint(x,y,z) may return a Color per vertex
//            high    { bone, y0, y1 }: vertices above y0 blend toward `bone` (50% at y1) - smooth joints
//            low     { bone, y1 }:     vertices below y1 blend toward `bone`
//            mask    a float stored per vertex (aMask attribute) for shader use (e.g. 1 = skin, 2 = glossy lens)
//       const mesh = sk.build(material)        Mesh with dynamic position/normal, vertex colours, aMask and aOwn attributes
//       sk.update(boneMatrices)                boneMatrices[i] = THREE.Matrix4 current bone world matrix; call each frame
// ---------------------------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const V = (a) => (a instanceof THREE.Vector3 ? a : new THREE.Vector3(a[0], a[1], a[2]));

export const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function tubeGeo(a, b, r0, r1 = r0, seg = 8) {
  a = V(a); b = V(b);
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, false).translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3().subVectors(b, a).normalize());
  return g.applyMatrix4(new THREE.Matrix4().compose(a, q, ONE));
}

export function revolve(len, rOf, seg = 16, capStart = true, capEnd = true) {
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

export function ellipsoid(c, r, seg = 14) {
  return new THREE.SphereGeometry(1, seg, seg >> 1).applyMatrix4(new THREE.Matrix4().compose(V(c), new THREE.Quaternion(), V(r)));
}

export function loftRing(stations, nRing, ringFn) {
  const pos = [], idx = [];
  for (const st of stations) for (let k = 0; k < nRing; k++) { const [x, y] = ringFn(st, k / nRing); pos.push(x, y, st.z); }
  for (let i = 0; i + 1 < stations.length; i++) for (let k = 0; k < nRing; k++) {
    const a = i * nRing + k, b = i * nRing + ((k + 1) % nRing), c = (i + 1) * nRing + k, d = (i + 1) * nRing + ((k + 1) % nRing);
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

export class SkinBuffer {
  constructor(numBones) {
    this.nb = numBones;
    this.bind = Array.from({ length: numBones }, () => new THREE.Matrix4());
    this.inv = Array.from({ length: numBones }, () => new THREE.Matrix4());
    this.P = []; this.N = []; this.C = []; this.A = []; this.B2 = []; this.W = []; this.I = []; this.S = [];
    this.n = 0;
    this._m = new THREE.Matrix4();
    this.sm = new Float64Array(numBones * 16);
  }
  setBind(bone, m) { this.bind[bone].copy(m); this.inv[bone].copy(m).invert(); }
  add(geo, bone, opts = {}) {
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const pos = geo.attributes.position.array, nor = geo.attributes.normal.array, idx = geo.index ? geo.index.array : null;
    const n = geo.attributes.position.count, e = this.bind[bone].elements, base = opts.color || new THREE.Color(1, 1, 1), off = this.n;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      let b2 = bone, w = 0;
      if (opts.high && y > opts.high.y0) { b2 = opts.high.bone; w = 0.5 * smoothstep(opts.high.y0, opts.high.y1, y); }
      else if (opts.low && y < opts.low.y1) { b2 = opts.low.bone; w = 0.5 * (1 - smoothstep(0, opts.low.y1, y)); }
      const c = (opts.paint && opts.paint(x, y, z)) || base;
      this.P.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
      const nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2];
      this.N.push(e[0] * nx + e[4] * ny + e[8] * nz, e[1] * nx + e[5] * ny + e[9] * nz, e[2] * nx + e[6] * ny + e[10] * nz);
      this.C.push(c.r, c.g, c.b); this.S.push(opts.mask || 0);
      this.A.push(bone); this.B2.push(b2); this.W.push(w);
    }
    if (idx) for (let k = 0; k < idx.length; k++) this.I.push(idx[k] + off); else for (let k = 0; k < n; k++) this.I.push(off + k);
    this.n += n;
  }
  build(material) {
    const nv = this.n;
    this.BP = Float32Array.from(this.P); this.BN = Float32Array.from(this.N);
    this.IA = Uint8Array.from(this.A); this.IB = Uint8Array.from(this.B2); this.WB = Float32Array.from(this.W);
    this.OP = new Float32Array(nv * 3); this.ON = new Float32Array(nv * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.OP, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.ON, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(this.C), 3));
    g.setAttribute('aMask', new THREE.BufferAttribute(Float32Array.from(this.S), 1));
    g.setAttribute('aOwn', new THREE.BufferAttribute(Float32Array.from(this.A), 1));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(this.I), 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 3);
    this.geo = g;
    const mesh = new THREE.Mesh(g, material); mesh.frustumCulled = false;
    return mesh;
  }
  update(boneMatrices) {
    const SM = this.sm, m = this._m;
    for (let b = 0; b < this.nb; b++) { m.multiplyMatrices(boneMatrices[b], this.inv[b]); SM.set(m.elements, b * 16); }
    const { BP, BN, IA, IB, WB, OP, ON } = this;
    for (let i = 0; i < this.n; i++) {
      const v = i * 3, x = BP[v], y = BP[v + 1], z = BP[v + 2];
      const a = IA[i] * 16, c = IB[i] * 16, w = WB[i], wa = 1 - w;
      const ax = SM[a] * x + SM[a + 4] * y + SM[a + 8] * z + SM[a + 12], ay = SM[a + 1] * x + SM[a + 5] * y + SM[a + 9] * z + SM[a + 13], az = SM[a + 2] * x + SM[a + 6] * y + SM[a + 10] * z + SM[a + 14];
      const bx = SM[c] * x + SM[c + 4] * y + SM[c + 8] * z + SM[c + 12], by = SM[c + 1] * x + SM[c + 5] * y + SM[c + 9] * z + SM[c + 13], bz = SM[c + 2] * x + SM[c + 6] * y + SM[c + 10] * z + SM[c + 14];
      OP[v] = wa * ax + w * bx; OP[v + 1] = wa * ay + w * by; OP[v + 2] = wa * az + w * bz;
      const nx = BN[v], ny = BN[v + 1], nz = BN[v + 2];
      const anx = SM[a] * nx + SM[a + 4] * ny + SM[a + 8] * nz, any = SM[a + 1] * nx + SM[a + 5] * ny + SM[a + 9] * nz, anz = SM[a + 2] * nx + SM[a + 6] * ny + SM[a + 10] * nz;
      const bnx = SM[c] * nx + SM[c + 4] * ny + SM[c + 8] * nz, bny = SM[c + 1] * nx + SM[c + 5] * ny + SM[c + 9] * nz, bnz = SM[c + 2] * nx + SM[c + 6] * ny + SM[c + 10] * nz;
      const mx = wa * anx + w * bnx, my = wa * any + w * bny, mz = wa * anz + w * bnz;
      const l = 1 / (Math.hypot(mx, my, mz) || 1);
      ON[v] = mx * l; ON[v + 1] = my * l; ON[v + 2] = mz * l;
    }
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.normal.needsUpdate = true;
  }
}
