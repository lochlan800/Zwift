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
  const cycle = [PAL_HONEY, PAL_BRICK_WHITE, 5, PAL_HONEY, 4, PAL_BRICK_WHITE, PAL_HONEY, PAL_BRICK_WHITE, PAL_RENDER];
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

// ---------------------------------------------------------------- Storrs Hill Road (rural climb)
// Real road: ~6.8 m two-lane with dashed centre + edge lines, a tarmac footway on the left going
// uphill (route direction), rough grass then open arable fields on that side, scrub on the other.
export function markStorrs(features) {
  const rp = features.route.pts;
  const S = new Float64Array(rp.length);
  for (let i = 1; i < rp.length; i++) S[i] = S[i - 1] + Math.hypot(rp[i][0] - rp[i - 1][0], rp[i][2] - rp[i - 1][2]);
  const nearest = (x, z) => { let bi = 0, bd = 1e9; for (let i = 0; i < rp.length; i += 2) { const d = (rp[i][0] - x) ** 2 + (rp[i][2] - z) ** 2; if (d < bd) { bd = d; bi = i; } } return { i: bi, d: Math.sqrt(bd), s: S[bi] }; };
  const roads = [];
  for (const r of features.roads) {
    if (r.n !== 'Storrs Hill Road' || r.tu || r.p.length < 2) continue;
    r._w = Math.max(r._w || 6, 6.8);
    const a = nearest(r.p[0][0], r.p[0][2]), b = nearest(r.p[r.p.length - 1][0], r.p[r.p.length - 1][2]);
    if (a.d > 8 || b.d > 8 || Math.min(a.s, b.s) < 1945) continue; // the valley end in Horbury Bridge keeps its normal treatment
    r._storrs = true;
    r._forceT = 0; // centre dashes + edge lines
    r._pave = 1.8; r._paveTarmac = true;
    r._paveSide = b.s > a.s ? 1 : -1; // +1 = left of the polyline direction
    r._s0 = a.s; r._s1 = b.s;
    roads.push(r);
  }
  return { roads };
}

export function storrsTrees(st, hf, bIdx) {
  const out = [];
  for (const r of st.roads) {
    const side = -r._paveSide, hw = r._w / 2;
    let acc = 0;
    for (let i = 0; i + 1 < r.p.length; i++) {
      const a = r.p[i], b = r.p[i + 1], L = Math.hypot(b[0] - a[0], b[2] - a[2]);
      acc += L; if (acc < 9) continue; acc = 0;
      const tx = (b[0] - a[0]) / L, tz = (b[2] - a[2]) / L, nx = tz * side, nz = -tx * side;
      if (hash2(a[0] * 0.3, a[2] * 0.7) > 0.55) continue;
      const o = hw + 5 + hash2(a[2], a[0]) * 6;
      const x = a[0] + nx * o, z = a[2] + nz * o;
      if (bIdx.find(x, z, 2)) continue;
      const h = 6 + hash2(x, z) * 7;
      out.push([x, hf.sample(x, z), z, h, h * (0.42 + hash2(z, x) * 0.12)]);
    }
  }
  return out;
}

// long rough grass strip between the Storrs Hill footway and the field
export function storrsVerge(st, hf, lc) {
  let n = 0;
  for (const r of st.roads) {
    const hw = r._w / 2 + r._pave, side = r._paveSide;
    for (let i = 0; i + 1 < r.p.length; i++) {
      const a = r.p[i], b = r.p[i + 1], L = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const tx = (b[0] - a[0]) / L, tz = (b[2] - a[2]) / L, nx = tz * side, nz = -tx * side;
      for (let s = 0; s < L; s += 2) for (let o = hw + 0.5; o <= hw + 7; o += 2) {
        const x = a[0] + tx * s + nx * o, z = a[2] + tz * s + nz * o;
        const ii = Math.round((x - hf.x0) / hf.res), jj = Math.round((z - hf.z0) / hf.res);
        if (ii < 0 || jj < 0 || ii >= hf.cols || jj >= hf.rows) continue;
        const k = jj * hf.cols + ii;
        if (lc[k] === 1 || lc[k] === 0) { lc[k] = 7; n++; }
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------- building age / historic character
// Deterministic: old core (≈700 m around High Street) and terraces -> Victorian/older stone & brick;
// big detached boxes far from the core -> 20th century brick (a minority roughcast).
export function classifyAges(features, bIdx) {
  const area = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return Math.abs(a / 2); };
  const stats = { old: 0, modern: 0, render: 0, mills: 0, churches: 0 };
  const mills = [];
  for (const b of features.buildings) {
    if (!b.p || b.p.length < 3) continue;
    const n = b.p.length; let cx = 0, cz = 0, x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const q of b.p) { cx += q[0] / n; cz += q[1] / n; x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); }
    const A = area(b.p), dCore = Math.hypot(cx + 100, cz - 150);
    const ext = Math.max(x1 - x0, z1 - z0), wid = Math.max(1, A / Math.max(ext, 1)), aspect = ext / wid;
    const h = hash2(cx * 0.31, cz * 0.47), h2 = hash2(cz * 0.13, cx * 0.71);
    let old = dCore < 700 || b.k === 'terrace' || (aspect > 2.4 && A > 70 && A < 600 && b.k !== 'industrial') || (dCore < 1200 && h < 0.5);
    if (b.k === 'church') {
      old = true; b.c = h < 0.6 ? 9 : 5; stats.churches++;
      if (b.r === 'flat' && A < 1200) { b.r = 'gabled'; b.e = Math.max(5, Math.min(b.h * 0.65, b.h - 2.5)); }
    }
    if ((b.k === 'industrial' || b.k === 'other' || b.k === 'commercial') && A > 700 && A < 9000 && aspect > 1.7 && (b.h || 0) >= 8.5 && dCore < 2200) {
      b.k = 'mill'; old = true; b.c = h < 0.55 ? 5 : (h < 0.8 ? 8 : 4); mills.push({ b, A }); stats.mills++;
    }
    b._old = old;
    if (b._tc) { stats.old++; continue; }
    const c = b.c | 0;
    if (old) {
      stats.old++;
      // older buildings: stone or brick, very little render
      if (c === 6 || c === 7) b.c = h2 < 0.45 ? 4 : h2 < 0.65 ? 5 : h2 < 0.8 ? 9 : (h2 < 0.92 ? 8 : 6);
      if (b.c === 6) stats.render++;
    } else {
      stats.modern++;
      if (c === 6 || c === 7) { if (h2 < 0.55) { stats.render++; } else b.c = [0, 1, 2, 3][Math.floor(h2 * 4) % 4]; }
      else if (c === 4 || c === 5) { if (h2 < 0.5) b.c = 1 + Math.floor(h2 * 6) % 3; }
    }
  }
  mills.sort((a, b) => b.A - a.A);
  for (const m of mills.slice(0, 2)) m.b._millChimney = true;
  // St Peter's (Georgian church on Church Street): tower + spire
  let best = null, bd = 1e9;
  for (const b of features.buildings) {
    if (b.k !== 'church') continue;
    const n = b.p.length; let cx = 0, cz = 0; for (const q of b.p) { cx += q[0] / n; cz += q[1] / n; }
    const d = Math.hypot(cx - 19, cz - 26);
    if (d < bd) { bd = d; best = b; }
  }
  if (best && bd < 120) { best._spire = true; best.c = 9; stats.stPeters = true; }
  return stats;
}
