// Horbury town centre: identifies the High Street (and adjoining centre streets),
// assigns the local facade palette, paves frontages and defines the crossings.
// Everything here is procedural, from written observations only.
import { SegmentIndex, hash2 } from './heightfield.js';

// Palette codes understood by the building shader (see buildings.js brickCol):
//   8 = Victorian red brick with white-painted dressings, 9 = honey/buff Yorkshire sandstone ashlar
//   with dressed quoins, 10 = whitewashed / cream painted render, 4 = darker weathered gritstone
export const PAL_BRICK_WHITE = 8, PAL_HONEY = 9, PAL_RENDER = 10;

const TC_NAMES = new Set(['High Street', 'Cluntergate', 'Queen Street', 'Church Street']);
// Horbury's centre lies around the local origin; the other "High Street" in the data is a different village.
const inCentre = (r) => {
  const a = r.p[0], b = r.p[r.p.length - 1];
  return Math.max(Math.abs(a[0]), Math.abs(b[0])) < 320 && Math.max(Math.abs(a[2] - 120), Math.abs(b[2] - 120)) < 180;
};

export function markTownCentre(features, hf, lc) {
  const roads = features.roads.filter((r) => r.n && TC_NAMES.has(r.n) && inCentre(r) && !r.tu);
  for (const r of roads) { r._tc = true; if (!r._pave) r._pave = 2.0; }
  const tcIdx = new SegmentIndex(24);
  for (const r of roads) for (let i = 0; i + 1 < r.p.length; i++) {
    const a = r.p[i], b = r.p[i + 1];
    tcIdx.add(a[0], a[1], a[2], b[0], b[1], b[2], r._w / 2 + r._pave, r);
  }
  const tmp = { seg: null, d: 0, t: 0, y: 0 };

  // pave the frontage strip (no lawns between pavement and building line)
  const { cols, rows, res } = hf;
  let paved = 0;
  for (let j = 0; j < rows; j++) {
    const z = hf.z0 + j * res;
    if (z < -150 || z > 420) continue;
    for (let i = 0; i < cols; i++) {
      const x = hf.x0 + i * res;
      if (x < -400 || x > 420) continue;
      void x; void z;
    }
  }

  // facade palette: buildings fronting the centre streets, ordered along the street, no two identical neighbours
  const fronting = [];
  for (const b of features.buildings) {
    if (!b.p || b.p.length < 3) continue;
    let best = null;
    for (const q of b.p) {
      const h = tcIdx.query(q[0], q[1], 4.5, null, tmp);
      if (h && (!best || h.d < best.d)) best = { d: h.d, seg: h.seg.id, t: h.t, side: 0 };
    }
    if (!best) continue;
    b._tc = true;
    if (b.k === 'shed' || b.k === 'garage') continue;
    fronting.push({ b, key: best.seg + best.t });
  }
  fronting.sort((a, c) => a.key - c.key);
  const cycle = [PAL_HONEY, PAL_BRICK_WHITE, PAL_RENDER, PAL_HONEY, 4, PAL_BRICK_WHITE];
  let prev = -1;
  for (const f of fronting) {
    const h = hash2(f.b.p[0][0], f.b.p[0][1]);
    let c = cycle[Math.floor(h * cycle.length)];
    if (c === prev) c = cycle[(Math.floor(h * cycle.length) + 1 + Math.floor(h * 7) % 2) % cycle.length];
    if (c === prev) c = c === PAL_HONEY ? PAL_BRICK_WHITE : PAL_HONEY;
    f.b.c = c; prev = c;
  }
  // town-wide: a share of Victorian red-brick terraces get white-painted dressings
  for (const b of features.buildings) {
    if (b._tc || b.k !== 'terrace' || !(b.c <= 3)) continue;
    if (hash2(b.p[0][1] * 0.7, b.p[0][0] * 1.3) < 0.45) b.c = PAL_BRICK_WHITE;
  }

  // crossings: zebra by the School Lane junction + one mid High Street
  const crossings = [];
  const byNameStart = (name, x, z) => roads.find((r) => r.n === name && Math.hypot(r.p[0][0] - x, r.p[0][2] - z) < 1);
  const schoolLane = features.roads.find((r) => r.n === 'School Lane');
  const r1 = schoolLane ? roads.find((r) => r.n === 'High Street' && Math.hypot(r.p[0][0] - schoolLane.p[0][0], r.p[0][2] - schoolLane.p[0][2]) < 1 && r.p.length > 10) : null;
  if (r1) crossings.push({ road: r1, u: 16, kind: 'zebra', note: 'High Street at School Lane junction' });
  const r2 = byNameStart('High Street', 93.5, 217.2) || roads.filter((r) => r.n === 'High Street').sort((a, c) => c.p.length - a.p.length)[0];
  if (r2 && r2 !== r1) crossings.push({ road: r2, u: 55, kind: 'zebra', note: 'mid High Street (east, by Cluntergate)' });
  for (const c of crossings) { c.road._cross = c.u; }
  // landmarks
  const area = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return Math.abs(a / 2); };
  const cen = (p) => p.reduce((a, q) => [a[0] + q[0] / p.length, a[1] + q[1] / p.length], [0, 0]);
  const landmarks = [];
  let coop = null, pub = null;
  if (crossings[0]) {
    const cp = crossings[0].road.p;
    let best = 0;
    for (const f of fronting) { const c = cen(f.b.p), A = area(f.b.p); if (Math.hypot(c[0] - cp[0][0], c[1] - cp[0][2]) < 70 && A > best && A < 900) { best = A; coop = f.b; } }
  }
  { let best = 1e9; for (const f of fronting) { if (f.b === coop) continue; const c = cen(f.b.p), A = area(f.b.p); const d = Math.hypot(c[0] + 110, c[1] - 150); if (A > 70 && A < 500 && d < best) { best = d; pub = f.b; } } }
  if (coop) { coop.k = 'coop'; coop.c = PAL_HONEY; coop.r = 'gabled'; landmarks.push({ name: 'Co-op (arched-window stone building)', at: cen(coop.p).map(Math.round) }); }
  if (pub) { pub.k = 'pub'; pub.c = 11; landmarks.push({ name: 'The Fleece (grey render pub)', at: cen(pub.p).map(Math.round) }); }
  // a few deciduous street trees at the back of the pavement where there is no frontage
  const streetTrees = [];
  for (const r of roads) {
    if (r.n !== 'High Street') continue;
    let acc = 0;
    for (let i = 0; i + 1 < r.p.length; i++) {
      const a = r.p[i], b = r.p[i + 1], L = Math.hypot(b[0] - a[0], b[2] - a[2]);
      acc += L;
      if (acc < 22) continue;
      acc = 0;
      const tx = (b[0] - a[0]) / L, tz = (b[2] - a[2]) / L;
      for (const side of [-1, 1]) {
        const o = r._w / 2 + r._pave + 1.3, x = a[0] + tz * side * o, z = a[2] - tx * side * o;
        let clear = true;
        for (const ff of fronting) { const c = cen(ff.b.p); if (Math.hypot(c[0] - x, c[1] - z) < 9) { clear = false; break; } }
        if (clear && hash2(x, z) < 0.55 && streetTrees.length < 10) { const h = 8 + hash2(z, x) * 5; streetTrees.push([x, hf.sample(x, z), z, h, h * 0.36]); }
      }
    }
  }
  for (const t of streetTrees) features.trees.push(t);
  return { roads, tcIdx, crossings, paved, fronting: fronting.length, landmarks, streetTrees: streetTrees.length, pub };
}

// ---------------------------------------------------------------- Quarry Hill
const QH = new Set(['Quarry Hill']);
export function markQuarryHill(features) {
  const roads = features.roads.filter((r) => r.n && QH.has(r.n) && !r.tu && Math.abs(r.p[0][0] + 560) < 400 && Math.abs(r.p[0][2] - 310) < 200);
  for (const r of roads) { r._qh = true; r._dyl = true; r._pave = 2.0; r._verge = r.k === 'primary' ? 2.4 : 1.6; }
  return { roads };
}

// mature trees lining Quarry Hill + a wooded bank on the side away from the houses
export function quarryTrees(qh, hf, bIdx) {
  const out = [];
  for (const r of qh.roads) {
    const hw = r._w / 2 + r._pave + r._verge;
    let acc = 0;
    for (let i = 0; i + 1 < r.p.length; i++) {
      const a = r.p[i], b = r.p[i + 1], L = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const tx = (b[0] - a[0]) / L, tz = (b[2] - a[2]) / L;
      acc += L;
      if (acc < 15) continue;
      acc = 0;
      for (const side of [-1, 1]) {
        let houses = 0;
        for (const d of [4, 8, 12]) if (bIdx.find(a[0] + tz * side * (hw + d), a[2] - tx * side * (hw + d))) houses++;
        const rows = houses ? 0 : (side > 0 ? 3 : (hash2(a[0], a[2]) < 0.6 ? 1 : 0));
        for (let k = 0; k < rows; k++) {
          const o = hw + 2.2 + k * 6 + hash2(a[0] + k, a[2]) * 2;
          const x = a[0] + tz * side * o + tx * (hash2(a[2], k) - 0.5) * 6, z = a[2] - tx * side * o + tz * (hash2(k, a[0]) - 0.5) * 6;
          if (bIdx.find(x, z, 2)) continue;
          const h = 13 + hash2(x, z) * 8;
          out.push([x, hf.sample(x, z), z, h, h * (0.4 + hash2(z, x) * 0.1)]);
        }
      }
    }
  }
  return out;
}

// pick a stone roadside pub on Quarry Hill (Quarry Inn style)
export function quarryPub(qh, features, tcIdx) {
  let best = null, bd = 1e9;
  const tmp = { seg: null, d: 0, t: 0, y: 0 };
  const idx = new SegmentIndex(24);
  for (const r of qh.roads) for (let i = 0; i + 1 < r.p.length; i++) { const a = r.p[i], b = r.p[i + 1]; idx.add(a[0], a[1], a[2], b[0], b[1], b[2], r._w / 2, r); }
  for (const b of features.buildings) {
    if (!b.p || b.k === 'shed' || b.k === 'garage' || b._tc) continue;
    let A = 0; for (let i = 0; i < b.p.length; i++) { const q = b.p[i], r = b.p[(i + 1) % b.p.length]; A += q[0] * r[1] - r[0] * q[1]; } A = Math.abs(A / 2);
    if (A < 90 || A > 450 || (b.e || 0) < 4.5) continue;
    for (const q of b.p) { const h = idx.query(q[0], q[1], 9, null, tmp); if (h && h.d < bd) { bd = h.d; best = b; } }
  }
  if (!best) return null;
  best.k = 'pub'; best.c = 5; best._tc = true; best._qinn = true;
  for (const r of qh.roads) for (let i = 0; i + 1 < r.p.length; i++) { const a = r.p[i], b = r.p[i + 1]; tcIdx.add(a[0], a[1], a[2], b[0], b[1], b[2], r._w / 2 + r._pave + r._verge, r); }
  return best;
}
