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
      if (tcIdx.query(x, z, 9, null, tmp)) { const k = j * cols + i; if (lc[k] !== 4) { lc[k] = 10; paved++; } }
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
  return { roads, tcIdx, crossings, paved, fronting: fronting.length };
}
