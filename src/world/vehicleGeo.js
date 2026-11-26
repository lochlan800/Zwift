import * as THREE from 'three';

// ---------------------------------------------------------------------------------------------
// Vehicle geometry for the traffic system. Each vehicle type is built on the CPU from LOFTED
// cross-sections (rounded body shell + tumblehome glasshouse) so the silhouette has a real side
// profile: sloped bonnet and windscreen, curved roofline, rounded sections. All types are merged
// into one buffer; every vertex carries its type (aType), a material code (aMat) and a wheel slot
// (aWheel). The vertex shader collapses vertices that belong to other types, so one instanced mesh
// draws every vehicle.
//
// aMat codes: 0 paint (instance body colour) 1 tinted glass 2 black trim 3 head lamp 4 tail lamp
//             5 accent paint (bus roof) 6 white plate 7 yellow plate 9 tyre rubber 10 alloy 11 dark disc
// Coordinates: +z forward, +x to the vehicle's right, y up from the road, centred on the footprint.
// ---------------------------------------------------------------------------------------------

export const TYPE_DEFS = [
  { name: 'hatch', L: 3.99, W: 1.77, sill: 0.22, wheel: [0.74, 1.22, -1.18, 0.31],
    top: [[1.995, 0.66], [1.6, 0.79], [1.0, 0.9], [0.62, 0.935], [-0.9, 0.935], [-1.7, 0.92], [-1.995, 0.86]],
    gh: { belt: 0.93, top: [[0.62, 0.93], [0.2, 1.40], [-0.2, 1.46], [-0.95, 1.44], [-1.45, 1.22], [-1.88, 0.93]], taper: 0.74, n: 3, roof: [0.1, -1.0], pillars: [-0.25, -1.3], mirrorZ: 0.42, doors: [0.5, -0.25, -1.25] } },
  { name: 'saloon', L: 4.62, W: 1.83, sill: 0.22, wheel: [0.77, 1.45, -1.4, 0.32],
    top: [[2.31, 0.66], [1.9, 0.8], [1.2, 0.92], [0.82, 0.95], [-1.2, 0.95], [-1.9, 1.0], [2.31 * -1, 0.95]],
    gh: { belt: 0.95, top: [[0.82, 0.95], [0.25, 1.42], [-0.1, 1.47], [-0.9, 1.45], [-1.35, 1.27], [-1.68, 0.98]], taper: 0.74, n: 3, roof: [0.18, -1.0], pillars: [-0.2, -1.28], mirrorZ: 0.6, doors: [0.62, -0.2, -1.25] } },
  { name: 'suv', L: 4.55, W: 1.92, sill: 0.3, wheel: [0.83, 1.4, -1.35, 0.37],
    top: [[2.275, 0.88], [1.9, 1.0], [1.3, 1.1], [0.9, 1.12], [-1.8, 1.12], [-2.275, 1.1]],
    gh: { belt: 1.12, top: [[0.9, 1.12], [0.4, 1.68], [0.0, 1.74], [-1.5, 1.72], [-2.0, 1.5], [-2.22, 1.15]], taper: 0.8, n: 3, roof: [0.35, -1.7], pillars: [-0.2, -1.6], mirrorZ: 0.7, doors: [0.7, -0.2, -1.55] } },
  { name: 'van', L: 5.35, W: 2.0, sill: 0.3, wheel: [0.88, 1.6, -1.55, 0.35],
    top: [[2.675, 0.9], [2.2, 1.0], [1.7, 1.12], [1.15, 1.18], [0.32, 1.2], [0.3, 2.05], [-2.675, 2.05]],
    gh: { belt: 1.18, top: [[1.15, 1.18], [0.8, 1.9], [0.5, 2.04], [0.3, 2.05]], taper: 0.82, n: 3, roof: [0.78, 0.3], pillars: [], mirrorZ: 0.95, doors: [0.8, 0.3] } },
  { name: 'bus', L: 10.8, W: 2.5, sill: 0.3, wheel: [1.0, 3.3, -3.4, 0.5], bus: true,
    top: [[5.4, 0.95], [5.0, 1.0], [-5.0, 1.0], [-5.4, 1.0]],
    gh: { belt: 1.0, top: [[5.3, 1.0], [5.22, 2.75], [5.0, 2.88], [-5.0, 2.88], [-5.22, 2.75], [-5.3, 1.0]], taper: 0.95, n: 7, roof: [5.0, -5.0], pillars: [3.9, 2.0, 0.1, -1.8, -3.6], mirrorZ: 5.2, doors: [4.6, 2.9, -3.2] } },
];

const sgnp = (c, e) => Math.sign(c) * Math.pow(Math.abs(c), e);
function interp(pts, z) { // pts sorted by z desc or asc: piecewise linear
  const n = pts.length;
  const desc = pts[0][0] > pts[n - 1][0];
  if (desc ? z >= pts[0][0] : z <= pts[0][0]) return pts[0][1];
  if (desc ? z <= pts[n - 1][0] : z >= pts[n - 1][0]) return pts[n - 1][1];
  for (let i = 0; i + 1 < n; i++) {
    const a = pts[i], b = pts[i + 1];
    if (desc ? (z <= a[0] && z >= b[0]) : (z >= a[0] && z <= b[0])) { const t = (z - a[0]) / (b[0] - a[0] || 1e-6); return a[1] + (b[1] - a[1]) * t; }
  }
  return pts[n - 1][1];
}

class Builder {
  constructor() { this.P = []; this.N = []; this.T = []; this.M = []; this.Wh = []; this.I = []; }
  push(geo, type, mat, wheel = -1, xf = null) {
    if (xf) geo.applyMatrix4(xf);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const pos = geo.attributes.position.array, nor = geo.attributes.normal.array, o = this.P.length / 3;
    const idx = geo.index ? geo.index.array : null;
    for (let i = 0; i < pos.length; i += 3) {
      this.P.push(pos[i], pos[i + 1], pos[i + 2]); this.N.push(nor[i], nor[i + 1], nor[i + 2]);
      this.T.push(type); this.M.push(Array.isArray(mat) ? mat[i / 3] : mat); this.Wh.push(wheel);
    }
    if (idx) for (const k of idx) this.I.push(o + k); else for (let k = 0; k < pos.length / 3; k++) this.I.push(o + k);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('aType', new THREE.Float32BufferAttribute(this.T, 1));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.M, 1));
    g.setAttribute('aWheel', new THREE.Float32BufferAttribute(this.Wh, 1));
    g.setIndex(this.I);
    return g;
  }
}

// loft a closed ring through stations. ring(st, k, n) -> [x, y]; returns {geo, mats}
function loft(stations, nRing, ringFn, matFn) {
  const pos = [], mats = [], idx = [];
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    for (let k = 0; k < nRing; k++) { const [x, y] = ringFn(st, k / nRing); pos.push(x, y, st.z); mats.push(matFn(st, k / nRing)); }
  }
  for (let i = 0; i + 1 < stations.length; i++) {
    for (let k = 0; k < nRing; k++) {
      const a = i * nRing + k, b = i * nRing + ((k + 1) % nRing), c = (i + 1) * nRing + k, d = (i + 1) * nRing + ((k + 1) % nRing);
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return { geo, mats };
}

function wheelGeometry() {
  // unit radius, axis x, symmetric (both faces carry the alloy detail so no mirroring is needed)
  const B = new Builder();
  const SEG = 24;
  // tyre: lathe of a rounded profile
  const prof = [[0.74, -0.31], [0.9, -0.29], [0.985, -0.2], [1.0, -0.1], [1.0, 0.1], [0.985, 0.2], [0.9, 0.29], [0.74, 0.31]];
  const tp = [], ti = [];
  for (let j = 0; j < prof.length; j++) for (let i = 0; i < SEG; i++) { const a = (i / SEG) * Math.PI * 2; tp.push(prof[j][1], Math.cos(a) * prof[j][0], Math.sin(a) * prof[j][0]); }
  for (let j = 0; j + 1 < prof.length; j++) for (let i = 0; i < SEG; i++) {
    const a = j * SEG + i, b = j * SEG + (i + 1) % SEG, c = (j + 1) * SEG + i, d = (j + 1) * SEG + (i + 1) % SEG;
    ti.push(a, b, c, b, d, c);
  }
  const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3)); tg.setIndex(ti); tg.computeVertexNormals();
  B.push(tg, 99, 9);
  for (const s of [-1, 1]) {
    // dark brake disc / well behind the spokes
    const disc = new THREE.CircleGeometry(0.76, SEG); disc.rotateY(s * Math.PI / 2); disc.translate(s * 0.22, 0, 0);
    B.push(disc, 99, 11);
    // alloy outer ring (rim lip)
    const ring = new THREE.RingGeometry(0.62, 0.78, SEG); ring.rotateY(s * Math.PI / 2); ring.translate(s * 0.3, 0, 0);
    B.push(ring, 99, 10);
    // five spokes
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + 0.2;
      const sp = new THREE.BufferGeometry();
      const hw0 = 0.07, hw1 = 0.12, r0 = 0.1, r1 = 0.66;
      const px = [0, -hw0, 0, 0, hw0, 0].length; void px;
      const v = [[r0, -hw0], [r1, -hw1], [r1, hw1], [r0, hw0]].map(([r, w]) => [s * 0.27, Math.cos(a) * r - Math.sin(a) * w, Math.sin(a) * r + Math.cos(a) * w]);
      sp.setAttribute('position', new THREE.Float32BufferAttribute(v.flat(), 3));
      sp.setIndex(s > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]);
      sp.computeVertexNormals();
      B.push(sp, 99, 10);
    }
    const hub = new THREE.CircleGeometry(0.15, 12); hub.rotateY(s * Math.PI / 2); hub.translate(s * 0.285, 0, 0);
    B.push(hub, 99, 10);
  }
  return B;
}

export function buildVehicles() {
  const B = new Builder();
  const wheelB = wheelGeometry();
  TYPE_DEFS.forEach((T, ti) => {
    const { L, W, sill } = T, hl = L / 2, hw = W / 2;
    const bus = !!T.bus;
    // ----- plan rounding: nearly flat ends (plates fit), rounded corners
    const planP = bus ? 18 : 14;
    const wAt = (z) => { const t = Math.min(1, Math.abs(z / hl)); return hw * Math.pow(Math.max(0, 1 - Math.pow(t, planP)), 0.4); };
    // ----- lower body shell
    const M = 44;
    const zs = [];
    for (let i = 0; i <= M; i++) { const s = (i / M) * 2 - 1; zs.push(hl * Math.sign(s) * Math.pow(Math.abs(s), 0.82)); }
    zs.reverse(); // front (+z) first
    const nTop = bus ? 8 : 3.2, nBot = bus ? 10 : 8;
    const st = zs.map((z) => ({ z, w: wAt(z), yt: interp(T.top, z) }));
    const bodyRing = (s, f) => {
      const a = f * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      const n = sn >= 0 ? nTop : nBot, e = 2 / n;
      const hh = (s.yt - sill) / 2, ym = (s.yt + sill) / 2;
      return [s.w * sgnp(c, e), ym + hh * sgnp(sn, e)];
    };
    const body = loft(st, 20, bodyRing, () => (bus ? 0 : 0));
    // bus: lower skirt accent colour, upper (window band) handled by the glasshouse
    if (bus) body.mats = body.mats.map((m, i) => { const k = i % 20; const f = k / 20; return (Math.sin(f * Math.PI * 2) < -0.2 ? 5 : 0); });
    B.push(body.geo, ti, body.mats);

    // ----- glasshouse (tumblehome loft) -> glass, roof paint, black pillars
    const g = T.gh;
    const zFront = g.top[0][0], zRear = g.top[g.top.length - 1][0];
    const gz = [];
    const GM = bus ? 60 : 40;
    for (let i = 0; i <= GM; i++) { const s = i / GM; gz.push(zFront + (zRear - zFront) * (0.5 - 0.5 * Math.cos(Math.PI * s))); }
    const ghSt = gz.map((z) => {
      const yt = interp(g.top, z);
      let pill = false;
      for (const pz of g.pillars) if (Math.abs(z - pz) < (bus ? 0.07 : 0.055)) pill = true;
      const roof = z <= g.roof[0] && z >= g.roof[1];
      return { z, yt: Math.max(yt, g.belt + 0.002), roof, pill };
    });
    // add hard material edges at pillars/roof by inserting duplicate stations is skipped: bands are narrow
    const ghRing = (s, f) => {
      const a = f * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      const e = 2 / g.n, u = sgnp(c, e), v = sgnp(sn, e);
      const vp = (v + 1) / 2;
      const wb = Math.max(0.0, wAt(s.z) - 0.05);
      const w = wb * (1 - (1 - g.taper) * vp);
      const y0 = g.belt - 0.04, y1 = s.yt;
      return [w * u, y0 + (y1 - y0) * vp];
    };
    const ghMat = (s, f) => {
      const sn = Math.sin(f * Math.PI * 2), vp = (Math.pow(Math.abs(sn), 2 / g.n) * Math.sign(sn) + 1) / 2;
      if (s.pill) return bus ? 0 : 2;
      if (bus && vp > 0.7) return 5;           // painted roof band above the windows
      if (s.roof && vp > 0.86) return 0;
      if (vp < 0.18) return 2;                 // sill line blends into trim
      if (T.name === 'van' && !s.roof && vp > 0.86) return 0;
      return 1;
    };
    const gh = loft(ghSt, 22, ghRing, ghMat);
    B.push(gh.geo, ti, gh.mats);

    // ----- details
    const box = (sx, sy, sz, x, y, z) => { const b = new THREE.BoxGeometry(sx, sy, sz); b.translate(x, y, z); return b; };
    const zf = hl, zr = -hl;
    const nose = interp(T.top, zf - 0.02), tail = interp(T.top, zr + 0.02);
    // plates: white at the front, yellow at the back
    if (!bus) {
      B.push(box(0.52, 0.11, 0.012, 0, sill + 0.28, zf + 0.004), ti, 6);
      B.push(box(0.52, 0.11, 0.012, 0, Math.max(sill + 0.3, tail - 0.3), zr - 0.004), ti, 7);
    } else {
      B.push(box(0.52, 0.11, 0.012, 0, 0.55, zf + 0.004), ti, 6);
      B.push(box(0.52, 0.11, 0.012, 0, 0.7, zr - 0.004), ti, 7);
      B.push(box(1.4, 0.2, 0.02, 0, 2.62, zf - 0.07), ti, 3);   // destination display
    }
    // head and tail lamps on the corners
    const lx = Math.max(0.2, wAt(zf - 0.03) - (bus ? 0.2 : 0.17));
    const hy = Math.min(nose - 0.08, sill + 0.5 + (bus ? 0.2 : 0));
    for (const s of [-1, 1]) {
      B.push(box(bus ? 0.3 : 0.34, 0.09, 0.05, s * lx, hy + (T.name === 'suv' || T.name === 'van' ? 0.12 : 0.03), zf - 0.03), ti, 3);
      B.push(box(bus ? 0.2 : 0.3, 0.09, 0.05, s * Math.max(0.2, wAt(zr + 0.03) - 0.16), Math.max(sill + 0.45, tail - 0.18), zr + 0.03), ti, 4);
    }
    // black lower grille/bumper strips
    B.push(box(Math.min(1.1, W * 0.55), 0.09, 0.035, 0, sill + 0.18, zf - 0.005), ti, 2);
    B.push(box(W * 0.62, 0.07, 0.035, 0, sill + 0.16, zr + 0.005), ti, 2);
    // door shut lines + sill trim on both sides
    const wMidY = (sill + g.belt) / 2;
    for (const s of [-1, 1]) {
      for (const dz of g.doors) {
        const x = wAt(dz) * 0.99 * Math.pow(Math.max(0, 1 - Math.pow(Math.abs((wMidY - (interp(T.top, dz) + sill) / 2) / ((interp(T.top, dz) - sill) / 2)), 8)), 1 / 8);
        B.push(box(0.012, g.belt - sill - 0.22, 0.012, s * (x + 0.002), wMidY + 0.04, dz), ti, 2);
      }
      B.push(box(0.014, 0.07, L * (bus ? 0.78 : 0.6), s * (wAt(0) * 0.985 + 0.001), sill + 0.1, -L * 0.04), ti, 2);
      // wing mirror: stalk + housing
      const mx = wAt(g.mirrorZ) - 0.02;
      B.push(box(0.1, 0.06, 0.05, s * (mx + 0.04), g.belt + 0.06, g.mirrorZ), ti, 2);
      B.push(box(0.07, 0.11, 0.17, s * (mx + 0.12), g.belt + 0.1, g.mirrorZ - 0.03), ti, bus ? 2 : 0);
      // wheel arches: dark discs just proud of the body side behind each wheel
    }
    const [wx, wzf, wzr, wr] = T.wheel;
    const bodyX = (zc) => {
      const yt = interp(T.top, zc), hh = (yt - sill) / 2, ym = (yt + sill) / 2, vv = Math.max(-0.99, Math.min(0.99, (wr - ym) / hh));
      return wAt(zc) * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(vv), nBot)), 1 / nBot);
    };
    // wheels sit just proud of the body side, in front of a dark arch disc
    T.wheel[0] = bodyX(wzf) + 0.025 - 0.31 * wr;
    const archAt = (zc, s) => {
      const d = new THREE.CircleGeometry(wr * 1.13, 22); d.rotateY(s * Math.PI / 2); d.translate(s * (bodyX(zc) + 0.004), wr, zc);
      return d;
    };
    for (const zc of [wzf, wzr]) for (const s of [-1, 1]) B.push(archAt(zc, s), ti, 2);
  });
  // wheels: shared geometry (type 99 = always visible), 4 slots
  const wgeo = wheelB.build();
  const out = new Builder();
  out.P = B.P; out.N = B.N; out.T = B.T; out.M = B.M; out.Wh = B.Wh; out.I = B.I;
  const wp = wgeo.attributes.position.array, wn = wgeo.attributes.normal.array, wt = wgeo.attributes.aMat.array, wi = wgeo.index.array;
  for (let w = 0; w < 4; w++) {
    const o = out.P.length / 3;
    for (let i = 0; i < wp.length; i += 3) { out.P.push(wp[i], wp[i + 1], wp[i + 2]); out.N.push(wn[i], wn[i + 1], wn[i + 2]); out.T.push(99); out.M.push(wt[i / 3]); out.Wh.push(w); }
    for (const k of wi) out.I.push(o + k);
  }
  return out.build();
}
